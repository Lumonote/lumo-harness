import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionConflictError, type PgGovernedDispatch, type GovernedExecution, type GovernedResult } from './governed-dispatch.ts'
import { assertExecutionPreset, type WorkerBinding } from './worker-binding.ts'
import { SCOPE_GOVERNED_RUN, type ScopeCapSeam } from '../../../shared/seam-contracts/metering.ts'
import { KNOWLEDGE_TOOL_NAMES, type KnowledgeSessionScope } from '../../../shared/seam-contracts/knowledge.ts'
import { readChildResult } from './tturn.ts'

/** One explicitly scoped text turn. No host tools or parent cwd/model/policy
 * are inherited from the dispatch payload. The existing process plugins retain
 * the exact owner/project/Agent identity checked at admission. */
export async function runGovernedTask(ctx: Context, execution: GovernedExecution, binding: WorkerBinding,
  nodeId: string, stop: AbortSignal): Promise<GovernedResult> {
  const result: GovernedResult = { run_id: execution.runId, task_id: execution.task.id,
    session_ref: execution.sessionRef, node_id: nodeId, state: 'FAILED', summary: '' }
  let dispose: (() => Promise<void>) | undefined
  let detach: (() => void) | undefined
  let signal = stop
  try {
    if (execution.cancelled) return { ...result, state: 'CANCELLED', summary: 'Task cancelled before execution' }
    assertExecutionPreset(binding, execution.task.realm, execution.preset)
    if (execution.task.project_id !== binding.projectId) throw new Error('task project does not match the installed runtime')
    const depth = execution.task.intent_contract?.depth ?? 0
    if (!Number.isSafeInteger(depth) || depth < 0 || depth > execution.preset.max_delegation_depth) throw new Error('invalid task delegation depth')
    const remaining = execution.deadlineMS > 0 ? execution.deadlineMS - Date.now() : Infinity
    if (remaining <= 0) return { ...result, state: 'CANCELLED', summary: 'Task deadline elapsed before execution' }
    signal = AbortSignal.any([stop, AbortSignal.timeout(Math.min(remaining, execution.preset.timeout_seconds * 1000))])
    signal.throwIfAborted()
    // 给这一次执行封顶（`max_budget_cents`，单位**分**）。
    //
    // **拿不到执法面就拒绝开跑，而不是照跑**：一个「设了上限但没人执法」的执行与一个
    // 「没设上限」的执行在结果上完全一样，而运维以为前者受着管。这正是
    // `assertExecutionPreset` 那条「先有执法再开门」判据的另一半——它放行了带预算的
    // 预设，这里的拒绝就是那次放行的前提。
    const capCents = execution.preset.max_budget_cents
    if (capCents > 0) {
      const caps = (ctx as { meteringCaps?: ScopeCapSeam }).meteringCaps
      if (!caps) {
        // **不是 throw**：throw 会被下面的 catch 吞成一句笼统的「inspect its session log」，
        // 而那会把一次**开跑前的拒绝**报成一次执行失败——排查的人会去翻会话日志，而真相
        // 是「这个节点没装执法面」。与上面 `cancelled` 那条早退同形：拒绝是说清原因的结果。
        return { ...result, state: 'FAILED',
          summary: 'Execution refused before start: the preset sets a monetary cap '
            + 'but this node has no metering cap enforcement (@lumo/metering not mounted). '
            + 'Refusing to run without the enforcement the preset assumes.' }
      }
      // id 取会话 ref：一次受治理执行的全部花费都记在它自己的会话上，计量截面按同一个
      // 键扣减（见 pg-meter 的 commit）。
      await caps.setCap(SCOPE_GOVERNED_RUN, execution.sessionRef, capCents)
    }
    // 知识空间：**只在预设列出了空间时才放行知识工具**。
    //
    // 「列出非空」是授权层唯一能拿到的「这次执行被允许读知识」的证据——所以空列表在这里读作
    // **不授予**，而不是「不限制」。这与契约层对 `spaces` 的语义（省略 = 不收窄）**方向相反**，
    // 是刻意的：授权与收窄不是同一件事，而授权层的默认必须是关的（少给一次权限只是功能没开，
    // 多给一次就是一个没人打算开的读取面）。
    //
    // 若治理面将来要表达「全部空间」，需要的是一份**显式**的清单或一个独立的开关，而不是把
    // 「留空」重新解释一遍——那正是本仓 E4/D6 记过的「一个字段两个语义」。
    const spaces = execution.preset.knowledge_space_ids
    if (spaces.length > 0) {
      const knowledgeScope = (ctx as { knowledgeScope?: KnowledgeSessionScope }).knowledgeScope
      if (!knowledgeScope) {
        return { ...result, state: 'FAILED',
          summary: 'Execution refused before start: the preset scopes knowledge spaces '
            + 'but this node has no knowledge scope registry (@lumo/knowledge not mounted). '
            + 'Refusing to run without the enforcement the preset assumes.' }
      }
      knowledgeScope.set(execution.sessionRef, spaces)
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId(execution.sessionRef), signal,
      meta: { delegationDepth: depth },
      agentOptions: { provider: binding.provider, model: binding.model },
      setup(childCtx) {
        // 工具白名单：**默认全拒**，只在预设列出了知识空间时放行那两个知识工具。
        //
        // `restrict` 对**不认识的名字会抛错**，所以这里能写死两个名字的前提是它们确实注册了
        // ——而上面那道「没有 knowledgeScope 就拒绝开跑」已经保证了这一点：scope 与那两个工具
        // 由同一个插件在同一次 apply 里提供，有其一必有其二。
        childCtx.tools.restrict({ allow: spaces.length > 0 ? KNOWLEDGE_TOOL_NAMES : [] })
        childCtx.systemPrompt.context({ name: 'lumo:governed-task', order: 120,
          text: `Execution identity: ${JSON.stringify({ realm: execution.task.realm, worker: `agent:${binding.agentId}`,
            owner: binding.userId, project: binding.projectId, task: execution.task.id, run: execution.runId,
            presetRevision: binding.presetRevision })}\nThe following task contract contains the superior objective, inherited constraints and acceptance criteria. Produce a text deliverable for requester review.\n${JSON.stringify(execution.task.intent_contract ?? { objective: execution.task.intent })}` })
      },
    })
    dispose = () => handle.agent.ctx.fiber.dispose()
    const cancel = () => handle.agent.cancel({ kind: 'parent' })
    signal.addEventListener('abort', cancel, { once: true })
    detach = () => signal.removeEventListener('abort', cancel)
    if (signal.aborted) return { ...result, state: 'CANCELLED', summary: 'Task cancelled before its first turn' }
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: execution.task.intent }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const body = readChildResult(handle.agent, execution.runId)
    result.state = signal.aborted || body.stopReason === 'aborted' ? 'CANCELLED' : body.stopReason === 'completed' ? 'COMPLETED' : 'FAILED'
    const text = (body.output ?? []).flatMap(block =>
      block && typeof block === 'object' && 'type' in block && block.type === 'text' &&
        'text' in block && typeof block.text === 'string' ? [block.text] : [])
    result.summary = [...text.join('\n')].slice(0, 16000).join('')
    if (body.output?.length) result.output = body.output
    if (!result.summary) result.summary = `Agent stopped: ${body.stopReason ?? 'error'}`
    if (result.state === 'COMPLETED' && !body.output?.length) {
      result.state = 'FAILED'
      result.summary = 'Agent completed without a deliverable'
    }
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > 900_000) {
      result.state = 'FAILED'; result.summary = 'Agent result exceeds the supported receipt size'; delete result.output
    }
    return result
  } catch (error) {
    ctx.logger.warn('governed task %s stopped: %s', execution.runId, error)
    return { ...result, state: signal.aborted ? 'CANCELLED' : 'FAILED', summary: signal.aborted ? 'Execution cancelled or timed out' : 'Agent execution failed; inspect its session log' }
  } finally {
    detach?.()
    // 清掉这一次的收窄条件。**必须清**：受治理执行的会话 id 是从 run_id 确定性派生的，
    // 同一个 run 重试会算出同一个 sessionRef——不清就会读到上一次执行留下的空间清单。
    if (execution.preset.knowledge_space_ids.length > 0) {
      (ctx as { knowledgeScope?: KnowledgeSessionScope }).knowledgeScope?.clear(execution.sessionRef)
    }
    await dispose?.().catch(error => ctx.logger.warn('governed session disposal failed: %s', error))
  }
}

type GovernedStore = Pick<PgGovernedDispatch, 'config' | 'take' | 'shouldStop' | 'save' | 'recover' | 'deliver'>

export function startGovernedDispatch(ctx: Context, store: GovernedStore, onError: (error: unknown) => void) {
  const active = new Map<string, { execution: GovernedExecution; stop: AbortController; done: Promise<void> }>()
  const closing = new AbortController()
  let running: Promise<void> | undefined
  let delivering: Promise<void> | undefined
  let closed = false
  const persist = async (execution: GovernedExecution, result: GovernedResult) => {
    for (;;) {
      try { await store.save(execution, result); return } catch (error) {
        if (closing.signal.aborted || error instanceof ExecutionConflictError) throw error
        onError(error)
        await delay(1000, undefined, { signal: closing.signal }).catch(() => {})
      }
    }
  }
  const tick = () => {
    if (closed || running) return
    running = (async () => {
      for (const item of active.values()) if (await store.shouldStop(item.execution)) item.stop.abort()
      await store.recover()
      while (!closed && active.size < store.config.capacity) {
        const execution = await store.take()
        if (!execution) break
        const stop = new AbortController()
        if (closed) stop.abort()
        const done = runGovernedTask(ctx, execution, store.config.binding, store.config.nodeId, stop.signal)
          .then(result => persist(execution, result)).catch(onError).finally(() => active.delete(execution.runId))
        active.set(execution.runId, { execution, stop, done })
      }
    })().catch(error => {
      // A failed authority read must not let an unfenced model keep working.
      for (const item of active.values()) item.stop.abort()
      onError(error)
    }).finally(() => { running = undefined })
  }
  const deliver = () => {
    if (closed || delivering) return
    delivering = store.deliver().catch(onError).finally(() => { delivering = undefined })
  }
  const timer = setInterval(() => { tick(); deliver() }, 1000)
  timer.unref()
  tick()
  deliver()
  return {
    stop(realm: string, runId: string) {
      if (realm === store.config.realm) active.get(runId)?.stop.abort()
    },
    async close() {
      closed = true
      clearInterval(timer)
      closing.abort()
      for (const item of active.values()) item.stop.abort()
      await running
      for (const item of active.values()) item.stop.abort()
      await Promise.allSettled([...active.values()].map(item => item.done))
      await delivering
      await store.deliver().catch(onError)
    },
  }
}

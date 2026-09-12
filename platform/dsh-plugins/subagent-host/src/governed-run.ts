import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { setTimeout as delay } from 'node:timers/promises'
import { ExecutionConflictError, type PgGovernedDispatch, type GovernedExecution, type GovernedResult } from './governed-dispatch.ts'
import { assertExecutionPreset, type WorkerBinding } from './worker-binding.ts'
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
    const handle = await ctx.agents.create({
      sessionId: SessionId(execution.sessionRef), signal,
      meta: { delegationDepth: depth },
      agentOptions: { provider: binding.provider, model: binding.model },
      setup(childCtx) {
        childCtx.tools.restrict({ allow: [] })
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

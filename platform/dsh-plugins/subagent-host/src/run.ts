/**
 * 承载侧一个远端子代理的完整生命周期(行 5 切片 1:one-shot spawn)。
 *
 * 与 dsh in-process driver 的公开模式逐行对齐(subagent-in-process-driver/src/index.ts),
 * 但不 import 它 —— "spawn 本体进程内" 意味着承载节点只拿到可传输的父描述
 * (ChildParentDescriptor),child 由本函数用公开件创建:
 *
 * 1. 深度:父深度 + 1(远程形态无 cap,`assertSubagentMaxDepth(undefined)` 走公开件);
 * 2. meta 手工构造 —— parent 不在承载节点,`childSessionMeta` 无对象可读;meta 只在
 *    header,是纯数据,按契约字段重建即可;
 * 3. policy overrides 由传输值直接注入 `appendDelegatedPolicyOverrides`(不用
 *    `captureDelegatedPolicyOverrides`,那需要一个活 parent);
 * 4. 驱动方法照 driver:`followup` + `whenIdle`,取消经运行表 entry.cancel →
 *    `child.cancel({ kind: 'parent' })`(register 之后等价的 in-process 语义);
 * 5. 结果读取在 tturn.ts(闭集词表 + `finalAssistantOutput` 规范选择);
 * 6. 集群回执先写持久 outbox，再由投递器重试；未装配数据库的独立调用保留短重试。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage, type ContentBlock } from '@deepseek-ai/dsh-llm'
import {
  assertSubagentMaxDepth,
  appendDelegatedPolicyOverrides,
  type SubagentDescriptorData,
} from '@deepseek-ai/dsh-subagent'
// SUBAGENT_DELEGATION_CONTEXT 是 dsh 固定的模型可见措辞(只为展示),它的宿模块
// child-agent.ts 不在主入口重导出、但列在自身 package.json 的 exports map
// (`./src/*` 子路径)里 —— 按声明面导入;platform 全链路线源运行(tsx/vitest),
// 与主入口的 lib bundle 同代码。
import { SUBAGENT_DELEGATION_CONTEXT } from '@deepseek-ai/dsh-subagent/src/child-agent.ts'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import {
  childDepthOf,
  runKeyOf,
  type StartChildRequest,
  type ChildResultBody,
} from '../../../shared/seam-contracts/subagent-host.ts'
import type { JobControlRuntime, JobRef, LocalJobRegistration } from '../../../shared/seam-contracts/job-virtualization.ts'
import { readChildResult } from './tturn.ts'

/** 运行表条目:一个承载 child 的取消面。 */
export interface RunCanceller {
  /** 取消该运行(child.cancel({ kind: 'parent' }));重复调用按 dsh cancel 语义幂等。 */
  cancel(reason?: string): void
}

/**
 * 承载侧运行表:`key = runKeyOf(realm, childId)`。
 *
 * host(server.ts)用它做重复启动检测与 stop 分发,本模块在子代理发布后写入真实
 * cancel,在运行结集时删除。条目发起时立即登记(占位 no-op)—— 与 host 的
 * has 检查同属一个同步段,Node 单线程下并发 start 不会双双通过。
 */
export type RunRegistry = Map<string, RunCanceller>

/** 运行一个校验通过的远端子代理(childId 由父侧 mint,是幂等键)。 */
export type ResultDelivery = (request: StartChildRequest, body: ChildResultBody) => Promise<void>

export async function runChild(ctx: Context, req: StartChildRequest, runs?: RunRegistry, delivery?: ResultDelivery): Promise<void> {
  const key = runKeyOf(req.realm, req.childId)
  let cancelRequested = false
  const entry: RunCanceller = {
    // 创建窗口没有 OS/Agent 句柄，但控制意图不能丢：job-control 注册的
    // cancel 会置位，create 成功后立即交给真实 child.cancel。
    cancel: () => { cancelRequested = true },
  }
  runs?.set(key, entry)
  const jobStartedAt = Date.now()
  const jobLabel = req.label ?? 'remote subagent'
  const jobRuntime = (ctx as Context & { jobControlRuntime?: JobControlRuntime }).jobControlRuntime
  let jobRef: JobRef | undefined
  let body: ChildResultBody
  try {
    if (jobRuntime) {
      jobRef = await jobRuntime.register(
        { sessionRef: req.parent.sessionId, jobId: req.childId },
        { kind: 'subagent', label: jobLabel, status: 'running', startedAt: jobStartedAt },
        (reason) => entry.cancel(reason),
      )
    }
    const depth = childDepthOf(req.parent)
    // 远程形态无 cap(行 5 明示);公开件仍校验字面值(undefined = 无上限)。
    assertSubagentMaxDepth(undefined)

    // child 的 setup 窗口 = 同 in-process driver 的公开模式:policy 注入 + 委派声明
    // + 描述 append(pre-step enter 判决处),不额外 import 私有实现。
    const handle = await ctx.agents.create({
      sessionId: SessionId(req.childId),
      meta: {
        ...(req.parent.cwd !== undefined ? { cwd: req.parent.cwd } : {}),
        parentSession: SessionId(req.parent.sessionId),
        origin: 'subagent',
        delegationDepth: depth,
      },
      agentOptions: {
        ...(req.parent.provider !== undefined ? { provider: req.parent.provider } : {}),
        ...(req.parent.model !== undefined ? { model: req.parent.model } : {}),
        ...(req.parent.maxTokens !== undefined ? { maxTokens: req.parent.maxTokens } : {}),
        subagentDepth: depth,
      },
      setup(childCtx, child) {
        appendDelegatedPolicyOverrides(child.session, {
          sandboxMode: req.parent.sandboxMode as SandboxMode | undefined,
          approvalPolicy: req.parent.approvalPolicy,
        })
        childCtx.systemPrompt.context({ name: 'subagent:delegation', order: 120, text: SUBAGENT_DELEGATION_CONTEXT })
        attachDescriptorAppend(childCtx, req.descriptor as SubagentDescriptorData)
      },
    })

    const child = handle.agent
    entry.cancel = () => child.cancel({ kind: 'parent' })
    // A control command may arrive during ctx.agents.create. Its earlier
    // registration records intent; apply it as soon as an actual local handle
    // exists instead of silently losing the creation-window cancellation.
    if (cancelRequested) entry.cancel()

    // 驱动单 turn(与 in-process driver 同公开模式:followup + whenIdle)。
    child.followup(createUserMessage({ content: req.prompt as ContentBlock[], source: { kind: 'user' } }))
    await child.whenIdle()

    body = readChildResult(child, req.childId)
  } catch (e) {
    ctx.logger.error('subagent-host: 子代理 %s 运行失败: %s', req.childId, e instanceof Error ? e.message : String(e))
    body = { runId: req.childId, ok: false, code: 'internal', message: `子代理运行失败于承载节点(runId=${req.childId})` }
  }

  try {
    // Persistence/delivery failure must never rewrite a successful execution
    // as a failed result. Its owner can retry the same immutable receipt.
    if (delivery) {
      await delivery(req, body)
    } else if (!await deliverCallback(req.callbackUrl, body)) {
      ctx.logger.warn('subagent-host: 子代理 %s 回执未送达', req.childId)
    }
  } finally {
    try {
      await settleJob(jobRuntime, jobRef, jobLabel, jobStartedAt, childStateOf(body.stopReason), body.diagnostic ?? body.message)
    } catch {
      ctx.logger.warn('subagent-host: job settlement failed for %s', req.childId)
    }
    runs?.delete(key)
  }
}

function childStateOf(reason: ChildResultBody['stopReason']): 'completed' | 'killed' | 'failed' {
  if (reason === 'completed') return 'completed'
  if (reason === 'aborted') return 'killed'
  return 'failed'
}

async function settleJob(
  runtime: JobControlRuntime | undefined,
  ref: JobRef | undefined,
  label: string,
  startedAt: number,
  status: 'completed' | 'killed' | 'failed',
  detail?: string,
): Promise<void> {
  if (!runtime || !ref) return
  const snapshot: LocalJobRegistration = {
    kind: 'subagent', label, status, startedAt, finishedAt: Date.now(),
    ...(detail !== undefined ? { detail } : {}),
  }
  await runtime.settle(ref, snapshot)
}

/**
 * 在 child 首个 pre-step 的 enter 判决处 append 描述(照 driver 的公开事件模式):
 * enter 意味着本步要被模型消费,描述先于第一个模型请求落日志。
 */
function attachDescriptorAppend(childCtx: Context, descriptor: unknown): void {
  let appended = false
  childCtx.on('agent/pre-step', async ({ agent }, next) => {
    const decision = await next()
    if (!appended && decision.kind === 'enter') {
      appended = true
      agent.session.append('subagent/descriptor', descriptor as SubagentDescriptorData)
    }
    return decision
  })
}

/** 回执单次尝试的超时上限(轻量 finalize:2s 契约;与 client.ts 出站 30s 不同 —— 那条是放长线等健康节点)。 */
const CALLBACK_TIMEOUT_MS = 2000

/**
 * 回执:每次尝试 2s 超时封顶(AbortSignal.timeout)+ 200ms 退避重试 1 次;
 * 仅供未装配持久 outbox 的独立调用使用；集群启动器总是装配持久回执。
 */
async function deliverCallback(url: string, body: ChildResultBody): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      })
      await res.body?.cancel()
      if (res.ok) return true
    } catch {
      /* 网络错/超时 —— 落在退避重试 */
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

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
 * 6. 回执 `deliverCallback`:2s 超时封顶(AbortSignal.timeout)+ 200ms 退避重试 1 次;
 *    两次都失败不重投 —— child 事件流已在会话日志,运行表照常结集(审计在日志,
 *    不赌网络;挂起的回执不再滞留运行表)。
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
import { readChildResult } from './tturn.ts'

/** 运行表条目:一个承载 child 的取消面。 */
export interface RunCanceller {
  /** 取消该运行(child.cancel({ kind: 'parent' }));重复调用按 dsh cancel 语义幂等。 */
  cancel(): void
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
export async function runChild(ctx: Context, req: StartChildRequest, runs?: RunRegistry): Promise<void> {
  const key = runKeyOf(req.realm, req.childId)
  const entry: RunCanceller = {
    // 发布前窗口的取消是 no-op:create 未决时 followup 未发,无可中止的 turn。
    // 窗口=一次本地 create;行 5 后续经信号通道收紧到「创建期也可取消」。
    // 发布前窗口:child 还在一次本地 create 内,stop 是 no-op——child 照常跑完并
    // 回执 completed;该窗口的取消语义随行 6 控制信号通道(JobControlSeam),本切片不做。
    cancel: () => {},
  }
  runs?.set(key, entry)
  // 每个 run 恰好一次回执(成功 completed / 失败 ok:false):成功回执一经寄出(或
  // 经投递决策)即置位,失败路径只覆盖「create 及之后尚未出回执」的失败 ——
  // 两者互斥,不会双发。
  let receiptSettled = false
  try {
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
      setup(childCtx) {
        const child = childCtx.agent as Agent
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

    // 驱动单 turn(与 in-process driver 同公开模式:followup + whenIdle)。
    child.followup(createUserMessage({ content: req.prompt as ContentBlock[], source: { kind: 'user' } }))
    await child.whenIdle()

    const body = readChildResult(child, req.childId)
    receiptSettled = true
    if (!await deliverCallback(req.callbackUrl, body)) {
      // 两次尝试都没送到:事件流已在 child 会话日志,不重投 —— 父侧审计以日志为准。
      ctx.logger.warn('subagent-host: 子代理 %s 回执失败(两次尝试),运行结束但回调未达', req.childId)
    }
  } catch (e) {
    ctx.logger.error('subagent-host: 子代理 %s 运行失败: %s', req.childId, e instanceof Error ? e.message : String(e))
    if (!receiptSettled) {
      // 200 StartChildOk 已寄出:create/驱动失败若只 log,父侧 result 永久挂起
      // (pending 条目无终态信号,永不结集)。寄一封 ok:false 把契约闭掉 ——
      // code 'internal' 是基础设施词表(不是 child 结局,stopReason 承载不了它)。
      const delivered = await deliverCallback(req.callbackUrl, {
        runId: req.childId,
        ok: false,
        code: 'internal',
        message: `子代理运行失败于承载节点(runId=${req.childId})`,
      })
      if (!delivered) {
        ctx.logger.warn('subagent-host: 子代理 %s 失败回执未送达(两次尝试),运行结束但回调未达', req.childId)
      }
    }
  } finally {
    runs?.delete(key)
  }
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
 * 两次都失败返回 false(调用方记 unsettled,不重投)。挂起不回执没有正确性损失
 * —— 只是运行表条目滞留,2s 封顶让最坏滞留 ≈4.2s(评审 Minor ⑦ 钉死)。
 */
async function deliverCallback(url: string, body: ChildResultBody): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CALLBACK_TIMEOUT_MS),
      })
      if (res.ok) return true
    } catch {
      /* 网络错/超时 —— 落在退避重试 */
    }
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 200))
  }
  return false
}

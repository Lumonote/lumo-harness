/**
 * subagent-remote 的 provider 本体:实现 dsh `SubagentProvider`(经 ctx.subagents
 * registerProvider 注册),把子代理**跨节点**运行 —— Scheduler 放置选节点 →
 * POST 承载节点 start → 回执结集 → 返回远端 `SubagentRun`(`localAgent: undefined`,
 * `out-of-process.ts` 的 `subprocessRunHandle` 先例)。
 *
 * 与 dsh 契约的对应(types.ts):
 * - `capabilities = NO_START_CAPABILITIES`:out-of-process 后端不支持
 *   outputSchema/depthLimit/toolFilter/persona,service 层先拒绝,绝不 accept-then-ignore。
 * - `inheritsParentContext = false`:child 只见传输快照,不继承父会话事件流。
 * - `result` never-reject on child failure(ok:true 内 stopReason 承载结局),
 *   reject on infrastructure fault(ok:false 回执/放置失败)。
 *
 * `start()` 时序(登记先行):childId mint 即登记回执表 —— 承载侧可能在任何时刻回执,
 * 注册必须早于放置请求(200 前到位),失败路径凭表删除回滚;dsh 契约以 start 返回
 * 为发布边界,拒绝时不留下任何可 dispose 的 run。
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  NO_START_CAPABILITIES,
  SubagentError,
  captureDelegatedPolicyOverrides,
  delegationDepthOf,
} from '@deepseek-ai/dsh-subagent'
import type {
  ResolvedSubagentStartRequest,
  SubagentProvider,
  SubagentResult,
  SubagentRun,
} from '@deepseek-ai/dsh-subagent'
import { randomUUID } from 'node:crypto'
import type { Server } from 'node:http'

import { createCallbackServer } from './callback.ts'
import type { ChildResultSettler, PendingEntry } from './callback.ts'
import {
  postChildStart,
  postChildStop,
  postPlacement,
  postTerminalState,
  terminalStateOf,
} from './client.ts'
import type { ChildParentDescriptor, StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'

export interface RemoteConfig {
  /** Scheduler base(经 X-Lumo-Realm 头信任注入;生产经边缘网关,§6.3 转 mTLS)。 */
  readonly schedulerUrl: string
  /** 放置应答 node_id → 承载节点 base URL(静态表;节点自我登记后续切片)。 */
  readonly nodeUrls: Readonly<Record<string, string>>
  /** host 端点共享令牌(承载侧 `tokens` 同值)。 */
  readonly hostTokens: Readonly<Record<string, string>>
  readonly realm: string
  /** 回调接收端口(provider 进程内 createServer)。 */
  readonly callbackPort: number
  readonly callbackHost?: string
}

export class RemoteSubagentProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  private readonly pending: Map<string, PendingEntry>
  private readonly scheduler: string
  private readonly nodeUrls: Readonly<Record<string, string>>
  private readonly hostTokens: Readonly<Record<string, string>>
  private readonly realm: string
  private readonly callbackHost: string
  private readonly callbackPort: number

  constructor(config: RemoteConfig, pending: Map<string, PendingEntry>, name = 'lumo-remote') {
    this.name = name
    this.pending = pending
    this.scheduler = config.schedulerUrl.replace(/\/+$/, '')
    this.nodeUrls = config.nodeUrls
    this.hostTokens = config.hostTokens
    this.realm = config.realm
    this.callbackHost = config.callbackHost ?? '127.0.0.1'
    this.callbackPort = config.callbackPort
  }

  async start(request: ResolvedSubagentStartRequest): Promise<SubagentRun> {
    const childId = SessionId(randomUUID())
    // per-run 鉴权能力段(评审 Important):secret 随 callbackUrl 下达,承载节点
    // 原样 POST 回执即落地 —— 回调接口网络开放、无调用方认证,能力段即最小鉴权;
    // secret 每次 start 重新 mint(重放另一次 run 的 secret 无效)。
    const secret = randomUUID()

    // 父描述在第一个 await 前同步采集:父切换/策略变更属于父的未来,不属于这个 child
    // (child-agent.ts 同训;captureDelegatedPolicyOverrides 需活 parent,本处即父进程)。
    const parent = describeParent(request.parent)
    const body: StartChildRequest = {
      childId,
      realm: this.realm,
      ...(request.label !== undefined ? { label: request.label } : {}),
      prompt: request.prompt,
      descriptor: request.descriptor,
      parent,
      callbackUrl: `http://${this.callbackHost}:${this.callbackPort}/subagent/result/${childId}/${secret}`,
    }

    // 登记先行 + 失败滚回:host 的 200 与回执是两个独立请求,没有顺序保证;
    // 回执表不提前登记的话,host 的回执可能先于 start 返回(200 已寄出、child 已跑完)
    // 撞上「未注册 → 404」,父侧将永远等不到结集。
    const result = new Promise<SubagentResult>((resolve, reject) => {
      this.pending.set(childId, { secret, settler: settleOf(childId, resolve, reject) })
    })

    // placement 是否已落 scheduler 账:201 之后失败必须回报终态(F1a),
    // 否则 PLACED 槽位无任务级 GC、永久泄漏;202/放置失败则从未占用,无需上报。
    let placed = false
    try {
      const nodeId = await postPlacement({ base: this.scheduler, realm: this.realm, childId })
      placed = true
      const nodeUrl = this.nodeUrls[nodeId]
      if (nodeUrl === undefined) {
        throw new SubagentError(`nodeUrls 无节点 ${nodeId} 的登记地址`, 'NODE_URL_UNKNOWN')
      }
      const token = this.hostTokens[nodeId]
      await postChildStart({ base: nodeUrl.replace(/\/+$/, ''), realm: this.realm, token, request: body })
      return remoteRunHandle(childId, result, () =>
        postChildStop({ base: nodeUrl.replace(/\/+$/, ''), realm: this.realm, token, childId }))
    } catch (e) {
      // 未被承载侧接受的 child 不存在可结集回执:摘表,不给 mock host 留幽灵
      this.pending.delete(childId)
      if (placed) {
        // F1a:placement 201 已把 childId 计入 scheduler 容量(start 失败 403/超时/
        // 不可达均不释放,且无任务级 GC —— 4 次即耗尽节点槽位)。fire-and-forget
        // best-effort:上报失败只记影子,不吞原错(原错照抛)。
        // 注:超时歧义场景可能误报 —— child 实际已在承载侧跑完,其回执对已摘表的
        // pending 以 404 被拒;仍优于永久占槽:以 FAILED 结账,scheduler 才能重派。
        void postTerminalState({ base: this.scheduler, realm: this.realm, childId, state: 'FAILED' })
          .catch(() => { /* best-effort:终态上报失败仅留审计,不遮蔽 start 原错 */ })
      }
      throw e
    }
  }
}

/** 父侧本地真实采集(dsh 公开件):session header + agent options + 委派策略快照。 */
function describeParent(parent: Agent): ChildParentDescriptor {
  const header = parent.session.header
  const overrides = captureDelegatedPolicyOverrides(parent)
  const options = parent.options
  return {
    sessionId: header.id,
    ...(header.cwd !== undefined ? { cwd: header.cwd } : {}),
    delegationDepth: delegationDepthOf(parent),
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
    ...(options.model !== undefined ? { model: options.model } : {}),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(overrides.sandboxMode !== undefined ? { sandboxMode: overrides.sandboxMode } : {}),
    ...(overrides.approvalPolicy !== undefined ? { approvalPolicy: overrides.approvalPolicy } : {}),
  }
}

/**
 * 一枚回执的终态接驳:ok:true = child 结局(resolve,契约闭集内);
 * ok:false = 基础设施故障(reject,code/message 透传为 SubagentError)。
 */
function settleOf(
  childId: string,
  resolve: (result: SubagentResult) => void,
  reject: (error: unknown) => void,
): ChildResultSettler {
  return (body) => {
    if (body.ok) {
      resolve({
        // 契约承诺 output 是模型面 JSON(ContentBlock[] 结构等价,承载侧经
        // readChildResult/finalAssistantOutput 选产)—— wire 边界该有的转译止于此
        output: (body.output ?? []) as SubagentResult['output'],
        ...(body.structured !== undefined ? { structured: body.structured } : {}),
        ...(body.diagnostic !== undefined ? { diagnostic: body.diagnostic } : {}),
        // 词表外不猜:缺省终局按 error 呈现(未知结局不算作 completed)
        stopReason: body.stopReason ?? 'error',
      })
      return
    }
    reject(new SubagentError(body.message ?? `子代理基础设施故障(runId=${childId})`, body.code ?? 'internal'))
  }
}

/** 远端 run 句柄:`localAgent: undefined`,dispose 幂等(与 subprocessRunHandle 同款记忆化)。 */
function remoteRunHandle(id: string, result: Promise<SubagentResult>, stop: () => Promise<void>): SubagentRun {
  let disposal: Promise<void> | undefined
  return {
    id: SessionId(id),
    localAgent: undefined,
    result,
    dispose(): Promise<void> {
      return (disposal ??= stop())
    },
  }
}

/** assembleRemote:回执表 + 回调 server + provider 的胶水(测试 harness 与插件 apply 共用)。 */
export interface RemoteAssembly {
  readonly provider: RemoteSubagentProvider
  /** 回调接收 server(未 listen;由调用方起停 —— 插件 ctx.effect / 测试 harness)。 */
  readonly server: Server
}

export function assembleRemote(config: RemoteConfig): RemoteAssembly {
  const pending = new Map<string, PendingEntry>()
  const server = createCallbackServer({
    pending,
    reportTerminal: (body) => {
      void postTerminalState({
        base: config.schedulerUrl.replace(/\/+$/, ''),
        realm: config.realm,
        childId: body.runId,
        state: terminalStateOf(body),
      }).catch(() => {
        // best-effort:终态上报失败不阻塞回执结集(审计在承载侧会话日志)
      })
    },
  })
  return { provider: new RemoteSubagentProvider(config, pending), server }
}

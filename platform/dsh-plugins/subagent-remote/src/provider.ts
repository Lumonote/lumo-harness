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
import { resolveNacosNode } from './nacos.ts'
import {
  postChildStart,
  postChildStop,
  postPlacement,
  postTerminalState,
  terminalStateOf,
} from './client.ts'
import type { ChildParentDescriptor, StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'
import type { JobControlSeam } from '../../../shared/seam-contracts/job-virtualization.ts'

export interface RemoteConfig {
  /** Scheduler base(经 X-Lumo-Realm 头信任注入;生产经边缘网关,§6.3 转 mTLS)。 */
	readonly schedulerUrl: string
	readonly controlPlaneToken?: string
  /** 放置应答 node_id → 承载节点 base URL(静态表;节点自我登记后续切片)。 */
  readonly nodeUrls: Readonly<Record<string, string>>
  /** host 端点共享令牌(承载侧 `tokens` 同值)。 */
  readonly hostTokens: Readonly<Record<string, string>>
  /** Optional Naming source used when nodeUrls has no entry for a scaled node. */
  readonly nacosUrl?: string
  readonly nacosService?: string
  readonly nacosGroup?: string
  /** Shared token fallback; individual hostTokens entries still take precedence. */
  readonly defaultHostToken?: string
  /** Restrict placement to the parent node's execution cluster when set. */
  readonly clusterId?: string
  readonly realm: string
  /** 回调接收端口(provider 进程内 createServer)。 */
  readonly callbackPort: number
  readonly callbackHost?: string
  /** Bind address for the callback listener; callbackHost remains the advertised DNS name. */
  readonly callbackBindHost?: string
  /** Injected control channel; absent only in focused provider tests/legacy wiring. */
  readonly jobControl?: JobControlSeam
  readonly controlActor?: string
  readonly controlRole?: string
}

export class RemoteSubagentProvider implements SubagentProvider {
  readonly name: string
  readonly capabilities = NO_START_CAPABILITIES
  readonly inheritsParentContext = false

  private readonly pending: Map<string, PendingEntry>
	private readonly scheduler: string
	private readonly controlPlaneToken: string | undefined
  private readonly nodeUrls: Readonly<Record<string, string>>
  private readonly hostTokens: Readonly<Record<string, string>>
	private readonly nacosUrl: string | undefined
	private readonly nacosService: string
	private readonly nacosGroup: string
	private readonly defaultHostToken: string | undefined
	private readonly clusterId: string
  private readonly realm: string
  private readonly callbackHost: string
  /** 装配配置引用:callbackPort 在 assembleRemote 之后、start() 之前可能被回填
   * (listen(0) 内核分配 → 回填,消除 freePort TOCTOU)—— 所以每次 start 现读,不复制。 */
  private readonly config: RemoteConfig

  constructor(config: RemoteConfig, pending: Map<string, PendingEntry>, name = 'lumo-remote') {
    this.name = name
    this.pending = pending
    this.config = config
		this.scheduler = config.schedulerUrl.replace(/\/+$/, '')
		this.controlPlaneToken = config.controlPlaneToken
    this.nodeUrls = config.nodeUrls
		this.hostTokens = config.hostTokens
		this.nacosUrl = config.nacosUrl?.replace(/\/+$/, '')
		this.nacosService = config.nacosService ?? 'lumo-dsh-node'
		this.nacosGroup = config.nacosGroup ?? 'DEFAULT_GROUP'
		this.defaultHostToken = config.defaultHostToken
		this.clusterId = config.clusterId ?? ''
    this.realm = config.realm
    this.callbackHost = config.callbackHost ?? '127.0.0.1'
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
      callbackUrl: `http://${this.callbackHost}:${this.config.callbackPort}/subagent/result/${childId}/${secret}`,
    }

    // 登记先行 + 失败滚回:host 的 200 与回执是两个独立请求,没有顺序保证;
    // 回执表不提前登记的话,host 的回执可能先于 start 返回(200 已寄出、child 已跑完)
    // 撞上「未注册 → 404」,父侧将永远等不到结集。
	let resolveResult!: (value: SubagentResult) => void
	let rejectResult!: (reason?: unknown) => void
	const result = new Promise<SubagentResult>((resolve, reject) => {
		resolveResult = resolve
		rejectResult = reject
	})
	const pendingEntry: PendingEntry = { secret, settler: settleOf(childId, resolveResult, rejectResult) }
	this.pending.set(childId, pendingEntry)

    // placement 是否已落 scheduler 账:201 之后失败必须回报终态(F1a),
    // 否则 PLACED 槽位无任务级 GC、永久泄漏;202/放置失败则从未占用,无需上报。
    let placed = false
    try {
		const placement = await postPlacement({ base: this.scheduler, realm: this.realm, childId, clusterId: this.clusterId, controlPlaneToken: this.controlPlaneToken })
		pendingEntry.attempt = placement.attempt
		placed = true
		const nodeId = placement.nodeId
	  const nodeUrl = await this.resolveNodeUrl(nodeId)
      if (nodeUrl === undefined) {
	        throw new SubagentError(`未找到节点 ${nodeId} 的登记地址`, 'NODE_URL_UNKNOWN')
      }
	  const token = this.hostTokens[nodeId] ?? this.defaultHostToken
	  if (token === undefined || token === '') {
	    throw new SubagentError(`节点 ${nodeId} 未配置承载令牌`, 'HOST_TOKEN_UNKNOWN')
	  }
      await postChildStart({ base: nodeUrl.replace(/\/+$/, ''), realm: this.realm, token, request: body })
      const directStop = () => postChildStop({ base: nodeUrl.replace(/\/+$/, ''), realm: this.realm, token, childId })
      const stop = this.config.jobControl === undefined
        ? directStop
        : async () => {
          const decision = await this.config.jobControl!.dispatch({
            ref: { sessionRef: String(parent.sessionId), node: nodeId, jobId: String(childId) },
            command: 'kill', actor: this.config.controlActor ?? 'subagent-parent',
            role: this.config.controlRole ?? 'operator', reason: 'parent disposed',
            correlationId: randomUUID(),
          })
          if (!decision.allowed) {
            throw new SubagentError(`远端子代理取消被控制通道拒绝: ${decision.reason}`, 'CONTROL_DENIED')
          }
        }
      return remoteRunHandle(childId, result, stop)
    } catch (e) {
      // 未被承载侧接受的 child 不存在可结集回执:摘表,不给 mock host 留幽灵
      this.pending.delete(childId)
      if (placed) {
        // F1a:placement 201 已把 childId 计入 scheduler 容量(start 失败 403/超时/
        // 不可达均不释放,且无任务级 GC —— 4 次即耗尽节点槽位)。fire-and-forget
        // best-effort:上报失败只记影子,不吞原错(原错照抛)。
        // 注:超时歧义场景可能误报 —— child 实际已在承载侧跑完,其回执对已摘表的
        // pending 以 404 被拒;仍优于永久占槽:以 FAILED 结账,scheduler 才能重派。
		void postTerminalState({ base: this.scheduler, realm: this.realm, childId, state: 'FAILED', attempt: pendingEntry.attempt, controlPlaneToken: this.controlPlaneToken })
          .catch(() => { /* best-effort:终态上报失败仅留审计,不遮蔽 start 原错 */ })
      }
      throw e
    }
  }

	private async resolveNodeUrl(nodeId: string): Promise<string | undefined> {
	  const configured = this.nodeUrls[nodeId]
	  if (configured !== undefined && configured !== '') return configured
	  if (this.nacosUrl === undefined) return undefined
	  try {
	    const endpoint = await resolveNacosNode({
	      baseUrl: this.nacosUrl,
	      serviceName: this.nacosService,
	      groupName: this.nacosGroup,
	    }, nodeId)
	    return endpoint?.baseUrl
	  } catch (error: unknown) {
	    throw new SubagentError(
	      `Nacos 节点查询失败(${nodeId}): ${error instanceof Error ? error.message : String(error)}`,
	      'NODE_DISCOVERY_FAILED',
	    )
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
		reportTerminal: (body, attempt) => {
		void postTerminalState({
		base: config.schedulerUrl.replace(/\/+$/, ''),
		controlPlaneToken: config.controlPlaneToken,
        realm: config.realm,
        childId: body.runId,
			state: terminalStateOf(body),
			attempt,
      }).catch(() => {
        // best-effort:终态上报失败不阻塞回执结集(审计在承载侧会话日志)
      })
    },
  })
  return { provider: new RemoteSubagentProvider(config, pending), server }
}

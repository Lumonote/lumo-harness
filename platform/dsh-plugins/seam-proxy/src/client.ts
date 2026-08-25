/**
 * SeamProxy 客户端：把本地 seam 调用透明转给远端 Provider（§4.1 的「桥」）。
 *
 * 它是 **Proxy 不是网关**：不做治理，只做发现 + 负载均衡 + 熔断 + 重试。
 * 鉴权在远端 Provider 侧（realm/roles 随调用传过去，由 Provider 强制过滤），
 * 与本地 Provider 的判定完全一致 —— 换成远程不该改变安全边界。
 */
import { Balancer, type EndpointHealth } from './balancer.ts'
import {
  RemoteSeamError,
  codeForStatus,
  isIdempotent,
  type SeamResponse,
} from '../../../shared/seam-contracts/remote.ts'
import {
  NO_TURN,
  TurnCallBudget,
  type BudgetMode,
  type BudgetViolation,
} from '../../../shared/seam-contracts/turn-budget.ts'

export interface SeamProxyConfig {
  /** 远端 seam host 地址列表（静态；Nacos 发现时经 setEndpoints 热更新） */
  endpoints: string[]
  /** 调用者身份，随每次调用透传给远端 Provider */
  realm: string
  userId?: string
  /** 本 realm 的 seam 共享令牌（远端 host 配了 tokens 时必填） */
  token?: string
  /** 单次调用超时 ms（默认 15s） */
  timeoutMs?: number
  /** 可重试方法的最大尝试次数（含首次；默认 3） */
  maxAttempts?: number
  /** 熔断：连续失败阈值 / 打开时长 */
  failureThreshold?: number
  openForMs?: number
  /** 闸 C：每 turn 调用预算模式，缺省 `warn`（超预算是性能回归，不是安全事故） */
  budgetMode?: BudgetMode
  onBudgetViolation?: (v: BudgetViolation) => void
}

export class SeamProxyClient {
  private readonly balancer: Balancer
  private readonly timeoutMs: number
  private readonly maxAttempts: number
  private readonly realm: string
  private readonly userId: string
  private readonly token: string | undefined
  private readonly budget: TurnCallBudget
  /**
   * 当前 turn 指针（闸 C）。
   *
   * turn 不进 seam 接口：`remote-seams.ts` 明确禁止远程专有参数，因为「远程适配器
   * 与本地 Provider 接口完全相同」是 §4.1 的核心约束 —— 加一个 turn 参数就等于
   * Consumer 要知道自己在跟远程说话。所以由平台侧的 turn 边界监听器调
   * {@link setTurn}。
   *
   * **已知弱点**：漏调 setTurn 会让预算失准且静默。当前可接受，因为闸 C 是回归
   * 探测器而非安全闸；若默认改成 `enforce`，必须先换成 AsyncLocalStorage 隐式传播。
   */
  private turn = NO_TURN

  constructor(config: SeamProxyConfig) {
    this.balancer = new Balancer({
      endpoints: config.endpoints,
      failureThreshold: config.failureThreshold,
      openForMs: config.openForMs,
    })
    this.timeoutMs = config.timeoutMs ?? 15_000
    this.maxAttempts = Math.max(config.maxAttempts ?? 3, 1)
    this.realm = config.realm
    this.userId = config.userId ?? 'system'
    this.token = config.token
    this.budget = new TurnCallBudget({
      mode: config.budgetMode,
      onViolation: config.onBudgetViolation,
    })
  }

  /** 由平台侧的 turn 边界监听器调用。空串按「没有 turn」处理，不接受歧义标识。 */
  setTurn(turn: string): void {
    this.turn = turn.length > 0 ? turn : NO_TURN
  }

  setEndpoints(urls: string[]): void {
    this.balancer.setEndpoints(urls)
  }

  health(): EndpointHealth[] {
    return this.balancer.health()
  }

  /**
   * 发一次 seam 调用。
   *
   * 重试只发生在两个条件同时成立时：方法在幂等白名单内，且失败是
   * 「没拿到语义结果」类（unavailable/timeout）。远端已经开始执行并返回了
   * 业务错误的情况绝不重试 —— 那是重复副作用的来源。
   */
  async call(seam: string, method: string, args: unknown[]): Promise<unknown> {
    // 闸 C：记一次**逻辑调用**，不是一次网络往返。重试不计数 —— 计了的话一段抖动的
    // 网络就会触发预算告警，把网络问题记到组件粒度的头上，而这个闸测的是组件粒度。
    //
    // enforce 模式下这里会抛。翻译成 forbidden：不可重试、不计入熔断（远端是健康的，
    // 是本地策略拒绝的），且语义上「调用方的问题不是节点故障」正好对上。
    try {
      this.budget.record(seam, this.turn)
    } catch (e) {
      throw new RemoteSeamError('forbidden', e instanceof Error ? e.message : String(e))
    }

    const retryable = isIdempotent(seam, method)
    const attempts = retryable ? this.maxAttempts : 1
    const targets = this.balancer.candidates(attempts)

    if (targets.length === 0) {
      throw new RemoteSeamError('unavailable',
        `seam ${seam}: 所有远端端点均已熔断`)
    }

    let last: RemoteSeamError | undefined
    for (let i = 0; i < attempts; i++) {
      // 端点数少于尝试次数时循环复用（单副本部署下退化为原地重试）
      const endpoint = targets[i % targets.length]!
      try {
        const value = await this.send(endpoint, seam, method, args)
        this.balancer.succeed(endpoint)
        return value
      } catch (e) {
        const err = e instanceof RemoteSeamError
          ? e
          : new RemoteSeamError('internal', String(e), endpoint)
        if (err.countsAsFailure) this.balancer.fail(endpoint)
        else this.balancer.succeed(endpoint) // 越权/参数错说明节点是活的
        if (!err.retryable || !retryable) throw err
        last = err
        // 指数退避，避免故障期把远端打得更死
        if (i < attempts - 1) await sleep(50 * 2 ** i)
      }
    }
    throw last ?? new RemoteSeamError('internal', `seam ${seam}.${method}: 重试耗尽`)
  }

  private async send(endpoint: string, seam: string, method: string, args: unknown[]): Promise<unknown> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Lumo-Realm': this.realm,
      'X-Lumo-User': this.userId,
    }
    if (this.token) headers['X-Lumo-Seam-Token'] = this.token

    let res: Response
    try {
      res = await fetch(`${endpoint}/seam/${encodeURIComponent(seam)}/${encodeURIComponent(method)}`, {
        method: 'POST',
        signal: AbortSignal.timeout(this.timeoutMs),
        headers,
        body: JSON.stringify({ seam, method, args }),
      })
    } catch (e) {
      // AbortSignal.timeout 抛 TimeoutError；其余是连接层失败
      const timedOut = e instanceof Error && e.name === 'TimeoutError'
      throw new RemoteSeamError(timedOut ? 'timeout' : 'unavailable', String(e), endpoint)
    }

    let payload: SeamResponse
    try {
      payload = (await res.json()) as SeamResponse
    } catch {
      throw new RemoteSeamError(codeForStatus(res.status),
        `远端返回非 JSON（HTTP ${res.status}）`, endpoint)
    }
    if (!payload.ok) {
      throw new RemoteSeamError(payload.code, payload.message, endpoint)
    }
    if (!res.ok) {
      // ok:true 却是错误状态码 —— 协议不一致，宁可失败也不接受歧义结果
      throw new RemoteSeamError(codeForStatus(res.status),
        `远端响应自相矛盾（HTTP ${res.status} 但 ok=true）`, endpoint)
    }
    return payload.value
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * SeamProxy 客户端：把本地 seam 调用透明转给远端 Provider（§4.1 的「桥」）。
 *
 * 它是 **Proxy 不是网关**：不做治理，只做发现 + 负载均衡 + 熔断 + 重试。
 * 鉴权在远端 Provider 侧（realm/roles 随调用传过去，由 Provider 强制过滤），
 * 与本地 Provider 的判定完全一致 —— 换成远程不该改变安全边界。
 */
import { Balancer, type EndpointHealth } from './balancer.ts'
import { request as httpsRequest } from 'node:https'
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
import {
  assertIdentityAssertionConfig,
  issueIdentityAssertion,
  SEAM_IDENTITY_AUDIENCE,
} from '../../../shared/seam-contracts/identity.ts'
import {
  assertMutualTLSEndpoint,
  ReloadingMutualTLSCredentials,
  type MutualTLSCredentials,
  type MutualTLSFileConfig,
} from '../../../shared/seam-contracts/mtls.ts'

export interface SeamProxyConfig {
  /** 远端 seam host 地址列表（静态；Nacos 发现时经 setEndpoints 热更新） */
  endpoints: string[]
  /** 调用者身份，随每次调用透传给远端 Provider */
  realm: string
  userId?: string
  /** 受限运行身份拥有的角色；配置签名身份时必填。 */
  roles?: string[]
  /** 与 seam-host 共享的断言密钥。配置后不再发送可伪造的身份头。 */
  identityAssertionSecret?: string
  /** 启用后只向 HTTPS mTLS Host 调用，并定期从绝对文件路径重载 Secret volume。 */
  tls?: MutualTLSFileConfig
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
  private readonly roles: readonly string[]
  private readonly identityAssertionSecret: string | undefined
  private readonly tls: ReloadingMutualTLSCredentials | undefined
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
    this.roles = [...(config.roles ?? [])]
    this.identityAssertionSecret = config.identityAssertionSecret || undefined
    if (this.identityAssertionSecret !== undefined && this.roles.length === 0) {
      throw new Error('seam-proxy: signed identity requires at least one role')
    }
    if (this.identityAssertionSecret !== undefined) {
      assertIdentityAssertionConfig({ audience: SEAM_IDENTITY_AUDIENCE, secret: this.identityAssertionSecret })
    }
    this.tls = config.tls === undefined ? undefined : new ReloadingMutualTLSCredentials(config.tls)
    if (this.tls !== undefined) config.endpoints.forEach(assertMutualTLSEndpoint)
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
    if (this.tls !== undefined) urls.forEach(assertMutualTLSEndpoint)
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
    const headers = seamRequestHeaders({
      realm: this.realm,
      userId: this.userId,
      roles: [...this.roles],
      token: this.token,
      identityAssertionSecret: this.identityAssertionSecret,
    })

    const url = `${endpoint}/seam/${encodeURIComponent(seam)}/${encodeURIComponent(method)}`
    const body = JSON.stringify({ seam, method, args })
    const result = this.tls === undefined
      ? await plainRequest(url, headers, body, this.timeoutMs, endpoint)
      : await mutualTLSRequest(url, headers, body, this.timeoutMs, this.tls.get(), endpoint)

    let payload: SeamResponse
    try { payload = JSON.parse(result.body) as SeamResponse } catch {
      throw new RemoteSeamError(codeForStatus(result.status),
        `远端返回非 JSON（HTTP ${result.status}）`, endpoint)
    }
    if (!payload.ok) {
      throw new RemoteSeamError(payload.code, payload.message, endpoint)
    }
    if (result.status < 200 || result.status >= 300) {
      // ok:true 却是错误状态码 —— 协议不一致，宁可失败也不接受歧义结果
      throw new RemoteSeamError(codeForStatus(result.status),
        `远端响应自相矛盾（HTTP ${result.status} 但 ok=true）`, endpoint)
    }
    return payload.value
  }
}

interface HTTPResult { status: number; body: string }

async function plainRequest(
  url: string, headers: Record<string, string>, body: string, timeoutMs: number, endpoint: string,
): Promise<HTTPResult> {
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(timeoutMs), headers, body })
  } catch (e) {
    const timedOut = e instanceof Error && e.name === 'TimeoutError'
    throw new RemoteSeamError(timedOut ? 'timeout' : 'unavailable', String(e), endpoint)
  }
  return { status: res.status, body: await res.text() }
}

function mutualTLSRequest(
  rawURL: string,
  headers: Record<string, string>,
  body: string,
  timeoutMs: number,
  tls: MutualTLSCredentials,
  endpoint: string,
): Promise<HTTPResult> {
  assertMutualTLSEndpoint(rawURL)
  const url = new URL(rawURL)
  return new Promise((resolve, reject) => {
    const request = httpsRequest(url, {
      method: 'POST', headers, ca: tls.ca, cert: tls.cert, key: tls.key,
      servername: tls.serverName ?? url.hostname, rejectUnauthorized: true, minVersion: 'TLSv1.2',
    }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      response.on('error', reject)
    })
    request.setTimeout(timeoutMs, () => request.destroy(new Error('mTLS request timed out')))
    request.on('error', (e) => {
      const timedOut = e instanceof Error && e.message === 'mTLS request timed out'
      reject(new RemoteSeamError(timedOut ? 'timeout' : 'unavailable', String(e), endpoint))
    })
    request.end(body)
  })
}

/**
 * 生成一次出站调用的身份头。带签名的模式有意不携带 X-Lumo-Realm/User：
 * Host 不能同时接受可信声明和可由任意 RPC 客户端伪造的回退字段。
 */
export function seamRequestHeaders(config: Pick<SeamProxyConfig,
  'realm' | 'userId' | 'roles' | 'token' | 'identityAssertionSecret'>): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const userId = config.userId ?? 'system'
  const secret = config.identityAssertionSecret || undefined
  if (secret === undefined) {
    headers['X-Lumo-Realm'] = config.realm
    headers['X-Lumo-User'] = userId
  } else {
    const roles = config.roles ?? []
    if (roles.length === 0) throw new Error('seam-proxy: signed identity requires at least one role')
    Object.assign(headers, issueIdentityAssertion({ realm: config.realm, userId, roles }, {
      audience: SEAM_IDENTITY_AUDIENCE,
      secret,
    }))
  }
  if (config.token) headers['X-Lumo-Seam-Token'] = config.token
  return headers
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Seam host 的 HTTP 面：把本节点已挂载的 seam Provider 暴露给远端 SeamProxy。
 *
 * 协议见 shared/seam-contracts/remote.ts —— **对 seam 通用**，加一个 seam 不需要
 * 新端点、不需要代码生成。
 *
 * 传输选型：当前 JSON over HTTP，回环/内网。§12.1 的目标形态是 gRPC/QUIC + mTLS；
 * 换传输只换本文件，dispatch.ts 的方法表与校验语义不变。
 *
 * 身份：兼容模式以每 realm 一个共享令牌证明 realm；签名模式由 Proxy 用短时 HMAC
 * 断言绑定 realm/user/roles，Host 绝不读取普通身份头，并拒绝请求体角色越出断言。
 * 两种应用层形态均不替代 §12.1 的 mTLS：它才是节点身份、密钥隔离和网络边界。
 */
import { createServer, type IncomingMessage, type Server as HTTPServer, type ServerResponse } from 'node:http'
import { createServer as createSecureServer, type Server as HTTPSServer } from 'node:https'
import { timingSafeEqual } from 'node:crypto'

import {
  SeamError,
  forbidden,
  invalid,
  capabilityUnavailable,
  seamErrorCode,
} from '../../../shared/seam-contracts/errors.ts'
import {
  statusForCode,
  type SeamResponse,
} from '../../../shared/seam-contracts/remote.ts'
import type { KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'
import type { GraphSeam } from '../../../shared/seam-contracts/graph.ts'
import {
  SEAM_IDENTITY_AUDIENCE,
  verifyIdentityAssertion,
} from '../../../shared/seam-contracts/identity.ts'
import {
  loadMutualTLSCredentials,
  type MutualTLSFileConfig,
} from '../../../shared/seam-contracts/mtls.ts'
import {
  callGraph,
  callKnowledge,
  isSeamName,
  methodSpec,
  METHOD_TABLE,
  type SeamName,
} from './dispatch.ts'
import { assertSeamRemotable } from './gate.ts'

export interface SeamHostLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

export interface SeamHostOptions {
  host: string
  port: number
  /** 单请求体上限（ingest 会很大，但不能无上限 —— 无上限等于一个 OOM 开关） */
  maxBodyBytes: number
  /** realm → 共享令牌。为空表示匿名放行（仅回环形态，启动时已告警） */
  tokens: ReadonlyMap<string, string>
  /** 配置后只信任发给 lumo-seam-host 的短时签名调用方身份。 */
  identityAssertionSecret?: string
  /** Configured certificate bundle turns this listener into a mandatory-client-cert mTLS endpoint. */
  tls?: MutualTLSFileConfig
  /** 惰性解析：能力可能在 host 之后才挂上，也可能这个节点压根没有 */
  resolveKnowledge: () => KnowledgeSeam | undefined
  resolveGraph: () => GraphSeam | undefined
  logger: SeamHostLogger
}

export interface Caller {
  realm: string
  userId: string
  roles: readonly string[]
}

export type SeamHostServer = HTTPServer | HTTPSServer

export function createSeamHost(options: SeamHostOptions): SeamHostServer {
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    void handle(req, res, options).catch((e: unknown) => {
      // 兜底：handle 内部已把所有可预期错误转成响应，走到这里说明是写响应本身失败
      options.logger.error('seam-host: 请求处理异常: %s', e)
      if (!res.headersSent) respond(res, 500, { ok: false, code: 'internal', message: '内部错误' })
      else res.end()
    })
  }
  const server = options.tls === undefined
    ? createServer(handler)
    : createSecureServer({
      ...serverTLSCredentials(options.tls),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2',
    }, handler)
  return server
}

function serverTLSCredentials(config: MutualTLSFileConfig): Omit<ReturnType<typeof loadMutualTLSCredentials>, 'serverName'> {
  const { serverName: _serverName, ...credentials } = loadMutualTLSCredentials(config)
  return credentials
}

async function handle(req: IncomingMessage, res: ServerResponse, options: SeamHostOptions): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://seam-host.invalid')
  const path = url.pathname

  if (req.method === 'GET' && (path === '/healthz' || path === '/seams')) {
    respondOk(res, {
      ok: true,
      seams: mountedSeams(options),
      methods: Object.fromEntries(
        mountedSeams(options).map((s) => [s, Object.keys(METHOD_TABLE[s])]),
      ),
    })
    return
  }

  const parts = path.split('/').filter(Boolean)
  if (req.method !== 'POST' || parts.length !== 3 || parts[0] !== 'seam') {
    respond(res, 404, { ok: false, code: 'invalid', message: `未知路由 ${req.method} ${path}` })
    return
  }
  const seamName = decodeURIComponent(parts[1]!)
  const method = decodeURIComponent(parts[2]!)

  try {
    const caller = authenticate(req, options)

    // 闸 B：先问「这个 seam 允许过网吗」，再问「这个 host 实现了它吗」。
    //
    // 顺序要紧。反过来的话，`ctx.terminals` 会被 isSeamName 判成 invalid ——
    // 「未知 seam」这个措辞是错的：它不是未知，它是**被明确禁止**的。错误码也会错成
    // invalid，读日志的人会去查参数而不是去查准入。
    //
    // 位置也要紧：在读请求体之前、在触碰任何 Provider 之前。被拒的调用不该先让我们
    // 吃掉一兆字节的 body。
    assertSeamRemotable(seamName)

    // 分级为 remotable 但本 host 没有方法表：说明分级表与实现漂移了（有跨包契约
    // 测试守着）。此时是 invalid 而非 forbidden —— 准入是允许的，只是这里没有。
    if (!isSeamName(seamName)) throw invalid(`本节点未实现 seam ${seamName}`)

    const body = await readBody(req, options.maxBodyBytes)
    const payload = parseCall(body)

    // 路径与载荷必须一致：不一致说明两端协议版本不同，宁可拒绝也不猜哪个为准
    if (payload.seam !== seamName || payload.method !== method) {
      throw invalid('请求体的 seam/method 与路径不一致')
    }

    const spec = methodSpec(seamName, method)
    if (payload.args.length !== spec.arity) {
      throw invalid(`seam ${seamName}.${method} 需要 ${spec.arity} 个参数，收到 ${payload.args.length}`)
    }

    // 越权闸门：载荷里的 realm 必须与调用方身份一致（本文件头部第 2 条硬规矩）
    for (const realm of spec.realms(payload.args)) {
      if (realm !== caller.realm) {
        throw forbidden(`调用方 realm=${caller.realm} 不得操作 realm=${realm} 的数据`)
      }
    }
    // `roles` 存在于请求体中，因而本身不可信。只有签名身份模式才把它当作一项
    // 可校验的、不能超出调用方授权范围的声明；旧协议保持其原有兼容语义。
    if (options.identityAssertionSecret !== undefined && spec.roles !== undefined) {
      assertRequestedRoles(caller.roles, spec.roles(payload.args))
    }

    const value = await dispatch(seamName, method, payload.args, options)
    respondOk(res, { ok: true, value } satisfies SeamResponse)
  } catch (e) {
    const code = seamErrorCode(e)
    const message = e instanceof Error ? e.message : String(e)
    if (code === 'internal') {
      // 只有真·节点故障才值得 error 级别；越权/参数错是日常噪音
      options.logger.error('seam-host: %s.%s 执行失败: %s', seamName, method, message)
    } else {
      options.logger.warn('seam-host: %s.%s 拒绝(%s): %s', seamName, method, code, message)
    }
    respond(res, statusForCode(code), { ok: false, code, message })
  }
}

function dispatch(
  seam: SeamName,
  method: string,
  args: unknown[],
  options: SeamHostOptions,
): Promise<unknown> {
  if (seam === 'knowledge') {
    const impl = options.resolveKnowledge()
    if (!impl) throw capabilityUnavailable('本节点未挂载 knowledge Provider')
    return callKnowledge(impl, method, args)
  }
  const impl = options.resolveGraph()
  if (!impl) throw capabilityUnavailable('本节点未挂载 knowledgeGraph Provider')
  return callGraph(impl, method, args)
}

function mountedSeams(options: SeamHostOptions): SeamName[] {
  const out: SeamName[] = []
  if (options.resolveKnowledge()) out.push('knowledge')
  if (options.resolveGraph()) out.push('knowledgeGraph')
  return out
}

function authenticate(req: IncomingMessage, options: SeamHostOptions): Caller {
  return authenticateHeaders(req.headers, options)
}

/** 独立于 HTTP listener 的认证入口，供无端口单元测试和嵌入式 host 使用。 */
export function authenticateHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  options: Pick<SeamHostOptions, 'tokens' | 'identityAssertionSecret'>,
): Caller {
  const signed = options.identityAssertionSecret === undefined
    ? undefined
    : verifySignedCaller(headers, options.identityAssertionSecret)
  const realm = signed?.realm ?? header(headers, 'x-lumo-realm')
  if (!realm) throw forbidden('缺少 X-Lumo-Realm：调用方身份不可省略')
  const userId = signed?.userId ?? header(headers, 'x-lumo-user') ?? 'unknown'
  const roles = signed?.roles ?? []

  if (options.tokens.size === 0) return { realm, userId, roles }

  const expected = options.tokens.get(realm)
  const presented = header(headers, 'x-lumo-seam-token')
  // realm 未配置令牌与令牌不匹配返回同一个错误：否则错误码本身就成了 realm 探测器
  if (!expected || !presented || !constantTimeEqual(expected, presented)) {
    throw forbidden(`realm ${realm} 的 seam 令牌校验失败`)
  }
  return { realm, userId, roles }
}

function verifySignedCaller(
  headers: Readonly<Record<string, string | string[] | undefined>>,
  secret: string,
): Caller {
  try {
    return verifyIdentityAssertion(headers, { audience: SEAM_IDENTITY_AUDIENCE, secret })
  } catch {
    // 切勿回退到普通头；否则攻击者只需带一个坏签名便可降级回可伪造的 legacy 身份。
    throw forbidden('调用方身份断言无效')
  }
}

/** 签名身份只可缩小、绝不可由 RPC 请求本身扩大。 */
export function assertRequestedRoles(callerRoles: readonly string[], requestedRoles: readonly string[]): void {
  const allowed = new Set(callerRoles)
  for (const role of requestedRoles) {
    if (!allowed.has(role)) throw forbidden(`调用方无权以角色 ${role} 查询`)
  }
}

function header(headers: Readonly<Record<string, string | string[] | undefined>>, name: string): string | undefined {
  const raw = headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && value.length > 0 ? value : undefined
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  // timingSafeEqual 要求等长；长度本身不是秘密，先比长度是可接受的
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limit) {
        // 超限即刻断流：继续收完再拒绝等于让调用方决定我们吃多少内存
        req.destroy()
        reject(invalid(`请求体超过上限 ${limit} 字节`))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (e) => reject(new SeamError('invalid', `读取请求体失败: ${e.message}`)))
  })
}

function parseCall(body: string): { seam: string; method: string; args: unknown[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    throw invalid('请求体不是合法 JSON')
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid('请求体必须是对象')
  const call = parsed as Record<string, unknown>
  if (typeof call['seam'] !== 'string' || typeof call['method'] !== 'string') {
    throw invalid('请求体缺少 seam/method')
  }
  if (!Array.isArray(call['args'])) throw invalid('args 必须是位置参数数组')
  return { seam: call['seam'], method: call['method'], args: call['args'] }
}

function respondOk(res: ServerResponse, payload: unknown): void {
  respond(res, 200, payload)
}

function respond(res: ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

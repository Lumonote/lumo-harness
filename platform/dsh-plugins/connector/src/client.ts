/**
 * 连接器网关 HTTP 客户端。
 *
 * 身份头由本客户端注入，与网关的 headerAuth 约定一致。
 * 生产形态下这些头应由边缘网关覆写 —— 网关**不信任**上游自报的 realm/roles，
 * 因此从 dsh 节点到连接器网关这一跳必须在受控网络内（mTLS / 内网）。
 */

export interface ConnectorClientConfig {
  gatewayUrl: string
  controlPlaneToken?: string
  realm: string
  userId: string
  roles: string[]
  projectId?: string
  /** 计量归因（X-Lumo-Dept 等）——optional 语义见网关 buildMeter：缺省补 'unknown' 并告警 */
  deptId?: string
  agentId?: string
  componentId?: string
  feature?: string
  timeoutMs?: number
}

/** 网关返回的工具面摘要（不含 credentialRef / egress 细节） */
export interface ConnectorSummary {
  id: string
  name: string
  protocol: string
  version: number
  operations: Array<{
    name: string
    method: string
    write: boolean
    sensitivity?: string
    pathParams: string[] | null
    allowedQuery: string[] | null
  }>
}

export interface InvokeRequest {
  connectorId: string
  operation: string
  pathParams?: Record<string, string>
  query?: Record<string, string>
  headers?: Record<string, string>
  body?: unknown
  correlationId?: string
  /** 一次性、精确绑定到本次调用的人工审批记录 ID。 */
  approvalId?: string
  /**
   * 发起本次调用的 dsh 会话 ref。网关用它写 `connector_audit.session_id`
   * （`cmd/connector-gateway/main.go` 读 `X-Lumo-Session`），并作为计量事件的
   * `sessionRef`。**缺省时审计行的 `session_id` 是 NULL** —— 那一行仍然记，
   * 但再也回不到「哪个会话调的」。
   */
  sessionRef?: string
}

export interface InvokeResult {
  status: number
  headers?: Record<string, string>
  body?: unknown
  encoding?: 'json' | 'text' | 'base64'
  contentType?: string
  durationMs: number
  redacted: boolean
}

/** 网关的闸门拒绝码 —— 与 server.classify 一一对应，调用方据此决定重试还是放弃 */
export type GatewayCode =
  | 'connector_not_found'
  | 'operation_invalid'
  | 'approval_required'
  | 'approval_invalid'
  | 'approval_unavailable'
  | 'egress_denied'
  | 'rate_limited'
  | 'circuit_open'
  | 'payload_too_large'
  | 'credential_error'
  | 'upstream_error'
  | 'internal_error'

export class GatewayError extends Error {
  constructor(
    readonly code: GatewayCode,
    readonly status: number,
    message: string,
  ) {
    super(message)
    this.name = 'GatewayError'
  }

  /** 闸门拒绝是否值得重试（限速与熔断会自愈；权限与参数错误不会） */
  get retryable(): boolean {
    return this.code === 'rate_limited' || this.code === 'circuit_open'
  }
}

/**
 * 会话归属头。
 *
 * 网关把同一个头用在两处（`gateway.Invoke` / `gateway.WebFetch` 的
 * `audit.Record.SessionID`，以及 `buildMeter` 的 `sessionRef`），缺省回落 `"system"`
 * —— 也就是说**不发这个头不会报错，只会静默丢掉会话归属**。审计表里那一行的
 * `session_id` 变成 NULL，而 §10.1 要的「外部调用时间线」正是按会话聚合的。
 *
 * 空白串按缺省处理：`X-Lumo-Session: ""` 与不发的效果相同（网关两侧都走 `def(...,"system")`），
 * 但显式发空串会让日志里出现一个看起来「有会话」的头，误导排查。
 */
function sessionHeader(sessionRef?: string): Record<string, string> {
  const value = sessionRef?.trim()
  return value ? { 'X-Lumo-Session': value } : {}
}

export class ConnectorClient {
  private readonly base: string
  private readonly timeoutMs: number
  private readonly identity: Record<string, string>

  constructor(config: ConnectorClientConfig) {
    this.base = config.gatewayUrl.replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.identity = {
      ...(config.controlPlaneToken ? { Authorization: `Bearer ${config.controlPlaneToken}` } : {}),
      'X-Lumo-User': config.userId,
      'X-Lumo-Realm': config.realm,
      'X-Lumo-Roles': config.roles.join(','),
      ...(config.projectId ? { 'X-Lumo-Project': config.projectId } : {}),
      ...(config.deptId ? { 'X-Lumo-Dept': config.deptId } : {}),
      ...(config.agentId ? { 'X-Lumo-Agent': config.agentId } : {}),
      ...(config.componentId ? { 'X-Lumo-Component': config.componentId } : {}),
      ...(config.feature ? { 'X-Lumo-Feature': config.feature } : {}),
    }
  }

  async list(): Promise<ConnectorSummary[]> {
    const res = await this.fetch('/connectors', { method: 'GET' })
    const json = (await res.json()) as { connectors?: ConnectorSummary[] }
    return json.connectors ?? []
  }

  async invoke(req: InvokeRequest): Promise<InvokeResult> {
    const res = await this.fetch(`/connectors/${encodeURIComponent(req.connectorId)}/invoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessionHeader(req.sessionRef) },
      body: JSON.stringify({
        operation: req.operation,
        pathParams: req.pathParams,
        query: req.query,
        headers: req.headers,
        body: req.body,
        correlationId: req.correlationId,
        approvalId: req.approvalId,
      }),
    })
    return (await res.json()) as InvokeResult
  }

  /**
   * 通用 URL 出站取回（POST /web/fetch，seam 远程形态 §1 第 8 行）。
   *
   * 与 invoke 的区别：目标 URL 由调用方给出（ctx.web 是运行时选定目标的通用能力，
   * 不存在 manifest 可拼装——安全边界由网关闸门链保证）。透传头与网关 allowlist
   * 同谱（content-type/accept），其余头不放行——那是把 PII/凭证带出网关的洞。
   */
  async webFetch(req: { url: string; headers?: Record<string, string>; sessionRef?: string }, signal?: AbortSignal): Promise<InvokeResult> {
    const safeHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers ?? {})) {
      const lower = k.toLowerCase()
      if (lower === 'content-type' || lower === 'accept') safeHeaders[k] = v
    }
    const res = await this.fetch('/web/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...sessionHeader(req.sessionRef) },
      body: JSON.stringify({
        url: req.url,
        ...(Object.keys(safeHeaders).length > 0 ? { headers: safeHeaders } : {}),
      }),
    }, signal)
    return (await res.json()) as InvokeResult
  }

  private async fetch(path: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
    // 网关拒绝走 GatewayError；外部 signal 与客户端超时合并，谁先触发谁生效
    const timeout = AbortSignal.timeout(this.timeoutMs)
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
    const res = await fetch(this.base + path, {
      ...init,
      signal: combined,
      headers: { ...this.identity, ...(init.headers as Record<string, string> | undefined) },
    })
    if (!res.ok) {
      // 网关的拒绝携带结构化 code；解析失败也不能吞掉状态码
      let code: GatewayCode = 'internal_error'
      let message = `连接器网关返回 ${res.status}`
      try {
        const body = (await res.json()) as { error?: string; code?: GatewayCode }
        if (body.code) code = body.code
        if (body.error) message = body.error
      } catch {
        /* 非 JSON 响应：保留默认信息 */
      }
      throw new GatewayError(code, res.status, message)
    }
    return res
  }
}

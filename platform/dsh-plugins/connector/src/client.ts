/**
 * 连接器网关 HTTP 客户端。
 *
 * 身份头由本客户端注入，与网关的 headerAuth 约定一致。
 * 生产形态下这些头应由边缘网关覆写 —— 网关**不信任**上游自报的 realm/roles，
 * 因此从 dsh 节点到连接器网关这一跳必须在受控网络内（mTLS / 内网）。
 */

export interface ConnectorClientConfig {
  gatewayUrl: string
  realm: string
  userId: string
  roles: string[]
  projectId?: string
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

export class ConnectorClient {
  private readonly base: string
  private readonly timeoutMs: number
  private readonly identity: Record<string, string>

  constructor(config: ConnectorClientConfig) {
    this.base = config.gatewayUrl.replace(/\/+$/, '')
    this.timeoutMs = config.timeoutMs ?? 30_000
    this.identity = {
      'X-Lumo-User': config.userId,
      'X-Lumo-Realm': config.realm,
      'X-Lumo-Roles': config.roles.join(','),
      ...(config.projectId ? { 'X-Lumo-Project': config.projectId } : {}),
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
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        operation: req.operation,
        pathParams: req.pathParams,
        query: req.query,
        headers: req.headers,
        body: req.body,
        correlationId: req.correlationId,
      }),
    })
    return (await res.json()) as InvokeResult
  }

  private async fetch(path: string, init: RequestInit): Promise<Response> {
    const signal = AbortSignal.timeout(this.timeoutMs)
    const res = await fetch(this.base + path, {
      ...init,
      signal,
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

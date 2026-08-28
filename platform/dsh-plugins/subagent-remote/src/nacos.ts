/** Minimal Nacos Naming resolver for dynamically scaled dsh execution nodes. */

export interface NacosNodeEndpoint {
  readonly nodeId: string
  readonly baseUrl: string
}

interface NacosHost {
  ip?: string
  port?: number
  healthy?: boolean
  enabled?: boolean
  metadata?: Record<string, string>
}

interface NacosListResponse {
  hosts?: NacosHost[]
}

export interface NacosResolverConfig {
  readonly baseUrl: string
  readonly serviceName: string
  readonly groupName: string
  readonly fetch?: typeof globalThis.fetch
}

/**
 * Resolve the endpoint after Scheduler placement. Nacos is intentionally
 * queried by node id only after placement, so a parent does not need a
 * process-restarted static URL map when HPA adds execution nodes.
 */
export async function resolveNacosNode(
  config: NacosResolverConfig,
  nodeId: string,
): Promise<NacosNodeEndpoint | undefined> {
  const query = new URLSearchParams({
    serviceName: config.serviceName,
    groupName: config.groupName,
  })
  const response = await (config.fetch ?? globalThis.fetch)(
    `${config.baseUrl.replace(/\/+$/, '')}/nacos/v1/ns/instance/list?${query.toString()}`,
    { signal: AbortSignal.timeout(5_000) },
  )
  if (!response.ok) throw new Error(`Nacos 节点查询失败: HTTP ${response.status}`)
  const body = await response.json() as NacosListResponse
  const host = (body.hosts ?? []).find((candidate) =>
    candidate.healthy !== false && candidate.enabled !== false &&
    candidate.ip !== undefined && candidate.port !== undefined &&
    candidate.metadata?.['node_id'] === nodeId)
  if (host?.ip === undefined || host.port === undefined || host.port <= 0) return undefined
  return { nodeId, baseUrl: `http://${host.ip}:${host.port}` }
}

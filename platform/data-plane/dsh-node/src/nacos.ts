export interface NacosRegistrationOptions {
  baseUrl: string
  serviceName: string
  groupName: string
  nodeId: string
	  realm: string
  clusterId: string
  host: string
  port: number
  capacity: number
  capabilities: string[]
  residency: string
}

export interface NacosRegistration {
  close(): Promise<void>
}

type RegistrationLogger = Pick<Console, 'warn'>

/** Register an ephemeral execution node and refresh its Nacos lease. */
export function startNacosRegistration(
  options: NacosRegistrationOptions,
  logger: RegistrationLogger = console,
): NacosRegistration {
  const base = options.baseUrl.replace(/\/+$/, '')
  const timer = setInterval(() => { void register(options, base, logger) }, 5_000)
  timer.unref()
  void register(options, base, logger)

  return {
    async close(): Promise<void> {
      clearInterval(timer)
      const query = queryOf(options)
      try {
        await fetch(`${base}/nacos/v1/ns/instance?${query.toString()}`, {
          method: 'DELETE',
          signal: AbortSignal.timeout(2_000),
        })
      } catch (error: unknown) {
        logger.warn(`dsh-node: Nacos 注销失败: ${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

async function register(
  options: NacosRegistrationOptions,
  base: string,
  logger: RegistrationLogger,
): Promise<void> {
  try {
    const response = await fetch(`${base}/nacos/v1/ns/instance?${queryOf(options).toString()}`, {
      method: 'POST',
      signal: AbortSignal.timeout(2_000),
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  } catch (error: unknown) {
    logger.warn(`dsh-node: Nacos 注册/续报失败: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function queryOf(options: NacosRegistrationOptions): URLSearchParams {
  return new URLSearchParams({
    serviceName: options.serviceName,
    groupName: options.groupName,
    ip: options.host,
    port: String(options.port),
    ephemeral: 'true',
    metadata: JSON.stringify({
      node_id: options.nodeId,
	      realm: options.realm,
      cluster_id: options.clusterId,
      capacity: String(options.capacity),
      capabilities: JSON.stringify(options.capabilities),
      residency: options.residency,
    }),
  })
}

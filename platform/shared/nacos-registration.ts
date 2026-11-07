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
  /** Permanently stop refreshes, then disable after every earlier registration. */
  withdraw(): Promise<void>
  close(): Promise<void>
}

type RegistrationLogger = Pick<Console, 'warn'>

/** One writer owns registration, drain withdrawal and final deregistration. */
export function startNacosRegistration(
  options: NacosRegistrationOptions,
  logger: RegistrationLogger = console,
  readiness: () => Promise<boolean> = async () => {
    const response = await fetch(`http://127.0.0.1:${options.port}/readyz`, { signal: AbortSignal.timeout(1_000) })
    await response.body?.cancel()
    return response.ok
  },
): NacosRegistration {
  const base = options.baseUrl.replace(/\/+$/, '')
  let withdrawn = false
  let closed = false
  let pending: Promise<void> | undefined
  let withdrawal: Promise<void> | undefined
  let closing: Promise<void> | undefined
  let publishedEligibility: boolean | undefined
  const update = async (method: 'POST' | 'PUT' | 'DELETE', enabled?: boolean): Promise<void> => {
    const query = queryOf(options)
    if (enabled !== undefined) query.set('enabled', String(enabled))
    const response = await fetch(`${base}/nacos/v1/ns/instance?${query}`, {
      method, signal: AbortSignal.timeout(2_000),
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
  }
  const tick = () => {
    if (withdrawn || closed || pending) return
    pending = (async () => {
      let ready = false
      try { ready = await readiness() } catch { /* Failed authority stays disabled. */ }
      // Withdrawal may have started while the readiness query was in flight.
      if (withdrawn || closed) return
      await update('POST', ready)
      // Nacos persists PUT metadata separately from ephemeral registration.
      // A prior process's disabled override survives a new POST enabled=true.
      // Synchronize it on boot and on readiness changes, under this writer.
      if (!withdrawn && !closed && publishedEligibility !== ready) {
        await update('PUT', ready)
        publishedEligibility = ready
      }
    })().catch((error: unknown) => {
      logger.warn(`dsh-node: Nacos 注册/续报失败: ${error instanceof Error ? error.message : String(error)}`)
    }).finally(() => { pending = undefined })
  }
  const timer = setInterval(tick, 5_000)
  timer.unref()
  tick()

  return {
    withdraw(): Promise<void> {
      // This flag changes before the first await, including a concurrent tick's
      // readiness read. A previously sent POST must finish before the PUT.
      withdrawn = true
      clearInterval(timer)
      if (closed) return closing!
      withdrawal ??= (async () => {
        await pending
        await update('PUT', false)
      })().catch(error => { withdrawal = undefined; throw error })
      return withdrawal
    },
    close(): Promise<void> {
      closed = true
      withdrawn = true
      clearInterval(timer)
      closing ??= (async () => {
        await pending
        await withdrawal?.catch(() => {})
        try { await update('DELETE') } catch (error: unknown) {
          logger.warn(`dsh-node: Nacos 注销失败: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
      return closing
    },
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
      node_id: options.nodeId, realm: options.realm, cluster_id: options.clusterId,
      capacity: String(options.capacity), capabilities: JSON.stringify(options.capabilities),
      residency: options.residency,
    }),
  })
}

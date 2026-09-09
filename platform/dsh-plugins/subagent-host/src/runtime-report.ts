import { randomUUID } from 'node:crypto'
import { assertExecutionPreset, assertWorkerBinding, type ExecutionPreset, type WorkerBinding } from './worker-binding.ts'

export interface RuntimeReportConfig {
  governanceUrl: string
  token: string
  realm: string
  nodeId: string
  binding: WorkerBinding
  capacity: number
}

/** Start only after the execution listener is accepting requests. */
export function startRuntimeReports(config: RuntimeReportConfig, onError: (error: unknown) => void) {
  assertWorkerBinding(config.binding)
  if (!config.token || !config.realm || !config.nodeId || !Number.isSafeInteger(config.capacity) || config.capacity < 1) {
    throw new Error('worker runtime requires authenticated node identity and positive capacity')
  }
  const instanceId = randomUUID()
  const base = config.governanceUrl.replace(/\/+$/, '')
  let reported = false
  let running: Promise<void> | undefined
  let closed = false
  const request = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(5_000),
      headers: { authorization: `Bearer ${config.token}`, 'x-lumo-realm': config.realm, 'content-type': 'application/json' },
    })
    if (!response.ok) throw new Error(`Worker runtime report failed: HTTP ${response.status}`)
    return response
  }
  const report = async (agentId: string, revision: number, status: string) => {
    await request(`/v1/workers/${encodeURIComponent(`agent:${agentId}`)}/runtime`, {
      method: 'PUT', body: JSON.stringify({ node_id: config.nodeId, instance_id: instanceId,
        preset_revision: revision, max_concurrency: config.capacity, status }),
    })
  }
  const tick = () => {
    if (closed || running) return
    running = (async () => {
      const binding = config.binding
      try {
        const preset = await (await request(`/v1/runtime/agent-presets/${encodeURIComponent(binding.agentId)}`)).json() as ExecutionPreset
        if (closed) return
        assertExecutionPreset(binding, config.realm, preset)
        if (config.capacity > preset.max_concurrency) throw new Error('worker capacity exceeds preset concurrency')
        await report(binding.agentId, binding.presetRevision, 'active')
        reported = true
      } catch (error) {
        onError(error)
        // Never relabel the running process with a revision it has not loaded.
        if (reported) await report(binding.agentId, binding.presetRevision, 'disabled').catch(onError)
      }
    })().finally(() => { running = undefined })
  }
  const timer = setInterval(tick, 10_000)
  timer.unref()
  tick()
  return {
    instanceId,
    async close() {
      closed = true
      clearInterval(timer)
      await running
      if (reported) await report(config.binding.agentId, config.binding.presetRevision, 'disabled').catch(onError)
    },
  }
}

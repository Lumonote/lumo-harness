import { randomBytes, randomUUID } from 'node:crypto'

export interface ExecutionNode {
  realm: string; node_id: string; project_id: string; process_id: string; endpoint: string; fence: number; expires_at: string
}
export interface ExecutionLease {
  session_ref: string; realm: string; node_id: string; project_id: string; process_id: string
  node_fence: number; fencing_token: number; writer_holder: string; expires_at: string
}
export class SessionExecutionFencedError extends Error {
  readonly code = 'session_execution_unavailable'
  constructor() { super('Session execution authority is unavailable; retry on its registered node after recovery') }
}
export async function boundedJSON(response: Response, maxBytes = 128 * 1024, signal?: AbortSignal): Promise<Record<string, unknown>> {
  if (!response.body) throw new SessionExecutionFencedError()
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0
  try { for (;;) { const value = signal ? await abortable(reader.read(), signal) : await reader.read(); if (value.done) break; bytes += value.value.length; if (bytes > maxBytes) throw new SessionExecutionFencedError(); chunks.push(value.value) } }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock() }
  signal?.throwIfAborted()
  const result: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new SessionExecutionFencedError()
  return result as Record<string, unknown>
}
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason) }
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}
export class SessionExecutionClient {
  private readonly base: string
  constructor(base: string, private token: string, private fetcher: typeof fetch = globalThis.fetch) {
    const url = new URL(base)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || !token.trim()) throw new Error('Invalid execution authority')
    this.base = base.replace(/\/+$/u, '')
  }
  async call(path: string, body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> {
    try {
    const active = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])])
    active.throwIfAborted()
    const request = this.fetcher(`${this.base}/v1/session-execution${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: active,
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }).then(response => { if (active.aborted) void response.body?.cancel().catch(() => {}); return response })
    const res = await abortable(request, active)
    if (!res.ok) { void res.body?.cancel().catch(() => {}); throw new SessionExecutionFencedError() }
    return await boundedJSON(res, 128 * 1024, active)
    } catch { throw new SessionExecutionFencedError() }
  }
  async node(realm: string, node: string, project: string): Promise<ExecutionNode> {
    const value = (await this.call(`/nodes/${encodeURIComponent(node)}?${new URLSearchParams({ realm, project_id: project })}`)).node as ExecutionNode
    if (!value || value.realm !== realm || value.node_id !== node || value.project_id !== project || !value.process_id || typeof value.endpoint !== 'string' || !Number.isSafeInteger(value.fence) || value.fence < 1) throw new SessionExecutionFencedError()
    return value
  }
}
/** A lost lease permanently fences this runtime. It must never re-admit its
 * stale in-memory Agent or silently reopen a writer with a newer generation. */
export class SessionExecutionRuntime {
  readonly processId = randomUUID()
  private readonly secret = randomBytes(32).toString('hex')
  private ready?: Promise<void>
  private node?: ExecutionNode
  private leases = new Map<string, ExecutionLease>()
  private retired = new Set<string>()
  private pending = new Map<string, Promise<void>>()
  private timer?: ReturnType<typeof setTimeout>
  private failed = false
  private renewingNode?: Promise<void>
  readonly signal: AbortSignal
  private abort = new AbortController()
  constructor(readonly client: SessionExecutionClient, readonly realm: string, readonly nodeId: string, readonly projectId: string, readonly endpoint: string, readonly writerHolder: string, private stop: () => void) { this.signal = this.abort.signal }
  private body() { return { realm: this.realm, node_id: this.nodeId, project_id: this.projectId, process_id: this.processId, endpoint: this.endpoint, token: this.secret } }
  private fail(): never { if (!this.failed) { this.failed = true; if (this.timer) clearTimeout(this.timer); this.abort.abort(new SessionExecutionFencedError()); this.stop() }; throw new SessionExecutionFencedError() }
  async start(): Promise<void> {
    if (this.failed) throw new SessionExecutionFencedError()
    this.ready ??= (async () => {
      const n = (await this.client.call(`/nodes/${encodeURIComponent(this.nodeId)}/acquire`, this.body(), this.signal)).node as ExecutionNode
      if (this.failed || !n || n.process_id !== this.processId || n.realm !== this.realm || n.node_id !== this.nodeId || n.project_id !== this.projectId || n.endpoint !== this.endpoint || !Number.isSafeInteger(n.fence) || n.fence < 1) this.fail()
      this.node = n
      this.scheduleHeartbeat()
    })().catch(() => this.fail())
    return this.ready
  }
  private scheduleHeartbeat(): void {
    if (this.failed) return
    // Spread replicas over time; schedule after completion so cycles cannot overlap.
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.heartbeat().catch(() => {}).finally(() => this.scheduleHeartbeat())
    }, 1750 + Math.floor(Math.random() * 501))
    this.timer.unref()
  }
  private async renewNode(): Promise<void> {
    // Join only an in-flight authority request. Every later check still renews;
    // no completed result, authorization or lease lifetime is cached here.
    this.renewingNode ??= (async () => {
      const n = (await this.client.call(`/nodes/${encodeURIComponent(this.nodeId)}/renew`, this.body(), this.signal)).node as ExecutionNode
      if (this.failed || !this.node || n?.process_id !== this.processId || n.realm !== this.realm || n.node_id !== this.nodeId || n.project_id !== this.projectId || n.endpoint !== this.endpoint || n.fence !== this.node.fence) this.fail()
      this.node = n
    })().finally(() => { this.renewingNode = undefined })
    await this.renewingNode
  }
  async ensure(ref: string): Promise<void> {
    if (this.retired.has(ref)) throw new SessionExecutionFencedError()
    await this.start()
    if (this.retired.has(ref)) throw new SessionExecutionFencedError()
    if (this.failed) throw new SessionExecutionFencedError()
    if (!this.leases.has(ref) && !this.pending.has(ref) && new Set([...this.leases.keys(), ...this.pending.keys()]).size >= 512) throw new Error('Session execution identity capacity reached')
    let current = this.pending.get(ref)
    if (!current) {
      current = (async () => {
        const prior = this.leases.get(ref)
        const l = (await this.client.call(`/sessions/${encodeURIComponent(ref)}/${prior ? 'renew' : 'acquire'}`, { ...this.body(), writer_holder: this.writerHolder, fencing_token: prior?.fencing_token ?? 0 }, this.signal)).lease as ExecutionLease
        if (this.retired.has(ref)) throw new SessionExecutionFencedError()
        if (this.failed || !l || l.session_ref !== ref || l.realm !== this.realm || l.node_id !== this.nodeId || l.project_id !== this.projectId || l.process_id !== this.processId || l.node_fence !== this.node?.fence || l.writer_holder !== this.writerHolder || !Number.isSafeInteger(l.fencing_token) || l.fencing_token < 1 || prior && prior.fencing_token !== l.fencing_token) this.fail()
        this.leases.set(ref, l)
      })().catch(() => { if (this.retired.has(ref)) throw new SessionExecutionFencedError(); return this.fail() }).finally(() => { this.pending.delete(ref) })
      this.pending.set(ref, current)
    }
    await current
  }
  /** Internal service proof; never serialize this capability to a browser. */
  async proof(ref: string) {
    await this.ensure(ref)
    const lease = this.leases.get(ref)!
    return { ...this.body(), writer_holder: lease.writer_holder, fencing_token: lease.fencing_token }
  }
  /** Retire one frozen Session permanently in this process. Other Sessions
   * keep their node heartbeat; this identity can never reopen the old Agent. */
  async retire(ref: string): Promise<void> {
    this.retired.add(ref)
    await this.pending.get(ref)?.catch(() => {})
    this.leases.delete(ref)
  }
  /** Target-node capability used before a restored Session acquires ownership.
   * This secret proof is internal and must never be returned to a browser. */
  async nodeProof() { await this.check(); return { ...this.body(), writer_holder: this.writerHolder, fencing_token: 0 } }
  async check(): Promise<void> { await this.start(); try { await this.renewNode() } catch { this.fail() } }
  /** Public non-secret generation facts for independent service-side fencing. */
  async identity(ref:string): Promise<{node_id:string;process_id:string;node_fence:number;writer_holder:string;fencing_token:number}> {
    await this.check(); await this.ensure(ref)
    return {node_id:this.nodeId,process_id:this.processId,node_fence:this.node!.fence,writer_holder:this.writerHolder,fencing_token:this.leases.get(ref)!.fencing_token}
  }
  private async heartbeat(): Promise<void> {
    const active = AbortSignal.any([this.signal, AbortSignal.timeout(5000)])
    // Snapshot references, not credentials. A foreground renewal that finishes
    // while queued already fulfilled this background refresh, so skip only it.
    const leases = [...this.leases.entries()]
    let cursor = 0
    try {
      await abortable(this.renewNode(), active)
      await Promise.all(Array.from({ length: Math.min(8, leases.length) }, async () => {
        for (;;) {
          active.throwIfAborted()
          const entry = leases[cursor++]
          if (!entry) return
          const [ref, observed] = entry
          if (this.leases.get(ref) !== observed) continue
          try { await abortable(this.ensure(ref), active) } catch (error) { if (!this.retired.has(ref)) throw error }
        }
      }))
    } catch { this.fail() }
  }
  async dispose(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    const acquired = this.node !== undefined
    this.failed = true; this.abort.abort(new SessionExecutionFencedError())
    if (acquired) await this.client.call(`/nodes/${encodeURIComponent(this.nodeId)}/release`, this.body()).catch(() => {})
  }
}

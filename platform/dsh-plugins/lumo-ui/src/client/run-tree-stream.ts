import { applyRunTreeEvent, emptyRunTree, type RunTreeDelta, type RunTreeNode, type RunTreeState } from '../../../../shared/seam-contracts/run-tree.ts'

type Snapshot = { seq: number; nodes: RunTreeNode[] }

/** Rebuild after each connection; queue deltas while one snapshot is in flight. */
export class RunTreeStream {
  private state = emptyRunTree()
  private pending = new Map<number, RunTreeDelta>()
  private flight: { controller: AbortController; promise: Promise<void> } | undefined
  private retry: ReturnType<typeof setTimeout> | undefined
  private epoch = 0
  private disposed = false
  private hydrated = false
  private overflow = false

  constructor(private readonly snapshot: (signal: AbortSignal) => Promise<Snapshot>, private readonly publish: (state: RunTreeState) => void, private readonly notice: (message: string) => void) {}

  hello(): void {
    if (this.disposed) return
    this.epoch++
    this.flight?.controller.abort()
    this.flight = undefined
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    this.pending.clear()
    this.overflow = false
    this.hydrated = false
    void this.refresh()
  }

  delta(delta: RunTreeDelta): void {
    if (this.disposed || !Number.isSafeInteger(delta.seq) || delta.seq < 1) return
    if (this.hydrated && delta.seq <= this.state.seq) return
    this.pending.set(delta.seq, delta)
    if (this.pending.size > 5000) { this.pending.clear(); this.overflow = true }
    if (this.flight || this.retry) return
    if (this.hydrated) this.drain()
    if (!this.hydrated || this.pending.size || this.overflow) void this.refresh()
  }

  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve()
    if (this.flight) return this.flight.promise
    if (this.retry) clearTimeout(this.retry)
    this.retry = undefined
    const epoch = this.epoch
    this.overflow = false
    const controller = new AbortController()
    const flight = { controller, promise: Promise.resolve() }
    this.flight = flight
    flight.promise = Promise.resolve().then(() => this.snapshot(controller.signal)).then(snap => {
      if (this.disposed || epoch !== this.epoch) return
      if (!Number.isSafeInteger(snap.seq) || snap.seq < 0 || !Array.isArray(snap.nodes)) throw new Error('运行树快照无效')
      // A delayed ordinary refresh must not roll back a newer local projection.
      if (!this.hydrated || snap.seq >= this.state.seq) {
        const state = emptyRunTree()
        for (const node of snap.nodes) {
          state.nodes[node.id] = node
          if (node.sessionId) state.sessions[node.sessionId] = node.id
        }
        state.seq = snap.seq
        this.state = state
      }
      this.hydrated = true
      this.drain()
      this.publish(this.state)
      this.notice('')
    }).catch(error => {
      if (!this.disposed && epoch === this.epoch) {
        this.notice(`运行树正在恢复：${error instanceof Error ? error.message : String(error)}`)
        this.schedule()
      }
    }).finally(() => {
      if (this.flight !== flight) return
      this.flight = undefined
      if (this.pending.size || this.overflow) this.schedule()
    })
    return flight.promise
  }

  disconnected(): void { if (!this.disposed) this.notice('连接中断，正在自动重连…') }

  dispose(): void {
    this.disposed = true
    this.epoch++
    this.flight?.controller.abort()
    if (this.retry) clearTimeout(this.retry)
    this.pending.clear()
  }

  private drain(): void {
    for (const seq of this.pending.keys()) if (seq <= this.state.seq) this.pending.delete(seq)
    let changed = false
    for (;;) {
      const next = this.pending.get(this.state.seq + 1)
      if (!next) break
      this.pending.delete(next.seq)
      this.state = applyRunTreeEvent(this.state, next.event)
      changed = true
    }
    if (changed) this.publish(this.state)
  }

  private schedule(): void {
    if (this.disposed || this.retry) return
    this.retry = setTimeout(() => { this.retry = undefined; void this.refresh() }, 1000)
  }
}

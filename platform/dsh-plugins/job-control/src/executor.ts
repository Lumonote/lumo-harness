/** Execution-node half of the durable job-control channel. */
import {
  formatJobRef,
  type JobControlRuntime,
  type JobLifecycleStatus,
  type JobRef,
  type LocalJobRegistration,
} from '../../../shared/seam-contracts/job-virtualization.ts'
import type { JobControlInbox, LocalJobSnapshot, PendingJobControl } from './pg-job-control.ts'

export interface JobOwner {
  readonly session: { readonly id: string }
}

export interface JobSnapshotLike {
  readonly id: string
  readonly kind: string
  readonly label: string
  readonly ownerSession?: string
  readonly status: JobLifecycleStatus
  readonly detail?: string
  readonly startedAt: number
  readonly finishedAt?: number
}

export interface JobsLike {
  list(owner?: JobOwner): JobSnapshotLike[]
  kill(id: string, owner: JobOwner, reason?: string): 'requested' | 'already-finished'
  onJobsChanged(listener: (owner: JobOwner | undefined) => void): () => void
  onJobDone(listener: (snapshot: JobSnapshotLike, owner: JobOwner | undefined) => void): () => void
}

type LocalEntry = { owner: JobOwner; snapshot: JobSnapshotLike }
type ExternalEntry = { cancel: (reason?: string) => void }

/**
 * Mirrors only session-owned local jobs into the global event/control plane.
 * Unowned dsh jobs intentionally have no `sessionRef`, therefore cannot be
 * turned into a globally authorized JobRef and are not exported.
 */
export class JobControlExecutor {
  private readonly jobs = new Map<string, LocalEntry>()
  private readonly external = new Map<string, ExternalEntry>()
  private running = false

  constructor(
    readonly nodeId: string,
    private readonly registry: JobsLike,
    private readonly inbox: JobControlInbox,
  ) {}

  /**
   * Register a local handle that is not itself a dsh JobRegistry record. The
   * subagent host is exactly this shape: it owns an Agent cancellation handle,
   * while the parent needs the same globally routed control semantics.
   */
  async register(
    partial: Omit<JobRef, 'node'>,
    snapshot: LocalJobRegistration,
    cancel: (reason?: string) => void,
  ): Promise<JobRef> {
    const ref: JobRef = { ...partial, node: this.nodeId }
    this.external.set(formatJobRef(ref), { cancel })
    await this.inbox.record({ ref, ...snapshot })
    return ref
  }

  async settle(ref: JobRef, snapshot: LocalJobRegistration): Promise<void> {
    if (ref.node !== this.nodeId) throw new Error(`job-control: 不得结算其他节点的 job (${ref.node})`)
    await this.inbox.record({ ref, ...snapshot })
    if (snapshot.status === 'completed' || snapshot.status === 'killed' || snapshot.status === 'failed') {
      this.external.delete(formatJobRef(ref))
    }
  }

  async observe(owner: JobOwner | undefined): Promise<void> {
    if (!owner) return
    const writes: Promise<void>[] = []
    for (const snapshot of this.registry.list(owner)) {
      if (!snapshot.ownerSession) continue
      const ref = { sessionRef: snapshot.ownerSession, node: this.nodeId, jobId: snapshot.id }
      this.jobs.set(formatJobRef(ref), { owner, snapshot })
      writes.push(this.inbox.record(toLocalSnapshot(ref, snapshot)))
    }
    await Promise.all(writes)
  }

  async done(snapshot: JobSnapshotLike, owner: JobOwner | undefined): Promise<void> {
    if (!owner || !snapshot.ownerSession) return
    const ref = { sessionRef: snapshot.ownerSession, node: this.nodeId, jobId: snapshot.id }
    this.jobs.set(formatJobRef(ref), { owner, snapshot })
    await this.inbox.record(toLocalSnapshot(ref, snapshot))
  }

  /** Drain one mailbox batch. Re-entrancy is ignored; the next interval retries. */
  async drainOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const commands = await this.inbox.take(this.nodeId)
      for (const command of commands) await this.apply(command)
    } finally {
      this.running = false
    }
  }

  private async apply(command: PendingJobControl): Promise<void> {
    const external = this.external.get(formatJobRef(command.ref))
    if (external) {
      external.cancel(command.reason)
      await this.inbox.ack(command.correlationId)
      return
    }
    const entry = this.jobs.get(formatJobRef(command.ref))
    // A completed/restarted local process may have no live registry entry.
    // Acking is correct: the durable snapshot/event stream remains the truth;
    // retrying a command against a different OS process would be unsafe.
    if (!entry) {
      await this.inbox.ack(command.correlationId)
      return
    }
    // `timeout` is a control-plane deadline expiration, not a local timer
    // creation API. Its immediate execution action is the same local kill;
    // recovery decides whether/how to re-place later.
    this.registry.kill(entry.snapshot.id, entry.owner, command.reason)
    await this.observe(entry.owner)
    await this.inbox.ack(command.correlationId)
  }
}

function toLocalSnapshot(ref: JobRef, snapshot: JobSnapshotLike): LocalJobSnapshot {
  return {
    ref,
    kind: snapshot.kind,
    label: snapshot.label,
    status: snapshot.status,
    ...(snapshot.detail !== undefined ? { detail: snapshot.detail } : {}),
    startedAt: snapshot.startedAt,
    ...(snapshot.finishedAt !== undefined ? { finishedAt: snapshot.finishedAt } : {}),
  }
}

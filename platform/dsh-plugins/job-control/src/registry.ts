/** Bridge the current DSH session-scoped job API to the durable executor. */
import { JobId, type JobRegistry, type JobView } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { JobControlExecutor, JobsLike, JobSnapshotLike } from './executor.ts'

function snapshotOf(job: JobView): JobSnapshotLike {
  return { ...job, ownerSession: job.owner }
}

export function adaptDshJobs(registry: Pick<JobRegistry, 'list' | 'kill'>): JobsLike {
  return {
    list: owner => registry.list(owner === undefined ? undefined : SessionId(owner.session.id)).map(snapshotOf),
    kill: (id, owner, reason) => registry.kill(JobId(id), SessionId(owner.session.id), reason),
  }
}

export function observeDshJobs(
  registry: Pick<JobRegistry, 'events' | 'attachController'>,
  executor: Pick<JobControlExecutor, 'done'>,
  onError: (error: unknown) => void,
): void {
  registry.attachController('lumo/job-control')
  registry.events.subscribe({ owners: 'scope' }, event => {
    if (event.type === 'output' || event.type === 'removed') return
    const owner = event.job.owner
    if (owner === undefined) return
    void executor.done(snapshotOf(event.job), { session: { id: owner } }).catch(onError)
  })
}

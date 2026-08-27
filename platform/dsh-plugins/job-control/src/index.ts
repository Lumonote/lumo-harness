/**
 * @lumo/job-control — P2c row 6's `ctx.jobs` control signal channel.
 *
 * This plugin observes local dsh jobs, publishes JobRef-scoped results to the
 * shared PG control plane, and executes only commands addressed to this node.
 * It never substitutes or proxies `ctx.jobs`; OS handles stay local.
 */
import { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-jobs'
import z from '@deepseek-ai/schemastery'

import { JobControlExecutor, type JobsLike } from './executor.ts'
import { PgJobControlSeam, RoleJobControlPolicy } from './pg-job-control.ts'
import type { JobControlSeam } from '../../../shared/seam-contracts/job-virtualization.ts'
import type { JobControlRuntime } from '../../../shared/seam-contracts/job-virtualization.ts'

export interface JobControlConfig {
  connectionString: string
  nodeId: string
  /** Poll interval for the PG control mailbox; bounded to avoid a hot loop. */
  pollIntervalMs?: number
  /** Roles allowed to issue job controls; omission uses operator/admin/owner. */
  allowedRoles?: string[]
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    jobControl: JobControlSeam
    jobControlRuntime: JobControlRuntime
  }
}

export const Config: z<JobControlConfig> = z.object({
  connectionString: z.string(),
  nodeId: z.string(),
  pollIntervalMs: z.number().min(50).max(60_000),
  allowedRoles: z.array(z.string()),
}) as unknown as z<JobControlConfig>

export function apply(ctx: Context, config: JobControlConfig): void {
  if (!config.nodeId) throw new Error('job-control: nodeId 不能为空')
  const seam = new PgJobControlSeam(config.connectionString, new RoleJobControlPolicy(config.allowedRoles))
  const executor = new JobControlExecutor(config.nodeId, ctx.jobs as unknown as JobsLike, seam)
  const interval = config.pollIntervalMs ?? 250

  ctx.provide('jobControl', seam)
  ctx.provide('jobControlRuntime', executor)
  void seam.init().then(() => {
    return executor.drainOnce()
  }).catch((error: unknown) => {
    ctx.logger.error('lumo/job-control: 初始化失败: %s', error instanceof Error ? error.message : String(error))
  })

  // Listeners are dsh effect-scoped; no manual unregistration is needed.
  ctx.jobs.onJobsChanged((owner) => {
    void executor.observe(owner as never).catch((error: unknown) => {
      ctx.logger.warn('lumo/job-control: job 投影失败: %s', error instanceof Error ? error.message : String(error))
    })
  })
  ctx.jobs.onJobDone((snapshot, owner) => {
    void executor.done(snapshot as never, owner as never).catch((error: unknown) => {
      ctx.logger.warn('lumo/job-control: job 终态投影失败: %s', error instanceof Error ? error.message : String(error))
    })
  })

  const timer = setInterval(() => {
    void executor.drainOnce().catch((error: unknown) => {
      ctx.logger.warn('lumo/job-control: 控制信号消费失败: %s', error instanceof Error ? error.message : String(error))
    })
  }, interval)
  timer.unref()
  ctx.effect(() => () => {
    clearInterval(timer)
    void seam.close()
  })
}

export default apply
export { JobControlExecutor } from './executor.ts'
export { PgJobControlSeam, RoleJobControlPolicy, JOB_CONTROL_DDL } from './pg-job-control.ts'
export type { JobControlInbox, JobControlPolicy, LocalJobSnapshot, PendingJobControl } from './pg-job-control.ts'
export type { JobControlRuntime, LocalJobRegistration } from '../../../shared/seam-contracts/job-virtualization.ts'

/** 业务任务与一次执行 Run 的闭集契约（业务控制面 §23.3）。 */

export const BUSINESS_STATES = [
  'DRAFT', 'ROUTING', 'ASSIGNED', 'EXECUTING', 'VERIFYING', 'IN_REVIEW', 'DONE', 'REJECTED', 'ARCHIVED',
] as const
export type BusinessState = (typeof BUSINESS_STATES)[number]

export const RUN_STATES = ['ASSIGNED', 'QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'] as const
export type RunState = (typeof RUN_STATES)[number]

export const TASK_EVENTS = [
  'route', 'assign', 'start', 'verify', 'submit_review', 'complete', 'reject', 'archive', 'reroute',
] as const
export type TaskEvent = (typeof TASK_EVENTS)[number]

/** 同一事件重放幂等；未知状态/事件与非法边一律抛错。 */
export function transitionTask(state: BusinessState, event: TaskEvent): BusinessState {
  if (!(BUSINESS_STATES as readonly string[]).includes(state)) throw new Error(`未知业务任务状态 ${state}`)
  if (!(TASK_EVENTS as readonly string[]).includes(event)) throw new Error(`未知业务任务事件 ${event}`)
  const target: Record<TaskEvent, BusinessState> = {
    route: 'ROUTING', assign: 'ASSIGNED', start: 'EXECUTING', verify: 'VERIFYING',
    submit_review: 'IN_REVIEW', complete: 'DONE', reject: 'REJECTED', archive: 'ARCHIVED', reroute: 'ROUTING',
  }
  const next = target[event]
  const allowed: Record<BusinessState, readonly BusinessState[]> = {
    DRAFT: ['DRAFT', 'ROUTING'],
    ROUTING: ['ROUTING', 'ASSIGNED'],
    ASSIGNED: ['ASSIGNED', 'EXECUTING', 'ROUTING'],
    EXECUTING: ['EXECUTING', 'VERIFYING', 'ROUTING'],
    VERIFYING: ['VERIFYING', 'IN_REVIEW', 'ROUTING'],
    IN_REVIEW: ['IN_REVIEW', 'DONE', 'REJECTED', 'ROUTING'],
    DONE: ['DONE', 'ARCHIVED'],
    REJECTED: ['REJECTED', 'ROUTING', 'ARCHIVED'],
    ARCHIVED: ['ARCHIVED'],
  }
  if (allowed[state].includes(next)) return next
  throw new Error(`业务任务状态不可从 ${state} 经 ${event} 转为 ${next}`)
}


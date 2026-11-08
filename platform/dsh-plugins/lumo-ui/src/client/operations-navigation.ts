/** Single-use navigation intent shared by the sidebar and collaboration view. */
export type OperationsTarget = { kind: 'task' | 'project'; id: string }
export const OPERATIONS_TARGET_EVENT = 'lumo:operations-target'
export const PROJECTS_CHANGED_EVENT = 'lumo:projects-changed'
let pending: OperationsTarget | null = null

export function queueOperationsTarget(target: OperationsTarget): void {
  pending = target
}

export function takeOperationsTarget(): OperationsTarget | null {
  const target = pending
  pending = null
  return target
}

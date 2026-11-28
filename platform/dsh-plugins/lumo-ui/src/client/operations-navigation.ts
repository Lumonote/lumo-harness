/** Single-use navigation intent shared by the sidebar and collaboration view. */
export type OperationsArea = 'projects' | 'flows' | 'delivery' | 'progress' | 'operations' | 'token-usage' | 'users' | 'departments' | 'roles' | 'permissions' | 'recovery' | 'storage' | 'local' | 'engines' | 'hosts' | 'connections'
export type OperationsTarget = { kind: 'task' | 'project'; id: string } | { kind: 'area'; area: OperationsArea }
export const OPERATIONS_TARGET_EVENT = 'lumo:operations-target'
export const PROJECTS_CHANGED_EVENT = 'lumo:projects-changed'
let pending: OperationsTarget | null = null

export function peekOperationsTarget(): OperationsTarget | null { return pending }

export function queueOperationsTarget(target: OperationsTarget): void {
  pending = target
}

export function takeOperationsTarget(): OperationsTarget | null {
  const target = pending
  pending = null
  return target
}

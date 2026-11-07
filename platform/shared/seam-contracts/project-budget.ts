import type { BudgetState } from './budget-policy.ts'

export interface ProjectBudgetIdentity { realm: string; projectId: string; actorUserId: string }
export interface ProjectBudgetSnapshot {
  projectId: string
  unit: 'tokens'
  remaining: number | null
  total: number | null
  softLimit: number | null
  overdraft: number
  revision: number
  state: BudgetState | 'unconfigured'
}
export interface ProjectBudgetChange extends ProjectBudgetIdentity {
  mode: 'adjust' | 'reset'
  total: number
  softLimit: number
  overdraft: number
  expectedRevision: number
  confirmReset?: boolean
}
/** Budget configuration belongs to the same writer as metering, never the browser or a second Go ledger writer. */
export interface ProjectBudgetService {
  readProjectBudget(input: ProjectBudgetIdentity): Promise<ProjectBudgetSnapshot>
  configureProjectBudget(input: ProjectBudgetChange): Promise<ProjectBudgetSnapshot>
}

import type pg from 'pg'
import { budgetState } from '../../../shared/seam-contracts/budget-policy.ts'
import type { ProjectBudgetChange, ProjectBudgetIdentity, ProjectBudgetSnapshot } from '../../../shared/seam-contracts/project-budget.ts'

export class ProjectBudgetError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = 'ProjectBudgetError' }
}
export const PROJECT_BUDGET_DDL = `
ALTER TABLE budget_trees ADD COLUMN IF NOT EXISTS config_revision BIGINT NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS project_budget_audit (
  id BIGSERIAL PRIMARY KEY, realm TEXT NOT NULL, project_id TEXT NOT NULL,
  actor_user_id TEXT NOT NULL, mode TEXT NOT NULL CHECK(mode IN ('reset','adjust')),
  revision BIGINT NOT NULL, before_state JSONB NOT NULL, after_state JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(), UNIQUE(project_id, revision)
);
CREATE INDEX IF NOT EXISTS project_budget_audit_scope ON project_budget_audit(realm,project_id,id);
`
type BudgetRow = { budget: string; budget_total: string | null; soft_limit: string | null; overdraft: string | null; config_revision: string }
function integer(value: unknown, label: string, signed = false): number {
  const number = typeof value === 'string' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isSafeInteger(number) || (!signed && number < 0)) throw new ProjectBudgetError(400, `${label} 必须是安全范围内的${signed ? '' : '非负'}整数`)
  return number
}
function snapshot(projectId: string, row?: BudgetRow): ProjectBudgetSnapshot {
  const total = row?.budget_total == null ? null : integer(row.budget_total, '预算总额')
  const remaining = row === undefined ? null : integer(row.budget, '剩余额度', true)
  const softLimit = total === null ? null : row?.soft_limit == null ? total : integer(row.soft_limit, '软限额')
  const overdraft = row?.overdraft == null ? 0 : integer(row.overdraft, '透支额度')
  return { projectId, unit: 'tokens', total, remaining, softLimit, overdraft,
    revision: row === undefined ? 0 : integer(row.config_revision, '版本'),
    state: total === null || remaining === null ? 'unconfigured' : budgetState(total - remaining, { budget: total, softLimit: softLimit!, overdraft }) }
}
async function authorize(client: pg.PoolClient, input: ProjectBudgetIdentity, write: boolean): Promise<void> {
  // Project mutations already take this parent lock before changing memberships.
  // Keeping it until configuration commits prevents a removed owner from writing.
  const result = await client.query<{ status: string }>(
    `SELECT status FROM projects WHERE id=$1 AND realm=$2 FOR ${write ? 'UPDATE' : 'SHARE'}`, [input.projectId, input.realm],
  )
  const project = result.rows[0]
  if (!project) throw new ProjectBudgetError(403, '没有访问此项目预算的权限')
  // A joined SELECT can read the old membership before waiting for the parent
  // lock. Read it in a fresh READ COMMITTED statement after obtaining that lock.
  const membership = await client.query<{ role: string }>('SELECT role FROM project_members WHERE project_id=$1 AND user_id=$2', [input.projectId, input.actorUserId])
  const role = membership.rows[0]?.role
  if (!['owner','editor','viewer'].includes(role ?? '')) throw new ProjectBudgetError(403, '没有访问此项目预算的权限')
  if (write && role !== 'owner') throw new ProjectBudgetError(403, '只有项目 owner 可以配置预算')
  if (write && project.status !== 'active') throw new ProjectBudgetError(409, '项目已归档，请先恢复项目')
}
export async function readProjectBudget(pool: pg.Pool, input: ProjectBudgetIdentity): Promise<ProjectBudgetSnapshot> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await authorize(client, input, false)
    const result = await client.query<BudgetRow>(`SELECT budget,budget_total,soft_limit,overdraft,config_revision FROM budget_trees WHERE kind='project' AND id=$1`, [input.projectId])
    await client.query('COMMIT')
    return snapshot(input.projectId, result.rows[0])
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}
export async function configureProjectBudget(pool: pg.Pool, input: ProjectBudgetChange): Promise<ProjectBudgetSnapshot> {
  integer(input.total, '预算总额'); integer(input.softLimit, '软限额'); integer(input.overdraft, '透支额度'); integer(input.expectedRevision, '读取版本')
  if (input.softLimit > input.total || !Number.isSafeInteger(input.total + input.overdraft)) throw new ProjectBudgetError(400, '软限额不能超过总额，总额加透支不能超出整数范围')
  if (input.mode !== 'adjust' && input.mode !== 'reset') throw new ProjectBudgetError(400, '预算操作必须为 adjust 或 reset')
  if (input.mode === 'reset' && input.confirmReset !== true) throw new ProjectBudgetError(400, '重置本期预算需要明确确认')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await authorize(client, input, true)
    const result = await client.query<BudgetRow>(`SELECT budget,budget_total,soft_limit,overdraft,config_revision FROM budget_trees WHERE kind='project' AND id=$1 FOR UPDATE`, [input.projectId])
    const before = snapshot(input.projectId, result.rows[0])
    if (before.revision !== input.expectedRevision) throw new ProjectBudgetError(409, '预算配置已变化，请重新读取后编辑')
    if (input.mode === 'adjust' && (before.total === null || before.remaining === null)) throw new ProjectBudgetError(409, '尚未配置本期总额，请明确重置本期预算以初始化')
    const remaining = input.mode === 'reset' ? input.total : Number(BigInt(before.remaining!) + BigInt(input.total) - BigInt(before.total!))
    integer(remaining, '调整后余额', true)
    const updated = await client.query<BudgetRow>(
      `INSERT INTO budget_trees(kind,id,budget,budget_total,soft_limit,overdraft,config_revision) VALUES('project',$1,$2,$3,$4,$5,$6)
       ON CONFLICT(kind,id) DO UPDATE SET budget=EXCLUDED.budget,budget_total=EXCLUDED.budget_total,
       soft_limit=EXCLUDED.soft_limit,overdraft=EXCLUDED.overdraft,config_revision=EXCLUDED.config_revision
       RETURNING budget,budget_total,soft_limit,overdraft,config_revision`,
      [input.projectId, remaining, input.total, input.softLimit, input.overdraft, before.revision + 1],
    )
    const after = snapshot(input.projectId, updated.rows[0])
    await client.query(`INSERT INTO project_budget_audit(realm,project_id,actor_user_id,mode,revision,before_state,after_state) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)`,
      [input.realm, input.projectId, input.actorUserId, input.mode, after.revision, JSON.stringify(before), JSON.stringify(after)])
    await client.query('COMMIT')
    return after
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}

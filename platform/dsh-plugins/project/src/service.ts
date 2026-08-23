/**
 * 项目工作区（§11.1）—— realm 内的组织单元：成员、制品引用、知识空间、
 * 会话、自动化、用量归属。
 *
 * 定位（§11.1 硬规矩 / 铁律 20）：**项目是权限载体与计量单元，不是第六类制品**。
 * 制品（组件/技能/智能体/连接器/流程）是构造单元，项目是承载单元。
 */
import pg from 'pg'

export const PROJECT_DDL = `
CREATE TABLE IF NOT EXISTS projects (
  project_id  TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  name        TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active','archived')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_projects_realm ON projects (realm, state);

-- 成员与项目角色（owner/editor/viewer；与 realm RBAC 取交集，评审 N4）
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner','editor','viewer')),
  PRIMARY KEY (project_id, user_id)
);

-- 制品引用（专家/技能/连接器/组件/流程 —— 控制台「专家·技能·连接器」入口的挂载记录）
CREATE TABLE IF NOT EXISTS project_artifacts (
  project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  artifact_kind TEXT NOT NULL CHECK (artifact_kind IN ('component','skill','agent','connector','flow')),
  artifact_name TEXT NOT NULL,
  version       TEXT NOT NULL,
  PRIMARY KEY (project_id, artifact_kind, artifact_name)
);

-- 知识空间（§5.4.7 协作单元；一个项目可含多个 Space，Space 不跨 realm）
CREATE TABLE IF NOT EXISTS project_spaces (
  space_id   TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  realm      TEXT NOT NULL,
  name       TEXT NOT NULL
);

-- 自动化定义（§8.3 Trigger + §9.2 Flow 的项目侧登记，控制台「自动化」入口）
CREATE TABLE IF NOT EXISTS project_automations (
  automation_id TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(project_id) ON DELETE CASCADE,
  trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN ('cron','webhook','event')),
  trigger_spec  TEXT NOT NULL,
  flow_ref      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true
);
`

export type ProjectRole = 'owner' | 'editor' | 'viewer'
export type ArtifactKind = 'component' | 'skill' | 'agent' | 'connector' | 'flow'

export interface Project {
  projectId: string
  realm: string
  name: string
  state: 'active' | 'archived'
}

export interface ProjectDashboard {
  project: Project
  members: Array<{ userId: string; role: ProjectRole }>
  artifacts: Array<{ kind: ArtifactKind; name: string; version: string }>
  spaces: Array<{ spaceId: string; name: string }>
  automations: Array<{ automationId: string; triggerKind: string; flowRef: string; enabled: boolean }>
  /** 用量与预算（§6.4 并行预算树的项目侧） */
  usage: { tokens: number; costUsd: number; budgetRemaining: number }
}

export class ProjectService {
  private pool: pg.Pool

  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString })
  }

  async init(): Promise<void> {
    await this.pool.query(PROJECT_DDL)
  }

  async create(project: Project, owner: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO projects (project_id, realm, name) VALUES ($1,$2,$3)
         ON CONFLICT (project_id) DO NOTHING`,
        [project.projectId, project.realm, project.name],
      )
      await client.query(
        `INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,'owner')
         ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner'`,
        [project.projectId, owner],
      )
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  /** 归档是常态；删除是异常（§11.1 —— 删除须显式授权，此处不提供 delete API） */
  async archive(projectId: string): Promise<void> {
    await this.pool.query(
      `UPDATE projects SET state = 'archived', archived_at = now() WHERE project_id = $1`,
      [projectId],
    )
  }

  async addMember(projectId: string, userId: string, role: ProjectRole): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1,$2,$3)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [projectId, userId, role],
    )
  }

  async roleOf(projectId: string, userId: string): Promise<ProjectRole | undefined> {
    const row = await this.pool.query<{ role: ProjectRole }>(
      'SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2',
      [projectId, userId],
    )
    return row.rows[0]?.role
  }

  async attachArtifact(
    projectId: string, kind: ArtifactKind, name: string, version: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_artifacts (project_id, artifact_kind, artifact_name, version)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, artifact_kind, artifact_name) DO UPDATE SET version = EXCLUDED.version`,
      [projectId, kind, name, version],
    )
  }

  async addSpace(spaceId: string, projectId: string, realm: string, name: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_spaces (space_id, project_id, realm, name) VALUES ($1,$2,$3,$4)
       ON CONFLICT (space_id) DO UPDATE SET name = EXCLUDED.name`,
      [spaceId, projectId, realm, name],
    )
  }

  async addAutomation(
    automationId: string, projectId: string,
    triggerKind: 'cron' | 'webhook' | 'event', triggerSpec: string, flowRef: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_automations (automation_id, project_id, trigger_kind, trigger_spec, flow_ref)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (automation_id) DO UPDATE SET
         trigger_kind = EXCLUDED.trigger_kind, trigger_spec = EXCLUDED.trigger_spec,
         flow_ref = EXCLUDED.flow_ref`,
      [automationId, projectId, triggerKind, triggerSpec, flowRef],
    )
  }

  /** 项目仪表板（控制台「项目」入口：成员/引用/空间/自动化/用量预算 一屏） */
  async dashboard(projectId: string): Promise<ProjectDashboard | undefined> {
    const p = await this.pool.query<{ project_id: string; realm: string; name: string; state: 'active' | 'archived' }>(
      'SELECT project_id, realm, name, state FROM projects WHERE project_id = $1',
      [projectId],
    )
    if (p.rows.length === 0) return undefined

    const [members, artifacts, spaces, automations, usage, budget] = await Promise.all([
      this.pool.query<{ user_id: string; role: ProjectRole }>(
        'SELECT user_id, role FROM project_members WHERE project_id = $1', [projectId]),
      this.pool.query<{ artifact_kind: ArtifactKind; artifact_name: string; version: string }>(
        'SELECT artifact_kind, artifact_name, version FROM project_artifacts WHERE project_id = $1', [projectId]),
      this.pool.query<{ space_id: string; name: string }>(
        'SELECT space_id, name FROM project_spaces WHERE project_id = $1', [projectId]),
      this.pool.query<{ automation_id: string; trigger_kind: string; flow_ref: string; enabled: boolean }>(
        'SELECT automation_id, trigger_kind, flow_ref, enabled FROM project_automations WHERE project_id = $1', [projectId]),
      // usage_ledger 由 @lumo/metering 建表；此处只读聚合（组件不直连他人写路径）
      this.pool.query<{ tokens: string | null; cost: string | null }>(
        `SELECT SUM(tokens)::text AS tokens, SUM(cost_usd)::text AS cost
         FROM usage_ledger WHERE project_id = $1`, [projectId]).catch(() => ({ rows: [{ tokens: null, cost: null }] })),
      this.pool.query<{ budget: string }>(
        `SELECT budget::text FROM budget_trees WHERE kind = 'project' AND id = $1`, [projectId])
        .catch(() => ({ rows: [] as Array<{ budget: string }> })),
    ])

    const row = p.rows[0]!
    return {
      project: { projectId: row.project_id, realm: row.realm, name: row.name, state: row.state },
      members: members.rows.map((r) => ({ userId: r.user_id, role: r.role })),
      artifacts: artifacts.rows.map((r) => ({ kind: r.artifact_kind, name: r.artifact_name, version: r.version })),
      spaces: spaces.rows.map((r) => ({ spaceId: r.space_id, name: r.name })),
      automations: automations.rows.map((r) => ({
        automationId: r.automation_id, triggerKind: r.trigger_kind,
        flowRef: r.flow_ref, enabled: r.enabled,
      })),
      usage: {
        tokens: Number(usage.rows[0]?.tokens ?? 0),
        costUsd: Number(usage.rows[0]?.cost ?? 0),
        budgetRemaining: Number(budget.rows[0]?.budget ?? 0),
      },
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

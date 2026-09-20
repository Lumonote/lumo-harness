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
  id          TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS projects_realm_name_uq ON projects (realm, name);

-- 成员与项目角色（owner/editor/viewer；与 realm RBAC 取交集，评审 N4）
CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- 制品引用（专家/技能/连接器/组件/流程 —— 控制台「专家·技能·连接器」入口的挂载记录）
CREATE TABLE IF NOT EXISTS project_artifacts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('component','skill','agent','connector','flow')),
  name       TEXT NOT NULL,
  version       TEXT NOT NULL,
  PRIMARY KEY (project_id, kind, name)
);

-- 知识空间（§5.4.7 协作单元；一个项目可含多个 Space，Space 不跨 realm）
CREATE TABLE IF NOT EXISTS project_spaces (
  space_id   TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  realm      TEXT NOT NULL,
  name       TEXT NOT NULL
);
-- 同项目内 Space 名唯一。具名唯一索引而不是建表时的内联 UNIQUE：既有库上
-- CREATE TABLE IF NOT EXISTS 是空操作，内联约束加不上去；而内联 UNIQUE 的自动名
-- （project_spaces_project_id_name_key）与具名索引并存会让「谁先建表」留下不同的
-- 索引集。Go 侧 control-plane/projects 与本插件共表（同库、同时在线），两侧逐字相同。
CREATE UNIQUE INDEX IF NOT EXISTS project_spaces_project_name_uq ON project_spaces (project_id, name);

-- 自动化定义（§8.3 Trigger + §9.2 Flow 的项目侧登记，控制台「自动化」入口）
CREATE TABLE IF NOT EXISTS project_automations (
  automation_id TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN ('cron','webhook','event')),
  trigger_spec  TEXT NOT NULL,
  flow_ref      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true
);
`

export type ProjectRole = 'owner' | 'editor' | 'viewer'
export type ArtifactKind = 'component' | 'skill' | 'agent' | 'connector' | 'flow'

/**
 * 决策记忆的 kind 闭集（§24.4 项目决策记忆）。与 Go 侧
 * `control-plane/projects/internal/domain/decisions.go` 的同名闭集逐字一致——
 * 两侧漂移由 `__tests__/decision-contract.spec.ts` 现场解析 Go 源码逮住。
 *
 * 闭集外的值一律拒绝（不是「未知即跳过」）：一个拼错的 kind 会让决策在按 kind 过滤的
 * 读面里静默消失，而消失的决策表现为「这条决定从没被记过」——正是这套记忆要防的事故。
 */
export const DECISION_KINDS = ['decision', 'boundary', 'ownership', 'trap'] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

/**
 * 索引层行数上限（§24.4 第 2 条）。
 *
 * 索引是**常驻上下文**的那一层：膨胀的索引同时损害命中率与上下文预算，所以「有 limit
 * 参数」还不够——默认值本身就是上限，调用方不传也必须被限住。数值与 Go 侧同源
 * （`domain.DecisionIndexDefaultLimit` / `DecisionIndexMaxLimit`）。
 */
export const DECISION_INDEX_DEFAULT_LIMIT = 50
export const DECISION_INDEX_MAX_LIMIT = 200

/** 把调用方给的 limit 收敛到 [1, DECISION_INDEX_MAX_LIMIT]（与 Go 侧同判序）。 */
export function resolveDecisionIndexLimit(requested?: number): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DECISION_INDEX_DEFAULT_LIMIT
  }
  return Math.min(Math.floor(requested), DECISION_INDEX_MAX_LIMIT)
}

/**
 * 索引查询 SQL（导出是为了让契约用例断言它的形状，不是为了让调用方执行它）。
 *
 * 三个条件都不是可选的：`realm` 是租户边界（跨 realm 查询得到**空集**，不是错误）、
 * `superseded_by IS NULL` 是 live 判据（被取代的条目只留在正文层）、`summary` 之外的列
 * 一律不取——`body` 一进索引，索引就从「命中表」退化成「正文的第二份拷贝」。
 */
export function decisionIndexQuery(kind?: DecisionKind): string {
  // 两种写法分别拼而不是 `($3 = '' OR kind = $3)`：后者会让 PG 用不上
  // project_decisions_live 这个部分索引的第三列。
  const filter = kind === undefined ? '' : ' AND kind = $3'
  const limit = kind === undefined ? '$3' : '$4'
  return `SELECT id, kind, summary, COALESCE(supersedes, '') AS supersedes, created_at
    FROM project_decisions
    WHERE realm = $1 AND project_id = $2 AND superseded_by IS NULL${filter}
    ORDER BY created_at DESC, id DESC
    LIMIT ${limit}`
}

/**
 * 正文查询 SQL。**不过滤 superseded_by**：被取代的行照样可读——索引层过滤它们是为了
 * 上下文预算，不是为了隐藏；「当初为什么这么定、后来被什么取代」正是要留下的考古层。
 */
export const DECISION_BODY_SQL = `SELECT id, realm, project_id, kind, summary, body,
    COALESCE(supersedes, '') AS supersedes, COALESCE(superseded_by, '') AS superseded_by,
    evidence, created_at
  FROM project_decisions
  WHERE realm = $1 AND project_id = $2 AND id = $3`

/** 索引行：常量级的一行，**没有 body**。 */
export interface DecisionIndexRow {
  id: string
  kind: DecisionKind
  summary: string
  supersedes?: string
  createdAt: string
}

/** 决策正文（(session_ref, seq) 证据坐标与任务报告同形，见 §23.4）。 */
export interface Decision {
  id: string
  realm: string
  projectId: string
  kind: DecisionKind
  summary: string
  body: string
  supersedes?: string
  supersededBy?: string
  evidence?: Array<{ session_ref: string; seq: number }>
  createdAt: string
}

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

  /**
   * 本节点绑定的 realm（装配层固定，与 projectId 同理：模型不可改）。
   *
   * 空串是**刻意的失败态**：决策读面全部返回空集，绝不退化成「不带 realm 过滤的全量读」。
   * 忘了注入 realm 的后果是「读不到」，不是「读到别人的」——fail-closed 的方向只允许这一种。
   */
  private realm: string

  constructor(connectionString: string, realm = '') {
    this.pool = new pg.Pool({ connectionString })
    this.realm = realm
  }

  async init(): Promise<void> {
    await this.pool.query(PROJECT_DDL)
  }

  async create(project: Project, owner: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        `INSERT INTO projects (id, realm, name, created_by) VALUES ($1,$2,$3,$4)
         ON CONFLICT (id) DO NOTHING`,
        [project.projectId, project.realm, project.name, owner],
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
      `UPDATE projects SET status = 'archived', archived_at = now() WHERE id = $1`,
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
      `INSERT INTO project_artifacts (project_id, kind, name, version)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (project_id, kind, name) DO UPDATE SET version = EXCLUDED.version`,
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
    const p = await this.pool.query<{ id: string; realm: string; name: string; status: 'active' | 'archived' }>(
      'SELECT id, realm, name, status FROM projects WHERE id = $1',
      [projectId],
    )
    if (p.rows.length === 0) return undefined

    const [members, artifacts, spaces, automations, usage, budget] = await Promise.all([
      this.pool.query<{ user_id: string; role: ProjectRole }>(
        'SELECT user_id, role FROM project_members WHERE project_id = $1', [projectId]),
      this.pool.query<{ kind: ArtifactKind; name: string; version: string }>(
        'SELECT kind, name, version FROM project_artifacts WHERE project_id = $1', [projectId]),
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
      project: { projectId: row.id, realm: row.realm, name: row.name, state: row.status },
      members: members.rows.map((r) => ({ userId: r.user_id, role: r.role })),
      artifacts: artifacts.rows.map((r) => ({ kind: r.kind, name: r.name, version: r.version })),
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

  /**
   * 决策记忆索引层（§24.4 第 2 条）：常驻的那一层，**常驻所以必须有界**。
   *
   * 参数顺序与 Go 侧 store.ListDecisionIndex 一致（realm 来自装配配置、不在参数里——
   * 拿不到 realm 的调用方读到的必须是空集）。kind 传闭集外的值直接抛错：静默按
   * 「没有这类决策」返回空集，会让契约漂移表现成「记忆是空的」。
   */
  async decisionIndex(
    projectId: string,
    opts: { kind?: DecisionKind; limit?: number } = {},
  ): Promise<DecisionIndexRow[]> {
    if (opts.kind !== undefined && !DECISION_KINDS.includes(opts.kind)) {
      throw new Error(`未知决策 kind ${String(opts.kind)}，合法取值：${DECISION_KINDS.join(' / ')}`)
    }
    const bound = resolveDecisionIndexLimit(opts.limit)
    const params: unknown[] = [this.realm, projectId]
    if (opts.kind !== undefined) params.push(opts.kind)
    params.push(bound)
    const rows = await this.pool.query<{
      id: string; kind: DecisionKind; summary: string; supersedes: string; created_at: Date
    }>(decisionIndexQuery(opts.kind), params)
    return rows.rows.map((r) => ({
      id: r.id, kind: r.kind, summary: r.summary,
      supersedes: r.supersedes || undefined,
      createdAt: r.created_at.toISOString(),
    }))
  }

  /** 正文层：命中索引之后再取全文（两级读面的第二级）。被取代的行同样读得到。 */
  async decisionBody(projectId: string, decisionId: string): Promise<Decision | undefined> {
    const rows = await this.pool.query<{
      id: string; realm: string; project_id: string; kind: DecisionKind
      summary: string; body: string; supersedes: string; superseded_by: string
      evidence: Decision['evidence'] | null; created_at: Date
    }>(DECISION_BODY_SQL, [this.realm, projectId, decisionId])
    const row = rows.rows[0]
    if (row === undefined) return undefined
    return {
      id: row.id, realm: row.realm, projectId: row.project_id, kind: row.kind,
      summary: row.summary, body: row.body,
      supersedes: row.supersedes || undefined,
      supersededBy: row.superseded_by || undefined,
      evidence: row.evidence ?? undefined,
      createdAt: row.created_at.toISOString(),
    }
  }

  // 决策记忆**没有写入面**（§24.4 第 4 条）。追加与取代必须同一个事务：插新行 +
  // 只回填旧行的 superseded_by + `AND superseded_by IS NULL` 的 CAS。这份事务在 Go 侧
  // （store.AppendDecision）只写了一遍；TS 再写一遍，两边迟早有一边漏掉那个 CAS 条件，
  // 于是同一行被两条新决策同时取代而无人察觉。固化任务（去重/剪枝/矛盾标注）同样只在
  // Go 侧实现一次——启发式判据有两份实现，等于有两套互相矛盾的结论。

  async close(): Promise<void> {
    await this.pool.end()
  }
}

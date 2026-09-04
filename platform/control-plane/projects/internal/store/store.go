// Package store 项目工作区存储层（projects / project_members / budget_trees 种子）。
//
// DDL 真相源在此（Go 服务独有表）；budget_trees 沿用 TS 侧 metering 的表结构
// （kind='project' 行——N3 拍板 B：项目树与用户树同表同键，本服务只种子不执法，
// 扣减在 TS 侧 commit() 的同事务双树路径，已落地已测）。
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/projects/internal/domain"
)

// DDL projects 与 project_members。删除用行删除（项目是组织实体不是 append-only
// 台账）；usage_ledger 的历史归因行不动——账不可毁，实体可消失（设计说明 §1/§8）。
const DDL = `
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_realm_name_uq ON projects (realm, name);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE TABLE IF NOT EXISTS project_artifacts (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('component','skill','agent','connector','flow')),
  name       TEXT NOT NULL,
  version    TEXT NOT NULL,
  PRIMARY KEY (project_id, kind, name)
);

CREATE TABLE IF NOT EXISTS project_spaces (
  space_id   TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  realm      TEXT NOT NULL,
  name       TEXT NOT NULL,
  UNIQUE (project_id, name)
);

CREATE TABLE IF NOT EXISTS project_automations (
  automation_id TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  trigger_kind  TEXT NOT NULL CHECK (trigger_kind IN ('cron','webhook','event')),
  trigger_spec  TEXT NOT NULL,
  flow_ref      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true
);

-- task_reports is the project-facing report projection. The governance service
-- owns the task/run lifecycle; this table intentionally keeps only report
-- sections and evidence coordinates, never a copied session transcript.
CREATE TABLE IF NOT EXISTS task_reports (
  id          TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  run_id      TEXT,
  sections    JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','confirmed','archived')),
  created_by  TEXT NOT NULL,
  confirmed_by TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE task_reports ADD COLUMN IF NOT EXISTS confirmed_by TEXT;
CREATE INDEX IF NOT EXISTS task_reports_pending_idx ON task_reports (realm, updated_at DESC) WHERE status = 'draft';
`

// 领域错误（server 层映射 HTTP 状态）。
var (
	ErrNotFound      = errors.New("项目不存在（或非成员不可见）")
	ErrNameTaken     = errors.New("同名项目已存在于本 realm")
	ErrLastOwner     = errors.New("最后一个 owner 不可移除或降级（项目不可成为无主孤儿）")
	ErrNotArchived   = errors.New("删除只接受 archived 态——归档是常态，删除是异常（先归档再删）")
	ErrAlreadyMember = errors.New("该用户已是成员")
	// ErrMeteringNotReady budget_trees 表尚未创建（真相源在 TS metering 插件，
	// dsh-node 首启时建）。项目树种子是创建的硬依赖——不建表（第二 DDL 真相源
	// 比等待更贵），把装配顺序如实暴露给调用方。
	ErrMeteringNotReady = errors.New("budget_trees 尚未创建（计量插件未初始化——须先完成 metering 建表再创建项目）")
	ErrReportStale      = errors.New("report session log is stale; refusing to persist a partial report")
	ErrInvalidReport    = errors.New("invalid task report")
	ErrConflict         = errors.New("task report state conflicts with the requested operation")
)

// Store PG 存储。
type Store struct {
	pool          *pgxpool.Pool
	defaultBudget int64
}

func New(pool *pgxpool.Pool, defaultBudget int64) *Store {
	if defaultBudget <= 0 {
		defaultBudget = 1_000_000_000 // 与 TS 侧缺省一致：视为不限额
	}
	return &Store{pool: pool, defaultBudget: defaultBudget}
}

// Init 幂等建表。
func (s *Store) Init(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, DDL)
	if err != nil {
		return fmt.Errorf("建 projects 表失败: %w", err)
	}
	return nil
}

// CreateProject 创建项目：owner 成员行 + 项目预算树种子，**同一事务**——半途失败
// 不得留下「无主项目」或「无预算树的项目」（后者会让计量扣减静默落到缺省额度，
// 口径在创建那刻就分叉）。预算种子仅无行时插入（与 TS 侧 seedDefaultBudget 同语义）。
func (s *Store) CreateProject(ctx context.Context, id, realm, name, creator string) (domain.Project, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return domain.Project{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	p := domain.Project{ID: id, Realm: realm, Name: name, Status: domain.StatusActive, CreatedBy: creator}
	err = tx.QueryRow(ctx, `
		INSERT INTO projects (id, realm, name, status, created_by)
		VALUES ($1, $2, $3, 'active', $4)
		RETURNING created_at`, id, realm, name, creator).Scan(&p.CreatedAt)
	if err != nil {
		if isUniqueViolation(err) {
			return domain.Project{}, ErrNameTaken
		}
		return domain.Project{}, fmt.Errorf("插入 projects 失败: %w", err)
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'owner')`,
		id, creator); err != nil {
		return domain.Project{}, fmt.Errorf("插入 owner 成员失败: %w", err)
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO budget_trees (kind, id, budget)
		VALUES ('project', $1, $2)
		ON CONFLICT DO NOTHING`, id, s.defaultBudget); err != nil {
		if isUndefinedTable(err) {
			return domain.Project{}, ErrMeteringNotReady
		}
		return domain.Project{}, fmt.Errorf("种子项目预算树失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return domain.Project{}, err
	}
	return p, nil
}

// GetProject 取项目（附带 caller 的角色；realm 不符或非成员都返回 ErrNotFound——
// 存在性本身不可泄露，与列表的成员可见性语义同源）。
func (s *Store) GetProject(ctx context.Context, id, realm, userID string) (domain.Project, string, error) {
	var p domain.Project
	var role string
	var archivedAt *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT p.id, p.realm, p.name, p.status, p.created_by, p.created_at, p.archived_at,
		       COALESCE(m.role, '')
		FROM projects p
		LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $3
		WHERE p.id = $1 AND p.realm = $2`, id, realm, userID).
		Scan(&p.ID, &p.Realm, &p.Name, &p.Status, &p.CreatedBy, &p.CreatedAt, &archivedAt, &role)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Project{}, "", ErrNotFound
	}
	if err != nil {
		return domain.Project{}, "", err
	}
	if role == "" {
		return domain.Project{}, "", ErrNotFound // 非成员：不可见而非 403
	}
	p.ArchivedAt = archivedAt
	return p, role, nil
}

// ListProjects 本人作为成员的项目列表（成员视角——先立紧边界，admin 全量视角
// 随 OPA 角色面，设计 §8）。
func (s *Store) ListProjects(ctx context.Context, realm, userID string) ([]domain.Project, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT p.id, p.realm, p.name, p.status, p.created_by, p.created_at, p.archived_at
		FROM projects p
		JOIN project_members m ON m.project_id = p.id AND m.user_id = $2
		WHERE p.realm = $1
		ORDER BY p.created_at DESC`, realm, userID)
	if err != nil {
		return nil, err
	}
	out := []domain.Project{}
	for rows.Next() {
		var p domain.Project
		var archivedAt *time.Time
		if err := rows.Scan(&p.ID, &p.Realm, &p.Name, &p.Status, &p.CreatedBy, &p.CreatedAt, &archivedAt); err != nil {
			return nil, err
		}
		p.ArchivedAt = archivedAt
		out = append(out, p)
	}
	return out, rows.Err()
}

// ListMembers 项目成员清单（project.read 即可）。
func (s *Store) ListMembers(ctx context.Context, projectID string) ([]domain.Member, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT project_id, user_id, role, added_at FROM project_members
		WHERE project_id = $1 ORDER BY added_at, user_id`, projectID)
	if err != nil {
		return nil, err
	}
	out := []domain.Member{}
	for rows.Next() {
		var m domain.Member
		if err := rows.Scan(&m.ProjectID, &m.UserID, &m.Role, &m.AddedAt); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// AddMember 加成员（owner 执法在 server 层）。已存在成员报 ErrAlreadyMember。
func (s *Store) AddMember(ctx context.Context, projectID, userID, role string) error {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, $3)
		ON CONFLICT (project_id, user_id) DO NOTHING`, projectID, userID, role)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrAlreadyMember
	}
	return nil
}

// UpdateMemberRole 改角色。最后一个 owner 降级 = 无主孤儿，拒绝。
func (s *Store) UpdateMemberRole(ctx context.Context, projectID, userID, role string) error {
	// 同一事务内先数 owner：降级的是最后 owner 时 0 行更新
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var cur string
	err = tx.QueryRow(ctx,
		`SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
		projectID, userID).Scan(&cur)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if cur == domain.RoleOwner && role != domain.RoleOwner {
		var owners int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM project_members WHERE project_id = $1 AND role = 'owner'`,
			projectID).Scan(&owners); err != nil {
			return err
		}
		if owners <= 1 {
			return ErrLastOwner
		}
	}
	if _, err := tx.Exec(ctx,
		`UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2`,
		projectID, userID, role); err != nil {
		return err
	}
	return tx.Commit(ctx)
}

// RemoveMember 移除成员。最后一个 owner 不可移除。
func (s *Store) RemoveMember(ctx context.Context, projectID, userID string) error {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var role string
	err = tx.QueryRow(ctx,
		`SELECT role FROM project_members WHERE project_id = $1 AND user_id = $2`,
		projectID, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if role == domain.RoleOwner {
		var owners int
		if err := tx.QueryRow(ctx,
			`SELECT count(*) FROM project_members WHERE project_id = $1 AND role = 'owner'`,
			projectID).Scan(&owners); err != nil {
			return err
		}
		if owners <= 1 {
			return ErrLastOwner
		}
	}
	tag, err := tx.Exec(ctx,
		`DELETE FROM project_members WHERE project_id = $1 AND user_id = $2`, projectID, userID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return tx.Commit(ctx)
}

func (s *Store) UpsertArtifact(ctx context.Context, artifact domain.Artifact) error {
	if artifact.Kind != "component" && artifact.Kind != "skill" && artifact.Kind != "agent" &&
		artifact.Kind != "connector" && artifact.Kind != "flow" {
		return fmt.Errorf("未知制品类型 %q", artifact.Kind)
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO project_artifacts (project_id, kind, name, version)
		VALUES ($1,$2,$3,$4)
		ON CONFLICT (project_id, kind, name) DO UPDATE SET version = EXCLUDED.version`,
		artifact.ProjectID, artifact.Kind, artifact.Name, artifact.Version)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListArtifacts(ctx context.Context, projectID string) ([]domain.Artifact, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT project_id, kind, name, version FROM project_artifacts
		WHERE project_id = $1 ORDER BY kind, name`, projectID)
	if err != nil {
		return nil, err
	}
	out := []domain.Artifact{}
	for rows.Next() {
		var a domain.Artifact
		if err := rows.Scan(&a.ProjectID, &a.Kind, &a.Name, &a.Version); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

func (s *Store) UpsertSpace(ctx context.Context, space domain.Space) error {
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO project_spaces (space_id, project_id, realm, name)
		SELECT $1, $2, $3, $4 WHERE EXISTS (
			SELECT 1 FROM projects WHERE id = $2 AND realm = $3)
		ON CONFLICT (space_id) DO UPDATE SET name = EXCLUDED.name`,
		space.ID, space.ProjectID, space.Realm, space.Name)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrNotFound
	}
	return nil
}

func (s *Store) ListSpaces(ctx context.Context, projectID string) ([]domain.Space, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT space_id, project_id, realm, name FROM project_spaces
		WHERE project_id = $1 ORDER BY name, space_id`, projectID)
	if err != nil {
		return nil, err
	}
	out := []domain.Space{}
	for rows.Next() {
		var space domain.Space
		if err := rows.Scan(&space.ID, &space.ProjectID, &space.Realm, &space.Name); err != nil {
			return nil, err
		}
		out = append(out, space)
	}
	return out, rows.Err()
}

func (s *Store) UpsertAutomation(ctx context.Context, a domain.Automation) error {
	if a.TriggerKind != "cron" && a.TriggerKind != "webhook" && a.TriggerKind != "event" {
		return fmt.Errorf("未知触发器类型 %q", a.TriggerKind)
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO project_automations
		  (automation_id, project_id, trigger_kind, trigger_spec, flow_ref, enabled)
		VALUES ($1,$2,$3,$4,$5,$6)
		ON CONFLICT (automation_id) DO UPDATE SET
		  trigger_kind=EXCLUDED.trigger_kind, trigger_spec=EXCLUDED.trigger_spec,
		  flow_ref=EXCLUDED.flow_ref, enabled=EXCLUDED.enabled`,
		a.ID, a.ProjectID, a.TriggerKind, a.TriggerSpec, a.FlowRef, a.Enabled)
	return err
}

func (s *Store) ListAutomations(ctx context.Context, projectID string) ([]domain.Automation, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT automation_id, project_id, trigger_kind, trigger_spec, flow_ref, enabled
		FROM project_automations WHERE project_id = $1 ORDER BY automation_id`, projectID)
	if err != nil {
		return nil, err
	}
	out := []domain.Automation{}
	for rows.Next() {
		var a domain.Automation
		if err := rows.Scan(&a.ID, &a.ProjectID, &a.TriggerKind, &a.TriggerSpec, &a.FlowRef, &a.Enabled); err != nil {
			return nil, err
		}
		out = append(out, a)
	}
	return out, rows.Err()
}

// DeleteAutomation 删除一条自动化规则。删除不存在规则的返回与成功一致（幂等），
// 便于前端在不关心先验存在性的情况下安全清理。
func (s *Store) DeleteAutomation(ctx context.Context, projectID, automationID string) error {
	_, err := s.pool.Exec(ctx, `
		DELETE FROM project_automations
		WHERE project_id = $1 AND automation_id = $2`,
		projectID, automationID)
	return err
}

// Transition 生命周期转移（幂等：重复 archive 是重放）。归档时刻只在
// active→archived 那次写入。
func (s *Store) Transition(ctx context.Context, projectID, event string) (domain.Project, error) {
	p, _, err := s.getProjectByID(ctx, projectID)
	if err != nil {
		return domain.Project{}, err
	}
	next, err := domain.TransitionProject(p.Status, event)
	if err != nil {
		return domain.Project{}, err
	}
	if next == p.Status {
		return p, nil // 自反转移幂等
	}
	var archivedAt *time.Time
	if next == domain.StatusArchived {
		now := time.Now().UTC()
		archivedAt = &now
	}
	_, err = s.pool.Exec(ctx,
		`UPDATE projects SET status = $2, archived_at = $3 WHERE id = $1`,
		projectID, next, archivedAt)
	if err != nil {
		return domain.Project{}, err
	}
	p.Status = next
	p.ArchivedAt = archivedAt
	return p, nil
}

// DeleteProject 终局删除：仅 archived 态 + 行删除（members 级联）。usage_ledger
// 的历史归因行不动——append-only 账不因组织实体消失而破例（设计 §1）。
func (s *Store) DeleteProject(ctx context.Context, projectID string) error {
	tag, err := s.pool.Exec(ctx, `DELETE FROM projects WHERE id = $1 AND status = 'archived'`, projectID)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		// 不存在，或 active 态直接删——两者都拒绝（不区分，避免存在性泄露之外的语义纠缠）
		return ErrNotArchived
	}
	return nil
}

// Usage 项目用量聚合 + 预算四态（仪表板最小后端）。聚合直读 usage_ledger——
// 只读账不写账，单一写入者原则不动摇（§6.4）。
func (s *Store) Usage(ctx context.Context, projectID string) ([]domain.UsageItem, domain.BudgetSnapshot, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT cost_type, COALESCE(SUM(qty), 0)::float8, COALESCE(SUM(cost_usd), 0)::float8
		FROM usage_ledger WHERE project_id = $1
		GROUP BY cost_type ORDER BY cost_type`, projectID)
	if err != nil {
		return nil, domain.BudgetSnapshot{}, err
	}
	items := []domain.UsageItem{}
	for rows.Next() {
		var it domain.UsageItem
		if err := rows.Scan(&it.CostType, &it.Qty, &it.CostUSD); err != nil {
			return nil, domain.BudgetSnapshot{}, err
		}
		items = append(items, it)
	}
	if err := rows.Err(); err != nil {
		return nil, domain.BudgetSnapshot{}, err
	}

	snap := domain.BudgetSnapshot{State: "unknown"}
	err = s.pool.QueryRow(ctx, `
		SELECT COALESCE(budget, 0), COALESCE(budget_total, budget, 0),
		       COALESCE(soft_limit, 0), COALESCE(overdraft, 0)
		FROM budget_trees WHERE kind = 'project' AND id = $1`, projectID).
		Scan(&snap.Remaining, &snap.Budget, &snap.SoftLimit, &snap.Overdraft)
	if errors.Is(err, pgx.ErrNoRows) {
		// 无预算行 = 未种子的树（创建路径必种子；此处仅防御）——四态 unknown
		return items, snap, nil
	}
	if err != nil {
		return nil, domain.BudgetSnapshot{}, err
	}
	snap.State = budgetState(snap)
	return items, snap, nil
}

// budgetState 四态（与 TS 侧 budget-policy 同判序：hard > within(透支窗) > soft > ok）。
func budgetState(s domain.BudgetSnapshot) string {
	switch {
	case s.Remaining < -s.Overdraft:
		return "hard"
	case s.Remaining < 0:
		return "within" // 透支窗口内
	case s.SoftLimit > 0 && s.Remaining < s.SoftLimit:
		return "soft"
	default:
		return "ok"
	}
}

const reportMaxLag int64 = 8

func nullableText(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func validateReportSections(sections []domain.ReportSection) error {
	allowed := map[string]bool{}
	for _, name := range domain.ReportSectionNames {
		allowed[name] = true
	}
	seen := map[string]bool{}
	for i := range sections {
		section := &sections[i]
		if !allowed[section.Name] || seen[section.Name] {
			return fmt.Errorf("%w: unknown or duplicate section %q", ErrInvalidReport, section.Name)
		}
		seen[section.Name] = true
		clean := section.Evidence[:0]
		for _, evidence := range section.Evidence {
			if evidence.SessionRef == "" || evidence.Seq < 0 {
				continue
			}
			clean = append(clean, evidence)
		}
		section.Evidence = clean
		// Evidence is the only source of verification. A client cannot promote a
		// prose-only section by setting verified=true in JSON.
		section.Verified = len(clean) > 0
	}
	if len(seen) != len(allowed) {
		return fmt.Errorf("%w: report must contain all six sections", ErrInvalidReport)
	}
	return nil
}

func reportReplicaHead(sections []domain.ReportSection) int64 {
	var head int64
	for _, section := range sections {
		for _, evidence := range section.Evidence {
			if evidence.Seq > head {
				head = evidence.Seq
			}
		}
	}
	return head
}

func reportIsStale(sections []domain.ReportSection, liveHead *int64) bool {
	return liveHead != nil && *liveHead-reportReplicaHead(sections) > reportMaxLag
}

type reportCostLine struct {
	CostType string  `json:"cost_type"`
	Qty      float64 `json:"qty"`
	Tokens   int64   `json:"tokens"`
	CostUSD  float64 `json:"cost_usd"`
}

type reportCostSummary struct {
	Source     string           `json:"source"`
	CostUSD    float64          `json:"cost_usd"`
	Tokens     int64            `json:"tokens"`
	ByCostType []reportCostLine `json:"by_cost_type"`
}

func (s *Store) hydrateReportCost(ctx context.Context, sections []domain.ReportSection) error {
	refs := make([]string, 0)
	seen := map[string]bool{}
	for _, section := range sections {
		for _, evidence := range section.Evidence {
			if evidence.SessionRef != "" && !seen[evidence.SessionRef] {
				seen[evidence.SessionRef] = true
				refs = append(refs, evidence.SessionRef)
			}
		}
	}
	if len(refs) == 0 {
		return nil
	}
	rows, err := s.pool.Query(ctx, `
		SELECT cost_type, COALESCE(SUM(qty),0)::float8, COALESCE(SUM(tokens),0)::bigint, COALESCE(SUM(cost_usd),0)::float8
		FROM usage_ledger WHERE session_ref = ANY($1::text[]) GROUP BY cost_type ORDER BY cost_type`, refs)
	if isUndefinedTable(err) {
		// A project service can start before the optional metering plugin. Do not
		// fabricate a cost value; the report can still carry its other evidence.
		return nil
	}
	if err != nil {
		return err
	}
	defer rows.Close()
	summary := reportCostSummary{Source: "usage_ledger", ByCostType: []reportCostLine{}}
	for rows.Next() {
		var line reportCostLine
		if err := rows.Scan(&line.CostType, &line.Qty, &line.Tokens, &line.CostUSD); err != nil {
			return err
		}
		summary.CostUSD += line.CostUSD
		summary.Tokens += line.Tokens
		summary.ByCostType = append(summary.ByCostType, line)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	encoded, err := json.Marshal(summary)
	if err != nil {
		return err
	}
	for i := range sections {
		if sections[i].Name == "cost" {
			sections[i].Content = encoded
		}
	}
	return nil
}

func (s *Store) CreateTaskReport(ctx context.Context, report domain.TaskReport, liveHead *int64) (domain.TaskReport, error) {
	if report.ID == "" || report.Realm == "" || report.TaskID == "" || report.CreatedBy == "" {
		return domain.TaskReport{}, fmt.Errorf("%w: id, realm, task_id and created_by are required", ErrInvalidReport)
	}
	if report.Status == "" {
		report.Status = domain.ReportDraft
	}
	if report.Status != domain.ReportDraft {
		return domain.TaskReport{}, fmt.Errorf("%w: new report must be draft", ErrInvalidReport)
	}
	if err := validateReportSections(report.Sections); err != nil {
		return domain.TaskReport{}, err
	}
	if reportIsStale(report.Sections, liveHead) {
		return domain.TaskReport{}, ErrReportStale
	}
	if err := s.hydrateReportCost(ctx, report.Sections); err != nil {
		return domain.TaskReport{}, err
	}
	sections, err := json.Marshal(report.Sections)
	if err != nil {
		return domain.TaskReport{}, err
	}
	err = s.pool.QueryRow(ctx, `
		INSERT INTO task_reports (id,realm,task_id,run_id,sections,status,created_by)
		VALUES ($1,$2,$3,$4,$5,'draft',$6)
		RETURNING created_at,updated_at`, report.ID, report.Realm, report.TaskID, nullableText(report.RunID), sections, report.CreatedBy).
		Scan(&report.CreatedAt, &report.UpdatedAt)
	if isUniqueViolation(err) {
		return domain.TaskReport{}, ErrConflict
	}
	if err != nil {
		return domain.TaskReport{}, err
	}
	return report, nil
}

func scanTaskReport(row interface{ Scan(dest ...any) error }, report *domain.TaskReport) error {
	var sections []byte
	err := row.Scan(&report.ID, &report.Realm, &report.TaskID, &report.RunID, &sections, &report.Status, &report.CreatedBy, &report.ConfirmedBy, &report.CreatedAt, &report.UpdatedAt)
	if err != nil {
		return err
	}
	if len(sections) == 0 {
		report.Sections = []domain.ReportSection{}
		return nil
	}
	return json.Unmarshal(sections, &report.Sections)
}

func reportSelect() string {
	return `SELECT id,realm,task_id,COALESCE(run_id,''),sections,status,created_by,COALESCE(confirmed_by,''),created_at,updated_at FROM task_reports`
}

func (s *Store) GetTaskReport(ctx context.Context, realm, taskID string, liveHead *int64) (domain.TaskReport, error) {
	var report domain.TaskReport
	err := scanTaskReport(s.pool.QueryRow(ctx, reportSelect()+` WHERE realm=$1 AND task_id=$2 ORDER BY updated_at DESC LIMIT 1`, realm, taskID), &report)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskReport{}, ErrNotFound
	}
	if err != nil {
		return domain.TaskReport{}, err
	}
	if reportIsStale(report.Sections, liveHead) {
		return domain.TaskReport{}, ErrReportStale
	}
	return report, nil
}

func (s *Store) ConfirmTaskReport(ctx context.Context, realm, taskID, reportID, confirmedBy string) (domain.TaskReport, error) {
	return s.confirmTaskReport(ctx, realm, taskID, reportID, confirmedBy)
}

func (s *Store) ConfirmTaskReportByID(ctx context.Context, realm, reportID, confirmedBy string) (domain.TaskReport, error) {
	var taskID string
	err := s.pool.QueryRow(ctx, `SELECT task_id FROM task_reports WHERE realm=$1 AND id=$2`, realm, reportID).Scan(&taskID)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskReport{}, ErrNotFound
	}
	if err != nil {
		return domain.TaskReport{}, err
	}
	return s.confirmTaskReport(ctx, realm, taskID, reportID, confirmedBy)
}

func (s *Store) confirmTaskReport(ctx context.Context, realm, taskID, reportID, confirmedBy string) (domain.TaskReport, error) {
	var report domain.TaskReport
	err := scanTaskReport(s.pool.QueryRow(ctx, reportSelect()+` WHERE realm=$1 AND task_id=$2 AND id=$3`, realm, taskID, reportID), &report)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskReport{}, ErrNotFound
	}
	if err != nil {
		return domain.TaskReport{}, err
	}
	verified := false
	for _, section := range report.Sections {
		if !section.Verified || len(section.Evidence) == 0 {
			verified = false
			break
		}
		verified = true
	}
	if !verified || len(report.Sections) == 0 {
		return domain.TaskReport{}, fmt.Errorf("%w: every report section needs evidence before confirmation", ErrInvalidReport)
	}
	err = scanTaskReport(s.pool.QueryRow(ctx, `
		UPDATE task_reports SET status='confirmed',confirmed_by=$4,updated_at=now()
		WHERE realm=$1 AND task_id=$2 AND id=$3 AND status='draft'
		RETURNING id,realm,task_id,COALESCE(run_id,''),sections,status,created_by,COALESCE(confirmed_by,''),created_at,updated_at`, realm, taskID, reportID, confirmedBy), &report)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.TaskReport{}, ErrConflict
	}
	return report, err
}

func (s *Store) getProjectByID(ctx context.Context, projectID string) (domain.Project, string, error) {
	var p domain.Project
	var archivedAt *time.Time
	err := s.pool.QueryRow(ctx, `
		SELECT id, realm, name, status, created_by, created_at, archived_at
		FROM projects WHERE id = $1`, projectID).
		Scan(&p.ID, &p.Realm, &p.Name, &p.Status, &p.CreatedBy, &p.CreatedAt, &archivedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return domain.Project{}, "", ErrNotFound
	}
	if err != nil {
		return domain.Project{}, "", err
	}
	p.ArchivedAt = archivedAt
	return p, "", nil
}

// isUniqueViolation PG 23505；isUndefinedTable PG 42P01。
func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23505"
	}
	return false
}

func isUndefinedTable(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "42P01"
	}
	return false
}

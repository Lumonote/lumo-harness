// Package store 项目工作区存储层（projects / project_members / budget_trees 种子）。
//
// DDL 真相源在此（Go 服务独有表）；budget_trees 沿用 TS 侧 metering 的表结构
// （kind='project' 行——N3 拍板 B：项目树与用户树同表同键，本服务只种子不执法，
// 扣减在 TS 侧 commit() 的同事务双树路径，已落地已测）。
package store

import (
	"context"
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
`

// 领域错误（server 层映射 HTTP 状态）。
var (
	ErrNotFound        = errors.New("项目不存在（或非成员不可见）")
	ErrNameTaken       = errors.New("同名项目已存在于本 realm")
	ErrLastOwner       = errors.New("最后一个 owner 不可移除或降级（项目不可成为无主孤儿）")
	ErrNotArchived     = errors.New("删除只接受 archived 态——归档是常态，删除是异常（先归档再删）")
	ErrAlreadyMember   = errors.New("该用户已是成员")
)

// Store PG 存储。
type Store struct {
	pool           *pgxpool.Pool
	defaultBudget  int64
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

// isUniqueViolation PG 23505。
func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23505"
	}
	return false
}

// Package store 第五类制品存储层（flows / flow_versions / flow_reviews）。
//
// 与 projects 服务的关系：flows 只读 project_members 表判定项目成员（两服务同库
// 不同表，跨服务 HTTP 调用在单机拓扑里是无谓故障面——设计说明 §8 取舍）。
package store

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/flows/internal/domain"
)

const DDL = `
CREATE TABLE IF NOT EXISTS flows (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL,
  realm        TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',
  visibility   TEXT NOT NULL DEFAULT 'private',
  author       TEXT NOT NULL,
  version      INT  NOT NULL DEFAULT 0,
  audience     JSONB,
  definition   JSONB NOT NULL,
  review_comment TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ,
  published_at TIMESTAMPTZ,
  deprecated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS flows_project_name_uq ON flows (project_id, name);

CREATE TABLE IF NOT EXISTS flow_versions (
  flow_id      TEXT NOT NULL,
  version      INT  NOT NULL,
  definition   JSONB NOT NULL,
  reviewer     TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, version)
);

CREATE TABLE IF NOT EXISTS flow_reviews (
  id BIGSERIAL PRIMARY KEY,
  flow_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL,
  comment TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

var (
	ErrNotFound      = errors.New("流程不存在（或不可见）")
	ErrNameTaken     = errors.New("同名流程已存在于本项目")
	ErrNotAuthor     = errors.New("仅作者可操作草稿")
	ErrOnlyDraft     = errors.New("仅 draft 态可改定义")
	ErrSelfReview    = errors.New("作者不可自审（职责分离）")
	ErrNotReviewer   = errors.New("审核须 manager/admin 角色")
	ErrVersionGone   = errors.New("回滚目标版本不存在")
)

type Store struct {
	pool *pgxpool.Pool
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("建 flows 表失败: %w", err)
	}
	return nil
}

// ProjectRole 只读查 project_members（表属 projects 服务 DDL 真相源）。
func (s *Store) ProjectRole(ctx context.Context, projectID, realm, userID string) (string, error) {
	var role string
	err := s.pool.QueryRow(ctx, `
		SELECT m.role FROM project_members m
		JOIN projects p ON p.id = m.project_id
		WHERE m.project_id = $1 AND p.realm = $2 AND m.user_id = $3`,
		projectID, realm, userID).Scan(&role)
	if errors.Is(err, pgx.ErrNoRows) {
		return "", ErrNotFound
	}
	return role, err
}

func scanFlow(row pgx.Row) (*domain.Flow, error) {
	var f domain.Flow
	var audience []byte
	err := row.Scan(&f.ID, &f.ProjectID, &f.Realm, &f.Name, &f.Status, &f.Visibility,
		&f.Author, &f.Version, &audience, &f.ReviewComment,
		&f.CreatedAt, &f.UpdatedAt, &f.SubmittedAt, &f.PublishedAt, &f.DeprecatedAt)
	if err != nil {
		return nil, err
	}
	if len(audience) > 0 {
		var a domain.Audience
		if err := json.Unmarshal(audience, &a); err == nil {
			f.Audience = &a
		}
	}
	return &f, nil
}

const flowCols = `id, project_id, realm, name, status, visibility, author, version,
	audience, review_comment, created_at, updated_at, submitted_at, published_at, deprecated_at`

// GetFlow 取流程（realm 边界）。可见性执法在 server 层（draft 仅作者等）。
func (s *Store) GetFlow(ctx context.Context, id, realm string) (*domain.Flow, error) {
	if realm == "" {
		return s.getFlowByID(ctx, id)
	}
	f, err := scanFlow(s.pool.QueryRow(ctx,
		`SELECT `+flowCols+` FROM flows WHERE id = $1 AND realm = $2`, id, realm))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

// getFlowByID 内部取流程（状态机/审核路径用——已通过 server 的 realm 边界）。
func (s *Store) getFlowByID(ctx context.Context, id string) (*domain.Flow, error) {
	f, err := scanFlow(s.pool.QueryRow(ctx,
		`SELECT `+flowCols+` FROM flows WHERE id = $1`, id))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return f, nil
}

// CreateFlow 建草稿。definition 已在 server 层过防环校验。
func (s *Store) CreateFlow(ctx context.Context, id, projectID, realm, name, author string, def json.RawMessage) (*domain.Flow, error) {
	f, err := scanFlow(s.pool.QueryRow(ctx, `
		INSERT INTO flows (id, project_id, realm, name, author, definition)
		VALUES ($1, $2, $3, $4, $5, $6)
		RETURNING `+flowCols, id, projectID, realm, name, author, def))
	if err != nil {
		if isUniqueViolation(err) {
			return nil, ErrNameTaken
		}
		return nil, fmt.Errorf("插入 flows 失败: %w", err)
	}
	return f, nil
}

// UpdateDefinition 改草稿（server 层已验作者 + draft 态）。
func (s *Store) UpdateDefinition(ctx context.Context, id string, def json.RawMessage) error {
	tag, err := s.pool.Exec(ctx,
		`UPDATE flows SET definition = $2, updated_at = now() WHERE id = $1 AND status = 'draft'`,
		id, def)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrOnlyDraft
	}
	return nil
}

// Transition 状态机执行：非法转移报 domain 错（server 映射 409）。
func (s *Store) Transition(ctx context.Context, id, event string) (*domain.Flow, error) {
	f, err := s.GetFlow(ctx, id, "")
	if err != nil {
		return nil, err
	}
	next, err := domain.TransitionFlow(f.Status, event)
	if err != nil {
		return nil, err
	}
	if next == f.Status {
		return f, nil // 幂等（targeted 重定）
	}
	var ts *time.Time
	switch next {
	case domain.StatusSubmitted:
		now := time.Now().UTC()
		ts = &now
	case domain.StatusPublished:
		now := time.Now().UTC()
		ts = &now
	case domain.StatusDeprecated:
		now := time.Now().UTC()
		ts = &now
	}
	var col string
	switch next {
	case domain.StatusSubmitted:
		col = "submitted_at"
	case domain.StatusPublished:
		col = "published_at"
	case domain.StatusDeprecated:
		col = "deprecated_at"
	case domain.StatusDraft:
		col = "" // reject 回 draft：不动时间戳
	}
	set := "status = $2, updated_at = now()"
	if col != "" {
		set = fmt.Sprintf("status = $2, updated_at = now(), %s = $3", col)
		if _, err := s.pool.Exec(ctx,
			`UPDATE flows SET `+set+` WHERE id = $1`, id, next, ts); err != nil {
			return nil, err
		}
	} else if _, err := s.pool.Exec(ctx,
		`UPDATE flows SET `+set+` WHERE id = $1`, id, next); err != nil {
		return nil, err
	}
	return s.GetFlow(ctx, id, "")
}

// Review 审核事务：approve = 状态转移 + 发布快照（flow_versions v+1）+ 重指 version +
// 审计行；reject = 回 draft + 审计行。**同一事务**——快照与指向分家会让「已发布但
// 指向旧版本」这种半态出现在崩溃窗口里。
func (s *Store) Review(ctx context.Context, id, reviewer string, approve bool, comment string) (*domain.Flow, error) {
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var status string
	var def json.RawMessage
	err = tx.QueryRow(ctx, `SELECT status, definition FROM flows WHERE id = $1`, id).Scan(&status, &def)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}

	var next string
	var f *domain.Flow
	if approve {
		next, err = domain.TransitionFlow(status, domain.EventApprove)
	} else {
		next, err = domain.TransitionFlow(status, domain.EventReject)
	}
	if err != nil {
		return nil, err
	}

	decision := "reject"
	if approve {
		decision = "approve"
		var version int
		if err := tx.QueryRow(ctx,
			`SELECT COALESCE(max(version), 0) + 1 FROM flow_versions WHERE flow_id = $1`, id).Scan(&version); err != nil {
			return nil, err
		}
		if _, err := tx.Exec(ctx, `
			INSERT INTO flow_versions (flow_id, version, definition, reviewer)
			VALUES ($1, $2, $3, $4)`, id, version, def, reviewer); err != nil {
			return nil, fmt.Errorf("写发布快照失败: %w", err)
		}
		if _, err := tx.Exec(ctx, `
			UPDATE flows SET status = $2, version = $3, published_at = now(),
			  updated_at = now(), review_comment = NULL WHERE id = $1`,
			id, next, version); err != nil {
			return nil, err
		}
	} else {
		if _, err := tx.Exec(ctx, `
			UPDATE flows SET status = $2, review_comment = $3, updated_at = now()
			WHERE id = $1`, id, next, comment); err != nil {
			return nil, err
		}
	}
	if _, err := tx.Exec(ctx, `
		INSERT INTO flow_reviews (flow_id, reviewer, decision, comment)
		VALUES ($1, $2, $3, $4)`, id, reviewer, decision, comment); err != nil {
		return nil, fmt.Errorf("写审计行失败: %w", err)
	}
	if err := tx.Commit(ctx); err != nil {
		return nil, err
	}
	if f, err = s.GetFlow(ctx, id, ""); err != nil {
		return nil, err
	}
	return f, nil
}

// Target 定向分发：published/targeted → targeted，audience + visibility 同部落库。
func (s *Store) Target(ctx context.Context, id string, audience *domain.Audience, visibility string) (*domain.Flow, error) {
	f, err := s.GetFlow(ctx, id, "")
	if err != nil {
		return nil, err
	}
	next, err := domain.TransitionFlow(f.Status, domain.EventTarget)
	if err != nil {
		return nil, err
	}
	aud, err := json.Marshal(audience)
	if err != nil {
		return nil, err
	}
	if _, err := s.pool.Exec(ctx, `
		UPDATE flows SET status = $2, visibility = $3, audience = $4, updated_at = now()
		WHERE id = $1`, id, next, visibility, aud); err != nil {
		return nil, err
	}
	return s.GetFlow(ctx, id, "")
}

// Rollback 重指版本（不改状态）。目标版本必须存在于 flow_versions——快照是唯一
// 可指的东西，指向空版本会让运行时拿到 404。
func (s *Store) Rollback(ctx context.Context, id string, version int) (*domain.Flow, error) {
	tag, err := s.pool.Exec(ctx, `
		UPDATE flows SET version = $2, updated_at = now()
		WHERE id = $1 AND EXISTS (
		  SELECT 1 FROM flow_versions WHERE flow_id = $1 AND version = $2)`, id, version)
	if err != nil {
		return nil, err
	}
	if tag.RowsAffected() == 0 {
		return nil, ErrVersionGone
	}
	return s.GetFlow(ctx, id, "")
}

// GetVersion 取发布快照（回滚/查看历史版本）。
func (s *Store) GetVersion(ctx context.Context, id string, version int) (json.RawMessage, string, error) {
	var def json.RawMessage
	var reviewer string
	err := s.pool.QueryRow(ctx,
		`SELECT definition, reviewer FROM flow_versions WHERE flow_id = $1 AND version = $2`,
		id, version).Scan(&def, &reviewer)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, "", ErrVersionGone
	}
	return def, reviewer, err
}

// ListProjectFlows 项目内清单：draft/submitted 只列本人，published+ 全员（项目成员
// 执法在 server）。
func (s *Store) ListProjectFlows(ctx context.Context, projectID, realm, userID string) ([]*domain.Flow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+flowCols+` FROM flows
		WHERE project_id = $1 AND realm = $2
		  AND (status NOT IN ('draft','submitted') OR author = $3)
		ORDER BY created_at DESC`, projectID, realm, userID)
	if err != nil {
		return nil, err
	}
	out := []*domain.Flow{}
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, f)
	}
	return out, rows.Err()
}

// Discoverable 流程面板：global ∪ targeted(命中) ∪ private(本人是项目成员)。
// 面板剔除 deprecated（引用方按 id 仍可读详情——「知道它死了」比 404 有用）。
//
// 过滤全在 Go 侧统一裁决（SQL 只做 realm+状态收窄）：三条可见性路径的判据必须
// 与契约同源——SQL 里拼一半 Go 里拼一半，两个半套判据迟早分叉（首版就是这么
// 红的：SQL 放行了项目成员，Go 后置 audience 过滤又把人剔了）。
func (s *Store) Discoverable(ctx context.Context, realm string, caller domain.Caller) ([]*domain.Flow, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT `+flowCols+` FROM flows f
		WHERE f.realm = $1 AND f.status IN ('published','targeted')
		ORDER BY f.created_at DESC`, realm)
	if err != nil {
		return nil, err
	}
	all := []*domain.Flow{}
	for rows.Next() {
		f, err := scanFlow(rows)
		if err != nil {
			return nil, err
		}
		all = append(all, f)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}

	// 调用者的项目成员集（private 路径的判据）
	memberProjects := map[string]bool{}
	mrows, err := s.pool.Query(ctx, `
		SELECT m.project_id FROM project_members m
		JOIN projects p ON p.id = m.project_id AND p.realm = $1
		WHERE m.user_id = $2`, realm, caller.User)
	if err != nil {
		return nil, err
	}
	for mrows.Next() {
		var pid string
		if err := mrows.Scan(&pid); err != nil {
			return nil, err
		}
		memberProjects[pid] = true
	}
	if err := mrows.Err(); err != nil {
		return nil, err
	}

	out := []*domain.Flow{}
	for _, f := range all {
		switch {
		case f.Visibility == domain.VisibilityGlobal:
			out = append(out, f)
		case memberProjects[f.ProjectID]:
			out = append(out, f) // private：项目成员（与 visibility 取值无关——成员恒可见）
		case f.Visibility == domain.VisibilityTargeted && domain.AudienceMatches(f.Audience, caller):
			out = append(out, f)
		}
	}
	return out, nil
}

func isUniqueViolation(err error) bool {
	var pgErr interface{ SQLState() string }
	if errors.As(err, &pgErr) {
		return pgErr.SQLState() == "23505"
	}
	return false
}

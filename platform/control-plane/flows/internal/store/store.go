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
	"log/slog"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/lineage"
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

-- TriggerBus 的持久入口：事件先落 outbox，再由投递 worker 发布到进程内 Bus。
CREATE TABLE IF NOT EXISTS flow_trigger_outbox (
  id                    BIGSERIAL PRIMARY KEY,
  realm                 TEXT NOT NULL,
  event_name            TEXT NOT NULL,
  payload               JSONB NOT NULL,
  -- A replay is a new durable trigger pinned to one failed execution.  These
  -- fields are intentionally stored beside the original payload rather than
  -- recomputed from current automation bindings when the worker picks it up.
  replay_automation_id  TEXT,
  replay_flow_id        TEXT,
  replay_flow_version   INT,
  replay_of_run_id      BIGINT,
  claimed_by            TEXT,
  claimed_at            BIGINT,
  delivered_at          BIGINT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT flow_trigger_replay_binding_complete CHECK (
    (replay_of_run_id IS NULL AND replay_automation_id IS NULL AND replay_flow_id IS NULL AND replay_flow_version IS NULL)
    OR
    (replay_of_run_id IS NOT NULL AND replay_automation_id IS NOT NULL AND replay_flow_id IS NOT NULL AND replay_flow_version > 0)
  )
);
CREATE INDEX IF NOT EXISTS idx_flow_trigger_pending
  ON flow_trigger_outbox (id) WHERE delivered_at IS NULL;
-- Each (trigger, automation) has one business attempt. Explicit replay uses a new trigger.
CREATE TABLE IF NOT EXISTS flow_runs (
  id            BIGSERIAL PRIMARY KEY,
  trigger_id    BIGINT NOT NULL REFERENCES flow_trigger_outbox(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL,
  flow_id       TEXT NOT NULL,
  flow_version  INT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  output        JSONB,
  error         TEXT,
  claimed_at    BIGINT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at   TIMESTAMPTZ,
  UNIQUE (trigger_id, automation_id)
);
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS claimed_at BIGINT;
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS replay_automation_id TEXT;
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS replay_flow_id TEXT;
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS replay_flow_version INT;
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS replay_of_run_id BIGINT;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flow_trigger_outbox'::regclass
      AND conname = 'flow_trigger_replay_binding_complete'
  ) THEN
    ALTER TABLE flow_trigger_outbox
      ADD CONSTRAINT flow_trigger_replay_binding_complete CHECK (
        (replay_of_run_id IS NULL AND replay_automation_id IS NULL AND replay_flow_id IS NULL AND replay_flow_version IS NULL)
        OR
        (replay_of_run_id IS NOT NULL AND replay_automation_id IS NOT NULL AND replay_flow_id IS NOT NULL AND replay_flow_version > 0)
      );
  END IF;
END $$;
-- One explicit retry per failed run. If that retry fails, replay its failed
-- child run instead; this preserves a simple, auditable attempt chain. This
-- follows the ALTERs so an existing deployment gains the column before index.
CREATE UNIQUE INDEX IF NOT EXISTS flow_trigger_replay_once
  ON flow_trigger_outbox (replay_of_run_id) WHERE replay_of_run_id IS NOT NULL;
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS claim_token BIGINT NOT NULL DEFAULT 0;
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS bindings_prepared BOOLEAN NOT NULL DEFAULT false;
-- cron 触发与 event 触发的绑定方式不同：event 按 trigger_spec 扇出到所有订阅者，
-- cron 只投给游标对应的那一个自动化。用 source 把两条路径分开，否则两个自动化写了
-- 同一个 cron 表达式时，一次定时触发会被两个流程各跑一遍。
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'event';
ALTER TABLE flow_trigger_outbox ADD COLUMN IF NOT EXISTS cron_automation_id TEXT;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flow_trigger_outbox'::regclass AND conname = 'flow_trigger_source_known'
  ) THEN
    ALTER TABLE flow_trigger_outbox
      ADD CONSTRAINT flow_trigger_source_known CHECK (source IN ('event','cron'));
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'flow_trigger_outbox'::regclass AND conname = 'flow_trigger_cron_target'
  ) THEN
    ALTER TABLE flow_trigger_outbox
      ADD CONSTRAINT flow_trigger_cron_target CHECK (
        (source = 'event' AND cron_automation_id IS NULL)
        OR
        (source = 'cron' AND cron_automation_id IS NOT NULL)
      );
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS flow_trigger_bindings (
  trigger_id BIGINT NOT NULL REFERENCES flow_trigger_outbox(id) ON DELETE CASCADE,
  automation_id TEXT NOT NULL,
  flow_id TEXT NOT NULL,
  flow_version INT NOT NULL CHECK (flow_version > 0),
  PRIMARY KEY (trigger_id, automation_id)
);

-- cron 调度游标。cron 表达式由 flows 服务用 Go 解析（SQL 不会算 cron），解析结果与
-- 推进状态落在这里。last_error 非空表示游标已停滞（表达式非法、或表达式永远不会
-- 触发）：停滞的游标不进调度，只有 spec 变更或先禁用再启用才会恢复，改好的表达式
-- 由协调阶段重置游标。
CREATE TABLE IF NOT EXISTS flow_cron_cursors (
  automation_id TEXT PRIMARY KEY,
  realm         TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  spec          TEXT NOT NULL,
  last_fired_at TIMESTAMPTZ NOT NULL,
  next_fire_at  TIMESTAMPTZ NOT NULL,
  last_error    TEXT NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_flow_cron_due
  ON flow_cron_cursors (next_fire_at) WHERE last_error = '';

-- 流程血缘 outbox（缺口 C7）。发布版本快照时把 DAG 边落进来（与发布同一事务），
-- 后台投影器异步搬运到 Nebula（图只是呈现层，见 architecture.md §9.2 / A5）。
-- 未配置 Nebula 时整体不写此表、不起投影器（绝不伪造成功）。
-- 唯一约束 (flow_id,version,from_node,to_node,edge_type) 在 PG 层保证幂等：
-- 同一版本重复发布（极端竞态）不会产生重复边，不只靠客户端自觉。
CREATE TABLE IF NOT EXISTS flow_lineage_outbox (
  id              BIGSERIAL PRIMARY KEY,
  flow_id         TEXT NOT NULL,
  version         INT NOT NULL,
  realm           TEXT NOT NULL DEFAULT '',
  from_node       TEXT NOT NULL,
  to_node         TEXT NOT NULL,
  edge_type       TEXT NOT NULL,
  from_operator   TEXT NOT NULL DEFAULT '',
  to_operator     TEXT NOT NULL DEFAULT '',
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT NOT NULL DEFAULT '',
  claimed_at      TIMESTAMPTZ,
  projected_at    TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (flow_id, version, from_node, to_node, edge_type)
);
-- 部分索引：只扫未投影的尾巴，已投影历史不拖慢轮询（与 knowledge_graph_outbox 同思路）。
CREATE INDEX IF NOT EXISTS idx_flow_lineage_pending
  ON flow_lineage_outbox (id) WHERE projected_at IS NULL;
`

var (
	ErrNotFound         = errors.New("流程不存在（或不可见）")
	ErrNameTaken        = errors.New("同名流程已存在于本项目")
	ErrNotAuthor        = errors.New("仅作者可操作草稿")
	ErrOnlyDraft        = errors.New("仅 draft 态可改定义")
	ErrSelfReview       = errors.New("作者不可自审（职责分离）")
	ErrNotReviewer      = errors.New("审核须 manager/admin 角色")
	ErrVersionGone      = errors.New("回滚目标版本不存在")
	ErrRunNotReplayable = errors.New("仅失败的运行可以重放")
	ErrRunInProgress    = errors.New("flow attempt is still running")
	ErrRunFinalized     = errors.New("flow attempt is already final or expired")
	ErrClaimLost        = errors.New("flow trigger claim was lost")
)

type Store struct {
	pool *pgxpool.Pool
	// lineageEnabled 由启动器按 LUMO_FLOW_NEBULA_URL 是否配置设置；运行期不变。
	// 见 SetLineageEnabled / internal/lineage 包注释（未配置时整体关闭血缘捕获）。
	lineageEnabled bool
}

type TriggerRecord struct {
	ID                 uint64          `json:"id"`
	ClaimToken         int64           `json:"-"`
	Realm              string          `json:"realm"`
	Name               string          `json:"name"`
	Payload            json.RawMessage `json:"payload"`
	ReplayAutomationID string          `json:"replay_automation_id,omitempty"`
	ReplayFlowID       string          `json:"replay_flow_id,omitempty"`
	ReplayFlowVersion  int             `json:"replay_flow_version,omitempty"`
	ReplayOfRunID      int64           `json:"replay_of_run_id,omitempty"`
}

func (r TriggerRecord) IsReplay() bool { return r.ReplayOfRunID > 0 }

type EventBinding struct {
	AutomationID string
	FlowID       string
	FlowVersion  int
}

type TriggerRun struct {
	ID              int64      `json:"id"`
	TriggerID       uint64     `json:"trigger_id"`
	AutomationID    string     `json:"automation_id"`
	FlowID          string     `json:"flow_id"`
	FlowVersion     int        `json:"flow_version"`
	Status          string     `json:"status"`
	OutputAvailable bool       `json:"output_available"`
	Error           string     `json:"error,omitempty"`
	ReplayOfRunID   *int64     `json:"replay_of_run_id,omitempty"`
	StartedAt       time.Time  `json:"started_at"`
	FinishedAt      *time.Time `json:"finished_at,omitempty"`
}

type ReplayEnqueue struct {
	TriggerID     uint64 `json:"trigger_id"`
	AlreadyQueued bool   `json:"already_queued"`
}

func New(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

func (s *Store) Init(ctx context.Context) error {
	if _, err := s.pool.Exec(ctx, DDL); err != nil {
		return fmt.Errorf("建 flows 表失败: %w", err)
	}
	if _, err := s.pool.Exec(ctx, managementDDL); err != nil {
		return fmt.Errorf("initialize flow change drafts: %w", err)
	}
	return nil
}

func (s *Store) EnqueueTrigger(ctx context.Context, realm, name string, payload json.RawMessage) error {
	if realm == "" || name == "" || name == "*" || len(payload) == 0 || !json.Valid(payload) {
		return fmt.Errorf("非法 trigger：realm/name/payload 必填且 payload 必须是 JSON")
	}
	_, err := s.pool.Exec(ctx, `
		INSERT INTO flow_trigger_outbox (realm, event_name, payload) VALUES ($1,$2,$3)`, realm, name, payload)
	return err
}

// ClaimTriggers 使用 SKIP LOCKED 支持多个 worker 并行搬运；未 ack 的 claim 可回收。
func (s *Store) ClaimTriggers(ctx context.Context, worker string, limit int) ([]TriggerRecord, error) {
	if limit <= 0 {
		limit = 100
	}
	rows, err := s.pool.Query(ctx, `
		WITH picked AS (
			SELECT id FROM flow_trigger_outbox
			WHERE delivered_at IS NULL AND claimed_by IS NULL
			ORDER BY id LIMIT $2 FOR UPDATE SKIP LOCKED
		), claimed AS (
			UPDATE flow_trigger_outbox o SET claimed_by = $1, claim_token = o.claim_token + 1,
				claimed_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
			FROM picked WHERE o.id = picked.id
			RETURNING o.id, o.claim_token, o.realm, o.event_name, o.payload,
			COALESCE(o.replay_automation_id, ''), COALESCE(o.replay_flow_id, ''),
			COALESCE(o.replay_flow_version, 0), COALESCE(o.replay_of_run_id, 0)
	)
		SELECT id, claim_token, realm, event_name, payload, replay_automation_id, replay_flow_id,
		replay_flow_version, replay_of_run_id FROM claimed ORDER BY id`, worker, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TriggerRecord{}
	for rows.Next() {
		var record TriggerRecord
		if err := rows.Scan(&record.ID, &record.ClaimToken, &record.Realm, &record.Name, &record.Payload,
			&record.ReplayAutomationID, &record.ReplayFlowID, &record.ReplayFlowVersion, &record.ReplayOfRunID); err != nil {
			return nil, err
		}
		out = append(out, record)
	}
	return out, rows.Err()
}

// EnqueueReplay creates one new durable trigger from a failed run. It copies
// the original event bytes and the binding/version captured by that run, so a
// later automation edit, disable, rollback, or rebinding cannot change what a
// replay executes. Repeating the request is idempotent and returns its already
// queued trigger; a later retry must target the new failed run instead.
func (s *Store) EnqueueReplay(ctx context.Context, flowID, realm string, runID int64) (ReplayEnqueue, error) {
	if flowID == "" || realm == "" || runID < 1 {
		return ReplayEnqueue{}, ErrNotFound
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return ReplayEnqueue{}, err
	}
	defer func() { _ = tx.Rollback(ctx) }()

	var (
		status, eventName, automationID, pinnedFlowID string
		payload                                       json.RawMessage
		version                                       int
	)
	err = tx.QueryRow(ctx, `
		SELECT r.status, t.event_name, t.payload, r.automation_id, r.flow_id, r.flow_version
		FROM flow_runs r
		JOIN flow_trigger_outbox t ON t.id = r.trigger_id
		WHERE r.id = $1 AND r.flow_id = $2 AND t.realm = $3
		FOR UPDATE OF r, t`, runID, flowID, realm).Scan(
		&status, &eventName, &payload, &automationID, &pinnedFlowID, &version,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return ReplayEnqueue{}, ErrNotFound
	}
	if err != nil {
		return ReplayEnqueue{}, err
	}
	if status != "failed" {
		return ReplayEnqueue{}, ErrRunNotReplayable
	}

	var queued ReplayEnqueue
	err = tx.QueryRow(ctx, `
		INSERT INTO flow_trigger_outbox
		  (realm, event_name, payload, replay_automation_id, replay_flow_id, replay_flow_version, replay_of_run_id)
		VALUES ($1,$2,$3,$4,$5,$6,$7)
		ON CONFLICT (replay_of_run_id) WHERE replay_of_run_id IS NOT NULL DO NOTHING
		RETURNING id`, realm, eventName, payload, automationID, pinnedFlowID, version, runID).Scan(&queued.TriggerID)
	if errors.Is(err, pgx.ErrNoRows) {
		if err := tx.QueryRow(ctx,
			`SELECT id FROM flow_trigger_outbox WHERE replay_of_run_id = $1`, runID).Scan(&queued.TriggerID); err != nil {
			return ReplayEnqueue{}, err
		}
		queued.AlreadyQueued = true
	} else if err != nil {
		return ReplayEnqueue{}, err
	}
	if err := tx.Commit(ctx); err != nil {
		return ReplayEnqueue{}, err
	}
	return queued, nil
}

func (s *Store) AckTrigger(ctx context.Context, id uint64, token int64) error {
	tag, err := s.pool.Exec(ctx, `UPDATE flow_trigger_outbox
	  SET delivered_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint, claimed_by = NULL
	  WHERE id = $1 AND claim_token = $2 AND claimed_by IS NOT NULL AND delivered_at IS NULL`, id, token)
	if err == nil && tag.RowsAffected() != 1 {
		return ErrClaimLost
	}
	return err
}

func (s *Store) RenewTrigger(ctx context.Context, id uint64, token int64) error {
	tag, err := s.pool.Exec(ctx, `UPDATE flow_trigger_outbox
	  SET claimed_at = (EXTRACT(EPOCH FROM now()) * 1000)::bigint
	  WHERE id = $1 AND claim_token = $2 AND claimed_by IS NOT NULL AND delivered_at IS NULL`, id, token)
	if err == nil && tag.RowsAffected() != 1 {
		return ErrClaimLost
	}
	return err
}

func (s *Store) RequeueStaleTriggers(ctx context.Context, olderThanMs int64) error {
	if olderThanMs < 1000 {
		olderThanMs = 1000
	}
	_, err := s.pool.Exec(ctx, `UPDATE flow_trigger_outbox SET claimed_by = NULL, claimed_at = NULL WHERE delivered_at IS NULL AND claimed_by IS NOT NULL AND claimed_at < (EXTRACT(EPOCH FROM now()) * 1000)::bigint - $1`, olderThanMs)
	return err
}

// ListEventBindings 读取项目自动化的事件绑定。只允许已发布快照进入运行面。
//
// webhook 与 event 共用持久入口并按 trigger_spec 扇出；cron 不在这里——它由本服务的
// 调度生产者按 automation_id 投给唯一一个自动化（见 internal/schedule）。
// 注意：当前没有任何调用方，绑定真相在 PrepareTriggerBindings（execution.go）。
func (s *Store) ListEventBindings(ctx context.Context, realm, name string) ([]EventBinding, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT a.automation_id, a.flow_ref, f.version
		FROM project_automations a
			JOIN flows f ON f.id = a.flow_ref AND f.project_id = a.project_id
			JOIN projects p ON p.id = a.project_id AND p.realm = f.realm AND p.status = 'active'
		WHERE f.realm = $1 AND a.trigger_kind IN ('event','webhook')
		  AND a.trigger_spec = $2 AND a.enabled
		  AND f.status IN ('published','targeted')
		ORDER BY a.automation_id`, realm, name)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	bindings := []EventBinding{}
	for rows.Next() {
		var binding EventBinding
		if err := rows.Scan(&binding.AutomationID, &binding.FlowID, &binding.FlowVersion); err != nil {
			return nil, err
		}
		bindings = append(bindings, binding)
	}
	return bindings, rows.Err()
}

// StartTriggerRun never restarts a business attempt, including interrupted ones.
// A live duplicate must remain unacknowledged until its original attempt ends.
func (s *Store) StartTriggerRun(ctx context.Context, triggerID uint64, automationID, flowID string, version int) (bool, error) {
	if triggerID == 0 || automationID == "" || flowID == "" || version < 1 {
		return false, fmt.Errorf("非法 flow run 标识")
	}
	tag, err := s.pool.Exec(ctx, `
		INSERT INTO flow_runs (trigger_id, automation_id, flow_id, flow_version, status, claimed_at)
		VALUES ($1,$2,$3,$4,'running',(EXTRACT(EPOCH FROM now()) * 1000)::bigint)
		ON CONFLICT (trigger_id, automation_id) DO NOTHING`, triggerID, automationID, flowID, version)
	if err != nil {
		return false, err
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	_, err = s.pool.Exec(ctx, `UPDATE flow_runs
	  SET status = 'failed', error = 'execution interrupted; explicit replay required', finished_at = now()
	  WHERE trigger_id = $1 AND automation_id = $2 AND status = 'running'
	    AND COALESCE(claimed_at, (EXTRACT(EPOCH FROM started_at) * 1000)::bigint)
	      <= (EXTRACT(EPOCH FROM now()) * 1000)::bigint - $3`, triggerID, automationID, RunExpiry.Milliseconds())
	if err != nil {
		return false, err
	}
	var status string
	if err := s.pool.QueryRow(ctx, `SELECT status FROM flow_runs WHERE trigger_id = $1 AND automation_id = $2`,
		triggerID, automationID).Scan(&status); err != nil {
		return false, err
	}
	if status == "running" {
		return false, ErrRunInProgress
	}
	return false, nil
}

func (s *Store) FinishTriggerRun(ctx context.Context, triggerID uint64, automationID, status string, output json.RawMessage, runErr error) error {
	if status != "succeeded" && status != "failed" {
		return fmt.Errorf("非法 flow run 终态 %q", status)
	}
	var errText *string
	if runErr != nil {
		value := runErr.Error()
		errText = &value
	}
	tag, err := s.pool.Exec(ctx, `
		UPDATE flow_runs SET status = $3, output = $4, error = $5, finished_at = now()
		WHERE trigger_id = $1 AND automation_id = $2 AND status = 'running'
		  AND claimed_at > (EXTRACT(EPOCH FROM now()) * 1000)::bigint - $6`,
		triggerID, automationID, status, output, errText, RunExpiry.Milliseconds())
	if err == nil && tag.RowsAffected() != 1 {
		return ErrRunFinalized
	}
	return err
}

// ListTriggerRuns exposes the durable event/webhook execution ledger without
// returning output payloads. Outputs can contain source-system data, so the
// management view gets only their existence plus bounded operational metadata.
func (s *Store) ListTriggerRuns(ctx context.Context, flowID string, limit int) ([]TriggerRun, error) {
	if flowID == "" {
		return nil, ErrNotFound
	}
	if limit < 1 || limit > 100 {
		limit = 50
	}
	rows, err := s.pool.Query(ctx, `
		SELECT r.id, r.trigger_id, r.automation_id, r.flow_id, r.flow_version, r.status,
		       r.output IS NOT NULL, COALESCE(left(r.error, 512), ''), o.replay_of_run_id,
		       r.started_at, r.finished_at
		FROM flow_runs r
		JOIN flow_trigger_outbox o ON o.id = r.trigger_id
		WHERE r.flow_id=$1
		ORDER BY r.started_at DESC, r.id DESC LIMIT $2`, flowID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []TriggerRun{}
	for rows.Next() {
		var run TriggerRun
		if err := rows.Scan(&run.ID, &run.TriggerID, &run.AutomationID, &run.FlowID, &run.FlowVersion,
			&run.Status, &run.OutputAvailable, &run.Error, &run.ReplayOfRunID, &run.StartedAt, &run.FinishedAt); err != nil {
			return nil, err
		}
		out = append(out, run)
	}
	return out, rows.Err()
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

// Definition 取执行所需的当前发布快照，草稿定义不得直接执行。
func (s *Store) Definition(ctx context.Context, id, realm string) (json.RawMessage, error) {
	definition, _, err := s.DefinitionSnapshot(ctx, id, realm)
	return definition, err
}

func (s *Store) DefinitionSnapshot(ctx context.Context, id, realm string) (json.RawMessage, int, error) {
	var def json.RawMessage
	var version int
	err := s.pool.QueryRow(ctx, `
		SELECT CASE WHEN f.version > 0 THEN v.definition ELSE NULL END, f.version
		FROM flows f LEFT JOIN flow_versions v ON v.flow_id = f.id AND v.version = f.version
		WHERE f.id = $1 AND f.realm = $2 AND f.status IN ('published','targeted')`, id, realm).Scan(&def, &version)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, 0, ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	if len(def) == 0 {
		return nil, 0, ErrNotFound
	}
	return def, version, nil
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
	var realm string
	var def json.RawMessage
	err = tx.QueryRow(ctx, `SELECT status, definition, realm FROM flows WHERE id = $1 FOR UPDATE`, id).Scan(&status, &def, &realm)
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
		// 把已发布的规范化定义解析成 domain.Definition 供血缘抽取；解析失败只记日志不阻断发布
		// （def 来自刚写入 flow_versions 的同一字节，理论上必然可解析）。
		var d domain.Definition
		if err := json.Unmarshal(def, &d); err != nil {
			slog.Warn("血缘定义反序列化失败，跳过", "flow_id", id, "version", version, "err", err)
		}
		// 血缘写入点：与发布快照同一事务。def 已通过入库校验（防环等），Extract 通常
		// 不会失败；这里仅把「编译后 DAG」的血缘边落成 outbox 行，Nebula 投影由后台异步完成，
		// 所以 Nebula 不可用不会让发布变慢或失败。Extract 万一失败（理论不可达）只记日志、
		// 不阻断发布——血缘缺失比发布失败可接受。
		if s.lineageEnabled {
			if edges, eerr := lineage.Extract(&d, id, version, realm); eerr == nil {
				if werr := s.writeLineageWithinTx(ctx, tx, edges); werr != nil {
					return nil, fmt.Errorf("写血缘 outbox 失败: %w", werr)
				}
			} else {
				slog.Warn("血缘抽取失败，跳过（发布仍继续）", "flow_id", id, "version", version, "err", eerr)
			}
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

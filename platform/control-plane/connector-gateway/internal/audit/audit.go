// Package audit 外部调用审计（§10.1「所有外部调用记 session 事件供审计」）。
//
// 两个落点，职责不同：
//   - PG `connector_audit`：**权威、不可绕过**。放行与拒绝都写，拒绝尤其要写 ——
//     只记成功调用的审计等于没有审计。
//   - SessionEvent：给模型与前端看的时间线。跨进程（网关是 Go，session 在 dsh 内），
//     因此走 outbox 投影，与知识库→图的做法同源（见 knowledge/graph-projector.ts）。
package audit

import (
	"context"
	"encoding/json"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

const DDL = `
CREATE TABLE IF NOT EXISTS connector_audit (
  id             BIGSERIAL PRIMARY KEY,
  correlation_id TEXT,
  realm          TEXT NOT NULL,
  project_id     TEXT,
  session_id     TEXT,
  user_id        TEXT NOT NULL,
  connector_id   TEXT NOT NULL,
  operation      TEXT NOT NULL,
  method         TEXT NOT NULL,
  target_host    TEXT NOT NULL,
  decision       TEXT NOT NULL,          -- allowed | denied
  deny_reason    TEXT,
  status         INTEGER,
  duration_ms    BIGINT,
  request_bytes  BIGINT,
  response_bytes BIGINT,
  redactions     JSONB NOT NULL DEFAULT '{}'::jsonb,
  breaker_state  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_connector_audit_session ON connector_audit (session_id, id);
CREATE INDEX IF NOT EXISTS idx_connector_audit_realm_time ON connector_audit (realm, created_at DESC);
-- 投影到 SessionEvent 的待办尾巴
CREATE INDEX IF NOT EXISTS idx_connector_audit_pending
  ON connector_audit (id) WHERE projected_at IS NULL AND session_id IS NOT NULL;
`

// Decision 审计里的放行/拒绝二值。
type Decision string

const (
	Allowed Decision = "allowed"
	Denied  Decision = "denied"
)

// Record 一条审计。不含请求体与响应体：审计要能长期留存，
// 留存明文载荷会把审计表变成又一份 PII 副本（§15 数据最小化）。
type Record struct {
	CorrelationID string
	Realm         string
	ProjectID     string
	SessionID     string
	UserID        string
	ConnectorID   string
	Operation     string
	Method        string
	TargetHost    string
	Decision      Decision
	DenyReason    string
	Status        int
	Duration      time.Duration
	RequestBytes  int64
	ResponseBytes int64
	Redactions    map[string]int
	BreakerState  string
}

// Sink 审计落点。
type Sink interface {
	Write(ctx context.Context, r Record) error
}

// PgSink PG 实现。
type PgSink struct{ pool *pgxpool.Pool }

func NewPg(pool *pgxpool.Pool) *PgSink { return &PgSink{pool: pool} }

func (s *PgSink) Init(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, DDL)
	return err
}

func (s *PgSink) Write(ctx context.Context, r Record) error {
	redactions, err := json.Marshal(orEmpty(r.Redactions))
	if err != nil {
		return err
	}
	_, err = s.pool.Exec(ctx,
		`INSERT INTO connector_audit
		   (correlation_id, realm, project_id, session_id, user_id, connector_id, operation,
		    method, target_host, decision, deny_reason, status, duration_ms,
		    request_bytes, response_bytes, redactions, breaker_state)
		 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
		nullable(r.CorrelationID), r.Realm, nullable(r.ProjectID), nullable(r.SessionID),
		r.UserID, r.ConnectorID, r.Operation, r.Method, r.TargetHost,
		string(r.Decision), nullable(r.DenyReason), r.Status, r.Duration.Milliseconds(),
		r.RequestBytes, r.ResponseBytes, redactions, nullable(r.BreakerState))
	return err
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

func orEmpty(m map[string]int) map[string]int {
	if m == nil {
		return map[string]int{}
	}
	return m
}

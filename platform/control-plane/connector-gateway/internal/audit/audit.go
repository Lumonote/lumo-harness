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

// MeterEvent 计量事件（connector.call 出向）。JSON 字段形状与
// shared/seam-contracts/cost-events.ts 的 CostEvent 逐字段同构 —— 消费侧
// assertCostEvent 会拒缺字段（context 八维全必填、traceId/emitter 必填）。
//
// 计量口径（已裁定）：
//   - 只有拿到上游响应（含 4xx）才计一次：qty=1、unit=call、costUsd=0
//     （本网关无费率表 —— 费率/汇率/折扣属计费系统）；
//   - 传输错误/超时（响应缺失）不计（审计照记）；
//   - denied 一律不计（审计已记）。
type MeterEvent struct {
	CostType string            `json:"costType"`
	Qty      float64           `json:"qty"`
	Unit     string            `json:"unit"`
	TraceID  string            `json:"traceId"`
	Emitter  string            `json:"emitter"`
	CostUSD  float64           `json:"costUsd"`
	Context  map[string]string `json:"context"`
}

// Sink 审计落点（审计与计量同事务）。
type Sink interface {
	// Write 落一条审计；meter 非 nil 时与计量事件在**同一 PG 事务**内双 INSERT
	// （connector_audit + usage_event_outbox）。meter 为 nil 时只写 connector_audit
	// —— 现有只审不量的调用路径不变。
	Write(ctx context.Context, r Record, meter *MeterEvent) error
}

// PgSink PG 实现。
type PgSink struct{ pool *pgxpool.Pool }

func NewPg(pool *pgxpool.Pool) *PgSink { return &PgSink{pool: pool} }

func (s *PgSink) Init(ctx context.Context) error {
	_, err := s.pool.Exec(ctx, DDL)
	return err
}

// usage_event_outbox 的 DDL 真相源在 TS pg-meter（与 llm-gateway store 同规）——
// 本服务不建表不迁表。表缺失时计量 INSERT 报 42P01，与审计同事务失败并响亮告警：
// metering 未初始化属于启动配置错误，绝不能静默变成「只审不量」。
func (s *PgSink) Write(ctx context.Context, r Record, meter *MeterEvent) error {
	redactions, err := json.Marshal(orEmpty(r.Redactions))
	if err != nil {
		return err
	}
	insert := `INSERT INTO connector_audit
	   (correlation_id, realm, project_id, session_id, user_id, connector_id, operation,
	    method, target_host, decision, deny_reason, status, duration_ms,
	    request_bytes, response_bytes, redactions, breaker_state)
	 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`
	args := []any{
		nullable(r.CorrelationID), r.Realm, nullable(r.ProjectID), nullable(r.SessionID),
		r.UserID, r.ConnectorID, r.Operation, r.Method, r.TargetHost,
		string(r.Decision), nullable(r.DenyReason), r.Status, r.Duration.Milliseconds(),
		r.RequestBytes, r.ResponseBytes, redactions, nullable(r.BreakerState),
	}
	if meter == nil {
		_, err = s.pool.Exec(ctx, insert, args...)
		return err
	}
	tx, err := s.pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback(ctx) }()
	if _, err := tx.Exec(ctx, insert, args...); err != nil {
		return err
	}
	payload, err := json.Marshal(meter)
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`INSERT INTO usage_event_outbox (event_key, payload) VALUES (gen_random_uuid(), $1)`,
		payload); err != nil {
		return err
	}
	return tx.Commit(ctx)
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

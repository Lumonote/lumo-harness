package audit

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// 审计读取面。
//
// 为什么读与写要分成两个类型：写（PgSink）是**权威且不可绕过**的 —— 放行与拒绝
// 都写，失败必须响亮；读（Reader）带 realm 与角色过滤，失败只影响排查。
// 两者的失败语义与调用方都不同，共用一个类型会诱使「读失败也当写失败处理」。
//
// 表结构早已为读准备好（`idx_connector_audit_session` 服务「某 session 的调用时间线」、
// `idx_connector_audit_realm_time` 服务「某 realm 的最近调用」），但此前**没有任何
// 查询出口** —— 要回答「这个 session 到底对外调了什么」只能上生产 psql。
// 合规审计表的读取面缺失，等于审计只对写者可见。

const (
	// DefaultQueryLimit 缺省页大小。
	DefaultQueryLimit = 50
	// MaxQueryLimit 单页上限。审计是只增表，不设上限的查询会退化成全表扫描。
	MaxQueryLimit = 200
)

// Entry 一条审计的读取视图。
//
// 刻意**不含** `projected_at`：那是投影进度簿记，不是审计内容。而且它**没有写入方** ——
// 往 SessionEvent 投影那条路已撤销（按构造走不通，理由见 audit.go 包注释），
// 此时暴露它只会让读的人以为时间线已经存在。会话维度的时间线请用 `sessionId` 过滤，
// 那是这条读取面本来就支持的（`idx_connector_audit_session`）。
//
// 也不含请求体与响应体 —— 表里本来就没存（§15 数据最小化，见 Record 注释），
// 所以这里没有「要不要脱敏」的决策：脱敏计数（Redactions）是计数，不是内容。
type Entry struct {
	ID            int64          `json:"id"`
	CorrelationID string         `json:"correlationId,omitempty"`
	Realm         string         `json:"realm"`
	ProjectID     string         `json:"projectId,omitempty"`
	SessionID     string         `json:"sessionId,omitempty"`
	UserID        string         `json:"userId"`
	ConnectorID   string         `json:"connectorId"`
	Operation     string         `json:"operation"`
	Method        string         `json:"method"`
	TargetHost    string         `json:"targetHost"`
	Decision      Decision       `json:"decision"`
	DenyReason    string         `json:"denyReason,omitempty"`
	Status        int            `json:"status"`
	DurationMS    int64          `json:"durationMs"`
	RequestBytes  int64          `json:"requestBytes"`
	ResponseBytes int64          `json:"responseBytes"`
	Redactions    map[string]int `json:"redactions"`
	BreakerState  string         `json:"breakerState,omitempty"`
	CreatedAt     time.Time      `json:"createdAt"`
}

// QueryFilter 审计查询条件。
//
// Realm 必填且**只来自已认证身份**：realm 决定能看见哪些调用，自报即越权
// （与包注释的同一约定）。UserID 为空表示「该 realm 全部用户」，
// 只有管理员可以置空 —— 这个判断在 handler，不在 SQL：SQL 不该猜调用者的角色。
type QueryFilter struct {
	Realm       string
	UserID      string
	SessionID   string
	ConnectorID string
	Decision    Decision // "" = 放行与拒绝都要
	BeforeID    int64    // keyset 游标：只取 id < BeforeID；0 = 从最新开始
	Limit       int
}

// Page 一页审计。NextBeforeID 为 0 表示已到末页。
type Page struct {
	Entries      []Entry `json:"entries"`
	NextBeforeID int64   `json:"nextBeforeId"`
}

// NormalizeLimit 把请求的页大小收敛到 [1, MaxQueryLimit]；非正取缺省。
//
// 单独抽成纯函数是为了能在无数据库的情况下断言收敛规则 —— 上限一旦失效，
// 审计查询就会退化成对只增表的一次全表扫描。
func NormalizeLimit(limit int) int {
	if limit <= 0 {
		return DefaultQueryLimit
	}
	if limit > MaxQueryLimit {
		return MaxQueryLimit
	}
	return limit
}

// ParseDecision 解析 decision 过滤值；空串表示不过滤。
//
// 未知取值必须**报错而不是退化为不过滤**：`decision=denyed` 这种拼写错误如果被
// 静默忽略，一次「只看被拒绝的调用」的合规查询会返回全部调用 —— 结果集被悄悄放大，
// 比报错危险得多。审计面的过滤值一律 fail-closed。
func ParseDecision(raw string) (Decision, error) {
	switch Decision(raw) {
	case "":
		return "", nil
	case Allowed:
		return Allowed, nil
	case Denied:
		return Denied, nil
	default:
		return "", fmt.Errorf("connector audit: 未知 decision %q", raw)
	}
}

// Reader 审计读取面。
type Reader struct{ pool *pgxpool.Pool }

func NewReader(pool *pgxpool.Pool) *Reader { return &Reader{pool: pool} }

// querySQL 按 id 倒序（= 插入序）返回。
//
// 排序键与游标键**必须是同一列**：`created_at` 取的是事务开始时刻（PG 的 now()），
// 而 id 取的是 INSERT 时刻，两者在并发下会不一致（先开始的事务可能后插入），
// 用 created_at 排序 + id 游标会漏行或重行。id 是严格全序，用它排序与翻页
// 才既精确又只走一次索引。
//
// 参数一律显式加类型转换：省略时会以无类型 NULL/未知类型下发，PG 可能推不出类型
// （与 llm-gateway provider 写入口径同一坑）。
const querySQL = `
SELECT id, COALESCE(correlation_id,''), realm, COALESCE(project_id,''), COALESCE(session_id,''),
       user_id, connector_id, operation, method, target_host, decision,
       COALESCE(deny_reason,''), COALESCE(status,0), COALESCE(duration_ms,0),
       COALESCE(request_bytes,0), COALESCE(response_bytes,0), redactions,
       COALESCE(breaker_state,''), created_at
FROM connector_audit
WHERE realm = $1::text
  AND ($2::text = '' OR user_id = $2::text)
  AND ($3::text = '' OR session_id = $3::text)
  AND ($4::text = '' OR connector_id = $4::text)
  AND ($5::text = '' OR decision = $5::text)
  AND ($6::bigint = 0 OR id < $6::bigint)
ORDER BY id DESC
LIMIT $7::int`

// Query 读取一页审计。
func (r *Reader) Query(ctx context.Context, f QueryFilter) (Page, error) {
	if f.Realm == "" {
		// 不是「查全部 realm」—— 没有 realm 的调用者不该看到任何审计。
		return Page{Entries: []Entry{}}, fmt.Errorf("connector audit: 查询缺少 realm")
	}
	limit := NormalizeLimit(f.Limit)
	rows, err := r.pool.Query(ctx, querySQL,
		f.Realm, f.UserID, f.SessionID, f.ConnectorID, string(f.Decision), f.BeforeID, limit)
	if err != nil {
		return Page{Entries: []Entry{}}, fmt.Errorf("connector audit: 查询失败: %w", err)
	}
	defer rows.Close()

	// 非 nil 空切片：nil 会编码成 JSON null，客户端 .map 直接抛。
	entries := make([]Entry, 0, limit)
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.CorrelationID, &e.Realm, &e.ProjectID, &e.SessionID,
			&e.UserID, &e.ConnectorID, &e.Operation, &e.Method, &e.TargetHost, &e.Decision,
			&e.DenyReason, &e.Status, &e.DurationMS, &e.RequestBytes, &e.ResponseBytes,
			&e.Redactions, &e.BreakerState, &e.CreatedAt); err != nil {
			return Page{Entries: []Entry{}}, fmt.Errorf("connector audit: 扫描失败: %w", err)
		}
		entries = append(entries, e)
	}
	if err := rows.Err(); err != nil {
		return Page{Entries: []Entry{}}, fmt.Errorf("connector audit: 读取失败: %w", err)
	}

	page := Page{Entries: entries}
	// 恰好取满一页时可能还有下一页；多一次空查询换「不重不漏」是划算的。
	// 严格小于游标保证边界行不会在两页里各出现一次。
	if len(entries) == limit {
		page.NextBeforeID = entries[len(entries)-1].ID
	}
	return page, nil
}

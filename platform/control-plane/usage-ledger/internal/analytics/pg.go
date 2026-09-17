package analytics

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5/pgxpool"
)

// PgSource 在 PG 台账上做日粒度分组聚合。
//
// 这是**唯一**的查询源：台账是 append-only 的权威表，日聚合直接在上面分组即可。
// 慢的原因很直接——无分区、全区间扫；在规模到达之前，这比维护一条派生链路便宜。
type PgSource struct{ pool *pgxpool.Pool }

func NewPgSource(pool *pgxpool.Pool) *PgSource { return &PgSource{pool: pool} }

// Aggregate 按天分组聚合台账。
//
// 日界用 `timezone($1, ts)` 显式指定，$1 来自 ReportingLocation —— 与 Go 侧的
// DayBounds 同源。**不要图省事写 `ts::date`**：那用数据库会话时区，会让同一份数据在
// 不同部署上分到不同的天，而且那种错在单机开发时永远看不到。
func (s *PgSource) Aggregate(ctx context.Context, fromDay, toDay, projectID string) ([]Row, error) {
	from, _, err := DayBounds(fromDay)
	if err != nil {
		return nil, err
	}
	// 上界取 toDay 的次日零点，构成 [from, toEnd) 半开区间：半开区间不会因为
	// 「ts 恰好等于上界」而把跨日边界的行算进来或漏掉。
	_, toEnd, err := DayBounds(toDay)
	if err != nil {
		return nil, err
	}

	sql := `SELECT to_char(timezone($1::text, ts), 'YYYY-MM-DD') AS day,
	       user_id, project_id, cost_type,
	       COALESCE(SUM(qty), 0)::float8      AS qty,
	       COALESCE(SUM(cost_usd), 0)::float8 AS cost_usd,
	       COALESCE(SUM(tokens), 0)::bigint   AS tokens
	  FROM usage_ledger
	 WHERE ts >= $2 AND ts < $3`
	args := []any{ReportingLocation.String(), from, toEnd}
	if projectID != "" {
		sql += ` AND project_id = $4`
		args = append(args, projectID)
	}
	// 分组与排序都用序号：ORDER BY 与 GROUP BY 必须逐字一致，否则 PG 会报
	// 「column must appear in the GROUP BY clause」——而那正是我们想要的响亮失败。
	sql += ` GROUP BY 1, 2, 3, 4 ORDER BY day, project_id, user_id, cost_type`

	rows, err := s.pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("analytics: PG 聚合失败: %w", err)
	}
	defer rows.Close()

	var out []Row
	for rows.Next() {
		var r Row
		if err := rows.Scan(&r.Day, &r.UserID, &r.ProjectID, &r.CostType, &r.Qty, &r.CostUSD, &r.Tokens); err != nil {
			return nil, fmt.Errorf("analytics: 扫描聚合结果失败: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

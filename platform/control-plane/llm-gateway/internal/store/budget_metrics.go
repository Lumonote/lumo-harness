// 预算树的监控投影（§7.4.2 的 budget_overrun）。
//
// 独立成文件是为了让「SQL 与 domain 判态是同一份语义的两种写法」这件事显眼：
// 这个镜像没有编译期护栏，护栏是 internal/server 里那条逐格对照 domain.StateOfTree
// 的用例。改这里必须同时改那边，反之亦然。
package store

import (
	"context"
	"fmt"
)

// BudgetTreeCount 一个 kind 的预算树计数。
type BudgetTreeCount struct {
	// Kind user | project（budget_trees 的判别列，没有第三档）。
	Kind string
	// Total 该 kind 的树总数。
	Total int64
	// Denied 处在 hard 档（新请求会被拒）的树数。
	Denied int64
}

// BudgetTreeCounts 预算树的红线段计数，按 kind 分组。
//
// 判态取 **need = 0**，即「不再有新请求时这棵树处在哪一档」。监控要回答的是
// 「现在有多少租户被拦在门外」，而不是「再放一个请求会怎样」——后者是请求路径
// 上 domain.StateOfTree(row, need) 的职责，两者的 need 不同，结论也就不同。
//
// 为什么在 SQL 里聚合而不是把行拉回来在 Go 里判态：budget_trees 每个用户、每个
// 项目各一行，行数随租户数增长，而这是抓取路径上每 15s 一次的查询。聚合把返回
// 行数压到「kind 的个数」，代价是 hard 条件要在这里重写一遍——那份镜像的对照
// 用例见 internal/server/budget_metrics_test.go。
//
// SQL 条件与 domain.StateOfTree(row, 0) == hard 的对应：
//
//	旧模式（budget_total IS NULL）：budget < need(=0)，即 budget < 0
//	总额模式：used = total - budget >= total + overdraft，即 budget <= -overdraft
//	非法配置：overdraft < 0 → 恒定 hard（与 domain.BudgetState 的守卫逐字对应）
//
// 两式在 budget 恰好为 0 时结论不同（总额模式算 hard、旧模式算 within），
// 所以不能合并成一句。
//
// 非法配置那一支是 2026-09-15 补的：`overdraft < 0` 在写入侧就被 `resolveLimits`
// 拒绝（canonical 会抛），所以正常途径进不了库；但只要靠「写不进来」兜，两份实现就
// 在这个角落**故意**分叉——而这份 SQL 本来就把这种行算 denied，domain 那边却因
// `used < budget` 支遮住 hard 支而判 soft。方向取 fail-closed（非法配置一律算拦住），
// 两边逐字对齐，镜像用例才不会只覆盖「配置合法」的那半边。
func (s *Store) BudgetTreeCounts(ctx context.Context) ([]BudgetTreeCount, error) {
	rows, err := s.pool.Query(ctx, `
		SELECT kind,
		       count(*)::bigint,
		       count(*) FILTER (
		         WHERE (budget_total IS NULL AND budget < 0)
		            OR (budget_total IS NOT NULL AND (
		                  COALESCE(overdraft, 0) < 0
		                  OR budget <= -COALESCE(overdraft, 0)))
		       )::bigint
		FROM budget_trees GROUP BY kind`)
	if err != nil {
		return nil, fmt.Errorf("llm-gateway: 统计预算树失败: %w", err)
	}
	defer rows.Close()
	var out []BudgetTreeCount
	for rows.Next() {
		var row BudgetTreeCount
		if err := rows.Scan(&row.Kind, &row.Total, &row.Denied); err != nil {
			return nil, fmt.Errorf("llm-gateway: 扫描预算树失败: %w", err)
		}
		out = append(out, row)
	}
	return out, rows.Err()
}

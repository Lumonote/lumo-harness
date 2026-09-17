package integration_test

// 缺口 C7 的活库断言：outbox 与发布同事务、PG 层幂等、查询面的递归与「不可用」语义。
//
// 分工：DAG→边集合的纯函数在 internal/lineage（那里不需要库）；这里只回答「落库了没有、
// 键是不是真的在 PG 层唯一、递归查询走出来对不对」。这些用 fake 是验不出来的。

import (
	"context"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/store"
)

func publishChain(t *testing.T, st *store.Store, ctx context.Context, id, realm string, operators ...string) *domain.Flow {
	t.Helper()
	f, err := st.CreateFlow(ctx, id, "p_lineage", realm, "lf-"+id, "author1", def(t, operators...))
	if err != nil {
		t.Fatalf("建流程: %v", err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatalf("提审: %v", err)
	}
	f, err = st.Review(ctx, f.ID, "rev1", true, "")
	if err != nil {
		t.Fatalf("发布: %v", err)
	}
	if f.Version != 1 {
		t.Fatalf("首次发布应产出 v1，实际 v%d", f.Version)
	}
	return f
}

func TestLineageOutboxWrittenWithPublish(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	st.SetLineageEnabled(true)

	f := publishChain(t, st, ctx, "flow_lg1", "r1", "op.a", "op.b", "op.c", "op.d")

	// 1) 同事务落地：发布成功就一定有 outbox 行，不存在「稍后补」的窗口。
	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM flow_lineage_outbox WHERE flow_id = $1 AND version = 1`, f.ID).Scan(&rows); err != nil {
		t.Fatalf("查 outbox: %v", err)
	}
	if rows != 3 {
		t.Fatalf("4 节点链应有 3 条边入 outbox，实际 %d", rows)
	}

	// 2) realm 不能是空列：发布事务里本来就查得到 realm，丢了就再也补不回来。
	var realms int
	if err := pool.QueryRow(ctx,
		`SELECT count(DISTINCT realm) FROM flow_lineage_outbox WHERE flow_id = $1 AND realm <> ''`, f.ID).Scan(&realms); err != nil {
		t.Fatalf("查 realm: %v", err)
	}
	if realms != 1 {
		t.Fatalf("边上应带上发布时的 realm，实际非空 realm 种类数 = %d", realms)
	}

	// 3) 算子名随边携带（图上的可读标签）。
	var fromOp, toOp string
	if err := pool.QueryRow(ctx, `
		SELECT from_operator, to_operator FROM flow_lineage_outbox
		WHERE flow_id = $1 AND from_node = 'n0' AND to_node = 'n1'`, f.ID).Scan(&fromOp, &toOp); err != nil {
		t.Fatalf("查算子名: %v", err)
	}
	if fromOp != "op.a" || toOp != "op.b" {
		t.Fatalf("算子名应为 op.a→op.b，实际 %s→%s", fromOp, toOp)
	}

	// 4) 未投影的边必须能被投影器看见（默认 next_attempt_at 为空即立即可取）。
	var claimable int
	if err := pool.QueryRow(ctx, `
		SELECT count(*) FROM flow_lineage_outbox
		WHERE flow_id = $1 AND projected_at IS NULL AND next_attempt_at IS NULL`, f.ID).Scan(&claimable); err != nil {
		t.Fatalf("查待投影: %v", err)
	}
	if claimable != 3 {
		t.Fatalf("新写入的边应全部可被认领，实际 %d", claimable)
	}
}

// TestLineageOutboxIdempotentAtDatabaseLevel 幂等必须由 PG 保证，而不是靠客户端自觉：
// 这里绕过所有 Go 代码，直接插一条同键行，必须被唯一约束拒绝。
//
// 同时钉住键的**形状**：同 From→To 但 edge_type 不同是两条不同的边（数据流与控制流可以
// 并存），如果约束少写了 edge_type，这一步会误判为重复而拒掉一条合法边。
func TestLineageOutboxIdempotentAtDatabaseLevel(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	st.SetLineageEnabled(true)

	f := publishChain(t, st, ctx, "flow_lg2", "r1", "op.a", "op.b")

	// 同键复制：应撞唯一约束。
	if _, err := pool.Exec(ctx, `
		INSERT INTO flow_lineage_outbox
		  (flow_id, version, realm, from_node, to_node, edge_type, from_operator, to_operator)
		SELECT flow_id, version, realm, from_node, to_node, edge_type, from_operator, to_operator
		FROM flow_lineage_outbox WHERE flow_id = $1`, f.ID); err == nil {
		t.Fatal("同键重复边必须被唯一约束拒绝（否则重复发布会产生重复边）")
	}

	// 同 From→To、不同类型：合法，应写入成功。
	if _, err := pool.Exec(ctx, `
		INSERT INTO flow_lineage_outbox
		  (flow_id, version, realm, from_node, to_node, edge_type, from_operator, to_operator)
		VALUES ($1, 1, 'r1', 'n0', 'n1', 'control', 'op.a', 'op.b')`, f.ID); err != nil {
		t.Fatalf("同端点不同类型的边应被允许（约束键含 edge_type）: %v", err)
	}
	var total int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM flow_lineage_outbox WHERE flow_id = $1`, f.ID).Scan(&total); err != nil {
		t.Fatalf("统计: %v", err)
	}
	if total != 2 {
		t.Fatalf("应为 2 条（data + control），实际 %d", total)
	}
}

// TestLineageNeighborsRecursive 查询面按 PG outbox 事实回放（不是查 Nebula）：
// 因此投影器一条都没搬时，答案也必须正确。
func TestLineageNeighborsRecursive(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	st.SetLineageEnabled(true)

	f := publishChain(t, st, ctx, "flow_lg3", "r1", "op.a", "op.b", "op.c", "op.d")

	var projected int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM flow_lineage_outbox WHERE flow_id = $1 AND projected_at IS NOT NULL`, f.ID).Scan(&projected); err != nil {
		t.Fatalf("查已投影: %v", err)
	}
	if projected != 0 {
		t.Fatalf("本用例前提是「一条都没投影」，实际 %d 条已投影", projected)
	}

	down, err := st.LineageNeighbors(ctx, f.ID, 1, "n1", "down", 0)
	if err != nil {
		t.Fatalf("查下游: %v", err)
	}
	if got := pairs(down); len(got) != 2 || got[0] != "n1>n2" || got[1] != "n2>n3" {
		t.Fatalf("n1 的下游应为 n1>n2、n2>n3，实际 %v", got)
	}

	up, err := st.LineageNeighbors(ctx, f.ID, 1, "n2", "up", 0)
	if err != nil {
		t.Fatalf("查上游: %v", err)
	}
	if got := pairs(up); len(got) != 2 || got[0] != "n0>n1" || got[1] != "n1>n2" {
		t.Fatalf("n2 的上游应为 n0>n1、n1>n2，实际 %v", got)
	}

	// 叶子：下游为空是**真结论**（不是不可用）——所以这里必须是空列表 + nil 错误。
	leaf, err := st.LineageNeighbors(ctx, f.ID, 1, "n3", "down", 0)
	if err != nil {
		t.Fatalf("叶子下游不应报错: %v", err)
	}
	if len(leaf) != 0 {
		t.Fatalf("n3 无下游，实际 %d 条", len(leaf))
	}

	// 跨版本隔离：v1 的边不能被当成 v2 的。
	other, err := st.LineageNeighbors(ctx, f.ID, 2, "n1", "down", 0)
	if err != nil {
		t.Fatalf("查 v2: %v", err)
	}
	if len(other) != 0 {
		t.Fatalf("v2 无血缘，不应看到 v1 的边，实际 %d 条", len(other))
	}

	// 非法入参逐条拒绝。
	if _, err := st.LineageNeighbors(ctx, f.ID, 1, "n1", "sideways", 0); err == nil {
		t.Fatal("非法 direction 应被拒绝")
	}
	if _, err := st.LineageNeighbors(ctx, f.ID, 1, "", "down", 0); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("空 node 应返回 ErrNotFound，实际 %v", err)
	}
	if _, err := st.LineageNeighbors(ctx, f.ID, 0, "n1", "down", 0); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("version<1 应返回 ErrNotFound，实际 %v", err)
	}
}

// TestLineageDisabledIsNotAnEmptyAnswer 「没在采集」与「没有血缘」必须可分。
// 这是 E7 的同类教训：结果集被悄悄缩小比报错危险得多。
func TestLineageDisabledIsNotAnEmptyAnswer(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	// 刻意不调用 SetLineageEnabled(true)：模拟未配置 LUMO_FLOW_NEBULA_URL。
	st.SetLineageEnabled(false)

	f := publishChain(t, st, ctx, "flow_lg4", "r1", "op.a", "op.b")

	var rows int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM flow_lineage_outbox WHERE flow_id = $1`, f.ID).Scan(&rows); err != nil {
		t.Fatalf("查 outbox: %v", err)
	}
	if rows != 0 {
		t.Fatalf("未启用血缘捕获时不该写 outbox，实际 %d 行", rows)
	}

	// 关键断言：不返回「空血缘」，而是明确的不可用。
	if _, err := st.LineageNeighbors(ctx, f.ID, 1, "n0", "down", 0); !errors.Is(err, store.ErrLineageUnavailable) {
		t.Fatalf("未启用时应返回 ErrLineageUnavailable，实际 %v", err)
	}

	// 反向：一旦启用，同一份数据立刻可查——证明上面的不可用是「开关」而非「数据缺失」。
	st.SetLineageEnabled(true)
	if _, err := st.LineageNeighbors(ctx, f.ID, 1, "n0", "down", 0); err != nil {
		t.Fatalf("启用后应可查（数据为空但语义可用）: %v", err)
	}
}

func pairs(records []store.LineageEdgeRecord) []string {
	out := make([]string, 0, len(records))
	for _, r := range records {
		out = append(out, r.FromNode+">"+r.ToNode)
	}
	return out
}

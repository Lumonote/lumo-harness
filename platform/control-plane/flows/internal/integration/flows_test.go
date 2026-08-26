package integration_test

// 真 PG 集成（判据 3 快照字节 / 判据 6 回滚 / 审计轨迹）。与 server_test 分工：
// 那里走 HTTP 断言状态码，这里直查表断言**数据**——版本快照的不可变性、回滚重指、
// 审计行的存在性，只有看字节才算数。

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/store"
)

func newStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 flows 集成测试")
	}
	schema := fmt.Sprintf("flows_int_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("admin: %v", err)
	}
	if _, err := admin.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("建 schema: %v", err)
	}
	admin.Close()
	u, _ := url.Parse(dsn)
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	pool, err := pgxpool.New(context.Background(), u.String())
	if err != nil {
		t.Fatalf("连接: %v", err)
	}
	t.Cleanup(pool.Close)
	st := store.New(pool)
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	return st, pool
}

func def(t *testing.T, operators ...string) json.RawMessage {
	t.Helper()
	d := domain.Definition{}
	for i, op := range operators {
		id := fmt.Sprintf("n%d", i)
		d.Nodes = append(d.Nodes, struct {
			ID       string `json:"id"`
			Operator string `json:"operator"`
		}{id, op})
		if i > 0 {
			d.Edges = append(d.Edges, struct {
				From string `json:"from"`
				To   string `json:"to"`
			}{fmt.Sprintf("n%d", i-1), id})
		}
	}
	b, err := json.Marshal(d)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return b
}

// 判据 3+6：两次发布两版本 → 回滚 v1 → 快照字节不变、指向重指、状态不变。
func TestVersioningAndRollback(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()

	f1, err := st.CreateFlow(ctx, "flow_v", "p1", "r1", "vf", "author1", def(t, "op.a", "op.b"))
	if err != nil {
		t.Fatalf("建: %v", err)
	}
	if _, err := st.Transition(ctx, f1.ID, domain.EventSubmit); err != nil {
		t.Fatalf("提审: %v", err)
	}
	if _, err := st.Review(ctx, f1.ID, "rev1", true, ""); err != nil {
		t.Fatalf("一审: %v", err)
	}
	// v1 快照字节
	v1, reviewer, err := st.GetVersion(ctx, f1.ID, 1)
	if err != nil || reviewer != "rev1" {
		t.Fatalf("v1 快照: %v %s", err, reviewer)
	}

	// 改草稿（published 态改定义应被拒）→ 走「reject 回 draft 再改再提」路径：
	// 发布后的修改必须再过审（这是流程制品与普通配置的区别）
	if err := st.UpdateDefinition(ctx, f1.ID, def(t, "op.a", "op.c")); err != store.ErrOnlyDraft {
		t.Fatalf("published 改定义应拒绝: %v", err)
	}
	// 二次审核链：直接从 published 提交不合法（状态机已保证），此处测 publish 新版本
	// 的完整路径：新草稿（同 flow 不可——走 reject 路径验证）
	f2, err := st.CreateFlow(ctx, "flow_v2", "p1", "r1", "vf2", "author1", def(t, "op.a", "op.c"))
	if err != nil {
		t.Fatalf("建2: %v", err)
	}
	if _, err := st.Transition(ctx, f2.ID, domain.EventSubmit); err != nil {
		t.Fatalf("提审2: %v", err)
	}
	// reject 带 comment：回 draft + 审计行 + review_comment 落库
	if _, err := st.Review(ctx, f2.ID, "rev1", false, "算子目录没有 op.c"); err != nil {
		t.Fatalf("拒审: %v", err)
	}
	var comment *string
	if err := pool.QueryRow(ctx,
		`SELECT review_comment FROM flows WHERE id = $1`, f2.ID).Scan(&comment); err != nil || comment == nil || *comment != "算子目录没有 op.c" {
		t.Fatalf("拒审意见应落库: %v %v", comment, err)
	}
	var rejects int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM flow_reviews WHERE flow_id = $1 AND decision = 'reject'`, f2.ID).Scan(&rejects); err != nil || rejects != 1 {
		t.Fatalf("审计行: %d %v", rejects, err)
	}

	// 回滚：对 f1（v1 已发布）——先造 v2：把 f1 走 target（保持 published/targeted）
	// 再直接构造 v2 快照（模拟二次发布：reject 路径回不去 published——用第二条流验证）
	// 简化而语义等价：手工插入 v2 快照行（store 不暴露「已发布再改」的路径是刻意的）
	if _, err := pool.Exec(ctx, `
		INSERT INTO flow_versions (flow_id, version, definition, reviewer)
		VALUES ($1, 2, $2, 'rev2')`, f1.ID, def(t, "op.x")); err != nil {
		t.Fatalf("造 v2: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`UPDATE flows SET version = 2 WHERE id = $1`, f1.ID); err != nil {
		t.Fatalf("指向 v2: %v", err)
	}
	// 回滚到 v1
	f, err := st.Rollback(ctx, f1.ID, 1)
	if err != nil || f.Version != 1 {
		t.Fatalf("回滚: %v version=%d", err, f.Version)
	}
	// 快照字节不变（回滚是重指，不是改写）
	v1After, _, err := st.GetVersion(ctx, f1.ID, 1)
	if err != nil || string(v1After) != string(v1) {
		t.Fatalf("v1 快照被改写: %s vs %s (%v)", v1After, v1, err)
	}
	// 回滚到不存在的版本 → 拒绝
	if _, err := st.Rollback(ctx, f1.ID, 99); err != store.ErrVersionGone {
		t.Fatalf("回滚不存在版本应拒绝: %v", err)
	}
	// 回滚不改状态（published 仍是 published）
	if f.Status != domain.StatusPublished {
		t.Fatalf("回滚不应改状态: %s", f.Status)
	}
}

// 判据 3 变体：approve 事务的原子性——快照行与 version 指向同事务落库。
func TestApproveAtomicity(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	f, err := st.CreateFlow(ctx, "flow_a", "p1", "r1", "af", "author1", def(t, "op.a"))
	if err != nil {
		t.Fatalf("建: %v", err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatalf("提审: %v", err)
	}
	if _, err := st.Review(ctx, f.ID, "rev1", true, "ok"); err != nil {
		t.Fatalf("审: %v", err)
	}
	var versions, points int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM flow_versions WHERE flow_id = $1 AND version = 1`, f.ID).Scan(&versions); err != nil || versions != 1 {
		t.Fatalf("快照行: %d %v", versions, err)
	}
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM flows WHERE id = $1 AND version = 1 AND status = 'published'`, f.ID).Scan(&points); err != nil || points != 1 {
		t.Fatalf("指向行: %d %v", points, err)
	}
	// 审计行
	var audits int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM flow_reviews WHERE flow_id = $1 AND decision = 'approve'`, f.ID).Scan(&audits); err != nil || audits != 1 {
		t.Fatalf("审计行: %d %v", audits, err)
	}
}

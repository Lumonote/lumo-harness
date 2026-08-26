package integration_test

// 真 PG 集成（判据 1-6，设计说明 §6）。与 server_test 的分工：那里走 HTTP 面
// 用最小同构依赖表；这里直接用 store + **完整形状的 usage_ledger/budget_trees**
// （与 metering 的真实 DDL 同构——漂移在此逮），验证归档后账照记、删除后台账
// 行保留、预算四态与种子值。

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/projects/internal/domain"
	"github.com/lumo-harness/platform/projects/internal/store"
)

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 projects 集成测试")
	}
	return dsn
}

func newStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	schema := fmt.Sprintf("proj_int_%d", time.Now().UnixNano())
	base := testDSN(t)
	admin, err := pgxpool.New(context.Background(), base)
	if err != nil {
		t.Fatalf("admin: %v", err)
	}
	if _, err := admin.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("建 schema: %v", err)
	}
	admin.Close()
	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("DSN 解析: %v", err)
	}
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	pool, err := pgxpool.New(context.Background(), u.String())
	if err != nil {
		t.Fatalf("连接: %v", err)
	}
	t.Cleanup(pool.Close)

	st := store.New(pool, 5_000)
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	// 完整形状依赖表（metering 真实 DDL 同构，幂等迁移动作含）
	for _, ddl := range []string{
		`CREATE TABLE IF NOT EXISTS budget_trees (
		   kind TEXT NOT NULL, id TEXT NOT NULL, budget BIGINT NOT NULL,
		   budget_total BIGINT, soft_limit BIGINT, overdraft BIGINT,
		   PRIMARY KEY (kind, id))`,
		`CREATE TABLE IF NOT EXISTS usage_ledger (
		   id BIGSERIAL PRIMARY KEY,
		   ts TIMESTAMPTZ NOT NULL,
		   user_id TEXT NOT NULL, dept_id TEXT NOT NULL, role TEXT NOT NULL,
		   project_id TEXT NOT NULL, agent_id TEXT NOT NULL, component_id TEXT NOT NULL,
		   feature TEXT NOT NULL, session_ref TEXT NOT NULL,
		   model TEXT, tokens BIGINT NOT NULL DEFAULT 0,
		   cost_type TEXT NOT NULL, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
		   trace_id TEXT, emitter TEXT, qty NUMERIC(20,6), unit TEXT, event_key TEXT)`,
	} {
		if _, err := pool.Exec(context.Background(), ddl); err != nil {
			t.Fatalf("建依赖表: %v", err)
		}
	}
	return st, pool
}

// 判据 1：创建三件套（成员行/预算行/重名拒绝）。
func TestCreateSeedsBudgetAndOwner(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	p, err := st.CreateProject(ctx, "proj_a", "r1", "apollo", "u1")
	if err != nil {
		t.Fatalf("创建: %v", err)
	}
	if p.Status != domain.StatusActive {
		t.Fatalf("新项目应 active: %s", p.Status)
	}
	var ownerRole string
	if err := pool.QueryRow(ctx,
		`SELECT role FROM project_members WHERE project_id='proj_a' AND user_id='u1'`).Scan(&ownerRole); err != nil || ownerRole != "owner" {
		t.Fatalf("owner 成员行: %v %s", err, ownerRole)
	}
	var budget int64
	if err := pool.QueryRow(ctx,
		`SELECT budget FROM budget_trees WHERE kind='project' AND id='proj_a'`).Scan(&budget); err != nil || budget != 5000 {
		t.Fatalf("预算种子: %v %d（want 5000）", err, budget)
	}
	if _, err := st.CreateProject(ctx, "proj_b", "r1", "apollo", "u2"); err != store.ErrNameTaken {
		t.Fatalf("realm 内重名应拒绝: %v", err)
	}
	if _, err := st.CreateProject(ctx, "proj_c", "r2", "apollo", "u3"); err != nil {
		t.Fatalf("异 realm 同名应放行: %v", err)
	}
}

// 判据 3：归档后账照记——Usage 聚合不受 status 影响（账期门按事件时刻判）。
func TestArchivedProjectStillCountsUsage(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	if _, err := st.CreateProject(ctx, "proj_x", "r1", "x", "u1"); err != nil {
		t.Fatalf("创建: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO usage_ledger (ts, user_id, dept_id, role, project_id, agent_id,
		  component_id, feature, session_ref, cost_type, cost_usd, qty)
		VALUES (now(), 'u1','d1','viewer','proj_x','a1','c1','kb:qa','s1',
		  'llm.tokens', 1.5, 100)`); err != nil {
		t.Fatalf("插台账: %v", err)
	}
	if _, err := st.Transition(ctx, "proj_x", "archive"); err != nil {
		t.Fatalf("归档: %v", err)
	}
	items, _, err := st.Usage(ctx, "proj_x")
	if err != nil || len(items) != 1 {
		t.Fatalf("归档后用量应照记: %v %v", items, err)
	}
	if items[0].CostType != "llm.tokens" || items[0].Qty != 100 || items[0].CostUSD != 1.5 {
		t.Fatalf("聚合数值: %+v", items[0])
	}
}

// 判据 5：删除后 projects/members 行消失、usage_ledger 历史行原样保留。
func TestDeleteKeepsLedgerRows(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	if _, err := st.CreateProject(ctx, "proj_y", "r1", "y", "u1"); err != nil {
		t.Fatalf("创建: %v", err)
	}
	if _, err := pool.Exec(ctx, `
		INSERT INTO usage_ledger (ts, user_id, dept_id, role, project_id, agent_id,
		  component_id, feature, session_ref, cost_type, cost_usd, qty)
		VALUES (now(), 'u1','d1','viewer','proj_y','a1','c1','kb:qa','s1',
		  'seam.query', 0.25, 42)`); err != nil {
		t.Fatalf("插台账: %v", err)
	}
	// active 直接删被拒（两层闸第一层）
	if err := st.DeleteProject(ctx, "proj_y"); err != store.ErrNotArchived {
		t.Fatalf("active 删除应拒绝: %v", err)
	}
	if _, err := st.Transition(ctx, "proj_y", "archive"); err != nil {
		t.Fatalf("归档: %v", err)
	}
	if err := st.DeleteProject(ctx, "proj_y"); err != nil {
		t.Fatalf("删除: %v", err)
	}
	var projects, members int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM projects`).Scan(&projects); err != nil {
		t.Fatalf("count: %v", err)
	}
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM project_members`).Scan(&members); err != nil {
		t.Fatalf("count: %v", err)
	}
	if projects != 0 || members != 0 {
		t.Fatalf("删除后实体应消失: projects=%d members=%d", projects, members)
	}
	var ledger int
	if err := pool.QueryRow(ctx,
		`SELECT count(*) FROM usage_ledger WHERE project_id='proj_y'`).Scan(&ledger); err != nil || ledger != 1 {
		t.Fatalf("台账历史行必须保留（append-only 不因删除破例）: %d %v", ledger, err)
	}
	// 删除后 usage 聚合仍可读（悬空 project_id 的账还在，报表解析为已删除项目）
	items, _, err := st.Usage(ctx, "proj_y")
	if err != nil || len(items) != 1 || items[0].Qty != 42 {
		t.Fatalf("悬空归因的聚合: %v %v", items, err)
	}
}

// 判据 6：预算四态来自 budget_trees（种子后可读；透支/软限额随运维配置演进）。
func TestUsageBudgetStates(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()
	if _, err := st.CreateProject(ctx, "proj_z", "r1", "z", "u1"); err != nil {
		t.Fatalf("创建: %v", err)
	}
	_, snap, err := st.Usage(ctx, "proj_z")
	if err != nil || snap.Budget != 5000 || snap.State != "ok" {
		t.Fatalf("初始四态: %+v %v", snap, err)
	}
	// 消耗后余量变化（直接改树模拟扣减——执法路径在 TS metering，已测）
	if _, err := pool.Exec(ctx,
		`UPDATE budget_trees SET budget = 200 WHERE kind='project' AND id='proj_z'`); err != nil {
		t.Fatalf("改树: %v", err)
	}
	_, snap, err = st.Usage(ctx, "proj_z")
	if err != nil || snap.Remaining != 200 {
		t.Fatalf("余量: %+v %v", snap, err)
	}
	// 透支窗口内 → within
	if _, err := pool.Exec(ctx,
		`UPDATE budget_trees SET budget = -100, overdraft = 500 WHERE kind='project' AND id='proj_z'`); err != nil {
		t.Fatalf("改树: %v", err)
	}
	_, snap, err = st.Usage(ctx, "proj_z")
	if err != nil || snap.State != "within" {
		t.Fatalf("透支窗内应 within: %+v %v", snap, err)
	}
	// 超透支 → hard
	if _, err := pool.Exec(ctx,
		`UPDATE budget_trees SET budget = -900 WHERE kind='project' AND id='proj_z'`); err != nil {
		t.Fatalf("改树: %v", err)
	}
	_, snap, err = st.Usage(ctx, "proj_z")
	if err != nil || snap.State != "hard" {
		t.Fatalf("超透支应 hard: %+v %v", snap, err)
	}
}

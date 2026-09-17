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
	"reflect"
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
		d.Nodes = append(d.Nodes, domain.FlowNode{ID: id, Operator: op})
		if i > 0 {
			d.Edges = append(d.Edges, domain.FlowEdge{From: fmt.Sprintf("n%d", i-1), To: id})
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

// sameJSON 比语义而不比字节。flow_trigger_outbox.payload 是 JSONB 列，PG 写入时
// 会规范化键序与空白（`{"a":1,"b":2}` 读回来是 `{"a": 1, "b": 2}`），所以拿 Go
// 字面量去比字节恒不相等——那测的是 PG 的序列化格式，不是「原负载被复制了」。
func sameJSON(t *testing.T, want, got json.RawMessage) bool {
	t.Helper()
	var w, g any
	if err := json.Unmarshal(want, &w); err != nil {
		t.Fatalf("期望负载不是合法 JSON: %v", err)
	}
	if err := json.Unmarshal(got, &g); err != nil {
		t.Fatalf("实际负载不是合法 JSON: %v", err)
	}
	return reflect.DeepEqual(w, g)
}

// A manual replay must remain a new, auditable attempt even after automation
// bindings or the flow's current version have changed. The original payload and
// captured binding are copied to a fresh outbox record, never re-matched.
func TestFailedRunReplayPinsPayloadAndPublishedVersion(t *testing.T) {
	st, pool := newStore(t)
	ctx := context.Background()

	f, err := st.CreateFlow(ctx, "flow_replay", "p1", "r1", "replay", "author1", def(t, "op.a"))
	if err != nil {
		t.Fatalf("建流程: %v", err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatalf("提审: %v", err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatalf("发布: %v", err)
	}

	payload := json.RawMessage(`{"ticket":"T-7","severity":"high"}`)
	if err := st.EnqueueTrigger(ctx, "r1", "ticket.opened", payload); err != nil {
		t.Fatalf("入原事件: %v", err)
	}
	var triggerID uint64
	if err := pool.QueryRow(ctx, `SELECT id FROM flow_trigger_outbox WHERE event_name='ticket.opened'`).Scan(&triggerID); err != nil {
		t.Fatalf("取原事件: %v", err)
	}
	if claimed, err := st.StartTriggerRun(ctx, triggerID, "automation-ticket", f.ID, 1); err != nil || !claimed {
		t.Fatalf("启动原运行: claimed=%v err=%v", claimed, err)
	}
	if err := st.FinishTriggerRun(ctx, triggerID, "automation-ticket", "failed", nil, fmt.Errorf("upstream unavailable")); err != nil {
		t.Fatalf("结束原运行: %v", err)
	}
	// Delivery of a terminal business failure must not silently become another
	// business attempt if its outbox acknowledgement needs recovery.
	if claimed, err := st.StartTriggerRun(ctx, triggerID, "automation-ticket", f.ID, 1); err != nil || claimed {
		t.Fatalf("失败运行不得被自动接管: claimed=%v err=%v", claimed, err)
	}

	var runID int64
	if err := pool.QueryRow(ctx, `SELECT id FROM flow_runs WHERE trigger_id=$1`, triggerID).Scan(&runID); err != nil {
		t.Fatalf("取原运行: %v", err)
	}
	queued, err := st.EnqueueReplay(ctx, f.ID, "r1", runID)
	if err != nil || queued.TriggerID == 0 || queued.AlreadyQueued {
		t.Fatalf("首次重放入队: %+v err=%v", queued, err)
	}
	duplicate, err := st.EnqueueReplay(ctx, f.ID, "r1", runID)
	if err != nil || !duplicate.AlreadyQueued || duplicate.TriggerID != queued.TriggerID {
		t.Fatalf("重复重放应幂等: %+v err=%v", duplicate, err)
	}

	var gotPayload json.RawMessage
	var automationID, flowID string
	var version int
	var replayOf int64
	if err := pool.QueryRow(ctx, `
		SELECT payload, replay_automation_id, replay_flow_id, replay_flow_version, replay_of_run_id
		FROM flow_trigger_outbox WHERE id=$1`, queued.TriggerID).Scan(
		&gotPayload, &automationID, &flowID, &version, &replayOf,
	); err != nil {
		t.Fatalf("读重放事件: %v", err)
	}
	if !sameJSON(t, payload, gotPayload) || automationID != "automation-ticket" || flowID != f.ID || version != 1 || replayOf != runID {
		t.Fatalf("重放没有固定原始快照: payload=%s automation=%s flow=%s version=%d replayOf=%d", gotPayload, automationID, flowID, version, replayOf)
	}

	if _, err := st.EnqueueReplay(ctx, f.ID, "r1", runID+999); err != store.ErrNotFound {
		t.Fatalf("不存在运行应拒绝: %v", err)
	}
	// 终点运行不可重复终结：一次尝试只有一次 running → 终态。这不是实现细节，
	// 它正是「重放是新的尝试、不是翻旧账」的前提，所以顺手钉住这条守卫。
	if err := st.FinishTriggerRun(ctx, triggerID, "automation-ticket", "succeeded", json.RawMessage(`{}`), nil); err != store.ErrRunFinalized {
		t.Fatalf("重复终结已终结的运行应 ErrRunFinalized: %v", err)
	}
	// 「成功运行不得重放」要的是 EnqueueReplay 的**状态谓词**，而上面那条路走不通
	// 正是产品的正确行为，所以这里直接改状态造出前提。注意这条运行此时**已经**有
	// 一条排队的重放：断言仍然成立，说明状态谓词判在 already_queued 回退之前。
	if _, err := pool.Exec(ctx, `UPDATE flow_runs SET status='succeeded' WHERE id=$1`, runID); err != nil {
		t.Fatalf("置成功运行: %v", err)
	}
	if _, err := st.EnqueueReplay(ctx, f.ID, "r1", runID); err != store.ErrRunNotReplayable {
		t.Fatalf("成功运行不得重放: %v", err)
	}
}

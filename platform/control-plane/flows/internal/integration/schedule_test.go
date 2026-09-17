package integration_test

// cron 调度（A2）的真 PG 集成。
//
// 只有**一个**用例，而且是刻意的：本机与 CI 的资源都有限，每多一个用例就多一个
// schema + 连接池。这里只放「只有真库能确认」的三件事，其余全部由 fake 单测覆盖
// （internal/cron 16 条 + internal/schedule 23 条，见那两个包）：
//
//  1. FireCronCursor 的「推进游标 + 入队」是不是真的一个事务（CTE 单语句）；
//  2. CAS 谓词能不能挡住重复入队；
//  3. 绑定 JOIN 按 source 分流——cron 只投给它自己的自动化，event 仍按表达式扇出。
//
// 另加两条 SQL 里 WHERE 的口径（fake 测不到）：ListCronAutomations 只认已发布 + 启用，
// 以及游标按 realm/project 隔离。

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/flows/internal/domain"
	"github.com/lumo-harness/platform/flows/internal/schedule"
	"github.com/lumo-harness/platform/flows/internal/store"
)

// flows 的绑定查询会 JOIN projects / project_automations，这两张表在生产里归
// projects 服务所有（两服务同库不同表，见 store 包注释）。集成测试只跑 flows 自己的
// DDL，所以这里补最小结构——只建被查询用到的列，避免测试悄悄依赖 projects 的完整
// schema，那样上游改表会在这里以看不懂的方式炸。
const projectsDDL = `
CREATE TABLE IF NOT EXISTS projects (
  id     TEXT PRIMARY KEY,
  realm  TEXT NOT NULL,
  status TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_automations (
  automation_id TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL,
  trigger_kind  TEXT NOT NULL,
  trigger_spec  TEXT NOT NULL,
  flow_ref      TEXT NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true
);
`

func newScheduleStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	st, pool := newStore(t)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, projectsDDL); err != nil {
		t.Fatalf("建 projects 最小结构: %v", err)
	}
	if _, err := pool.Exec(ctx,
		`INSERT INTO projects (id, realm, status) VALUES ('p1','r1','active')`); err != nil {
		t.Fatalf("建项目: %v", err)
	}
	return st, pool
}

// publishFlow 建一个流程并走完提审 → 发布，返回 flow_id。
func publishFlow(t *testing.T, st *store.Store, name string) string {
	t.Helper()
	ctx := context.Background()
	f, err := st.CreateFlow(ctx, "flow_"+name, "p1", "r1", name, "author1", def(t, "op.a"))
	if err != nil {
		t.Fatalf("建流程: %v", err)
	}
	if _, err := st.Transition(ctx, f.ID, domain.EventSubmit); err != nil {
		t.Fatalf("提审: %v", err)
	}
	if _, err := st.Review(ctx, f.ID, "reviewer", true, ""); err != nil {
		t.Fatalf("发布: %v", err)
	}
	return f.ID
}

func seedAutomation(t *testing.T, pool *pgxpool.Pool, automationID, kind, spec, flowRef string, enabled bool) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `
		INSERT INTO project_automations (automation_id, project_id, trigger_kind, trigger_spec, flow_ref, enabled)
		VALUES ($1,'p1',$2,$3,$4,$5)`, automationID, kind, spec, flowRef, enabled); err != nil {
		t.Fatalf("建自动化 %s: %v", automationID, err)
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("计数失败 (%s): %v", sql, err)
	}
	return n
}

// TestCronScheduleEndToEnd 一条故事线跑完 A2 的所有真库不变式。
func TestCronScheduleEndToEnd(t *testing.T) {
	st, pool := newScheduleStore(t)
	ctx := context.Background()
	flowID := publishFlow(t, st, "cron")

	// auto-a 与 auto-b 写**同一个** cron 表达式——按表达式匹配的绑定会让它们互相触发，
	// 这就是那条回归线。auto-event 用来证明 event 路径没被改坏。
	seedAutomation(t, pool, "auto-a", "cron", "0 * * * *", flowID, true)
	seedAutomation(t, pool, "auto-b", "cron", "0 * * * *", flowID, true)
	seedAutomation(t, pool, "auto-event", "event", "ticket.opened", flowID, true)
	// 停用的 cron 自动化不该进运行面。
	seedAutomation(t, pool, "auto-off", "cron", "0 * * * *", flowID, false)
	// 草稿流程上的 cron 自动化同样不该进运行面。
	draft, err := st.CreateFlow(ctx, "flow_draft_cron", "p1", "r1", "draftcron", "author1", def(t, "op.a"))
	if err != nil {
		t.Fatalf("建草稿: %v", err)
	}
	seedAutomation(t, pool, "auto-draft", "cron", "0 * * * *", draft.ID, true)

	// --- ListCronAutomations 的过滤口径（SQL 里的 WHERE，fake 测不到）---
	automations, err := st.ListCronAutomations(ctx)
	if err != nil {
		t.Fatalf("列出 cron 自动化: %v", err)
	}
	got := map[string]bool{}
	for _, automation := range automations {
		got[automation.AutomationID] = true
	}
	if len(automations) != 2 || !got["auto-a"] || !got["auto-b"] {
		t.Fatalf("cron 自动化 = %v，期望只有 auto-a / auto-b（排除停用与草稿流程）", got)
	}
	if automations[0].Realm != "r1" || automations[0].ProjectID != "p1" || automations[0].Spec != "0 * * * *" {
		t.Fatalf("自动化 = %+v，期望 realm=r1 project=p1 spec=0 * * * *", automations[0])
	}

	// --- 生产者第一轮：建游标，起点是 now，所以不该触发 ---
	now := time.Date(2026, 9, 14, 9, 0, 30, 0, time.UTC)
	producer := schedule.NewProducer(st, time.UTC)
	producer.SetClock(func() time.Time { return now })
	reported := []error{}
	producer.SetErrorHandler(func(err error) { reported = append(reported, err) })

	first := producer.Cycle(ctx)
	if first.Reconciled != 2 || first.Fired != 0 {
		t.Fatalf("第一轮 = %+v，期望 Reconciled=2 Fired=0 (errs=%v)", first, reported)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM flow_cron_cursors`); got != 2 {
		t.Fatalf("游标数 = %d，期望 2", got)
	}
	var nextFire time.Time
	if err := pool.QueryRow(ctx,
		`SELECT next_fire_at FROM flow_cron_cursors WHERE automation_id='auto-a'`).Scan(&nextFire); err != nil {
		t.Fatalf("读游标: %v", err)
	}
	// next_fire_at 是 TIMESTAMPTZ：存的瞬间是对的，但 pgx 读回来挂的是 time.Local，
	// 直接 Format 出来就是本机时区（本机 CST → 18:00+08:00，UTC 机器 → 10:00Z）。
	// 断言的是「这个瞬间」，所以先归一到 UTC 再渲染，否则用例会随机器时区红绿。
	if formatted := nextFire.UTC().Format(time.RFC3339); formatted != "2026-09-14T10:00:00Z" {
		t.Fatalf("next_fire_at = %s，期望 2026-09-14T10:00:00Z", formatted)
	}

	// --- 游标按 realm/project 隔离（SQL 里的 WHERE）---
	if _, err := pool.Exec(ctx, `
		INSERT INTO flow_cron_cursors (automation_id, realm, project_id, spec, last_fired_at, next_fire_at)
		VALUES ('auto-elsewhere','r2','p-other','0 * * * *',now(),now())`); err != nil {
		t.Fatalf("种子外部游标: %v", err)
	}
	scoped, err := st.ListCronCursors(ctx, "r1", "p1")
	if err != nil {
		t.Fatalf("按项目列游标: %v", err)
	}
	if len(scoped) != 2 {
		t.Fatalf("本项目游标数 = %d，期望 2（不得带出别的 realm/project）", len(scoped))
	}

	// --- 第二轮：到期，两个自动化各触发一次并推进到 11:00 ---
	now = time.Date(2026, 9, 14, 10, 0, 30, 0, time.UTC)
	second := producer.Cycle(ctx)
	if second.Fired != 2 {
		t.Fatalf("第二轮 Fired = %d，期望 2 (errs=%v)", second.Fired, reported)
	}
	if err := pool.QueryRow(ctx,
		`SELECT next_fire_at FROM flow_cron_cursors WHERE automation_id='auto-a'`).Scan(&nextFire); err != nil {
		t.Fatalf("读游标: %v", err)
	}
	if formatted := nextFire.UTC().Format(time.RFC3339); formatted != "2026-09-14T11:00:00Z" {
		t.Fatalf("推进后 next_fire_at = %s，期望 2026-09-14T11:00:00Z", formatted)
	}

	// outbox 行：source / cron_automation_id 必须落对，负载要是生产者序列化的那个。
	var triggerID uint64
	var source, eventName, cronAutomationID string
	var payload json.RawMessage
	if err := pool.QueryRow(ctx, `
		SELECT id, source, event_name, cron_automation_id, payload FROM flow_trigger_outbox
		WHERE source='cron' AND cron_automation_id='auto-a'`).Scan(
		&triggerID, &source, &eventName, &cronAutomationID, &payload); err != nil {
		t.Fatalf("读 outbox: %v", err)
	}
	if eventName != "auto-a" {
		t.Fatalf("event_name = %s，期望 auto-a", eventName)
	}
	var decoded schedule.Payload
	if err := json.Unmarshal(payload, &decoded); err != nil {
		t.Fatalf("负载不是合法 JSON: %v", err)
	}
	if decoded.AutomationID != "auto-a" || decoded.Spec != "0 * * * *" {
		t.Fatalf("负载 = %+v，期望 auto-a / 0 * * * *", decoded)
	}
	if formatted := decoded.ScheduledFor.Format(time.RFC3339); formatted != "2026-09-14T10:00:00Z" {
		t.Fatalf("负载 ScheduledFor = %s，期望 2026-09-14T10:00:00Z", formatted)
	}

	// --- 绑定分流：cron 只投给自己那一个自动化 ---
	bindings, err := st.PrepareTriggerBindings(ctx, triggerID, "r1")
	if err != nil {
		t.Fatalf("准备绑定: %v", err)
	}
	if len(bindings) != 1 || bindings[0].AutomationID != "auto-a" {
		t.Fatalf("cron 触发绑定 = %+v，期望只绑定 auto-a（不得带上同表达式的 auto-b 或事件自动化）", bindings)
	}
	if bindings[0].FlowID != flowID || bindings[0].FlowVersion != 1 {
		t.Fatalf("绑定 = %+v，期望 flow=%s version=1", bindings[0], flowID)
	}

	// --- 第三轮：还没到 11:00，不得重复触发 ---
	third := producer.Cycle(ctx)
	if third.Fired != 0 {
		t.Fatalf("第三轮 Fired = %d，期望 0", third.Fired)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM flow_trigger_outbox WHERE source='cron'`); got != 2 {
		t.Fatalf("cron 触发行数 = %d，期望 2", got)
	}

	// --- CAS：拿已过期的游标再提交一次，必须被挡下且不产生第二条触发 ---
	stale := store.Cursor{
		AutomationID: "auto-a", Realm: "r1", ProjectID: "p1", Spec: "0 * * * *",
		LastFiredAt: time.Date(2026, 9, 14, 9, 0, 0, 0, time.UTC),
		NextFireAt:  time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC),
	}
	if _, err := st.FireCronCursor(ctx, store.Fire{
		Cursor: stale, Payload: json.RawMessage(`{}`),
		Fired: time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC),
		Next:  time.Date(2026, 9, 14, 11, 0, 0, 0, time.UTC),
		Now:   now,
	}); err != store.ErrCursorAdvanced {
		t.Fatalf("重复提交错误 = %v，期望 ErrCursorAdvanced", err)
	}
	// spec 变了之后也不能再按旧 spec 提交（防住「读到旧 spec 再写入」的窗口）。
	changed := stale
	changed.Spec = "0 9 * * *"
	if _, err := st.FireCronCursor(ctx, store.Fire{
		Cursor: changed, Payload: json.RawMessage(`{}`),
		Fired: time.Date(2026, 9, 14, 10, 0, 0, 0, time.UTC),
		Next:  time.Date(2026, 9, 14, 11, 0, 0, 0, time.UTC),
		Now:   now,
	}); err != store.ErrCursorAdvanced {
		t.Fatalf("spec 已变更时提交错误 = %v，期望 ErrCursorAdvanced", err)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM flow_trigger_outbox WHERE source='cron'`); got != 2 {
		t.Fatalf("CAS 未挡住重复入队：cron 触发行数 = %d，期望仍为 2", got)
	}

	// --- 事件路径回归：source='event' 时仍按 trigger_spec 扇出 ---
	if err := st.EnqueueTrigger(ctx, "r1", "ticket.opened", json.RawMessage(`{"ticket":"T-1"}`)); err != nil {
		t.Fatalf("入事件: %v", err)
	}
	var eventTriggerID uint64
	if err := pool.QueryRow(ctx,
		`SELECT id FROM flow_trigger_outbox WHERE source='event' AND event_name='ticket.opened'`).Scan(&eventTriggerID); err != nil {
		t.Fatalf("取事件触发: %v", err)
	}
	eventBindings, err := st.PrepareTriggerBindings(ctx, eventTriggerID, "r1")
	if err != nil {
		t.Fatalf("准备事件绑定: %v", err)
	}
	if len(eventBindings) != 1 || eventBindings[0].AutomationID != "auto-event" {
		t.Fatalf("事件绑定 = %+v，期望只绑定 auto-event", eventBindings)
	}

	// --- 非法表达式：落停滞游标、不进调度、不触发、对巡检可见 ---
	if _, err := pool.Exec(ctx,
		`UPDATE project_automations SET trigger_spec = '每天早上九点' WHERE automation_id = 'auto-a'`); err != nil {
		t.Fatalf("改表达式: %v", err)
	}
	now = time.Date(2026, 9, 14, 11, 30, 0, 0, time.UTC)
	fourth := producer.Cycle(ctx)
	// auto-b 的表达式没变、仍是合法的小时任务，11:30 时它的 11:00 到期，所以这一轮
	// **应该**恰好触发 1 次——非法表达式只该停掉它自己那一条，不该把整个调度按停。
	// 被停掉的是 auto-a：reconcile 发现 spec 变了、解析失败，把它的游标重置成停滞
	// （last_error 非空 → DueCronCursors 的 `last_error = ''` 把它挡在调度之外）。
	if fourth.Fired != 1 {
		t.Fatalf("第四轮 Fired = %d，期望 1（只有 auto-b 到期；auto-a 已停滞）", fourth.Fired)
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM flow_trigger_outbox WHERE source='cron' AND cron_automation_id='auto-a'`); got != 1 {
		t.Fatalf("停滞的 auto-a 不应再触发：触发行数 = %d，期望仍为 1", got)
	}
	if got := countRows(t, pool,
		`SELECT count(*) FROM flow_trigger_outbox WHERE source='cron' AND cron_automation_id='auto-b'`); got != 2 {
		t.Fatalf("auto-b 应照常触发：触发行数 = %d，期望 2", got)
	}
	scoped, err = st.ListCronCursors(ctx, "r1", "p1")
	if err != nil {
		t.Fatalf("按项目列游标: %v", err)
	}
	stalled := 0
	for _, cursor := range scoped {
		if cursor.LastError != "" {
			stalled++
		}
	}
	if stalled != 1 {
		t.Fatalf("stalled = %d，期望 1", stalled)
	}

	// --- 停用：协调阶段删掉游标，触发源彻底消失 ---
	if _, err := pool.Exec(ctx,
		`UPDATE project_automations SET enabled = false WHERE automation_id IN ('auto-a','auto-b')`); err != nil {
		t.Fatalf("停用: %v", err)
	}
	fifth := producer.Cycle(ctx)
	if fifth.Reconciled != 2 {
		t.Fatalf("停用后 Reconciled = %d，期望 2（删掉两条游标）", fifth.Reconciled)
	}
	if got := countRows(t, pool, `SELECT count(*) FROM flow_cron_cursors WHERE project_id='p1'`); got != 0 {
		t.Fatalf("停用后本项目仍有 %d 条游标，期望 0", got)
	}
	if len(reported) != 0 {
		t.Fatalf("整个流程不应上报错误，实际 %v", reported)
	}
}

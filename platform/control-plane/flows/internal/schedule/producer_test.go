package schedule

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"testing"
	"time"

	"github.com/lumo-harness/platform/flows/internal/cron"
	"github.com/lumo-harness/platform/flows/internal/store"
)

// fakeCursors 复刻存储层的可观察行为，特别是 FireCronCursor 的 CAS：
// 游标已被推进到 fire.Now 之后就拒绝，返回 store.ErrCursorAdvanced。
type fakeCursors struct {
	automations []store.CronAutomation
	cursors     map[string]store.Cursor
	nextID      uint64

	listErr error
	loadErr error
	dueErr  error
	fireErr error

	upserts []store.Cursor
	deletes [][]string
	stalls  []string
	fires   []store.Fire
}

func newFakeCursors() *fakeCursors {
	return &fakeCursors{cursors: map[string]store.Cursor{}}
}

func (f *fakeCursors) ListCronAutomations(context.Context) ([]store.CronAutomation, error) {
	if f.listErr != nil {
		return nil, f.listErr
	}
	return f.automations, nil
}

func (f *fakeCursors) LoadCronCursors(context.Context) ([]store.Cursor, error) {
	if f.loadErr != nil {
		return nil, f.loadErr
	}
	out := make([]store.Cursor, 0, len(f.cursors))
	for _, cursor := range f.cursors {
		out = append(out, cursor)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].AutomationID < out[j].AutomationID })
	return out, nil
}

func (f *fakeCursors) UpsertCronCursor(_ context.Context, cursor store.Cursor) error {
	f.upserts = append(f.upserts, cursor)
	f.cursors[cursor.AutomationID] = cursor
	return nil
}

func (f *fakeCursors) DeleteCronCursors(_ context.Context, automationIDs []string) error {
	f.deletes = append(f.deletes, automationIDs)
	for _, id := range automationIDs {
		delete(f.cursors, id)
	}
	return nil
}

func (f *fakeCursors) DueCronCursors(_ context.Context, now time.Time, limit int) ([]store.Cursor, error) {
	if f.dueErr != nil {
		return nil, f.dueErr
	}
	out := []store.Cursor{}
	for _, cursor := range f.cursors {
		// 停滞的游标不参与调度，与 SQL 侧的 last_error = '' 过滤一致。
		if cursor.LastError != "" || cursor.NextFireAt.After(now) {
			continue
		}
		out = append(out, cursor)
	}
	sort.Slice(out, func(i, j int) bool {
		if !out[i].NextFireAt.Equal(out[j].NextFireAt) {
			return out[i].NextFireAt.Before(out[j].NextFireAt)
		}
		return out[i].AutomationID < out[j].AutomationID
	})
	if limit > 0 && len(out) > limit {
		out = out[:limit]
	}
	return out, nil
}

func (f *fakeCursors) FireCronCursor(_ context.Context, fire store.Fire) (uint64, error) {
	if f.fireErr != nil {
		return 0, f.fireErr
	}
	current, ok := f.cursors[fire.Cursor.AutomationID]
	if !ok {
		return 0, store.ErrCursorAdvanced
	}
	if current.NextFireAt.After(fire.Now) {
		return 0, store.ErrCursorAdvanced
	}
	current.LastFiredAt = fire.Fired
	current.NextFireAt = fire.Next
	current.LastError = ""
	f.cursors[fire.Cursor.AutomationID] = current
	f.fires = append(f.fires, fire)
	f.nextID++
	return f.nextID, nil
}

func (f *fakeCursors) StallCronCursor(_ context.Context, automationID, reason string) error {
	f.stalls = append(f.stalls, automationID+"|"+reason)
	current := f.cursors[automationID]
	current.LastError = reason
	f.cursors[automationID] = current
	return nil
}

// --- 测试辅助 ---

func mustTime(t *testing.T, value string) time.Time {
	t.Helper()
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		t.Fatalf("解析时间 %q 失败: %v", value, err)
	}
	return parsed
}

// newTestProducer 返回一个时钟固定在 now 的生产者，并收集上报的错误。
func newTestProducer(t *testing.T, cursors Cursors, now string) (*Producer, *[]error) {
	t.Helper()
	producer := NewProducer(cursors, time.UTC)
	producer.SetClock(func() time.Time { return mustTime(t, now) })
	reported := &[]error{}
	producer.SetErrorHandler(func(err error) { *reported = append(*reported, err) })
	return producer, reported
}

func automation(id, spec string) store.CronAutomation {
	return store.CronAutomation{AutomationID: id, Realm: "realm-1", ProjectID: "proj-1", Spec: spec}
}

func hourlyCursor(id, lastFired, nextFire string) store.Cursor {
	return store.Cursor{
		AutomationID: id, Realm: "realm-1", ProjectID: "proj-1", Spec: "0 * * * *",
		LastFiredAt: mustTimeForTest(lastFired), NextFireAt: mustTimeForTest(nextFire),
	}
}

// seedCursor 同时登记自动化与游标。协调阶段会删掉没有对应自动化的游标，
// 所以只塞游标不塞自动化，下一轮就会被清掉。
func seedCursor(fake *fakeCursors, cursor store.Cursor) {
	fake.automations = append(fake.automations, store.CronAutomation{
		AutomationID: cursor.AutomationID, Realm: cursor.Realm,
		ProjectID: cursor.ProjectID, Spec: cursor.Spec,
	})
	fake.cursors[cursor.AutomationID] = cursor
}

// mustTimeForTest 供构造测试数据使用，解析失败会 panic（数据是写死的字面量）。
func mustTimeForTest(value string) time.Time {
	parsed, err := time.Parse(time.RFC3339, value)
	if err != nil {
		panic(err)
	}
	return parsed
}

// --- 协调阶段 ---

func TestReconcileCreatesCursorForNewAutomation(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "0 9 * * *")}
	producer, _ := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Reconciled != 1 {
		t.Fatalf("Reconciled = %d，期望 1", report.Reconciled)
	}
	if len(fake.upserts) != 1 {
		t.Fatalf("Upsert 调用 %d 次，期望 1 次", len(fake.upserts))
	}
	created := fake.upserts[0]
	if created.AutomationID != "auto-1" || created.Spec != "0 9 * * *" {
		t.Fatalf("新建游标 = %+v，期望 auto-1 / 0 9 * * *", created)
	}
	if got := created.LastFiredAt.Format(time.RFC3339); got != "2026-09-14T10:00:00Z" {
		t.Fatalf("LastFiredAt = %s，期望 now", got)
	}
	// 起点是 now，所以下一次是次日 09:00，不会立刻补跑。
	if got := created.NextFireAt.Format(time.RFC3339); got != "2026-09-15T09:00:00Z" {
		t.Fatalf("NextFireAt = %s，期望 2026-09-15T09:00:00Z", got)
	}
	if created.LastError != "" {
		t.Fatalf("LastError = %q，期望为空", created.LastError)
	}
	if len(fake.fires) != 0 {
		t.Fatalf("新建游标不应触发任何运行，实际触发 %d 次", len(fake.fires))
	}
}

func TestReconcileKeepsUnchangedCursor(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "0 9 * * *")}
	fake.cursors["auto-1"] = store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1", Spec: "0 9 * * *",
		LastFiredAt: mustTimeForTest("2026-09-14T09:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-15T09:00:00Z"),
	}
	producer, reported := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Reconciled != 0 {
		t.Fatalf("Reconciled = %d，期望 0（游标未变）", report.Reconciled)
	}
	if len(fake.upserts) != 0 {
		t.Fatalf("未变更的游标不应被重写，实际 Upsert %d 次", len(fake.upserts))
	}
	if len(fake.deletes) != 0 {
		t.Fatalf("未变更的游标不应被删除，实际删除 %v", fake.deletes)
	}
	if len(*reported) != 0 {
		t.Fatalf("不应上报错误，实际 %v", *reported)
	}
}

func TestReconcileResetsCursorWhenSpecChanges(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "0 10 * * *")}
	fake.cursors["auto-1"] = store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1", Spec: "0 9 * * *",
		LastFiredAt: mustTimeForTest("2026-09-01T09:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-14T09:00:00Z"),
	}
	producer, _ := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Reconciled != 1 {
		t.Fatalf("Reconciled = %d，期望 1", report.Reconciled)
	}
	reset := fake.upserts[0]
	if reset.Spec != "0 10 * * *" {
		t.Fatalf("重置后的 Spec = %q，期望 0 10 * * *", reset.Spec)
	}
	if got := reset.LastFiredAt.Format(time.RFC3339); got != "2026-09-14T10:00:00Z" {
		t.Fatalf("重置后的 LastFiredAt = %s，期望 now（不追溯旧表达式）", got)
	}
	if got := reset.NextFireAt.Format(time.RFC3339); got != "2026-09-15T10:00:00Z" {
		t.Fatalf("重置后的 NextFireAt = %s，期望 2026-09-15T10:00:00Z", got)
	}
	// 改表达式不应产生一次「按旧表达式算的」补跑。
	if len(fake.fires) != 0 {
		t.Fatalf("改表达式后不应立即触发，实际触发 %d 次", len(fake.fires))
	}
}

func TestReconcileDeletesStaleCursors(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "0 9 * * *")}
	fake.cursors["auto-1"] = store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1", Spec: "0 9 * * *",
		LastFiredAt: mustTimeForTest("2026-09-14T09:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-15T09:00:00Z"),
	}
	// auto-2 已停用或流程已下线：不在 ListCronAutomations 的返回里。
	// 这里刻意只塞游标、不塞自动化——seedCursor 会连带登记自动化，那样就删不掉了。
	fake.cursors["auto-2"] = hourlyCursor("auto-2", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z")
	producer, _ := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Reconciled != 1 {
		t.Fatalf("Reconciled = %d，期望 1（只删了 auto-2）", report.Reconciled)
	}
	if len(fake.deletes) != 1 || len(fake.deletes[0]) != 1 || fake.deletes[0][0] != "auto-2" {
		t.Fatalf("删除列表 = %v，期望只删 auto-2", fake.deletes)
	}
	if _, ok := fake.cursors["auto-1"]; !ok {
		t.Fatal("auto-1 的游标不应被删除")
	}
	if len(fake.fires) != 0 {
		t.Fatalf("被删游标不应触发运行，实际触发 %d 次", len(fake.fires))
	}
}

func TestReconcileStallsInvalidSpecAndKeepsItVisible(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "每天早上九点")}
	producer, _ := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Reconciled != 1 {
		t.Fatalf("Reconciled = %d，期望 1（仍要落一条游标）", report.Reconciled)
	}
	if len(fake.upserts) != 1 {
		t.Fatalf("Upsert 调用 %d 次，期望 1 次", len(fake.upserts))
	}
	if fake.upserts[0].LastError == "" {
		t.Fatal("非法表达式必须落上停滞原因，否则巡检看不到它")
	}
	// 停滞游标不进调度：同一轮里不能触发，下一轮也不行。
	second := producer.Cycle(context.Background())
	if second.Fired != 0 || len(fake.fires) != 0 {
		t.Fatalf("停滞游标不应触发运行，实际触发 %d 次", len(fake.fires))
	}
}

func TestReconcileStallsUnreachableSpec(t *testing.T) {
	fake := newFakeCursors()
	// 2 月没有 30 日：语法合法但永远不会触发。
	fake.automations = []store.CronAutomation{automation("auto-1", "0 0 30 2 *")}
	producer, _ := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Reconciled != 1 || len(fake.upserts) != 1 {
		t.Fatalf("Reconciled = %d, upserts = %d，期望各 1", report.Reconciled, len(fake.upserts))
	}
	if fake.upserts[0].LastError == "" {
		t.Fatal("永不触发的表达式必须落上停滞原因")
	}
}

func TestReconcileDoesNotRetryStalledCursorWithSameSpec(t *testing.T) {
	const spec = "每天早上九点"
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", spec)}
	fake.cursors["auto-1"] = store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1", Spec: spec,
		LastFiredAt: mustTimeForTest("2026-09-14T10:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-14T10:00:00Z"),
		LastError:   "cron 表达式无法解析: ...",
	}
	producer, reported := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Reconciled != 0 || len(fake.upserts) != 0 {
		t.Fatalf("spec 未变时不应反复重试，Reconciled=%d upserts=%d", report.Reconciled, len(fake.upserts))
	}
	if len(*reported) != 0 {
		t.Fatalf("不应上报错误，实际 %v", *reported)
	}
}

func TestReconcileRecoversStalledCursorWhenSpecChanges(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "0 9 * * *")}
	fake.cursors["auto-1"] = store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1", Spec: "每天早上九点",
		LastFiredAt: mustTimeForTest("2026-09-14T10:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-14T10:00:00Z"),
		LastError:   "cron 表达式无法解析: ...",
	}
	producer, _ := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Reconciled != 1 {
		t.Fatalf("Reconciled = %d，期望 1（改好表达式后应恢复）", report.Reconciled)
	}
	if fake.upserts[0].LastError != "" {
		t.Fatalf("恢复后的 LastError = %q，期望清空", fake.upserts[0].LastError)
	}
	if got := fake.upserts[0].NextFireAt.Format(time.RFC3339); got != "2026-09-15T09:00:00Z" {
		t.Fatalf("恢复后的 NextFireAt = %s，期望 2026-09-15T09:00:00Z", got)
	}
}

func TestReconcileUsesConfiguredDefaultLocation(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "0 9 * * *")}
	shanghai, err := time.LoadLocation("Asia/Shanghai")
	if err != nil {
		t.Fatalf("加载时区失败: %v", err)
	}
	producer := NewProducer(fake, shanghai)
	producer.SetClock(func() time.Time { return mustTime(t, "2026-09-14T00:00:00Z") })

	producer.Cycle(context.Background())

	if len(fake.upserts) != 1 {
		t.Fatalf("Upsert 调用 %d 次，期望 1 次", len(fake.upserts))
	}
	// 默认时区是上海时，09:00 就是 UTC 01:00。
	if got := fake.upserts[0].NextFireAt.UTC().Format(time.RFC3339); got != "2026-09-14T01:00:00Z" {
		t.Fatalf("NextFireAt = %s，期望 2026-09-14T01:00:00Z", got)
	}
}

// --- 触发阶段 ---

func TestCycleFiresDueCursorOnce(t *testing.T) {
	fake := newFakeCursors()
	seedCursor(fake, hourlyCursor("auto-1", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z"))
	producer, reported := newTestProducer(t, fake, "2026-09-14T09:00:30Z")

	report := producer.Cycle(context.Background())

	if report.Fired != 1 {
		t.Fatalf("Fired = %d，期望 1", report.Fired)
	}
	if len(*reported) != 0 {
		t.Fatalf("不应上报错误，实际 %v", *reported)
	}
	fire := fake.fires[0]
	if got := fire.Fired.Format(time.RFC3339); got != "2026-09-14T09:00:00Z" {
		t.Fatalf("Fired = %s，期望计划时刻 2026-09-14T09:00:00Z", got)
	}
	if got := fire.Next.Format(time.RFC3339); got != "2026-09-14T10:00:00Z" {
		t.Fatalf("Next = %s，期望 2026-09-14T10:00:00Z", got)
	}

	var payload Payload
	if err := json.Unmarshal(fire.Payload, &payload); err != nil {
		t.Fatalf("负载不是合法 JSON: %v", err)
	}
	if payload.AutomationID != "auto-1" || payload.ProjectID != "proj-1" || payload.Spec != "0 * * * *" {
		t.Fatalf("负载标识 = %+v，期望 auto-1 / proj-1 / 0 * * * *", payload)
	}
	if got := payload.ScheduledFor.Format(time.RFC3339); got != "2026-09-14T09:00:00Z" {
		t.Fatalf("负载 ScheduledFor = %s，期望 2026-09-14T09:00:00Z", got)
	}
	if got := payload.FiredAt.Format(time.RFC3339); got != "2026-09-14T09:00:30Z" {
		t.Fatalf("负载 FiredAt = %s，期望 2026-09-14T09:00:30Z", got)
	}

	// 关键：推进到 now 之后，所以紧接着再来一轮不会重复触发。
	second := producer.Cycle(context.Background())
	if second.Fired != 0 || len(fake.fires) != 1 {
		t.Fatalf("第二轮不应再次触发，Fired=%d 总触发=%d", second.Fired, len(fake.fires))
	}
}

func TestCycleCoalescesMissedFiresIntoOne(t *testing.T) {
	fake := newFakeCursors()
	// 每小时一次，但游标停在 00:00，现在已是 05:30 —— 中间漏了 5 次。
	seedCursor(fake, hourlyCursor("auto-1", "2026-09-14T00:00:00Z", "2026-09-14T01:00:00Z"))
	producer, _ := newTestProducer(t, fake, "2026-09-14T05:30:00Z")

	report := producer.Cycle(context.Background())

	if report.Fired != 1 {
		t.Fatalf("Fired = %d，期望 1（只补最近一次，不重放 5 次）", report.Fired)
	}
	fire := fake.fires[0]
	if got := fire.Fired.Format(time.RFC3339); got != "2026-09-14T05:00:00Z" {
		t.Fatalf("Fired = %s，期望最近一次漏跑 2026-09-14T05:00:00Z", got)
	}
	if got := fire.Next.Format(time.RFC3339); got != "2026-09-14T06:00:00Z" {
		t.Fatalf("Next = %s，期望 2026-09-14T06:00:00Z（now 之后，收住追赶）", got)
	}

	// 不能出现「接下来几轮连续补跑」的爆发。
	for round := 0; round < 5; round++ {
		if extra := producer.Cycle(context.Background()); extra.Fired != 0 {
			t.Fatalf("第 %d 轮又触发了 %d 次，追赶应只发生一次", round+2, extra.Fired)
		}
	}
	if len(fake.fires) != 1 {
		t.Fatalf("总触发 = %d，期望 1", len(fake.fires))
	}
}

func TestCycleFiresNothingWhenNoCursorDue(t *testing.T) {
	fake := newFakeCursors()
	seedCursor(fake, hourlyCursor("auto-1", "2026-09-14T08:00:00Z", "2026-09-14T10:00:00Z"))
	producer, reported := newTestProducer(t, fake, "2026-09-14T09:00:00Z")

	report := producer.Cycle(context.Background())

	if report.Fired != 0 || len(fake.fires) != 0 {
		t.Fatalf("未到期不应触发，Fired=%d fires=%d", report.Fired, len(fake.fires))
	}
	if len(*reported) != 0 {
		t.Fatalf("不应上报错误，实际 %v", *reported)
	}
}

func TestCycleTreatsAlreadyAdvancedCursorAsBenign(t *testing.T) {
	fake := newFakeCursors()
	seedCursor(fake, hourlyCursor("auto-1", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z"))
	fake.fireErr = store.ErrCursorAdvanced
	producer, reported := newTestProducer(t, fake, "2026-09-14T09:00:30Z")

	report := producer.Cycle(context.Background())

	if report.Advanced != 1 {
		t.Fatalf("Advanced = %d，期望 1", report.Advanced)
	}
	if report.Fired != 0 {
		t.Fatalf("Fired = %d，期望 0", report.Fired)
	}
	if len(*reported) != 0 {
		t.Fatalf("被其他副本抢先推进不是故障，不应上报错误，实际 %v", *reported)
	}
}

func TestCycleStallsCursorWhoseSpecStoppedFiring(t *testing.T) {
	fake := newFakeCursors()
	// spec 与协调阶段看到的一致，所以不会被重置；但它永远不会触发。
	fake.automations = []store.CronAutomation{automation("auto-1", "0 0 30 2 *")}
	fake.cursors["auto-1"] = store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1", Spec: "0 0 30 2 *",
		LastFiredAt: mustTimeForTest("2026-09-14T09:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-14T09:00:00Z"),
	}
	producer, reported := newTestProducer(t, fake, "2026-09-14T09:00:30Z")

	report := producer.Cycle(context.Background())

	if report.Stalled != 1 {
		t.Fatalf("Stalled = %d，期望 1", report.Stalled)
	}
	if len(fake.fires) != 0 {
		t.Fatalf("不可调度的游标不应触发，实际 %d 次", len(fake.fires))
	}
	if len(fake.stalls) != 1 {
		t.Fatalf("Stall 调用 %d 次，期望 1 次", len(fake.stalls))
	}
	if len(*reported) == 0 {
		t.Fatal("停滞必须上报，否则运维看不到")
	}
	// 停滞之后不再进调度。
	if next := producer.Cycle(context.Background()); next.Fired != 0 {
		t.Fatalf("停滞游标不应再触发，Fired=%d", next.Fired)
	}
}

func TestCycleStallsCursorWithUnparsableSpec(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "每天早上九点")}
	fake.cursors["auto-1"] = store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1", Spec: "每天早上九点",
		LastFiredAt: mustTimeForTest("2026-09-14T09:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-14T09:00:00Z"),
	}
	producer, reported := newTestProducer(t, fake, "2026-09-14T09:00:30Z")

	report := producer.Cycle(context.Background())

	if report.Stalled != 1 {
		t.Fatalf("Stalled = %d，期望 1", report.Stalled)
	}
	if len(fake.stalls) != 1 || len(*reported) == 0 {
		t.Fatalf("停滞应被记录并上报，stalls=%v reported=%v", fake.stalls, *reported)
	}
}

func TestCycleRecoversInconsistentCursorFromNow(t *testing.T) {
	fake := newFakeCursors()
	fake.automations = []store.CronAutomation{automation("auto-1", "0 9 * * *")}
	// 人为构造不一致：游标到期，但 LastFiredAt 晚于 NextFireAt，
	// 于是 Due 在 (LastFiredAt, now] 里找不到触发时刻。
	fake.cursors["auto-1"] = store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1", Spec: "0 9 * * *",
		LastFiredAt: mustTimeForTest("2026-09-14T09:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-14T08:00:00Z"),
	}
	producer, reported := newTestProducer(t, fake, "2026-09-14T10:00:00Z")

	report := producer.Cycle(context.Background())

	if len(fake.fires) != 0 {
		t.Fatalf("不一致的游标不应触发，实际 %d 次", len(fake.fires))
	}
	if report.Advanced != 1 {
		t.Fatalf("Advanced = %d，期望 1（按 now 重新起步）", report.Advanced)
	}
	if len(fake.upserts) != 1 {
		t.Fatalf("Upsert 调用 %d 次，期望 1 次自愈写入", len(fake.upserts))
	}
	if got := fake.upserts[0].NextFireAt.Format(time.RFC3339); got != "2026-09-15T09:00:00Z" {
		t.Fatalf("自愈后的 NextFireAt = %s，期望 2026-09-15T09:00:00Z", got)
	}
	if len(*reported) == 0 {
		t.Fatal("不一致应上报，否则会被静默吞掉")
	}
}

func TestCycleSurvivesStoreErrors(t *testing.T) {
	cases := []struct {
		name  string
		apply func(*fakeCursors)
	}{
		{"列出自动化失败", func(f *fakeCursors) { f.listErr = errors.New("list boom") }},
		{"读取游标失败", func(f *fakeCursors) { f.loadErr = errors.New("load boom") }},
		{"读取到期游标失败", func(f *fakeCursors) { f.dueErr = errors.New("due boom") }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			fake := newFakeCursors()
			seedCursor(fake, hourlyCursor("auto-1", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z"))
			tc.apply(fake)
			producer, reported := newTestProducer(t, fake, "2026-09-14T09:00:30Z")

			report := producer.Cycle(context.Background())

			if report.Fired != 0 {
				t.Fatalf("存储层报错时不应触发，Fired=%d", report.Fired)
			}
			if len(*reported) == 0 {
				t.Fatal("存储层错误必须上报")
			}
		})
	}
}

func TestCycleReportsFireFailure(t *testing.T) {
	fake := newFakeCursors()
	seedCursor(fake, hourlyCursor("auto-1", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z"))
	fake.fireErr = errors.New("fire boom")
	producer, reported := newTestProducer(t, fake, "2026-09-14T09:00:30Z")

	report := producer.Cycle(context.Background())

	if report.Fired != 0 {
		t.Fatalf("Fired = %d，期望 0", report.Fired)
	}
	if len(*reported) != 1 {
		t.Fatalf("上报错误 %d 次，期望 1 次: %v", len(*reported), *reported)
	}
}

func TestCycleHonoursLimit(t *testing.T) {
	fake := newFakeCursors()
	for _, id := range []string{"auto-1", "auto-2", "auto-3"} {
		seedCursor(fake, hourlyCursor(id, "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z"))
	}
	producer, _ := newTestProducer(t, fake, "2026-09-14T09:00:30Z")
	producer.SetTiming(time.Second, 2)

	report := producer.Cycle(context.Background())

	if report.Fired != 2 {
		t.Fatalf("Fired = %d，期望受 limit=2 限制", report.Fired)
	}
}

func TestCycleHandlesMultipleDueCursors(t *testing.T) {
	fake := newFakeCursors()
	seedCursor(fake, hourlyCursor("auto-1", "2026-09-14T08:00:00Z", "2026-09-14T09:00:00Z"))
	seedCursor(fake, store.Cursor{
		AutomationID: "auto-2", Realm: "realm-1", ProjectID: "proj-1", Spec: "*/15 * * * *",
		LastFiredAt: mustTimeForTest("2026-09-14T09:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-14T09:15:00Z"),
	})
	producer, _ := newTestProducer(t, fake, "2026-09-14T09:20:00Z")

	report := producer.Cycle(context.Background())

	if report.Fired != 2 {
		t.Fatalf("Fired = %d，期望 2", report.Fired)
	}
	byID := map[string]store.Fire{}
	for _, fire := range fake.fires {
		byID[fire.Cursor.AutomationID] = fire
	}
	if got := byID["auto-2"].Fired.Format(time.RFC3339); got != "2026-09-14T09:15:00Z" {
		t.Fatalf("auto-2 的计划时刻 = %s，期望 2026-09-14T09:15:00Z", got)
	}
	if got := byID["auto-2"].Next.Format(time.RFC3339); got != "2026-09-14T09:30:00Z" {
		t.Fatalf("auto-2 的下一次 = %s，期望 2026-09-14T09:30:00Z", got)
	}
}

func TestCycleSpecWithTimezonePrefix(t *testing.T) {
	fake := newFakeCursors()
	seedCursor(fake, store.Cursor{
		AutomationID: "auto-1", Realm: "realm-1", ProjectID: "proj-1",
		Spec:        "CRON_TZ=Asia/Shanghai 0 9 * * *",
		LastFiredAt: mustTimeForTest("2026-09-13T01:00:00Z"),
		NextFireAt:  mustTimeForTest("2026-09-14T01:00:00Z"),
	})
	// 上海 09:00 = UTC 01:00；now 已过 01:00，应触发。
	producer, _ := newTestProducer(t, fake, "2026-09-14T01:00:30Z")

	report := producer.Cycle(context.Background())

	if report.Fired != 1 {
		t.Fatalf("Fired = %d，期望 1", report.Fired)
	}
	fire := fake.fires[0]
	if got := fire.Fired.UTC().Format(time.RFC3339); got != "2026-09-14T01:00:00Z" {
		t.Fatalf("Fired = %s，期望 2026-09-14T01:00:00Z", got)
	}
	if got := fire.Next.UTC().Format(time.RFC3339); got != "2026-09-15T01:00:00Z" {
		t.Fatalf("Next = %s，期望 2026-09-15T01:00:00Z", got)
	}
}

func TestNewProducerDefaults(t *testing.T) {
	producer := NewProducer(newFakeCursors(), nil)
	if got := producer.Location().String(); got != "UTC" {
		t.Fatalf("默认时区 = %q，期望 UTC", got)
	}
	if producer.limit <= 0 || producer.poll <= 0 {
		t.Fatalf("默认 limit=%d poll=%v，都应为正", producer.limit, producer.poll)
	}
	if producer.now == nil {
		t.Fatal("默认时钟不应为 nil")
	}
}

// TestCronPackageIsTheOnlyScheduleAuthority 固定「调度语义只由 cron 包定义」这一点：
// 生产者不自己算钟点，只把 spec 交给 cron.Parse。
func TestCronPackageIsTheOnlyScheduleAuthority(t *testing.T) {
	sched, err := cron.Parse("0 9 * * *", time.UTC)
	if err != nil {
		t.Fatalf("Parse 失败: %v", err)
	}
	next, err := sched.Next(mustTime(t, "2026-09-14T10:00:00Z"))
	if err != nil {
		t.Fatalf("Next 失败: %v", err)
	}
	if got := next.Format(time.RFC3339); got != "2026-09-15T09:00:00Z" {
		t.Fatalf("Next = %s，期望 2026-09-15T09:00:00Z", got)
	}
}

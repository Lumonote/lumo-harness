package indexing

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

// ---- 测试替身 ----
//
// fakeSource 刻意复刻真库的三条语义，否则测试会给出假绿：
//  1. 只返回 dispatched=false 且 attempts < maxAttempts 的行；
//  2. attempts 用尽的终态行直接跳到上限（真库用 CASE WHEN 实现）；
//  3. 已被确认的行不再被 RecordDispatchFailure 改动（真库的 WHERE dispatched = false）。
type fakeSource struct {
	order     []string
	rows      map[string]*fakeRow
	markErr   error
	recordErr error
}

type fakeRow struct {
	pending    store.PendingPublish
	dispatched bool
}

func rowKey(id domain.DocumentID, version int) string { return fmt.Sprintf("%s@%d", id, version) }

func newFakeSource(rows ...store.PendingPublish) *fakeSource {
	f := &fakeSource{rows: map[string]*fakeRow{}}
	for _, r := range rows {
		key := rowKey(r.DocID, r.Version)
		f.order = append(f.order, key)
		f.rows[key] = &fakeRow{pending: r}
	}
	return f
}

func (f *fakeSource) PendingPublishes(_ context.Context, limit, maxAttempts int) ([]store.PendingPublish, error) {
	var out []store.PendingPublish
	for _, key := range f.order {
		if len(out) >= limit {
			break
		}
		r := f.rows[key]
		if r.dispatched || r.pending.Attempts >= maxAttempts {
			continue
		}
		out = append(out, r.pending)
	}
	return out, nil
}

func (f *fakeSource) MarkDispatched(_ context.Context, id domain.DocumentID, version int) error {
	if f.markErr != nil {
		return f.markErr
	}
	r, ok := f.rows[rowKey(id, version)]
	if !ok || r.dispatched {
		return nil
	}
	r.dispatched = true
	return nil
}

func (f *fakeSource) RecordDispatchFailure(_ context.Context, id domain.DocumentID, version int, reason string, maxAttempts int, terminal bool) (int, error) {
	if f.recordErr != nil {
		return 0, f.recordErr
	}
	r, ok := f.rows[rowKey(id, version)]
	if !ok || r.dispatched {
		return 0, nil
	}
	if terminal {
		r.pending.Attempts = maxAttempts
	} else {
		r.pending.Attempts++
	}
	r.pending.Publisher = reason // 借字段存 last_error，测试只关心内容
	return r.pending.Attempts, nil
}

func (f *fakeSource) dispatchedCount() int {
	n := 0
	for _, r := range f.rows {
		if r.dispatched {
			n++
		}
	}
	return n
}

func (f *fakeSource) get(id domain.DocumentID, version int) *fakeRow {
	return f.rows[rowKey(id, version)]
}

type fakeIndexer struct {
	mu     sync.Mutex
	calls  []Ingest
	errFor map[string]error
}

func (f *fakeIndexer) Ingest(_ context.Context, entry Ingest) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls = append(f.calls, entry)
	if f.errFor != nil {
		if err, ok := f.errFor[entry.Doc.DocID]; ok {
			return err
		}
	}
	return nil
}

func (f *fakeIndexer) callCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.calls)
}

func (f *fakeIndexer) lastCall() Ingest {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.calls[len(f.calls)-1]
}

func newRow(id, realm, space, title string, version int, content string) store.PendingPublish {
	return store.PendingPublish{
		DocID: domain.DocumentID(id), Realm: domain.RealmID(realm), Space: domain.SpaceID(space),
		Title: title, Version: version, Publisher: "alice", Content: content,
	}
}

func newTestDispatcher(t *testing.T, source Source, indexer Indexer) *Dispatcher {
	t.Helper()
	d, err := NewDispatcher(source, indexer, "tei-bge-m3")
	if err != nil {
		t.Fatalf("构造调度器失败: %v", err)
	}
	d.SetErrorHandler(func(error) {})
	d.SetCycleHandler(func(Report) {})
	return d
}

// ---- 构造与配置校验 ----

func TestNewDispatcherRejectsInvalidConfig(t *testing.T) {
	source := newFakeSource()
	indexer := &fakeIndexer{}
	cases := []struct {
		name    string
		source  Source
		indexer Indexer
		model   string
	}{
		{"缺来源", nil, indexer, "m"},
		{"缺下游", source, nil, "m"},
		{"缺模型", source, indexer, ""},
		{"模型只有空白", source, indexer, "   "},
	}
	for _, c := range cases {
		if _, err := NewDispatcher(c.source, c.indexer, c.model); err == nil {
			t.Fatalf("%s 必须报错：模型标识写错的表现是检索永远查不到，属于静默失效", c.name)
		}
	}
}

// ---- 正常路径 ----

func TestCycleIndexesAndAcknowledges(t *testing.T) {
	content := "第一段。\n\n第二段。"
	source := newFakeSource(newRow("doc-1", "r1", "s1", "标题一", 3, content))
	indexer := &fakeIndexer{}
	d := newTestDispatcher(t, source, indexer)

	report := d.Cycle(context.Background())
	if report != (Report{Scanned: 1, Indexed: 1}) {
		t.Fatalf("期望 {Scanned:1 Indexed:1}，实得 %+v", report)
	}
	if source.dispatchedCount() != 1 {
		t.Fatal("写入成功后必须确认，否则同一行会被反复投影")
	}
	call := indexer.lastCall()
	if call.Doc.DocID != "doc-1" || call.Doc.Realm != "r1" || call.Doc.Space != "s1" {
		t.Fatalf("投影载荷必须带 outbox 冻结的 realm/space：%+v", call.Doc)
	}
	if call.Doc.Title != "标题一" || call.Doc.SourceVersion != 3 || call.Doc.EmbeddingModel != "tei-bge-m3" {
		t.Fatalf("投影载荷元数据不对：%+v", call.Doc)
	}
	if len(call.Chunks) != 1 || !strings.Contains(call.Chunks[0].Text, "第一段") {
		t.Fatalf("分片内容不对：%+v", call.Chunks)
	}
}

func TestCycleIsIdempotentWhenReplayed(t *testing.T) {
	// 模拟「确认前崩溃」：第二轮再扫到同一行，载荷必须逐字相同，
	// 下游按 (doc_id, chunk_index) upsert 才不会留下错位的旧分片。
	content := "甲\n\n乙\n\n丙"
	source := newFakeSource(newRow("doc-1", "r1", "s1", "t", 1, content))
	indexer := &fakeIndexer{}
	d := newTestDispatcher(t, source, indexer)

	source.markErr = errors.New("确认时连接断开")
	d.Cycle(context.Background())
	source.markErr = nil
	second := d.Cycle(context.Background())

	if second.Indexed != 1 || source.dispatchedCount() != 1 {
		t.Fatalf("重扫必须能补上确认：%+v", second)
	}
	if indexer.callCount() != 2 {
		t.Fatalf("期望两次投影调用，实得 %d", indexer.callCount())
	}
	first := indexer.calls[0]
	again := indexer.calls[1]
	if first.Doc != again.Doc {
		t.Fatalf("重放的文档元数据必须相同：%+v vs %+v", first.Doc, again.Doc)
	}
	if fmt.Sprint(first.Chunks) != fmt.Sprint(again.Chunks) {
		t.Fatal("重放的分片必须逐字相同（分片是内容的纯函数）")
	}
}

func TestCycleScansOnlyUpToLimit(t *testing.T) {
	source := newFakeSource(
		newRow("doc-1", "r1", "s1", "t", 1, "a"),
		newRow("doc-2", "r1", "s1", "t", 1, "b"),
		newRow("doc-3", "r1", "s1", "t", 1, "c"),
	)
	d := newTestDispatcher(t, source, &fakeIndexer{})
	d.SetTiming(time.Second, 2)

	report := d.Cycle(context.Background())
	if report.Scanned != 2 || source.dispatchedCount() != 2 {
		t.Fatalf("批量上限必须生效：%+v dispatched=%d", report, source.dispatchedCount())
	}
}

// ---- 失败与重试 ----

func TestRetryableFailureIsNotAcknowledged(t *testing.T) {
	source := newFakeSource(newRow("doc-1", "r1", "s1", "t", 1, "内容"))
	indexer := &fakeIndexer{errFor: map[string]error{"doc-1": errors.New("连接超时")}}
	d := newTestDispatcher(t, source, indexer)

	report := d.Cycle(context.Background())
	if report.Failed != 1 || report.Indexed != 0 {
		t.Fatalf("可重试失败应记 Failed 且不确认：%+v", report)
	}
	if source.dispatchedCount() != 0 {
		t.Fatal("失败时绝不能确认——确认了就是静默丢失")
	}
	if got := source.get("doc-1", 1).pending.Attempts; got != 1 {
		t.Fatalf("attempts 应为 1，实得 %d", got)
	}
}

func TestRetrySucceedsOnSecondCycle(t *testing.T) {
	source := newFakeSource(newRow("doc-1", "r1", "s1", "t", 1, "内容"))
	indexer := &fakeIndexer{errFor: map[string]error{"doc-1": errors.New("暂时不可用")}}
	d := newTestDispatcher(t, source, indexer)

	d.Cycle(context.Background())
	indexer.errFor = nil
	report := d.Cycle(context.Background())

	if report.Indexed != 1 || source.dispatchedCount() != 1 {
		t.Fatalf("恢复后必须补上：%+v", report)
	}
}

func TestRejectedIsTerminalAndStallsImmediately(t *testing.T) {
	source := newFakeSource(newRow("doc-1", "r1", "s1", "t", 1, "内容"))
	indexer := &fakeIndexer{errFor: map[string]error{"doc-1": fmt.Errorf("%w: seam 返回 400", ErrRejected)}}
	d := newTestDispatcher(t, source, indexer)

	first := d.Cycle(context.Background())
	if first.Rejected != 1 || first.Failed != 0 {
		t.Fatalf("终态拒绝应记 Rejected：%+v", first)
	}
	if got := source.get("doc-1", 1).pending.Attempts; got != defaultMaxAttempts {
		t.Fatalf("终态应直接跳到上限 %d，实得 %d（否则会白烧 embedding 调用）", defaultMaxAttempts, got)
	}
	// 第二轮不该再取到它。
	if second := d.Cycle(context.Background()); second.Scanned != 0 {
		t.Fatalf("停滞行不应再被扫描：%+v", second)
	}
}

func TestStalledRowDoesNotStarveLaterRows(t *testing.T) {
	// 这是「attempts 用尽即移出扫描」的真正理由：一条永久失败的行如果一直占着
	// 批量配额，它后面所有新发布都会被饿死。
	stalled := newRow("doc-stalled", "r1", "s1", "t", 1, "坏内容")
	stalled.Attempts = defaultMaxAttempts
	source := newFakeSource(stalled, newRow("doc-new", "r1", "s1", "t", 1, "好内容"))
	d := newTestDispatcher(t, source, &fakeIndexer{})

	report := d.Cycle(context.Background())
	if report.Scanned != 1 || report.Indexed != 1 {
		t.Fatalf("停滞行必须让位给新行：%+v", report)
	}
	if !source.get("doc-new", 1).dispatched {
		t.Fatal("新行应被正常投影")
	}
}

func TestFailingRowDoesNotBlockTheRestOfTheBatch(t *testing.T) {
	source := newFakeSource(
		newRow("doc-bad", "r1", "s1", "t", 1, "坏"),
		newRow("doc-good", "r1", "s1", "t", 1, "好"),
	)
	indexer := &fakeIndexer{errFor: map[string]error{"doc-bad": errors.New("坏了")}}
	d := newTestDispatcher(t, source, indexer)

	report := d.Cycle(context.Background())
	if report.Scanned != 2 || report.Indexed != 1 || report.Failed != 1 {
		t.Fatalf("单行失败不得中断本轮（队头阻塞）：%+v", report)
	}
	if !source.get("doc-good", 1).dispatched {
		t.Fatal("失败行后面的行仍必须被处理")
	}
}

func TestRecordFailureErrorIsReportedNotSwallowed(t *testing.T) {
	source := newFakeSource(newRow("doc-1", "r1", "s1", "t", 1, "内容"))
	source.recordErr = errors.New("数据库不可用")
	indexer := &fakeIndexer{errFor: map[string]error{"doc-1": errors.New("下游失败")}}

	var reported []error
	d := newTestDispatcher(t, source, indexer)
	d.SetErrorHandler(func(err error) { reported = append(reported, err) })

	d.Cycle(context.Background())
	found := false
	for _, err := range reported {
		if strings.Contains(err.Error(), "记录投影失败失败") {
			found = true
		}
	}
	if !found {
		t.Fatalf("记录失败本身失败必须被上报，否则 attempts 永远不涨、死循环：%v", reported)
	}
}

func TestStallIsReportedExactlyOnce(t *testing.T) {
	source := newFakeSource(newRow("doc-1", "r1", "s1", "t", 1, "内容"))
	indexer := &fakeIndexer{errFor: map[string]error{"doc-1": errors.New("一直失败")}}

	var stalls int
	d := newTestDispatcher(t, source, indexer)
	d.SetMaxAttempts(3)
	d.SetErrorHandler(func(err error) {
		if strings.Contains(err.Error(), "已停滞") {
			stalls++
		}
	})

	for i := 0; i < 6; i++ {
		d.Cycle(context.Background())
	}
	if stalls != 1 {
		t.Fatalf("停滞只应上报一次，实得 %d 次", stalls)
	}
	if got := source.get("doc-1", 1).pending.Attempts; got != 3 {
		t.Fatalf("attempts 应停在上限 3，实得 %d", got)
	}
}

func TestCycleStopsOnContextCancellation(t *testing.T) {
	source := newFakeSource(
		newRow("doc-1", "r1", "s1", "t", 1, "a"),
		newRow("doc-2", "r1", "s1", "t", 1, "b"),
	)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	d := newTestDispatcher(t, source, &fakeIndexer{})

	report := d.Cycle(ctx)
	if report.Indexed != 0 || source.dispatchedCount() != 0 {
		t.Fatalf("已取消的上下文不应继续投影：%+v", report)
	}
}

// ---- 载荷构造 ----

func TestBuildFallsBackToDocIDForEmptyTitle(t *testing.T) {
	// host 对 title 做非空校验；空标题的文档若不回落就会被永远拒绝。
	source := newFakeSource(newRow("doc-1", "r1", "s1", "", 1, "内容"))
	indexer := &fakeIndexer{}
	d := newTestDispatcher(t, source, indexer)

	if report := d.Cycle(context.Background()); report.Indexed != 1 {
		t.Fatalf("空标题应回落到 docId 而不是失败：%+v", report)
	}
	if got := indexer.lastCall().Doc.Title; got != "doc-1" {
		t.Fatalf("期望回落为 doc-1，实得 %q", got)
	}
}

func TestBuildRejectsMissingRealmOrSpaceLocally(t *testing.T) {
	// 本地先挡：这两个字段是 host 的非空校验项，缺了必然是 400，
	// 提前拒绝可以省掉一次 embedding 往返。
	source := newFakeSource(
		newRow("doc-1", "", "s1", "t", 1, "内容"),
		newRow("doc-2", "r1", "", "t", 1, "内容"),
	)
	indexer := &fakeIndexer{}
	d := newTestDispatcher(t, source, indexer)

	report := d.Cycle(context.Background())
	if report.Rejected != 2 || report.Scanned != 2 {
		t.Fatalf("期望两行都被本地拒绝：%+v", report)
	}
	if indexer.callCount() != 0 {
		t.Fatalf("本地拒绝不应发起网络调用，实得 %d 次", indexer.callCount())
	}
	if source.dispatchedCount() != 0 {
		t.Fatal("被拒绝的行不得被确认")
	}
}

func TestBuildEmptyContentProducesZeroChunks(t *testing.T) {
	// 发布一个空文档是合法的；它应当清掉旧投影而不是写入一个空文本分片。
	source := newFakeSource(newRow("doc-1", "r1", "s1", "t", 2, ""))
	indexer := &fakeIndexer{}
	d := newTestDispatcher(t, source, indexer)

	if report := d.Cycle(context.Background()); report.Indexed != 1 {
		t.Fatalf("空正文应当成功投影（零分片）：%+v", report)
	}
	if chunks := indexer.lastCall().Chunks; chunks != nil {
		t.Fatalf("空正文必须产生零分片，实得 %#v", chunks)
	}
}

// ---- 循环 ----

func TestRunReportsEachCycleAndStopsOnCancel(t *testing.T) {
	source := newFakeSource(newRow("doc-1", "r1", "s1", "t", 1, "内容"))
	d := newTestDispatcher(t, source, &fakeIndexer{})
	d.SetTiming(5*time.Millisecond, 10)

	var cycles int
	done := make(chan struct{})
	d.SetCycleHandler(func(r Report) {
		if r.Indexed > 0 {
			cycles++
			close(done)
		}
	})

	ctx, cancel := context.WithCancel(context.Background())
	go d.Run(ctx)
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		cancel()
		t.Fatal("Run 未在预期时间内完成一轮派发")
	}
	cancel()
}

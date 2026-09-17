package integration_test

// 发布 outbox → 知识库投影（A3）的真 PG 集成。
//
// 只有**一个**用例，而且是刻意的：本机与 CI 的资源都有限，每多一个用例就多一个
// schema + 连接池。fake 单测（internal/indexing，35 条）已经把分片确定性、幂等重放、
// 确认时序、重试与停滞策略全覆盖了；这里只放「只有真库能确认」的三件事：
//
//  1. realm/space/title 真的从 outbox 行与 collab_documents 里取出来（这是 A3 说的
//     exact snapshot/realm/space propagation，fake 里是测试自己填的，证明不了 SQL）；
//  2. MarkDispatched 真的把行从待派发集合里去掉（idempotent indexing 的确认面）；
//  3. attempts 上限真的把停滞行移出扫描，且终态一次跳到上限（retry acknowledgment）。
//
// 另加一条 SQL 里 WHERE 的口径：跨 realm 的行不会互相串（realm 是首要授权边界）。

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/collaborator/internal/domain"
	"github.com/lumo-harness/platform/collaborator/internal/store"
)

func newPGStore(t *testing.T) (*store.Store, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 collaborator 集成测试")
	}
	schema := fmt.Sprintf("collab_int_%d", time.Now().UnixNano())
	admin, err := pgxpool.New(context.Background(), dsn)
	if err != nil {
		t.Fatalf("admin: %v", err)
	}
	if _, err := admin.Exec(context.Background(), "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("建 schema: %v", err)
	}
	admin.Close()

	u, err := url.Parse(dsn)
	if err != nil {
		t.Fatalf("解析 DSN: %v", err)
	}
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	pool, err := pgxpool.New(context.Background(), u.String())
	if err != nil {
		t.Fatalf("连接: %v", err)
	}
	t.Cleanup(pool.Close)

	// 只走 PG：发布 outbox 的路径不碰 Redis，所以不需要真 Redis 才能验它。
	st := store.NewPGOnly(pool)
	if err := st.Init(context.Background()); err != nil {
		t.Fatalf("init: %v", err)
	}
	return st, pool
}

// 上限取小值让用例短：语义与生产一致，只是不用跑 8 轮。
const testMaxAttempts = 3

func TestPublishOutboxPropagationAndRetry(t *testing.T) {
	st, _ := newPGStore(t)
	ctx := context.Background()

	docA := domain.Document{ID: "doc-a", Realm: "r1", Space: "s1", Title: "设计文档"}
	docB := domain.Document{ID: "doc-b", Realm: "r2", Space: "s2", Title: ""}
	for _, d := range []domain.Document{docA, docB} {
		if err := st.EnsureDocument(ctx, d); err != nil {
			t.Fatalf("登记文档 %s: %v", d.ID, err)
		}
	}

	// 同一文档发两个版本：outbox 顺序必须等于版本顺序，否则下游会先写新后写旧。
	if _, err := st.Publish(ctx, docA, "alice", "v1 正文\n\n[参考](docs/x.md)"); err != nil {
		t.Fatalf("发布 v1: %v", err)
	}
	if _, err := st.Publish(ctx, docA, "alice", "v2 正文"); err != nil {
		t.Fatalf("发布 v2: %v", err)
	}
	if _, err := st.Publish(ctx, docB, "bob", "另一个租户的正文"); err != nil {
		t.Fatalf("发布 doc-b: %v", err)
	}

	pending, err := st.PendingPublishes(ctx, 10, testMaxAttempts)
	if err != nil {
		t.Fatalf("读待派发: %v", err)
	}
	if len(pending) != 3 {
		t.Fatalf("期望 3 条待派发，实得 %d", len(pending))
	}

	// 判据 1：realm/space/title 必须逐字来自 outbox 与 collab_documents。
	first := pending[0]
	if first.DocID != docA.ID || first.Realm != docA.Realm || first.Space != docA.Space || first.Title != docA.Title {
		t.Fatalf("首条事件的 realm/space/title 未正确传播: %+v", first)
	}
	if first.Version != 1 || first.Publisher != "alice" {
		t.Fatalf("首条事件版本/发布者不对: %+v", first)
	}
	if first.Content != "v1 正文\n\n[参考](docs/x.md)" {
		t.Fatalf("首条事件正文必须与快照一致（铁律 17：只投影发布态）: %q", first.Content)
	}
	if pending[1].Version != 2 {
		t.Fatalf("第二条应是 v2（按 outbox 写入顺序）: %+v", pending[1])
	}
	// 跨 realm 不串：doc-b 带的是它自己的 realm/space。
	if pending[2].Realm != "r2" || pending[2].Space != "s2" {
		t.Fatalf("跨 realm 事件串了: %+v", pending[2])
	}

	// 判据 2：确认之后该行必须从待派发集合里消失。
	if err := st.MarkDispatched(ctx, docA.ID, 1); err != nil {
		t.Fatalf("确认 v1: %v", err)
	}
	pending, err = st.PendingPublishes(ctx, 10, testMaxAttempts)
	if err != nil {
		t.Fatalf("读待派发: %v", err)
	}
	if len(pending) != 2 {
		t.Fatalf("确认后应剩 2 条，实得 %d", len(pending))
	}
	for _, p := range pending {
		if p.DocID == docA.ID && p.Version == 1 {
			t.Fatal("已确认的 v1 仍在待派发集合里，会导致重复投影")
		}
	}
	// 重复确认必须是幂等的（重扫补偿路径会再确认一次）。
	if err := st.MarkDispatched(ctx, docA.ID, 1); err != nil {
		t.Fatalf("重复确认应幂等: %v", err)
	}
	// 确认不存在的行不是错误（重放时可能已被别的副本确认掉）。
	if err := st.MarkDispatched(ctx, "doc-missing", 1); err != nil {
		t.Fatalf("确认未知行不应报错: %v", err)
	}

	// 判据 3：可重试失败累加 attempts，达到上限后移出扫描。
	for i := 1; i <= testMaxAttempts; i++ {
		attempts, err := st.RecordDispatchFailure(ctx, docA.ID, 2, "下游超时", testMaxAttempts, false)
		if err != nil {
			t.Fatalf("第 %d 次记录失败: %v", i, err)
		}
		if attempts != i {
			t.Fatalf("第 %d 次记录后 attempts 应为 %d，实得 %d", i, i, attempts)
		}
	}
	pending, err = st.PendingPublishes(ctx, 10, testMaxAttempts)
	if err != nil {
		t.Fatalf("读待派发: %v", err)
	}
	for _, p := range pending {
		if p.DocID == docA.ID && p.Version == 2 {
			t.Fatal("attempts 用尽的停滞行仍在扫描范围内，会长期占据批量配额并饿死新发布")
		}
	}

	// 终态一次跳到上限：新发一版并直接判终态。
	if _, err := st.Publish(ctx, docA, "alice", "v3 正文"); err != nil {
		t.Fatalf("发布 v3: %v", err)
	}
	attempts, err := st.RecordDispatchFailure(ctx, docA.ID, 3, "载荷非法", testMaxAttempts, true)
	if err != nil {
		t.Fatalf("记录终态失败: %v", err)
	}
	if attempts != testMaxAttempts {
		t.Fatalf("终态应一次跳到上限 %d，实得 %d（否则会白烧 embedding 调用）", testMaxAttempts, attempts)
	}
	pending, err = st.PendingPublishes(ctx, 10, testMaxAttempts)
	if err != nil {
		t.Fatalf("读待派发: %v", err)
	}
	for _, p := range pending {
		if p.DocID == docA.ID {
			t.Fatalf("doc-a 的行都应已停滞/确认，实得 %+v", p)
		}
	}
	// 跨 realm 的那条不受影响：一个租户的坏行不能连坐别的租户。
	found := false
	for _, p := range pending {
		if p.DocID == docB.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("doc-b 的待派发行被误伤: %+v", pending)
	}

	// 对已确认的行记录失败必须是空操作（真库的 WHERE dispatched = false）。
	attempts, err = st.RecordDispatchFailure(ctx, docA.ID, 1, "迟到的失败", testMaxAttempts, false)
	if err != nil {
		t.Fatalf("对已确认行记录失败: %v", err)
	}
	if attempts != 0 {
		t.Fatalf("已确认的行不应被改动，实得 attempts=%d", attempts)
	}
}

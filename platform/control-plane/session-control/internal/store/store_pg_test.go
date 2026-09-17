// 活库用例（门控 LUMO_TEST_PG_DSN）：验证只有真 PostgreSQL 才能验证的东西。
//
// 尤其是 `FOR UPDATE` + revision 比较这一对——它是「跨实例仲裁」的全部依据，而内存
// 假实现无论怎么写都只是把它**照抄**一遍（照抄的是我的理解，不是数据库的行为）。
package store

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/session-control/internal/state"
)

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 session-control 存储层测试（真 PG）")
	}
	return dsn
}

// newStore 用独立 schema + 建表，同包各用例互不干扰。
func newStore(t *testing.T) *Store {
	t.Helper()
	ctx := context.Background()
	base := testDSN(t)
	schema := fmt.Sprintf("sc_%d", time.Now().UnixNano())

	admin, err := pgxpool.New(ctx, base)
	if err != nil {
		t.Fatalf("admin: %v", err)
	}
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+schema); err != nil {
		t.Fatalf("建 schema: %v", err)
	}
	admin.Close()

	u, err := url.Parse(base)
	if err != nil {
		t.Fatalf("解析 DSN: %v", err)
	}
	q := u.Query()
	q.Set("options", "-c search_path="+schema)
	u.RawQuery = q.Encode()
	pool, err := pgxpool.New(ctx, u.String())
	if err != nil {
		t.Fatalf("连接: %v", err)
	}
	t.Cleanup(pool.Close)

	st := New(pool)
	if err := st.Init(ctx); err != nil {
		t.Fatalf("建表: %v", err)
	}
	return st
}

func applyCommit(sessionRef, realm string, from, to state.State, expected int64) Commit {
	return Commit{
		SessionRef: sessionRef, Realm: realm, Actor: "u-7", ActorRole: "operator",
		Command: state.CmdPause, ExpectedRevision: expected,
		ChangeState: true, ToState: to, Outcome: "applied",
		FromState: from, CorrelationID: "corr-1",
	}
}

func TestFirstEffectiveCommandCreatesStateRow(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	if _, err := st.Load(ctx, "s1"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("未登记会话应返回 ErrNotFound（而不是编造的 running），实际 %v", err)
	}

	res, err := st.Commit(ctx, applyCommit("s1", "dev", state.StateRunning, state.StatePaused, 0))
	if err != nil {
		t.Fatalf("提交失败: %v", err)
	}
	if res.Row.Revision != 1 || res.Row.State != state.StatePaused || res.Row.Realm != "dev" {
		t.Fatalf("建行结果不符：%+v", res.Row)
	}
	if res.AuditID == 0 {
		t.Fatal("审计行必须落库并回传 id")
	}

	row, err := st.Load(ctx, "s1")
	if err != nil {
		t.Fatalf("读回失败: %v", err)
	}
	if row.State != state.StatePaused || row.Revision != 1 || row.LastCommand != state.CmdPause {
		t.Fatalf("读回不符：%+v", row)
	}
}

// TestRejectedOutcomeOnUnknownSessionWritesAuditButNoStateRow 是「拒绝不得建行」的
// 活库证明：状态行的 realm 写后不可变，建行等于确定该会话的隔离边界，而一次被拒的
// 尝试不该有这种权力（否则任何人可以用一条 realm 写错的请求把别人的会话抢过来绑住）。
func TestRejectedOutcomeOnUnknownSessionWritesAuditButNoStateRow(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	_, err := st.Commit(ctx, Commit{
		SessionRef: "s1", Realm: "realm-b", Actor: "attacker", ActorRole: "operator",
		Command: state.CmdAbort, ExpectedRevision: 0, ChangeState: false,
		Outcome: "policy_denied", Reason: "role 未授权", FromState: state.StateRunning,
	})
	if err != nil {
		t.Fatalf("纯审计路径不该报错: %v", err)
	}
	if _, err := st.Load(ctx, "s1"); !errors.Is(err, ErrNotFound) {
		t.Fatal("被拒的尝试**不得**建立状态行")
	}
	events, err := st.Timeline(ctx, "s1", 0, 10)
	if err != nil {
		t.Fatalf("读时间线失败: %v", err)
	}
	if len(events) != 1 || events[0].Outcome != "policy_denied" || events[0].Reason != "role 未授权" {
		t.Fatalf("拒绝必须留审计（含原因），实际 %+v", events)
	}
	// 时间线上这一条的 to_state 应等于起点（它什么都没改）。
	if events[0].ToState != string(state.StateRunning) || events[0].Revision != 0 {
		t.Fatalf("纯审计行的落点/版本不符：%+v", events[0])
	}
}

func TestRealmMismatchIsRefusedAndStateUntouched(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	if _, err := st.Commit(ctx, applyCommit("s1", "realm-a", state.StateRunning, state.StatePaused, 0)); err != nil {
		t.Fatalf("首次提交失败: %v", err)
	}
	_, err := st.Commit(ctx, applyCommit("s1", "realm-b", state.StatePaused, state.StateStopped, 1))
	if !errors.Is(err, ErrRealmMismatch) {
		t.Fatalf("跨 realm 必须被拒，实际 %v", err)
	}
	row, _ := st.Load(ctx, "s1")
	if row.State != state.StatePaused || row.Realm != "realm-a" {
		t.Fatalf("被拒的跨 realm 提交改了东西：%+v", row)
	}
}

// TestStaleRevisionIsRefusedWithoutSideEffects 覆盖 CAS 的失败分支：
// 版本不符时**状态与审计都不能变**——一次基于过期前提的决定不该留下任何痕迹。
func TestStaleRevisionIsRefusedWithoutSideEffects(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	if _, err := st.Commit(ctx, applyCommit("s1", "dev", state.StateRunning, state.StatePaused, 0)); err != nil {
		t.Fatalf("首次提交失败: %v", err)
	}
	_, err := st.Commit(ctx, applyCommit("s1", "dev", state.StateRunning, state.StateStopped, 0)) // 仍按 revision 0
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("过期前提必须返回 ErrConflict，实际 %v", err)
	}
	row, _ := st.Load(ctx, "s1")
	if row.State != state.StatePaused || row.Revision != 1 {
		t.Fatalf("冲突提交改了状态：%+v", row)
	}
	events, _ := st.Timeline(ctx, "s1", 0, 10)
	if len(events) != 1 {
		t.Fatalf("冲突提交不该留下审计行，实际 %d 条", len(events))
	}
}

// TestConcurrentCommitsOnSameRevisionOnlyOneWins 是本文件里最重要的一条：它测的是
// **数据库**能不能真的串行化，而不是我们的代码看起来对不对。
//
// 两个实例都读到 revision 0，各自算出一个结论，然后同时提交。正确的结果是恰好一个
// 成功：库行锁让它们串行，第二个的比较失败并拿到 ErrConflict（然后重读重试）。
// 若少了 `FOR UPDATE`，两者都能读到 revision 0 并双双提交成功——审计里两条 applied，
// 而实际只生效了一条，这正是本服务要防的丢失更新。
func TestConcurrentCommitsOnSameRevisionOnlyOneWins(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()
	if _, err := st.Commit(ctx, applyCommit("s1", "dev", state.StateRunning, state.StatePaused, 0)); err != nil {
		t.Fatalf("建行失败: %v", err)
	}

	const rounds = 8
	for round := 0; round < rounds; round++ {
		row, err := st.Load(ctx, "s1")
		if err != nil {
			t.Fatalf("读状态失败: %v", err)
		}
		start := make(chan struct{})
		var (
			wg      sync.WaitGroup
			mu      sync.Mutex
			okCount int
			conflic int
		)
		for i := 0; i < 2; i++ {
			wg.Add(1)
			go func(i int) {
				defer wg.Done()
				<-start
				in := applyCommit("s1", "dev", row.State, state.StatePaused, row.Revision)
				// 两条指令模拟「两个实例各算出一个结论」：一个 pause、一个 stop。
				if i == 1 {
					in.ToState = state.StateStopped
					in.Command = state.CmdStop
				}
				_, err := st.Commit(ctx, in)
				mu.Lock()
				defer mu.Unlock()
				switch {
				case err == nil:
					okCount++
				case errors.Is(err, ErrConflict):
					conflic++
				default:
					t.Errorf("意外错误: %v", err)
				}
			}(i)
		}
		close(start)
		wg.Wait()

		if okCount != 1 || conflic != 1 {
			t.Fatalf("第 %d 轮：应恰好一条成功、一条冲突，实际 成功=%d 冲突=%d", round, okCount, conflic)
		}
		after, _ := st.Load(ctx, "s1")
		if after.Revision != row.Revision+1 {
			t.Fatalf("第 %d 轮：revision 应恰好 +1（%d → %d）", round, row.Revision, after.Revision)
		}
	}
}

// TestTimelinePagingIncludesRejections：时间线是控制台与审计共用的读面，
// 它必须按 id 升序、游标可翻页，且**含被拒的那些**（只记成功的审计等于没有审计）。
func TestTimelinePagingIncludesRejections(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	revision := int64(0)
	from := state.StateRunning
	// pause → 生效；pause again → noop；stop after... 造几条不同类型的记录。
	if _, err := st.Commit(ctx, applyCommit("s1", "dev", from, state.StatePaused, revision)); err != nil {
		t.Fatalf("提交失败: %v", err)
	}
	// 被拒的那条（不改状态）。
	if _, err := st.Commit(ctx, Commit{
		SessionRef: "s1", Realm: "dev", Actor: "u-9", ActorRole: "operator",
		Command: state.CmdApprove, ExpectedRevision: 1, ChangeState: false,
		Outcome: "state_rejected", Reason: "仅在 awaiting-approval 状态可 approve",
		FromState: state.StatePaused,
	}); err != nil {
		t.Fatalf("提交被拒记录失败: %v", err)
	}
	// 另一条会话的记录不得混进来。
	if _, err := st.Commit(ctx, applyCommit("s2", "dev", state.StateRunning, state.StatePaused, 0)); err != nil {
		t.Fatalf("提交 s2 失败: %v", err)
	}

	page1, err := st.Timeline(ctx, "s1", 0, 1)
	if err != nil {
		t.Fatalf("读时间线失败: %v", err)
	}
	if len(page1) != 1 || page1[0].Outcome != "applied" {
		t.Fatalf("第一页不符：%+v", page1)
	}
	page2, err := st.Timeline(ctx, "s1", page1[0].ID, 10)
	if err != nil {
		t.Fatalf("翻页失败: %v", err)
	}
	if len(page2) != 1 || page2[0].Outcome != "state_rejected" {
		t.Fatalf("第二页应是被拒的那条（含原因），实际 %+v", page2)
	}
	if page2[0].Reason == "" || page2[0].Actor != "u-9" {
		t.Fatalf("被拒的记录必须带原因与主体：%+v", page2[0])
	}
	if page2[0].ID <= page1[0].ID {
		t.Fatal("时间线必须按 id 升序（游标才能翻页）")
	}
}

// TestConcurrentFirstCommandsDoNotOverwriteRealm：两条并发的首指令只有一个能建立
// realm，另一个要么命中相同 realm（都成功），要么被 realm 隔离拒掉——绝不能出现
// 「后到者把 realm 改掉」。
func TestConcurrentFirstCommandsDoNotOverwriteRealm(t *testing.T) {
	st := newStore(t)
	ctx := context.Background()

	start := make(chan struct{})
	var wg sync.WaitGroup
	for i, realm := range []string{"realm-a", "realm-b"} {
		wg.Add(1)
		go func(i int, realm string) {
			defer wg.Done()
			<-start
			in := applyCommit("s1", realm, state.StateRunning, state.StatePaused, 0)
			_, err := st.Commit(ctx, in)
			if err != nil && !errors.Is(err, ErrConflict) && !errors.Is(err, ErrRealmMismatch) {
				t.Errorf("realm=%s 意外错误: %v", realm, err)
			}
		}(i, realm)
	}
	close(start)
	wg.Wait()

	row, err := st.Load(ctx, "s1")
	if err != nil {
		t.Fatalf("读回失败: %v", err)
	}
	if row.Realm != "realm-a" && row.Realm != "realm-b" {
		t.Fatalf("realm 必须是两个主张者之一，实际 %q", row.Realm)
	}
	// 建立之后不可变：再来一次不同 realm 的尝试必须被拒。
	other := "realm-a"
	if row.Realm == "realm-a" {
		other = "realm-b"
	}
	if _, err := st.Commit(ctx, applyCommit("s1", other, row.State, state.StateStopped, row.Revision)); !errors.Is(err, ErrRealmMismatch) {
		t.Fatalf("已确立的 realm 必须不可变，实际 %v", err)
	}
}

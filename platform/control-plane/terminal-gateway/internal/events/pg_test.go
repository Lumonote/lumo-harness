package events

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// 活库用例的入口闸：无 DSN 时跳过（离线环境友好）。跳过**不是通过** ——
// `test-local-pg.sh` 会断言每一步至少执行了 1 个非跳过用例。
func testPool(t *testing.T) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过终端的会话日志事件源测试（真 PG）")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatalf("连接 PG 失败: %v", err)
	}
	t.Cleanup(pool.Close)
	if _, err := pool.Exec(ctx, sessionLogDDL); err != nil {
		t.Fatalf("建 session_log 失败: %v", err)
	}
	return pool
}

// sessionLogDDL 是读侧依赖的那部分 schema。
//
// ⚠️ 这是**手抄**自 `dsh-plugins/session-log/src/pg-log.ts` 的建表语句。跨语言没法共用
// 一份声明，所以这里有一条真实的漂移风险：插件改了列名而这里没跟，本测试照样绿，直到
// 部署上第一次回放才报错。缓解它的不是注释而是下面那个「列名可被 SELECT 到」的用例 ——
// 它把「读侧用到的每一列都真的存在」变成一条会红的断言，而不是一句约定。
const sessionLogDDL = `
CREATE TABLE IF NOT EXISTS session_log (
  session_ref   TEXT   NOT NULL,
  seq           BIGINT NOT NULL,
  fencing_token BIGINT NOT NULL,
  event_type    TEXT   NOT NULL,
  payload       TEXT   NOT NULL,
  digest        TEXT   NOT NULL,
  event_time    BIGINT NOT NULL,
  appended_at   BIGINT NOT NULL,
  PRIMARY KEY (session_ref, seq)
);
CREATE TABLE IF NOT EXISTS session_writer_lease (
  session_ref   TEXT   PRIMARY KEY,
  holder        TEXT   NOT NULL,
  fencing_token BIGINT NOT NULL,
  expires_at    BIGINT NOT NULL
);`

func seedLog(t *testing.T, pool *pgxpool.Pool, sessionRef string, from, to int64) {
	t.Helper()
	ctx := context.Background()
	for seq := from; seq <= to; seq++ {
		_, err := pool.Exec(ctx,
			`INSERT INTO session_log (session_ref,seq,fencing_token,event_type,payload,digest,event_time,appended_at)
			 VALUES ($1,$2,1,'turn/start',$3,$4,$5,$5) ON CONFLICT DO NOTHING`,
			sessionRef, seq, `{"seq":`+strconv.FormatInt(seq, 10)+`}`, "digest-"+strconv.FormatInt(seq, 10), seq)
		if err != nil {
			t.Fatalf("插第 %d 条失败: %v", seq, err)
		}
	}
}

// TestPgReadsUseColumnsThatExist 是上面那段 DDL 的防漂移断言：读侧真正 SELECT 的
// 三列 + 排序键必须都在。列被改名时这里先红，而不是等到部署上回放出错。
func TestPgReadsUseColumnsThatExist(t *testing.T) {
	pool := testPool(t)
	ctx := context.Background()
	for _, col := range []string{"seq", "event_type", "payload"} {
		var found bool
		err := pool.QueryRow(ctx,
			`SELECT EXISTS (SELECT 1 FROM information_schema.columns
			                WHERE table_name='session_log' AND column_name=$1)`, col).Scan(&found)
		if err != nil {
			t.Fatalf("查列失败: %v", err)
		}
		if !found {
			t.Fatalf("读侧 SELECT 了 session_log.%s，但该列不存在（插件 schema 改了？）", col)
		}
	}
}

func TestPgHistoryReturnsOnlyAfterCursorInOrder(t *testing.T) {
	pool := testPool(t)
	src, err := NewPg(Options{Pool: pool})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	ctx := context.Background()
	ref := "sess-history-" + time.Now().Format("150405.000000")
	seedLog(t, pool, ref, 1, 5)

	all, err := src.History(ctx, ref, 0)
	if err != nil {
		t.Fatalf("History 失败: %v", err)
	}
	if len(all) != 5 {
		t.Fatalf("游标 0 应拿到全部 5 条，实得 %d", len(all))
	}
	for i, ev := range all {
		if ev.Seq != int64(i+1) {
			t.Fatalf("第 %d 条 seq 应为 %d，实得 %d（顺序必须严格升序）", i, i+1, ev.Seq)
		}
		if ev.SessionRef != ref {
			t.Fatalf("session_ref 应为 %s，实得 %s", ref, ev.SessionRef)
		}
		if ev.Type != "turn/start" {
			t.Fatalf("event_type 未透传，实得 %q", ev.Type)
		}
	}

	// 游标是**排他**的：seq=3 已看过，不该再回来。
	after, err := src.History(ctx, ref, 3)
	if err != nil {
		t.Fatalf("History 失败: %v", err)
	}
	if len(after) != 2 || after[0].Seq != 4 {
		t.Fatalf("游标 3 之后应为 seq 4,5，实得 %d 条且首条 seq=%d", len(after), after[0].Seq)
	}
}

func TestPgLatestSeqTracksMax(t *testing.T) {
	pool := testPool(t)
	src, _ := NewPg(Options{Pool: pool})
	ctx := context.Background()
	ref := "sess-head-" + time.Now().Format("150405.000000")

	// 未知会话必须是 0，不是错误：终端问一个还没有事件的会话是正常路径。
	seq, err := src.LatestSeq(ctx, ref)
	if err != nil {
		t.Fatalf("未知会话不应报错: %v", err)
	}
	if seq != 0 {
		t.Fatalf("未知会话的水位应为 0，实得 %d", seq)
	}

	seedLog(t, pool, ref, 1, 3)
	if seq, err = src.LatestSeq(ctx, ref); err != nil || seq != 3 {
		t.Fatalf("水位应为 3，实得 %d（err=%v）", seq, err)
	}
}

func TestPgHistoryRejectsNegativeCursor(t *testing.T) {
	pool := testPool(t)
	src, _ := NewPg(Options{Pool: pool})
	if _, err := src.History(context.Background(), "any", -1); err == nil {
		t.Fatal("负游标必须被拒：契约里 since<0 视为非法")
	}
}

// 超限必须**报错**。静默截断会让终端把「只回放了前 N 条」显示成「这个会话就这么多」——
// 与 §8.2 禁止的「伪造空历史」是同一类谎，而且它长得完全正常。
func TestPgHistoryRefusesToSilentlyTruncate(t *testing.T) {
	pool := testPool(t)
	src, err := NewPg(Options{Pool: pool, MaxReplay: 2})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	ctx := context.Background()
	ref := "sess-cap-" + time.Now().Format("150405.000000")
	seedLog(t, pool, ref, 1, 4)

	_, err = src.History(ctx, ref, 0)
	if err == nil {
		t.Fatal("4 条 > 上限 2，必须报错而不是返回前 2 条")
	}
	if !strings.Contains(err.Error(), "上限") {
		t.Fatalf("错误必须说清是「上限」而不是终点，实得: %v", err)
	}
	// 边界：恰好等于上限不该报错（多取一条是为了区分「正好读完」与「后面还有」）。
	if _, err := src.History(ctx, ref, 2); err != nil {
		t.Fatalf("恰好 2 条应通过，实得: %v", err)
	}
}

// Subscribe 只推**增量**：调用方刚 replay 过历史，再推一遍历史不是「实时」。
func TestPgSubscribePushesOnlyNewEvents(t *testing.T) {
	pool := testPool(t)
	src, err := NewPg(Options{Pool: pool, Interval: 50 * time.Millisecond})
	if err != nil {
		t.Fatalf("构造失败: %v", err)
	}
	ref := "sess-sub-" + time.Now().Format("150405.000000")
	seedLog(t, pool, ref, 1, 3)

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	sub, err := src.Subscribe(ctx, ref)
	if err != nil {
		t.Fatalf("订阅失败: %v", err)
	}

	// 订阅之后才写的那条，才是应该被推的。
	time.Sleep(120 * time.Millisecond)
	seedLog(t, pool, ref, 4, 4)

	select {
	case ev := <-sub:
		if ev.Seq != 4 {
			t.Fatalf("只应推送新增的 seq=4，实得 %d（历史被重推了？）", ev.Seq)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("新增事件未被推送")
	}

	cancel()
	deadline := time.After(2 * time.Second)
	for {
		select {
		case _, ok := <-sub:
			if !ok {
				return // ctx 取消后 channel 被关闭，符合契约
			}
		case <-deadline:
			t.Fatal("ctx 取消后 channel 未关闭")
		}
	}
}

// 读侧**不得**碰写侧的任何东西。这是本类型成立的前提：`session_log` 是单写者 + fencing
// 的，只有写会破坏那个不变式。断言的是「跑完一轮读之后，行数与租约原封不动」——
// 如果哪天有人给读路径加了一句 INSERT/UPDATE，这条会先红。
func TestPgReadsDoNotTouchTheWriteSide(t *testing.T) {
	pool := testPool(t)
	src, _ := NewPg(Options{Pool: pool, MaxReplay: 100})
	ctx := context.Background()
	ref := "sess-ro-" + time.Now().Format("150405.000000")
	seedLog(t, pool, ref, 1, 3)

	if _, err := pool.Exec(ctx,
		`INSERT INTO session_writer_lease (session_ref,holder,fencing_token,expires_at)
		 VALUES ($1,'someone-else',7,$2) ON CONFLICT (session_ref) DO NOTHING`,
		ref, time.Now().Add(time.Hour).UnixMilli()); err != nil {
		t.Fatalf("预置租约失败: %v", err)
	}

	before := countRows(t, pool, `SELECT count(*) FROM session_log WHERE session_ref=$1`, ref)
	var leaseBefore struct {
		holder string
		token  int64
	}
	if err := pool.QueryRow(ctx, `SELECT holder,fencing_token FROM session_writer_lease WHERE session_ref=$1`, ref).
		Scan(&leaseBefore.holder, &leaseBefore.token); err != nil {
		t.Fatalf("读租约失败: %v", err)
	}

	if _, err := src.History(ctx, ref, 0); err != nil {
		t.Fatalf("History 失败: %v", err)
	}
	if _, err := src.LatestSeq(ctx, ref); err != nil {
		t.Fatalf("LatestSeq 失败: %v", err)
	}
	subCtx, cancel := context.WithCancel(ctx)
	sub, err := src.Subscribe(subCtx, ref)
	if err != nil {
		t.Fatalf("Subscribe 失败: %v", err)
	}
	time.Sleep(120 * time.Millisecond)
	cancel()
	<-sub
	cancel()

	if after := countRows(t, pool, `SELECT count(*) FROM session_log WHERE session_ref=$1`, ref); after != before {
		t.Fatalf("读操作改动了 session_log：%d → %d", before, after)
	}
	var leaseAfter struct {
		holder string
		token  int64
	}
	if err := pool.QueryRow(ctx, `SELECT holder,fencing_token FROM session_writer_lease WHERE session_ref=$1`, ref).
		Scan(&leaseAfter.holder, &leaseAfter.token); err != nil {
		t.Fatalf("复查租约失败: %v", err)
	}
	if leaseAfter.holder != leaseBefore.holder || leaseAfter.token != leaseBefore.token {
		t.Fatalf("读操作动过写者租约：%v/%d → %v/%d",
			leaseBefore.holder, leaseBefore.token, leaseAfter.holder, leaseAfter.token)
	}
}

func countRows(t *testing.T, pool *pgxpool.Pool, sql string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := pool.QueryRow(context.Background(), sql, args...).Scan(&n); err != nil {
		t.Fatalf("计数失败: %v", err)
	}
	return n
}

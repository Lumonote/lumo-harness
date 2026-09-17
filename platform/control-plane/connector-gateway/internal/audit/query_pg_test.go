// Package audit_test 审计读取面的 SQL 语义判据（真 PG）。
//
// 只放**假实现断言不了**的东西：WHERE 子句真的生效、keyset 翻页不重不漏、
// 排序键是 id 而不是 created_at。过滤条件透传、参数校验、鉴权等都在
// server 包的纯内存测试里 —— 用假实现断言 SQL 只是在断言假实现。
package audit_test

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/connector-gateway/internal/audit"
)

func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过 connector-gateway 审计读取测试（真 PG）")
	}
	return dsn
}

// newReader 独立 schema + 建表，返回读取面与池。同包各用例互不干扰。
func newReader(t *testing.T) (*audit.Reader, *pgxpool.Pool) {
	t.Helper()
	ctx := context.Background()
	base := testDSN(t)
	schema := fmt.Sprintf("cg_audit_%d", time.Now().UnixNano())

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
	if err := audit.NewPg(pool).Init(ctx); err != nil {
		t.Fatalf("init audit: %v", err)
	}
	return audit.NewReader(pool), pool
}

func seed(t *testing.T, pool *pgxpool.Pool, realm, user, session, connector string, decision audit.Decision, createdAt time.Time) int64 {
	t.Helper()
	var id int64
	err := pool.QueryRow(context.Background(), `
		INSERT INTO connector_audit
		  (realm, user_id, session_id, connector_id, operation, method, target_host,
		   decision, status, duration_ms, request_bytes, response_bytes, created_at)
		VALUES ($1,$2,$3,$4,'op','POST','api.example.com',$5,200,12,10,20,$6) RETURNING id`,
		realm, user, session, connector, string(decision), createdAt).Scan(&id)
	if err != nil {
		t.Fatalf("seed: %v", err)
	}
	return id
}

// 过滤条件必须真的落到 SQL 上：realm 隔离、用户过滤、decision、session、connector。
func TestQueryAppliesFilters(t *testing.T) {
	reader, pool := newReader(t)
	ctx := context.Background()
	now := time.Now()
	seed(t, pool, "r1", "u1", "s1", "c1", audit.Allowed, now)
	seed(t, pool, "r1", "u1", "s1", "c1", audit.Denied, now)
	seed(t, pool, "r1", "u1", "s2", "c1", audit.Allowed, now)
	seed(t, pool, "r1", "u2", "s3", "c1", audit.Allowed, now)
	seed(t, pool, "r2", "u1", "s1", "c1", audit.Allowed, now) // 另一 realm

	realmOnly, err := reader.Query(ctx, audit.QueryFilter{Realm: "r1"})
	if err != nil {
		t.Fatalf("realm 查询: %v", err)
	}
	if len(realmOnly.Entries) != 4 {
		t.Fatalf("realm 过滤应剩 4 条（不含 r2）: got %d", len(realmOnly.Entries))
	}

	byUser, err := reader.Query(ctx, audit.QueryFilter{Realm: "r1", UserID: "u2"})
	if err != nil {
		t.Fatalf("用户查询: %v", err)
	}
	if len(byUser.Entries) != 1 || byUser.Entries[0].UserID != "u2" {
		t.Fatalf("用户过滤失效: %+v", byUser.Entries)
	}

	denied, err := reader.Query(ctx, audit.QueryFilter{Realm: "r1", Decision: audit.Denied})
	if err != nil {
		t.Fatalf("decision 查询: %v", err)
	}
	if len(denied.Entries) != 1 || denied.Entries[0].Decision != audit.Denied {
		t.Fatalf("decision 过滤失效: %+v", denied.Entries)
	}

	bySession, err := reader.Query(ctx, audit.QueryFilter{Realm: "r1", SessionID: "s1"})
	if err != nil {
		t.Fatalf("session 查询: %v", err)
	}
	if len(bySession.Entries) != 2 {
		t.Fatalf("session 过滤应剩 2 条: got %d", len(bySession.Entries))
	}

	// 组合过滤（审计最常用的问法：这个 session 里被拒绝的调用）
	combo, err := reader.Query(ctx, audit.QueryFilter{Realm: "r1", SessionID: "s1", Decision: audit.Denied})
	if err != nil {
		t.Fatalf("组合查询: %v", err)
	}
	if len(combo.Entries) != 1 || combo.Entries[0].Decision != audit.Denied || combo.Entries[0].SessionID != "s1" {
		t.Fatalf("组合过滤失效: %+v", combo.Entries)
	}
}

// keyset 翻页必须不重不漏：按 id 倒序逐页走完，恰好覆盖全部 id。
// 这是 offset 分页做不到的 —— 审计是只增表，翻页期间的新写入会让 offset 漂移。
func TestQueryKeysetPaginationIsExact(t *testing.T) {
	reader, pool := newReader(t)
	ctx := context.Background()
	now := time.Now()
	want := make([]int64, 0, 7)
	for i := 0; i < 7; i++ {
		want = append(want, seed(t, pool, "r1", "u1", "s1", "c1", audit.Allowed, now))
	}

	seen := make([]int64, 0, 7)
	cursor := int64(0)
	for page := 0; page < 10; page++ {
		got, err := reader.Query(ctx, audit.QueryFilter{Realm: "r1", BeforeID: cursor, Limit: 2})
		if err != nil {
			t.Fatalf("第 %d 页: %v", page, err)
		}
		for _, e := range got.Entries {
			seen = append(seen, e.ID)
		}
		if got.NextBeforeID == 0 {
			break
		}
		if got.NextBeforeID >= cursor && cursor != 0 {
			t.Fatalf("游标未前进: %d → %d", cursor, got.NextBeforeID)
		}
		cursor = got.NextBeforeID
	}

	if len(seen) != len(want) {
		t.Fatalf("翻页条数 = %d, want %d（重或漏）: %v", len(seen), len(want), seen)
	}
	// 期望倒序（最新 id 在前）
	for i := range seen {
		if seen[i] != want[len(want)-1-i] {
			t.Fatalf("翻页顺序/覆盖不符: got %v want %v（倒序）", seen, want)
		}
	}
	// 严格小于游标 → 无重复
	dupes := map[int64]bool{}
	for _, id := range seen {
		if dupes[id] {
			t.Fatalf("翻页出现重复行 %d", id)
		}
		dupes[id] = true
	}
}

// 排序键必须是 id（插入序），不是 created_at（事务开始时刻）。
// 并发下两者会不一致：先开始的事务可能后插入，于是「早的时间戳 + 大的 id」。
// 若按 created_at 排序却用 id 作游标，这种行会被漏掉或重复 —— 这里显式造出该形态。
func TestQueryOrdersByIdNotCreatedAt(t *testing.T) {
	reader, pool := newReader(t)
	ctx := context.Background()
	base := time.Now().Add(-time.Hour)
	older := seed(t, pool, "r1", "u1", "s1", "c1", audit.Allowed, base)
	// 后插入（id 更大）但时间戳更早 —— 模拟事务开始早、提交晚
	newerID := seed(t, pool, "r1", "u1", "s1", "c1", audit.Allowed, base.Add(-time.Minute))
	if newerID <= older {
		t.Fatalf("seed 未产生预期的 id 递增: %d then %d", older, newerID)
	}

	got, err := reader.Query(ctx, audit.QueryFilter{Realm: "r1"})
	if err != nil {
		t.Fatalf("查询: %v", err)
	}
	if len(got.Entries) != 2 {
		t.Fatalf("条数 = %d, want 2", len(got.Entries))
	}
	if got.Entries[0].ID != newerID {
		t.Fatalf("应按 id 倒序（大 id 在前），got 首行 id=%d want %d", got.Entries[0].ID, newerID)
	}
	if !got.Entries[0].CreatedAt.Before(got.Entries[1].CreatedAt) {
		t.Fatalf("本用例前提是「大 id 的时间戳更早」，数据未成立: %v vs %v",
			got.Entries[0].CreatedAt, got.Entries[1].CreatedAt)
	}
}

// 两种退化输入：空结果必须是 [] 而不是 null（nil 会编码成 JSON null，
// 客户端 .map 直接抛）；缺 realm 必须报错，不得退化为「查全部 realm」——
// 没有 realm 的调用者不该看到任何审计。
func TestQueryDegenerateInputs(t *testing.T) {
	reader, pool := newReader(t)
	ctx := context.Background()
	seed(t, pool, "r1", "u1", "s1", "c1", audit.Allowed, time.Now())

	empty, err := reader.Query(ctx, audit.QueryFilter{Realm: "no-such-realm"})
	if err != nil {
		t.Fatalf("空结果查询: %v", err)
	}
	if empty.Entries == nil {
		t.Fatal("Entries 为 nil —— 会序列化成 JSON null")
	}
	if len(empty.Entries) != 0 || empty.NextBeforeID != 0 {
		t.Fatalf("空页应无行且无游标: rows=%d cursor=%d", len(empty.Entries), empty.NextBeforeID)
	}

	noRealm, err := reader.Query(ctx, audit.QueryFilter{})
	if err == nil {
		t.Fatalf("缺 realm 应报错，而不是返回全部: %+v", noRealm.Entries)
	}
	if len(noRealm.Entries) != 0 {
		t.Fatalf("缺 realm 时不得返回任何行: %+v", noRealm.Entries)
	}
}

// 活库用例（门控 LUMO_TEST_PG_DSN）：**旧库收敛**——2026-09-17 之前由 `@lumo/control`
// 插件建的那对异构同名表。
//
// 为什么要单独钉这条路径：全新库上 `CREATE TABLE IF NOT EXISTS` 会建出正确形状，所有
// 用例全绿；老库上同一批语句是**空操作**，于是
//
//   - 建索引引用的列还不存在 → `column "id" does not exist`（42703），报错指向索引，
//     病根是前面两行没建出表；
//   - 列在但少了默认值 → 插入撞 not-null（23502）；
//   - 插件那句 CHECK 还在 → Go 写 'stopped' / 'awaiting-approval' 撞 23514。
//
// 2026-09-20 线上就是第一种：session-control 起不来、无限退出。三种都不会在全新库上
// 复现，所以「跑一遍全新库」不能替代本文件。
package store

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/lumo-harness/platform/session-control/internal/state"
)

// legacyPluginDDL 是插件当年建这两张表用的形状（含它那句四态 CHECK 与
// idx_control_audit_session 索引）。逐列取自当时线上库的 `\d`，不取自文档：
// 判据必须是「真的存在过的那张表」，否则这条用例测的是我记忆里的表。
//
// 用 CREATE TABLE（不是 IF NOT EXISTS）：本文件的用途就是造出那张表，静默跳过等于
// 让用例变成空转。
const legacyPluginDDL = `
CREATE TABLE session_control_state (
  session_ref TEXT PRIMARY KEY,
  state       TEXT NOT NULL CHECK (state IN ('running','paused','stopping','aborted')),
  reason      TEXT,
  actor       TEXT,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE session_control_audit (
  request_id   TEXT PRIMARY KEY,
  command      TEXT NOT NULL,
  session_ref  TEXT NOT NULL,
  actor        TEXT NOT NULL,
  role         TEXT NOT NULL,
  realm        TEXT NOT NULL,
  reason       TEXT NOT NULL,
  allowed      BOOLEAN NOT NULL,
  denied_cause TEXT,
  decided_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_control_audit_session ON session_control_audit (session_ref, decided_at);
INSERT INTO session_control_state (session_ref, state, reason, actor) VALUES
  ('s-legacy','paused','临时停线','alice'),
  -- 幽灵状态：Go 从不写它，而插件写过。不换算的话，这一行读出来是词表外的值，
  -- 闸门 fail-closed 全拒——一个已经停下来的会话变成「什么都不许做」。
  ('s-ghost','stopping',NULL,NULL);
INSERT INTO session_control_audit (request_id,command,session_ref,actor,role,realm,reason,allowed,denied_cause) VALUES
  ('r-1','pause','s-legacy','alice','operator','dev','临时停线',true,NULL),
  ('r-2','abort','s-legacy','bob','viewer','dev','',false,'not-authorized');
`

// newSchemaStore 建一个独立 schema 并把连接绑到它，但**不跑本服务的 DDL**：调用方要先
// 把库造成旧形状，再由 Init 去收敛。
func newSchemaStore(t *testing.T, prefix string) (*Store, *pgxpool.Pool, string) {
	t.Helper()
	ctx := context.Background()
	base := testDSN(t)
	schema := fmt.Sprintf("%s_%d", prefix, time.Now().UnixNano())

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
	return New(pool), pool, schema
}

// TestInitConvergesLegacyPluginTables：Init 在旧库上必须**收敛**，而不是失败。
//
// 失败的那一次（2026-09-20）报的是 `column "id" does not exist`，而这条用例把三件
// 事一起钉住：建表/建索引能过、旧数据搬进新列（含 realm 回填与幽灵状态换算）、
// 收敛后 Go 自己的写入路径可用。
func TestInitConvergesLegacyPluginTables(t *testing.T) {
	ctx := context.Background()
	st, pool, _ := newSchemaStore(t, "sc_legacy")

	if _, err := pool.Exec(ctx, legacyPluginDDL); err != nil {
		t.Fatalf("造旧库失败：%v", err)
	}
	if err := st.Init(ctx); err != nil {
		t.Fatalf("旧库上 Init 必须收敛：%v", err)
	}

	// 状态行：realm 从插件的审计回填（状态行自己没有 realm），同义列搬进 last_*。
	var realm, gotState, lastReason, lastActor string
	if err := pool.QueryRow(ctx, `SELECT realm, state, last_reason, last_actor
		FROM session_control_state WHERE session_ref='s-legacy'`).
		Scan(&realm, &gotState, &lastReason, &lastActor); err != nil {
		t.Fatalf("读回旧状态行：%v", err)
	}
	if realm != "dev" {
		t.Errorf("realm 必须从旧审计行回填（否则该会话此后每条指令都 realm_mismatch），实际 %q", realm)
	}
	if gotState != "paused" {
		t.Errorf("旧状态必须保留，实际 %q", gotState)
	}
	if lastReason != "临时停线" || lastActor != "alice" {
		t.Errorf("插件的 reason/actor 是同义列，应搬进 last_reason/last_actor，实际 %q/%q", lastReason, lastActor)
	}

	var ghost string
	if err := pool.QueryRow(ctx, `SELECT state FROM session_control_state WHERE session_ref='s-ghost'`).Scan(&ghost); err != nil {
		t.Fatalf("读幽灵状态行：%v", err)
	}
	if ghost != string(state.StateStopped) {
		t.Errorf("'stopping' 必须换算成 %q，实际 %q", state.StateStopped, ghost)
	}

	// 审计行：布尔与自由文本拒因按最接近的一档归类。
	rows, err := pool.Query(ctx, `SELECT actor_role, outcome FROM session_control_audit ORDER BY id`)
	if err != nil {
		t.Fatalf("读审计行：%v", err)
	}
	defer rows.Close()
	var got []string
	for rows.Next() {
		var role, outcome string
		if err := rows.Scan(&role, &outcome); err != nil {
			t.Fatalf("扫审计行：%v", err)
		}
		got = append(got, role+"/"+outcome)
	}
	if strings.Join(got, ",") != "operator/applied,viewer/policy_denied" {
		t.Errorf("旧审计行的角色与结论映射不符，实际 %v", got)
	}

	// 收敛后必须能用**本服务的列形状**写入：这条插入列的正是当初撞 not-null 的那张表。
	res, err := st.Commit(ctx, Commit{
		SessionRef: "s-legacy", Realm: "dev", Actor: "u-1", ActorRole: "operator",
		Command: state.CmdStop, ExpectedRevision: 0,
		ChangeState: true, ToState: state.StateStopped,
		Outcome: "applied", FromState: state.StatePaused, CorrelationID: "c-legacy",
	})
	if err != nil {
		t.Fatalf("收敛后写审计/状态失败：%v", err)
	}
	if res.AuditID == 0 {
		t.Error("审计行必须有 id")
	}

	// 插件的旧列必须已经删掉：留着它们意味着形状没收敛到本服务的定义上。
	var stale int
	if err := pool.QueryRow(ctx, `SELECT count(*) FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name='session_control_audit'
		  AND column_name IN ('request_id','allowed','denied_cause','role','decided_at')`).Scan(&stale); err != nil {
		t.Fatalf("查旧列：%v", err)
	}
	if stale != 0 {
		t.Errorf("旧列应被删除（同义列不留两份），残留 %d 列", stale)
	}
}

// TestLegacyConvergenceMatchesFreshShape：两条路径产出的表必须**逐列等价**（列名、类型、
// 可空、默认值）。
//
// 不等价时**只有老库会坏**，而且是静默的：governance 的 `session_id` 就是这么坏的
// （建表语句带 DEFAULT、收敛语句不带，新库好好的，老库登录报 23502）。所以这条断言
// 比较的不是「旧库能不能用」，而是「两条路径是不是同一张表」。
func TestLegacyConvergenceMatchesFreshShape(t *testing.T) {
	ctx := context.Background()

	fresh, freshPool, freshSchema := newSchemaStore(t, "sc_freshshape")
	if err := fresh.Init(ctx); err != nil {
		t.Fatalf("全新库 Init：%v", err)
	}

	legacy, legacyPool, legacySchema := newSchemaStore(t, "sc_legacyshape")
	if _, err := legacyPool.Exec(ctx, legacyPluginDDL); err != nil {
		t.Fatalf("造旧库失败：%v", err)
	}
	if err := legacy.Init(ctx); err != nil {
		t.Fatalf("旧库 Init：%v", err)
	}

	freshCols := columnShape(t, freshPool, freshSchema)
	legacyCols := columnShape(t, legacyPool, legacySchema)
	if strings.Join(freshCols, "\n") != strings.Join(legacyCols, "\n") {
		t.Errorf("两条路径的列形状必须一致（含默认值）。\n新建库：\n%s\n旧库收敛：\n%s",
			strings.Join(freshCols, "\n"), strings.Join(legacyCols, "\n"))
	}
}

// columnShape 取某 schema 里两张表的列定义，序列名里的 schema 前缀会被抹掉（bigserial
// 的默认值必然带前缀，那不是形状差异）。
func columnShape(t *testing.T, pool *pgxpool.Pool, schema string) []string {
	t.Helper()
	rows, err := pool.Query(context.Background(), `
		SELECT table_name, column_name, data_type, is_nullable, coalesce(column_default,'')
		  FROM information_schema.columns
		 WHERE table_schema=$1 AND table_name LIKE 'session_control_%'`, schema)
	if err != nil {
		t.Fatalf("读列定义（%s）：%v", schema, err)
	}
	defer rows.Close()
	var out []string
	for rows.Next() {
		var table, column, dataType, nullable, def string
		if err := rows.Scan(&table, &column, &dataType, &nullable, &def); err != nil {
			t.Fatalf("扫列定义：%v", err)
		}
		out = append(out, fmt.Sprintf("%s.%s %s %s %s",
			table, column, dataType, nullable, strings.ReplaceAll(def, schema+".", "")))
	}
	sort.Strings(out)
	return out
}

// TestMigrationFileMatchesServiceDDL：部署跑的那份迁移必须与服务端 DDL 同文。
//
// Compose 不跑 migrate.sh，服务端 DDL 是那类部署唯一的收敛点；跑迁移的部署走 006。
// 两份是**手抄的同一批判据**——09-17 那次修完代码才两天，正是因为「建表语句与收敛
// 语句不等价」又坏了一次（governance session_id）。这条断言让它们不可能悄悄分叉。
func TestMigrationFileMatchesServiceDDL(t *testing.T) {
	const path = "../../../../deploy/migrations/006_session_control_single_owner.sql"
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("读不到迁移文件（相对 internal/store 起算）：%v", err)
	}
	if !strings.Contains(string(raw), strings.TrimSpace(DDL)) {
		t.Error("006 迁移与服务端 const DDL 不同文：两条部署路径会各自收敛出不同的表，而只有一条被测到")
	}
}

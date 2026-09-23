package store

// 老库收敛用例（门控 LUMO_TEST_PG_DSN）：`governance_auth_sessions` 在没有 session_id
// 列的库上必须被收敛成「带默认值」的形状。
//
// 2026-09-20 线上实测：登录报
//
//	create session: ERROR: null value in column "session_id" of relation
//	"governance_auth_sessions" violates not-null constraint (SQLSTATE 23502)
//
// 病根是同一张表的**两条定义不等价**：建表语句写 `session_id ... DEFAULT
// gen_random_uuid()::text`（列由 CREATE 得到时插入可以不列它），收敛语句写
// `ADD COLUMN IF NOT EXISTS session_id TEXT`（列由 ALTER 得到时没有默认值），而两处
// INSERT（密码登录 auth.go、OIDC 回调 oidc.go）都不列这一列。
//
// 全新库永远复现不了这条：`ADD COLUMN IF NOT EXISTS` 在列已存在时整句是空操作。
// 所以「跑一遍新建库的用例全绿」不能替代本文件——这类坏法**只有老库会中招**。

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"os"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// legacyAuthSessionsDDL 是加 session_id 之前那张表的形状：没有 session_id，也没有
// oidc_issuer（两列都是后来由 ALTER 补的）。逐列抄自当时的库。
const legacyAuthSessionsDDL = `
DROP TABLE governance_auth_sessions;
CREATE TABLE governance_auth_sessions (
  token_hash   TEXT PRIMARY KEY,
  realm        TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  client_ip    TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  FOREIGN KEY (realm, user_id) REFERENCES governance_users(realm, id) ON DELETE CASCADE
);
INSERT INTO governance_users (realm, id, display_name) VALUES ('dev','u-legacy','老库用户');
INSERT INTO governance_auth_sessions (token_hash, realm, user_id, expires_at)
VALUES ('legacy-hash','dev','u-legacy', now() + interval '1 hour');
`

func legacyStore(t *testing.T) (*Store, *pgxpool.Pool) {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN is required for legacy schema convergence tests")
	}
	ctx := context.Background()
	admin, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	schema := "lumo_legacy_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, "CREATE SCHEMA "+pgx.Identifier{schema}.Sanitize()); err != nil {
		admin.Close()
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(ctx, "DROP SCHEMA "+pgx.Identifier{schema}.Sanitize()+" CASCADE"); err != nil {
			t.Error(err)
		}
		admin.Close()
	})

	cfg, err := pgxpool.ParseConfig(dsn)
	if err != nil {
		t.Fatal(err)
	}
	cfg.ConnConfig.RuntimeParams["search_path"] = schema
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return New(pool), pool
}

func TestInitConvergesAuthSessionsWithoutSessionID(t *testing.T) {
	ctx := context.Background()
	st, pool := legacyStore(t)

	// 先把库造成「全套表都在」的状态，再把会话表换回旧形状——这就是老库升级时的样子。
	if err := st.Init(ctx); err != nil {
		t.Fatalf("首次 Init：%v", err)
	}
	if _, err := pool.Exec(ctx, legacyAuthSessionsDDL); err != nil {
		t.Fatalf("造旧库失败：%v", err)
	}

	// 升级路径：同一条 Init 再跑一遍。
	if err := st.Init(ctx); err != nil {
		t.Fatalf("旧库上 Init 必须收敛：%v", err)
	}

	var def *string
	if err := pool.QueryRow(ctx, `SELECT column_default FROM information_schema.columns
		WHERE table_schema=current_schema() AND table_name='governance_auth_sessions'
		  AND column_name='session_id'`).Scan(&def); err != nil {
		t.Fatalf("查 session_id 定义：%v", err)
	}
	if def == nil {
		t.Fatal("session_id 没有默认值：登录路径（不列这一列的 INSERT）会以 23502 失败")
	}

	// 老行必须拿到 id（收敛语句回填），且旧行本身不能丢。
	var legacyID string
	if err := pool.QueryRow(ctx, `SELECT session_id FROM governance_auth_sessions
		WHERE token_hash='legacy-hash'`).Scan(&legacyID); err != nil {
		t.Fatalf("读回旧会话行：%v", err)
	}
	if legacyID == "" {
		t.Error("旧行必须回填出 session_id（它是会话列表与按 id 撤销的键）")
	}

	// 登录路径的原样：不列 session_id。
	var newID string
	if err := pool.QueryRow(ctx, `INSERT INTO governance_auth_sessions
		(token_hash, realm, user_id, expires_at) VALUES ('fresh-hash','dev','u-legacy', now() + interval '1 hour')
		RETURNING session_id`).Scan(&newID); err != nil {
		t.Fatalf("登录路径的插入必须成功：%v", err)
	}
	if newID == legacyID {
		t.Error("session_id 必须每行唯一（它是 UNIQUE 索引）")
	}
}

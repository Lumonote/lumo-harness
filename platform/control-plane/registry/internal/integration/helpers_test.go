package integration_test

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/url"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/store"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

// testDSN 取活库连接串，未设置则跳过——与 scheduler 的同名 helper 同规矩。
func testDSN(t *testing.T) string {
	t.Helper()
	dsn := os.Getenv("LUMO_TEST_PG_DSN")
	if dsn == "" {
		t.Skip("LUMO_TEST_PG_DSN 未设置，跳过活库集成测试")
	}
	return dsn
}

// testKey 生成一对固定用途的 ed25519 密钥，并返回带该公钥的信任表。
// max 是该发布者的 scope 上限。
func testKey(t *testing.T, id string, max []string) (ed25519.PrivateKey, *trust.Store) {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatalf("生成密钥失败: %v", err)
	}
	ts := trust.NewStore([]trust.Publisher{{ID: id, PublicKey: pub, MaxScopes: max}})
	return priv, ts
}

// newStore 给每个用例独立 schema。测试的 FileStore 只在用例生命周期内存在，
// 绝不能把它对应的 PG 索引写进运行中 Registry 使用的 public schema。
func newStore(t *testing.T, ts *trust.Store) (*store.Store, objstore.Store) {
	t.Helper()
	ctx := context.Background()
	dsn, err := url.Parse(testDSN(t))
	if err != nil || (dsn.Scheme != "postgres" && dsn.Scheme != "postgresql") {
		t.Fatal("LUMO_TEST_PG_DSN 必须是 postgres:// 或 postgresql:// URL")
	}
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatalf("生成测试 schema 名失败: %v", err)
	}
	schema := "registry_test_" + hex.EncodeToString(suffix[:])
	admin, err := pgxpool.New(ctx, dsn.String())
	if err != nil {
		t.Fatalf("连测试库失败: %v", err)
	}
	if _, err := admin.Exec(ctx, fmt.Sprintf(`CREATE SCHEMA "%s"`, schema)); err != nil {
		admin.Close()
		t.Fatalf("创建测试 schema 失败: %v", err)
	}
	t.Cleanup(func() {
		if _, err := admin.Exec(context.Background(), fmt.Sprintf(`DROP SCHEMA "%s" CASCADE`, schema)); err != nil {
			t.Errorf("清理测试 schema 失败: %v", err)
		}
		admin.Close()
	})
	query := dsn.Query()
	query.Set("search_path", schema)
	dsn.RawQuery = query.Encode()
	objs := objstore.NewFileStore(t.TempDir())
	s, err := store.New(ctx, dsn.String(), objs, ts)
	if err != nil {
		t.Fatalf("连库失败: %v", err)
	}
	t.Cleanup(s.Close)
	if err := s.Init(ctx); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	return s, objs
}

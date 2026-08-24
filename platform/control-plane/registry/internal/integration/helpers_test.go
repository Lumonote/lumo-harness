package integration_test

import (
	"context"
	"crypto/ed25519"
	"os"
	"testing"

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

// newStore 建一个连活库的 Store，并清空注册表相关表。
// 活库共享，因此这些用例一律不得 t.Parallel()。
func newStore(t *testing.T, ts *trust.Store) (*store.Store, objstore.Store) {
	t.Helper()
	ctx := context.Background()
	objs := objstore.NewFileStore(t.TempDir())
	s, err := store.New(ctx, testDSN(t), objs, ts)
	if err != nil {
		t.Fatalf("连库失败: %v", err)
	}
	t.Cleanup(s.Close)
	if err := s.Init(ctx); err != nil {
		t.Fatalf("建表失败: %v", err)
	}
	if err := s.TruncateForTest(ctx); err != nil {
		t.Fatalf("清表失败: %v", err)
	}
	return s, objs
}

package integration_test

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/store"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

// mf 拼一份 manifest 原始字节。注意：这里生成的字节就是被签名覆盖的对象，
// 全程不得再序列化一次——重序列化正是本设计要防的失配来源。
func mf(name, version string, scopes []string, deps []manifest.Dep) []byte {
	m := map[string]any{
		"apiVersion": "lumo.artifact/v1",
		"kind":       "Component",
		"name":       name,
		"version":    version,
		"publisher":  "acme",
		"scopes":     scopes,
	}
	if len(deps) > 0 {
		m["deps"] = deps
	}
	raw, err := json.Marshal(m)
	if err != nil {
		panic(err)
	}
	return raw
}

func sign(priv ed25519.PrivateKey, raw []byte) []byte {
	return ed25519.Sign(priv, raw)
}

func TestPublishThenGet(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query"})
	s, objs := newStore(t, ts)

	raw := mf("sales-kb", "2.0.1", []string{"kb:query"}, nil)
	rec, err := s.Publish(ctx, raw, sign(priv, raw))
	if err != nil {
		t.Fatalf("发布失败: %v", err)
	}
	if rec.Digest != objstore.Digest(raw) {
		t.Fatalf("digest 不是字节的 sha256: %s", rec.Digest)
	}
	if rec.Idempotent {
		t.Fatal("首次发布不应标记为幂等命中")
	}

	// 字节必须真的进了对象存储，且取回来逐字节相同。
	got, err := objs.Get(ctx, rec.Digest)
	if err != nil {
		t.Fatalf("取字节失败: %v", err)
	}
	if string(got) != string(raw) {
		t.Fatal("取回的字节与上传的不同——签名覆盖的对象被动过")
	}

	back, err := s.Get(ctx, "sales-kb", "2.0.1")
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if back.Digest != rec.Digest || back.Publisher != "acme" {
		t.Fatalf("查询结果不符: %+v", back)
	}
}

// TestPublishIdempotent —— CI 重跑、网络重试必须安全。
func TestPublishIdempotent(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query"})
	s, _ := newStore(t, ts)

	raw := mf("sales-kb", "2.0.1", []string{"kb:query"}, nil)
	if _, err := s.Publish(ctx, raw, sign(priv, raw)); err != nil {
		t.Fatalf("首发失败: %v", err)
	}
	rec, err := s.Publish(ctx, raw, sign(priv, raw))
	if err != nil {
		t.Fatalf("同 digest 重发应幂等成功: %v", err)
	}
	if !rec.Idempotent {
		t.Fatal("同 digest 重发应标记为幂等命中")
	}
}

func TestRolloutTargetsOnlyPublishedImmutableVersion(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query"})
	s, _ := newStore(t, ts)

	for _, version := range []string{"1.0.0", "1.1.0"} {
		raw := mf("sales-kb", version, []string{"kb:query"}, nil)
		if _, err := s.Publish(ctx, raw, sign(priv, raw)); err != nil {
			t.Fatalf("发布 %s: %v", version, err)
		}
	}
	if _, err := s.UpsertRollout(ctx, store.Rollout{Channel: "stable", Name: "sales-kb", Version: "9.9.9", Percent: 100}); !errors.Is(err, store.ErrNotFound) {
		t.Fatalf("未发布版本不能成为期望状态，得到: %v", err)
	}
	first, err := s.UpsertRollout(ctx, store.Rollout{Channel: "stable", Name: "sales-kb", Version: "1.0.0", Percent: 100})
	if err != nil {
		t.Fatal(err)
	}
	if first.Version != "1.0.0" || first.UpdatedAt.IsZero() {
		t.Fatalf("首次目标状态不正确: %+v", first)
	}
	updated, err := s.UpsertRollout(ctx, store.Rollout{Channel: "stable", Name: "sales-kb", Version: "1.1.0", Percent: 100})
	if err != nil {
		t.Fatal(err)
	}
	if updated.Version != "1.1.0" {
		t.Fatalf("期望版本更新失败: %+v", updated)
	}
	got, err := s.GetRollout(ctx, "stable", "sales-kb")
	if err != nil || got.Version != "1.1.0" || got.Percent != 100 {
		t.Fatalf("读取期望状态 = %+v, %v", got, err)
	}
	items, err := s.ListRollouts(ctx, "stable", 10)
	if err != nil || len(items) != 1 || items[0].Name != "sales-kb" {
		t.Fatalf("列出期望状态 = %+v, %v", items, err)
	}
}

// TestPublishImmutable —— 不动版本号悄悄换内容，是最经典的供应链手法。
func TestPublishImmutable(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query", "kb:write"})
	s, _ := newStore(t, ts)

	a := mf("sales-kb", "2.0.1", []string{"kb:query"}, nil)
	if _, err := s.Publish(ctx, a, sign(priv, a)); err != nil {
		t.Fatalf("首发失败: %v", err)
	}
	b := mf("sales-kb", "2.0.1", []string{"kb:write"}, nil)
	_, err := s.Publish(ctx, b, sign(priv, b))
	if !errors.Is(err, store.ErrVersionImmutable) {
		t.Fatalf("同版本不同 digest 必须被拒，得到: %v", err)
	}
}

func TestPublishRejectsUnknownPublisher(t *testing.T) {
	ctx := context.Background()
	_, ts := testKey(t, "acme", []string{"kb:query"})
	s, _ := newStore(t, ts)

	_, evilPriv, _ := ed25519.GenerateKey(nil)
	raw := mf("evil-kb", "1.0.0", []string{"kb:query"}, nil)
	// publisher 字段写的是 acme，但签名用的是别人的私钥。
	_, err := s.Publish(ctx, raw, sign(evilPriv, raw))
	if !errors.Is(err, trust.ErrBadSignature) {
		t.Fatalf("冒名签名必须被拒，得到: %v", err)
	}
}

// TestPublishRejectsScopeEscalation —— 验收判据 7。
func TestPublishRejectsScopeEscalation(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query"})
	s, _ := newStore(t, ts)

	raw := mf("greedy", "1.0.0", []string{"data:write:warehouse"}, nil)
	_, err := s.Publish(ctx, raw, sign(priv, raw))
	if !errors.Is(err, trust.ErrScopeEscalation) {
		t.Fatalf("超上限的 scope 必须被拒，得到: %v", err)
	}
}

// TestPublishBytesBeforeMetadata —— §3 的方向判据。
// 元数据写失败时，残留必须是「对象存储里的孤儿字节」这种便宜错误，
// 而不是「库里有记录但取不到字节」那种要到安装期才炸的错误。
func TestPublishBytesBeforeMetadata(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query", "kb:write"})
	s, objs := newStore(t, ts)

	// 先占位：同 (name,version) 已存在且 digest 不同 → 元数据写会被不可变性拒绝。
	a := mf("order", "1.0.0", []string{"kb:query"}, nil)
	if _, err := s.Publish(ctx, a, sign(priv, a)); err != nil {
		t.Fatalf("首发失败: %v", err)
	}
	b := mf("order", "1.0.0", []string{"kb:write"}, nil)
	if _, err := s.Publish(ctx, b, sign(priv, b)); err == nil {
		t.Fatal("应被不可变性拒绝")
	}
	// b 的字节此刻应已在对象存储里（孤儿），且无害：内容寻址使同 digest 重传幂等。
	ok, err := objs.Has(ctx, objstore.Digest(b))
	if err != nil {
		t.Fatalf("查对象失败: %v", err)
	}
	if !ok {
		t.Fatal("字节应先于元数据落盘——顺序反了会在库里留下取不到字节的记录")
	}
}

package integration_test

import (
	"context"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/plan"
	"github.com/lumo-harness/platform/registry/internal/resolve"
)

// TestTamperedMetadataDoesNotAffectEnforcement —— 验收判据 3。
//
// 直接改库里的 scopes 列，然后生成安装计划：计划里的 scope 必须仍是
// 原始字节里那个。这条断言成立，才说明 PG 是索引而不是真相源；
// 它不成立，则前面所有签名工作都只是装饰。
func TestTamperedMetadataDoesNotAffectEnforcement(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query"})
	s, objs := newStore(t, ts)

	raw := mf("sales-kb", "2.0.1", []string{"kb:query"}, nil)
	rec, err := s.Publish(ctx, raw, sign(priv, raw))
	if err != nil {
		t.Fatalf("发布失败: %v", err)
	}

	// 攻击者写穿数据库：把 scope 提成写权限。字节与签名一动未动。
	if err := s.ExecForTest(ctx,
		`UPDATE registry_artifacts SET scopes = ARRAY['data:write:all'] WHERE name = $1 AND version = $2`,
		"sales-kb", "2.0.1"); err != nil {
		t.Fatalf("篡改失败: %v", err)
	}

	// 确认库里确实被改了，否则这条测试等于没测。
	poisoned, err := s.Get(ctx, "sales-kb", "2.0.1")
	if err != nil {
		t.Fatalf("查询失败: %v", err)
	}
	if len(poisoned.Scopes) != 1 || poisoned.Scopes[0] != "data:write:all" {
		t.Fatalf("前置条件不成立，库里没被改: %+v", poisoned.Scopes)
	}

	nodes := []resolve.Node{{
		Name: rec.Name, Version: rec.Version, Digest: poisoned.Digest, Sig: poisoned.Sig,
	}}
	p, err := plan.Build(ctx, nodes, plan.Shape{}, objs, ts)
	if err != nil {
		t.Fatalf("计划应正常生成（字节没被动）: %v", err)
	}
	if len(p.Scopes) != 1 || p.Scopes[0] != "kb:query" {
		t.Fatalf("执法读到了被篡改的库字段——PG 成了信任根，设计失守: %+v", p.Scopes)
	}
	if len(p.Items) != 1 || len(p.Items[0].Scopes) != 1 || p.Items[0].Scopes[0] != "kb:query" {
		t.Fatalf("计划条目的 scope 也必须来自字节: %+v", p.Items)
	}
}

// TestClosureThroughStore —— resolve 接上真库的 lookup，走一遍三层依赖。
func TestClosureThroughStore(t *testing.T) {
	ctx := context.Background()
	priv, ts := testKey(t, "acme", []string{"kb:query"})
	s, objs := newStore(t, ts)

	for _, a := range []struct {
		name, version string
		deps          []manifest.Dep
	}{
		{"util", "1.1.0", nil},
		{"lib", "2.0.0", []manifest.Dep{{Name: "util", Version: "1.1.0"}}},
		{"app", "1.0.0", []manifest.Dep{{Name: "lib", Version: "2.0.0"}, {Name: "util", Version: "1.1.0"}}},
	} {
		raw := mf(a.name, a.version, []string{"kb:query"}, a.deps)
		if _, err := s.Publish(ctx, raw, sign(priv, raw)); err != nil {
			t.Fatalf("发布 %s 失败: %v", a.name, err)
		}
	}

	nodes, err := resolve.Closure(ctx, manifest.Dep{Name: "app", Version: "1.0.0"}, s.LookupNode)
	if err != nil {
		t.Fatalf("闭包解析失败: %v", err)
	}
	if len(nodes) != 3 || nodes[len(nodes)-1].Name != "app" {
		t.Fatalf("闭包应为 3 个节点且根在最后: %+v", nodes)
	}

	p, err := plan.Build(ctx, nodes, plan.Shape{}, objs, ts)
	if err != nil {
		t.Fatalf("生成计划失败: %v", err)
	}
	if p.Root != "app@1.0.0" || len(p.Items) != 3 {
		t.Fatalf("计划不符: %+v", p)
	}
}

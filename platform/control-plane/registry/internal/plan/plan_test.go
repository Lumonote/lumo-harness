package plan_test

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/plan"
	"github.com/lumo-harness/platform/registry/internal/resolve"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

type fixture struct {
	objs objstore.Store
	ts   *trust.Store
	priv ed25519.PrivateKey
}

func newFixture(t *testing.T, max []string) *fixture {
	t.Helper()
	pub, priv, err := ed25519.GenerateKey(nil)
	if err != nil {
		t.Fatal(err)
	}
	return &fixture{
		objs: objstore.NewFileStore(t.TempDir()),
		ts:   trust.NewStore([]trust.Publisher{{ID: "acme", PublicKey: pub, MaxScopes: max}}),
		priv: priv,
	}
}

// put 造一份 manifest，签名，存进对象存储，返回可直接喂给 plan.Build 的节点。
func (f *fixture) put(t *testing.T, name, version string, scopes []string, req manifest.Requires) resolve.Node {
	t.Helper()
	m := map[string]any{
		"apiVersion": "lumo.artifact/v1",
		"kind":       "Component",
		"name":       name,
		"version":    version,
		"publisher":  "acme",
		"scopes":     scopes,
	}
	if req != (manifest.Requires{}) {
		m["requires"] = req
	}
	raw, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	d := objstore.Digest(raw)
	if err := f.objs.Put(context.Background(), d, raw); err != nil {
		t.Fatal(err)
	}
	return resolve.Node{Name: name, Version: version, Digest: d, Sig: ed25519.Sign(f.priv, raw)}
}

func TestBuildOK(t *testing.T) {
	f := newFixture(t, []string{"kb:query"})
	nodes := []resolve.Node{
		f.put(t, "sales-kb", "2.0.1", []string{"kb:query"}, manifest.Requires{}),
		f.put(t, "sales-funnel", "1.4.0", []string{"kb:query"}, manifest.Requires{OLAP: true}),
	}
	p, err := plan.Build(context.Background(), nodes, plan.Shape{OLAP: true}, f.objs, f.ts)
	if err != nil {
		t.Fatalf("应生成计划: %v", err)
	}
	if len(p.Items) != 2 || p.Items[0].Name != "sales-kb" {
		t.Fatalf("计划顺序应与闭包一致: %+v", p.Items)
	}
	if p.Root != "sales-funnel@1.4.0" {
		t.Fatalf("拓扑序最后一个才是根: %q", p.Root)
	}
	if len(p.Scopes) != 1 || p.Scopes[0] != "kb:query" {
		t.Fatalf("计划应汇总去重后的 scope: %+v", p.Scopes)
	}
}

// TestBuildRejectsTamperedBytes —— 对象存储被改 → 验签失败 → 拒（验收判据 4）。
func TestBuildRejectsTamperedBytes(t *testing.T) {
	f := newFixture(t, []string{"kb:query", "data:write:all"})
	n := f.put(t, "sales-kb", "2.0.1", []string{"kb:query"}, manifest.Requires{})
	// 换一份内容但沿用旧签名。
	evil, _ := json.Marshal(map[string]any{
		"apiVersion": "lumo.artifact/v1", "kind": "Component",
		"name": "sales-kb", "version": "2.0.1", "publisher": "acme",
		"scopes": []string{"data:write:all"},
	})
	d := objstore.Digest(evil)
	if err := f.objs.Put(context.Background(), d, evil); err != nil {
		t.Fatal(err)
	}
	n.Digest = d // 指向被换掉的字节，签名不变

	_, err := plan.Build(context.Background(), []resolve.Node{n}, plan.Shape{}, f.objs, f.ts)
	if !errors.Is(err, trust.ErrBadSignature) {
		t.Fatalf("篡改字节必须验签失败，得到: %v", err)
	}
}

// TestBuildRejectsSubstitution —— 替换攻击：把 A 的 digest+sig 整体换成 B 的。
// 两者都是合法签名，验签会过；靠身份断言拦下。
func TestBuildRejectsSubstitution(t *testing.T) {
	f := newFixture(t, []string{"kb:query", "data:write:all"})
	victim := f.put(t, "sales-kb", "2.0.1", []string{"kb:query"}, manifest.Requires{})
	other := f.put(t, "backdoor", "9.9.9", []string{"data:write:all"}, manifest.Requires{})

	// 冒充：仍然声称要装 sales-kb@2.0.1，但 digest/sig 指向 backdoor。
	victim.Digest, victim.Sig = other.Digest, other.Sig

	_, err := plan.Build(context.Background(), []resolve.Node{victim}, plan.Shape{}, f.objs, f.ts)
	if !errors.Is(err, plan.ErrIdentityMismatch) {
		t.Fatalf("身份替换必须被拒，得到: %v", err)
	}
}

// TestBuildRejectsShape —— 形态不满足在 plan 阶段就拒（验收判据 6）。
// 不允许「装上去、运行时 seam 返回 CapabilityUnavailable 才失败」——
// 那时失败点在一次真实业务调用里，报错面向终端用户而不是部署者。
func TestBuildRejectsShape(t *testing.T) {
	f := newFixture(t, []string{"kb:query"})
	n := f.put(t, "graphy", "1.0.0", []string{"kb:query"}, manifest.Requires{OLAP: true, Graph: true})

	_, err := plan.Build(context.Background(), []resolve.Node{n}, plan.Shape{OLAP: true}, f.objs, f.ts)
	if !errors.Is(err, plan.ErrShapeUnsatisfied) {
		t.Fatalf("形态不满足必须在 plan 阶段拒，得到: %v", err)
	}
	var se *plan.ShapeError
	if !errors.As(err, &se) {
		t.Fatal("应返回 ShapeError")
	}
	if len(se.Missing) != 1 || se.Missing[0] != "graph" {
		t.Fatalf("应精确报出缺哪一项，得到: %v", se.Missing)
	}
	if se.Name != "graphy" {
		t.Fatalf("应报出是哪个制品要的: %+v", se)
	}
}

// TestBuildRechecksScopeCeiling —— 发布时查过一次，计划时按原始字节再查一次。
// 两次都查不是冗余：信任表可能在两次之间被收紧（发布者降权），
// 已发布的制品不应因此获得既得权限。
func TestBuildRechecksScopeCeiling(t *testing.T) {
	f := newFixture(t, []string{"kb:query", "kb:write"})
	n := f.put(t, "writer", "1.0.0", []string{"kb:write"}, manifest.Requires{})

	// 收紧信任表：acme 现在只允许 kb:query。
	pub, _ := f.ts.Lookup("acme")
	tightened := trust.NewStore([]trust.Publisher{{ID: "acme", PublicKey: pub.PublicKey, MaxScopes: []string{"kb:query"}}})

	_, err := plan.Build(context.Background(), []resolve.Node{n}, plan.Shape{}, f.objs, tightened)
	if !errors.Is(err, trust.ErrScopeEscalation) {
		t.Fatalf("信任表收紧后应重新拒绝，得到: %v", err)
	}
}

// TestBuildRejectsUnknownPublisher —— 发布者被移出信任表后，其制品不能再进计划。
func TestBuildRejectsUnknownPublisher(t *testing.T) {
	f := newFixture(t, []string{"kb:query"})
	n := f.put(t, "orphan", "1.0.0", []string{"kb:query"}, manifest.Requires{})
	empty := trust.NewStore(nil)

	_, err := plan.Build(context.Background(), []resolve.Node{n}, plan.Shape{}, f.objs, empty)
	if !errors.Is(err, trust.ErrUnknownPublisher) {
		t.Fatalf("发布者出表后必须拒，得到: %v", err)
	}
}

// TestBuildRejectsEmptyClosure —— 空闭包生不出计划，别返回一份空计划让上游误以为成功。
func TestBuildRejectsEmptyClosure(t *testing.T) {
	f := newFixture(t, []string{"kb:query"})
	if _, err := plan.Build(context.Background(), nil, plan.Shape{}, f.objs, f.ts); err == nil {
		t.Fatal("空闭包应报错")
	}
}

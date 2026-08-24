package resolve_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/resolve"
)

// fake 是一张内存依赖图：key 为 "name@version"。
type fake map[string][]manifest.Dep

func (f fake) lookup(_ context.Context, name, version string) (*resolve.Node, error) {
	deps, ok := f[name+"@"+version]
	if !ok {
		return nil, resolve.ErrMissing
	}
	return &resolve.Node{
		Name: name, Version: version,
		Digest: "sha256:" + strings.Repeat("0", 64),
		Deps:   deps,
	}, nil
}

func dep(n, v string) manifest.Dep { return manifest.Dep{Name: n, Version: v} }

// TestClosureTopoOrder —— 输出必须是拓扑序（被依赖者在前），
// 这样安装计划可以直接照序装，不需要再排一次。
func TestClosureTopoOrder(t *testing.T) {
	g := fake{
		"app@1.0.0":  {dep("lib", "2.0.0"), dep("util", "1.1.0")},
		"lib@2.0.0":  {dep("util", "1.1.0")},
		"util@1.1.0": {},
	}
	nodes, err := resolve.Closure(context.Background(), dep("app", "1.0.0"), g.lookup)
	if err != nil {
		t.Fatalf("应解析成功: %v", err)
	}
	if len(nodes) != 3 {
		t.Fatalf("闭包应有 3 个节点，得到 %d: %+v", len(nodes), nodes)
	}
	pos := map[string]int{}
	for i, n := range nodes {
		pos[n.Name] = i
	}
	if pos["util"] > pos["lib"] || pos["lib"] > pos["app"] {
		t.Fatalf("不是拓扑序: %+v", nodes)
	}
}

// TestClosureDedup —— 同一制品同一版本被多个路径依赖，只应出现一次。
func TestClosureDedup(t *testing.T) {
	g := fake{
		"app@1.0.0": {dep("a-x", "1.0.0"), dep("b-x", "1.0.0")},
		"a-x@1.0.0": {dep("c-x", "1.0.0")},
		"b-x@1.0.0": {dep("c-x", "1.0.0")},
		"c-x@1.0.0": {},
	}
	nodes, err := resolve.Closure(context.Background(), dep("app", "1.0.0"), g.lookup)
	if err != nil {
		t.Fatalf("应解析成功: %v", err)
	}
	if len(nodes) != 4 {
		t.Fatalf("去重后应为 4 个节点，得到 %d", len(nodes))
	}
}

// TestClosureCycle —— 拒绝并报出环路径，否则运维只知道「有环」而不知道环在哪。
func TestClosureCycle(t *testing.T) {
	g := fake{
		"a-x@1.0.0": {dep("b-x", "1.0.0")},
		"b-x@1.0.0": {dep("c-x", "1.0.0")},
		"c-x@1.0.0": {dep("a-x", "1.0.0")},
	}
	_, err := resolve.Closure(context.Background(), dep("a-x", "1.0.0"), g.lookup)
	if !errors.Is(err, resolve.ErrCycle) {
		t.Fatalf("成环必须被拒，得到: %v", err)
	}
	var ce *resolve.CycleError
	if !errors.As(err, &ce) {
		t.Fatalf("应返回 CycleError 以携带路径")
	}
	if len(ce.Path) < 4 || ce.Path[0] != "a-x@1.0.0" || ce.Path[len(ce.Path)-1] != "a-x@1.0.0" {
		t.Fatalf("环路径应首尾相同并完整: %v", ce.Path)
	}
}

// TestClosureVersionConflict —— 本设计的判断题：
// 包管理器通常自动选最高版本，但制品带 scope 权限，静默升版 = 静默提权。
// 因此一律拒绝，把问题交给人。
func TestClosureVersionConflict(t *testing.T) {
	g := fake{
		"app@1.0.0":    {dep("jira", "1.2.0"), dep("report", "1.0.0")},
		"report@1.0.0": {dep("jira", "1.5.0")},
		"jira@1.2.0":   {},
		"jira@1.5.0":   {},
	}
	_, err := resolve.Closure(context.Background(), dep("app", "1.0.0"), g.lookup)
	if !errors.Is(err, resolve.ErrVersionConflict) {
		t.Fatalf("多版本必须被拒（不得自动仲裁），得到: %v", err)
	}
	var ce *resolve.ConflictError
	if !errors.As(err, &ce) {
		t.Fatalf("应返回 ConflictError")
	}
	if ce.Name != "jira" {
		t.Fatalf("应报出冲突的制品名: %+v", ce)
	}
	if ce.Existing == ce.Incoming {
		t.Fatalf("应报出两个不同版本: %+v", ce)
	}
}

// TestClosureMissing —— 依赖不存在时报出是「谁」依赖了它。
func TestClosureMissing(t *testing.T) {
	g := fake{"app@1.0.0": {dep("ghost", "9.9.9")}}
	_, err := resolve.Closure(context.Background(), dep("app", "1.0.0"), g.lookup)
	if !errors.Is(err, resolve.ErrMissing) {
		t.Fatalf("缺失依赖必须被拒，得到: %v", err)
	}
	var me *resolve.MissingError
	if !errors.As(err, &me) {
		t.Fatalf("应返回 MissingError")
	}
	if me.Via != "app@1.0.0" {
		t.Fatalf("应报出引入方: %+v", me)
	}
}

// TestClosureRootMissing —— 根制品本身不存在。
func TestClosureRootMissing(t *testing.T) {
	_, err := resolve.Closure(context.Background(), dep("nope", "1.0.0"), fake{}.lookup)
	if !errors.Is(err, resolve.ErrMissing) {
		t.Fatalf("根缺失必须被拒，得到: %v", err)
	}
	var me *resolve.MissingError
	if !errors.As(err, &me) || me.Via != "" {
		t.Fatalf("根缺失时 Via 应为空: %+v", me)
	}
}

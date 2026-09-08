// Package plan 生成安装计划。
//
// 本包是整个注册表设计的落点，只有一条规矩，但它决定了前面所有工作是否有意义：
//
//	执法只认对象存储里那串被签名覆盖的原始字节。
//
// 具体做法：按 digest 取字节 → 验签 → **重新解析** → 从解析结果读
// scope / requires / deps 做判断。PG 里的同名字段一个都不读。
//
// 为什么这么费事：如果执法读 PG 元数据，registry 的数据库就成了信任根——
// 一次 SQL 注入、一次运维误操作、一个越权的内部账号，就能把
// scopes: [kb:query] 改成 [data:write:*]，而对象存储里那份被签名覆盖的
// 原始字节纹丝未动，签名照样验得过。签名验的是字节，执法看的是数据库，
// 两者从来没有对上。这是 parser differential 攻击的标准形状：
// **签名覆盖的对象与执法依据的对象不是同一个对象。**
//
// 与之配套的第二条断言是身份断言（ErrIdentityMismatch）：改库的人伪造不了签名，
// 却能把 A 的 digest+sig 整体换成 B 的——两份都合法，验签都过。
// 因此重解析出的 name/version 必须与请求的一致，否则一次 UPDATE 就绕过全部防线。
package plan

import (
	"context"
	"errors"
	"fmt"
	"sort"

	"github.com/lumo-harness/platform/registry/internal/manifest"
	"github.com/lumo-harness/platform/registry/internal/objstore"
	"github.com/lumo-harness/platform/registry/internal/resolve"
	"github.com/lumo-harness/platform/registry/internal/trust"
)

var (
	// ErrShapeUnsatisfied 目标部署形态不满足制品的 requires（§13.2.3）。
	ErrShapeUnsatisfied = errors.New("registry: 目标形态不满足制品要求")
	// ErrIdentityMismatch 取回字节解析出的身份与请求的不一致（替换攻击）。
	ErrIdentityMismatch = errors.New("registry: 制品身份与请求不符")
)

// Shape 是目标部署形态提供的能力。字段与 manifest.Requires 一一对应。
type Shape struct {
	OLAP   bool `json:"olap"`
	Graph  bool `json:"graph"`
	Vector bool `json:"vector"`
	Object bool `json:"object"`
	GPU    bool `json:"gpu"`
}

// ShapeError 精确报出是哪个制品缺哪几项能力。
// 只报「形态不满足」而不报缺哪项，等于把排查成本转嫁给部署者。
type ShapeError struct {
	Name    string
	Version string
	Missing []string
}

func (e *ShapeError) Error() string {
	return fmt.Sprintf("%s: %s@%s 需要 %v，目标形态未提供",
		ErrShapeUnsatisfied.Error(), e.Name, e.Version, e.Missing)
}
func (e *ShapeError) Unwrap() error { return ErrShapeUnsatisfied }

// Item 是安装计划中的一项。**所有字段都来自重解析结果**，不来自 PG。
type Item struct {
	Name      string            `json:"name"`
	Version   string            `json:"version"`
	Kind      manifest.Kind     `json:"kind"`
	Publisher string            `json:"publisher"`
	Digest    string            `json:"digest"`
	Signature []byte            `json:"signature,omitempty"`
	Scopes    []string          `json:"scopes"`
	Requires  manifest.Requires `json:"requires"`
}

// Plan 是一份安装计划。Items 保持闭包给出的拓扑序（被依赖者在前）。
type Plan struct {
	Root   string   `json:"root"`
	Items  []Item   `json:"items"`
	Scopes []string `json:"scopes"` // 全闭包 scope 的去重并集，供审批面一眼看全
	Shape  Shape    `json:"shape"`
}

// Build 生成安装计划。
//
// nodes 来自 resolve.Closure，本函数只用它的 Name/Version/Digest/Sig 与顺序；
// 其余一切从字节重解析得来。
func Build(ctx context.Context, nodes []resolve.Node, target Shape, objs objstore.Store, ts *trust.Store) (*Plan, error) {
	if len(nodes) == 0 {
		return nil, errors.New("registry: 空闭包，无从生成计划")
	}

	items := make([]Item, 0, len(nodes))
	scopeSet := map[string]struct{}{}

	for _, n := range nodes {
		raw, err := objs.Get(ctx, n.Digest)
		if err != nil {
			return nil, fmt.Errorf("registry: 取 %s@%s 的字节失败: %w", n.Name, n.Version, err)
		}

		m, err := manifest.Parse(raw)
		if err != nil {
			return nil, fmt.Errorf("registry: %s@%s 重解析失败: %w", n.Name, n.Version, err)
		}
		if err := ts.Verify(m.Publisher, raw, n.Sig); err != nil {
			return nil, fmt.Errorf("%w（%s@%s）", err, n.Name, n.Version)
		}

		// 身份断言：堵住「digest+sig 整体替换成另一份合法制品」。
		if m.Name != n.Name || m.Version != n.Version {
			return nil, fmt.Errorf("%w: 请求 %s@%s，字节里是 %s@%s",
				ErrIdentityMismatch, n.Name, n.Version, m.Name, m.Version)
		}

		// scope 上限按当前信任表重查：信任表可能在发布之后被收紧，
		// 已发布的制品不应因此拥有既得权限。
		pub, ok := ts.Lookup(m.Publisher)
		if !ok {
			return nil, fmt.Errorf("%w: %s", trust.ErrUnknownPublisher, m.Publisher)
		}
		if bad, within := trust.ScopesWithin(m.Scopes, pub.MaxScopes); !within {
			return nil, fmt.Errorf("%w: %s@%s 声明 %s", trust.ErrScopeEscalation, m.Name, m.Version, bad)
		}

		if missing := shapeGap(m.Requires, target); len(missing) > 0 {
			return nil, &ShapeError{Name: m.Name, Version: m.Version, Missing: missing}
		}

		for _, sc := range m.Scopes {
			scopeSet[sc] = struct{}{}
		}
		items = append(items, Item{
			Name: m.Name, Version: m.Version, Kind: m.Kind, Publisher: m.Publisher,
			Digest: n.Digest, Signature: append([]byte(nil), n.Sig...), Scopes: m.Scopes, Requires: m.Requires,
		})
	}

	scopes := make([]string, 0, len(scopeSet))
	for sc := range scopeSet {
		scopes = append(scopes, sc)
	}
	sort.Strings(scopes)

	root := items[len(items)-1] // 拓扑序的最后一个是根
	return &Plan{
		Root:   root.Name + "@" + root.Version,
		Items:  items,
		Scopes: scopes,
		Shape:  target,
	}, nil
}

// shapeGap 返回 req 要求但 target 未提供的能力名，按固定顺序，便于测试与人读。
func shapeGap(req manifest.Requires, target Shape) []string {
	var missing []string
	check := []struct {
		name string
		want bool
		have bool
	}{
		{"olap", req.OLAP, target.OLAP},
		{"graph", req.Graph, target.Graph},
		{"vector", req.Vector, target.Vector},
		{"object", req.Object, target.Object},
		{"gpu", req.GPU, target.GPU},
	}
	for _, c := range check {
		if c.want && !c.have {
			missing = append(missing, c.name)
		}
	}
	return missing
}

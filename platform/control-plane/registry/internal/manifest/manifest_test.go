package manifest_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/registry/internal/manifest"
)

// good 返回一份合法的 Component manifest 原始字节。
func good() []byte {
	return []byte(`{
		"apiVersion": "lumo.artifact/v1",
		"kind": "Component",
		"name": "sales-funnel-analysis",
		"version": "1.4.0",
		"publisher": "acme",
		"scopes": ["kb:query"],
		"requires": {"olap": true},
		"deps": [{"name": "sales-kb", "version": "2.0.1"}]
	}`)
}

func TestParseGood(t *testing.T) {
	m, err := manifest.Parse(good())
	if err != nil {
		t.Fatalf("合法 manifest 应解析成功: %v", err)
	}
	if m.Kind != manifest.KindComponent || m.Name != "sales-funnel-analysis" {
		t.Fatalf("字段解析错: %+v", m)
	}
	if !m.Requires.OLAP || m.Requires.Graph {
		t.Fatalf("requires 解析错: %+v", m.Requires)
	}
	if len(m.Deps) != 1 || m.Deps[0].Version != "2.0.1" {
		t.Fatalf("deps 解析错: %+v", m.Deps)
	}
}

// TestParseRejects 逐条校验拒绝理由——每条都要报出具体字段，
// 否则发布者面对 400 只能猜。
func TestParseRejects(t *testing.T) {
	cases := []struct {
		name string
		raw  string
		want string
	}{
		{"未知 apiVersion", `{"apiVersion":"dsh.component/v1","kind":"Component","name":"a-b","version":"1.0.0","publisher":"p","scopes":["x:y"]}`, "apiVersion"},
		{"未知 kind", `{"apiVersion":"lumo.artifact/v1","kind":"Widget","name":"a-b","version":"1.0.0","publisher":"p","scopes":["x:y"]}`, "kind"},
		{"未知字段", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"a-b","version":"1.0.0","publisher":"p","scopes":["x:y"],"extra":1}`, "extra"},
		{"名字非法", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"A_B","version":"1.0.0","publisher":"p","scopes":["x:y"]}`, "name"},
		{"版本非三段", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"a-b","version":"1.4","publisher":"p","scopes":["x:y"]}`, "version"},
		{"publisher 空", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"a-b","version":"1.0.0","publisher":"","scopes":["x:y"]}`, "publisher"},
		{"scopes 空", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"a-b","version":"1.0.0","publisher":"p","scopes":[]}`, "scopes"},
		{"scope 格式错", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"a-b","version":"1.0.0","publisher":"p","scopes":["nocolon"]}`, "scopes"},
		{"自依赖", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"a-b","version":"1.0.0","publisher":"p","scopes":["x:y"],"deps":[{"name":"a-b","version":"1.0.0"}]}`, "自依赖"},
		{"依赖版本非法", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"a-b","version":"1.0.0","publisher":"p","scopes":["x:y"],"deps":[{"name":"c-d","version":"latest"}]}`, "deps"},
		{"重复依赖", `{"apiVersion":"lumo.artifact/v1","kind":"Skill","name":"a-b","version":"1.0.0","publisher":"p","scopes":["x:y"],"deps":[{"name":"c-d","version":"1.0.0"},{"name":"c-d","version":"2.0.0"}]}`, "重复"},
		{"空字节", ``, "空"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			_, err := manifest.Parse([]byte(tc.raw))
			if err == nil {
				t.Fatal("应被拒绝，但解析成功了")
			}
			if !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("错误信息应含 %q，实得: %v", tc.want, err)
			}
		})
	}
}

// TestParseIsByteExact 解析不得改写原始字节：同一份字节两次解析结果一致，
// 且解析不产生「规范化后的字节」这种东西——签名覆盖的就是入参本身。
func TestParseIsByteExact(t *testing.T) {
	raw := good()
	before := string(raw)
	if _, err := manifest.Parse(raw); err != nil {
		t.Fatalf("解析失败: %v", err)
	}
	if string(raw) != before {
		t.Fatal("Parse 改写了入参字节——签名覆盖的对象被动过")
	}
}

// TestSchemaParity JSON Schema 与 Go 结构体必填字段一致。
// 两份定义并存必然漂移，这条用例是唯一的看门狗。
func TestSchemaParity(t *testing.T) {
	kinds := map[manifest.Kind]string{
		manifest.KindComponent: "component",
		manifest.KindSkill:     "skill",
		manifest.KindAgent:     "agent",
		manifest.KindConnector: "connector",
		manifest.KindFlow:      "flow",
	}
	for k, file := range kinds {
		path := filepath.Join("..", "..", "..", "..", "shared", "manifests", file+".schema.json")
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatalf("读 %s 失败: %v", path, err)
		}
		var doc struct {
			Required []string `json:"required"`
		}
		if err := json.Unmarshal(raw, &doc); err != nil {
			t.Fatalf("%s 不是合法 JSON: %v", path, err)
		}
		want := manifest.RequiredFields(k)
		if len(doc.Required) != len(want) {
			t.Fatalf("%s required 数量 %d，Go 侧 %d: %v vs %v", file, len(doc.Required), len(want), doc.Required, want)
		}
		set := map[string]bool{}
		for _, f := range doc.Required {
			set[f] = true
		}
		for _, f := range want {
			if !set[f] {
				t.Fatalf("%s 的 schema 缺必填字段 %q", file, f)
			}
		}
	}
}

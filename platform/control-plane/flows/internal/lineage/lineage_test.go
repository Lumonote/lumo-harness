package lineage

import (
	"sort"
	"strings"
	"testing"

	"github.com/lumo-harness/platform/flows/internal/domain"
)

func node(id, operator string) domain.FlowNode {
	return domain.FlowNode{ID: id, Operator: operator}
}

func edge(from, to, typ string) domain.FlowEdge {
	return domain.FlowEdge{From: from, To: to, Type: typ}
}

// key 把一条边压成便于比较的字符串：断言「边集合相等」而不是逐字段写。
func key(e Edge) string {
	return strings.Join([]string{e.FlowID, e.FromNode, e.ToNode, e.EdgeType, e.FromOperator, e.ToOperator}, "|")
}

func keys(edges []Edge) []string {
	out := make([]string, 0, len(edges))
	for _, e := range edges {
		out = append(out, key(e))
	}
	sort.Strings(out)
	return out
}

func TestExtractShapes(t *testing.T) {
	chain := &domain.Definition{
		Nodes: []domain.FlowNode{node("a", "llm"), node("b", "connector"), node("c", "notify")},
		Edges: []domain.FlowEdge{edge("a", "b", ""), edge("b", "c", "")},
	}
	diamond := &domain.Definition{
		Nodes: []domain.FlowNode{node("a", "llm"), node("b", "tool"), node("c", "tool"), node("d", "notify")},
		Edges: []domain.FlowEdge{edge("a", "b", ""), edge("a", "c", ""), edge("b", "d", ""), edge("c", "d", "")},
	}

	cases := []struct {
		name  string
		def   *domain.Definition
		flow  string
		ver   int
		realm string
		want  []string
	}{
		{
			name: "线性链：两边、算子名随边带上、缺省类型按数据流",
			def:  chain, flow: "f1", ver: 1, realm: "acme",
			want: []string{"f1|a|b|data|llm|connector", "f1|b|c|data|connector|notify"},
		},
		{
			name: "菱形：同一上游扇出两条边，不去重",
			def:  diamond, flow: "f1", ver: 3, realm: "acme",
			want: []string{
				"f1|a|b|data|llm|tool", "f1|a|c|data|llm|tool",
				"f1|b|d|data|tool|notify", "f1|c|d|data|tool|notify",
			},
		},
		{
			name: "孤立节点：无边不报错，产出空集合（不是 nil 语义上的错误）",
			def:  &domain.Definition{Nodes: []domain.FlowNode{node("solo", "llm")}},
			flow: "f1", ver: 1, realm: "acme", want: nil,
		},
		{
			name: "显式控制流类型被保留，不被当成数据流覆盖",
			def: &domain.Definition{
				Nodes: []domain.FlowNode{node("a", "guard"), node("b", "llm")},
				Edges: []domain.FlowEdge{edge("a", "b", EdgeTypeControl)},
			},
			flow: "f1", ver: 2, realm: "acme",
			want: []string{"f1|a|b|control|guard|llm"},
		},
		{
			name: "同一对节点两种边类型是两条不同的边（与 PG 唯一约束的键一致）",
			def: &domain.Definition{
				Nodes: []domain.FlowNode{node("a", "guard"), node("b", "llm")},
				Edges: []domain.FlowEdge{edge("a", "b", EdgeTypeControl), edge("a", "b", EdgeTypeData)},
			},
			flow: "f1", ver: 2, realm: "acme",
			want: []string{"f1|a|b|control|guard|llm", "f1|a|b|data|guard|llm"},
		},
		{
			name: "重复边去重：同 From→To 同类型只留一条",
			def: &domain.Definition{
				Nodes: []domain.FlowNode{node("a", "llm"), node("b", "tool")},
				Edges: []domain.FlowEdge{edge("a", "b", ""), edge("a", "b", ""), edge("a", "b", EdgeTypeData)},
			},
			flow: "f1", ver: 1, realm: "acme",
			want: []string{"f1|a|b|data|llm|tool"},
		},
		{
			name: "缺算子名不阻断血缘：标签为空但边仍然成立",
			def: &domain.Definition{
				Nodes: []domain.FlowNode{node("a", ""), node("b", "tool")},
				Edges: []domain.FlowEdge{edge("a", "b", "")},
			},
			flow: "f1", ver: 1, realm: "acme",
			want: []string{"f1|a|b|data||tool"},
		},
		{
			name: "realm 原样落到边上（空 realm 也是明确值，不是遗漏）",
			def:  chain, flow: "f1", ver: 1, realm: "",
			want: []string{"f1|a|b|data|llm|connector", "f1|b|c|data|connector|notify"},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, err := Extract(tc.def, tc.flow, tc.ver, tc.realm)
			if err != nil {
				t.Fatalf("不应报错: %v", err)
			}
			if len(got) == 0 && len(tc.want) == 0 {
				// 空定义分支：只断言没有边，realm/version 无从谈起。
				return
			}
			if diff := keys(got); !equalStrings(diff, tc.want) {
				t.Fatalf("边集合不符\n want %v\n got  %v", tc.want, diff)
			}
			for _, e := range got {
				if e.Realm != tc.realm {
					t.Fatalf("边 %s 的 realm 应为 %q，实际 %q", key(e), tc.realm, e.Realm)
				}
				if e.Version != tc.ver {
					t.Fatalf("边 %s 的 version 应为 %d，实际 %d", key(e), tc.ver, e.Version)
				}
				if e.FlowID != tc.flow {
					t.Fatalf("边 %s 的 flow_id 应为 %q，实际 %q", key(e), tc.flow, e.FlowID)
				}
			}
		})
	}
}

// TestExtractCrossVersionIdentity 跨版本同 node id：边必须能区分版本。
//
// 这是 requirement #5 点名的边界——如果血缘只按 node id 认节点，v1 与 v2 的同一算子会被
// 混成一个图节点，回放出来的历史就是错的（而且不会报错）。
func TestExtractCrossVersionIdentity(t *testing.T) {
	def := &domain.Definition{
		Nodes: []domain.FlowNode{node("a", "llm"), node("b", "tool")},
		Edges: []domain.FlowEdge{edge("a", "b", "")},
	}
	v1, err := Extract(def, "f1", 1, "acme")
	if err != nil {
		t.Fatalf("v1 不应报错: %v", err)
	}
	v2, err := Extract(def, "f1", 2, "acme")
	if err != nil {
		t.Fatalf("v2 不应报错: %v", err)
	}
	if v1[0].Version == v2[0].Version {
		t.Fatalf("同 node id 的边在跨版本时必须可分：%+v vs %+v", v1[0], v2[0])
	}
	if got, want := nodeID(v1[0].FlowID, v1[0].Version, v1[0].FromNode), "flow:f1:v1:a"; got != want {
		t.Fatalf("图节点 id 应带版本前缀 %q，实际 %q", want, got)
	}
	if got, want := nodeID(v2[0].FlowID, v2[0].Version, v2[0].FromNode), "flow:f1:v2:a"; got != want {
		t.Fatalf("图节点 id 应带版本前缀 %q，实际 %q", want, got)
	}
}

// TestExtractRejections 每个拒绝分支都要有一条用例：本仓库的评审会拒绝「只检查好输入能过」
// 的测试，而血缘的拒绝分支正好决定了「发布会不会因为血缘失败而失败」。
func TestExtractRejections(t *testing.T) {
	cases := []struct {
		name    string
		def     *domain.Definition
		version int
		wantHas string
	}{
		{name: "nil 定义", def: nil, version: 1, wantHas: "非空流程定义"},
		{name: "零节点", def: &domain.Definition{}, version: 1, wantHas: "非空流程定义"},
		{name: "只有边没有节点", def: &domain.Definition{Edges: []domain.FlowEdge{edge("a", "b", "")}}, version: 1, wantHas: "非空流程定义"},
		{name: "version 为 0（未发布）", def: &domain.Definition{Nodes: []domain.FlowNode{node("a", "llm")}}, version: 0, wantHas: "已发布版本"},
		{name: "version 为负", def: &domain.Definition{Nodes: []domain.FlowNode{node("a", "llm")}}, version: -3, wantHas: "已发布版本"},
		{
			name:    "自环",
			def:     &domain.Definition{Nodes: []domain.FlowNode{node("a", "llm")}, Edges: []domain.FlowEdge{edge("a", "a", "")}},
			version: 1, wantHas: "自环",
		},
		{
			name: "三元环",
			def: &domain.Definition{
				Nodes: []domain.FlowNode{node("a", "llm"), node("b", "tool"), node("c", "notify")},
				Edges: []domain.FlowEdge{edge("a", "b", ""), edge("b", "c", ""), edge("c", "a", "")},
			},
			version: 1, wantHas: "含环",
		},
		{
			name: "悬空起点",
			def: &domain.Definition{
				Nodes: []domain.FlowNode{node("a", "llm")},
				Edges: []domain.FlowEdge{edge("ghost", "a", "")},
			},
			version: 1, wantHas: "悬空边",
		},
		{
			name: "悬空终点",
			def: &domain.Definition{
				Nodes: []domain.FlowNode{node("a", "llm")},
				Edges: []domain.FlowEdge{edge("a", "ghost", "")},
			},
			version: 1, wantHas: "悬空边",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			edges, err := Extract(tc.def, "f1", tc.version, "acme")
			if err == nil {
				t.Fatalf("应被拒绝，实际通过并给出 %d 条边", len(edges))
			}
			if !strings.Contains(err.Error(), tc.wantHas) {
				t.Fatalf("错误文案应含 %q，实际 %q", tc.wantHas, err.Error())
			}
		})
	}
}

// TestExtractSelfLoopBeatsCycleMessage 自环必须报「自环」而不是笼统的「含环」：
// 两者修法不同（前者是定义写错，后者是拓扑写错），文案混了就没法定位。
func TestExtractSelfLoopBeatsCycleMessage(t *testing.T) {
	def := &domain.Definition{
		Nodes: []domain.FlowNode{node("a", "llm"), node("b", "tool")},
		Edges: []domain.FlowEdge{edge("a", "b", ""), edge("b", "b", "")},
	}
	_, err := Extract(def, "f1", 1, "acme")
	if err == nil || !strings.Contains(err.Error(), "自环") {
		t.Fatalf("应报自环，实际: %v", err)
	}
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}

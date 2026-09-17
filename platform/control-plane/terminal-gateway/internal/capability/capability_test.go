package capability

import "testing"

// 一个「全量 renderer」的节点：本进程里所有节点都先按全集暴露，协商再按终端收窄，
// 这样「同一事件按终端类型降级成 card/table/chart」的选择结果才看得出来。
var fullNode = NodeView{
	Kind:      "cost_breakdown",
	Renderers: []RendererKey{RendererChart, RendererTable, RendererCard, RendererJSON},
}

func rk(list ...RendererKey) []RendererKey { return list }

func TestSelectRenderer_ByKind(t *testing.T) {
	cases := []struct {
		name string
		cap  Capabilities
		want RendererKey
		ok   bool
	}{
		// 各类终端在「能渲染全集」的前提下，应得到 §8.2 规定的默认形态。
		{"web→chart", Capabilities{Kind: KindWeb, Renderers: rk(RendererChart, RendererTable)}, RendererChart, true},
		{"cli→table", Capabilities{Kind: KindCLI, Renderers: rk(RendererTable)}, RendererTable, true},
		{"mobile→card", Capabilities{Kind: KindMobile, Renderers: rk(RendererCard, RendererChart)}, RendererCard, true},
		{"api→json", Capabilities{Kind: KindAPI, Renderers: rk(RendererJSON)}, RendererJSON, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, ok := SelectRenderer(c.cap, fullNode)
			if ok != c.ok || got != c.want {
				t.Fatalf("SelectRenderer = (%q,%v), want (%q,%v)", got, ok, c.want, c.ok)
			}
		})
	}
}

// 当终端未声明其类型默认 renderer 时，按 priority（最丰富优先）回落。
func TestSelectRenderer_FallbackByPriority(t *testing.T) {
	// web 只声明 table（不声明 chart）→ 得不到 chart，按 priority 落到 table。
	cap := Capabilities{Kind: KindWeb, Renderers: rk(RendererTable)}
	got, ok := SelectRenderer(cap, fullNode)
	if !ok || got != RendererTable {
		t.Fatalf("web 回落期望 table，得到 (%q,%v)", got, ok)
	}
}

// 反例：终端声明「什么都不会」→ 协商失败，必须诚实返回 false，而非兜底成未知 renderer。
func TestSelectRenderer_TerminalKnowsNothing(t *testing.T) {
	cap := Capabilities{Kind: KindWeb, Renderers: nil}
	if _, ok := SelectRenderer(cap, fullNode); ok {
		t.Fatalf("web 不声明任何 renderer 应当失败，却成功了")
	}
}

// 反例：节点只提供某终端无法渲染的形态 → 失败。mobile 只会 card，节点只给 table。
func TestSelectRenderer_NodeOffersIncompatible(t *testing.T) {
	cap := Capabilities{Kind: KindMobile, Renderers: rk(RendererCard)}
	node := NodeView{Kind: "x", Renderers: rk(RendererTable)}
	if _, ok := SelectRenderer(cap, node); ok {
		t.Fatalf("mobile 无法渲染 table，应当失败，却成功了")
	}
}

// 终端自声明认识了 chart，节点也提供 chart → 即便终端类型是 cli，也信任其声明返回 chart。
// 能力协商信任终端自报能力；敏感动作的鉴权另有 OPA/签名把关（见 internal/policy）。
func TestSelectRenderer_TrustsSelfDeclared(t *testing.T) {
	cap := Capabilities{Kind: KindCLI, Renderers: rk(RendererChart)}
	got, ok := SelectRenderer(cap, fullNode)
	if !ok || got != RendererChart {
		t.Fatalf("cli 自声明会 chart 应得到 chart，得到 (%q,%v)", got, ok)
	}
}

// 未登记的终端类型（ide）无 kindDefault，按 priority 从它认识的里挑最丰富的。
func TestSelectRenderer_UnknownKindFallsToPriority(t *testing.T) {
	cap := Capabilities{Kind: KindIDE, Renderers: rk(RendererJSON, RendererTable)}
	got, ok := SelectRenderer(cap, fullNode)
	if !ok || got != RendererTable {
		t.Fatalf("ide 应回落到 priority 第一个认识的(table)，得到 (%q,%v)", got, ok)
	}
}

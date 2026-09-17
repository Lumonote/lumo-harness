// Package capability 实现 §8.2 的能力协商：终端连接时声明 capabilities（终端类型 +
// 它认识的 renderer key），服务端据此算出「该终端应当用哪个 keyed renderer」渲染某个
// ConversationNodeDefinition。
//
// 协商结果必须是**可判定的纯函数**（见 SelectRenderer）——无时钟、无随机、无外部状态。
// 这是硬性要求：同一输入永远得到同一输出，才能被单测完整覆盖、也才能在多端之间保持
// 一致（web 给图表、CLI 给表格、mobile 给卡片）。
package capability

// TerminalKind 终端类型，对应架构 §8.2「web/CLI/IDE/mobile/API」。
type TerminalKind string

const (
	KindWeb    TerminalKind = "web"
	KindCLI    TerminalKind = "cli"
	KindMobile TerminalKind = "mobile"
	KindAPI    TerminalKind = "api"
	KindIDE    TerminalKind = "ide"
)

// RendererKey 是 keyed renderer 的标识（§8.2「按 keyed renderer 选渲染」）。
type RendererKey string

const (
	RendererChart RendererKey = "chart"
	RendererTable RendererKey = "table"
	RendererCard  RendererKey = "card"
	RendererJSON  RendererKey = "json"
)

// Capabilities 终端在连接时声明的能力。
type Capabilities struct {
	Kind      TerminalKind  // 终端类型，决定偏好 renderer
	Renderers []RendererKey // 该终端「认识」的 renderer key（自声明，网关信任）
}

// NodeView 一个 ConversationNodeDefinition 暴露给终端的渲染形态（已落地的 renderer 全集）。
// 真实系统中这份映射由各节点的定义给出；本进程用一份「全量」缺省即可演示协商如何随终端变化。
type NodeView struct {
	Kind      string        // 节点定义名（如 "cost_breakdown"），仅用于可读
	Renderers []RendererKey // 该节点实际可用 renderer
}

// kindDefault 每种终端类型偏好的 renderer，与 §8.2 逐字对应：
// web 给图表、CLI 给表格、mobile 给卡片、api 给原始 json。
var kindDefault = map[TerminalKind]RendererKey{
	KindWeb:    RendererChart,
	KindCLI:    RendererTable,
	KindMobile: RendererCard,
	KindAPI:    RendererJSON,
}

// priority 当终端未声明其类型默认 renderer 时，从「最丰富」到「最简」的回落顺序。
// 用于让能力较弱的终端仍能拿到一个它认识的最佳渲染形态。
var priority = []RendererKey{RendererChart, RendererTable, RendererCard, RendererJSON}

// SelectRenderer 是能力协商的**纯函数**：给定终端能力与该节点的可用 renderer，决定该终端
// 收到这个节点时应当用哪个 renderer 渲染。
//
// 确定性规则：
//  1. 取节点可用 renderer 中、终端声明「认识」的子集（supported）；
//  2. 若终端类型默认 renderer 在 supported 中，优先用它（最贴合该终端形态）；
//  3. 否则按 priority 选第一个 supported；
//  4. 若 supported 为空 → 该终端无法渲染此节点，返回 ("", false) 让上层**诚实报错**，
//     而不是静默兜底成某个它根本不认识的 renderer（那会让终端拿到无法解析的负载）。
func SelectRenderer(cap Capabilities, node NodeView) (RendererKey, bool) {
	known := make(map[RendererKey]bool, len(cap.Renderers))
	for _, r := range cap.Renderers {
		known[r] = true
	}
	var supported []RendererKey
	for _, r := range node.Renderers {
		if known[r] {
			supported = append(supported, r)
		}
	}
	if len(supported) == 0 {
		return "", false
	}
	if def, ok := kindDefault[cap.Kind]; ok && contains(supported, def) {
		return def, true
	}
	for _, p := range priority {
		if contains(supported, p) {
			return p, true
		}
	}
	return supported[0], true
}

func contains(s []RendererKey, r RendererKey) bool {
	for _, x := range s {
		if x == r {
			return true
		}
	}
	return false
}

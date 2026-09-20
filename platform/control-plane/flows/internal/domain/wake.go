// 唤醒归因（§24.9 第 1 条、§14 验收判据 10）。
//
// 判据原文：「一次由事件唤醒的 Run，其成本可按 wake 事件聚合查询（cost_type 闭集未扩）」。
// 这条判据在实现前是**空的**：事件能把流程叫醒（TriggerBus 的 cron/event → outbox →
// Bus → 绑定 → 执行），但被叫醒的那次执行烧掉的钱，在台账里没有任何一列能指回唤醒源。
//
// # 落点为什么是 trace 而不是新 cost_type
//
// §24.9 写明了：唤醒产生的成本按**既有 trace 维度**归因到唤醒事件，`cost_type` 闭集不扩
// （§22.5 不可逆清单、§23.4 明确不扩集）。所以这里不新增计费类型，而是给既有的
// `usage_ledger.trace_id` 一个**可解析的取值形状**。
//
// # 完整链路（每一段都已存在，本文件只补中间缺的那一段）
//
//	事件/wake 源  → flow_trigger_outbox.id          唤醒源身份，本来就有（表的主键）
//	              → flow_runs.trigger_id            「这个 Run 被谁唤醒」，本来就有（§11 外键）
//	              → 出站算子调用带 X-Lumo-Trace        ← **本文件补的就是这一段**
//	              → usage_ledger.trace_id            网关按头归因，本来就有
//
// 因此归因不需要新列、不需要新表：Run 到唤醒源的关系是 `flow_runs.trigger_id`，
// 成本到唤醒事件的关系是 `usage_ledger.trace_id = WakeTrace(trigger_id)`。两边都由
// 既有列承载，唯一的缺口是执行面从来没把唤醒源的键**带出去**——网关只好自己铸一个
// （`llm-gateway` 的 `gw-<随机>`），于是每一次调用各自成一个孤立的 trace，
// 「有多少钱花在等事件上」这个问题在数据上无法回答。
//
// # 查询形状
//
//	已知唤醒事件： SELECT sum(cost_usd) FROM usage_ledger WHERE trace_id = WakeTrace(<trigger_id>)
//	窗口内全部唤醒：SELECT sum(cost_usd) FROM usage_ledger WHERE trace_id LIKE 'flow-trigger-%'
//
// 前者是 trace_id 上的等值查询（usage_ledger_trace_idx 直接可用）；后者是前缀扫描，
// 用途是「本期有多少成本由事件回路产生」这类总量口径，量级上是巡检查询而不是在线路径。
package domain

import (
	"strconv"
	"strings"
)

// WakeTracePrefix 唤醒归因键的前缀。
//
// 为什么必须有前缀：trace_id 还有别的生产者（网关自己铸的 `gw-`、调用方自带的关联 id）。
// 没有前缀就无法把「这次花费来自一次唤醒」与「这次花费来自一次同步请求」分开，
// 而「有多少钱花在等事件上」（§24.9）要的正是这个区分。前缀同时是**跨语言可读**的：
// 看板与巡检直接按它筛，不需要 import 本包。
const WakeTracePrefix = "flow-trigger-"

// WakeTrace 把一次唤醒事件映射成计量台账里的 trace 值。
//
// triggerID 为 0（未知唤醒源）时返回空串，语义是「**不铸键**」而不是「铸一个空键」：
// 上游据此不设置 X-Lumo-Trace 头，网关便退回它自己的缺省铸法。这是 fail-closed 的
// 正确形状——不知道被谁唤醒时，台账里宁可留下一个明确不可归因的 trace，也不要留下
// 一个看起来像「第 0 号事件唤醒了它」的假归因；后者会被聚合查询当真，把成本记到
// 一个永不存在的唤醒源头上。
func WakeTrace(triggerID uint64) string {
	if triggerID == 0 {
		return ""
	}
	return WakeTracePrefix + strconv.FormatUint(triggerID, 10)
}

// ParseWakeTrace 从台账的 trace 值反解唤醒事件 id，第二返回值表示「这是一个唤醒键」。
//
// 这是「可查询」的另一半：只看 `usage_ledger` 里的一行，要能回答「这次花费是哪次唤醒
// 产生的」。只有写侧没有读侧的话，键的形状就只是约定，任何一处悄悄改格式都没人发现。
//
// 拒绝三种形状，各自的理由不同：
//   - 前缀不符：不是本机制产生的键（`gw-` 是网关自铸的，明确不可归因）。
//   - 解析失败或 0：前缀对但值非法——写侧不该产出它，读侧也不该猜。
//   - 前导零 / 加号等非规范写法（ParseUint 会接受 "007"）：同一个唤醒事件在台账里
//     成了两个字符串，聚合会静默裂成两行。规范化检查让这种写入变成读侧的显式失败，
//     而不是一份看起来正常的错账。
func ParseWakeTrace(trace string) (uint64, bool) {
	if !strings.HasPrefix(trace, WakeTracePrefix) {
		return 0, false
	}
	raw := strings.TrimPrefix(trace, WakeTracePrefix)
	id, err := strconv.ParseUint(raw, 10, 64)
	if err != nil || id == 0 {
		return 0, false
	}
	if strconv.FormatUint(id, 10) != raw {
		return 0, false
	}
	return id, true
}

/**
 * 第五类制品——用户自定义流程契约（§11 后半，设计说明
 * `docs/superpowers/specs/2026-08-26-user-flows-design.md`）。
 *
 * 流程是继组件/技能/智能体/连接器之后的第五类制品：用户在项目内低代码定义私有
 * 流程（DAG，复用 §9.2 算子目录），审核通过后提升为通用，再按 audience 定向分发。
 *
 * 本文件是闭集 + 三个纯函数（与 projects/cost-events 同风格）；Go 消费侧
 * （control-plane/flows）跑同一矩阵——契约双实现，语义同源。
 */

/** 生命周期状态闭集。deprecated 是终态——「复活」走版本回滚（重指快照），不是状态机转移。 */
export const FLOW_STATUSES = ['draft', 'submitted', 'published', 'targeted', 'deprecated'] as const
export type FlowStatus = (typeof FLOW_STATUSES)[number]

/**
 * 生命周期事件闭集。
 *
 * rollback **不在事件里**：回滚重指 `flows.version` 指向的发布快照，不改变状态——
 * published/targeted 流程回滚后仍是 published/targeted。把回滚做成状态转移会让
 * 「在跑的引用随回滚断语义」变成合法路径。
 */
export const FLOW_EVENTS = ['submit', 'approve', 'reject', 'target', 'deprecate'] as const
export type FlowEvent = (typeof FLOW_EVENTS)[number]

/** 可见性闭集（manifest 字段，与状态正交——published 且 private 是常态：进目录但只本项目可见）。 */
export const VISIBILITIES = ['private', 'targeted', 'global'] as const
export type FlowVisibility = (typeof VISIBILITIES)[number]

/** audience 形状（targeted 时 manifest 携带；roles/depts/users 任一命中即可见）。 */
export interface FlowAudience {
  roles?: string[]
  depts?: string[]
  users?: string[]
}

// 合法转移表。targeted --target--> targeted 是**幂等重定 audience**（定向参数变了，
// 状态没变）；draft --deprecate--> 是放弃草稿（未发布就死的流程不该占 submitted 队列）。
const TRANSITIONS: Record<FlowStatus, Partial<Record<FlowEvent, FlowStatus>>> = {
  draft: { submit: 'submitted', deprecate: 'deprecated' },
  submitted: { approve: 'published', reject: 'draft' },
  published: { target: 'targeted', deprecate: 'deprecated' },
  targeted: { target: 'targeted', deprecate: 'deprecated' },
  deprecated: {}, // 终态
}

/** 状态机。闭集外或非法转移**抛错**——静默 false 会把状态机的拼写错误藏到生产。 */
export function transitionFlow(status: FlowStatus, event: FlowEvent): FlowStatus {
  if (!FLOW_STATUSES.includes(status)) {
    throw new Error(`未知流程状态 ${String(status)}，合法取值：${FLOW_STATUSES.join(' / ')}`)
  }
  if (!FLOW_EVENTS.includes(event)) {
    throw new Error(`未知生命周期事件 ${String(event)}，合法取值：${FLOW_EVENTS.join(' / ')}`)
  }
  const next = TRANSITIONS[status][event]
  if (next === undefined) {
    throw new Error(`非法转移：${status} --${event}-->（查 TRANSITIONS——加转移是治理决定，不是顺手改）`)
  }
  return next
}

/** 流程定义（DAG）形状。operator 引用 §9.2 算子目录的算子 id——执行接线是 FlowEngine（P2）。 */
export interface FlowDefinition {
  nodes: Array<{ id: string; operator: string }>
  edges: Array<{ from: string; to: string }>
}

/**
 * 入库护栏（§9.2「提交校验」的可执行子集）：形状、节点唯一、算子非空、边引用存在、
 * **DAG 无环**（Kahn 拓扑排序）。
 *
 * 防环是硬护栏：环会让 FlowEngine 的断点续跑永不出活，入库前拦比运行时炸便宜一个
 * 数量级。OPA scope 与限流护栏随 §6.3 P2 接到同一校验链上。
 */
export function validateFlowDefinition(def: unknown): true {
  if (typeof def !== 'object' || def === null || Array.isArray(def)) {
    throw new Error('流程定义形状：须为 { nodes, edges } 对象')
  }
  const d = def as { nodes?: unknown; edges?: unknown }
  if (!Array.isArray(d.nodes) || !Array.isArray(d.edges)) {
    throw new Error('流程定义形状：nodes/edges 须为数组')
  }
  const nodes = d.nodes as Array<{ id?: unknown; operator?: unknown }>
  if (nodes.length === 0) {
    throw new Error('流程定义至少一个节点——空流程没有定义语义')
  }
  const ids = new Set<string>()
  for (const n of nodes) {
    if (typeof n.id !== 'string' || n.id === '') {
      throw new Error('节点 id 必须是非空字符串')
    }
    if (ids.has(n.id)) {
      throw new Error(`节点 id 必须唯一：${n.id} 重复`)
    }
    if (typeof n.operator !== 'string' || n.operator === '') {
      throw new Error(`节点 ${n.id} 缺算子（operator）——空算子是未完成的定义`)
    }
    ids.add(n.id)
  }
  // 邻接表 + 入度（Kahn）
  const adj = new Map<string, string[]>()
  const indeg = new Map<string, number>()
  for (const id of ids) {
    adj.set(id, [])
    indeg.set(id, 0)
  }
  for (const e of d.edges as Array<{ from?: unknown; to?: unknown }>) {
    if (typeof e.from !== 'string' || typeof e.to !== 'string') {
      throw new Error('边形状：from/to 必须是字符串')
    }
    if (!ids.has(e.from) || !ids.has(e.to)) {
      throw new Error(`边 ${e.from}→${e.to} 引用了不存在的节点`)
    }
    adj.get(e.from)!.push(e.to)
    indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1)
  }
  const queue = [...ids].filter((id) => indeg.get(id) === 0)
  let visited = 0
  while (queue.length > 0) {
    const cur = queue.shift()!
    visited++
    for (const next of adj.get(cur)!) {
      const d2 = (indeg.get(next) ?? 0) - 1
      indeg.set(next, d2)
      if (d2 === 0) queue.push(next)
    }
  }
  if (visited !== ids.size) {
    throw new Error('流程定义含环——DAG 是硬约束（拓扑排序未收敛）')
  }
  return true
}

/**
 * 定向可见性判据：roles/depts/users 任一命中即真。
 *
 * **空 audience 恒假**：targeted 但没配 audience 是配置错误——宁可全员不可见（配置方
 * 自己会发现）也不要全员可见（越权面）。
 */
export function audienceMatches(
  audience: FlowAudience | null | undefined,
  caller: { roles: string[]; depts?: string[]; user: string; dept?: string },
): boolean {
  if (audience === null || audience === undefined) return false
  const roles = audience.roles ?? []
  const depts = audience.depts ?? []
  const users = audience.users ?? []
  if (roles.length === 0 && depts.length === 0 && users.length === 0) return false
  if (users.includes(caller.user)) return true
  if (caller.roles.some((r) => roles.includes(r))) return true
  // dept 单值与 depts 数组是同一维度的两种携带方式（网关头给单值，组织树给数组）——
  // 取并集而不是二选一：空数组短路掉单值是「配置了却不可见」的静默错误。
  const callerDepts = [...(caller.depts ?? []), ...(caller.dept ? [caller.dept] : [])]
  if (callerDepts.some((d) => depts.includes(d))) return true
  return false
}

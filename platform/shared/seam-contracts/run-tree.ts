/**
 * 运行树契约（P0-3）：任务(Task) → 运行(Run) → 子 Agent(SubAgent)。
 *
 * 取代 lumo-ui 里用 `tasks.slice(0, 8)` 拼出来的“任务执行投影”。三类节点的事实源不同：
 *   - task / run：治理面（/lumo/api/tasks、/lumo/api/tasks/{id}/runs）；
 *   - subagent：dsh 上游扩展点 `subagent/start` / `subagent/end`（只读监听，不改 dsh），
 *     由 lumo-ui 后端采集持久化；
 *   - ask：P0-1 统一 Ask，按 source.run_id / source.session_ref 挂到节点上。
 * 父子关系：subagent.parentId = 直接创建者 session id（dsh `parentSessionId`），
 * 根级子 Agent 的创建者就是 run.session_ref，于是 run 节点 id 用 `run:<runId>`，
 * 并登记 session 别名，subagent 的 parentId 经别名解析到 run 节点。
 *
 * 借鉴 gugu `runtime/codex-subagents.mjs` 的“按职责命名、项目树里能看到谁做了什么”，
 * 但实现是纯函数 reducer + 快照/增量协议，便于前后端共用和表驱动测试。
 */

export type RunTreeNodeKind = 'task' | 'run' | 'subagent'
export type RunTreeStatus = 'pending' | 'running' | 'awaiting_ask' | 'succeeded' | 'failed' | 'cancelled'

export interface RunTreeNode {
  id: string
  kind: RunTreeNodeKind
  parentId?: string
  rootTaskId?: string | undefined
  status: RunTreeStatus
  title: string
  /** 执行者 / 子 Agent 名或 provider */
  agent?: string
  model?: string
  /** dsh session id（run 的 session_ref、subagent 的 child id），用于父子解析 */
  sessionId?: string
  startedAt?: string
  endedAt?: string | undefined
  askIds: string[]
  detail?: string
}

export interface RunTreeState {
  nodes: Record<string, RunTreeNode>
  /** sessionId → 节点 id */
  sessions: Record<string, string>
  /** 进入 awaiting_ask 前的状态，Ask 结束后恢复 */
  resume: Record<string, RunTreeStatus>
  /** 单调递增序号，增量订阅用 */
  seq: number
}

export type RunTreeEvent =
  | { type: 'node.upsert'; node: Partial<RunTreeNode> & Pick<RunTreeNode, 'id' | 'kind'> }
  | { type: 'subagent.start'; runId: string; childSessionId: string; parentSessionId: string; provider: string; at: string; name?: string; model?: string }
  | { type: 'subagent.end'; runId: string; childSessionId: string; parentSessionId: string; provider: string; stopReason: string; at: string; summary?: string }
  | { type: 'ask.pending'; askId: string; runId?: string; sessionRef?: string }
  | { type: 'ask.resolved'; askId: string; runId?: string; sessionRef?: string }

/** 增量协议：SSE 每帧一条 `{ seq, event }`；客户端发现 seq 跳号即重新拉快照。 */
export interface RunTreeDelta { seq: number; event: RunTreeEvent }
export interface RunTreeSnapshot { seq: number; nodes: RunTreeNode[] }

export const RUN_TREE_ROUTES = {
  snapshot: 'GET /lumo/api/run-tree?rootTaskId=',
  events: 'GET /lumo/api/run-tree/events',
} as const

export const TERMINAL_STATUSES: readonly RunTreeStatus[] = ['succeeded', 'failed', 'cancelled']

export function emptyRunTree(): RunTreeState { return { nodes: {}, sessions: {}, resume: {}, seq: 0 } }

export function subagentNodeId(childSessionId: string): string { return `subagent:${childSessionId}` }
export function runNodeId(runId: string): string { return `run:${runId}` }
export function taskNodeId(taskId: string): string { return `task:${taskId}` }

/** dsh SubagentStopReason → 树状态 */
export function statusFromStopReason(reason: string): RunTreeStatus {
  if (reason === 'completed') return 'succeeded'
  if (reason === 'aborted') return 'cancelled'
  return 'failed' // error / max-tokens / refusal / 未知扩展
}

/** 治理面 Task/Run 状态（大写）→ 树状态 */
export function statusFromTaskState(state: string): RunTreeStatus {
  switch (state.toUpperCase()) {
    case 'COMPLETED': case 'SUCCEEDED': case 'DONE': return 'succeeded'
    case 'FAILED': case 'BLOCKED': return 'failed'
    case 'CANCELLED': case 'CANCELED': return 'cancelled'
    case 'RUNNING': case 'CANCELLING': return 'running'
    case 'AWAITING_APPROVAL': case 'AWAITING-APPROVAL': return 'awaiting_ask'
    default: return 'pending'
  }
}

function resolveParent(state: RunTreeState, parentSessionId: string): string {
  return state.sessions[parentSessionId] ?? subagentNodeId(parentSessionId)
}

function rootOf(state: RunTreeState, parentId: string | undefined): string | undefined {
  const seen = new Set<string>()
  let id = parentId
  while (id !== undefined && !seen.has(id)) {
    seen.add(id)
    const node = state.nodes[id]
    if (node === undefined) return undefined
    if (node.rootTaskId !== undefined) return node.rootTaskId
    id = node.parentId
  }
  return undefined
}

function findAskTarget(state: RunTreeState, runId?: string, sessionRef?: string): string | undefined {
  if (sessionRef !== undefined && state.sessions[sessionRef] !== undefined) return state.sessions[sessionRef]
  if (runId !== undefined) {
    if (state.nodes[runNodeId(runId)] !== undefined) return runNodeId(runId)
    const sub = Object.values(state.nodes).find(n => n.kind === 'subagent' && n.detail === `dsh-run:${runId}`)
    if (sub !== undefined) return sub.id
  }
  return undefined
}

/** 纯 reducer：返回新 state（浅拷贝），不改入参。未知/不可定位事件原样返回但仍推进 seq。 */
export function applyRunTreeEvent(prev: RunTreeState, event: RunTreeEvent): RunTreeState {
  const state: RunTreeState = { nodes: { ...prev.nodes }, sessions: { ...prev.sessions }, resume: { ...prev.resume }, seq: prev.seq + 1 }
  switch (event.type) {
    case 'node.upsert': {
      const old = state.nodes[event.node.id]
      const merged: RunTreeNode = { ...(old ?? { status: 'pending', title: event.node.id, askIds: [] }), ...event.node }
      // 正在等 Ask 时，治理面的 running 不覆盖 awaiting_ask
      if (old?.status === 'awaiting_ask' && merged.status === 'running') merged.status = 'awaiting_ask'
      if (merged.rootTaskId === undefined) merged.rootTaskId = merged.kind === 'task' ? merged.id : rootOf(state, merged.parentId)
      state.nodes[merged.id] = merged
      if (merged.sessionId) state.sessions[merged.sessionId] = merged.id
      return state
    }
    case 'subagent.start': {
      const id = subagentNodeId(event.childSessionId)
      const parentId = resolveParent(state, event.parentSessionId)
      const old = state.nodes[id]
      state.nodes[id] = {
        ...old, askIds: old?.askIds ?? [], id, kind: 'subagent', parentId, rootTaskId: rootOf(state, parentId),
        status: 'running', title: event.name ?? old?.title ?? event.provider, agent: event.provider,
        ...(event.model ? { model: event.model } : {}), sessionId: event.childSessionId,
        startedAt: old?.startedAt ?? event.at, endedAt: undefined, detail: `dsh-run:${event.runId}`,
      }
      state.sessions[event.childSessionId] = id
      return state
    }
    case 'subagent.end': {
      const id = subagentNodeId(event.childSessionId)
      const old = state.nodes[id]
      const parentId = old?.parentId ?? resolveParent(state, event.parentSessionId)
      state.nodes[id] = {
        ...old, askIds: old?.askIds ?? [], title: old?.title ?? event.provider, id, kind: 'subagent', parentId,
        rootTaskId: old?.rootTaskId ?? rootOf(state, parentId), agent: event.provider, sessionId: event.childSessionId,
        status: statusFromStopReason(event.stopReason), endedAt: event.at,
        detail: event.summary ? event.summary.slice(0, 2000) : (old?.detail ?? `dsh-run:${event.runId}`),
      }
      delete state.resume[id]
      state.sessions[event.childSessionId] = id
      return state
    }
    case 'ask.pending': {
      const target = findAskTarget(state, event.runId, event.sessionRef)
      if (target === undefined) return state
      const node = state.nodes[target]!
      if (TERMINAL_STATUSES.includes(node.status)) return state
      if (node.status !== 'awaiting_ask') state.resume[target] = node.status
      state.nodes[target] = { ...node, status: 'awaiting_ask', askIds: node.askIds.includes(event.askId) ? node.askIds : [...node.askIds, event.askId] }
      return state
    }
    case 'ask.resolved': {
      const target = findAskTarget(state, event.runId, event.sessionRef)
        ?? Object.values(state.nodes).find(n => n.askIds.includes(event.askId))?.id
      if (target === undefined) return state
      const node = state.nodes[target]!
      const askIds = node.askIds.filter(id => id !== event.askId)
      // askIds 只保留“待处理”的 Ask；全部处理完才恢复原状态
      const status = node.status === 'awaiting_ask' && askIds.length === 0 ? (state.resume[target] ?? 'running') : node.status
      if (askIds.length === 0) delete state.resume[target]
      state.nodes[target] = { ...node, askIds, status }
      return state
    }
  }
}

export interface RunTreeItem { node: RunTreeNode; children: RunTreeItem[] }

/** 把扁平节点组装成森林；父节点缺失的节点作为根（例如尚未关联任务的子 Agent）。 */
export function buildRunTree(nodes: readonly RunTreeNode[]): RunTreeItem[] {
  const items = new Map<string, RunTreeItem>()
  for (const node of nodes) items.set(node.id, { node, children: [] })
  const roots: RunTreeItem[] = []
  for (const item of items.values()) {
    const parent = item.node.parentId !== undefined ? items.get(item.node.parentId) : undefined
    if (parent !== undefined && parent !== item && !isAncestor(items, item.node.id, parent.node.id)) parent.children.push(item)
    else roots.push(item)
  }
  const byTime = (a: RunTreeItem, b: RunTreeItem) => (a.node.startedAt ?? '').localeCompare(b.node.startedAt ?? '')
  const sortDeep = (list: RunTreeItem[]) => { list.sort(byTime); for (const it of list) sortDeep(it.children) }
  sortDeep(roots)
  return roots
}

function isAncestor(items: Map<string, RunTreeItem>, candidate: string, of: string): boolean {
  const seen = new Set<string>()
  let id: string | undefined = of
  while (id !== undefined && !seen.has(id)) {
    if (id === candidate) return true
    seen.add(id)
    id = items.get(id)?.node.parentId
  }
  return false
}

/** 只取某个任务的子树（rootTaskId 未定时按父链判断）。 */
export function selectRootTask(state: RunTreeState, rootTaskId: string): RunTreeNode[] {
  return Object.values(state.nodes).filter(n => n.id === rootTaskId || n.rootTaskId === rootTaskId || rootOf(state, n.parentId) === rootTaskId)
}

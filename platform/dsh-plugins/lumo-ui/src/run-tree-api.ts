/**
 * 运行树后端（P0-3）：
 *   1. 采集：只读监听 dsh 扩展点 `subagent/start` / `subagent/end`（dsh 不改），得到子 Agent 父子关系；
 *   2. 持久化：事件日志追加写 JSONL（与 skillhub 等同样落在 `.lumo/` 下的本地文件），启动时重放；
 *   3. 接口：`GET /lumo/api/run-tree`（快照，可按 rootTaskId / sessionIds 过滤）、
 *      `GET /lumo/api/run-tree/events`（SSE 增量，帧为 RunTreeDelta）、
 *      `POST /lumo/api/run-tree/links`（前端/治理面把 task、run 及其 session_ref 登记进来，
 *      让根级子 Agent 能挂到 run 下）、`POST /lumo/api/run-tree/asks`（Ask 关联/解除）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { ASK_RUN_TREE_EVENT } from '../../../shared/seam-contracts/asks.ts'
import { applyRunTreeEvent, emptyRunTree, selectRootTask, type RunTreeDelta, type RunTreeEvent, type RunTreeNode, type RunTreeState } from '../../../shared/seam-contracts/run-tree.ts'

const MAX_NODES = 5000

export class RunTreeStore {
  private state: RunTreeState = emptyRunTree()
  private readonly listeners = new Set<(delta: RunTreeDelta) => void>()
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try { this.state = applyRunTreeEvent(this.state, JSON.parse(line) as RunTreeEvent) } catch { /* 坏行跳过，不中断重放 */ }
      }
    }
  }
  apply(event: RunTreeEvent): RunTreeDelta {
    this.state = applyRunTreeEvent(this.state, event)
    if (Object.keys(this.state.nodes).length > MAX_NODES) this.prune()
    if (this.file) {
      try { mkdirSync(dirname(this.file), { recursive: true }); appendFileSync(this.file, `${JSON.stringify(event)}\n`) } catch { /* 持久化失败不影响内存视图 */ }
    }
    const delta = { seq: this.state.seq, event }
    for (const listener of this.listeners) { try { listener(delta) } catch { /* 单个订阅者异常不影响其他 */ } }
    return delta
  }
  snapshot(filter: { rootTaskId?: string; sessionIds?: string[] } = {}): { seq: number; nodes: RunTreeNode[] } {
    let nodes = filter.rootTaskId ? selectRootTask(this.state, filter.rootTaskId) : Object.values(this.state.nodes)
    if (filter.sessionIds?.length) {
      const wanted = new Set(filter.sessionIds)
      nodes = nodes.filter(n => n.kind !== 'subagent' || wanted.has(n.sessionId ?? '') || subtreeOf(this.state, n, wanted))
    }
    return { seq: this.state.seq, nodes }
  }
  subscribe(listener: (delta: RunTreeDelta) => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  /** 超限时丢弃最早结束的终态子 Agent（内存视图；日志保留供审计） */
  private prune(): void {
    const done = Object.values(this.state.nodes).filter(n => n.kind === 'subagent' && n.endedAt).sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? ''))
    const nodes = { ...this.state.nodes }
    for (const n of done.slice(0, Math.max(0, Object.keys(nodes).length - MAX_NODES))) delete nodes[n.id]
    this.state = { ...this.state, nodes }
  }
}

function subtreeOf(state: RunTreeState, node: RunTreeNode, sessions: Set<string>): boolean {
  const seen = new Set<string>()
  let id = node.parentId
  while (id !== undefined && !seen.has(id)) {
    seen.add(id)
    const parent = state.nodes[id]
    if (parent === undefined) return false
    if (parent.sessionId && sessions.has(parent.sessionId)) return true
    id = parent.parentId
  }
  return false
}

interface SubagentInfoLike { runId: string; provider: string; parentSessionId: string; id: string; stopReason?: string; lastAssistantMessage?: ReadonlyArray<{ type?: string; text?: string }> }
type LooseOn = { on(name: string, listener: (info: SubagentInfoLike) => void): () => void }

/** 监听 dsh 子 Agent 生命周期。dsh 未装配 subagent 时事件永不触发，无副作用。 */
export function registerRunTreeCollector(ctx: Context, store: RunTreeStore): void {
  const on = (ctx as unknown as LooseOn).on.bind(ctx)
  on('subagent/start', info => {
    store.apply({ type: 'subagent.start', runId: String(info.runId), childSessionId: String(info.id), parentSessionId: String(info.parentSessionId), provider: info.provider, at: new Date().toISOString() })
  })
  // P0-1：连接器 / owned-chat 等来源广播的 Ask 关联（带 run_id / session_ref），服务端直接挂树。
  ;(ctx as unknown as { on(name: string, listener: (link: unknown) => void): () => void }).on(ASK_RUN_TREE_EVENT, link => {
    const events = askEvents(link)
    if (typeof events !== 'string') for (const event of events) store.apply(event)
  })
  on('subagent/end', info => {
    const summary = info.lastAssistantMessage?.map(b => (b.type === 'text' ? b.text ?? '' : '')).join('').trim()
    store.apply({ type: 'subagent.end', runId: String(info.runId), childSessionId: String(info.id), parentSessionId: String(info.parentSessionId), provider: info.provider, stopReason: info.stopReason ?? 'error', at: new Date().toISOString(), ...(summary ? { summary } : {}) })
  })
}

const ID = /^[A-Za-z0-9._:@/-]{1,200}$/u
const STATUSES = new Set(['pending', 'running', 'awaiting_ask', 'succeeded', 'failed', 'cancelled'])

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export interface RunTreeRouteDeps { readBody: (req: IncomingMessage) => Promise<Buffer> }

/** 处理了返回 true；未匹配返回 false。 */
export async function handleRunTreeRoute(req: IncomingMessage, res: ServerResponse, pathname: string, store: RunTreeStore | undefined, deps: RunTreeRouteDeps): Promise<boolean> {
  if (!pathname.startsWith('/lumo/api/run-tree')) return false
  if (store === undefined) { json(res, 503, { error: '运行树未装配' }); return true }
  if (req.method === 'GET' && pathname === '/lumo/api/run-tree') {
    const params = new URL(req.url ?? '/', 'http://lumo.local').searchParams
    const rootTaskId = params.get('rootTaskId') ?? undefined
    const sessionIds = (params.get('sessionIds') ?? '').split(',').map(s => s.trim()).filter(s => ID.test(s)).slice(0, 200)
    if (rootTaskId !== undefined && !ID.test(rootTaskId)) { json(res, 400, { error: 'invalid rootTaskId' }); return true }
    json(res, 200, store.snapshot({ ...(rootTaskId ? { rootTaskId } : {}), ...(sessionIds.length ? { sessionIds } : {}) }))
    return true
  }
  if (req.method === 'GET' && pathname === '/lumo/api/run-tree/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
    res.write(`event: hello\ndata: ${JSON.stringify({ seq: store.snapshot().seq })}\n\n`)
    const off = store.subscribe(delta => { res.write(`event: delta\ndata: ${JSON.stringify(delta)}\n\n`) })
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
    req.on('close', () => { off(); clearInterval(ping); res.end() })
    return true
  }
  if (req.method === 'POST' && (pathname === '/lumo/api/run-tree/links' || pathname === '/lumo/api/run-tree/asks')) {
    let body: unknown
    try { body = JSON.parse((await deps.readBody(req)).toString('utf8') || '{}') } catch { json(res, 400, { error: 'invalid json' }); return true }
    const events = pathname.endsWith('/links') ? linkEvents(body) : askEvents(body)
    if (typeof events === 'string') { json(res, 400, { error: events }); return true }
    let seq = 0
    for (const event of events) seq = store.apply(event).seq
    json(res, 200, { applied: events.length, seq })
    return true
  }
  json(res, 404, { error: 'unknown run-tree route' })
  return true
}

/** body: { nodes: [{ id, kind: 'task'|'run', parentId?, sessionId?, status?, title?, agent?, model?, startedAt?, endedAt? }] } */
export function linkEvents(body: unknown): RunTreeEvent[] | string {
  const list = (body as { nodes?: unknown })?.nodes
  if (!Array.isArray(list) || list.length > 200) return 'nodes must be an array (≤200)'
  const out: RunTreeEvent[] = []
  for (const raw of list as Array<Record<string, unknown>>) {
    if (!raw || typeof raw !== 'object') return 'invalid node'
    const id = raw.id, kind = raw.kind
    if (typeof id !== 'string' || !ID.test(id) || (kind !== 'task' && kind !== 'run')) return 'invalid node id/kind'
    const node: Extract<RunTreeEvent, {type:'node.upsert'}>['node'] = { id, kind }
    for (const key of ['parentId', 'sessionId', 'title', 'agent', 'model', 'startedAt', 'endedAt', 'detail'] as const) {
      if (typeof raw[key] === 'string') node[key] = (raw[key] as string).slice(0, 500)
    }
    if (typeof raw.status === 'string') { if (!STATUSES.has(raw.status)) return 'invalid status'; node.status = raw.status as RunTreeNode['status'] }
    out.push({ type: 'node.upsert', node })
  }
  return out
}

/** body: { askId, state: 'pending'|'resolved', runId?, sessionRef? }，与 P0-1 Ask.source.run_id / session_ref 对齐 */
export function askEvents(body: unknown): RunTreeEvent[] | string {
  const b = body as { askId?: unknown; state?: unknown; runId?: unknown; sessionRef?: unknown }
  if (typeof b?.askId !== 'string' || !ID.test(b.askId)) return 'invalid askId'
  const runId = typeof b.runId === 'string' && ID.test(b.runId) ? b.runId : undefined
  const sessionRef = typeof b.sessionRef === 'string' && ID.test(b.sessionRef) ? b.sessionRef : undefined
  if (b.state === 'pending') return [{ type: 'ask.pending', askId: b.askId, ...(runId ? { runId } : {}), ...(sessionRef ? { sessionRef } : {}) }]
  if (b.state === 'resolved') return [{ type: 'ask.resolved', askId: b.askId, ...(runId ? { runId } : {}), ...(sessionRef ? { sessionRef } : {}) }]
  return 'state must be pending|resolved'
}

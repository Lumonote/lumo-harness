/**
 * 运行树面板（P0-3）：任务 → 运行 → 子 Agent，替换旧的“任务执行投影”（OrchestrationTopology）。
 *
 * 数据流：
 *   1. 取最近任务及其 runs（治理面现有接口），把 task/run 及 run.session_ref 登记到 /lumo/api/run-tree/links；
 *   2. 取 /lumo/api/asks 的待处理 Ask，按 source.run_id / session_ref 登记到 /lumo/api/run-tree/asks；
 *   3. 拉快照 /lumo/api/run-tree，再订阅 /lumo/api/run-tree/events 增量（seq 跳号就重拉快照）。
 * 回退开关：localStorage `lumo.runTree = 'legacy'`（或 URL `?runTree=legacy`）恢复旧拼接视图。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { applyRunTreeEvent, buildRunTree, emptyRunTree, runNodeId, statusFromTaskState, taskNodeId, type RunTreeDelta, type RunTreeItem, type RunTreeNode, type RunTreeState, type RunTreeStatus } from '../../../../shared/seam-contracts/run-tree.ts'
import type { Ask } from '../../../../shared/seam-contracts/asks.ts'
import { effectiveStatus } from '../../../../shared/seam-contracts/asks.ts'
import { api } from './api.ts'
import { BusyButton, Empty, Notice } from './surface-shell.tsx'
import './run-tree-panel.css'

export const RUN_TREE_FLAG = 'lumo.runTree'

/** 默认启用新运行树；显式设成 legacy 才回退旧视图。 */
export function runTreeEnabled(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('runTree') === 'legacy') return false
    if (typeof localStorage !== 'undefined' && localStorage.getItem(RUN_TREE_FLAG) === 'legacy') return false
  } catch { /* 隐私模式等读不到存储时用默认值 */ }
  return true
}

export interface RunTreeTask { id: string; title: string; state: string; assignee_name?: string; assignee_worker_id?: string; assignee_user_id: string; created_at: string; updated_at: string }
interface TaskRunLite { id: string; attempt: number; worker_id: string; session_ref?: string; state: string; started_at?: string; ended_at?: string; created_at: string; last_error?: string }

export const RUN_TREE_STATUS_LABEL: Record<RunTreeStatus, string> = {
  pending: '等待中', running: '运行中', awaiting_ask: '等待人工', succeeded: '已完成', failed: '失败', cancelled: '已取消',
}
/** 状态色走 CSS 变量，主题缺省时给出可读的回退色 */
export const RUN_TREE_STATUS_COLOR: Record<RunTreeStatus, string> = {
  pending: 'var(--lumo-muted, #8a8f98)', running: 'var(--lumo-accent, #3b82f6)', awaiting_ask: 'var(--lumo-warning, #d97706)',
  succeeded: 'var(--lumo-success, #16a34a)', failed: 'var(--lumo-danger, #dc2626)', cancelled: 'var(--lumo-muted, #6b7280)',
}
const KIND_LABEL: Record<RunTreeNode['kind'], string> = { task: '任务', run: '运行', subagent: '子 Agent' }

export function RunTreePanel<T extends RunTreeTask>({ tasks, showRuns, limit = 8 }: { tasks: T[]; showRuns?: (task: T) => Promise<void>; limit?: number }) {
  const [tree, setTree] = useState<RunTreeState>(emptyRunTree)
  const [asks, setAsks] = useState<Ask[]>([])
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({})
  const [selected, setSelected] = useState<string>('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const seqRef = useRef(0)
  const visible = useMemo(() => tasks.slice(0, limit), [tasks, limit])

  const loadSnapshot = useCallback(async () => {
    const snap = await api<{ seq: number; nodes: RunTreeNode[] }>('/lumo/api/run-tree')
    const state = emptyRunTree()
    for (const node of snap.nodes) {
      state.nodes[node.id] = node
      if (node.sessionId) state.sessions[node.sessionId] = node.id
    }
    state.seq = snap.seq
    seqRef.current = snap.seq
    setTree(state)
  }, [])

  const sync = useCallback(async () => {
    setLoading(true); setNotice('')
    try {
      const links: Array<Record<string, unknown>> = []
      const runsByTask = await Promise.all(visible.map(task => api<{ runs?: TaskRunLite[] }>(`/lumo/api/tasks/${encodeURIComponent(task.id)}/runs`).then(r => r.runs ?? []).catch(() => [] as TaskRunLite[])))
      visible.forEach((task, index) => {
        links.push({ id: taskNodeId(task.id), kind: 'task', title: task.title, status: statusFromTaskState(task.state), agent: task.assignee_name ?? task.assignee_worker_id ?? task.assignee_user_id, startedAt: task.created_at })
        for (const run of runsByTask[index]!) {
          links.push({
            id: runNodeId(run.id), kind: 'run', parentId: taskNodeId(task.id), title: `第 ${run.attempt} 次运行`, status: statusFromTaskState(run.state), agent: run.worker_id,
            ...(run.session_ref ? { sessionId: run.session_ref } : {}), startedAt: run.started_at ?? run.created_at, ...(run.ended_at ? { endedAt: run.ended_at } : {}), ...(run.last_error ? { detail: run.last_error } : {}),
          })
        }
      })
      if (links.length) await api('/lumo/api/run-tree/links', { method: 'POST', body: JSON.stringify({ nodes: links }) })
      const askList = await api<{ asks: Ask[] }>('/lumo/api/asks').then(r => r.asks ?? []).catch(() => [] as Ask[])
      setAsks(askList)
      for (const ask of askList) {
        if (!ask.source.run_id && !ask.source.session_ref) continue
        const state = effectiveStatus(ask) === 'pending' ? 'pending' : 'resolved'
        await api('/lumo/api/run-tree/asks', { method: 'POST', body: JSON.stringify({ askId: ask.id, state, runId: ask.source.run_id, sessionRef: ask.source.session_ref }) }).catch(() => undefined)
      }
      await loadSnapshot()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) }
  }, [visible, loadSnapshot])

  useEffect(() => { void sync() }, [sync])
  useEffect(() => {
    if (typeof EventSource === 'undefined') return
    const source = new EventSource('/lumo/api/run-tree/events')
    source.addEventListener('delta', message => {
      try {
        const delta = JSON.parse((message as MessageEvent<string>).data) as RunTreeDelta
        if (delta.seq !== seqRef.current + 1) { void loadSnapshot(); return }
        seqRef.current = delta.seq
        setTree(current => applyRunTreeEvent(current, delta.event))
      } catch { void loadSnapshot() }
    })
    source.onerror = () => source.close()
    return () => source.close()
  }, [loadSnapshot])

  const forest = useMemo(() => {
    const ids = new Set(visible.map(task => taskNodeId(task.id)))
    return buildRunTree(Object.values(tree.nodes)).filter(item => ids.has(item.node.id) || item.node.kind === 'subagent')
  }, [tree, visible])
  const node = selected ? tree.nodes[selected] : undefined
  const nodeAsks = node ? asks.filter(ask => node.askIds.includes(ask.id) || (node.sessionId !== undefined && ask.source.session_ref === node.sessionId)) : []
  const task = node?.rootTaskId ? visible.find(t => taskNodeId(t.id) === node.rootTaskId) : undefined

  return <div className="lumo-run-tree" data-run-tree="v1">
    <header><div><span className="lumo-inspector-label">任务 → 运行 → 子 Agent</span><b>运行树</b><small>子 Agent 来自 dsh 生命周期事件；等待人工的节点会关联到待处理 Ask。</small></div><BusyButton busy={loading} className="lumo-small" onClick={() => void sync()}>刷新</BusyButton></header>
    {notice ? <Notice error close={() => setNotice('')}>{notice}</Notice> : null}
    {forest.length ? <ul role="tree" className="lumo-run-tree-list">{forest.map(item => <RunTreeRow key={item.node.id} item={item} depth={0} collapsed={collapsed} toggle={id => setCollapsed(c => ({ ...c, [id]: !c[id] }))} selected={selected} select={setSelected} />)}</ul> : visible.length && showRuns ? <ul>{visible.map(t => <li key={t.id}>{t.title} <BusyButton className="lumo-small" onClick={() => void showRuns(t)}>执行详情</BusyButton></li>)}</ul> : <Empty>还没有可展示的任务；创建委派后会出现任务、运行和子 Agent。</Empty>}
    {node ? <aside className="lumo-run-tree-detail" aria-label="节点详情">
      <b>{KIND_LABEL[node.kind]} · {node.title}</b>
      <small>{node.id}</small>
      <dl>
        <dt>状态</dt><dd style={{ color: RUN_TREE_STATUS_COLOR[node.status] }}>{RUN_TREE_STATUS_LABEL[node.status]}</dd>
        {node.agent ? <><dt>执行者</dt><dd>{node.agent}</dd></> : null}
        {node.model ? <><dt>模型</dt><dd>{node.model}</dd></> : null}
        {node.startedAt ? <><dt>开始</dt><dd>{node.startedAt}</dd></> : null}
        {node.endedAt ? <><dt>结束</dt><dd>{node.endedAt}</dd></> : null}
        {node.detail ? <><dt>说明</dt><dd>{node.detail}</dd></> : null}
      </dl>
      {nodeAsks.length ? <div><span className="lumo-inspector-label">待处理 Ask</span>{nodeAsks.map(ask => <p key={ask.id} data-ask-id={ask.id}><b>{ask.title}</b> <small>{effectiveStatus(ask)} · 到“待处理审批与提问”中处理</small></p>)}</div> : null}
      {task && showRuns ? <BusyButton className="lumo-small" onClick={() => void showRuns(task)}>执行详情</BusyButton> : null}
    </aside> : null}
  </div>
}

function RunTreeRow({ item, depth, collapsed, toggle, selected, select }: { item: RunTreeItem; depth: number; collapsed: Record<string, boolean>; toggle: (id: string) => void; selected: string; select: (id: string) => void }) {
  const { node, children } = item
  const open = !collapsed[node.id]
  return <li role="treeitem" aria-expanded={children.length ? open : undefined} aria-selected={selected === node.id} data-node-kind={node.kind} data-status={node.status}>
    <div className="lumo-run-tree-row" style={{ paddingLeft: depth * 16 }}>
      {children.length ? <button type="button" className="lumo-run-tree-toggle" aria-label={open ? '折叠' : '展开'} onClick={() => toggle(node.id)}>{open ? '▾' : '▸'}</button> : <span className="lumo-run-tree-toggle" aria-hidden="true">·</span>}
      <button type="button" className="lumo-run-tree-node" onClick={() => select(node.id)}>
        <i aria-hidden="true" style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: RUN_TREE_STATUS_COLOR[node.status], marginRight: 6 }} />
        <small>{KIND_LABEL[node.kind]}</small> <b>{node.title}</b> <small>{node.agent ?? ''} · {RUN_TREE_STATUS_LABEL[node.status]}{node.askIds.length ? ` · ${node.askIds.length} 个 Ask` : ''}</small>
      </button>
    </div>
    {children.length && open ? <ul role="group">{children.map(child => <RunTreeRow key={child.node.id} item={child} depth={depth + 1} collapsed={collapsed} toggle={toggle} selected={selected} select={select} />)}</ul> : null}
  </li>
}

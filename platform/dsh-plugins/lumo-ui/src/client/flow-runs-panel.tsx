import { useEffect, useRef, useState } from 'react'
import { api } from './api.ts'
import { BusyButton, Empty, Notice } from './surface-shell.tsx'

export interface FlowDefinition { nodes?: Array<{ id?: string; operator?: string }>; edges?: Array<{ from?: string; to?: string }> }

export function flowVersionChanges(previous: FlowDefinition, current: FlowDefinition): string[] {
  const nodeMap = (definition: FlowDefinition) => new Map((definition.nodes ?? []).filter(node => node.id).map(node => [node.id!, node.operator ?? '']))
  const edgeSet = (definition: FlowDefinition) => new Set((definition.edges ?? []).filter(edge => edge.from && edge.to).map(edge => `${edge.from}→${edge.to}`))
  const beforeNodes = nodeMap(previous); const afterNodes = nodeMap(current)
  const added = [...afterNodes.keys()].filter(id => !beforeNodes.has(id))
  const removed = [...beforeNodes.keys()].filter(id => !afterNodes.has(id))
  const changed = [...afterNodes.entries()].filter(([id, operator]) => beforeNodes.has(id) && beforeNodes.get(id) !== operator).map(([id, operator]) => `${id}（${beforeNodes.get(id)} → ${operator}）`)
  const beforeEdges = edgeSet(previous); const afterEdges = edgeSet(current)
  const edgeAdded = [...afterEdges].filter(edge => !beforeEdges.has(edge))
  const edgeRemoved = [...beforeEdges].filter(edge => !afterEdges.has(edge))
  const changes: string[] = []
  if (added.length) changes.push(`新增节点：${added.join('、')}`)
  if (removed.length) changes.push(`移除节点：${removed.join('、')}`)
  if (changed.length) changes.push(`节点算子变更：${changed.join('、')}`)
  if (edgeAdded.length) changes.push(`新增连线：${edgeAdded.join('、')}`)
  if (edgeRemoved.length) changes.push(`移除连线：${edgeRemoved.join('、')}`)
  return changes.length ? changes : ['两个发布快照的节点、算子和连线一致。']
}

interface FlowRun { id: number; automation_id: string; flow_version: number; status: string; error?: string; started_at: string }
interface RunResult { id: number; status: string; flowVersion: number; output?: unknown; error?: string; nodes: Array<{ nodeId: string; status: string; output?: unknown; error?: string }> }
const labels: Record<string, string> = { running: '运行中', succeeded: '已完成', failed: '失败', unknown: '结果未知' }

export function FlowRunsPanel({ flows, request = api }: { flows: Array<{ id?: string; name?: string }>; request?: typeof api }) {
  const [flowId, setFlowId] = useState('')
  const [runs, setRuns] = useState<FlowRun[]>([])
  const [result, setResult] = useState<RunResult | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const generation = useRef(0)
  const selection = useRef('')
  selection.current = flowId
  useEffect(() => {
    const epoch = ++generation.current
    const controller = new AbortController()
    setRuns([]); setResult(null); setError(''); setBusy(Boolean(flowId))
    if (flowId) void request<{ runs: FlowRun[] }>(`/lumo/api/flows/${encodeURIComponent(flowId)}/runs`, { signal: controller.signal }).then(data => {
      if (epoch === generation.current) setRuns(data.runs ?? [])
    }).catch(reason => { if (epoch === generation.current) setError(String(reason instanceof Error ? reason.message : reason)) })
      .finally(() => { if (epoch === generation.current) setBusy(false) })
    return () => { generation.current++; controller.abort() }
  }, [flowId, revision, request])
  useEffect(() => { if (flowId && !flows.some(flow => flow.id === flowId)) setFlowId('') }, [flows, flowId])
  const read = async (run: FlowRun) => {
    if (busy || run.automation_id !== 'manual') return
    const epoch = ++generation.current
    const selected = flowId
    setBusy(true); setError(''); setResult(null)
    try {
      const data = await request<RunResult>(`/lumo/api/flows/${encodeURIComponent(selected)}/runs/${run.id}/result`)
      if (epoch === generation.current && selection.current === selected) setResult(data)
    } catch (reason) { if (epoch === generation.current && selection.current === selected) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (epoch === generation.current && selection.current === selected) setBusy(false) }
  }
  return <section className="lumo-section">
    <div className="lumo-section-title"><b>流程运行记录</b><BusyButton busy={busy} disabled={!flowId} onClick={() => setRevision(value => value + 1)}>刷新记录</BusyButton></div>
    <label>查看流程<select aria-label="运行记录流程" value={flowId} onChange={event => { generation.current++; setResult(null); setFlowId(event.target.value) }}><option value="">选择流程</option>{flows.filter(flow => flow.id).map(flow => <option key={flow.id} value={flow.id}>{flow.name ?? flow.id}</option>)}</select></label>
    {error ? <Notice error>{error}</Notice> : null}
    {runs.length ? <ul>{runs.map(run => <li key={run.id}>#{run.id} · v{run.flow_version} · {labels[run.status] ?? run.status} · {run.automation_id === 'manual' ? '手动执行' : run.automation_id} {run.error ? <span>{run.error}</span> : null}{run.automation_id === 'manual' ? <BusyButton busy={busy} onClick={() => void read(run)}>查看结果 #{run.id}</BusyButton> : null}</li>)}</ul> : <Empty>{busy ? '正在读取运行记录…' : flowId ? '暂无运行记录。' : '选择流程后可查询断连前启动的运行。'}</Empty>}
    {result ? <div aria-label="流程执行结果"><b>#{result.id} · {labels[result.status] ?? result.status}</b>{result.error ? <p>{result.error}</p> : null}<p>仅发起人可查看手动运行结果。结果未知时请先核对外部操作；这里不会自动重放。</p><pre>{JSON.stringify({ nodes: result.nodes, output: result.output }, null, 2)}</pre></div> : null}
  </section>
}

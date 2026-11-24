import { describe, expect, it } from 'vitest'
import { applyRunTreeEvent, buildRunTree, emptyRunTree, runNodeId, selectRootTask, statusFromStopReason, statusFromTaskState, subagentNodeId, taskNodeId, type RunTreeEvent } from '../run-tree.ts'

const at = '2026-11-24T00:00:00Z'
function fold(events: RunTreeEvent[]) { return events.reduce(applyRunTreeEvent, emptyRunTree()) }
const base: RunTreeEvent[] = [
  { type: 'node.upsert', node: { id: taskNodeId('t1'), kind: 'task', title: '任务', status: 'running' } },
  { type: 'node.upsert', node: { id: runNodeId('r1'), kind: 'run', parentId: taskNodeId('t1'), sessionId: 's-root', status: 'running' } },
  { type: 'subagent.start', runId: 'd1', childSessionId: 'c1', parentSessionId: 's-root', provider: 'in-process', at },
  { type: 'subagent.start', runId: 'd2', childSessionId: 'c2', parentSessionId: 'c1', provider: 'acp', at },
]

describe('run tree reducer', () => {
  it('links subagents to run via session alias and inherits rootTaskId', () => {
    const s = fold(base)
    expect(s.nodes[subagentNodeId('c1')]!.parentId).toBe(runNodeId('r1'))
    expect(s.nodes[subagentNodeId('c2')]!.parentId).toBe(subagentNodeId('c1'))
    expect(s.nodes[subagentNodeId('c2')]!.rootTaskId).toBe(taskNodeId('t1'))
    expect(selectRootTask(s, taskNodeId('t1'))).toHaveLength(4)
    expect(s.seq).toBe(4)
  })
  it('maps stop reasons', () => {
    expect(statusFromStopReason('completed')).toBe('succeeded')
    expect(statusFromStopReason('aborted')).toBe('cancelled')
    expect(statusFromStopReason('max-tokens')).toBe('failed')
    expect(statusFromTaskState('QUEUED')).toBe('pending')
    const s = fold([...base, { type: 'subagent.end', runId: 'd2', childSessionId: 'c2', parentSessionId: 'c1', provider: 'acp', stopReason: 'completed', at }])
    expect(s.nodes[subagentNodeId('c2')]!.status).toBe('succeeded')
  })
  it('awaiting_ask round-trips and keeps pending ask ids', () => {
    let s = fold([...base, { type: 'ask.pending', askId: 'connector:a1', sessionRef: 'c1' }, { type: 'ask.pending', askId: 'connector:a2', sessionRef: 'c1' }])
    const id = subagentNodeId('c1')
    expect(s.nodes[id]!.status).toBe('awaiting_ask')
    expect(s.nodes[id]!.askIds).toEqual(['connector:a1', 'connector:a2'])
    s = applyRunTreeEvent(s, { type: 'ask.resolved', askId: 'connector:a1' })
    expect(s.nodes[id]!.status).toBe('awaiting_ask')
    s = applyRunTreeEvent(s, { type: 'ask.resolved', askId: 'connector:a2' })
    expect(s.nodes[id]!.status).toBe('running')
    expect(s.nodes[id]!.askIds).toEqual([])
  })
  it('ignores asks for unknown targets and terminal nodes', () => {
    const s = fold([...base, { type: 'ask.pending', askId: 'x', runId: 'nope' }])
    expect(Object.values(s.nodes).some(n => n.status === 'awaiting_ask')).toBe(false)
  })
  it('builds a forest and orphan subagents become roots', () => {
    const s = fold([...base, { type: 'subagent.start', runId: 'd3', childSessionId: 'c3', parentSessionId: 'unknown', provider: 'p', at }])
    const roots = buildRunTree(Object.values(s.nodes))
    expect(roots.map(r => r.node.id).sort()).toEqual([subagentNodeId('c3'), taskNodeId('t1')].sort())
    const task = roots.find(r => r.node.id === taskNodeId('t1'))!
    expect(task.children[0]!.children[0]!.children[0]!.node.id).toBe(subagentNodeId('c2'))
  })
  it('does not mutate previous state', () => {
    const s0 = fold(base)
    const before = JSON.stringify(s0)
    applyRunTreeEvent(s0, { type: 'ask.pending', askId: 'q', sessionRef: 'c1' })
    expect(JSON.stringify(s0)).toBe(before)
  })
})

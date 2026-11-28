import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { askEvents, handleRunTreeRoute, linkEvents, registerRunTreeCollector, RunTreeStore } from '../src/run-tree-api.ts'

function fakeRes() {
  const out = { status: 0, body: '' }
  const res = { writeHead: (s: number) => { out.status = s; return res }, end: (b?: string) => { out.body = b ?? '' }, write: () => true } as unknown as ServerResponse
  return { res, out }
}
const deps = (body: unknown) => ({ readBody: async () => Buffer.from(JSON.stringify(body)) })

describe('run-tree api', () => {
  it('ignores unrelated paths and 503 without store', async () => {
    const { res, out } = fakeRes()
    expect(await handleRunTreeRoute({ method: 'GET', url: '/' } as IncomingMessage, res, '/lumo/api/asks', new RunTreeStore(), deps({}))).toBe(false)
    expect(await handleRunTreeRoute({ method: 'GET', url: '/' } as IncomingMessage, res, '/lumo/api/run-tree', undefined, deps({}))).toBe(true)
    expect(out.status).toBe(503)
  })
  it('collects dsh subagent lifecycle and links to run via session_ref', async () => {
    const store = new RunTreeStore()
    const handlers: Record<string, (info: unknown) => void> = {}
    registerRunTreeCollector({ on: (name: string, fn: (info: unknown) => void) => { handlers[name] = fn; return () => {} } } as never, store)
    await handleRunTreeRoute({ method: 'POST', url: '' } as IncomingMessage, fakeRes().res, '/lumo/api/run-tree/links', store,
      deps({ nodes: [{ id: 'task:t1', kind: 'task', title: 'T' }, { id: 'run:r1', kind: 'run', parentId: 'task:t1', sessionId: 's1', status: 'running' }] }))
    handlers['subagent/start']!({ runId: 'x', provider: 'acp', parentSessionId: 's1', id: 'c1' })
    handlers['subagent/end']!({ runId: 'x', provider: 'acp', parentSessionId: 's1', id: 'c1', stopReason: 'completed', lastAssistantMessage: [{ type: 'text', text: 'done' }] })
    const { res, out } = fakeRes()
    await handleRunTreeRoute({ method: 'GET', url: '/lumo/api/run-tree?rootTaskId=task:t1' } as IncomingMessage, res, '/lumo/api/run-tree', store, deps({}))
    const snap = JSON.parse(out.body) as { nodes: Array<{ id: string; parentId?: string; status: string; detail?: string }> }
    const child = snap.nodes.find(n => n.id === 'subagent:c1')!
    expect(child.parentId).toBe('run:r1')
    expect(child.status).toBe('succeeded')
    expect(child.detail).toBe('done')
  })
  it('validates link and ask bodies', () => {
    expect(typeof linkEvents({ nodes: [{ id: 'a b', kind: 'task' }] })).toBe('string')
    expect(typeof linkEvents({ nodes: [{ id: 'x', kind: 'subagent' }] })).toBe('string')
    expect(typeof askEvents({ askId: 'connector:1', state: 'maybe' })).toBe('string')
    expect(askEvents({ askId: 'connector:1', state: 'pending', sessionRef: 's1' })).toEqual([{ type: 'ask.pending', askId: 'connector:1', sessionRef: 's1' }])
  })
  it('notifies subscribers with monotonic seq', () => {
    const store = new RunTreeStore()
    const seen: number[] = []
    const off = store.subscribe(d => seen.push(d.seq))
    store.apply({ type: 'node.upsert', node: { id: 'task:a', kind: 'task' } })
    store.apply({ type: 'node.upsert', node: { id: 'task:b', kind: 'task' } })
    off()
    store.apply({ type: 'node.upsert', node: { id: 'task:c', kind: 'task' } })
    expect(seen).toEqual([1, 2])
  })
  it('keeps SSE alive after request completion and cleans up on response close', async () => {
    vi.useFakeTimers()
    try {
      const store = new RunTreeStore()
      const req = Object.assign(new EventEmitter(), { method: 'GET', url: '/lumo/api/run-tree/events' })
      const res = Object.assign(new EventEmitter(), { writeHead: vi.fn(), write: vi.fn(() => true) })
      await handleRunTreeRoute(req as IncomingMessage, res as unknown as ServerResponse, req.url, store, deps({}))
      req.emit('close')
      store.apply({ type: 'node.upsert', node: { id: 'task:a', kind: 'task' } })
      expect(res.write).toHaveBeenCalledTimes(2)
      res.emit('close')
      store.apply({ type: 'node.upsert', node: { id: 'task:b', kind: 'task' } })
      expect(res.write).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

})

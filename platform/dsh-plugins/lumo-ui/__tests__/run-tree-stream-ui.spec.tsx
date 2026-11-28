// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunTreePanel } from '../src/client/run-tree-panel.tsx'

class Source {
  static instances: Source[] = []
  onerror?: () => void
  closed = false
  handlers = new Map<string, (event: { data: string }) => void>()
  constructor(readonly url: string) { Source.instances.push(this) }
  addEventListener(type: string, listener: (event: { data: string }) => void) { this.handlers.set(type, listener) }
  close() { this.closed = true }
  emit(type: string, data: unknown) { this.handlers.get(type)?.({ data: JSON.stringify(data) }) }
}
afterEach(() => { vi.unstubAllGlobals(); Source.instances = [] })
describe('RunTreePanel stream wiring', () => {
  it('keeps EventSource reconnect enabled and fetches a snapshot on each hello', async () => {
    vi.stubGlobal('EventSource', Source)
    const request = vi.fn(async (path: string) => new Response(JSON.stringify(path === '/lumo/api/run-tree' ? { seq: 0, nodes: [] } : { asks: [] })))
    vi.stubGlobal('fetch', request)
    const container = document.createElement('div'); document.body.append(container)
    const root = createRoot(container)
    try {
      await act(async () => root.render(<RunTreePanel tasks={[]} />))
      const source = Source.instances[0]!
      const before = request.mock.calls.filter(([path]) => path === '/lumo/api/run-tree').length
      await act(async () => source.onerror?.())
      expect(source.closed).toBe(false)
      expect(container.textContent).toContain('正在自动重连')
      await act(async () => source.emit('hello', { seq: 0 }))
      expect(request.mock.calls.filter(([path]) => path === '/lumo/api/run-tree').length).toBe(before + 1)
      await act(async () => source.emit('hello', { seq: 0 }))
      expect(request.mock.calls.filter(([path]) => path === '/lumo/api/run-tree').length).toBe(before + 2)
      await act(async () => root.unmount())
      expect(source.closed).toBe(true)
    } finally { container.remove() }
  })
})

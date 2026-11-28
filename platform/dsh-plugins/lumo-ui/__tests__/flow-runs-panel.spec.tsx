// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { FlowRunsPanel } from '../src/client/flow-runs-panel.tsx'

let root: Root | undefined
let container: HTMLDivElement
const flows = [{ id: 'a', name: '流程A' }, { id: 'b', name: '流程B' }]
const runs = [{ id: 42, automation_id: 'manual', status: 'failed', flow_version: 2, started_at: '' }]
async function mount(request: typeof import('../src/client/api.ts').api) {
  container = document.createElement('div'); document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<FlowRunsPanel flows={flows} request={request} />))
}
async function choose(value: string) {
  await act(async () => {
    const select = container.querySelector('select')!; select.value = value
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}
const read = () => [...container.querySelectorAll('button')].find(button => button.textContent === '查看结果 #42')!
afterEach(async () => { await act(async () => root?.unmount()); root = undefined; container?.remove() })

describe('manual Flow receipt UI', () => {
  it('queries durable node receipts and never offers automatic replay', async () => {
    const request = vi.fn().mockResolvedValueOnce({ runs }).mockResolvedValueOnce({ id: 42, status: 'failed', flowVersion: 2, nodes: [{ nodeId: 'send', status: 'unknown' }] })
    await mount(request); await choose('a'); await act(async () => read().click())
    expect(container.querySelector('[aria-label="流程执行结果"]')).not.toBeNull()
    expect(request).toHaveBeenLastCalledWith('/lumo/api/flows/a/runs/42/result')
    expect([...container.querySelectorAll('button')].some(button => button.textContent?.includes('重放'))).toBe(false)
    expect(container.textContent).toContain('不会自动重放')
  })
  it('ignores a late result when selection changes', async () => {
    let resolve!: (value: unknown) => void
    const request = vi.fn().mockResolvedValueOnce({ runs }).mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValueOnce({ runs: [] })
    await mount(request); await choose('a'); await act(async () => read().click()); await choose('b')
    expect(container.textContent).toContain('暂无运行记录。')
    await act(async () => resolve({ id: 42, status: 'failed', nodes: [] }))
    expect(container.querySelector('[aria-label="流程执行结果"]')).toBeNull()
  })
})

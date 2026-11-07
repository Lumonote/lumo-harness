// @vitest-environment jsdom
import { webcrypto } from 'node:crypto'
import { cleanup, fireEvent, render, screen, waitFor } from '../../../../deepseek-harness/node_modules/@testing-library/react/dist/index.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RunReviewPanel, runReviewRequestKey } from '../src/client/run-review-panel.tsx'

beforeEach(() => { vi.stubGlobal('crypto', webcrypto); localStorage.clear() })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const actor = { realm: 'r1', userId: 'requester' }
const run = { id: 'producer:attempt:1', worker_id: 'agent:producer', state: 'COMPLETED' }
const worker = (id: string, extra = {}) => ({ worker_id: `agent:${id}`, worker_kind: 'agent' as const, display_name: id, status: 'active', eligible: true, ...extra })
const workers = [worker('producer'), worker('reviewer'), worker('busy', { eligible: false }), worker('disabled', { status: 'disabled' }), worker('human', { worker_id: 'user:human', worker_kind: 'human' as const })]
const receipt = { task: { id: 'review-task', title: 'Review output', project_id: 'p1', assignee_worker_id: 'agent:reviewer' }, run: { id: 'review-run', task_id: 'review-task', worker_id: 'agent:reviewer', state: 'QUEUED' } }
function mount(request = vi.fn().mockResolvedValue(receipt), extra = {}) {
  const onOpen = vi.fn()
  return { request, onOpen, ...render(<RunReviewPanel request={request} actor={actor} taskID="producer" projectID="p1" run={run} workers={workers} onOpen={onOpen} {...extra} />) }
}
function chooseAndCreate() {
  fireEvent.change(screen.getByRole('combobox', { name: '审核 Agent' }), { target: { value: 'agent:reviewer' } })
  fireEvent.click(screen.getByRole('button', { name: '创建审核任务' }))
}

describe('independent review task entry', () => {
  it('offers other active Agents and shows unavailable capacity without offering humans or the producer', () => {
    mount()
    expect(screen.getAllByRole('option').map(option => option.textContent)).toEqual(['选择审核 Agent', 'reviewer · agent:reviewer', 'busy · agent:busy · 当前不可分派'])
    expect((screen.getByRole('option', { name: /busy/u }) as HTMLOptionElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: '创建审核任务' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('creates one independent task, displays its Run and opens the returned task', async () => {
    const f = mount()
    chooseAndCreate()
    await screen.findByText('审核任务已创建，等待审核 Agent 执行并提交结论。')
    expect(f.request).toHaveBeenCalledExactlyOnceWith('/lumo/api/tasks/producer/runs/producer%3Aattempt%3A1/review-tasks', expect.objectContaining({ method: 'POST', body: '{"reviewer_worker_id":"agent:reviewer"}', headers: { 'Idempotency-Key': expect.stringMatching(/^ui-review:[a-f0-9]{64}$/u) } }))
    expect(screen.getByRole('status').textContent).toContain('review-run · QUEUED')
    fireEvent.click(screen.getByRole('button', { name: /打开审核任务/u }))
    expect(f.onOpen).toHaveBeenCalledExactlyOnceWith(receipt.task)
  })

  it('retains the exact conflict message and reuses its key after a lost response and remount', async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error('independent review required: model must differ')).mockResolvedValueOnce(receipt)
    const first = mount(request)
    chooseAndCreate()
    expect((await screen.findByRole('alert')).textContent).toBe('independent review required: model must differ')
    const firstKey = request.mock.calls[0]![1].headers['Idempotency-Key']
    first.unmount()
    mount(request)
    chooseAndCreate()
    await screen.findByText('审核任务已创建，等待审核 Agent 执行并提交结论。')
    expect(request.mock.calls[1]![1].headers['Idempotency-Key']).toBe(firstKey)
  })

  it('deduplicates double submission while deriving the persistent request key', async () => {
    const f = mount()
    fireEvent.change(screen.getByRole('combobox', { name: '审核 Agent' }), { target: { value: 'agent:reviewer' } })
    const button = screen.getByRole('button', { name: '创建审核任务' })
    fireEvent.click(button); fireEvent.click(button)
    await screen.findByRole('status')
    expect(f.request).toHaveBeenCalledOnce()
  })

  it('starts a new review only after explicit confirmation and preserves its new key after remount', async () => {
    const request = vi.fn().mockResolvedValue(receipt)
    const first = mount(request)
    chooseAndCreate()
    await screen.findByRole('status')
    const original = request.mock.calls[0]![1].headers['Idempotency-Key']
    fireEvent.click(screen.getByRole('button', { name: '新建另一轮审核' }))
    expect(request).toHaveBeenCalledOnce()
    expect(screen.getByText('这会创建另一项独立审核任务，已安排的审核任务会继续保留。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认新建一轮' }))
    fireEvent.click(screen.getByRole('button', { name: '创建审核任务' }))
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2))
    const next = request.mock.calls[1]![1].headers['Idempotency-Key']
    expect(next).not.toBe(original)
    first.unmount()
    mount(request)
    chooseAndCreate()
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3))
    expect(request.mock.calls[2]![1].headers['Idempotency-Key']).toBe(next)
  })

  it.each([{ actor: null }, { run: { ...run, state: 'RUNNING' } }, { workers: [] }, { workersError: 'Agent directory unavailable' }])('disables creation when current prerequisites are missing: %j', extra => {
    const f = mount(undefined, extra)
    fireEvent.change(screen.getByRole('combobox', { name: '审核 Agent' }), { target: { value: 'agent:reviewer' } })
    const button = screen.getByRole('button', { name: '创建审核任务' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(f.request).not.toHaveBeenCalled()
  })

  it('refuses a response bound to another project, task or reviewer', async () => {
    const f = mount(vi.fn().mockResolvedValue({ ...receipt, run: { ...receipt.run, worker_id: 'agent:other' } }))
    chooseAndCreate()
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('响应与本次请求不一致'))
    expect(f.onOpen).not.toHaveBeenCalled()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('keeps stable keys across calls and separates accounts, runs and reviewer choices', async () => {
    const first = await runReviewRequestKey(actor, 'producer', run.id, 'agent:reviewer')
    expect(await runReviewRequestKey(actor, 'producer', run.id, 'agent:reviewer')).toBe(first)
    for (const [who, runID, reviewer] of [
      [{ ...actor, userId: 'other' }, run.id, 'agent:reviewer'], [{ ...actor, realm: 'r2' }, run.id, 'agent:reviewer'],
      [actor, 'another-run', 'agent:reviewer'], [actor, run.id, 'agent:another'],
    ] as const) expect(await runReviewRequestKey(who, 'producer', runID, reviewer)).not.toBe(first)
  })
})

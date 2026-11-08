import { expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { GovernedProgressReporter, TASK_PROGRESS_TOOL, type ProgressCheckpoint } from '../src/task-progress.ts'
import { config, execution } from './governed-fixtures.ts'

const checkpoint: ProgressCheckpoint = { status: 'blocked', percent: 40, summary: 'Prepared the implementation', next_step: 'Obtain staging access', blocked_reason: 'Missing staging grant' }
function authority(progress: unknown = null) {
  return vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === 'GET') return Response.json({ current_run_id: 'run-1', revision: 3, can_update: true, progress })
    return Response.json({ run_id: 'run-1', task_id: 'task-run-1', revision: 4, source: 'runtime' })
  })
}

it('reports with its fixed execution identity and the authority revision', async () => {
  const fetcher = authority()
  const reporter = new GovernedProgressReporter(config, execution(), fetcher)
  await expect(reporter.report(checkpoint, new AbortController().signal)).resolves.toEqual({ revision: 4, recorded: true })
  expect(String(fetcher.mock.calls[0][0])).toContain('node_id=')
  expect(fetcher.mock.calls[1][0]).toBe(`${config.governanceUrl}/v1/runtime/task-runs/run-1/progress`)
  const init = fetcher.mock.calls[1][1]!
  expect(init.redirect).toBe('error')
  expect(JSON.parse(String(init.body))).toEqual({ ...checkpoint, run_id: 'run-1', expected_revision: 3, node_id: config.nodeId, session_ref: 'session-run-1' })
})

it('does not automatically replace a human checkpoint', async () => {
  const fetcher = authority({ ...checkpoint, source: 'user', updated_by: 'manager' })
  await expect(new GovernedProgressReporter(config, execution(), fetcher).report(checkpoint, new AbortController().signal, true)).resolves.toEqual({ revision: 3, recorded: false })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it.each(['on_track', 'at_risk', 'blocked'] as const)('preserves a persisted runtime checkpoint from outside this reporter: %s', async status => {
  const fetcher = authority({ ...checkpoint, status, source: 'runtime', updated_by: 'agent:writer' })
  await expect(new GovernedProgressReporter(config, execution(), fetcher).report({ status: 'on_track', percent: 100,
    summary: 'Runtime returned text', next_step: 'Submit for review',
  }, new AbortController().signal, true)).resolves.toEqual({ revision: 3, recorded: false })
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('surfaces a CAS conflict without retrying over the concurrent update', async () => {
  const fetcher = authority()
  fetcher.mockImplementation(async (_url, init) => init?.method === 'GET'
    ? Response.json({ current_run_id: 'run-1', revision: 3, can_update: true, progress: null })
    : new Response('', { status: 409 }))
  await expect(new GovernedProgressReporter(config, execution(), fetcher).report(checkpoint, new AbortController().signal)).rejects.toThrow('changed')
  expect(fetcher).toHaveBeenCalledTimes(2)
})

it.each([
  { current_run_id: 'other', revision: 1, can_update: true },
  { current_run_id: 'run-1', revision: -1, can_update: true },
  { current_run_id: 'run-1', revision: 1, can_update: false },
])('rejects a stale or invalid Run view %j', async view => {
  const fetcher = vi.fn(async () => Response.json(view))
  await expect(new GovernedProgressReporter(config, execution(), fetcher).report(checkpoint, new AbortController().signal)).rejects.toThrow('identity')
  expect(fetcher).toHaveBeenCalledTimes(1)
})

it('requires the exact execution Session and excludes model-supplied identity', async () => {
  let tool: { name: string; execute: (args: unknown, exec: unknown) => Promise<unknown> } | undefined
  const ctx = { tools: { register: (value: typeof tool) => { tool = value } } } as unknown as Context
  const fetcher = authority()
  const signal = new AbortController().signal
  new GovernedProgressReporter(config, execution(), fetcher).install(ctx, signal)
  expect(tool?.name).toBe(TASK_PROGRESS_TOOL)
  expect(() => tool!.execute(checkpoint, { signal, agent: { session: { id: 'other' } } })).toThrow('exact execution Session')
  expect(() => tool!.execute({ ...checkpoint, run_id: 'other' }, { signal, agent: { session: { id: 'session-run-1' } } })).toThrow('Progress requires')
  expect(fetcher).not.toHaveBeenCalled()
  await expect(tool!.execute(checkpoint, { signal, agent: { session: { id: 'session-run-1' } } })).resolves.toEqual({ revision: 4, recorded: true })
})

it('does not send a checkpoint after cancellation', async () => {
  const abort = new AbortController(); abort.abort()
  const fetcher = authority()
  await expect(new GovernedProgressReporter(config, execution(), fetcher).report(checkpoint, abort.signal)).rejects.toThrow()
  expect(fetcher).not.toHaveBeenCalled()
})

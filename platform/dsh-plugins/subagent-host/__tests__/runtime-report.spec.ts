import { afterEach, expect, it, vi } from 'vitest'
import { startRuntimeReports } from '../src/runtime-report.ts'
import { config, preset } from './governed-fixtures.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('reports the installed revision and withdraws the same runtime instance on shutdown', async () => {
  vi.useFakeTimers()
  const reports: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    expect(init.headers).toMatchObject({ authorization: 'Bearer service', 'x-lumo-realm': 'realm' })
    expect(init.redirect).toBe('error')
    if (init.method === 'PUT') {
      expect(url).toContain('/v1/workers/agent%3Awriter/runtime')
      reports.push(JSON.parse(init.body as string))
      return new Response('{}')
    }
    return new Response(JSON.stringify(preset))
  }))
  const onError = vi.fn()
  const reporter = startRuntimeReports(config, onError)
  try { await vi.advanceTimersByTimeAsync(10_001) } finally { await reporter.close() }
  expect(reports.map(report => report.status)).toEqual(['active', 'active', 'disabled'])
  expect(new Set(reports.map(report => report.instance_id))).toEqual(new Set([reporter.instanceId]))
  expect(reports[0]).toMatchObject({ node_id: 'node-1', preset_revision: 7, max_concurrency: 2 })
  expect(onError).not.toHaveBeenCalled()
})

it('never reports active when the configured preset cannot be loaded', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => new Response('{}', { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  const reporter = startRuntimeReports(config, () => {})
  try { await vi.advanceTimersByTimeAsync(1) } finally { await reporter.close() }
  expect(fetch).toHaveBeenCalledTimes(1)
})

it.each([
  { revision: 8 }, { owner_user_id: 'other' }, { model_ref: 'other' },
  { connector_ids: ['connector'] }, { max_budget_cents: 1 }, { max_concurrency: 1 },
])('withdraws the installed identity when the authority changes: %j', async patch => {
  vi.useFakeTimers()
  let current = structuredClone(preset)
  const reports: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'PUT') { reports.push(JSON.parse(init.body as string)); return new Response('{}') }
    return new Response(JSON.stringify(current))
  }))
  const onError = vi.fn()
  const reporter = startRuntimeReports(config, onError)
  try {
    await vi.advanceTimersByTimeAsync(1)
    current = { ...current, ...patch }
    await vi.advanceTimersByTimeAsync(10_000)
  } finally { await reporter.close() }
  expect(reports.map(report => report.status)).toEqual(['active', 'disabled', 'disabled'])
  expect(reports.every(report => report.preset_revision === config.binding.presetRevision)).toBe(true)
  expect(onError).toHaveBeenCalledTimes(1)
})

it('does not publish an active heartbeat when shutdown races preset loading', async () => {
  vi.useFakeTimers()
  let resolve!: (response: Response) => void
  const fetch = vi.fn(() => new Promise<Response>(done => { resolve = done }))
  vi.stubGlobal('fetch', fetch)
  const reporter = startRuntimeReports(config, () => {})
  const closed = reporter.close()
  resolve(new Response(JSON.stringify(preset)))
  await closed
  expect(fetch).toHaveBeenCalledTimes(1)
})

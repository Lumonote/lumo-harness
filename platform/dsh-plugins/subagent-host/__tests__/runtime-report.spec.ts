import { afterEach, expect, it, vi } from 'vitest'
import { startRuntimeReports } from '../src/runtime-report.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it('reports configured presets periodically and withdraws the same runtime instance on shutdown', async () => {
  vi.useFakeTimers()
  const reports: Record<string, unknown>[] = []
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'PUT') {
      reports.push(JSON.parse(init.body as string))
      return new Response('{}')
    }
    return new Response(JSON.stringify({ revision: 7, status: 'active' }))
  }))
  const onError = vi.fn()
  const reporter = startRuntimeReports({ governanceUrl: 'http://governance:8089', token: 'service', realm: 'r1', nodeId: 'node-1', agentIds: ['one'], capacity: 2 }, onError)
  await vi.advanceTimersByTimeAsync(10_001)
  await reporter.close()
  expect(reports.length).toBe(3)
  expect(reports.map(report => report.status)).toEqual(['active', 'active', 'disabled'])
  expect(new Set(reports.map(report => report.instance_id)).size).toBe(1)
  expect(reports[0]).toMatchObject({ node_id: 'node-1', preset_revision: 7, max_concurrency: 2 })
  expect(onError).not.toHaveBeenCalled()
})

it('never reports a preset active when its configuration cannot be loaded', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn(async () => new Response('{}', { status: 404 }))
  vi.stubGlobal('fetch', fetch)
  const reporter = startRuntimeReports({ governanceUrl: 'http://governance:8089', token: 'service', realm: 'r1', nodeId: 'node-1', agentIds: ['unknown'], capacity: 2 }, () => {})
  await vi.advanceTimersByTimeAsync(1)
  await reporter.close()
  expect(fetch).toHaveBeenCalledTimes(1)
})

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

// `{ max_budget_cents: 1 }` **已从本表移除**（2026-09-19）：它此前能过，是因为
// `assertExecutionPreset` 把「非零预算」一律判为不支持，而**不是**因为「预算被改过」。
// 金额上限现在有了执法面，那条一律拒绝消失了，于是这一格暴露出它本来就没测到东西。
//
// 顺带记下一个**真实的缺口**：撤回的判据是「预设 ≠ 绑定」，而 `WorkerBinding` 里没有预算
// 字段——所以「预算被中途改了」在这条路径上**检测不到**。当前实现只在开跑前设一次上限
// （`governed-run`），所以中途改预算**不会生效**，而运行会照常继续。这是已知的，不是本
// 用例的断言对象；要补的话得让上限可**就地更新**（只改 cap、不清已花），而不是重新 set
// ——`setCap` 会把已花清零，中途重设等于让上限永远不触发。
it.each([
  { revision: 8 }, { owner_user_id: 'other' }, { model_ref: 'other' },
  { connector_ids: ['connector'] }, { max_concurrency: 1 },
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

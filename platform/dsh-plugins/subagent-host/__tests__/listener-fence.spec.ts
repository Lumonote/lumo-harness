import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentHostOptions } from '../src/server.ts'
import type { StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'

const h = vi.hoisted(() => ({
  options: undefined as SubagentHostOptions | undefined,
  autoListen: true, listenReady: undefined as (() => void) | undefined,
  server: undefined as import('node:events').EventEmitter | undefined,
  dispose: undefined as (() => Promise<void>) | undefined,
  tool: undefined as ((exec: unknown, next: () => unknown) => Promise<unknown>) | undefined,
  renew: vi.fn<() => Promise<void>>(), release: vi.fn<() => Promise<void>>(),
  poolEnd: vi.fn<() => Promise<void>>(), cancel: vi.fn(),
  pause: vi.fn(), closeGoverned: vi.fn<() => Promise<void>>(), closeReports: vi.fn<() => Promise<void>>(),
  closeDelivery: vi.fn<() => Promise<void>>(), execute: vi.fn<() => Promise<void>>(),
}))
vi.mock('pg', () => ({ default: { Pool: class {
  on() {}
  query = vi.fn(async () => ({}))
  end = h.poolEnd
} } }))
vi.mock('../../../shared/subagent-receipts.ts', () => ({ PgSubagentReceipts: class { async init() {} } }))
vi.mock('../src/durable-start-guard.ts', () => ({
  HostBootLeaseError: class extends Error {},
  PgHostBootLease: class {
    ttlMs = 30_000
    async acquire() {}
    isOwned() { return true }
    async assertOwned() {}
    renew = h.renew
    release = h.release
  },
  PgDurableStartGuard: class {
    async init() {}
    async recoverAbandoned() {}
    async admit() {}
    async assertMayRun() {}
    callbackStore() { return {} }
  },
}))
vi.mock('../src/governed-dispatch.ts', () => ({ PgGovernedDispatch: class { async init() {} } }))
vi.mock('../src/runtime-report.ts', () => ({ startRuntimeReports: () => ({ instanceId: 'instance', close: h.closeReports }) }))
vi.mock('../src/governed-run.ts', () => ({ startGovernedDispatch: () => ({
  pause: h.pause, close: h.closeGoverned, activeCount: () => 0, stop() {},
}) }))
vi.mock('../src/callback-outbox.ts', () => ({
  persistCallback: vi.fn(), startCallbackDelivery: () => ({ close: h.closeDelivery, wake() {} }),
}))
vi.mock('../src/run.ts', () => ({ runChild: (_ctx: unknown, _request: unknown, runs: Map<string, unknown>) => {
  runs.set('live-child', { cancel: h.cancel })
  return h.execute()
} }))
vi.mock('../src/server.ts', async () => {
  const { EventEmitter } = await import('node:events')
  return { createSubagentHost: (options: SubagentHostOptions) => {
    h.options = options
    const server = new EventEmitter()
    h.server = server
    return Object.assign(server, { listen(_port: number, _host: string, ready: () => void) { h.listenReady = ready; if (h.autoListen) ready() },
      close: vi.fn(), closeAllConnections: vi.fn() })
  } }
})
import { registerSubagentHost } from '../src/index.ts'

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
  h.autoListen = true
  h.listenReady = undefined
  h.release.mockResolvedValue(undefined)
  h.poolEnd.mockResolvedValue(undefined)
  h.closeDelivery.mockResolvedValue(undefined)
})
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it.each(['listener', 'renewal'] as const)('fences all execution on %s failure and releases only after pending work closes', async source => {
  const renewal = deferred()
  const execution = deferred()
  const governed = deferred()
  const reports = deferred()
  h.renew.mockReturnValue(renewal.promise)
  h.execute.mockReturnValue(execution.promise)
  h.closeGoverned.mockReturnValue(governed.promise)
  h.closeReports.mockReturnValue(reports.promise)
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, agents: { get: () => undefined },
    on(_name: string, hook: typeof h.tool) { h.tool = hook },
    effect(install: () => (() => Promise<void>)) { h.dispose = install() },
  } as unknown as Context
  await registerSubagentHost(ctx, { connectionString: 'postgres://unused', nodeId: 'node', tokens: { realm: 'secret' },
    callbackOrigins: ['http://parent.invalid'], runtimeReport: {
      realm: 'realm', nodeId: 'node', governanceUrl: 'http://governance.invalid', token: 'service', capacity: 1,
      binding: { agentId: 'writer', userId: 'owner', projectId: 'project', presetRevision: 1, provider: 'mock', model: 'mock' },
    } })
  const host = h.options!
  expect(host.lifecycle!.admitting()).toBe(true)
  host.start({ realm: 'realm', childId: 'child' } as StartChildRequest)
  await vi.advanceTimersByTimeAsync(10_000)
  expect(h.renew).toHaveBeenCalledOnce()
  if (source === 'listener') h.server!.emit('error', new Error('accept EMFILE'))
  else renewal.reject(new Error('database connection lost'))
  await vi.advanceTimersByTimeAsync(0)
  expect(host.lifecycle!.admitting()).toBe(false)
  expect(h.pause).toHaveBeenCalledOnce()
  expect(h.cancel).toHaveBeenCalledOnce()
  expect(h.closeGoverned).toHaveBeenCalledOnce()
  expect(h.closeReports).toHaveBeenCalledOnce()
  expect(() => host.start({} as StartChildRequest)).toThrow()
  const next = vi.fn()
  await expect(h.tool!({}, next)).rejects.toThrow()
  expect(next).not.toHaveBeenCalled()
  const disposing = h.dispose!()
  h.server!.emit('error', new Error('second listener error during shutdown'))
  expect(h.release).not.toHaveBeenCalled()
  execution.resolve()
  governed.resolve()
  await vi.advanceTimersByTimeAsync(0)
  expect(h.release).not.toHaveBeenCalled()
  reports.resolve()
  if (source === 'listener') {
    await vi.advanceTimersByTimeAsync(0)
    expect(h.release).not.toHaveBeenCalled()
  }
  renewal.resolve()
  await disposing
  expect(h.closeGoverned).toHaveBeenCalledOnce()
  expect(h.closeReports).toHaveBeenCalledOnce()
  expect(h.closeDelivery).toHaveBeenCalledOnce()
  expect(h.release).toHaveBeenCalledOnce()
  expect(h.poolEnd).toHaveBeenCalledOnce()
})


it.each([true, false])('keeps anonymous hosts fenced after listener error (listener was ready: %s)', async listening => {
  h.autoListen = listening
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, agents: { get: () => undefined },
    on(_name: string, hook: typeof h.tool) { h.tool = hook },
    effect(install: () => (() => Promise<void>)) { h.dispose = install() },
  } as unknown as Context
  await registerSubagentHost(ctx, { allowAnonymous: true, host: '127.0.0.1', port: 0 })
  const lifecycle = h.options!.lifecycle!
  expect(lifecycle.admitting()).toBe(listening)
  h.server!.emit('error', new Error('listener failed without a PostgreSQL boot lease'))
  expect(lifecycle.status().replication.ready).toBe(false)
  expect(lifecycle.admitting()).toBe(false)
  const initialized = vi.spyOn(lifecycle, 'start')
  h.listenReady!()
  expect(initialized).not.toHaveBeenCalled()
  expect(() => h.options!.start({} as StartChildRequest)).toThrow()
  const next = vi.fn()
  await expect(h.tool!({}, next)).rejects.toThrow()
  expect(next).not.toHaveBeenCalled()
  await h.dispose!()
  expect(h.release).not.toHaveBeenCalled()
  expect(h.renew).not.toHaveBeenCalled()
})

it('owns discovery in the host and drains only after an earlier enabled registration is disabled', async () => {
  const post = deferred()
  const methods: string[] = []
  let enabled = false
  vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input)
    methods.push(init!.method!)
    if (init!.method === 'POST') await post.promise
    enabled = url.searchParams.get('enabled') === 'true'
    return new Response('ok')
  })
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, agents: { get: () => undefined },
    on(_name: string, hook: typeof h.tool) { h.tool = hook },
    effect(install: () => (() => Promise<void>)) { h.dispose = install() },
  } as unknown as Context
  await registerSubagentHost(ctx, { connectionString: 'postgres://unused', nodeId: 'node',
    tokens: { realm: 'secret' }, discovery: { baseUrl: 'http://nacos', serviceName: 'nodes',
      groupName: 'g', nodeId: 'node', realm: 'realm', clusterId: 'cluster', host: 'node',
      port: 8091, capacity: 1, capabilities: ['subagent'], residency: '' } })
  await vi.advanceTimersByTimeAsync(0)
  expect(methods).toEqual(['POST'])
  const lifecycle = h.options!.lifecycle!
  let drained = false
  const drain = lifecycle.drain(1_000).then(result => { drained = result })
  expect(lifecycle.admitting()).toBe(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(drained).toBe(false)
  expect(methods).toEqual(['POST'])
  post.resolve()
  await drain
  expect(drained).toBe(true)
  expect(enabled).toBe(false)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(methods).toEqual(['POST', 'PUT'])
  await h.dispose!()
  expect(methods).toEqual(['POST', 'PUT', 'DELETE'])
  expect(h.release).toHaveBeenCalledOnce()
})

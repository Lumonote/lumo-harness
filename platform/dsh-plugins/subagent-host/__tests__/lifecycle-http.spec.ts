import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createSubagentHost, type SubagentHostOptions } from '../src/server.ts'
import { HostLifecycle } from '../src/lifecycle.ts'
import { runKeyOf, type StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

const request: StartChildRequest = {
  childId: 'child-1', realm: 'dev', prompt: [{ type: 'text', text: 'work' }],
  descriptor: { version: 2, mode: 'one-shot', provider: 'spawn', label: 'work' },
  parent: { sessionId: 'parent-1', delegationDepth: 0 },
  callbackUrl: 'http://parent/subagent/result/child-1/0123456789abcdef',
  schedulerAttempt: 2, schedulerNodeId: 'N1',
}

async function setup(overrides: Partial<SubagentHostOptions> = {}) {
  let active = 0
  const flush = vi.fn(async () => {})
  const lifecycle = new HostLifecycle({
    active: () => active, health: () => ({ ready: true, pending: 0 }),
    check: async () => {}, withdraw: async () => {}, pause: () => {}, flush,
  })
  const start = vi.fn(() => { active++ })
  const server = createSubagentHost({
    host: '127.0.0.1', port: 0, maxBodyBytes: 4096,
    tokens: new Map([['dev', 'secret']]), callbackOrigins: new Set(['http://parent']),
    runs: new Map(), sessionExists: () => false, start, lifecycle,
    logger: { info() {}, warn() {}, error() {} }, ...overrides,
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const post = (path: string, body: unknown, authorized = true) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(authorized ? { 'x-lumo-realm': 'dev', 'x-lumo-seam-token': 'secret' } : {}) },
    body: JSON.stringify(body),
  })
  return { base, post, start, flush, lifecycle, finish: () => { active-- } }
}

describe('node readiness and drain HTTP contract', () => {
  it('returns unavailable with a diagnostic when a health provider throws', async () => {
    const lifecycle = new HostLifecycle({
      active: () => 0,
      health: () => { throw new Error('replication provider is unavailable') },
      check: async () => {}, withdraw: async () => {}, pause: () => {}, flush: async () => {},
    })
    lifecycle.start()
    const h = await setup({ lifecycle })
    const response = await fetch(`${h.base}/readyz`)
    expect(response.status).toBe(503)
    expect(await response.json()).toEqual({ ready: false, code: 'dependency_unavailable',
      message: 'replication provider is unavailable' })
    expect((await fetch(`${h.base}/healthz`)).status).toBe(200)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('authenticates drain and reports readiness separately from liveness', async () => {
    const h = await setup()
    expect((await fetch(`${h.base}/healthz`)).status).toBe(200)
    expect((await fetch(`${h.base}/readyz`)).status).toBe(503)
    h.lifecycle.start()
    expect((await fetch(`${h.base}/readyz`)).status).toBe(200)
    expect((await h.post('/drain', {}, false)).status).toBe(403)
    expect((await h.post('/drain', { timeout_ms: -1 })).status).toBe(400)
    expect((await h.post('/drain', { timeout_ms: 500 })).status).toBe(200)
    expect((await fetch(`${h.base}/readyz`)).status).toBe(503)
    expect((await h.post('/subagent/start', request)).status).toBe(503)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('counts durable admission across an overlapping drain, then waits for its execution', async () => {
    let admitted!: () => void
    let entered!: () => void
    const enteredPromise = new Promise<void>(resolve => { entered = resolve })
    const h = await setup({ admit: async () => { entered(); await new Promise<void>(resolve => { admitted = resolve }) } })
    h.lifecycle.start()
    const starting = h.post('/subagent/start', request)
    await enteredPromise
    expect((await h.post('/subagent/start', request)).status).toBe(400)
    let finished = false
    const draining = h.lifecycle.drain(2_000).then(result => { finished = true; return result })
    expect(h.lifecycle.status().active).toBe(1)
    admitted()
    expect((await starting).status).toBe(200)
    expect(h.start).toHaveBeenCalledOnce()
    expect(h.lifecycle.status().active).toBe(1)
    expect(finished).toBe(false)
    h.finish()
    expect(await draining).toBe(true)
    expect(h.flush).toHaveBeenCalledOnce()
  })

  it('does not cancel the live newer execution when a durable stop rejects a stale attempt', async () => {
    const cancel = vi.fn()
    const stopGoverned = vi.fn()
    const h = await setup({
      runs: new Map([[runKeyOf('dev', 'child-1'), { cancel }]]), stopGoverned,
      persistStop: async () => ({ neverStarted: false, applied: false }),
    })
    const response = await h.post('/subagent/stop', { childId: 'child-1', attempt: 1, nodeId: 'N1' })
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ never_started: false })
    expect(cancel).not.toHaveBeenCalled()
    expect(stopGoverned).not.toHaveBeenCalled()
  })
})

import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'

import { DeviceActionsClient, handleDeviceActionsRoute, readDeviceEndpoint, registerDeviceActionTools, sanitizeCaller } from '../src/device-actions.ts'
import { handleRemoteAsksRoute } from '../src/remote-asks-wiring.ts'
import type { RunTreeEvent } from '../../../shared/seam-contracts/run-tree.ts'

const endpoint = { url: 'http://127.0.0.1:4567', token: 't'.repeat(64) }
function fakeRes() {
  const out = { status: 0, body: '' }
  const res = { writeHead: (s: number) => { out.status = s; return res }, end: (b?: string) => { out.body = b ?? '' }, write: () => true } as unknown as ServerResponse
  return { res, out }
}
const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })

describe('device actions endpoint', () => {
  it('reads only loopback endpoints with a long token', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lumo-da-'))
    const file = join(dir, 'e.json')
    writeFileSync(file, JSON.stringify(endpoint))
    expect(readDeviceEndpoint(file)).toEqual(endpoint)
    writeFileSync(file, JSON.stringify({ url: 'http://10.0.0.1:1', token: 't'.repeat(64) }))
    expect(readDeviceEndpoint(file)).toBeUndefined()
    expect(readDeviceEndpoint(undefined)).toBeUndefined()
  })
  it('sanitizes caller refs', () => {
    expect(sanitizeCaller({ session_ref: 's1', run_id: 'bad id', agent: 7 })).toEqual({ session_ref: 's1' })
  })
})

describe('DeviceActionsClient.invoke', () => {
  it('sends bearer token and records run tree + ask for high-risk', async () => {
    const events: RunTreeEvent[] = []
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>).authorization).toBe(`Bearer ${endpoint.token}`)
      return reply(200, { call_id: 'c1', state: 'succeeded', result: { text: 'x' }, confirmed: true })
    }) as unknown as typeof fetch
    const client = new DeviceActionsClient(endpoint, { apply: e => events.push(e) }, fetchImpl)
    const out = await client.invoke('clipboard.read', {}, { session_ref: 'sess-1', run_id: 'run-1' }, 'c1')
    expect(out.status).toBe(200)
    expect(events.map(e => e.type)).toEqual(['subagent.start', 'ask.pending', 'ask.resolved', 'subagent.end'])
    expect(events[1]).toMatchObject({ askId: 'device:c1', sessionRef: 'sess-1', runId: 'run-1' })
    expect(events[3]).toMatchObject({ stopReason: 'completed', childSessionId: 'device:c1', parentSessionId: 'sess-1' })
  })
  it('low-risk without session does not touch the run tree; rejection maps to aborted', async () => {
    const events: RunTreeEvent[] = []
    const client = new DeviceActionsClient(endpoint, { apply: e => events.push(e) }, (async () => reply(200, { state: 'succeeded' })) as unknown as typeof fetch)
    await client.invoke('open.url', { url: 'https://x.dev' }, {}, 'c2')
    expect(events).toEqual([])
    const c2 = new DeviceActionsClient(endpoint, { apply: e => events.push(e) }, (async () => reply(403, { state: 'rejected' })) as unknown as typeof fetch)
    await c2.invoke('screen.capture', {}, { session_ref: 's' }, 'c3')
    expect(events.at(-1)).toMatchObject({ type: 'subagent.end', stopReason: 'aborted' })
  })
  it('rejects malformed action ids locally and maps network errors to 502', async () => {
    const client = new DeviceActionsClient(endpoint, undefined, (async () => { throw Error('down') }) as unknown as typeof fetch)
    expect((await client.invoke('rm -rf', {}, {}, 'c4')).status).toBe(400)
    expect((await client.invoke('open.url', {}, {}, 'c5')).status).toBe(502)
  })
})

describe('device routes and tools', () => {
  it('501 without desktop endpoint, ignores other paths', async () => {
    const { res, out } = fakeRes()
    expect(await handleDeviceActionsRoute({ method: 'GET' } as IncomingMessage, res, '/lumo/api/asks', { client: undefined, readBody: async () => Buffer.from(''), userId: 'u' })).toBe(false)
    expect(await handleDeviceActionsRoute({ method: 'GET' } as IncomingMessage, res, '/lumo/api/device-actions', { client: undefined, readBody: async () => Buffer.from(''), userId: 'u' })).toBe(true)
    expect(out.status).toBe(501)
  })
  it('registers two agent tools that pass session context', async () => {
    const tools: Array<{ name: string; execute: (a: unknown, e: unknown) => Promise<unknown> }> = []
    const fetchImpl = vi.fn(async (_u: string, init?: RequestInit) => reply(200, { state: 'succeeded', echo: JSON.parse(String(init?.body ?? '{}')) })) as unknown as typeof fetch
    const dispose = registerDeviceActionTools({ tools: { register: (t: unknown) => { tools.push(t as never); return () => {} } } }, new DeviceActionsClient(endpoint, undefined, fetchImpl))
    expect(tools.map(t => t.name)).toEqual(['device_actions_list', 'device_action_invoke'])
    const out = await tools[1]!.execute({ action: 'system.notify', args: { title: 'hi' } }, { agent: { name: 'main', session: { id: 'sess-9' } } }) as { ok: boolean; echo: { caller: unknown } }
    expect(out.ok).toBe(true)
    expect(out.echo.caller).toEqual({ session_ref: 'sess-9', agent: 'main' })
    dispose()
  })
})

const row = (state: string) => ({
  envelope: { version: 1, request_id: 'R'.repeat(43), digest: `sha256:${'a'.repeat(64)}`, plan_json: '{}' },
  plan: { realm: 'r', node_id: 'n', owner_user_id: 'owner', project_id: 'p', session_ref: 'sess-x', capability: 'computer.interact', expires_at: '2999-01-01T00:00:00Z', intent: 'click', channel: 'c', subject: 's', sender_user_id: 'alice', team_id: 't', agent_id: 'a' },
  state, revision: 1, summary: '',
}) as never

describe('remote-computer ask wiring', () => {
  const base = { connectorUrl: '', headers: {}, timeoutMs: 10 }
  it('does not take over when broker is not installed', async () => {
    const { res } = fakeRes()
    expect(await handleRemoteAsksRoute({ method: 'GET', url: '/lumo/api/asks' } as IncomingMessage, res, '/lumo/api/asks', { ...base, service: undefined, confirm: undefined, readBody: async () => Buffer.from('') })).toBe(false)
  })
  it('lists local asks and links pending to run tree', async () => {
    const events: RunTreeEvent[] = []
    const { res, out } = fakeRes()
    const service = { list: () => [row('pending')], decide: vi.fn(), revoke: vi.fn() }
    await handleRemoteAsksRoute({ method: 'GET', url: '/lumo/api/asks' } as IncomingMessage, res, '/lumo/api/asks', { ...base, service, confirm: undefined, runTree: { apply: e => events.push(e) }, readBody: async () => Buffer.from('') })
    expect(JSON.parse(out.body).asks[0].id).toBe(`remote-computer:${'R'.repeat(43)}`)
    expect(events[0]).toMatchObject({ type: 'ask.pending', sessionRef: 'sess-x' })
  })
  it('approve requires local confirmation; declined confirmation becomes reject', async () => {
    const decide = vi.fn(async (_id: string, d: { approve: boolean }) => row(d.approve ? 'running' : 'denied'))
    const service = { list: () => [row('pending')], decide, revoke: vi.fn() }
    const path = `/lumo/api/asks/remote-computer:${'R'.repeat(43)}/answer`
    const body = async () => Buffer.from(JSON.stringify({ value: 'approve' }))
    let r = fakeRes()
    await handleRemoteAsksRoute({ method: 'POST' } as IncomingMessage, r.res, path, { ...base, service, confirm: undefined, readBody: body })
    expect(r.out.status).toBe(501)
    expect(decide).not.toHaveBeenCalled()
    r = fakeRes()
    await handleRemoteAsksRoute({ method: 'POST' } as IncomingMessage, r.res, path, { ...base, service, confirm: { confirm: async () => false }, readBody: body })
    expect(decide).toHaveBeenLastCalledWith('R'.repeat(43), { digest: `sha256:${'a'.repeat(64)}`, approve: false })
    r = fakeRes()
    await handleRemoteAsksRoute({ method: 'POST' } as IncomingMessage, r.res, path, { ...base, service, confirm: { confirm: async () => true }, readBody: body })
    expect(decide).toHaveBeenLastCalledWith('R'.repeat(43), { digest: `sha256:${'a'.repeat(64)}`, approve: true })
    expect(JSON.parse(r.out.body).ask.status).toBe('answered')
  })
  it('cancel revokes with ledger digest; other ask ids fall through', async () => {
    const revoke = vi.fn(async () => undefined)
    const service = { list: () => [row('pending')], decide: vi.fn(), revoke }
    const { res } = fakeRes()
    await handleRemoteAsksRoute({ method: 'POST' } as IncomingMessage, res, `/lumo/api/asks/remote-computer:${'R'.repeat(43)}/cancel`, { ...base, service, confirm: undefined, readBody: async () => Buffer.from('') })
    expect(revoke).toHaveBeenCalledWith('R'.repeat(43), `sha256:${'a'.repeat(64)}`)
    expect(await handleRemoteAsksRoute({ method: 'POST' } as IncomingMessage, res, '/lumo/api/asks/connector:x/answer', { ...base, service, confirm: undefined, readBody: async () => Buffer.from('') })).toBe(false)
  })
})

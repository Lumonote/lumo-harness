import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { RunTreeEvent } from '../../../shared/seam-contracts/run-tree.ts'
import { handleRemoteHostsRoute, redact, remoteHostsEnabled, RemoteHostsService, sshBaseArgs, type SshRunner } from '../src/remote-hosts-api.ts'

const target = { version: '1.2.3', dshSha: '4b399c39a6d1479cd84ca591b4d7c88e24d38a96', dshTag: 'dsh-v0.2.3-alpha.2' }
const PROBE_OK = 'os=Linux\narch=x86_64\ndep.node=v24.1.0\ndep.tar=tar\ndep.curl=curl\n'

function setup(script: Array<{ code: number; stdout?: string; stderr?: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'lumo-remote-'))
  const scriptPath = join(dir, 's.sh'); writeFileSync(scriptPath, '#!/bin/sh\n')
  const calls: string[][] = []
  const events: RunTreeEvent[] = []
  let closed = 0
  const runner: SshRunner = {
    async run(_h, args) { calls.push(args); const r = script.shift() ?? { code: 0, stdout: PROBE_OK }; return { code: r.code, stdout: r.stdout ?? '', stderr: r.stderr ?? '' } },
    forward() { return { pid: 42, ready: Promise.resolve(), close: () => { closed++ }, done: new Promise<number>(() => {}) } },
  }
  const svc = new RemoteHostsService({ file: join(dir, 'remote-hosts.json'), target, runner, scriptPath, runTree: { apply: e => events.push(e) }, identity: { userId: 'u1', realm: 'r' } })
  return { svc, calls, events, dir, closed: () => closed }
}
const host = { name: 'gpu', address: 'gpu.example.com', user: 'ubuntu', auth: { kind: 'agent' } }

describe('RemoteHostsService', () => {
  it('persists hosts without secrets and rejects duplicates', () => {
    const { svc, dir } = setup([])
    expect(svc.create(host).ok).toBe(true)
    expect(svc.create(host).ok).toBe(false)
    expect(readFileSync(join(dir, 'remote-hosts.json'), 'utf8')).not.toMatch(/PRIVATE KEY/)
  })
  it('requires probe + Ask approval before install, records run tree', async () => {
    const { svc, calls, events } = setup([{ code: 0, stdout: PROBE_OK }, { code: 0, stdout: 'result=installed\nrelease=1.2.3-4b399c39a6d1' }, { code: 0, stdout: `${PROBE_OK}installed.version=1.2.3\ninstalled.dsh=${target.dshSha}\n` }])
    const created = svc.create(host); if (!created.ok) throw new Error()
    const id = created.host.id
    expect(svc.request(id, 'install').ok).toBe(false) // 未探测
    await svc.probe(id)
    const r = svc.request(id, 'install'); if (!r.ok) throw new Error(r.error)
    expect(calls).toHaveLength(1) // 批准前不执行
    expect(svc.request(id, 'install').ok).toBe(false) // 重复申请
    expect(svc.answer(r.ask.id, 'approve', 'someone-else').ok).toBe(false)
    const a = svc.answer(r.ask.id, 'approve', 'u1'); await a.done
    expect(calls[1]!.slice(0, 4)).toEqual(['sh', '-s', '--', 'install'])
    expect(calls[1]).toContain(target.dshSha)
    expect(svc.get(id)!.state).toBe('installed')
    expect(events.map(e => e.type)).toEqual(expect.arrayContaining(['ask.pending', 'ask.resolved']))
    expect(events.filter(e => e.type === 'node.upsert').map(e => (e as { node: { status: string } }).node.status)).toEqual(['pending', 'running', 'succeeded'])
    expect(svc.answer(r.ask.id, 'approve', 'u1').ok).toBe(false) // 幂等
  })
  it('reject cancels; failure marks failed and reports rollback; retries ssh 255', async () => {
    const { svc, calls, events } = setup([{ code: 0, stdout: PROBE_OK }, { code: 255 }, { code: 1, stdout: 'result=rolled-back', stderr: 'error=self check failed' }])
    const c = svc.create(host); if (!c.ok) throw new Error()
    await svc.probe(c.host.id)
    const r1 = svc.request(c.host.id, 'install'); if (!r1.ok) throw new Error()
    svc.answer(r1.ask.id, 'reject', 'u1')
    expect(events.at(-1)).toMatchObject({ node: { status: 'cancelled' } })
    const r2 = svc.request(c.host.id, 'install'); if (!r2.ok) throw new Error()
    await svc.answer(r2.ask.id, 'approve', 'u1').done
    expect(calls).toHaveLength(3)
    expect(svc.get(c.host.id)!.lastError).toContain('已回滚')
  })
  it('auto-upgrade raises an Ask (never silently runs)', async () => {
    const { svc } = setup([{ code: 0, stdout: `${PROBE_OK}installed.version=1.2.2\ninstalled.dsh=${target.dshSha}\n` }])
    const c = svc.create({ ...host, autoUpgrade: true }); if (!c.ok) throw new Error()
    const v = await svc.checkVersion(c.host.id)
    expect(v.verdict).toBe('upgrade'); expect(v.ask?.status).toBe('pending')
  })
  it('tunnel registers a device and can be closed', async () => {
    const { svc, closed } = setup([{ code: 0, stdout: `${PROBE_OK}installed.version=1.2.3\ninstalled.dsh=${target.dshSha}\n` }])
    const c = svc.create(host); if (!c.ok) throw new Error()
    await svc.probe(c.host.id)
    const r = svc.request(c.host.id, 'tunnel'); if (!r.ok) throw new Error()
    await svc.answer(r.ask.id, 'approve', 'u1').done
    expect(svc.get(c.host.id)).toMatchObject({ state: 'connected', deviceId: `remote:${c.host.id}`, tunnel: { status: 'up', mode: 'ssh-local-forward' } })
    expect(svc.closeTunnel(c.host.id)).toBe(true); expect(closed()).toBe(1)
  })
  it('vault auth without resolver fails closed', async () => {
    const { svc } = setup([])
    const c = svc.create({ ...host, auth: { kind: 'vault', ref: 'vault:secret/ssh#key' } }); if (!c.ok) throw new Error()
    await expect(svc.probe(c.host.id)).rejects.toThrow('Vault')
  })
})

describe('ssh args and routes', () => {
  it('uses strict, non-interactive ssh options', () => {
    const args = sshBaseArgs({ id: 'x', name: 'n', address: 'h', port: 2222, user: 'u', auth: { kind: 'agent' }, installRoot: '~', autoUpgrade: false, state: 'registered', createdAt: '', updatedAt: '', hostKeyFingerprint: 'SHA256:x' }, '/k')
    expect(args).toEqual(expect.arrayContaining(['BatchMode=yes', 'StrictHostKeyChecking=yes', 'PasswordAuthentication=no', '--', 'u@h']))
    expect(args.indexOf('--')).toBe(args.length - 2)
  })
  it('redacts secrets and honours the switch', () => {
    expect(redact('token=abc -----BEGIN X-----\nk\n-----END X-----')).toBe('token=[redacted] [redacted-key]')
    expect(remoteHostsEnabled({ LUMO_REMOTE_HOSTS: 'off' })).toBe(false)
    expect(remoteHostsEnabled({})).toBe(true)
  })
  it('routes: 404 when disabled, create + list', async () => {
    const out = { status: 0, body: '' }
    const res = { writeHead: (s: number) => { out.status = s; return res }, end: (b?: string) => { out.body = b ?? '' } } as unknown as ServerResponse
    const req = (method: string) => ({ method, url: '/' }) as IncomingMessage
    expect(await handleRemoteHostsRoute(req('GET'), res, '/lumo/api/asks', undefined, { readBody: async () => Buffer.from(''), userId: 'u' })).toBe(false)
    await handleRemoteHostsRoute(req('GET'), res, '/lumo/api/remote-hosts', undefined, { readBody: async () => Buffer.from(''), userId: 'u' })
    expect(out.status).toBe(404)
    const { svc } = setup([])
    await handleRemoteHostsRoute(req('POST'), res, '/lumo/api/remote-hosts', svc, { readBody: async () => Buffer.from(JSON.stringify(host)), userId: 'u1' })
    expect(out.status).toBe(201)
    await handleRemoteHostsRoute(req('GET'), res, '/lumo/api/remote-hosts', svc, { readBody: async () => Buffer.from(''), userId: 'u1' })
    expect(JSON.parse(out.body).hosts).toHaveLength(1)
  })
})

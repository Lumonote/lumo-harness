import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RemoteHostsService, type SshRunner } from '../src/remote-hosts-api.ts'
import type { RunTreeEvent } from '../../../shared/seam-contracts/run-tree.ts'

const target = { version: '1.2.3', dshSha: 'a'.repeat(40), dshTag: 'test' }
const installed = `os=Linux\narch=x86_64\ndep.node=v24.1.0\ndep.tar=tar\ndep.curl=curl\ninstalled.version=1.2.3\ninstalled.dsh=${target.dshSha}\n`
const input = { name: 'remote', address: 'test.example', user: 'user', auth: { kind: 'agent' } }
const dirs: string[] = []
function deferred<T>() { let resolve!: (v: T) => void, reject!: (e: Error) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'remote-reliability-')); dirs.push(dir)
  const file = join(dir, 'hosts.json'), scriptPath = join(dir, 'script.sh')
  writeFileSync(scriptPath, '#!/bin/sh\n')
  const ready = deferred<void>(), done = deferred<number>(), close = vi.fn()
  const run = vi.fn(async () => ({ code: 0, stdout: installed, stderr: '' }))
  const forward = vi.fn(() => ({ pid: 42, ready: ready.promise, done: done.promise, close }))
  const runner: SshRunner = { run, forward }, events: RunTreeEvent[] = []
  const service = new RemoteHostsService({ file, scriptPath, runner, target, runTree: { apply: e => events.push(e) } })
  const created = service.create(input); if (!created.ok) throw new Error(created.error)
  const id = created.host.id
  const start = async () => { await service.probe(id); const r = service.request(id, 'tunnel'); if (!r.ok) throw new Error(r.error); const approved = service.answer(r.ask.id, 'approve', 'user'); await vi.waitFor(() => expect(forward).toHaveBeenCalled()); return approved }
  return { service, dir, file, scriptPath, runner, run, forward, ready, done, close, events, id, start }
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('remote tunnel lifecycle', () => {
  it('stays connecting until ready, records disconnect consistently and permits retry', async () => {
    const f = fixture(), answer = await f.start()
    expect(f.service.get(f.id)).toMatchObject({ state: 'connecting', tunnel: { status: 'starting' } })
    expect(f.events.at(-1)).toMatchObject({ node: { status: 'running' } })
    f.ready.resolve(); await answer.done
    expect(f.service.get(f.id)).toMatchObject({ state: 'connected', tunnel: { status: 'up' } })
    await f.service.probe(f.id)
    expect(f.service.get(f.id)?.state).toBe('connected')
    f.done.resolve(255); await Promise.resolve()
    expect(f.service.get(f.id)).toMatchObject({ state: 'failed', tunnel: { status: 'down' } })
    expect(f.service.get(f.id)?.deviceId).toBeUndefined()
    expect(f.service.get(f.id)?.tunnel?.pid).toBeUndefined()
    expect(f.service.request(f.id, 'tunnel').ok).toBe(true)
  })
  it('early exit cannot report success or retain online state', async () => {
    const f = fixture(), answer = await f.start()
    f.done.resolve(255); await answer.done
    expect(f.events.at(-1)).toMatchObject({ node: { status: 'failed' } })
    expect(f.service.get(f.id)).toMatchObject({ state: 'failed', tunnel: { status: 'down' } })
    f.ready.resolve(); await Promise.resolve()
    expect(f.service.get(f.id)?.state).toBe('failed')
  })
  it.each(['close', 'delete'] as const)('%s while connecting prevents delayed readiness from reviving the host', async action => {
    const f = fixture(), answer = await f.start()
    if (action === 'close') expect(f.service.closeTunnel(f.id)).toBe(true)
    else expect(f.service.remove(f.id)).toBe(true)
    await answer.done; f.ready.resolve(); f.done.resolve(0); await Promise.resolve()
    expect(f.close).toHaveBeenCalled()
    expect(f.events.at(-1)).toMatchObject({ node: { status: 'cancelled' } })
    if (action === 'delete') expect(f.service.list()).toEqual([])
    else expect(f.service.get(f.id)).toMatchObject({ state: 'installed', tunnel: { status: 'down' } })
  })
  it('restarts offline and removes stale PID/device claims', async () => {
    const f = fixture(), answer = await f.start()
    f.ready.resolve(); await answer.done
    const restarted = new RemoteHostsService({ file: f.file, target, runner: f.runner })
    expect(restarted.get(f.id)).toMatchObject({ state: 'installed', tunnel: { status: 'down' } })
    expect(restarted.get(f.id)?.deviceId).toBeUndefined()
    expect(JSON.parse(readFileSync(f.file, 'utf8')).hosts[0].tunnel.pid).toBeUndefined()
    f.service.closeAll()
  })
  it('preserves actual disconnect even when snapshot writing fails', async () => {
    const f = fixture(), answer = await f.start()
    f.ready.resolve(); await answer.done
    renameSync(f.file, `${f.file}.saved`); writeFileSync(f.file, 'file occupying config path')
    // Replace the parent with a file, a deterministic failure even when tests run with elevated filesystem rights.
    const moved = `${f.dir}-moved`; renameSync(f.dir, moved); dirs.push(moved); writeFileSync(f.dir, 'blocked')
    expect(() => f.service.closeTunnel(f.id)).toThrow('保存失败')
    expect(f.service.get(f.id)).toMatchObject({ state: 'installed', tunnel: { status: 'down' } })
    expect(f.service.get(f.id)?.lastError).toContain('保存失败')
    expect(f.close).toHaveBeenCalled()
  })
  it('serializes approvals against in-flight probes and other pending operations', async () => {
    const f = fixture(); await f.service.probe(f.id)
    const pending = f.service.request(f.id, 'tunnel'); if (!pending.ok) throw new Error()
    expect(f.service.request(f.id, 'rollback').ok).toBe(false)
    const probe = deferred<{ code: number; stdout: string; stderr: string }>()
    f.run.mockImplementationOnce(() => probe.promise)
    const running = f.service.probe(f.id)
    expect(f.service.answer(pending.ask.id, 'approve', 'user').ok).toBe(false)
    probe.resolve({ code: 0, stdout: installed, stderr: '' }); await running
    const approved = f.service.answer(pending.ask.id, 'approve', 'user')
    f.ready.resolve(); await approved.done
    f.service.closeAll()
  })
  it('removing a host cancels its pending approval and run-tree entry', async () => {
    const f = fixture(); await f.service.probe(f.id)
    const r = f.service.request(f.id, 'tunnel'); if (!r.ok) throw new Error(r.error)
    f.service.remove(f.id)
    expect(f.service.asks().find(a => a.id === r.ask.id)?.status).toBe('cancelled')
    expect(f.events.at(-1)).toMatchObject({ node: { status: 'cancelled', detail: '主机已移除' } })
    expect(f.service.answer(r.ask.id, 'approve', 'user').ok).toBe(false)
    expect(f.forward).not.toHaveBeenCalled()
  })
  it('an unsuccessful post-install probe cannot produce a successful run', async () => {
    const f = fixture(); await f.service.probe(f.id)
    f.run.mockResolvedValueOnce({ code: 0, stdout: 'result=installed', stderr: '' }).mockResolvedValueOnce({ code: 255, stdout: '', stderr: 'disconnected' })
    const r = f.service.request(f.id, 'upgrade'); if (!r.ok) throw new Error(r.error)
    await f.service.answer(r.ask.id, 'approve', 'user').done
    expect(f.events.at(-1)).toMatchObject({ node: { status: 'failed' } })
    expect(f.service.get(f.id)?.lastError).toContain('探测失败')
  })
})

describe('remote host persistence', () => {
  it.each(['{bad json', '{"hosts":{}}', '{"hosts":[{}]}'])('preserves corrupt configuration and rejects mutation: %s', contents => {
    const f = fixture(); writeFileSync(f.file, contents)
    const service = new RemoteHostsService({ file: f.file, target, runner: f.runner })
    expect(() => service.list()).toThrow('原文件已保留')
    expect(() => service.create(input)).toThrow('原文件已保留')
    expect(readFileSync(f.file, 'utf8')).toBe(contents)
  })
  it('failed creation never reports success or inserts an in-memory host', () => {
    const f = fixture(), blocker = join(f.dir, 'blocked'); writeFileSync(blocker, 'x')
    const service = new RemoteHostsService({ file: join(blocker, 'hosts.json'), target, runner: f.runner })
    expect(() => service.create(input)).toThrow('保存失败')
    expect(service.list()).toEqual([])
  })
  it('validates nested persisted records before allowing writes', () => {
    const f = fixture(), data = JSON.parse(readFileSync(f.file, 'utf8'))
    data.hosts[0].tunnel = { mode: 'ssh-local-forward', status: 'up', localPort: 0, remotePort: 7420 }
    const contents = JSON.stringify(data); writeFileSync(f.file, contents)
    const service = new RemoteHostsService({ file: f.file, target, runner: f.runner })
    expect(() => service.remove(f.id)).toThrow('隧道记录无效')
    expect(readFileSync(f.file, 'utf8')).toBe(contents)
  })
})

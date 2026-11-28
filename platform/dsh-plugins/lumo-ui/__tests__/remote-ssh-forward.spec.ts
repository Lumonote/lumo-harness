import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSshRunner } from '../src/remote-ssh.ts'
import type { RemoteHost } from '../../../shared/seam-contracts/remote-hosts.ts'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), command: vi.fn(), trust: vi.fn(), get: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }))
vi.mock('node:http', () => ({ get: mocks.get }))
vi.mock('../src/remote-ssh-process.ts', () => ({ runSshCommand: mocks.command }))
vi.mock('../src/remote-ssh-trust.ts', () => ({ prepareHostTrust: mocks.trust, pinnedKnownHostsFile: (_h: unknown, file: string) => file }))
const host: RemoteHost = { id: 'host-id-123456', name: 'test', address: 'host.example', port: 22, user: 'user', auth: { kind: 'agent' }, installRoot: '~/.lumo-remote', autoUpgrade: false, state: 'installed', createdAt: '', updatedAt: '' }
let child: EventEmitter & { pid: number; stderr: PassThrough; kill: ReturnType<typeof vi.fn> }
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks()
  child = Object.assign(new EventEmitter(), { pid: 123, stderr: new PassThrough(), kill: vi.fn(() => { child.emit('close', 0); return true }) })
  mocks.spawn.mockReturnValue(child); mocks.trust.mockResolvedValue(undefined)
  mocks.command.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
  mocks.get.mockImplementation((_options, callback) => {
    queueMicrotask(() => callback({ statusCode: 200, destroy() {} }))
    return Object.assign(new EventEmitter(), { destroy() {} })
  })
})
afterEach(() => vi.useRealTimers())
const flush = async () => { await vi.advanceTimersByTimeAsync(1) }

describe('SSH forward readiness', () => {
  it('requires our master to establish the requested forward before HTTP can mark it ready', async () => {
    let allowBinding!: (result: { code: number; stdout: string; stderr: string }) => void
    const binding = new Promise(resolve => { allowBinding = resolve })
    mocks.command.mockImplementation(async (_command, args: string[]) => args.includes('forward') ? binding : { code: 0, stdout: '', stderr: '' })
    const tunnel = createSshRunner('/tmp/known').forward(host, 23000, 7420, {})
    let ready = false; void tunnel.ready.then(() => { ready = true })
    await flush()
    expect(ready).toBe(false); expect(mocks.get).not.toHaveBeenCalled()
    expect(mocks.command.mock.calls.some(([, args]) => args.includes('forward') && args.includes('127.0.0.1:23000:127.0.0.1:7420'))).toBe(true)
    allowBinding({ code: 0, stdout: '', stderr: '' }); await flush(); await tunnel.ready
    expect(ready).toBe(true); expect(tunnel.pid).toBe(123)
    tunnel.close(); await tunnel.done
  })
  it('a busy local port fails without mistaking another HTTP service for the tunnel', async () => {
    mocks.command.mockImplementation(async (_command, args: string[]) => ({ code: args.includes('forward') ? 255 : 0, stdout: '', stderr: 'Address already in use' }))
    const tunnel = createSshRunner('/tmp/known').forward(host, 23000, 7420, {})
    const assertion = expect(tunnel.ready).rejects.toThrow('端口转发失败')
    await flush(); await assertion
    expect(mocks.get).not.toHaveBeenCalled(); expect(child.kill).toHaveBeenCalled()
  })
  it('does not report readiness while the remote HTTP service is unavailable', async () => {
    mocks.get.mockImplementation(() => {
      const req = Object.assign(new EventEmitter(), { destroy() {} }); queueMicrotask(() => req.emit('error', new Error('reset'))); return req
    })
    const tunnel = createSshRunner('/tmp/known').forward(host, 23000, 7420, {})
    const assertion = expect(tunnel.ready).rejects.toThrow('未就绪')
    await vi.advanceTimersByTimeAsync(31_000); await assertion
    expect(child.kill).toHaveBeenCalled()
  })
  it('cancellation before host verification completes never starts ssh', async () => {
    let trusted!: () => void
    mocks.trust.mockReturnValue(new Promise<void>(resolve => { trusted = resolve }))
    const tunnel = createSshRunner('/tmp/known').forward(host, 23000, 7420, {})
    const assertion = expect(tunnel.ready).rejects.toThrow('取消')
    tunnel.close(); trusted(); await flush(); await assertion
    expect(await tunnel.done).toBe(130); expect(mocks.spawn).not.toHaveBeenCalled()
  })
  it('verification failure never authenticates or starts a forwarding process', async () => {
    mocks.trust.mockRejectedValue(new Error('主机指纹不匹配'))
    const tunnel = createSshRunner('/tmp/known').forward(host, 23000, 7420, {})
    await expect(tunnel.ready).rejects.toThrow('指纹不匹配')
    expect(mocks.spawn).not.toHaveBeenCalled()
  })
})

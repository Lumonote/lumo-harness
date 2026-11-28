import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ManagedCliTools, cleanInstallLog } from '../src/managed-cli.ts'
import { EngineRegistry, BUILTIN_ENGINES } from '../src/registry.ts'
import { runInstallerCommand, type CliInstaller } from '../src/cli-install-runner.ts'
import { handleCliInstallRoute } from '../src/cli-install-routes.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'

const roots: string[] = []
const root = () => { const dir = mkdtempSync(join(tmpdir(), 'lumo-managed-cli-')); roots.push(dir); return dir }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const fake: CliInstaller = async ({ directory, recipe, progress }) => {
  progress('下载与安装', 'installed\n'); mkdirSync(join(directory, 'bin'), { recursive: true })
  writeFileSync(join(directory, 'bin', recipe.binary), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  return '1.2.3'
}
const request = (action: 'install' | 'reinstall' = 'install') => ({ requestId: randomUUID(), action, version: 'latest' })
const options = { freeSpace: () => 10 * 1024 ** 3, install: fake }

describe('project-managed CLI lifecycle', () => {
  it('activates only a complete release, routes all new sessions through it, and persists across restart', async () => {
    const directory = root(), cli = new ManagedCliTools(directory, options)
    const registry = new EngineRegistry(BUILTIN_ENGINES, new Set(), { managed: id => cli.resolve(id) })
    expect(cli.resolve('codex')).toBeUndefined()
    const started = cli.start('codex', request())
    expect(started.job?.status).toBe('running'); expect(cli.resolve('codex')).toBeUndefined()
    await cli.idle()
    const tool = cli.view('codex')
    expect(tool).toMatchObject({ installation: { version: '1.2.3' }, job: { status: 'succeeded' } })
    expect(registry.resolve('codex')).toMatchObject({ bin: tool.executable, args: ['app-server'] })
    expect(new ManagedCliTools(directory, options).resolve('codex')).toEqual(cli.resolve('codex'))
    expect(new EngineRegistry(BUILTIN_ENGINES, new Set(['codex']), { managed: id => cli.resolve(id) }).resolve('codex')).toHaveProperty('error')
  })
  it('preserves the previous working installation when reinstall fails and cleans only the failed attempt', async () => {
    const directory = root(), install = vi.fn(fake), cli = new ManagedCliTools(directory, { ...options, install })
    cli.start('codex', request()); await cli.idle()
    const previous = cli.resolve('codex'), original = cli.view('codex').installation!
    install.mockRejectedValueOnce(new Error('network disconnected'))
    const retry = request('reinstall'); cli.start('codex', retry); await cli.idle()
    expect(cli.view('codex').job).toMatchObject({ status: 'failed', error: 'network disconnected' })
    expect(cli.resolve('codex')).toEqual(previous)
    expect(existsSync(join(directory, 'codex/releases', retry.requestId))).toBe(false)
    expect(existsSync(join(directory, 'codex/releases', original.releaseId))).toBe(true)
  })
  it('deduplicates requests, prevents concurrent installs and waits for cancellation before releasing the lock', async () => {
    let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    const install: CliInstaller = async ({ signal }) => { started(); return await new Promise((_, reject) => signal.addEventListener('abort', () => setTimeout(() => reject(signal.reason), 5), { once: true })) }
    const directory = root(), cli = new ManagedCliTools(directory, { ...options, install }), input = request()
    cli.start('trae', input); await ready
    expect(cli.start('trae', input).job?.id).toBe(input.requestId)
    expect(() => cli.start('codex', request())).toThrow('正在安装')
    expect(() => new ManagedCliTools(directory, options).start('codex', request())).toThrow('正在安装')
    expect(() => cli.cancel('trae', randomUUID())).toThrow('任务已变化')
    cli.cancel('trae', input.requestId)
    expect(cli.view('trae').job?.status).toBe('running')
    await cli.idle()
    expect(cli.view('trae').job?.status).toBe('cancelled')
    expect(existsSync(join(directory, '.install-lock'))).toBe(false)
  })
  it('rejects insufficient disk space before downloading anything', async () => {
    const install = vi.fn(fake), cli = new ManagedCliTools(root(), { freeSpace: () => 100, install })
    cli.start('trae', request()); await cli.idle()
    expect(install).not.toHaveBeenCalled()
    expect(cli.view('trae').job).toMatchObject({ status: 'failed', error: expect.stringContaining('磁盘空间不足') })
  })
  it('never overwrites a previous release when an older request is replayed after another installation', async () => {
    const cli = new ManagedCliTools(root(), options), first = request()
    cli.start('codex', first); await cli.idle()
    const previous = cli.view('codex').executable!
    cli.start('codex', request('reinstall')); await cli.idle()
    const current = cli.resolve('codex')
    cli.start('codex', first); await cli.idle()
    expect(cli.view('codex').job?.status).toBe('failed')
    expect(existsSync(previous)).toBe(true); expect(cli.resolve('codex')).toEqual(current)
  })
  it('marks interrupted attempts on restart and fails closed for a broken managed executable', async () => {
    const directory = root(), cli = new ManagedCliTools(directory, options)
    cli.start('codex', request()); await cli.idle()
    const path = join(directory, 'codex/state.json'), saved = JSON.parse(readFileSync(path, 'utf8'))
    saved.job.status = 'running'; writeFileSync(path, JSON.stringify(saved))
    const next = new ManagedCliTools(directory, options)
    expect(next.view('codex').job?.status).toBe('interrupted')
    rmSync(cli.view('codex').executable!)
    expect(new EngineRegistry(BUILTIN_ENGINES, new Set(), { managed: id => next.resolve(id) }).resolve('codex')).toHaveProperty('error')
  })
  it('rejects uncurated commands, version injection and paths from persisted records', async () => {
    const directory = root(), cli = new ManagedCliTools(directory, options)
    expect(() => cli.start('unknown', request())).toThrow('尚未提供')
    expect(() => cli.start('codex', { ...request(), version: 'latest; touch /tmp/no' })).toThrow('无效')
    expect(() => cli.start('codex', { ...request(), requestId: '../../escape' })).toThrow('无效')
    mkdirSync(join(directory, 'codex')); writeFileSync(join(directory, 'codex/state.json'), JSON.stringify({ version: 1, installation: { releaseId: '../../elsewhere', version: '1.2.3' } }))
    expect(new ManagedCliTools(directory).resolve('codex')).toHaveProperty('error')
    expect(cleanInstallLog('token=secret https://name:password@example.com\x1b[31m')).not.toMatch(/secret|password|\x1b/u)
  })
  it('reaps a running installer when cancelled', async () => {
    const controller = new AbortController(), output: string[] = []
    const run = runInstallerCommand({ bin: process.execPath, args: ['-e', 'console.log("ready");setInterval(()=>{},1000)'] }, root(), process.env, controller.signal, text => { output.push(text); controller.abort(new Error('cancel test')) })
    await expect(run).rejects.toThrow('cancel test')
    expect(output.join('')).toContain('ready')
  })
})

describe('CLI installation API', () => {
  it('requires local same-origin JSON and exposes no arbitrary command or installer URL', async () => {
    const cli = new ManagedCliTools(root(), options), input = request()
    const call = (action: string, payload: unknown = input, headers: Record<string, string> = {}, address = '127.0.0.1') => {
      let status = 0, result: any
      const req = { method: action ? 'POST' : 'GET', socket: { remoteAddress: address }, headers: { host: '127.0.0.1:4200', origin: 'http://127.0.0.1:4200', 'content-type': 'application/json', ...headers } }
      const res = { writeHead: (code: number) => { status = code }, end: (body: string) => { result = JSON.parse(body) } }
      handleCliInstallRoute(req as IncomingMessage, res as unknown as ServerResponse, `/engines/codex/installation${action ? `/${action}` : ''}`, payload as Record<string, unknown>, cli)
      return { status, result }
    }
    expect(call('install', input, { origin: 'https://foreign.test' }).status).toBe(403)
    expect(call('install', input, { origin: '' }).status).toBe(403)
    expect(call('install', input, {}, '192.168.1.2').status).toBe(403)
    expect(call('install', { ...input, command: 'anything' }).status).toBe(400)
    expect(call('install').status).toBe(202); await cli.idle()
    expect(call('').result.tool.job.status).toBe('succeeded')
  })
})

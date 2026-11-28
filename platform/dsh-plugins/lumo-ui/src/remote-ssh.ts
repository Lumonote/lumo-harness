import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { get } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { shellQuote, type RemoteHost } from '../../../shared/seam-contracts/remote-hosts.ts'
import { runSshCommand, type CommandOptions, type CommandResult } from './remote-ssh-process.ts'
import { pinnedKnownHostsFile, prepareHostTrust } from './remote-ssh-trust.ts'

export interface SshForward { readonly pid?: number | undefined; close(): void; ready: Promise<void>; done: Promise<number> }
export interface SshRunner {
  run(host: RemoteHost, args: string[], options: CommandOptions & { identity?: string }): Promise<CommandResult>
  forward(host: RemoteHost, localPort: number, remotePort: number, options: { identity?: string; signal?: AbortSignal }): SshForward
}

export function sshBaseArgs(host: RemoteHost, knownHostsFile: string, identity?: string): string[] {
  const args = ['-p', String(host.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=2',
    '-o', `UserKnownHostsFile=${pinnedKnownHostsFile(host, knownHostsFile)}`, '-o', 'GlobalKnownHostsFile=/dev/null',
    '-o', `StrictHostKeyChecking=${host.hostKeyFingerprint ? 'yes' : 'accept-new'}`, '-o', 'KnownHostsCommand=none', '-o', 'UpdateHostKeys=no', '-o', 'VerifyHostKeyDNS=no',
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none']
  if (identity) args.push('-o', 'IdentitiesOnly=yes', '-i', identity)
  args.push('--', `${host.user}@${host.address}`)
  return args
}

function httpReady(port: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    const req = get({ hostname: '127.0.0.1', port, path: '/', timeout: 1000, signal }, res => {
      const ok = Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 500)
      res.destroy(); resolve(ok)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

function pause(signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(); return }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
    const timer = setTimeout(done, 150); signal.addEventListener('abort', done, { once: true })
  })
}

function forward(host: RemoteHost, knownHostsFile: string, localPort: number, remotePort: number, options: { identity?: string; signal?: AbortSignal }): SshForward {
  const abort = new AbortController()
  let child: ChildProcess | undefined, stopped = false, exitCode: number | undefined, stderr = '', controlDir: string | undefined
  let resolveDone!: (code: number) => void
  let force: ReturnType<typeof setTimeout> | undefined
  const done = new Promise<number>(resolve => { resolveDone = resolve })
  const finish = (code: number) => {
    if (exitCode !== undefined) return
    exitCode = code
    if (force) clearTimeout(force)
    options.signal?.removeEventListener('abort', close)
    if (controlDir) { try { rmSync(controlDir, { recursive: true, force: true }) } catch { /* Process state still settles. */ } }
    resolveDone(code)
  }
  const close = () => {
    stopped = true; abort.abort()
    if (!child) { finish(130); return }
    if (exitCode !== undefined) return
    child.kill('SIGTERM'); force ??= setTimeout(() => child?.kill('SIGKILL'), 1500); force.unref?.()
  }
  options.signal?.addEventListener('abort', close, { once: true })
  if (options.signal?.aborted) close()
  const ready = (async () => {
    try {
      await prepareHostTrust(host, knownHostsFile, runSshCommand, abort.signal)
      if (stopped) throw new Error('隧道连接已取消')
      controlDir = mkdtempSync(join(tmpdir(), 'lumo-ssh-'))
      const control = join(controlDir, 'socket')
      const base = sshBaseArgs(host, knownHostsFile, options.identity)
      const at = base.indexOf('--')
      child = spawn('ssh', ['-o', 'ControlMaster=yes', '-o', `ControlPath=${control}`, '-o', 'ControlPersist=no', ...base.slice(0, at), '-N', '-o', 'ExitOnForwardFailure=yes', ...base.slice(at)], { stdio: ['ignore', 'ignore', 'pipe'] })
      child.stderr?.on('data', d => { stderr = `${stderr}${String(d)}`.slice(-4000) })
      child.on('error', e => { stderr = e.message; finish(127) })
      child.on('close', code => finish(code ?? 1))
      const deadline = Date.now() + 30_000
      let bound = false
      while (!stopped && exitCode === undefined && Date.now() < deadline) {
        // A response on the port alone could belong to another process. Check our private SSH master too.
        const master = await runSshCommand('ssh', ['-S', control, '-O', 'check', ...base], { timeoutMs: 1000, signal: abort.signal })
        if (master.code === 0) {
          if (!bound) {
            const bind = await runSshCommand('ssh', ['-S', control, '-O', 'forward', ...base.slice(0, at), '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, ...base.slice(at)], { timeoutMs: 5000, signal: abort.signal })
            if (bind.code !== 0) throw new Error(`SSH 端口转发失败：${bind.stderr}`)
            bound = true
          }
          if (await httpReady(localPort, abort.signal) && exitCode === undefined && !stopped) return
        }
        await pause(abort.signal)
      }
      throw new Error(stopped ? '隧道连接已取消' : exitCode !== undefined ? `SSH 隧道退出（${exitCode}）：${stderr.trim()}` : 'SSH 隧道未就绪：远端工作台未响应或本地端口不可用')
    } catch (error) { close(); throw error }
  })()
  return { get pid() { return child?.pid }, close, ready, done }
}

export function createSshRunner(knownHostsFile: string): SshRunner {
  return {
    async run(host, args, options) {
      await prepareHostTrust(host, knownHostsFile, runSshCommand, options.signal)
      return runSshCommand('ssh', [...sshBaseArgs(host, knownHostsFile, options.identity), ...args.map(a => /^[A-Za-z0-9_.\/:=@-]+$/u.test(a) ? a : shellQuote(a))], options)
    },
    forward: (host, localPort, remotePort, options) => forward(host, knownHostsFile, localPort, remotePort, options),
  }
}

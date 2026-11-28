import { spawn } from 'node:child_process'

export interface CommandOptions { stdin?: string; timeoutMs?: number; signal?: AbortSignal }
export interface CommandResult { code: number; stdout: string; stderr: string }
export type CommandRunner = (command: string, args: string[], options?: CommandOptions) => Promise<CommandResult>

/** No shell, bounded diagnostics, cancellation and a hard deadline for stuck SSH processes. */
export const runSshCommand: CommandRunner = (command, args, options = {}) => new Promise(resolve => {
  if (options.signal?.aborted) { resolve({ code: 130, stdout: '', stderr: '操作已取消' }); return }
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  let stdout = '', stderr = '', stopped = false
  let force: ReturnType<typeof setTimeout> | undefined
  const stop = () => {
    stopped = true; child.kill('SIGTERM')
    force ??= setTimeout(() => child.kill('SIGKILL'), 1500); force.unref?.()
  }
  const timer = setTimeout(stop, options.timeoutMs ?? 30_000)
  options.signal?.addEventListener('abort', stop, { once: true })
  child.stdout.on('data', d => { stdout += String(d); if (stdout.length > 1024 * 1024) { stdout = stdout.slice(0, 1024 * 1024); stop() } })
  child.stderr.on('data', d => { stderr += String(d); if (stderr.length > 1024 * 1024) { stderr = stderr.slice(-1024 * 1024); stop() } })
  const finish = (code: number) => {
    clearTimeout(timer); if (force) clearTimeout(force)
    options.signal?.removeEventListener('abort', stop)
    resolve({ code: stopped ? (options.signal?.aborted ? 130 : 124) : code, stdout, stderr: stopped ? `${stderr}\n${options.signal?.aborted ? '操作已取消' : 'SSH 超时或输出超限'}` : stderr })
  }
  child.on('error', e => { stderr = e.message; finish(127) })
  child.on('close', code => finish(code ?? 1))
  child.stdin.on('error', () => { /* Early SSH exits can close stdin before the script is sent. */ })
  child.stdin.end(options.stdin ?? '')
})

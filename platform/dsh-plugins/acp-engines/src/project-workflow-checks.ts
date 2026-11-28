import { spawn, type ChildProcess } from 'node:child_process'
import { engineEnv } from './registry.ts'
import { parseProjectChecks, type ProjectCheck, type ProjectCheckResult } from './project-workflow-model.ts'

export const PROJECT_CHECK_LIMITS = { outputBytes: 16 * 1024, defaultTimeoutMs: 5 * 60_000, killGraceMs: 500, reapTimeoutMs: 5000 } as const

/** Execute an explicitly configured check; only process evidence determines its result. */
export async function runProjectCheck(check: ProjectCheck, cwd: string, commit: string, signal: AbortSignal): Promise<ProjectCheckResult> {
  const configuration = parseProjectChecks([check])[0]!, startedAt = new Date().toISOString()
  const result = (state: ProjectCheckResult['state'], exitCode: number | null, output: string, truncated = false): ProjectCheckResult => ({
    ...configuration, state, exitCode, output, truncated, commit, startedAt, finishedAt: new Date().toISOString(),
  })
  if (signal.aborted) return result('cancelled', null, '[验收] 已取消，命令未启动。')
  const env = engineEnv({ id: 'project-check', label: '项目验收', protocol: 'acp', provider: 'project-check', commands: [] })
  return new Promise<ProjectCheckResult>((resolve, reject) => {
    const unix = process.platform !== 'win32'
    let child: ChildProcess, closed = false, settled = false, exitCode: number | null = null
    let state: ProjectCheckResult['state'] | undefined, stopping = false, treeStopped = false
    let captured = Buffer.alloc(0), truncated = false
    const notes: string[] = []
    let timeout: ReturnType<typeof setTimeout> | undefined, escalation: ReturnType<typeof setTimeout> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined, poll: ReturnType<typeof setInterval> | undefined
    const append = (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), remaining = PROJECT_CHECK_LIMITS.outputBytes - captured.length
      if (bytes.length > remaining) truncated = true
      if (remaining > 0) captured = Buffer.concat([captured, bytes.subarray(0, remaining)])
    }
    const output = () => {
      const suffix = notes.length ? Buffer.from(`\n[验收] ${notes.join('；')}`) : Buffer.alloc(0)
      const room = Math.max(0, PROJECT_CHECK_LIMITS.outputBytes - suffix.length)
      // Replacement characters for invalid child output may expand its byte size.
      const normalized = Buffer.from(new TextDecoder().decode(captured, { stream: truncated }))
      if (normalized.length > room) truncated = true
      const prefix = normalized.subarray(0, room)
      // Do not introduce broken UTF-8 when the byte limit cuts a code point.
      return new TextDecoder().decode(prefix, { stream: truncated }) + suffix.toString('utf8')
    }
    const cleanup = () => {
      clearTimeout(timeout); clearTimeout(escalation); clearTimeout(deadline); clearInterval(poll)
      signal.removeEventListener('abort', abort)
    }
    const finish = (error?: Error) => {
      if (settled) return
      settled = true; cleanup()
      if (error) reject(error)
      else { const text = output(); resolve(result(state ?? (exitCode === 0 ? 'passed' : 'failed'), exitCode, text, truncated)) }
    }
    const groupExists = () => {
      if (!child.pid) return false
      try { process.kill(-child.pid, 0); return true }
      catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
    }
    const signalGroup = (value: NodeJS.Signals) => {
      if (!child.pid) return
      try { process.kill(-child.pid, value) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') notes.push(`进程组 ${value} 失败：${String((error as Error).message).slice(0, 300)}`)
      }
    }
    const maybeFinish = () => {
      if (settled || !closed) return
      if (unix ? groupExists() : stopping && !treeStopped) return
      finish()
    }
    const stop = (next: 'failed' | 'cancelled', reason: string) => {
      if (settled || stopping) return
      stopping = true; state = next; notes.push(reason); clearTimeout(timeout)
      if (!child.pid) { treeStopped = true; maybeFinish(); return }
      if (unix) {
        signalGroup('SIGTERM')
        escalation = setTimeout(() => { if (!settled) signalGroup('SIGKILL') }, PROJECT_CHECK_LIMITS.killGraceMs)
      } else {
        // taskkill /T is the native Windows process-tree termination mechanism.
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { env, shell: false, windowsHide: true, stdio: 'ignore' })
        killer.once('error', error => finish(new Error(`无法确认验收进程树已停止：${error.message}`)))
        killer.once('close', code => {
          if (code !== 0) { finish(new Error(`无法确认验收进程树已停止：taskkill 退出码 ${code ?? 'null'}`)); return }
          treeStopped = true; maybeFinish()
        })
      }
      poll = setInterval(maybeFinish, 25)
      deadline = setTimeout(() => {
        if (unix) signalGroup('SIGKILL')
        if (closed && (unix ? !groupExists() : treeStopped)) { maybeFinish(); return }
        finish(new Error('无法确认验收进程树已停止，请检查运行进程；本次没有记为已取消或已完成。'))
      }, PROJECT_CHECK_LIMITS.reapTimeoutMs)
      maybeFinish()
    }
    const abort = () => stop('cancelled', '用户已取消，已请求停止验收进程树。')
    try { child = spawn(configuration.command, configuration.args, { cwd, env, shell: false, detached: unix, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (error) { notes.push(`命令启动失败：${String((error as Error).message).slice(0, 600)}`); state = 'failed'; finish(); return }
    child.stdout?.on('data', append); child.stderr?.on('data', append)
    child.once('error', error => { state = 'failed'; notes.push(`命令启动或运行失败：${error.message.slice(0, 600)}`) })
    child.once('exit', (code, exitSignal) => {
      exitCode = code
      if (!stopping && exitSignal) { state = 'failed'; notes.push(`命令被信号 ${exitSignal} 终止。`) }
      // A command that exits while its children still run is not a completed check.
      if (!stopping && unix && groupExists()) stop('failed', '命令退出后仍有后台子进程，已请求清理；验收未通过。')
    })
    child.once('close', (code, exitSignal) => {
      closed = true; exitCode = child.pid ? code : null
      if (!stopping && code !== 0 && !state) { state = 'failed'; notes.push(`命令退出码 ${code ?? 'null'}${exitSignal ? `，信号 ${exitSignal}` : ''}。`) }
      maybeFinish()
    })
    timeout = setTimeout(() => stop('failed', `命令超过 ${configuration.timeoutMs ?? PROJECT_CHECK_LIMITS.defaultTimeoutMs} 毫秒，已请求停止验收进程树。`), configuration.timeoutMs ?? PROJECT_CHECK_LIMITS.defaultTimeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
}

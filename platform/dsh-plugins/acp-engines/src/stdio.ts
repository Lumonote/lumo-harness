/**
 * stdio 传输：把子进程的 stdin/stdout 包成 MessageTransport（一行一条 JSON）。
 * stderr 只保留尾部若干 KB 供诊断，绝不当协议解析。
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'

import { LineDecoder, type JsonRpcMessage, type MessageTransport } from './jsonrpc.ts'

export interface SpawnSpec { bin: string; args: string[]; cwd: string; env: Record<string, string> }
export type Spawner = (bin: string, args: string[], options: SpawnOptions) => ChildProcess

const STDERR_TAIL = 16 * 1024

export interface StdioTransport extends MessageTransport { readonly pid: number | undefined; stderrTail(): string }

export function spawnStdioTransport(spec: SpawnSpec, spawner: Spawner = spawn): StdioTransport {
  const child = spawner(spec.bin, spec.args, { cwd: spec.cwd, env: spec.env, stdio: ['pipe', 'pipe', 'pipe'], detached: false, windowsHide: true })
  const listeners = new Set<(m: JsonRpcMessage) => void>()
  const closeListeners = new Set<(reason: string) => void>()
  let stderr = ''
  let closed = false
  const finish = (reason: string) => {
    if (closed) return
    closed = true
    for (const l of closeListeners) l(reason)
  }
  const decoder = new LineDecoder(line => {
    let message: JsonRpcMessage
    try { message = JSON.parse(line) as JsonRpcMessage } catch { return /* 非 JSON 行（引擎日志）忽略 */ }
    if (message === null || typeof message !== 'object') return
    for (const l of listeners) l(message)
  }, () => { stderr += '\n[acp-engines] 丢弃超限帧' })
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => decoder.push(chunk))
  child.stderr?.setEncoding('utf8')
  child.stderr?.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL) })
  child.on('error', error => finish(`spawn 失败：${error.message}`))
  child.on('exit', (code, signal) => finish(`进程退出 code=${code ?? 'null'} signal=${signal ?? 'null'}`))
  child.stdin?.on('error', () => { /* EPIPE：由 exit 事件收尾 */ })

  return {
    get pid() { return child.pid },
    stderrTail: () => stderr,
    send(message) {
      if (closed || !child.stdin?.writable) return
      child.stdin.write(`${JSON.stringify(message)}\n`)
    },
    onMessage(listener) { listeners.add(listener) },
    onClose(listener) { if (closed) listener('closed'); else closeListeners.add(listener) },
    close() {
      if (closed) return
      try { child.stdin?.end() } catch { /* 忽略 */ }
      // 先礼后兵：SIGTERM，3 秒后仍在则 SIGKILL
      try { child.kill('SIGTERM') } catch { /* 忽略 */ }
      const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) { try { child.kill('SIGKILL') } catch { /* 忽略 */ } } }, 3000)
      timer.unref?.()
    },
  }
}

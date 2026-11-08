import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export interface WindowsCuaTool { name: string; description?: string; inputSchema: Record<string, unknown>; outputSchema?: unknown }
export interface WindowsCuaCatalog { tools: WindowsCuaTool[] }
interface Pending { id: string; resolve(value: unknown): void; reject(reason: unknown): void }
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
}
interface RuntimeProcess { child: ChildProcessWithoutNullStreams; closed: Promise<void>; quiet: boolean; stopping: boolean; buffer: string; ready: Promise<WindowsCuaCatalog>; resolveReady(value: WindowsCuaCatalog): void; rejectReady(reason: unknown): void; pending?: Pending }
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
export function parseWindowsCatalog(value: unknown): WindowsCuaCatalog {
  if (!record(value) || !Array.isArray(value['tools']) || value['tools'].length === 0 || value['tools'].length > 128) throw Error('WINDOWS_CUA_INVALID_CATALOG')
  const names = new Set<string>()
  for (const tool of value['tools']) {
    if (!record(tool) || typeof tool['name'] !== 'string' || !/^[A-Za-z0-9_-]{1,45}$/u.test(tool['name']) || names.has(tool['name'])
      || !record(tool['inputSchema']) || (tool['description'] !== undefined && typeof tool['description'] !== 'string')) throw Error('WINDOWS_CUA_INVALID_CATALOG')
    names.add(tool['name'])
  }
  if (!names.has('check_permissions') || !names.has('get_window_state')) throw Error('WINDOWS_CUA_CAPABILITIES_MISSING')
  return value as unknown as WindowsCuaCatalog
}
export function windowsSupervisorPath(architecture = process.arch): string {
  if (!['x64', 'arm64'].includes(architecture)) throw Error('WINDOWS_CUA_ARCHITECTURE_REQUIRED')
  const directory = new URL(`../native/bin/win32-${architecture}/`, import.meta.url)
  const executable = fileURLToPath(new URL('lumo-cua-supervisor.exe', directory))
  const receipt: unknown = JSON.parse(readFileSync(new URL('receipt.json', directory), 'utf8'))
  if (!record(receipt) || receipt['version'] !== 1 || receipt['architecture'] !== architecture || typeof receipt['sha256'] !== 'string'
    || createHash('sha256').update(readFileSync(executable)).digest('hex') !== receipt['sha256']) throw Error('WINDOWS_CUA_SUPERVISOR_INVALID')
  return executable
}
export interface WindowsRuntimeOptions { spawnWorker?(): ChildProcessWithoutNullStreams; cleanupTimeoutMs?: number; startupTimeoutMs?: number }

/** A cancellation settles only after the supervisor has acknowledged zero job members and exited. */
export class WindowsCuaRuntime {
  private current?: RuntimeProcess
  private catalogDigest?: string
  private sequence = 0
  private sessionId?: string
  private disposed = false
  private quarantineReason?: string
  private readonly spawnWorker: () => ChildProcessWithoutNullStreams
  readonly cleanupTimeoutMs: number
  readonly startupTimeoutMs: number
  constructor(options: WindowsRuntimeOptions = {}) {
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000
    this.startupTimeoutMs = options.startupTimeoutMs ?? 20_000
    this.spawnWorker = options.spawnWorker ?? (() => {
      if (process.platform !== 'win32') throw Error('WINDOWS_CUA_PLATFORM_REQUIRED')
      const extension = import.meta.url.endsWith('.ts') ? 'ts' : 'js'
      return spawn(windowsSupervisorPath(), [String(process.pid), process.execPath, fileURLToPath(new URL(`./windows-worker.${extension}`, import.meta.url))], {
        windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
      })
    })
  }
  get quarantined(): boolean { return this.quarantineReason !== undefined }
  private quarantine(code: string): void { this.quarantineReason ??= code }
  private async boot(): Promise<RuntimeProcess> {
    if (this.disposed || this.quarantined) throw Error(this.quarantineReason ?? 'WINDOWS_CUA_DISPOSED')
    if (this.current) { await this.current.ready; return this.current }
    const child = this.spawnWorker()
    const readiness = deferred<WindowsCuaCatalog>()
    const closure = deferred<void>()
    const runtime: RuntimeProcess = { child, closed: closure.promise, quiet: false, stopping: false, buffer: '', ready: readiness.promise, resolveReady: readiness.resolve, rejectReady: readiness.reject }
    this.current = runtime
    runtime.ready.catch(() => {})
    const startup = setTimeout(() => { this.quarantine('WINDOWS_CUA_STARTUP_TIMEOUT'); void this.stop(runtime) }, this.startupTimeoutMs)
    startup.unref()
    runtime.ready.finally(() => clearTimeout(startup)).catch(() => {})
    child.stdin.on('error', () => { this.quarantine('WINDOWS_CUA_PIPE_FAILED'); void this.stop(runtime) })
    child.stderr.resume() // Native diagnostics can contain application data; never log them into shared audit.
    child.on('error', () => { this.quarantine('WINDOWS_CUA_SPAWN_FAILED'); runtime.rejectReady(Error('WINDOWS_CUA_SPAWN_FAILED')) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (data: string) => {
      runtime.buffer += data
      if (Buffer.byteLength(runtime.buffer) > 64 * 1024 * 1024) { this.quarantine('WINDOWS_CUA_OUTPUT_LIMIT'); void this.stop(runtime); return }
      let newline: number
      while ((newline = runtime.buffer.indexOf('\n')) >= 0) {
        const line = runtime.buffer.slice(0, newline); runtime.buffer = runtime.buffer.slice(newline + 1)
        try {
          const message: unknown = JSON.parse(line)
          if (!record(message)) throw Error('WINDOWS_CUA_INVALID_PROTOCOL')
          if (message['supervisor'] === 'quiet') { runtime.quiet = true; continue }
          if (runtime.stopping) continue
          if (message['kind'] === 'catalog') {
            const catalog = parseWindowsCatalog(message['value'])
            const digest = createHash('sha256').update(JSON.stringify(catalog)).digest('hex')
            if (this.catalogDigest !== undefined && this.catalogDigest !== digest) throw Error('WINDOWS_CUA_CATALOG_CHANGED')
            this.catalogDigest = digest; runtime.resolveReady(catalog)
          } else if ((message['kind'] === 'result' || message['kind'] === 'error') && message['id'] === runtime.pending?.id) {
            const pending = runtime.pending!; delete runtime.pending
            if (message['kind'] === 'result') pending.resolve(message['value'])
            else pending.reject(Error('WINDOWS_CUA_CALL_FAILED'))
          } else throw Error('WINDOWS_CUA_INVALID_PROTOCOL')
        } catch { this.quarantine('WINDOWS_CUA_INVALID_PROTOCOL'); void this.stop(runtime) }
      }
    })
    child.on('close', code => {
      clearTimeout(startup)
      if (!runtime.stopping || !runtime.quiet || code !== 0) this.quarantine('WINDOWS_CUA_CLEANUP_UNCONFIRMED')
      runtime.rejectReady(Error(this.quarantineReason ?? 'WINDOWS_CUA_STOPPED'))
      // A crashed supervisor cannot attest that its job is empty. Keep the
      // dispatch unresolved (and its desktop lock held) until Host restart.
      if (!runtime.quiet || code !== 0) return
      runtime.pending?.reject(Error(this.quarantineReason ?? 'WINDOWS_CUA_CANCELLED'))
      delete runtime.pending
      if (this.current === runtime) delete this.current
      closure.resolve()
    })
    await runtime.ready
    return runtime
  }
  async catalog(): Promise<WindowsCuaCatalog> { return await (await this.boot()).ready }
  async call(name: string, args: unknown, signal: AbortSignal, sessionId?: string): Promise<unknown> {
    signal.throwIfAborted()
    if (name === 'check_permissions' && (!record(args) || args['prompt'] !== false)) throw Error('WINDOWS_CUA_PASSIVE_PERMISSIONS_REQUIRED')
    if (sessionId !== undefined && this.sessionId !== undefined && this.sessionId !== sessionId && this.current) await this.stop(this.current)
    if (sessionId !== undefined) this.sessionId = sessionId
    const runtime = await this.boot()
    signal.throwIfAborted()
    if (runtime.stopping || runtime.pending) throw Error('WINDOWS_CUA_BUSY')
    const catalog = await runtime.ready
    if (!catalog.tools.some(tool => tool.name === name)) throw Error('WINDOWS_CUA_UNKNOWN_TOOL')
    const response = deferred<unknown>()
    const id = String(++this.sequence)
    runtime.pending = { id, resolve: response.resolve, reject: response.reject }
    const abort = (): void => { void this.stop(runtime) }
    signal.addEventListener('abort', abort, { once: true })
    try {
      const message = `${JSON.stringify({ id, name, args })}\n`
      if (Buffer.byteLength(message) > 1024 * 1024) { delete runtime.pending; throw Error('WINDOWS_CUA_INPUT_LIMIT') }
      runtime.child.stdin.write(message)
      if (signal.aborted) abort()
      const result = await response.promise
      if (signal.aborted) await this.stop(runtime)
      signal.throwIfAborted()
      return result
    } catch (error) {
      if (signal.aborted || runtime.stopping) await this.stop(runtime)
      throw error
    } finally { signal.removeEventListener('abort', abort) }
  }
  private async stop(runtime: RuntimeProcess): Promise<void> {
    if (!runtime.stopping) {
      runtime.stopping = true
      // The supervisor owns this command. It terminates the job, not just a cancelled SDK Future.
      runtime.child.stdin.write('{"supervisor":"stop"}\n')
      const deadline = setTimeout(() => { this.quarantine('WINDOWS_CUA_CLEANUP_TIMEOUT') }, this.cleanupTimeoutMs)
      deadline.unref()
      void runtime.closed.finally(() => clearTimeout(deadline))
    }
    // Intentionally no Promise.race timeout: an unconfirmed backend retains the desktop lease.
    await runtime.closed
  }
  async drain(): Promise<void> { if (this.current) await this.stop(this.current) }
  async dispose(): Promise<void> { this.disposed = true; await this.drain() }
}

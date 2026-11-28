import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CLI_RECIPES, CLI_VERSION, RELEASE_ID, type CliInstallation, type CliInstallJob, type CliToolView } from './cli-install-catalog.ts'
import { installCli, installedCommand, type CliCommand, type CliInstaller } from './cli-install-runner.ts'

interface State { version: 1; installation?: CliInstallation; job?: CliInstallJob }
const now = () => new Date().toISOString()
const running = (job?: CliInstallJob) => job?.status === 'running'
export function cleanInstallLog(text: string): string {
  return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/gu, '').replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/giu, '$1[redacted]@')
    .replace(/((?:token|api[_-]?key|authorization|password)\s*[:=]\s*)\S+/giu, '$1[redacted]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/gu, '').slice(-24_000)
}

/** One local installation service is shared by the catalog, conversations and Bot workflows. */
export class ManagedCliTools {
  readonly root: string
  private readonly states = new Map<string, State>()
  private active: { engineId: string; controller: AbortController; done: Promise<void> } | undefined
  private disposed = false
  constructor(root: string, private readonly options: { install?: CliInstaller; freeSpace?: (path: string) => number; platform?: NodeJS.Platform } = {}) {
    this.root = resolve(root)
  }
  private recipe(id: string) { return CLI_RECIPES.find(recipe => recipe.engineId === id) }
  private supported(id: string): string | undefined {
    const recipe = this.recipe(id), platform = this.options.platform ?? process.platform
    if (!recipe) return id === 'workbuddy' ? 'WorkBuddy 随桌面应用提供；安装应用后重新检测。' : '此工具尚未提供受管在线安装方式；可检测本机已有 CLI。'
    if (recipe.method === 'trae' && !['darwin', 'linux'].includes(platform)) return 'TRAE 在线安装目前支持 macOS 和 Linux。'
    return undefined
  }
  private directory(id: string, releaseId: string): string { return join(this.root, id, 'releases', releaseId) }
  private state(id: string): State {
    if (!this.recipe(id)) return { version: 1 }
    const cached = this.states.get(id)
    if (cached) return cached
    let state: State = { version: 1 }
    const file = join(this.root, id, 'state.json')
    try {
      if (statSync(file).size > 64_000) throw new Error('CLI 安装记录过大')
      state = JSON.parse(readFileSync(file, 'utf8'))
      if (state.version !== 1 || (state.installation && (!RELEASE_ID.test(state.installation.releaseId) || !CLI_VERSION.test(state.installation.version)))
        || (state.job && (!RELEASE_ID.test(state.job.id) || !CLI_VERSION.test(state.job.requestedVersion) || typeof state.job.log !== 'string'
          || !['running', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(state.job.status)))) throw new Error('CLI 安装记录无效')
      if (running(state.job)) state = { ...state, job: { ...state.job!, status: 'interrupted', stage: '安装已中断', finishedAt: now(), error: '运行时已重启；请重试安装。已启用版本仍可使用。' } }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.states.set(id, state)
    return state
  }
  private save(id: string, state: State): void {
    const directory = join(this.root, id)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    const temp = join(directory, `${randomUUID()}.tmp`)
    try { writeFileSync(temp, JSON.stringify(state), { mode: 0o600, flag: 'wx' }); renameSync(temp, join(directory, 'state.json')) }
    finally { rmSync(temp, { force: true }) }
    this.states.set(id, state)
  }
  resolve(id: string): CliCommand | { error: string } | undefined {
    if (!this.recipe(id)) return undefined
    try {
      const entry = this.state(id).installation
      return entry ? installedCommand(this.recipe(id)!, this.directory(id, entry.releaseId)) : undefined
    } catch (error) { return { error: `受管 CLI 不可用：${error instanceof Error ? error.message : String(error)}` } }
  }
  view(id: string): CliToolView {
    const recipe = this.recipe(id), reason = this.supported(id), state = this.state(id), command = this.resolve(id)
    return { engineId: id, supported: !reason, ...(reason ? { reason } : {}), directory: join(this.root, id),
      source: recipe?.method === 'npm' ? `npm · ${recipe.packageName}` : recipe?.method === 'trae' ? 'TRAE 官方安装器' : '本机程序',
      ...(state.installation ? { installation: { ...state.installation } } : {}), ...(state.job ? { job: { ...state.job } } : {}),
      ...(command && !('error' in command) ? { executable: command.bin } : {}),
    }
  }
  private lock(): () => void {
    const directory = join(this.root, '.install-lock')
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    try { mkdirSync(directory, { mode: 0o700 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let pid: number
      try { pid = Number(readFileSync(join(directory, 'pid'), 'utf8')); if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error() }
      catch { throw new Error('安装锁记录不完整，请检查 CLI 管理目录后重试') }
      try { process.kill(pid, 0); throw new Error('已有运行时正在安装 CLI，请等待其完成') }
      catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure }
      rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { mode: 0o700 })
    }
    try { writeFileSync(join(directory, 'pid'), String(process.pid), { mode: 0o600, flag: 'wx' }) }
    catch (error) { rmSync(directory, { recursive: true, force: true }); throw error }
    return () => rmSync(directory, { recursive: true, force: true })
  }
  start(id: string, input: { requestId: string; action: 'install' | 'reinstall'; version: string }): CliToolView {
    if (this.disposed) throw new Error('运行时正在关闭')
    const recipe = this.recipe(id), reason = this.supported(id)
    if (!recipe || reason) throw new Error(reason ?? '不支持此工具的在线安装')
    if (!RELEASE_ID.test(input.requestId) || !CLI_VERSION.test(input.version) || !['install', 'reinstall'].includes(input.action)) throw new TypeError('安装请求或版本无效')
    const state = this.state(id)
    if (state.job?.id === input.requestId) {
      if (state.job.action !== input.action || state.job.requestedVersion !== input.version) throw new Error('重复请求的安装参数不一致')
      return this.view(id)
    }
    if (this.active) throw new Error('已有 CLI 正在安装，请等待完成或取消')
    const unlock = this.lock(), controller = new AbortController()
    const job: CliInstallJob = { id: input.requestId, action: input.action, requestedVersion: input.version, status: 'running', stage: '检查空间', startedAt: now(), log: '' }
    try { this.save(id, { ...state, job }) } catch (error) { unlock(); throw error }
    // Defer execution until active is set, including synchronous preflight failures.
    const done = Promise.resolve().then(async () => {
      const directory = this.directory(id, job.id)
      let activated = false, created = false
      const progress = (stage: string, text = '') => {
        controller.signal.throwIfAborted()
        job.stage = stage; job.log = cleanInstallLog(job.log + text)
        this.save(id, { ...state, job: { ...job } })
      }
      try {
        const fs = statfsSync(this.root)
        const free = this.options.freeSpace?.(this.root) ?? fs.bavail * fs.bsize
        if (free < recipe.minimumSpace) throw new Error(`磁盘空间不足：可用 ${(free / 1024 ** 3).toFixed(1)} GB，安装至少需要 ${recipe.minimumSpace / 1024 ** 3} GB。释放空间后可在此重试。`)
        mkdirSync(join(this.root, id, 'releases'), { recursive: true, mode: 0o700 })
        // A replay of an older request ID must never overwrite or remove a live release.
        mkdirSync(directory, { mode: 0o700 }); created = true
        const version = await (this.options.install ?? installCli)({ recipe, directory, version: input.version, signal: controller.signal, progress })
        controller.signal.throwIfAborted()
        if (!CLI_VERSION.test(version) || version === 'latest') throw new Error('安装未返回有效版本')
        installedCommand(recipe, directory)
        job.status = 'succeeded'; job.stage = '安装完成'; job.finishedAt = now()
        this.save(id, { version: 1, installation: { releaseId: job.id, version, installedAt: now() }, job: { ...job } })
        activated = true
      } catch (error) {
        job.status = controller.signal.aborted ? 'cancelled' : 'failed'; job.stage = controller.signal.aborted ? '已取消' : '安装失败'; job.finishedAt = now()
        job.error = cleanInstallLog(error instanceof Error ? error.message : String(error))
        try { this.save(id, { ...state, job: { ...job } }) }
        catch { this.states.set(id, { ...state, job: { ...job, error: `${job.error}；安装记录保存失败，请检查磁盘。` } }) }
      } finally {
        // Never remove an activated or previous release: existing sessions may still use it.
        if (!activated && created) { try { rmSync(directory, { recursive: true, force: true }) } catch { /* retry is isolated in a fresh directory */ } }
        try { unlock() } catch { /* stale PID lock is safely detected on the next start */ }
        this.active = undefined
      }
    })
    this.active = { engineId: id, controller, done }
    return this.view(id)
  }
  cancel(id: string, jobId: string): CliToolView {
    if (this.state(id).job?.id !== jobId) throw new Error('安装任务已变化，请刷新后重试')
    if (this.active?.engineId === id) this.active.controller.abort(new Error('用户取消安装'))
    return this.view(id)
  }
  async idle(): Promise<void> { await this.active?.done }
  dispose(): void { this.disposed = true; this.active?.controller.abort(new Error('运行时关闭，安装已取消')) }
}

/**
 * 远端机器 SSH 一键接入后端（P1）。独立文件，index.ts 只做两行接入。
 *
 *   - 主机记录：`.lumo/remote-hosts.json`（只存地址/端口/用户/认证**引用**，永不存私钥明文）；
 *   - SSH 执行：spawn 本机 `ssh`（参数数组、无 shell），BatchMode、StrictHostKeyChecking=yes（已钉指纹）
 *     或 accept-new（首次，写入独立 known_hosts）；远端脚本 `platform/tools/remote/lumo-remote.sh` 经 stdin 送达；
 *   - 高风险操作（install/upgrade/rollback/tunnel）先创建 P0-1 Ask（kind=approval, source.kind='run'），
 *     批准后才执行；全过程写入 P0-3 运行树（run 节点 + ask.pending/resolved）；
 *   - 隧道：`ssh -N -L 127.0.0.1:<local>:127.0.0.1:<remote>`；远端已装 frpc 且配置了 LUMO_REMOTE_FRPC=1 时改走 frpc；
 *   - 隧道建好后登记为设备 `remote:<hostId>`（本机设备表 + 运行树），集群形态下由注册中心接入另行完成。
 *
 * 开关：LUMO_REMOTE_HOSTS=off 关闭（路由回 404）；仅 local 部署形态启用。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { bundleBaseUrl, findLocalBundle, incomingDir, runScp, scpArgs } from './remote-bundle.ts'
import { APPROVAL_OPTIONS, transition, type Ask, type AskStatus } from '../../../shared/seam-contracts/asks.ts'
import type { RunTreeEvent } from '../../../shared/seam-contracts/run-tree.ts'
import {
  HIGH_RISK_OPERATIONS, installBlockers, normalizeHostInput, parseProbeOutput, remoteAskTitle, remoteDeviceId, remoteRunEvent, remoteRunId,
  remoteScriptArgs, shellQuote, upgradeVerdict, type ReleaseTarget, type RemoteHost, type RemoteOperation,
} from '../../../shared/seam-contracts/remote-hosts.ts'

export const REMOTE_PREFIX = '/lumo/api/remote-hosts'
const HOST_ID = /^[A-Za-z0-9_-]{12,40}$/u
const ASK_TTL_MS = 15 * 60_000

export function remoteHostsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.LUMO_REMOTE_HOSTS ?? '').trim().toLowerCase()
  return !(v === 'off' || v === '0' || v === 'false')
}

/** 执行器抽象：测试注入假实现，生产用本机 ssh。 */
export interface SshRunner {
  run(host: RemoteHost, args: string[], options: { stdin?: string; timeoutMs?: number; identity?: string }): Promise<{ code: number; stdout: string; stderr: string }>
  forward(host: RemoteHost, localPort: number, remotePort: number, options: { identity?: string }): { pid?: number; close(): void; done: Promise<number> }
}

/** Vault 引用由调用方解析成**本机临时私钥文件路径**（不落平台存储）；未配置即拒绝。 */
export type VaultResolver = (ref: string) => Promise<string>

export interface RunTreeSink { apply(event: RunTreeEvent): unknown }

export interface RemoteHostsOptions {
  file: string
  target: ReleaseTarget
  runTree?: RunTreeSink
  runner?: SshRunner
  vault?: VaultResolver
  knownHostsFile?: string
  bundleUrl?: (target: ReleaseTarget, host: RemoteHost) => string | undefined
  /** 离线推送：安装前把本机服务端包 scp 到远端 R/incoming/，返回包 sha256（远端据此强制校验）。见 remote-bundle.ts */
  prepareBundle?: (target: ReleaseTarget, host: RemoteHost, runner: SshRunner, identity?: string) => Promise<{ sha256: string } | undefined>
  scriptPath?: string
  now?: () => number
  identity?: { userId: string; realm: string }
}

interface PendingOp { ask: Ask; hostId: string; op: RemoteOperation; opId: string; timer?: ReturnType<typeof setTimeout> }

export function defaultScriptPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../tools/remote/lumo-remote.sh')
}

/** 读取 platform/dsh-pin.json + platform/package.json，保证远端与本地同版本、同 dsh pin。 */
export function localReleaseTarget(platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')): ReleaseTarget {
  const pin = JSON.parse(readFileSync(join(platformRoot, 'dsh-pin.json'), 'utf8')) as { sha: string; tag: string }
  const pkg = JSON.parse(readFileSync(join(platformRoot, 'package.json'), 'utf8')) as { version: string }
  return { version: pkg.version, dshSha: pin.sha, dshTag: pin.tag }
}

export function sshBaseArgs(host: RemoteHost, knownHostsFile: string, identity?: string): string[] {
  const args = ['-p', String(host.port), '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'ServerAliveInterval=15',
    '-o', `UserKnownHostsFile=${knownHostsFile}`, '-o', `StrictHostKeyChecking=${host.hostKeyFingerprint ? 'yes' : 'accept-new'}`,
    '-o', 'PasswordAuthentication=no', '-o', 'KbdInteractiveAuthentication=no']
  if (identity) args.push('-o', 'IdentitiesOnly=yes', '-i', identity)
  args.push('--', `${host.user}@${host.address}`)
  return args
}

export function createSshRunner(knownHostsFile: string): SshRunner {
  return {
    run(host, args, options) {
      return new Promise(done => {
        const child = spawn('ssh', [...sshBaseArgs(host, knownHostsFile, options.identity), ...args.map(a => /^[A-Za-z0-9_.\/:=@-]+$/u.test(a) ? a : shellQuote(a))], { stdio: ['pipe', 'pipe', 'pipe'] })
        let stdout = '', stderr = ''
        const timer = setTimeout(() => child.kill('SIGTERM'), options.timeoutMs ?? 120_000)
        child.stdout.on('data', d => { stdout += String(d) }); child.stderr.on('data', d => { stderr += String(d) })
        child.on('error', e => { clearTimeout(timer); done({ code: 127, stdout, stderr: e.message }) })
        child.on('close', code => { clearTimeout(timer); done({ code: code ?? 1, stdout, stderr }) })
        child.stdin.end(options.stdin ?? '')
      })
    },
    forward(host, localPort, remotePort, options) {
      const base = sshBaseArgs(host, knownHostsFile, options.identity)
      const at = base.indexOf('--')
      const child: ChildProcess = spawn('ssh', [...base.slice(0, at), '-N', '-o', 'ExitOnForwardFailure=yes', '-L', `127.0.0.1:${localPort}:127.0.0.1:${remotePort}`, ...base.slice(at)], { stdio: 'ignore' })
      const done = new Promise<number>(r => { child.on('close', c => r(c ?? 1)); child.on('error', () => r(127)) })
      return { ...(child.pid ? { pid: child.pid } : {}), close: () => { child.kill('SIGTERM') }, done }
    },
  }
}

function expandHome(path: string): string { return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path }

export class RemoteHostsService {
  private hosts: RemoteHost[] = []
  private readonly pending = new Map<string, PendingOp>()
  private readonly history = new Map<string, Ask>()
  private readonly tunnels = new Map<string, { close(): void }>()
  private readonly running = new Set<string>()
  private readonly runner: SshRunner
  private readonly now: () => number
  private seq = 0

  constructor(private readonly options: RemoteHostsOptions) {
    this.now = options.now ?? Date.now
    this.runner = options.runner ?? createSshRunner(options.knownHostsFile ?? join(dirname(options.file), 'remote-known_hosts'))
    if (existsSync(options.file)) {
      try { this.hosts = (JSON.parse(readFileSync(options.file, 'utf8')) as { hosts?: RemoteHost[] }).hosts ?? [] } catch { this.hosts = [] }
    }
  }

  get target(): ReleaseTarget { return this.options.target }
  list(): RemoteHost[] { return this.hosts.map(h => ({ ...h })) }
  get(id: string): RemoteHost | undefined { return this.hosts.find(h => h.id === id) }
  asks(): Ask[] { return [...this.history.values()] }

  create(input: unknown): { ok: true; host: RemoteHost } | { ok: false; error: string } {
    const r = normalizeHostInput(input)
    if (!r.ok) return r
    if (this.hosts.some(h => h.address === r.value.address && h.port === r.value.port && h.user === r.value.user)) return { ok: false, error: '该主机已录入' }
    const at = new Date(this.now()).toISOString()
    const host: RemoteHost = { id: randomBytes(12).toString('base64url'), ...r.value, state: 'registered', createdAt: at, updatedAt: at }
    this.hosts.push(host); this.save()
    return { ok: true, host }
  }

  remove(id: string): boolean {
    const before = this.hosts.length
    this.tunnels.get(id)?.close(); this.tunnels.delete(id)
    this.hosts = this.hosts.filter(h => h.id !== id)
    for (const [askId, p] of this.pending) if (p.hostId === id) this.finish(askId, 'cancel', 'system')
    if (this.hosts.length !== before) { this.save(); return true }
    return false
  }

  /** 连通性 + 环境探测（只读，不需要 Ask）。 */
  async probe(id: string): Promise<RemoteHost> {
    const host = this.mustGet(id)
    const identity = await this.identity(host)
    const result = await this.runner.run(host, ['sh', '-s', '--', ...remoteScriptArgs('probe', host)], { stdin: this.script(), timeoutMs: 30_000, ...(identity ? { identity } : {}) })
    if (result.code !== 0) return this.update(id, { state: 'failed', lastError: `探测失败（${result.code}）：${redact(result.stderr)}` })
    const probe = parseProbeOutput(result.stdout, new Date(this.now()).toISOString())
    return this.update(id, { probe, state: probe.installed ? 'installed' : 'probed', lastError: undefined as unknown as string })
  }

  /** 版本检查：给出 verdict；自动升级开关打开时直接发起升级申请（仍要 Ask）。 */
  async checkVersion(id: string): Promise<{ verdict: ReturnType<typeof upgradeVerdict>; ask?: Ask }> {
    const host = await this.probe(id)
    const verdict = upgradeVerdict(host.probe?.installed ?? null, this.target)
    if (host.autoUpgrade && (verdict === 'upgrade' || verdict === 'dsh-mismatch')) {
      const r = this.request(id, 'upgrade')
      if (r.ok) return { verdict, ask: r.ask }
    }
    return { verdict }
  }

  /** 高风险操作：创建 Ask 并登记运行树；批准后才执行。 */
  request(id: string, op: RemoteOperation): { ok: true; ask: Ask } | { ok: false; error: string } {
    if (!HIGH_RISK_OPERATIONS.includes(op)) return { ok: false, error: '未知操作' }
    const host = this.get(id)
    if (!host) return { ok: false, error: '主机不存在' }
    if (this.running.has(id)) return { ok: false, error: '该主机有操作正在执行' }
    if ([...this.pending.values()].some(p => p.hostId === id && p.op === op)) return { ok: false, error: '已有待审批的同类操作' }
    if (op === 'install' || op === 'upgrade') {
      if (!host.probe) return { ok: false, error: '请先探测环境' }
      const blockers = installBlockers(host.probe)
      if (blockers.length) return { ok: false, error: blockers.join('；') }
      if (op === 'upgrade' && !host.probe.installed) return { ok: false, error: '尚未安装，请用一键安装' }
    }
    if (op === 'tunnel' && !host.probe?.installed) return { ok: false, error: '尚未安装 lumo 服务端' }
    const opId = `${++this.seq}-${randomBytes(4).toString('hex')}`
    const created = new Date(this.now())
    const runId = remoteRunId(id, op, opId)
    const target = op === 'install' || op === 'upgrade' ? this.target : undefined
    const ask: Ask = {
      id: `run:remote-${opId}`, kind: 'approval', status: 'pending', realm: this.options.identity?.realm ?? '',
      title: remoteAskTitle(host, op, target),
      detail: op === 'tunnel' ? '将建立 SSH 本地端口转发并把该机器登记为设备。' : '将通过 SSH 在远端执行安装脚本；失败自动回滚到上一个版本。',
      options: APPROVAL_OPTIONS, source: { kind: 'run', ref: opId, run_id: runId, operation: `remote.${op}` },
      requester_user_id: this.options.identity?.userId ?? '', created_at: created.toISOString(), expires_at: new Date(created.getTime() + ASK_TTL_MS).toISOString(),
    }
    const entry: PendingOp = { ask, hostId: id, op, opId }
    entry.timer = setTimeout(() => this.finish(ask.id, 'expire', 'system'), ASK_TTL_MS); entry.timer.unref?.()
    this.pending.set(ask.id, entry); this.history.set(ask.id, ask)
    this.emit(remoteRunEvent(host, op, opId, 'pending', undefined, created.toISOString()))
    this.emit({ type: 'ask.pending', askId: ask.id, runId })
    return { ok: true, ask }
  }

  /** 回答 Ask：approve → 执行；reject → 运行节点 cancelled。执行在后台进行，返回 Ask 终态。 */
  answer(askId: string, value: string, by: string): { ok: boolean; error?: string; ask?: Ask; done?: Promise<void> } {
    const entry = this.pending.get(askId)
    if (!entry) return { ok: false, error: this.history.has(askId) ? 'ask 已结束' : 'ask 不存在' }
    if (value !== 'approve' && value !== 'reject') return { ok: false, error: '无效选项' }
    if (entry.ask.requester_user_id !== '' && entry.ask.requester_user_id !== by) return { ok: false, error: '只有发起人可以批准此操作' }
    const ask = this.finish(askId, value === 'approve' ? 'answer' : 'reject', by, value)
    if (!ask) return { ok: false, error: 'ask 已结束' }
    if (value === 'reject') return { ok: true, ask }
    return { ok: true, ask, done: this.execute(entry) }
  }

  closeTunnel(id: string): boolean {
    const t = this.tunnels.get(id)
    if (!t) return false
    t.close(); this.tunnels.delete(id)
    const host = this.get(id)
    if (host?.tunnel) this.update(id, { tunnel: { ...host.tunnel, status: 'down' }, state: 'installed' })
    return true
  }

  closeAll(): void { for (const id of [...this.tunnels.keys()]) this.closeTunnel(id) }

  private async execute(entry: PendingOp): Promise<void> {
    const { hostId, op, opId } = entry
    const host = this.mustGet(hostId)
    this.running.add(hostId)
    this.emit(remoteRunEvent(host, op, opId, 'running'))
    try {
      const identity = await this.identity(host)
      if (op === 'tunnel') { await this.openTunnel(host, identity); this.emit(remoteRunEvent(host, op, opId, 'succeeded', `设备 ${remoteDeviceId(hostId)} 已在线`)); return }
      this.update(hostId, { state: op === 'install' ? 'installing' : 'upgrading' })
      const target = op === 'rollback' ? undefined : this.target
      const bundle = target ? this.options.bundleUrl?.(target, host) : undefined
      const pushed = target && this.options.prepareBundle ? await this.options.prepareBundle(target, host, this.runner, identity) : undefined
      const extra = pushed ? ['--bundle-sha256', pushed.sha256] : []
      // 可重试：网络类失败（255 = ssh 连接错误）重试 2 次；脚本本身幂等（同 release 目录直接复用）
      let result = { code: 1, stdout: '', stderr: '' }
      for (let attempt = 0; attempt < 3; attempt++) {
        result = await this.runner.run(host, ['sh', '-s', '--', ...remoteScriptArgs(op, host, target, bundle), ...extra], { stdin: this.script(), timeoutMs: 15 * 60_000, ...(identity ? { identity } : {}) })
        if (result.code !== 255) break
      }
      if (result.code !== 0) {
        const msg = `${redact(result.stderr) || '远端脚本失败'}${/result=rolled-back/u.test(result.stdout) ? '（已回滚到上一个版本）' : ''}`
        this.update(hostId, { state: 'failed', lastError: msg })
        this.emit(remoteRunEvent(host, op, opId, 'failed', msg)); return
      }
      const refreshed = await this.probe(hostId)
      this.emit(remoteRunEvent(refreshed, op, opId, 'succeeded', /result=already-installed/u.test(result.stdout) ? '已是目标版本（幂等跳过）' : result.stdout.match(/release=(\S+)/u)?.[1]))
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      this.update(hostId, { state: 'failed', lastError: msg })
      this.emit(remoteRunEvent(host, op, opId, 'failed', msg))
    } finally { this.running.delete(hostId) }
  }

  private async openTunnel(host: RemoteHost, identity: string | undefined): Promise<void> {
    this.tunnels.get(host.id)?.close()
    const remotePort = Number(process.env.LUMO_REMOTE_PORT ?? 7420)
    const localPort = 20000 + (parseInt(host.id.replace(/[^0-9a-f]/giu, '').slice(0, 4) || '0', 16) % 20000)
    const t = this.runner.forward(host, localPort, remotePort, identity ? { identity } : {})
    this.tunnels.set(host.id, t)
    void t.done.then(() => { if (this.tunnels.get(host.id) === t) { this.tunnels.delete(host.id); const h = this.get(host.id); if (h?.tunnel) this.update(host.id, { tunnel: { ...h.tunnel, status: 'down' } }) } })
    this.update(host.id, { state: 'connected', deviceId: remoteDeviceId(host.id), tunnel: { mode: 'ssh-local-forward', localPort, remotePort, status: 'up', ...(t.pid ? { pid: t.pid } : {}) } })
  }

  private async identity(host: RemoteHost): Promise<string | undefined> {
    if (host.auth.kind === 'agent') return undefined
    if (host.auth.kind === 'key-file') return expandHome(host.auth.path)
    if (!this.options.vault) throw new Error('未配置 Vault，无法解析私钥引用')
    return this.options.vault(host.auth.ref)
  }

  private finish(askId: string, action: 'answer' | 'reject' | 'expire' | 'cancel', by: string, value?: string): Ask | undefined {
    const entry = this.pending.get(askId)
    if (!entry) return undefined
    const { next, ok } = transition(entry.ask.status, action)
    if (!ok) return undefined
    this.pending.delete(askId)
    if (entry.timer) clearTimeout(entry.timer)
    const ask: Ask = { ...entry.ask, status: next as AskStatus, ...(value ? { answer: { value, answered_by: by, answered_at: new Date(this.now()).toISOString() } } : {}) }
    this.history.set(askId, ask)
    const runId = remoteRunId(entry.hostId, entry.op, entry.opId)
    this.emit({ type: 'ask.resolved', askId, runId })
    const host = this.get(entry.hostId)
    if (next !== 'answered' && host) this.emit(remoteRunEvent(host, entry.op, entry.opId, 'cancelled', next === 'rejected' ? '审批被拒绝' : next === 'expired' ? '审批超时' : '已撤回'))
    return ask
  }

  private script(): string { return readFileSync(this.options.scriptPath ?? defaultScriptPath(), 'utf8') }
  private emit(event: RunTreeEvent): void { try { this.options.runTree?.apply(event) } catch { /* 运行树故障不影响操作 */ } }
  private mustGet(id: string): RemoteHost { const h = this.get(id); if (!h) throw new Error('主机不存在'); return h }

  private update(id: string, patch: Partial<RemoteHost>): RemoteHost {
    const i = this.hosts.findIndex(h => h.id === id)
    if (i < 0) throw new Error('主机不存在')
    const next: RemoteHost = { ...this.hosts[i]!, ...patch, updatedAt: new Date(this.now()).toISOString() }
    if (patch.lastError === undefined && 'lastError' in patch) delete next.lastError
    this.hosts[i] = next; this.save()
    return next
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.options.file), { recursive: true })
      const tmp = `${this.options.file}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ hosts: this.hosts }, null, 2), { mode: 0o600 })
      renameSync(tmp, this.options.file)
    } catch { /* 持久化失败不影响内存状态 */ }
  }
}

/** 错误输出脱敏：去掉疑似私钥/令牌片段并截断。 */
export function redact(text: string): string {
  return text.replace(/-----BEGIN[\s\S]*?-----END[^-]*-----/gu, '[redacted-key]').replace(/(token|password|secret)=\S+/giu, '$1=[redacted]').trim().slice(0, 500)
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(JSON.stringify(body))
}

export interface RemoteRouteDeps { readBody: (req: IncomingMessage) => Promise<Buffer>; userId: string }

/** 处理了返回 true。service 为 undefined（非 local 或开关关闭）时回 404。 */
export async function handleRemoteHostsRoute(req: IncomingMessage, res: ServerResponse, pathname: string, service: RemoteHostsService | undefined, deps: RemoteRouteDeps): Promise<boolean> {
  if (pathname !== REMOTE_PREFIX && !pathname.startsWith(`${REMOTE_PREFIX}/`)) return false
  if (!service) { json(res, 404, { error: 'remote_hosts_disabled' }); return true }
  const method = req.method ?? 'GET'
  const body = async (): Promise<unknown> => {
    const text = (await deps.readBody(req)).toString('utf8')
    return text === '' ? {} : JSON.parse(text)
  }
  try {
    if (pathname === REMOTE_PREFIX) {
      if (method === 'GET') { json(res, 200, { hosts: service.list(), target: service.target }); return true }
      if (method === 'POST') { const r = service.create(await body()); json(res, r.ok ? 201 : 400, r.ok ? { host: r.host } : { error: r.error }); return true }
      json(res, 405, { error: 'method_not_allowed' }); return true
    }
    if (pathname === `${REMOTE_PREFIX}/asks` && method === 'GET') { json(res, 200, { asks: service.asks() }); return true }
    const ans = /^\/lumo\/api\/remote-hosts\/asks\/(run:remote-[A-Za-z0-9-]{1,40})\/answer$/u.exec(pathname)
    if (ans && method === 'POST') {
      const input = await body() as { value?: unknown }
      const r = service.answer(ans[1]!, String(input.value ?? ''), deps.userId)
      json(res, r.ok ? 200 : 409, r.ok ? { ask: r.ask } : { error: r.error }); return true
    }
    const m = /^\/lumo\/api\/remote-hosts\/([A-Za-z0-9_-]+)(?:\/(probe|version|install|upgrade|rollback|tunnel|tunnel\/close))?$/u.exec(pathname)
    if (!m || !HOST_ID.test(m[1]!)) { json(res, 404, { error: 'unknown_remote_host_route' }); return true }
    const [, id, action] = m
    if (!action && method === 'DELETE') { json(res, service.remove(id!) ? 200 : 404, {}); return true }
    if (!action && method === 'GET') { const h = service.get(id!); json(res, h ? 200 : 404, h ? { host: h } : { error: '主机不存在' }); return true }
    if (method !== 'POST' || !action) { json(res, 405, { error: 'method_not_allowed' }); return true }
    if (!service.get(id!)) { json(res, 404, { error: '主机不存在' }); return true }
    if (action === 'probe') { json(res, 200, { host: await service.probe(id!) }); return true }
    if (action === 'version') { json(res, 200, await service.checkVersion(id!)); return true }
    if (action === 'tunnel/close') { json(res, service.closeTunnel(id!) ? 200 : 409, {}); return true }
    const r = service.request(id!, action as RemoteOperation)
    json(res, r.ok ? 202 : 409, r.ok ? { ask: r.ask } : { error: r.error }); return true
  } catch (error) {
    json(res, error instanceof SyntaxError ? 400 : 500, { error: error instanceof Error ? redact(error.message) : 'remote host error' }); return true
  }
}

/** index.ts 接入用的工厂：非 local 或开关关闭返回 undefined。 */
export function createRemoteHosts(options: { local: boolean; stateDir: string; runTree?: RunTreeSink; identity?: { userId: string; realm: string }; env?: NodeJS.ProcessEnv }): RemoteHostsService | undefined {
  if (!options.local || !remoteHostsEnabled(options.env)) return undefined
  let target: ReleaseTarget
  try { target = localReleaseTarget() } catch { return undefined }
  const env = options.env ?? process.env
  const knownHostsFile = join(options.stateDir, 'remote-known_hosts')
  return new RemoteHostsService({
    file: join(options.stateDir, 'remote-hosts.json'), target,
    ...(options.runTree ? { runTree: options.runTree } : {}), ...(options.identity ? { identity: options.identity } : {}),
    knownHostsFile,
    // 在线：发布目录（远端拼 lumo-server-<V>-<os>-<arch>.tar.gz 并按 SHA256SUMS 校验）；离线：LUMO_REMOTE_BUNDLE_DIR 下的包经 scp 推送
    bundleUrl: (t: ReleaseTarget) => bundleBaseUrl(t, env),
    prepareBundle: async (t, h, runner, identity) => {
      const local = await findLocalBundle(env.LUMO_REMOTE_BUNDLE_DIR, t, h)
      if (!local) return undefined
      const dest = incomingDir(h.installRoot)
      const mk = await runner.run(h, ['mkdir', '-p', dest], { timeoutMs: 30_000, ...(identity ? { identity } : {}) })
      if (mk.code !== 0) throw new Error(`创建远端 incoming 目录失败：${redact(mk.stderr)}`)
      const r = await runScp(scpArgs(sshBaseArgs(h, knownHostsFile, identity), [local.file, `${local.file}.sha256`], dest))
      if (r.code !== 0) throw new Error(`scp 推送安装包失败（${r.code}）：${redact(r.stderr)}`)
      return { sha256: local.sha256 }
    },
  })
}

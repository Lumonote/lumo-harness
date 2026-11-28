/**
 * 远端机器 SSH 一键接入契约（P1：SSH remote）。
 *
 * 流程：录入主机 → 连通性/环境探测 → 一键安装 lumo 服务端（与本地同版本、同 dsh pin）
 *       → 版本检查/升级/回滚 → 建立隧道 → 打开远端工作台；集群设备注册由接入流程另行完成。
 * 借鉴 gugu `electron/server/ssh-*.ts` + `ssh-install/*` + `tunnel-*.ts` 的分步思路，实现是纯函数 + 小的执行器。
 *
 * 安全约束：
 *   - 平台**从不保存私钥明文**。认证只允许 ssh-agent、本机私钥文件路径、或 Vault 引用（由本机解析，不落盘）。
 *   - 录入时若检测到 PEM/OpenSSH 私钥内容，直接拒绝。
 *   - 安装、升级、回滚、建立隧道都是高风险步骤，必须先经过 P0-1 统一 Ask 批准，并登记到 P0-3 运行树。
 */
import type { RunTreeEvent, RunTreeStatus } from './run-tree.ts'

export type RemoteAuth =
  | { kind: 'agent' }
  | { kind: 'key-file'; path: string }
  | { kind: 'vault'; ref: string }

export interface RemoteHostInput {
  name: string
  address: string
  port?: number
  user: string
  auth: RemoteAuth
  /** 已知主机指纹（SHA256:...），连接前实际验证。不填时首次连接用 accept-new，后续沿用独立 known_hosts。 */
  hostKeyFingerprint?: string
  /** 远端安装根目录；默认 `~/.lumo-remote`。 */
  installRoot?: string
  autoUpgrade?: boolean
}

export interface RemoteProbe {
  os: string
  arch: string
  kernel?: string
  deps: Record<string, string | null>
  installed?: { version: string; dshSha: string } | null
  probedAt: string
}

export interface RemoteTunnel {
  mode: 'ssh-local-forward' | 'frpc'
  localPort: number
  remotePort: number
  status: 'starting' | 'up' | 'down'
  pid?: number
}

export type RemoteHostState = 'registered' | 'probed' | 'installing' | 'installed' | 'upgrading' | 'failed' | 'connecting' | 'connected'

export interface RemoteHost {
  id: string
  name: string
  address: string
  port: number
  user: string
  auth: RemoteAuth
  hostKeyFingerprint?: string
  installRoot: string
  autoUpgrade: boolean
  state: RemoteHostState
  probe?: RemoteProbe
  tunnel?: RemoteTunnel
  deviceId?: string
  lastError?: string
  createdAt: string
  updatedAt: string
}

export interface ReleaseTarget { version: string; dshSha: string; dshTag: string }

export type RemoteOperation = 'install' | 'upgrade' | 'rollback' | 'tunnel'
export const HIGH_RISK_OPERATIONS: readonly RemoteOperation[] = ['install', 'upgrade', 'rollback', 'tunnel']

export const REMOTE_HOST_ROUTES = {
  list: 'GET /lumo/api/remote-hosts',
  create: 'POST /lumo/api/remote-hosts',
  remove: 'DELETE /lumo/api/remote-hosts/{id}',
  probe: 'POST /lumo/api/remote-hosts/{id}/probe',
  request: 'POST /lumo/api/remote-hosts/{id}/{install|upgrade|rollback|tunnel}',
  asks: 'GET /lumo/api/remote-hosts/asks',
  answer: 'POST /lumo/api/remote-hosts/asks/{id}/answer',
  untunnel: 'POST /lumo/api/remote-hosts/{id}/tunnel/close',
} as const

const NAME = /^[\p{L}\p{N} ._-]{1,64}$/u
const USER = /^[a-z_][a-z0-9_.-]{0,31}$/iu
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu
const IPV4 = /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/u
const IPV6 = /^[0-9a-f:]{2,39}$/iu
const VAULT_REF = /^vault:[A-Za-z0-9/_.-]{1,200}#[A-Za-z0-9_.-]{1,64}$/u
const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}=?$/u
const INSTALL_ROOT = /^(?:~\/|\/)[A-Za-z0-9._/-]{1,200}$/u
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----|PuTTY-User-Key-File|b3BlbnNzaC1rZXktdjE/u

export function containsPrivateKey(value: unknown): boolean {
  return JSON.stringify(value ?? null).match(PRIVATE_KEY) !== null
}

export function validHostAddress(address: string): boolean {
  if (address.startsWith('-')) return false
  return IPV4.test(address) || (address.includes(':') && IPV6.test(address)) || HOST.test(address)
}

/** 校验并规范化录入；返回错误字符串或规范化结果。任何私钥内容一律拒绝。 */
export function normalizeHostInput(input: unknown): { ok: true; value: Required<Omit<RemoteHostInput, 'hostKeyFingerprint'>> & { hostKeyFingerprint?: string } } | { ok: false; error: string } {
  if (containsPrivateKey(input)) return { ok: false, error: '不接受私钥内容；请改用 ssh-agent、本机私钥路径或 Vault 引用' }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: '无效输入' }
  const v = input as Record<string, unknown>
  const name = typeof v.name === 'string' ? v.name.trim() : ''
  const address = typeof v.address === 'string' ? v.address.trim() : ''
  const user = typeof v.user === 'string' ? v.user.trim() : ''
  const port = v.port === undefined ? 22 : Number(v.port)
  if (!NAME.test(name)) return { ok: false, error: '名称无效' }
  if (!validHostAddress(address)) return { ok: false, error: '地址无效' }
  if (!USER.test(user)) return { ok: false, error: '用户名无效' }
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, error: '端口无效' }
  const auth = normalizeAuth(v.auth)
  if (typeof auth === 'string') return { ok: false, error: auth }
  const installRoot = v.installRoot === undefined || v.installRoot === '' ? '~/.lumo-remote' : String(v.installRoot)
  if (!INSTALL_ROOT.test(installRoot) || installRoot.includes('..')) return { ok: false, error: '安装目录无效' }
  let hostKeyFingerprint: string | undefined
  if (v.hostKeyFingerprint !== undefined && v.hostKeyFingerprint !== '') {
    if (typeof v.hostKeyFingerprint !== 'string' || !FINGERPRINT.test(v.hostKeyFingerprint)) return { ok: false, error: '主机指纹格式应为 SHA256:…' }
    hostKeyFingerprint = v.hostKeyFingerprint
  }
  return { ok: true, value: { name, address, port, user, auth, installRoot, autoUpgrade: v.autoUpgrade === true, ...(hostKeyFingerprint ? { hostKeyFingerprint } : {}) } }
}

function normalizeAuth(raw: unknown): RemoteAuth | string {
  if (!raw || typeof raw !== 'object') return '认证方式无效'
  const a = raw as Record<string, unknown>
  if (a.kind === 'agent') return { kind: 'agent' }
  if (a.kind === 'key-file') {
    const path = typeof a.path === 'string' ? a.path.trim() : ''
    if (!/^(?:~\/|\/)[^\0\n]{1,400}$/u.test(path) || path.includes('..')) return '私钥路径必须是本机绝对路径或 ~/ 开头'
    return { kind: 'key-file', path }
  }
  if (a.kind === 'vault') {
    const ref = typeof a.ref === 'string' ? a.ref.trim() : ''
    if (!VAULT_REF.test(ref)) return 'Vault 引用格式应为 vault:<path>#<field>'
    return { kind: 'vault', ref }
  }
  return '认证方式只支持 agent / key-file / vault'
}

/** 远端脚本 `probe` 子命令输出的 key=value 行 → RemoteProbe。未知键忽略。 */
export function parseProbeOutput(text: string, now = new Date().toISOString()): RemoteProbe {
  const kv: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const m = /^([a-z_.]+)=(.*)$/u.exec(line.trim())
    if (m) kv[m[1]!] = m[2]!
  }
  const deps: Record<string, string | null> = {}
  for (const [k, val] of Object.entries(kv)) if (k.startsWith('dep.')) deps[k.slice(4)] = val === '' || val === 'missing' ? null : val
  const installed = kv['installed.version'] ? { version: kv['installed.version'], dshSha: kv['installed.dsh'] ?? '' } : null
  return { os: (kv.os ?? 'unknown').toLowerCase(), arch: normalizeArch(kv.arch ?? 'unknown'), ...(kv.kernel ? { kernel: kv.kernel } : {}), deps, installed, probedAt: now }
}

export function normalizeArch(arch: string): string {
  const a = arch.toLowerCase()
  if (a === 'x86_64' || a === 'amd64') return 'x64'
  if (a === 'aarch64' || a === 'arm64') return 'arm64'
  return a
}

export const REQUIRED_DEPS = ['node', 'tar', 'curl'] as const
export const SUPPORTED_PLATFORMS: readonly string[] = ['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64']

/** 安装前置检查：平台受支持、依赖齐全、node 主版本满足 ^22.19 || >=24。 */
export function installBlockers(probe: RemoteProbe): string[] {
  const out: string[] = []
  if (!SUPPORTED_PLATFORMS.includes(`${probe.os}-${probe.arch}`)) out.push(`不支持的平台 ${probe.os}-${probe.arch}`)
  for (const dep of REQUIRED_DEPS) if (!probe.deps[dep]) out.push(`缺少依赖 ${dep}`)
  const node = probe.deps.node
  if (node) {
    const m = /^v?(\d+)\.(\d+)/u.exec(node)
    const major = m ? Number(m[1]) : 0, minor = m ? Number(m[2]) : 0
    if (!(major >= 24 || (major === 22 && minor >= 19))) out.push(`node 版本过低 ${node}（需要 ^22.19 或 >=24）`)
  }
  return out
}

export function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/u, '').split(/[.-]/u), pb = b.replace(/^v/u, '').split(/[.-]/u)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? '0', y = pb[i] ?? '0'
    const nx = Number(x), ny = Number(y)
    const c = Number.isFinite(nx) && Number.isFinite(ny) ? nx - ny : x.localeCompare(y)
    if (c !== 0) return c > 0 ? 1 : -1
  }
  return 0
}

export type UpgradeVerdict = 'not-installed' | 'up-to-date' | 'upgrade' | 'dsh-mismatch' | 'remote-newer'

/** 版本判定：版本相同但 dsh pin 不同也需要重装（同 pin 是硬约束）。 */
export function upgradeVerdict(installed: RemoteProbe['installed'], target: ReleaseTarget): UpgradeVerdict {
  if (!installed) return 'not-installed'
  const c = compareVersions(installed.version, target.version)
  if (c > 0) return 'remote-newer'
  if (c < 0) return 'upgrade'
  return installed.dshSha === target.dshSha ? 'up-to-date' : 'dsh-mismatch'
}

/** 发布物目录名：版本 + dsh pin 前 12 位，保证同一目录只对应一个组合（幂等的基础）。 */
export function releaseId(target: ReleaseTarget): string { return `${target.version}-${target.dshSha.slice(0, 12)}` }

export function shellQuote(value: string): string { return `'${value.replace(/'/gu, `'\\''`)}'` }

/** 远端脚本的调用参数（脚本经 stdin 送达，`sh -s -- <args>`，不在远端落临时文件之外的东西）。 */
export function remoteScriptArgs(op: 'probe' | 'install' | 'upgrade' | 'rollback' | 'status', host: Pick<RemoteHost, 'installRoot'>, target?: ReleaseTarget, bundleUrl?: string): string[] {
  const args = [op, '--root', host.installRoot]
  if (target && (op === 'install' || op === 'upgrade')) {
    args.push('--version', target.version, '--dsh-sha', target.dshSha, '--dsh-tag', target.dshTag)
    if (bundleUrl) args.push('--bundle-url', bundleUrl)
  }
  return args
}

export function remoteRunId(hostId: string, op: RemoteOperation, opId: string): string { return `remote-${op}-${hostId}-${opId}` }

/** 高风险操作在运行树上的事件（不扩展 run-tree 契约，只用 node.upsert / ask.*）。 */
export function remoteRunEvent(host: Pick<RemoteHost, 'id' | 'name'>, op: RemoteOperation, opId: string, status: RunTreeStatus, detail?: string, at = new Date().toISOString()): RunTreeEvent {
  const terminal = status === 'succeeded' || status === 'failed' || status === 'cancelled'
  return { type: 'node.upsert', node: {
    id: `run:${remoteRunId(host.id, op, opId)}`, kind: 'run', status, title: `远端${OP_LABEL[op]}：${host.name}`, agent: 'remote-ssh',
    ...(status === 'pending' ? { startedAt: at } : {}), ...(terminal ? { endedAt: at } : {}), ...(detail ? { detail } : {}),
  } }
}

export const OP_LABEL: Record<RemoteOperation, string> = { install: '安装', upgrade: '升级', rollback: '回滚', tunnel: '建立隧道' }

export function remoteAskTitle(host: Pick<RemoteHost, 'name' | 'user' | 'address' | 'port'>, op: RemoteOperation, target?: ReleaseTarget): string {
  const where = `${host.user}@${host.address}:${host.port}`
  return target ? `远端${OP_LABEL[op]} lumo ${target.version}（dsh ${target.dshTag}）→ ${host.name}（${where}）` : `远端${OP_LABEL[op]} → ${host.name}（${where}）`
}

/** SSH 接入记录的稳定 ID；该标识本身不代表已注册到分布式调度器。 */
export function remoteDeviceId(hostId: string): string { return `remote:${hostId}` }

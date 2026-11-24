/**
 * 引擎注册表：每个 Agent 引擎怎么启动（命令、参数、环境）、走哪种协议、怎么探测能力。
 *
 * - `acp`：引擎本身（或官方适配器）说 ACP，直接 stdio JSON-RPC。
 * - `codex-app-server`：Codex 只有 `codex app-server`（自有 JSON-RPC），由 codex-bridge.ts 转成 ACP。
 *
 * 命令解析只在宿主侧做；注册表下发给浏览器时去掉路径与环境（见 publicEngine）。
 * 可执行文件查找沿用桌面端 dev_agents.rs 的约定目录（~/.local/bin、Homebrew、NVM、Codex.app）。
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'

export type EngineProtocol = 'acp' | 'codex-app-server'

export interface EngineDefinition {
  id: string
  label: string
  protocol: EngineProtocol
  /** 候选命令，按序尝试；首个能找到的生效 */
  commands: Array<{ bin: string; args: string[]; requiredFile?: string }>
  /** 额外环境变量（不覆盖宿主已有同名变量，除非 overrideEnv） */
  env?: Record<string, string>
  /** 从宿主环境里剔除的变量（如把桌面端 PG/Redis 地址挡在引擎外） */
  envRemove?: string[]
  /** 子 Agent 树上显示的 provider 名 */
  provider: string
  /** 引擎需要的登录方式说明，探测失败时提示 */
  authHint?: string
}

const workBuddyCLI = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli'

function cliEngine(id: string, label: string, bin: string, args: string[]): EngineDefinition {
  return { id, label, provider: id, protocol: 'acp', commands: [{ bin, args }] }
}

export const BUILTIN_ENGINES: readonly EngineDefinition[] = [
  {
    id: 'claude-code', label: 'Claude Code', protocol: 'acp', provider: 'claude-code',
    // Zed 维护的官方 ACP 适配器；全局安装时是 claude-code-acp，否则用 npx 拉起
    commands: [
      { bin: 'claude-code-acp', args: [] },
      { bin: 'claude-agent-acp', args: [] },
      { bin: 'npx', args: ['-y', '@zed-industries/claude-code-acp'] },
    ],
    authHint: '需要先在终端执行 claude 完成登录，或设置 ANTHROPIC_API_KEY',
  },
  {
    id: 'codex', label: 'Codex', protocol: 'codex-app-server', provider: 'codex',
    commands: [{ bin: 'codex', args: ['app-server'] }],
    authHint: '需要先执行 codex login',
  },
  {
    id: 'codex-acp', label: 'Codex（ACP 适配器）', protocol: 'acp', provider: 'codex',
    commands: [{ bin: 'codex-acp', args: [] }],
    authHint: '需要先执行 codex login',
  },
  {
    id: 'gemini', label: 'Gemini CLI', protocol: 'acp', provider: 'gemini',
    commands: [{ bin: 'gemini', args: ['--experimental-acp'] }],
    authHint: '需要先在终端执行 gemini 完成登录',
  },
  {
    id: 'workbuddy', label: 'WorkBuddy', protocol: 'acp', provider: 'workbuddy',
    commands: [{ bin: `${workBuddyCLI}/bin/codebuddy`, args: ['--acp'], requiredFile: `${workBuddyCLI}/dist/codebuddy-lite-wb.mjs` }],
    env: { CODEBUDDY_FORCE_LITE_WB_BUNDLE: '1' },
    authHint: '需要当前引擎宿主安装含 ACP 入口的 macOS WorkBuddy',
  },
  cliEngine('codebuddy', 'Tencent CodeBuddy Code', 'codebuddy', ['--acp']),
  cliEngine('trae', 'TRAE CLI', 'traecli', ['--acp']),
  cliEngine('kiro', 'Kiro CLI', 'kiro-cli', ['acp']),
  cliEngine('github-copilot', 'GitHub Copilot CLI', 'copilot', ['--acp', '--stdio']),
  cliEngine('opencode', 'OpenCode', 'opencode', ['acp']),
  cliEngine('qwen-code', 'Qwen Code', 'qwen', ['--acp']),
]

export const ENGINE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u

export interface ResolvedEngine { definition: EngineDefinition; bin: string; args: string[] }

export interface EngineProbe {
  id: string
  label: string
  protocol: EngineProtocol
  available: boolean
  /** 不可用原因（未安装 / 被配置禁用） */
  reason?: string
  /** 握手后得到的能力；未握手时为空 */
  capabilities?: { loadSession: boolean; image: boolean; embeddedContext: boolean; mcpHttp: boolean }
  agentVersion?: string
  authHint?: string
}

export interface LookupOptions { pathEnv?: string; home?: string; extraDirs?: string[]; isExecutable?: (file: string) => boolean; isFile?: (file: string) => boolean }

function isRegularFile(file: string): boolean {
  try { return statSync(file).isFile() } catch { return false }
}

function defaultExecutable(file: string): boolean {
  try { const s = statSync(file); return s.isFile() && (process.platform === 'win32' || (s.mode & 0o111) !== 0) } catch { return false }
}

/** 与 dev_agents.rs::installed 同一套目录顺序，再补 PATH。 */
export function searchDirs(bin: string, options: LookupOptions = {}): string[] {
  const dirs: string[] = []
  const home = options.home ?? process.env.HOME
  if (home && isAbsolute(home)) {
    dirs.push(join(home, '.local/bin'))
  }
  dirs.push('/opt/homebrew/bin', '/usr/local/bin')
  if (home && isAbsolute(home)) {
    const root = join(home, '.nvm/versions/node')
    try {
      const versions = readdirSync(root).filter(v => /^v\d+\.\d+\.\d+$/u.test(v))
        .sort((a, b) => compareVersion(b.slice(1), a.slice(1)))
      for (const v of versions) dirs.push(join(root, v, 'bin'))
    } catch { /* 无 NVM */ }
  }
  if (bin === 'codex' || bin === 'codex-acp') {
    dirs.push('/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS', '/Applications/Codex.app/Contents/Resources')
  }
  for (const d of (options.pathEnv ?? process.env.PATH ?? '').split(delimiter)) if (d && isAbsolute(d)) dirs.push(d)
  dirs.push(...(options.extraDirs ?? []))
  return [...new Set(dirs)]
}

function compareVersion(a: string, b: string): number {
  const pa = a.split('.').map(Number); const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  return 0
}

export function findExecutable(bin: string, options: LookupOptions = {}): string | undefined {
  const check = options.isExecutable ?? defaultExecutable
  if (isAbsolute(bin)) return check(bin) ? bin : undefined
  if (bin.includes('/') || bin.includes('\\')) return undefined
  for (const dir of searchDirs(bin, options)) {
    const file = join(dir, bin)
    if (check(file)) return file
  }
  return undefined
}

export class EngineRegistry {
  private readonly engines = new Map<string, EngineDefinition>()
  constructor(definitions: readonly EngineDefinition[] = BUILTIN_ENGINES, private readonly disabled: ReadonlySet<string> = new Set(), private readonly lookup: LookupOptions = {}) {
    for (const d of definitions) this.register(d)
  }
  register(definition: EngineDefinition): void {
    if (!ENGINE_ID.test(definition.id)) throw new Error(`非法引擎 id：${definition.id}`)
    if (definition.commands.length === 0) throw new Error(`引擎 ${definition.id} 没有候选命令`)
    this.engines.set(definition.id, definition)
  }
  list(): EngineDefinition[] { return [...this.engines.values()] }
  get(id: string): EngineDefinition | undefined { return this.engines.get(id) }

  resolve(id: string): ResolvedEngine | { error: string } {
    const definition = this.engines.get(id)
    if (definition === undefined) return { error: `未知引擎：${id}` }
    if (this.disabled.has(id)) return { error: `引擎 ${id} 已被配置禁用` }
    for (const c of definition.commands) {
      if (c.requiredFile && !(this.lookup.isFile ?? isRegularFile)(c.requiredFile)) continue
      const bin = findExecutable(c.bin, this.lookup)
      if (bin) return { definition, bin, args: [...c.args] }
    }
    return { error: `未找到 ${definition.label} 的启动入口（${definition.commands.map(c => c.requiredFile ? definition.label : c.bin).join(' / ')}）` }
  }

  /** 静态探测：只看可执行文件是否存在；握手探测由 EngineHost.probe 做 */
  probeStatic(): EngineProbe[] {
    return this.list().map(d => {
      const r = this.resolve(d.id)
      return { id: d.id, label: d.label, protocol: d.protocol, available: !('error' in r), ...('error' in r ? { reason: r.error } : {}), ...(d.authHint ? { authHint: d.authHint } : {}) }
    })
  }
}

/** 构造子进程环境：继承宿主 → 删 envRemove → 合并 env。 */
export function engineEnv(definition: EngineDefinition, base: NodeJS.ProcessEnv = process.env, binDir?: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(base)) if (typeof v === 'string') env[k] = v
  for (const k of DEFAULT_ENV_REMOVE) delete env[k]
  for (const k of definition.envRemove ?? []) delete env[k]
  Object.assign(env, definition.env ?? {})
  if (binDir) env.PATH = env.PATH ? `${binDir}${delimiter}${env.PATH}` : binDir
  return env
}

/** 平台内部的中间件凭据不进引擎（与桌面端 spawn worker 时的 env_remove 一致）。 */
export const DEFAULT_ENV_REMOVE = ['LUMO_PG_DSN', 'LUMO_REDIS_URL', 'LUMO_NACOS_ADDR', 'LUMO_MINIO_ENDPOINT', 'LUMO_CONNECTOR_GATEWAY_URL', 'LUMO_DESKTOP_HANDOFF_FILE']

export function exists(path: string): boolean { return existsSync(path) }

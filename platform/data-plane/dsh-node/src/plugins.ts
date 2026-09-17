import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { BASELINE_PLUGIN_PINS, PACKAGED_PROFILE_MODULES } from './generated/plugin-baseline.ts'
import { homedir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const PLATFORM_PLUGIN_MODULES = {
  agentTeams: '@lumo/agent-teams',
  attachments: '@lumo/attachments',
  connector: '@lumo/connector',
  control: '@lumo/control',
  jobControl: '@lumo/job-control',
  knowledge: '@lumo/knowledge',
  platformUi: '@lumo/dsh-platform-ui',
  mailbox: '@lumo/mailbox',
  metering: '@lumo/metering',
  objectStore: '@lumo/object-store',
  openDesign: '@lumo/open-design',
  archify: '@lumo/archify',
  creativeSkills: '@lumo/creative-skills',
  rufloOrchestration: '@lumo/ruflo-orchestration',
  knowledgeVault: '@lumo/knowledge-vault',
  project: '@lumo/project',
  provenance: '@lumo/provenance',
  recovery: '@lumo/recovery',
  seamHost: '@lumo/seam-host',
  seamProxy: '@lumo/seam-proxy',
  sessionLog: '@lumo/session-log',
  // 这里**故意没有** sessionTitleGateway / `@lumo/session-title-gw`，不要加回来：
  // `dsh-plugins/session-title-gw` **不是插件** —— 没有 `src/`，`package.json` 也没有
  // `main`/`exports`，并且从未出现在 `index.ts` 的 loader 行里（那里没有解构这个键）。
  // 它只是一个**验证切片**（`__tests__/title-route.spec.ts`），证明「标题辅助调用经网关路由」
  // 是**纯 Config 事实**：上游 provider 的 `provider`/`model` 成对覆盖即可，`title` 零改动，
  // 因此不需要任何插件代码。
  //
  // 把它登记在这里的代价不是「多个无害条目」：`profilePluginSpecs()` 会遍历本表，
  // 于是每个 profile 都要 `dsh plugin add` 一个永远加载不了的包；而
  // `isOptionalProfilePlugin('@lumo/...')` 恒为 false，安装一旦失败就**直接抛错终止启动**
  // （可选插件才会降级为 warn）。登记它 = 给启动路径埋一个无条件失败的闸门。
  skillLocal: '@lumo/skill-local',
  storage: '@lumo/storage',
  subagentHost: '@lumo/subagent-host',
  subagentRemote: '@lumo/subagent-remote',
  userAuth: '@lumo/user-auth',
  webGateway: '@lumo/web-gateway',
  webFetchFakeIp: '@lumo/web-fetch-fakeip',
} as const

const PLATFORM_PLUGIN_DIRECTORIES: Record<keyof typeof PLATFORM_PLUGIN_MODULES, string> = {
  agentTeams: 'agent-teams',
  attachments: 'attachments',
  connector: 'connector',
  control: 'control',
  jobControl: 'job-control',
  knowledge: 'knowledge',
  platformUi: 'lumo-ui',
  mailbox: 'mailbox',
  metering: 'metering',
  objectStore: 'object-store',
  openDesign: 'open-design',
  archify: 'archify',
  creativeSkills: 'creative-skills',
  rufloOrchestration: 'ruflo-orchestration',
  knowledgeVault: 'knowledge-vault',
  project: 'project',
  provenance: 'provenance',
  recovery: 'recovery',
  seamHost: 'seam-host',
  seamProxy: 'seam-proxy',
  sessionLog: 'session-log',
  skillLocal: 'skill-local',
  storage: 'storage',
  subagentHost: 'subagent-host',
  subagentRemote: 'subagent-remote',
  userAuth: 'user-auth',
  webGateway: 'web-gateway',
  webFetchFakeIp: 'web-fetch-fakeip',
}

const WEB_COMMUNITY_PLUGINS = [
  { name: '@yejiming/dsh-data-agent', spec: '@yejiming/dsh-data-agent@0.1.3' },
] as const

/**
 * Pinned DSH community plugins that make up the Lumo desktop baseline.
 * They are installed into a profile for repository previews and copied into
 * the self-contained desktop runtime during packaging.  Pinning versions is
 * important here: a desktop build must not change behavior because a registry
 * tag moved after the installer was produced.
 *
 * 名单、版本与升版纪律的真相源是
 * platform/shared/manifests/plugin-baseline.manifest.json —— 包括为什么排除
 * `@anweat/dsh-browser`（仍 import dsh-settings 已移除的旧符号）与
 * `@nanmicoder/dsh-agent-teams`（调用 master 已移除的 registerContinuableSetup）。
 * 本文件只消费其生成物：改 pin = 改清单 + `pnpm run codegen:plugin-baseline`，
 * 不要在下面手工加条目（漂移锁会红）。
 */
export const BASE_PROFILE_PLUGINS: readonly ProfilePluginSpec[] = BASELINE_PLUGIN_PINS.map(
  pin => ({ name: pin.name, spec: pin.spec }),
)

export const OBSOLETE_PROFILE_PLUGINS = ['deepseek-harness-auth'] as const

/**
 * First-party packages are part of the platform contract. Everything else is
 * an independently versioned plugin and may be disabled when its loader
 * cannot be applied.
 */
export function isOptionalProfilePlugin(packageName: string): boolean {
  return !packageName.startsWith('@deepseek-ai/') && !packageName.startsWith('@lumo/')
}

/** Extract profile bundle names mentioned by a failed Loader composition. */
export function failedProfilePluginNames(stderr: string, candidates: readonly string[]): string[] {
  if (!/failed to apply loader entry|plugin tree failed|failed to resolve|err_module_not_found|cannot find (?:module|package)/iu.test(stderr)) return []
  const normalized = stderr.replaceAll('\\', '/')
  const loaderIds = [...stderr.matchAll(/failed to apply loader entry\s+([^\s(]+)/giu)]
    .map(match => match[1]?.replace(/[:;,]+$/gu, ''))
    .filter((id): id is string => id !== undefined)
  return candidates.filter(name => {
    if (!isOptionalProfilePlugin(name)) return false
    const shortName = name.split('/').pop() ?? name
    return normalized.includes(name) || loaderIds.includes(name) || loaderIds.includes(shortName)
  })
}

/** Package names of the pinned baseline: what a packaged runtime must mount as profile layers. */
export function baselineBundlePackages(): string[] {
  return BASE_PROFILE_PLUGINS.map(({ name }) => name)
}

/** Version the packaged runtime actually carries for one package, or undefined when absent. */
function readPackagedVersion(runtimeModules: string, name: string): string | undefined {
  try {
    const manifest = JSON.parse(readFileSync(resolve(runtimeModules, ...name.split('/'), 'package.json'), 'utf8')) as { version?: unknown }
    return typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : undefined
  } catch {
    return undefined
  }
}

/** Version pinned in {@link BASE_PROFILE_PLUGINS} for one baseline package, or undefined. */
function pinnedBaselineVersion(name: string): string | undefined {
  const spec = BASE_PROFILE_PLUGINS.find(plugin => plugin.name === name)?.spec
  if (spec === undefined) return undefined
  const at = spec.lastIndexOf('@')
  return at > 0 ? spec.slice(at + 1) : undefined
}

// 打包 runtime 下 dsh-node 把这份名单逐个 symlink 到 DSH_HOME/profiles/node_modules，
// 让 patch 里的裸包名（name: '@lumo/...'）能从 profile 目录按 Node 的父级上溯解析到。
// 名单 = 首方模块 + 基线包名，由 shared/manifests/plugin-baseline.manifest.json 拼装
// （生成物 ./generated/plugin-baseline.ts）——不要再手抄：漏加时 Loader 报
// Cannot find package，整个插件树挂载失败。

export interface ProfilePluginSpec {
  name: string
  spec: string
}

/** Package specs installed into a DSH profile before its Loader tree starts. */
export function profilePluginSpecs(profile: string, platformRoot: string, deploymentMode: 'local' | 'standalone' | 'cluster' = 'standalone'): ProfilePluginSpec[] {
  const local = Object.entries(PLATFORM_PLUGIN_MODULES).map(([key, name]) => ({
    name,
    spec: `link:${resolve(platformRoot, 'dsh-plugins', PLATFORM_PLUGIN_DIRECTORIES[key as keyof typeof PLATFORM_PLUGIN_MODULES])}`,
  }))
  if (deploymentMode === 'local') {
    // local 模式的知识源是 Vault（sqlite+FTS5），不是需要 PG 的 @lumo/knowledge 接缝。
    // 本名单同时是 packagedFirstParty 清单的来源：打包 runtime 只 symlink 这些模块。
    const localOnly = new Set(['@lumo/agent-teams', '@lumo/dsh-platform-ui', '@lumo/knowledge-vault', '@lumo/open-design', '@lumo/archify', '@lumo/creative-skills', '@lumo/ruflo-orchestration', '@lumo/skill-local', '@lumo/web-fetch-fakeip'])
    return [
      ...local.filter(({ name }) => localOnly.has(name)),
      ...BASE_PROFILE_PLUGINS,
    ]
  }
  return profile === 'web'
    ? [...local, ...BASE_PROFILE_PLUGINS, ...WEB_COMMUNITY_PLUGINS]
    : [...local, ...BASE_PROFILE_PLUGINS]
}

export function missingProfilePluginSpecs(
  desired: ProfilePluginSpec[],
  installed: Record<string, string>,
): ProfilePluginSpec[] {
  return desired.filter(({ name }) => installed[name] === undefined)
}

export function obsoleteProfilePluginNames(profile: string, installed: Record<string, string>): string[] {
  if (profile !== 'web') return []
  return OBSOLETE_PROFILE_PLUGINS.filter(name => installed[name] !== undefined)
}

function profileDependencies(profile: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const dshHome = env['DSH_HOME'] ?? resolve(homedir(), '.dsh')
  const manifest = resolve(dshHome, 'profiles', profile, 'package.json')
  if (!existsSync(manifest)) return {}
  const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { dependencies?: Record<string, string> }
  return parsed.dependencies ?? {}
}

/**
 * Install package links through the official profile manager. The generated
 * Loader patch can then use stable package names instead of container paths.
 */
export function ensureProfilePlugins(options: {
  profile: string
  platformRoot: string
  dshRoot: string
  deploymentMode?: 'local' | 'standalone' | 'cluster'
  env?: NodeJS.ProcessEnv
}): void {
  const env = options.env ?? process.env
  if (env['LUMO_PACKAGED_RUNTIME'] === '1') {
    ensurePackagedProfileModules(options.profile, env)
    // Modules alone mount nothing: the baseline must also become bundle
    // layers, which is what `dsh plugin add` would have done outside a package.
    ensurePackagedBaselineBundles({ profile: options.profile, env })
    return
  }
  clearReintroducedPluginQuarantine(options.profile, env)
  if (env['LUMO_AUTO_INSTALL_PLUGINS'] === '0') return

  const installed = profileDependencies(options.profile, env)
  const obsolete = obsoleteProfilePluginNames(options.profile, installed)
  if (obsolete.length > 0) {
    console.log(`dsh-node: removing obsolete profile plugin(s): ${obsolete.join(', ')}`)
    let removed: ReturnType<typeof spawnSync> | undefined
    try {
      removed = runProfileManager(options, env, ['remove', ...obsolete])
    } catch (error: unknown) {
      console.warn(`dsh-node: obsolete plugin removal failed; continuing without blocking startup: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (removed !== undefined && (removed.error || removed.status !== 0)) {
      console.warn(
        `dsh-node: obsolete plugin removal failed; continuing without blocking startup: ${removed.error?.message ?? `exit ${removed.status ?? 'unknown'}`}`,
      )
    } else if (removed !== undefined) {
      for (const name of obsolete) delete installed[name]
    }
  }

  const missing = missingProfilePluginSpecs(
    profilePluginSpecs(options.profile, options.platformRoot, options.deploymentMode),
    installed,
  )
  if (missing.length === 0) return

  for (const plugin of missing) {
    console.log(`dsh-node: installing profile plugin ${plugin.name}`)
    let result: ReturnType<typeof spawnSync>
    try {
      result = runProfileManager(options, env, ['add', plugin.spec])
    } catch (error: unknown) {
      if (isOptionalProfilePlugin(plugin.name)) {
        console.warn(`dsh-node: optional plugin ${plugin.name} could not be installed; skipping: ${error instanceof Error ? error.message : String(error)}`)
        continue
      }
      throw error
    }
    if (result.error || result.status !== 0) {
      const detail = result.error?.message ?? `exit ${result.status ?? 'unknown'}`
      if (isOptionalProfilePlugin(plugin.name)) {
        console.warn(`dsh-node: optional plugin ${plugin.name} could not be installed; skipping: ${detail}`)
        continue
      }
      throw new Error(`dsh-node: profile plugin installation failed for ${plugin.name}: ${detail}`)
    }
  }
}

/**
 * A packaged runtime cannot invoke pnpm or create links back into the source
 * checkout. Keep the DSH profile's normal parent-walk resolution contract by
 * placing relative-to-the-app package links in its shared fallback directory.
 */
function ensurePackagedProfileModules(profile: string, env: NodeJS.ProcessEnv): void {
  const runtimeModules = env['LUMO_RUNTIME_NODE_MODULES']
  if (runtimeModules === undefined || runtimeModules.trim() === '') {
    throw new Error('dsh-node: packaged runtime is missing LUMO_RUNTIME_NODE_MODULES')
  }
  const dshHome = env['DSH_HOME'] ?? resolve(homedir(), '.dsh')
  const modulesDir = resolve(dshHome, 'profiles', 'node_modules')
  mkdirSync(modulesDir, { recursive: true })
  for (const name of PACKAGED_PROFILE_MODULES) {
    const target = resolve(runtimeModules, ...name.split('/'))
    if (!existsSync(resolve(target, 'package.json'))) {
      if (isOptionalProfilePlugin(name)) {
        console.warn(`dsh-node: optional plugin ${name} is absent from the packaged runtime; skipping`)
        continue
      }
      throw new Error(`dsh-node: packaged runtime is missing ${name}`)
    }
    linkPackagedModule(modulesDir, name, target, true)
  }
}

/**
 * Symlink one packaged runtime package into a profile `node_modules` directory.
 *
 * The shared fallback directory belongs to dsh-node alone, so a non-symlink
 * there is a hard error. Inside a profile pnpm owns the directory, and a real
 * package (for example one updated through the market) must win: the market
 * resolves presence and activation from `<profile>/node_modules`.
 */
function linkPackagedModule(linkDir: string, name: string, target: string, strict: boolean): void {
  const link = resolve(linkDir, ...name.split('/'))
  mkdirSync(resolve(link, '..'), { recursive: true })
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) {
      if (strict) throw new Error(`dsh-node: ${link} exists and is not a symlink`)
      return
    }
    if (readlinkSync(link) === target) return
    unlinkSync(link)
  }
  symlinkSync(target, link, 'junction')
}

/** Outcome of one {@link reconcileBaselineBundles} pass. */
export interface BaselineBundleReconciliation {
  /** The bundle list to persist (kept entries first, appended baseline last). */
  bundles: string[]
  /** Baseline packages this pass appended. */
  added: string[]
  /** Bundles this pass retired because the runtime stopped carrying them. */
  removed: string[]
  /** Baseline packages the app owns in this profile after the pass. */
  owned: string[]
}

/**
 * Merge the pinned baseline into one profile's `dsh.profile.bundles`.
 *
 * Membership, not ordering, is the whole contract: a bundle layer mounts its
 * package's own loader rows, so naming a package twice makes the Loader reject
 * the tree (`duplicate loader entry id`) and the app fails to boot. A package
 * the profile already carries — installed through the market, or added by
 * `dsh plugin add` — therefore keeps its single slot.
 *
 * Retirement is scoped to what the app added itself (`owned`): bundle
 * resolution is fail-loud, so a baseline package a newer build stops carrying
 * must leave the list, while a market-owned entry is never the app's to drop.
 */
export function reconcileBaselineBundles(options: {
  /** The profile's current `dsh.profile.bundles` list. */
  bundles: readonly string[]
  /** Baseline packages this runtime actually carries. */
  available: readonly string[]
  /** Baseline packages a previous pass appended to this profile. */
  owned: readonly string[]
}): BaselineBundleReconciliation {
  const { bundles, available, owned } = options
  const removed = owned.filter(name => !available.includes(name))
  const kept = bundles.filter(name => !removed.includes(name))
  const added = available.filter(name => !kept.includes(name))
  const ownedNames = [...new Set([...owned.filter(name => available.includes(name)), ...added])]
  return { bundles: [...kept, ...added], added, removed, owned: ownedNames }
}

/** Filename of the app-owned baseline record beside a profile manifest. */
const BASELINE_RECORD_FILENAME = '.lumo-baseline-bundles.json'
const QUARANTINE_RECORD_FILENAME = '.lumo-plugin-quarantine.json'

interface PluginQuarantineRecord {
  packages?: Record<string, { reason?: string; quarantinedAt?: string }>
}

function profileManifestPath(profile: string, env: NodeJS.ProcessEnv): string {
  const dshHome = env['DSH_HOME'] ?? resolve(homedir(), '.dsh')
  return resolve(dshHome, 'profiles', profile, 'package.json')
}

/** Read the bundle layer names currently configured for a profile. */
export function profileBundleNames(profile: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const manifestPath = profileManifestPath(profile, env)
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh?: { profile?: { bundles?: unknown } } }
    return Array.isArray(manifest.dsh?.profile?.bundles)
      ? manifest.dsh.profile.bundles.filter((name): name is string => typeof name === 'string')
      : []
  } catch {
    return []
  }
}

function profileQuarantinePath(profile: string, env: NodeJS.ProcessEnv): string {
  const dshHome = env['DSH_HOME'] ?? resolve(homedir(), '.dsh')
  return resolve(dshHome, 'profiles', profile, QUARANTINE_RECORD_FILENAME)
}

function readPluginQuarantine(path: string): Set<string> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as PluginQuarantineRecord
    return new Set(Object.keys(parsed.packages ?? {}))
  } catch {
    return new Set()
  }
}

function writePluginQuarantine(path: string, packages: Iterable<string>, reason = 'loader failed'): void {
  const entries = Object.fromEntries([...new Set(packages)].map(name => [name, {
    reason,
    quarantinedAt: new Date().toISOString(),
  }]))
  if (Object.keys(entries).length === 0) {
    rmSync(path, { force: true })
    return
  }
  mkdirSync(resolve(path, '..'), { recursive: true })
  writeFileSync(path, `${JSON.stringify({ packages: entries }, undefined, 2)}\n`)
}

/**
 * Remove failed optional bundles from a profile before retrying its boot.
 * Dependencies remain installed so the user can re-enable a fixed version;
 * only the composition layer is quarantined.
 */
export function quarantineProfilePlugins(options: {
  profile: string
  packages: readonly string[]
  reason?: string
  env?: NodeJS.ProcessEnv
}): string[] {
  const env = options.env ?? process.env
  const manifestPath = profileManifestPath(options.profile, env)
  if (!existsSync(manifestPath)) return []
  let manifest: { dsh?: { profile?: { bundles?: unknown } } }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch {
    return []
  }
  const bundles = profileBundleNames(options.profile, env)
  const failed = [...new Set(options.packages)].filter(name => isOptionalProfilePlugin(name) && bundles.includes(name))
  if (failed.length === 0) return []
  const nextBundles = bundles.filter(name => !failed.includes(name))
  writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles: nextBundles },
    },
  }, undefined, 2)}\n`)
  const quarantinePath = profileQuarantinePath(options.profile, env)
  const existing = readPluginQuarantine(quarantinePath)
  for (const name of failed) existing.add(name)
  writePluginQuarantine(quarantinePath, existing, options.reason)
  return failed
}

/**
 * A package that is present in the profile again was explicitly re-added by
 * the user. Treat that as an opt-in retry and clear its old quarantine mark.
 */
export function clearReintroducedPluginQuarantine(profile: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const bundles = profileBundleNames(profile, env)
  const path = profileQuarantinePath(profile, env)
  const quarantined = readPluginQuarantine(path)
  const reintroduced = [...quarantined].filter(name => bundles.includes(name))
  if (reintroduced.length === 0) return []
  for (const name of reintroduced) quarantined.delete(name)
  writePluginQuarantine(path, quarantined)
  return reintroduced
}

/** Whether `packageName` resolves from any of the given `node_modules` roots. */
function resolvesPackage(packageName: string, moduleRoots: readonly string[]): boolean {
  const segments = packageName.split('/')
  return moduleRoots.some(root => existsSync(resolve(root, ...segments, 'package.json')))
}

/**
 * Let the official CLI create a missing profile so its manifest carries the
 * shipped bundle tuple. Only `--dump-default-config` initializes a profile
 * without booting the tree it describes; the dump output is discarded.
 * @returns whether the profile manifest exists afterwards.
 */
function initProfileManifest(profile: string, dshCli: string | undefined, env: NodeJS.ProcessEnv): boolean {
  if (dshCli === undefined || !existsSync(dshCli)) return false
  const result = spawnSync(process.execPath, [dshCli, '--profile', profile, '--dump-default-config'], {
    env,
    stdio: 'pipe',
    encoding: 'utf8',
    timeout: 5 * 60_000,
  })
  if (result.error !== undefined || result.status !== 0) {
    console.warn(
      `dsh-node: profile ${profile} 初始化失败，基线插件本次不挂载：${result.error?.message ?? result.stderr ?? `退出码 ${result.status ?? '未知'}`}`,
    )
    return false
  }
  return true
}

/**
 * Register the pinned baseline as profile bundle layers.
 *
 * A packaged runtime cannot run `dsh plugin add`, and the official
 * reconciliation that promotes an installed, bundle-declaring dependency into
 * a `dsh.profile.bundles` layer only runs inside that command — so without
 * this the baseline packages sit in `node_modules` while the loader tree
 * mounts none of them: shipped plugins look uninstalled and the capabilities
 * they own (context, task board, agent teams, ...) are simply absent.
 */
export function ensurePackagedBaselineBundles(options: {
  profile: string
  env?: NodeJS.ProcessEnv
}): void {
  const env = options.env ?? process.env
  const runtimeModules = env['LUMO_RUNTIME_NODE_MODULES']
  if (runtimeModules === undefined || runtimeModules.trim() === '') {
    throw new Error('dsh-node: packaged runtime is missing LUMO_RUNTIME_NODE_MODULES')
  }
  const dshHome = env['DSH_HOME'] ?? resolve(homedir(), '.dsh')
  const profilesDir = resolve(dshHome, 'profiles')
  const profileDir = resolve(profilesDir, options.profile)
  const manifestPath = resolve(profileDir, 'package.json')
  if (!existsSync(manifestPath) && !initProfileManifest(options.profile, env['LUMO_DSH_CLI'], env)) return
  if (!existsSync(manifestPath)) return

  let manifest: { dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: unknown; patchReload?: string } } }
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as typeof manifest
  } catch (error: unknown) {
    console.warn(`dsh-node: profile ${options.profile} 的 package.json 无法解析，跳过基线插件登记：${String(error)}`)
    return
  }

  // Bundle resolution walks the dsh installation first, then the profile
  // directory; the shared fallback is the profile's own parent walk.
  const moduleRoots = [runtimeModules, resolve(profileDir, 'node_modules'), resolve(profilesDir, 'node_modules')]
  const current = Array.isArray(manifest.dsh?.profile?.bundles)
    ? manifest.dsh.profile.bundles.filter((name): name is string => typeof name === 'string')
    : []
  const quarantinePath = profileQuarantinePath(options.profile, env)
  const quarantined = readPluginQuarantine(quarantinePath)
  // Seeing a quarantined bundle in the manifest means the user explicitly
  // re-added it (for example after updating the package), so allow one retry.
  const reintroduced = [...quarantined].filter(name => current.includes(name))
  if (reintroduced.length > 0) {
    for (const name of reintroduced) quarantined.delete(name)
    writePluginQuarantine(quarantinePath, quarantined)
  }
  const available = baselineBundlePackages()
    .filter(name => !quarantined.has(name) || current.includes(name))
    .filter(name => resolvesPackage(name, moduleRoots))
  const recordPath = resolve(profileDir, BASELINE_RECORD_FILENAME)
  const owned = readBaselineRecord(recordPath)
  const { bundles, added, removed, owned: nextOwned } = reconcileBaselineBundles({ bundles: current, available, owned })
  if (removed.length > 0) {
    console.warn(`dsh-node: 退役 ${removed.length} 个基线插件 bundle(s)：${removed.join(', ')}`)
  }
  if (added.length > 0) {
    console.log(`dsh-node: 登记 ${added.length} 个基线插件 bundle(s)：${added.join(', ')}`)
  }

  // The market's Installed tab reads profile `dependencies` and resolves
  // presence/activation from `<profile>/node_modules`, while Discover also
  // accepts `dsh.profile.bundles`. A bundle-only baseline therefore looked
  // installed in Discover but left Installed empty. Record the shipped
  // baseline the way `dsh plugin add` would: a profile-local link plus a
  // dependency entry.
  const baselineNames = new Set(baselineBundlePackages())
  const dependencies = { ...(manifest.dependencies ?? {}) }
  let dependenciesChanged = false
  const profileModulesDir = resolve(profileDir, 'node_modules')
  for (const name of bundles) {
    if (!baselineNames.has(name)) continue
    const target = resolve(runtimeModules, ...name.split('/'))
    if (!existsSync(resolve(target, 'package.json'))) continue
    linkPackagedModule(profileModulesDir, name, target, false)
    if (dependencies[name] !== undefined) continue
    dependencies[name] = readPackagedVersion(runtimeModules, name) ?? pinnedBaselineVersion(name) ?? '*'
    dependenciesChanged = true
  }

  if (added.length === 0 && removed.length === 0 && nextOwned.length === owned.length && !dependenciesChanged) return

  writeFileSync(manifestPath, `${JSON.stringify({
    ...manifest,
    ...(dependenciesChanged ? { dependencies } : {}),
    dsh: {
      ...manifest.dsh,
      profile: { ...manifest.dsh?.profile, bundles },
    },
  }, undefined, 2)}\n`)
  writeFileSync(recordPath, `${JSON.stringify({ packages: nextOwned }, undefined, 2)}\n`)
}

/** Read the baseline packages a previous pass appended to this profile. */
function readBaselineRecord(path: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { packages?: unknown }
    return Array.isArray(parsed.packages) ? parsed.packages.filter((name): name is string => typeof name === 'string') : []
  } catch {
    return []
  }
}

function runProfileManager(
  options: { profile: string; dshRoot: string },
  env: NodeJS.ProcessEnv,
  args: string[],
): ReturnType<typeof spawnSync> {
  const managerEnv = profileManagerEnv(env)
  const windowsCorepack = process.platform === 'win32'
  return spawnSync(
    windowsCorepack ? 'cmd.exe' : 'corepack',
    windowsCorepack
      ? ['/d', '/s', '/c', 'corepack.cmd', 'pnpm', 'run', 'dsh', 'plugin', '--profile', options.profile, ...args]
      : ['pnpm', 'run', 'dsh', 'plugin', '--profile', options.profile, ...args],
    {
      cwd: options.dshRoot,
      env: managerEnv,
      stdio: 'inherit',
      timeout: 10 * 60_000,
    },
  )
}

/**
 * The upstream CLI intentionally invokes a bare `pnpm` inside the user
 * profile. Provide that executable at the platform boundary instead of
 * patching apps/cli: the shim delegates to Corepack, disables parent-project
 * packageManager probing, and remains scoped to this DSH home.
 */
function profileManagerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dshHome = env['DSH_HOME'] ?? resolve(homedir(), '.dsh')
  const bin = resolve(dshHome, '.lumo-bin')
  mkdirSync(bin, { recursive: true })

  const shellShim = resolve(bin, 'pnpm')
  const shellSource = '#!/bin/sh\nexec corepack pnpm "$@"\n'
  if (!existsSync(shellShim) || readFileSync(shellShim, 'utf8') !== shellSource) writeFileSync(shellShim, shellSource)
  chmodSync(shellShim, 0o755)

  const cmdShim = resolve(bin, 'pnpm.cmd')
  const cmdSource = '@echo off\r\ncorepack pnpm %*\r\n'
  if (!existsSync(cmdShim) || readFileSync(cmdShim, 'utf8') !== cmdSource) writeFileSync(cmdShim, cmdSource)

  const inheritedPath = env['PATH'] ?? process.env['PATH'] ?? ''
  return {
    ...env,
    PATH: inheritedPath === '' ? bin : `${bin}${delimiter}${inheritedPath}`,
    COREPACK_ENABLE_PROJECT_SPEC: '0',
    DSH_TELEMETRY_DISABLED: '1',
  }
}

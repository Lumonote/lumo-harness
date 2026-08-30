import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

export const PLATFORM_PLUGIN_MODULES = {
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
  project: '@lumo/project',
  provenance: '@lumo/provenance',
  recovery: '@lumo/recovery',
  seamHost: '@lumo/seam-host',
  seamProxy: '@lumo/seam-proxy',
  sessionLog: '@lumo/session-log',
  sessionTitleGateway: '@lumo/session-title-gw',
  skillLocal: '@lumo/skill-local',
  storage: '@lumo/storage',
  subagentHost: '@lumo/subagent-host',
  subagentRemote: '@lumo/subagent-remote',
  userAuth: '@lumo/user-auth',
  webGateway: '@lumo/web-gateway',
} as const

const PLATFORM_PLUGIN_DIRECTORIES: Record<keyof typeof PLATFORM_PLUGIN_MODULES, string> = {
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
  project: 'project',
  provenance: 'provenance',
  recovery: 'recovery',
  seamHost: 'seam-host',
  seamProxy: 'seam-proxy',
  sessionLog: 'session-log',
  sessionTitleGateway: 'session-title-gw',
  skillLocal: 'skill-local',
  storage: 'storage',
  subagentHost: 'subagent-host',
  subagentRemote: 'subagent-remote',
  userAuth: 'user-auth',
  webGateway: 'web-gateway',
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
 */
export const BASE_PROFILE_PLUGINS = [
  { name: 'dshmarket', spec: 'dshmarket@1.36.0' },
  { name: '@liustack/modlens', spec: '@liustack/modlens@3.25.2' },
  { name: '@anweat/dsh-browser', spec: '@anweat/dsh-browser@0.1.10' },
  { name: 'dsh-context', spec: 'dsh-context@0.38.1' },
  { name: 'dsh-cost-meter', spec: 'dsh-cost-meter@1.6.7' },
] as const

export const OBSOLETE_PROFILE_PLUGINS = ['deepseek-harness-auth'] as const

const PACKAGED_PROFILE_MODULES = [
  '@deepseek-ai/dsh-storage-sqlite',
  '@lumo/dsh-platform-ui',
  '@lumo/open-design',
  '@lumo/archify',
  '@lumo/creative-skills',
  '@lumo/ruflo-orchestration',
  'dshmarket',
  '@liustack/modlens',
  '@anweat/dsh-browser',
  'dsh-context',
  'dsh-cost-meter',
] as const

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
    const localOnly = new Set(['@lumo/dsh-platform-ui', '@lumo/open-design', '@lumo/archify', '@lumo/creative-skills', '@lumo/ruflo-orchestration', '@lumo/skill-local'])
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
    return
  }
  if (env['LUMO_AUTO_INSTALL_PLUGINS'] === '0') return

  const installed = profileDependencies(options.profile, env)
  const obsolete = obsoleteProfilePluginNames(options.profile, installed)
  if (obsolete.length > 0) {
    console.log(`dsh-node: removing obsolete profile plugin(s): ${obsolete.join(', ')}`)
    const removed = runProfileManager(options, env, ['remove', ...obsolete])
    if (removed.error) throw new Error(`dsh-node: obsolete plugin removal failed: ${removed.error.message}`)
    if (removed.status !== 0) {
      throw new Error(`dsh-node: obsolete plugin removal exited with status ${removed.status ?? 'unknown'}`)
    }
    for (const name of obsolete) delete installed[name]
  }

  const missing = missingProfilePluginSpecs(
    profilePluginSpecs(options.profile, options.platformRoot, options.deploymentMode),
    installed,
  )
  if (missing.length === 0) return

  console.log(`dsh-node: installing ${missing.length} profile plugin(s): ${missing.map(({ name }) => name).join(', ')}`)
  const result = runProfileManager(options, env, ['add', ...missing.map(({ spec }) => spec)])
  if (result.error) throw new Error(`dsh-node: profile plugin installation failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`dsh-node: profile plugin installation exited with status ${result.status ?? 'unknown'}`)
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
      throw new Error(`dsh-node: packaged runtime is missing ${name}`)
    }
    const link = resolve(modulesDir, ...name.split('/'))
    mkdirSync(resolve(link, '..'), { recursive: true })
    let stat
    try {
      stat = lstatSync(link)
    } catch {
      stat = undefined
    }
    if (stat !== undefined) {
      if (!stat.isSymbolicLink()) {
        throw new Error(`dsh-node: ${link} exists and is not a symlink`)
      }
      if (readlinkSync(link) === target) continue
      unlinkSync(link)
    }
    symlinkSync(target, link, 'junction')
  }
}

function runProfileManager(
  options: { profile: string; dshRoot: string },
  env: NodeJS.ProcessEnv,
  args: string[],
): ReturnType<typeof spawnSync> {
  const managerEnv = profileManagerEnv(env)
  return spawnSync(
    'corepack',
    ['pnpm', 'run', 'dsh', 'plugin', '--profile', options.profile, ...args],
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

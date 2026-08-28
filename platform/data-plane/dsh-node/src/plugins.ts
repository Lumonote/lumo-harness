import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve } from 'node:path'
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
  webGateway: 'web-gateway',
}

const WEB_COMMUNITY_PLUGINS = [
  { name: 'deepseek-harness-auth', spec: 'deepseek-harness-auth@0.4.0' },
  { name: '@yejiming/dsh-data-agent', spec: '@yejiming/dsh-data-agent@0.1.3' },
] as const

export interface ProfilePluginSpec {
  name: string
  spec: string
}

/** Package specs installed into a DSH profile before its Loader tree starts. */
export function profilePluginSpecs(profile: string, platformRoot: string): ProfilePluginSpec[] {
  const local = Object.entries(PLATFORM_PLUGIN_MODULES).map(([key, name]) => ({
    name,
    spec: `link:${resolve(platformRoot, 'dsh-plugins', PLATFORM_PLUGIN_DIRECTORIES[key as keyof typeof PLATFORM_PLUGIN_MODULES])}`,
  }))
  return profile === 'web' ? [...local, ...WEB_COMMUNITY_PLUGINS] : local
}

export function missingProfilePluginSpecs(
  desired: ProfilePluginSpec[],
  installed: Record<string, string>,
): ProfilePluginSpec[] {
  return desired.filter(({ name }) => installed[name] === undefined)
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
  env?: NodeJS.ProcessEnv
}): void {
  const env = options.env ?? process.env
  if (env['LUMO_AUTO_INSTALL_PLUGINS'] === '0') return

  const missing = missingProfilePluginSpecs(
    profilePluginSpecs(options.profile, options.platformRoot),
    profileDependencies(options.profile, env),
  )
  if (missing.length === 0) return

  console.log(`dsh-node: installing ${missing.length} profile plugin(s): ${missing.map(({ name }) => name).join(', ')}`)
  const result = spawnSync(
    'corepack',
    ['pnpm', 'run', 'dsh', 'plugin', '--profile', options.profile, 'add', ...missing.map(({ spec }) => spec)],
    {
      cwd: options.dshRoot,
      env: { ...env, DSH_TELEMETRY_DISABLED: '1' },
      stdio: 'inherit',
      timeout: 10 * 60_000,
    },
  )
  if (result.error) throw new Error(`dsh-node: profile plugin installation failed: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`dsh-node: profile plugin installation exited with status ${result.status ?? 'unknown'}`)
  }
}

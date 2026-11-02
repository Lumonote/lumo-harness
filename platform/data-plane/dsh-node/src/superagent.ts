import { homedir } from 'node:os'
import { resolve } from 'node:path'

/** Complete the upstream bundle's required machine config without supplying accounts or policy. */
export function superagentProfileOverlay(profile: string, bundles: readonly string[], env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (!bundles.includes('dsh-superagent')) return ''
  // The prototype's CLI shims and absolute-path schema currently require POSIX;
  // its management routes also require the Web profile's server services.
  if (platform === 'win32' || profile !== 'web') return `
- id: dsh-superagent
  disabled: true
- id: dsh-superagent-github
  disabled: true
`
  const stateDir = resolve(env['LUMO_SUPERAGENT_STATE_DIR'] ?? resolve(env['DSH_HOME'] ?? resolve(homedir(), '.dsh'), 'profiles', profile, 'superagent'))
  return `
- id: dsh-superagent
  config:
    stateDir: ${JSON.stringify(stateDir)}
`
}

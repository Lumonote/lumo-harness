import { describe, expect, it } from 'vitest'
import { superagentProfileOverlay } from '../src/superagent.ts'

describe('Superagent baseline configuration', () => {
  it('does not patch a missing or quarantined bundle', () => {
    expect(superagentProfileOverlay('web', [], {}, 'darwin')).toBe('')
  })

  it('uses persistent profile state and leaves account setup to the panel', () => {
    const patch = superagentProfileOverlay('web', ['dsh-superagent'], { DSH_HOME: '/persistent/dsh' }, 'darwin')
    expect(patch).toContain('stateDir: "/persistent/dsh/profiles/web/superagent"')
    expect(patch).not.toContain('disabled:')
    expect(patch).not.toContain('repository:')
    expect(patch).not.toContain('cli:')
  })

  it('respects an explicit state directory', () => {
    expect(superagentProfileOverlay('web', ['dsh-superagent'], { LUMO_SUPERAGENT_STATE_DIR: '/state/agent' }, 'linux'))
      .toContain('stateDir: "/state/agent"')
  })

  it.each([['headless', 'linux'], ['web', 'win32']] as const)('keeps unsupported %s/%s host entries disabled', (profile, platform) => {
    const patch = superagentProfileOverlay(profile, ['dsh-superagent'], {}, platform)
    expect(patch).toContain('- id: dsh-superagent\n  disabled: true')
    expect(patch).toContain('- id: dsh-superagent-github\n  disabled: true')
  })
})

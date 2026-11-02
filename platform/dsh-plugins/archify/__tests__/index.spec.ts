import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { apply, upstream } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function skillFixture(markdown = '---\nname: archify\n---\n\nArchify fixture instructions.\n'): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo-archify-test-')))
  roots.push(root)
  // Ignored repository snapshots must not be prerequisites for loader tests.
  vi.stubEnv('LUMO_BUNDLED_SKILLS_ROOT', join(root, 'not-installed'))
  writeFileSync(join(root, 'SKILL.md'), markdown)
  return root
}

describe('@lumo/archify', () => {
  it('registers file-backed instructions and the Lumo extension with pinned upstream provenance', () => {
    const root = skillFixture()
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const effect = vi.fn()
    apply({ get: () => ({ register }), effect } as never, { root })

    const sources = JSON.parse(readFileSync(new URL('../../../upstream/skill-sources.json', import.meta.url), 'utf8'))
    expect(sources.skills.find((skill: { name: string }) => skill.name === 'archify')).toMatchObject(upstream)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'archify',
      provider: 'lumo-archify',
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
      resourceBase: { kind: 'directory', path: root },
      path: join(root, 'SKILL.md'),
    }))
    expect(register.mock.calls[0]?.[0].content).toMatch(/^Archify fixture instructions\.\n/)
    expect(register.mock.calls[0]?.[0].content).not.toContain('name: archify')
    expect(register.mock.calls[0]?.[0].content).toContain('infrared-grid')
    expect(register.mock.calls[0]?.[0].content).toContain('data-lumo-theme')
    expect(effect).toHaveBeenCalledOnce()
    effect.mock.calls[0][0]()()
    expect(unregister).toHaveBeenCalledOnce()
  })

  it('rejects a missing skill before registering anything', () => {
    const root = join(skillFixture(), 'not-installed')
    const register = vi.fn()
    expect(() => apply({ get: () => ({ register }) } as never, { root })).toThrow(/ENOENT/)
    expect(register).not.toHaveBeenCalled()
  })

  it('rejects malformed frontmatter before registering anything', () => {
    const root = skillFixture('not a skill document')
    const register = vi.fn()
    expect(() => apply({ get: () => ({ register }) } as never, { root })).toThrow(/lacks frontmatter/)
    expect(register).not.toHaveBeenCalled()
  })
})

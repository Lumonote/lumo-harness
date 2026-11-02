import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply, upstream } from '../src/index.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  vi.unstubAllEnvs()
})

function skillFixture(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo-creative-test-')))
  roots.push(root)
  vi.stubEnv('LUMO_BUNDLED_SKILLS_ROOT', join(root, 'not-installed'))
  for (const name of ['gpt-image-2-style-library', 'ppt-master']) {
    mkdirSync(join(root, name))
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\n---\n\n${name} fixture instructions.\n`)
  }
  return root
}

describe('@lumo/creative-skills', () => {
  it('registers the pinned image and presentation skills in Chinese', () => {
    const root = skillFixture()
    const unregister = vi.fn()
    const register = vi.fn(() => unregister)
    const effect = vi.fn()
    apply({ get: () => ({ register }), effect } as never, { root })
    const sources = JSON.parse(readFileSync(new URL('../../../upstream/skill-sources.json', import.meta.url), 'utf8'))
    for (const [name, pin] of [['gpt-image-2-style-library', upstream.image], ['ppt-master', upstream.presentation]] as const) {
      expect(sources.skills.find((skill: { name: string }) => skill.name === name)).toMatchObject(pin)
      expect(register).toHaveBeenCalledWith(expect.objectContaining({
        name, source: 'bundled', provider: 'lumo-creative-skills',
        resourceBase: { kind: 'directory', path: join(root, name) },
        path: join(root, name, 'SKILL.md'),
        invocation: { modelInvocable: true, userInvocable: true },
      }))
    }
    expect(register).toHaveBeenCalledTimes(2)
    expect(register.mock.calls[0][0].content).toBe('gpt-image-2-style-library fixture instructions.\n')
    expect(register.mock.calls[1][0].content).toMatch(/^ppt-master fixture instructions\.\n/)
    expect(register.mock.calls[1][0].content).toContain('Lumo runtime boundary')
    expect(register.mock.calls[1][0].description).toMatch(/[\u4e00-\u9fff]/)
    expect(effect).toHaveBeenCalledOnce()
    effect.mock.calls[0][0]()()
    expect(unregister).toHaveBeenCalledTimes(2)
  })

  it('rejects incomplete installation before registering either skill', () => {
    const root = skillFixture()
    rmSync(join(root, 'ppt-master'), { recursive: true })
    const register = vi.fn()
    expect(() => apply({ get: () => ({ register }) } as never, { root })).toThrow(/ENOENT/)
    expect(register).not.toHaveBeenCalled()
  })

  it('rejects a mismatched skill name before registration', () => {
    const root = skillFixture()
    writeFileSync(join(root, 'gpt-image-2-style-library', 'SKILL.md'), '---\nname: other-skill\n---\nbody')
    const register = vi.fn()
    expect(() => apply({ get: () => ({ register }) } as never, { root })).toThrow(/expected gpt-image-2-style-library/)
    expect(register).not.toHaveBeenCalled()
  })
})

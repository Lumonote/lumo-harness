import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import localSkill, { loadLocalSkillSnapshot, type Config } from '../src/index.ts'

function sha256(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`
}

async function fixture(): Promise<{ root: string; config: Config; content: string }> {
  const root = await mkdtemp(join(tmpdir(), 'lumo-skill-snapshot-'))
  const content = '---\nname: repo-audit\ndescription: Audit a repository\n---\n\nRead the tests first.\n'
  await mkdir(join(root, 'repo-audit'))
  await writeFile(join(root, 'repo-audit', 'SKILL.md'), content)
  return {
    root,
    content,
    config: { root, skills: [{ name: 'repo-audit', sha256: sha256(content), description: 'Audit a repository' }] },
  }
}

describe('@lumo/skill-local', () => {
  it('registers only verified, local skill bytes and preserves the resource base', async () => {
    const { config, root } = await fixture()
    const ctx = new Context()
    await ctx.plugin(SkillRegistry)
    await ctx.plugin(localSkill, config)
    await expect(ctx.skills.list()).resolves.toMatchObject([{ name: 'repo-audit', provider: 'lumo-local-snapshot' }])
    await expect(ctx.skills.get('repo-audit')).resolves.toMatchObject({
      content: 'Read the tests first.\n',
      resourceBase: { kind: 'directory', path: join(root, 'repo-audit') },
    })
    await ctx.fiber.dispose()
  })

  it('fails closed on changed bytes and unpinned root entries', async () => {
    const { config, root } = await fixture()
    await writeFile(join(root, 'repo-audit', 'SKILL.md'), '---\nname: repo-audit\n---\nchanged')
    await expect(loadLocalSkillSnapshot(config)).rejects.toThrow('digest mismatch')

    const fresh = await fixture()
    await mkdir(join(fresh.root, 'unreviewed'))
    await expect(loadLocalSkillSnapshot(fresh.config)).rejects.toThrow('unpinned entry')
  })
})

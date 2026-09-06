import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it } from 'vitest'
import { api, type Config } from '../src/index.ts'
import { registerSkillHubRuntime, type SkillHubRuntime } from '../src/skillhub-runtime.ts'
import { buildCatalog, installItem, type SkillHubConfig } from '../src/skillhub.ts'

const roots: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function runtime(root: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SkillRegistry)
  let installed!: SkillHubRuntime
  await ctx.inject(['skills'], (owner) => { installed = registerSkillHubRuntime(owner, root) })
  return { ctx, installed }
}

async function setup() {
  const root = mkdtempSync(join(tmpdir(), 'lumo skillhub (&) '))
  roots.push(root)
  const skillsRoot = join(root, 'skills')
  const { ctx, installed } = await runtime(skillsRoot)
  const config: SkillHubConfig = {
    root: skillsRoot, catalogFile: join(root, 'catalog.json'), installFile: join(root, 'installs.json'),
    snapshotFile: join(root, 'snapshot.json'), command: join(root, 'skillhub.mjs'),
    apiBase: 'https://invalid.test', runtime: installed,
  }
  writeFileSync(config.command, `
    import { mkdirSync, writeFileSync } from 'node:fs'
    import { join } from 'node:path'
    const [operation, slug, flag, root] = process.argv.slice(2)
    if (operation !== 'install' || flag !== '--dir') process.exit(2)
    if (slug === 'broken') { console.error('fixture installation failed'); process.exit(3) }
    if (slug === 'broken404') { console.error('Download failed: HTTP 404 for https://api.skillhub.cn/api/v1/download?slug=' + slug); process.exit(5) }
    const name = slug === 'catalog-name' ? 'docs-live' : slug
    mkdirSync(join(root, slug), {recursive: true})
    writeFileSync(join(root, slug, 'SKILL.md'), '---\\nname: ' + name + '\\ndescription: Test skill\\n---\\nInstalled instructions for ' + name + '\\n')
  `)
  writeFileSync(config.catalogFile, JSON.stringify({
    source: 'skillhub',
    skills: [{ id: 'catalog-name', name: 'Catalog name' }, { id: 'broken', name: 'Broken' }],
    packs: [
      { id: 'expert-pack', name: 'Expert pack', skillSlugs: ['catalog-name', 'testing-live'] },
      { id: 'partial-pack', name: 'Partial pack', skillSlugs: ['good-one', 'broken404'] },
    ],
    plugins: [],
  }))
  return { config, ctx }
}

describe('SkillHub installation and native discovery', () => {
  it('loads the installed body immediately and rediscovers it in a new runtime', async () => {
    const { config, ctx } = await setup()
    expect((await ctx.skills.snapshot()).skills).toHaveLength(0)
    const catalog = await installItem(config, 'skill', 'catalog-name')
    expect(catalog.installed.commands?.['skill:catalog-name']).toEqual(['docs-live'])
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).toEqual(['docs-live'])
    const skill = await ctx.skills.get('docs-live')
    expect(skill?.content).toContain('Installed instructions for docs-live')
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const restarted = await runtime(config.root)
    expect((await restarted.ctx.skills.snapshot()).skills.map(skill => skill.name)).toEqual(['docs-live'])
    expect(buildCatalog(config).installed.skills).toEqual(['catalog-name'])
  })

  it('installs each expert-pack skill and records the actual invocation names', async () => {
    const { config, ctx } = await setup()
    const catalog = await installItem(config, 'pack', 'expert-pack')
    expect(catalog.installed.packs).toEqual(['expert-pack'])
    expect(catalog.installed.commands?.['pack:expert-pack']).toEqual(['docs-live', 'testing-live'])
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name).sort()).toEqual(['docs-live', 'testing-live'])
  })

  it('does not report a failed CLI installation as installed', async () => {
    const { config } = await setup()
    await expect(installItem(config, 'skill', 'broken')).rejects.toThrow('fixture installation failed')
    expect(buildCatalog(config).installed.skills).toEqual([])
  })

  it('installs the healthy skills of an expert pack when one constituent 404s', async () => {
    const { config, ctx } = await setup()
    const catalog = await installItem(config, 'pack', 'partial-pack')
    // 一个构成技能 404 不应拖垮整个专家包：健康技能照常安装并记录。
    expect(catalog.installed.packs).toEqual(['partial-pack'])
    expect(catalog.installed.commands?.['pack:partial-pack']).toEqual(['good-one'])
    expect(catalog.notice).toContain('broken404')
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name)).toEqual(['good-one'])
  })

  it('retries the post-CLI discovery before reporting an unloadable SKILL.md', async () => {
    const { config, ctx } = await setup()
    // 模拟 CLI 退出后 watcher/扫描尚未收敛：前两次 refresh 看不到文件，第三次才返回。
    const real = config.runtime!
    let calls = 0
    config.runtime = { refresh: async () => (++calls < 3 ? [] : real.refresh()) }
    const catalog = await installItem(config, 'pack', 'expert-pack')
    expect(catalog.installed.commands?.['pack:expert-pack']).toEqual(['docs-live', 'testing-live'])
    expect(calls).toBeGreaterThanOrEqual(3)
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name).sort()).toEqual(['docs-live', 'testing-live'])
  })

  it('passes the installation runtime through the HTTP handler', async () => {
    const { config } = await setup()
    const request = Object.assign(Readable.from([Buffer.from(JSON.stringify({ kind: 'skill', id: 'catalog-name' }))]), {
      method: 'POST', url: '/lumo/api/skillhub/install', headers: {},
    })
    let status = 0
    let body: unknown
    const response = {
      setHeader() {},
      writeHead(value: number) { status = value; return this },
      end(value: string) { body = JSON.parse(value); return this },
    }
    const hostConfig = {
      realm: 'local', userId: 'local', roles: ['operator'], projectId: '', deptId: '',
      identityAssertionSecret: '', deploymentMode: 'local',
      skillhubCatalogFile: config.catalogFile, skillhubInstallFile: config.installFile,
      skillhubRoot: config.root, skillhubSnapshotFile: config.snapshotFile, skillhubCommand: config.command,
    } as Config
    await api(hostConfig, undefined, undefined, undefined, undefined, request as never, response as never, config.runtime)
    expect(status).toBe(200)
    expect(body).toMatchObject({ installed: { skills: ['catalog-name'], commands: { 'skill:catalog-name': ['docs-live'] } } })
    expect(JSON.parse(readFileSync(config.installFile, 'utf8')).commands['skill:catalog-name']).toEqual(['docs-live'])
  })
})

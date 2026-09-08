import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import { afterEach, describe, expect, it } from 'vitest'
import { api, type Config } from '../src/index.ts'
import { registerSkillHubRuntime, type SkillHubRuntime } from '../src/skillhub-runtime.ts'
import { buildCatalog, installItem, loadCatalog, type SkillHubConfig } from '../src/skillhub.ts'

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
      { id: 'expert-pack', name: 'Expert pack', command: 'expert-entry', skillSlugs: ['catalog-name', 'testing-live'] },
      { id: 'partial-pack', name: 'Partial pack', skillSlugs: ['good-one', 'broken404'] },
      { id: 'empty-pack', name: 'Empty pack', skillSlugs: ['broken', 'broken404'] },
    ],
    plugins: [],
  }))
  return { config, ctx }
}

describe('SkillHub installation and native discovery', () => {
  it('marks every bundled base plugin installed across seed and cache catalogs', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo skillhub base '))
    roots.push(root)
    const config: SkillHubConfig = {
      root: join(root, 'skills'), catalogFile: join(root, 'catalog.json'), installFile: join(root, 'installs.json'),
      snapshotFile: join(root, 'snapshot.json'), command: 'skillhub', apiBase: 'https://invalid.test',
      preinstalledRepositories: [
        'https://github.com/dsh-market/dsh-market.git',
        'REVOLUTIONLA/dsh-dream-skin/',
        'bowenliang123/dsh-context',
        'git@github.com:Han-1413141/dsh-cost-meter.git',
        'scwlkq/dsh-task-board',
        'https://github.com/liustack/modlens',
        'NanmiCoder/dsh-agent-teams',
        'dream-num/dsh-univer-office.git',
      ],
    }
    expect(buildCatalog(config).installed.plugins.sort()).toEqual([
      'dsh-agent-teams', 'dsh-context', 'dsh-cost-meter', 'dsh-dream-skin',
      'dsh-market', 'dsh-task-board', 'dsh-univer-office', 'modlens',
    ])
  })

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

  it('installs one expert entry that routes to the constituent skills and survives restart', async () => {
    const { config, ctx } = await setup()
    const catalog = await installItem(config, 'pack', 'expert-pack')
    expect(catalog.installed.packs).toEqual(['expert-pack'])
    expect(catalog.installed.commands?.['pack:expert-pack']).toEqual(['expert-entry'])
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name).sort()).toEqual(['docs-live', 'expert-entry', 'testing-live'])
    const entry = await ctx.skills.get('expert-entry')
    expect(entry?.content).toContain('# Expert pack')
    expect(entry?.content).toContain('../catalog-name/SKILL.md')
    expect(entry?.content).toContain('../testing-live/SKILL.md')
    expect(entry?.invocation).toEqual({ userInvocable: true, modelInvocable: false })
    await ctx.fiber.dispose()
    contexts.splice(contexts.indexOf(ctx), 1)
    const restarted = await runtime(config.root)
    expect((await restarted.ctx.skills.get('expert-entry'))?.content).toEqual(entry?.content)
    expect(buildCatalog(config).installed.commands?.['pack:expert-pack']).toEqual(['expert-entry'])
  })

  it('repairs legacy pack receipts from local skills without downloading again', async () => {
    const { config, ctx } = await setup()
    await installItem(config, 'skill', 'catalog-name')
    const receipts = JSON.parse(readFileSync(config.installFile, 'utf8'))
    receipts.packs = ['expert-pack']
    receipts.commands['pack:expert-pack'] = ['docs-live']
    receipts.files['pack:expert-pack'] = receipts.files['skill:catalog-name']
    writeFileSync(config.installFile, JSON.stringify(receipts))
    config.command = ''
    const catalog = await loadCatalog(config, true)
    expect(catalog.installed.commands?.['pack:expert-pack']).toEqual(['expert-entry'])
    expect((await ctx.skills.get('expert-entry'))?.content).toContain('../catalog-name/SKILL.md')
    expect((await loadCatalog(config, true)).installed).toEqual(catalog.installed)
  })

  it('does not report an expert pack installed when every constituent fails', async () => {
    const { config, ctx } = await setup()
    await expect(installItem(config, 'pack', 'empty-pack')).rejects.toThrow('全部技能均不可用')
    expect(buildCatalog(config).installed.packs).toEqual([])
    expect((await ctx.skills.snapshot()).skills).toHaveLength(0)
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
    expect(catalog.installed.commands?.['pack:partial-pack']).toEqual(['partial-pack'])
    expect(catalog.notice).toContain('broken404')
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name).sort()).toEqual(['good-one', 'partial-pack'])
    expect((await ctx.skills.get('partial-pack'))?.content).not.toContain('broken404')
  })

  it('retries the post-CLI discovery before reporting an unloadable SKILL.md', async () => {
    const { config, ctx } = await setup()
    // 模拟 CLI 退出后 watcher/扫描尚未收敛：前两次 refresh 看不到文件，第三次才返回。
    const real = config.runtime!
    let calls = 0
    config.runtime = { refresh: async () => (++calls < 3 ? [] : real.refresh()) }
    const catalog = await installItem(config, 'pack', 'expert-pack')
    expect(catalog.installed.commands?.['pack:expert-pack']).toEqual(['expert-entry'])
    expect(calls).toBeGreaterThanOrEqual(3)
    expect((await ctx.skills.snapshot()).skills.map(skill => skill.name).sort()).toEqual(['docs-live', 'expert-entry', 'testing-live'])
  }, 15000)

  it.each(['local', 'standalone'] as const)('preserves %s operator installation through the HTTP handler', async deploymentMode => {
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
      identityAssertionSecret: '', deploymentMode,
      skillhubCatalogFile: config.catalogFile, skillhubInstallFile: config.installFile,
      skillhubRoot: config.root, skillhubSnapshotFile: config.snapshotFile, skillhubCommand: config.command,
    } as Config
    await api(hostConfig, undefined, undefined, undefined, undefined, request as never, response as never, config.runtime)
    expect(status).toBe(200)
    expect(body).toMatchObject({ installed: { skills: ['catalog-name'], commands: { 'skill:catalog-name': ['docs-live'] } } })
    expect(JSON.parse(readFileSync(config.installFile, 'utf8')).commands['skill:catalog-name']).toEqual(['docs-live'])
  })
})

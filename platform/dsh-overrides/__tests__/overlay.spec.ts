import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { applyLumoDshOverrides } from '../apply.mjs'
import { brandWebBuild } from '../brand-web.mjs'

/**
 * dsh 覆盖层的回归护栏。
 *
 * 这两个脚本是第一铁律的兑现方式：产品改动落在**暂存副本**上，上游 checkout 保持
 * 原样。代价是 `apply.mjs` 靠字符串锚点定位插入位置 —— 上游一次重构就会让锚点失配，
 * 而失败点原本只在跑完整桌面构建时才暴露。这里把它拉到单元测试里。
 *
 * `brand-web.mjs` 这部分接管的是上游 `apps/web/tests/pwa-manifest.e2e.ts` 曾经背的
 * 断言：那份用例当时被就地改成断言 Lumo 品牌，随迁移一并还原成上游版本，品牌契约
 * 从此由本文件负责。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const dshRoot = resolve(repoRoot, 'deepseek-harness')

/** 覆盖层触碰的上游文件；顺序即 applyLumoDshOverrides 的补丁顺序。 */
const PATCHED = [
  'packages/client/ui-conversation/src/client/apply.ts',
  'packages/client/ui-conversation/src/client/contract/slots.ts',
  'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx',
  'packages/client/ui-sidebar/src/client/index.ts',
  'packages/client/ui-sidebar/src/client/contract/slots.ts',
  'packages/client/ui-sidebar/src/client/SidebarRoot.tsx',
  'packages/session/session-format-v0-to-v1/src/relationships.ts',
  'packages/client/ui-model-selection/src/client/directory.ts',
  // 根 tsdown.config.ts 在列表尾部：前面 0-5 的下标是既有测试的读取约定。
  'tsdown.config.ts',
]

const temporaries: string[] = []
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryRoot(label: string): string {
  const root = mkdtempSync(resolve(tmpdir(), `lumo-overlay-${label}-`))
  temporaries.push(root)
  return root
}

/**
 * 把上游当前 HEAD 的文件铺进临时目录。走 `git show` 而不是读工作区 —— 工作区可能
 * 带着尚未迁移的改动，那样测的就不是「覆盖层能否作用于干净上游」了。
 *
 * 走 HEAD 而不是某个固定 tag：上游 checkout 跟随 master，所以这份护栏会自动对着
 * 最新上游跑，`git pull` 之后锚点若漂移，跑测试就红，不必等到打桌面包才发现。
 */
function stagePristineUpstream(label: string): string {
  const root = temporaryRoot(label)
  for (const relativePath of PATCHED) {
    const source = execFileSync('git', ['-C', dshRoot, 'show', `HEAD:${relativePath}`], { encoding: 'utf8' })
    const target = resolve(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  return root
}

function read(root: string, relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

describe('applyLumoDshOverrides', () => {
  it('锚点在当前上游 HEAD 里仍然存在,会话与侧边栏都被打上扩展位', () => {
    const root = stagePristineUpstream('anchors')
    applyLumoDshOverrides(root)

    const applyTs = read(root, PATCHED[0]!)
    expect(applyTs).toContain("'conversation.hero.input.left': { kind: 'list', scope: 'root' }")
    expect(applyTs).toContain("'conversation.hero.composer.dock': { kind: 'list', scope: 'root' }")

    const slots = read(root, PATCHED[1]!)
    expect(slots).toContain('HeroComposerOwnerProps')
    expect(slots).toContain('LUMO_HERO_INPUT_BRIDGE')
    expect(slots).toContain('readonly inputActions?: InputActions')
    expect(slots).toContain("| 'conversation.hero.input.left'")
    expect(slots).toContain("| 'conversation.hero.composer.dock'")

    const conversationRoot = read(root, PATCHED[2]!)
    expect(conversationRoot).toContain("renderSlot('conversation.hero.input.left', { input: inputState, inputActions })")
    expect(conversationRoot).toContain("renderSlot('conversation.hero.composer.dock', { input: inputState, inputActions })")

    const sidebarApply = read(root, PATCHED[3]!)
    expect(sidebarApply).toContain("'sidebar.navigation': { kind: 'list', scope: 'root' }")
    const sidebarSlots = read(root, PATCHED[4]!)
    expect(sidebarSlots).toContain('SidebarNavigationOwnerProps')
    expect(sidebarSlots).toContain("| 'sidebar.navigation'")
    const sidebarRoot = read(root, PATCHED[5]!)
    expect(sidebarRoot).toContain("renderSlot('sidebar.navigation', { wide })")

    const relationships = read(root, PATCHED[6]!)
    expect(relationships).toContain('LUMO_SESSION_RECOVERY')
    expect(relationships).toContain("assertNoUnresolvedTools(toolLifecycles, 'turn/start recovery')")
  })

  it('首页无会话时 hero 座位只在 hero 模式渲染,会话仍走上游的 input.dock 槽', () => {
    const root = stagePristineUpstream('scope')
    applyLumoDshOverrides(root)
    const source = read(root, PATCHED[2]!)
    // 上游已把 composer 重构为 input.dock + composer.bar,不再有 leftItems/三元。
    // 关键:会话输入走上游的 input.dock;hero 座位用 hero 守卫,绝不无条件替换会话槽。
    expect(source).toContain("renderSlot('conversation.input.dock', zone)")
    expect(source).toContain("{hero && renderSlot('conversation.hero.input.left', { input: inputState, inputActions })}")
    expect(source).not.toMatch(/zone === undefined\s*\?\s*renderSlot\('conversation\.hero\.input\.left'/u)
  })

  it('重复执行是幂等的,不会打第二遍', () => {
    const root = stagePristineUpstream('idempotent')
    applyLumoDshOverrides(root)
    const once = PATCHED.map(path => read(root, path))
    applyLumoDshOverrides(root)
    expect(PATCHED.map(path => read(root, path))).toEqual(once)
  })

  it('锚点消失时立刻报错并点名文件,而不是静默少打一个扩展位', () => {
    const root = stagePristineUpstream('missing')
    // 模拟上游重构掉了 agentPreset 那一行。
    const target = resolve(root, PATCHED[0]!)
    writeFileSync(target, readFileSync(target, 'utf8').replace(/^.*conversation\.hero\.agentPreset.*$/mu, ''))
    expect(() => { applyLumoDshOverrides(root) }).toThrow(/apply\.ts does not contain the expected upstream anchor/u)
  })

  it('锚点出现多次时拒绝,而不是赌第一处是对的', () => {
    const root = stagePristineUpstream('ambiguous')
    const target = resolve(root, PATCHED[0]!)
    const source = readFileSync(target, 'utf8')
    const anchor = "      'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },\n"
    writeFileSync(target, source.replace(anchor, anchor + anchor))
    expect(() => { applyLumoDshOverrides(root) }).toThrow(/contains the upstream anchor more than once/u)
  })
})

describe('brandWebBuild', () => {
  /** 造一份最小 dist：只有 brandWebBuild 会读写的两个文件。 */
  function stageDist(label: string, options: { index?: string; manifest?: string } = {}): string {
    const root = temporaryRoot(label)
    const dist = resolve(root, 'apps', 'web', 'dist')
    mkdirSync(dist, { recursive: true })
    if (options.index !== undefined) writeFileSync(resolve(dist, 'index.html'), options.index)
    if (options.manifest !== undefined) writeFileSync(resolve(dist, 'manifest.webmanifest'), options.manifest)
    return root
  }

  const UPSTREAM_INDEX = '<!doctype html><html><head>'
    + '<link rel="manifest" href="/manifest.webmanifest" />'
    + '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'
    + '<title>DSH Local Build</title></head><body></body></html>'
  const UPSTREAM_MANIFEST = JSON.stringify({
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: '/',
    display: 'fullscreen',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  })

  it('把构建产物换成 Lumo 品牌,并落下 PNG 图标', () => {
    const root = stageDist('brand', { index: UPSTREAM_INDEX, manifest: UPSTREAM_MANIFEST })
    brandWebBuild(root)

    const dist = resolve(root, 'apps', 'web', 'dist')
    const html = readFileSync(resolve(dist, 'index.html'), 'utf8')
    expect(html).toContain('<link rel="icon" type="image/png" href="/branding/logo.png" />')
    expect(html).toContain('<title>Lumo</title>')
    expect(html).not.toContain('favicon.svg')
    expect(html).not.toContain('DSH Local Build')
    // manifest 的 link 不是图标 link,替换正则不能顺手把它吃掉。
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

    const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.webmanifest'), 'utf8'))
    expect(manifest.name).toBe('Lumo')
    expect(manifest.short_name).toBe('Lumo')
    expect(manifest.icons).toEqual([{ src: '/branding/logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' }])
    // start_url / display 是上游的产品决定,品牌覆盖不该动它们。
    expect(manifest.start_url).toBe('/')
    expect(manifest.display).toBe('fullscreen')

    expect(existsSync(resolve(dist, 'branding', 'logo.png'))).toBe(true)
  })

  it('对已品牌化的 dist 重跑仍然收敛到同一结果', () => {
    const root = stageDist('rebrand', { index: UPSTREAM_INDEX, manifest: UPSTREAM_MANIFEST })
    brandWebBuild(root)
    const dist = resolve(root, 'apps', 'web', 'dist')
    const once = readFileSync(resolve(dist, 'index.html'), 'utf8')
    brandWebBuild(root)
    expect(readFileSync(resolve(dist, 'index.html'), 'utf8')).toBe(once)
  })

  it('dist 不完整时报错,而不是产出一个半品牌化的包', () => {
    expect(() => { brandWebBuild(stageDist('no-manifest', { index: UPSTREAM_INDEX })) })
      .toThrow(/requires a completed DSH Web build/u)
    expect(() => { brandWebBuild(stageDist('no-index', { manifest: UPSTREAM_MANIFEST })) })
      .toThrow(/requires a completed DSH Web build/u)
  })
})

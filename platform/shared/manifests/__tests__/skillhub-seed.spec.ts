/**
 * SkillHub 离线种子清单的漂移锁。
 *
 * 结构：`shared/manifests/skillhub-seed.manifest.json` 是唯一真相源；lumo-ui 侧因 tsconfig 的
 * `rootDir: src` 无法跨包 import 清单（且这份数据是离线时的最后兜底，必须编译进包、不能改成
 * 运行期读文件），故持有一份**生成物** `dsh-plugins/lumo-ui/src/generated/skillhub-seed.ts`，
 * 必须锁住二者的一致性。
 *
 * 与 `plugin-baseline.spec.ts`、Go 侧 `usage-ledger/internal/manifest/manifest_test.go`
 * 的漂移锁同源。
 *
 * 改清单 → `pnpm run codegen:skillhub-seed` → 本用例应绿；只改一侧即红。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  PACK_CATEGORIES,
  PLUGIN_CATEGORIES,
  SEED_PACKS,
  SEED_PLUGINS,
  SEED_SKILLS,
  SKILL_CATEGORIES,
  SKILLHUB_SEED_SOURCE,
} from '../../../dsh-plugins/lumo-ui/src/generated/skillhub-seed.ts'

interface SeedSkillEntry {
  id: string
  name: string
  tag: string
  description: string
  rating: number
  downloads: number
  source: string
  verified: boolean
  command: string
  apiKey: boolean
}

interface SeedPackEntry {
  id: string
  name: string
  role: string
  category: string
  description: string
  skills: number
  source: string
  command: string
}

interface SeedPluginEntry {
  id: string
  name: string
  category: string
  description: string
  stars: number
  forks: number
  source: string
  installable: boolean
  repo: string
}

interface SeedManifest {
  title: string
  description: string
  source: string
  categories: { skills: string[]; packs: string[]; plugins: string[] }
  skills: SeedSkillEntry[]
  packs: SeedPackEntry[]
  plugins: SeedPluginEntry[]
}

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = resolve(here, '..', 'skillhub-seed.manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as SeedManifest

const plain = <T extends object>(entries: readonly T[]): T[] => entries.map(entry => ({ ...entry }))

describe('SkillHub 种子清单 —— 生成物与原件一致（漂移锁）', () => {
  it('skills 逐条一致，含顺序', () => {
    expect(plain(SEED_SKILLS)).toEqual(manifest.skills)
  })

  it('packs 逐条一致，含顺序', () => {
    expect(plain(SEED_PACKS)).toEqual(manifest.packs)
  })

  it('plugins 逐条一致，含顺序', () => {
    expect(plain(SEED_PLUGINS)).toEqual(manifest.plugins)
  })

  it('三组分类字典一致，含顺序', () => {
    expect([...SKILL_CATEGORIES]).toEqual([...manifest.categories.skills])
    expect([...PACK_CATEGORIES]).toEqual([...manifest.categories.packs])
    expect([...PLUGIN_CATEGORIES]).toEqual([...manifest.categories.plugins])
  })

  it('来源站点一致', () => {
    expect(SKILLHUB_SEED_SOURCE).toBe(manifest.source)
  })

  it('字段集合与清单完全一致（生成器没有偷偷丢字段）', () => {
    const keysOf = (entry: object): string[] => Object.keys(entry).sort()
    for (const [generated, declared] of [
      [SEED_SKILLS, manifest.skills],
      [SEED_PACKS, manifest.packs],
      [SEED_PLUGINS, manifest.plugins],
    ] as const) {
      expect(generated.length).toBe(declared.length)
      for (let i = 0; i < generated.length; i += 1) {
        expect(keysOf(generated[i])).toEqual(keysOf(declared[i]))
      }
    }
  })
})

describe('SkillHub 种子清单 —— 清单自身的完整性', () => {
  it('说明性字段非空（title / description / source）', () => {
    for (const field of [manifest.title, manifest.description, manifest.source]) {
      expect(field.trim().length).toBeGreaterThan(0)
    }
  })

  it('三类都不得为空 —— 离线兜底空目录会让面板直接白屏', () => {
    expect(manifest.skills.length).toBeGreaterThan(0)
    expect(manifest.packs.length).toBeGreaterThan(0)
    expect(manifest.plugins.length).toBeGreaterThan(0)
  })

  it('每类 id 唯一', () => {
    for (const entries of [manifest.skills, manifest.packs, manifest.plugins]) {
      const ids = entries.map(entry => entry.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('每条的名称与描述非空', () => {
    for (const entry of [...manifest.skills, ...manifest.packs, ...manifest.plugins]) {
      expect(entry.name.trim().length).toBeGreaterThan(0)
      expect(entry.description.trim().length).toBeGreaterThan(0)
    }
  })

  it('分类字典无重复项', () => {
    for (const list of [manifest.categories.skills, manifest.categories.packs, manifest.categories.plugins]) {
      expect(new Set(list).size).toBe(list.length)
    }
  })

  it('分类字典首项是「不过滤」标签 —— UI 靠位置把它当默认项', () => {
    expect(manifest.categories.skills[0]).toBe('全部')
    expect(manifest.categories.packs[0]).toBe('全部')
    expect(manifest.categories.plugins[0]).toBe('全部分类')
  })

  it('每条的分类落在本类的分类字典里 —— 否则筛选下拉里会出现筛不出东西的选项', () => {
    const inList = (label: string, list: string[]): boolean => list.includes(label)
    for (const entry of manifest.skills) expect(inList(entry.tag, manifest.categories.skills)).toBe(true)
    for (const entry of manifest.packs) expect(inList(entry.category, manifest.categories.packs)).toBe(true)
    for (const entry of manifest.plugins) expect(inList(entry.category, manifest.categories.plugins)).toBe(true)
  })

  it('数值字段是非负整数（rating / downloads / skills / stars / forks）', () => {
    const isCount = (value: number): boolean => Number.isInteger(value) && value >= 0
    for (const entry of manifest.skills) {
      expect(isCount(entry.rating)).toBe(true)
      expect(isCount(entry.downloads)).toBe(true)
    }
    for (const entry of manifest.packs) expect(isCount(entry.skills)).toBe(true)
    for (const entry of manifest.plugins) {
      expect(isCount(entry.stars)).toBe(true)
      expect(isCount(entry.forks)).toBe(true)
    }
  })

  it('插件的 repo 是 owner/name 形式 —— 它要和 preinstalledRepositories 做匹配', () => {
    for (const entry of manifest.plugins) {
      expect(entry.repo).toMatch(/^[\w.-]+\/[\w.-]+$/u)
    }
  })
})

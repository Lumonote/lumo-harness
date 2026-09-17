/**
 * 基线插件清单的漂移锁。
 *
 * 结构：`shared/manifests/plugin-baseline.manifest.json` 是唯一真相源；dsh-node 侧因运行期
 * 读不到仓库文件（tsx 直跑源码 + 打包后目录布局不同）而持有一份**生成物**，故必须锁住二者
 * 的一致性。`desktop/build-runtime.mjs` 不需要锁 —— 它直读原件，结构上无法漂移。
 *
 * 与 Go 侧 `usage-ledger/internal/manifest/manifest_test.go` 的漂移锁、以及 TS 侧
 * `cost-events.ts` 对 `cost-types.manifest.json` 的单源化约定同源。
 *
 * 改清单 → `pnpm run codegen:plugin-baseline` → 本用例应绿；只改一侧即红。
 */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  BASELINE_EXCLUDED_PLUGINS,
  BASELINE_PLUGIN_PINS,
  PACKAGED_FIRST_PARTY_MODULES,
  PACKAGED_PROFILE_MODULES,
} from '../../../data-plane/dsh-node/src/generated/plugin-baseline.ts'

interface BaselineEntry {
  name: string
  version: string
  note: string
}

interface ExcludedEntry {
  name: string
  reason: string
}

interface BaselineManifest {
  title: string
  description: string
  policy: string
  baseline: BaselineEntry[]
  excluded: ExcludedEntry[]
  packagedFirstParty: string[]
}

const here = dirname(fileURLToPath(import.meta.url))
const manifestPath = resolve(here, '..', 'plugin-baseline.manifest.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BaselineManifest

describe('基线插件清单 —— 生成物与原件一致（漂移锁）', () => {
  it('baseline 逐条一致，含顺序', () => {
    expect(BASELINE_PLUGIN_PINS.map(pin => ({ name: pin.name, version: pin.version, note: pin.note })))
      .toEqual(manifest.baseline.map(entry => ({ name: entry.name, version: entry.version, note: entry.note })))
  })

  it('spec 由 name@version 拼出，不是第二处手写', () => {
    for (const pin of BASELINE_PLUGIN_PINS) {
      expect(pin.spec).toBe(`${pin.name}@${pin.version}`)
    }
  })

  it('excluded 逐条一致', () => {
    expect(BASELINE_EXCLUDED_PLUGINS.map(entry => ({ ...entry })))
      .toEqual(manifest.excluded.map(entry => ({ ...entry })))
  })

  it('首方模块名单一致', () => {
    expect([...PACKAGED_FIRST_PARTY_MODULES]).toEqual([...manifest.packagedFirstParty])
  })

  it('PACKAGED_PROFILE_MODULES = 首方模块 + 基线包名', () => {
    expect([...PACKAGED_PROFILE_MODULES]).toEqual([
      ...manifest.packagedFirstParty,
      ...manifest.baseline.map(entry => entry.name),
    ])
  })
})

describe('基线插件清单 —— 清单自身的完整性', () => {
  it('说明性字段非空（title / description / policy）', () => {
    for (const field of [manifest.title, manifest.description, manifest.policy]) {
      expect(field.trim().length).toBeGreaterThan(0)
    }
  })

  it('版本是精确版本，不接受范围写法', () => {
    for (const entry of manifest.baseline) {
      expect(entry.version).toMatch(/^\d+\.\d+\.\d+$/)
    }
  })

  it('每条都写清了钉这个版本的理由', () => {
    for (const entry of manifest.baseline) {
      expect(entry.note.trim().length).toBeGreaterThan(0)
    }
  })

  it('同一包名不得同时出现在 baseline / excluded / 首方名单里', () => {
    const names = [
      ...manifest.baseline.map(entry => entry.name),
      ...manifest.excluded.map(entry => entry.name),
      ...manifest.packagedFirstParty,
    ]
    expect(new Set(names).size).toBe(names.length)
  })

  it('已排除的插件没有偷偷回到基线里', () => {
    const baselineNames = new Set(manifest.baseline.map(entry => entry.name))
    for (const entry of manifest.excluded) {
      expect(baselineNames.has(entry.name)).toBe(false)
    }
  })
})

/**
 * 从 platform/shared/manifests/skillhub-seed.manifest.json 生成
 * platform/dsh-plugins/lumo-ui/src/generated/skillhub-seed.ts。
 *
 * 用法：
 *   node tools/gen-skillhub-seed.mjs            # 写盘
 *   node tools/gen-skillhub-seed.mjs --check    # 只校验是否陈旧，陈旧则退出码 1
 *
 * 为什么要有生成器，而不是让 lumo-ui 直接 import 清单：
 * ① lumo-ui 的 tsconfig 是 `rootDir: src`，跨出包边界的 import 直接编译失败；
 * ② 这份数据是 SkillHub 不可达时的**最后兜底**（refreshCatalog → 磁盘缓存 → 本数据），必须
 *    编译进包，不能改成运行期读文件 —— 多一个文件读取就多一个失败点。
 * 生成物落在包内、随包构建，运行期一定在；代价是必须锁住它与原件的一致性
 * （见 shared/manifests/__tests__/skillhub-seed.spec.ts 的漂移锁）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(platformRoot, 'shared', 'manifests', 'skillhub-seed.manifest.json')
const outputPath = resolve(platformRoot, 'dsh-plugins', 'lumo-ui', 'src', 'generated', 'skillhub-seed.ts')
const checkOnly = process.argv.includes('--check')

/**
 * 三类条目的字段契约。顺序即生成物里的字段顺序 —— 必须显式写死，不能沿用 JSON 的键序，
 * 否则清单里挪一下键的位置就会让生成物「看起来变了」。
 * 第三项是分类字段名：技能用 `tag`，专家包与插件用 `category`。
 */
const KINDS = [
  {
    key: 'skills',
    constName: 'SEED_SKILLS',
    interfaceName: 'SeedSkill',
    categoryField: 'tag',
    fields: [
      ['id', 'string'], ['name', 'string'], ['tag', 'string'], ['description', 'string'],
      ['rating', 'number'], ['downloads', 'number'], ['source', 'string'],
      ['verified', 'boolean'], ['command', 'string'], ['apiKey', 'boolean'],
    ],
  },
  {
    key: 'packs',
    constName: 'SEED_PACKS',
    interfaceName: 'SeedPack',
    categoryField: 'category',
    fields: [
      ['id', 'string'], ['name', 'string'], ['role', 'string'], ['category', 'string'],
      ['description', 'string'], ['skills', 'number'], ['source', 'string'], ['command', 'string'],
    ],
  },
  {
    key: 'plugins',
    constName: 'SEED_PLUGINS',
    interfaceName: 'SeedPlugin',
    categoryField: 'category',
    fields: [
      ['id', 'string'], ['name', 'string'], ['category', 'string'], ['description', 'string'],
      ['stars', 'number'], ['forks', 'number'], ['source', 'string'],
      ['installable', 'boolean'], ['repo', 'string'],
    ],
  },
]

const CATEGORY_CONSTS = { skills: 'SKILL_CATEGORIES', packs: 'PACK_CATEGORIES', plugins: 'PLUGIN_CATEGORIES' }

/** 失败即抛：清单是构建输入，宁可在这里红，也不要把半成品写进生成物。 */
function fail(message) {
  throw new Error(`${message}\n清单：${manifestPath}`)
}

function requireText(value, where) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${where} 必须是非空字符串`)
  return value
}

function readManifest() {
  let raw
  try {
    raw = readFileSync(manifestPath, 'utf8')
  } catch (error) {
    fail(`读不到清单原件：${error instanceof Error ? error.message : String(error)}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    fail(`清单不是合法 JSON：${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) fail('清单根节点必须是对象')
  return parsed
}

function normalize(manifest) {
  requireText(manifest.title, 'title')
  requireText(manifest.description, 'description')
  const source = requireText(manifest.source, 'source')

  if (typeof manifest.categories !== 'object' || manifest.categories === null) fail('categories 必须是对象')

  const categories = {}
  for (const { key } of KINDS) {
    const list = manifest.categories[key]
    if (!Array.isArray(list) || list.length === 0) fail(`categories.${key} 必须是非空数组`)
    categories[key] = list.map((label, index) => requireText(label, `categories.${key}[${index}]`))
    if (new Set(categories[key]).size !== categories[key].length) fail(`categories.${key} 有重复项`)
  }

  const entries = {}
  for (const { key, fields, categoryField } of KINDS) {
    const list = manifest[key]
    if (!Array.isArray(list) || list.length === 0) fail(`${key} 必须是非空数组`)

    entries[key] = list.map((entry, index) => {
      const where = `${key}[${index}]`
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(`${where} 必须是对象`)

      const declared = new Set(fields.map(([name]) => name))
      const extra = Object.keys(entry).filter(name => !declared.has(name))
      if (extra.length > 0) fail(`${where} 有未声明的字段：${extra.join(', ')}（生成器与 schema 都要求封闭）`)

      const normalized = {}
      for (const [name, type] of fields) {
        const value = entry[name]
        if (type === 'string') {
          normalized[name] = requireText(value, `${where}.${name}`)
        } else if (type === 'number') {
          if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
            fail(`${where}.${name} 必须是非负整数：${String(value)}`)
          }
          normalized[name] = value
        } else {
          if (typeof value !== 'boolean') fail(`${where}.${name} 必须是布尔值：${String(value)}`)
          normalized[name] = value
        }
      }

      // 分类必须落在该 kind 的分类字典里，否则 UI 的筛选下拉里会多出一个筛不出东西的选项。
      const label = normalized[categoryField]
      if (!categories[key].includes(label)) fail(`${where}.${categoryField} 「${label}」不在 categories.${key} 里`)
      return normalized
    })

    const ids = entries[key].map(entry => entry.id)
    if (new Set(ids).size !== ids.length) fail(`${key} 里有重复 id`)
  }

  return { source, categories, entries }
}

/** 生成物里的字符串字面量：仓库风格是单引号，这里显式转义。 */
function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function literal(value, type) {
  if (type === 'string') return quote(value)
  if (type === 'number') return String(value)
  return value ? 'true' : 'false'
}

/** 每个条目压成一行：与它替换掉的手写数组同形，生成物 diff 才读得懂。 */
function renderEntries(entries, fields) {
  return entries
    .map(entry => `  { ${fields.map(([name, type]) => `${name}: ${literal(entry[name], type)}`).join(', ')} },`)
    .join('\n')
}

function renderInterfaces() {
  return KINDS.map(({ interfaceName, fields, key }) => {
    const notes = {
      rating: '  /** 评分。远端快照，不要手改。 */',
      downloads: '  /** 下载量。远端快照，不要手改。 */',
      stars: '  /** Star 数。远端快照，不要手改。 */',
      forks: '  /** Fork 数。远端快照，不要手改。 */',
      skills: '  /** 包含的技能数量。 */',
    }
    const body = fields
      .map(([name, type]) => (notes[name] ? `${notes[name]}\n` : '') + `  ${name}: ${type}`)
      .join('\n')
    return `/** \`${key}\` 里的一个条目（SkillHub 首页快照的子集）。 */\nexport interface ${interfaceName} {\n${body}\n}`
  }).join('\n\n')
}

function render({ source, categories, entries }) {
  const interfaces = renderInterfaces()

  const arrays = KINDS.map(({ key, constName, interfaceName, fields }) => [
    `/** 离线兜底用的${key === 'skills' ? '技能' : key === 'packs' ? '专家包' : '插件'}列表（顺序 = 清单顺序）。 */`,
    `export const ${constName}: ${interfaceName}[] = [`,
    renderEntries(entries[key], fields),
    ']',
  ].join('\n')).join('\n\n')

  const categoryArrays = KINDS.map(({ key }) => [
    `export const ${CATEGORY_CONSTS[key]}: string[] = [`,
    categories[key].map(label => `  ${quote(label)},`).join('\n'),
    ']',
  ].join('\n')).join('\n\n')

  return `/**
 * 本文件由 platform/tools/gen-skillhub-seed.mjs 生成，请勿手工编辑。
 *
 * 真相源：platform/shared/manifests/skillhub-seed.manifest.json
 * 重新生成：pnpm run codegen:skillhub-seed
 * 一致性：platform/shared/manifests/__tests__/skillhub-seed.spec.ts 的漂移锁
 *
 * 为什么是生成物而不是直接 import 清单：lumo-ui 的 tsconfig 是 rootDir: src，跨出包边界的
 * import 直接编译失败；且这份数据是 SkillHub 不可达时的最后兜底，必须编译进包，不能变成
 * 运行期文件读取。
 *
 * 注意：本文件是远端数据的**镜像**（rating / downloads / stars / forks 都是抓取那一刻的
 * 快照）。重新同步时整表替换，不要逐条手改。
 */

${interfaces}

${arrays}

${categoryArrays}

/** 种子数据的来源站点。 */
export const SKILLHUB_SEED_SOURCE: string = ${quote(source)}
`
}

function main() {
  const normalized = normalize(readManifest())
  const expected = render(normalized)

  if (checkOnly) {
    let actual
    try {
      actual = readFileSync(outputPath, 'utf8')
    } catch {
      console.error(`生成物缺失：${outputPath}\n请运行 pnpm run codegen:skillhub-seed`)
      process.exitCode = 1
      return
    }
    if (actual !== expected) {
      console.error(
        `生成物与清单不一致：${outputPath}\n`
        + '清单改过但没重新生成，或生成物被手工编辑过。请运行 pnpm run codegen:skillhub-seed 后提交。',
      )
      process.exitCode = 1
      return
    }
    console.log(
      `SkillHub 种子生成物与清单一致（技能 ${normalized.entries.skills.length}、`
      + `专家包 ${normalized.entries.packs.length}、插件 ${normalized.entries.plugins.length}）`,
    )
    return
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, expected)
  console.log(
    `已生成 ${outputPath}`
    + `（技能 ${normalized.entries.skills.length}、专家包 ${normalized.entries.packs.length}、`
    + `插件 ${normalized.entries.plugins.length}）`,
  )
}

main()

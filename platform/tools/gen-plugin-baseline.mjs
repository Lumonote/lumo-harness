/**
 * 从 platform/shared/manifests/plugin-baseline.manifest.json 生成
 * platform/data-plane/dsh-node/src/generated/plugin-baseline.ts。
 *
 * 用法：
 *   node tools/gen-plugin-baseline.mjs            # 写盘
 *   node tools/gen-plugin-baseline.mjs --check    # 只校验是否陈旧，陈旧则退出码 1
 *
 * 为什么要有生成器，而不是让 dsh-node 直接 import 清单：
 * dsh-node 不是打包产物，用 `tsx src/index.ts` 直跑源码；打包后的 runtime 里它的位置是
 * `<runtime>/node_modules/@lumo/dsh-node/src/plugins.ts`，按相对路径上溯到的是 node_modules
 * 而不是仓库，所以运行期读不到 platform/shared/ 下的文件。生成物落在包内、随包复制，
 * 运行期一定在；代价是必须锁住它与原件的一致性（见 shared/manifests/__tests__/）。
 *
 * desktop/build-runtime.mjs 不需要生成器：它在构建期、在仓库内运行，直接读清单原件。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = resolve(platformRoot, 'shared', 'manifests', 'plugin-baseline.manifest.json')
const outputPath = resolve(platformRoot, 'data-plane', 'dsh-node', 'src', 'generated', 'plugin-baseline.ts')
const checkOnly = process.argv.includes('--check')

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/
const PACKAGE_NAME_PATTERN = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/

/** 失败即抛：清单是构建输入，宁可在这里红，也不要把半成品写进生成物。 */
function fail(message) {
  throw new Error(`${message}\n清单：${manifestPath}`)
}

function requireText(value, where) {
  if (typeof value !== 'string' || value === '') fail(`${where} 必须是非空字符串`)
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

/** 校验并归一化清单；返回生成所需的最小结构。 */
function normalize(manifest) {
  requireText(manifest.title, 'title')
  requireText(manifest.description, 'description')
  requireText(manifest.policy, 'policy')

  if (!Array.isArray(manifest.baseline) || manifest.baseline.length === 0) fail('baseline 必须是非空数组')
  if (!Array.isArray(manifest.excluded)) fail('excluded 必须是数组')
  if (!Array.isArray(manifest.packagedFirstParty) || manifest.packagedFirstParty.length === 0) {
    fail('packagedFirstParty 必须是非空数组')
  }

  const baseline = manifest.baseline.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(`baseline[${index}] 必须是对象`)
    const name = requireText(entry.name, `baseline[${index}].name`)
    const version = requireText(entry.version, `baseline[${index}].version`)
    const note = requireText(entry.note, `baseline[${index}].note`)
    if (!PACKAGE_NAME_PATTERN.test(name)) fail(`baseline[${index}].name 不是合法 npm 包名：${name}`)
    if (!VERSION_PATTERN.test(version)) {
      fail(`baseline[${index}].version 必须是精确版本（x.y.z），不接受范围写法：${version}`)
    }
    return { name, version, note, spec: `${name}@${version}` }
  })

  const excluded = manifest.excluded.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(`excluded[${index}] 必须是对象`)
    return {
      name: requireText(entry.name, `excluded[${index}].name`),
      reason: requireText(entry.reason, `excluded[${index}].reason`),
    }
  })

  const packagedFirstParty = manifest.packagedFirstParty.map((name, index) => {
    requireText(name, `packagedFirstParty[${index}]`)
    if (!PACKAGE_NAME_PATTERN.test(name)) fail(`packagedFirstParty[${index}] 不是合法 npm 包名：${name}`)
    return name
  })

  // 同一批包名不得出现在多个名单里：重复会掩盖「已排除却仍被安装」这类矛盾。
  const seen = new Map()
  for (const [list, names] of [
    ['baseline', baseline.map(entry => entry.name)],
    ['excluded', excluded.map(entry => entry.name)],
    ['packagedFirstParty', packagedFirstParty],
  ]) {
    for (const name of names) {
      const previous = seen.get(name)
      if (previous !== undefined) fail(`包名 ${name} 同时出现在 ${previous} 与 ${list}`)
      seen.set(name, list)
    }
  }

  return { baseline, excluded, packagedFirstParty }
}

/** 生成物里的字符串字面量：仓库风格是单引号，这里显式转义。 */
function quote(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`
}

function render({ baseline, excluded, packagedFirstParty }) {
  const pins = baseline
    .map(entry => [
      '  {',
      `    name: ${quote(entry.name)},`,
      `    version: ${quote(entry.version)},`,
      `    spec: ${quote(entry.spec)},`,
      `    note: ${quote(entry.note)},`,
      '  },',
    ].join('\n'))
    .join('\n')

  const exclusions = excluded
    .map(entry => [
      '  {',
      `    name: ${quote(entry.name)},`,
      `    reason: ${quote(entry.reason)},`,
      '  },',
    ].join('\n'))
    .join('\n')

  const firstParty = packagedFirstParty.map(name => `  ${quote(name)},`).join('\n')

  return `/**
 * 本文件由 platform/tools/gen-plugin-baseline.mjs 生成，请勿手工编辑。
 *
 * 真相源：platform/shared/manifests/plugin-baseline.manifest.json
 * 重新生成：pnpm run codegen:plugin-baseline
 * 一致性：platform/shared/manifests/__tests__/plugin-baseline.spec.ts 的漂移锁
 *
 * 为什么是生成物而不是直接 import 清单：dsh-node 用 tsx 直跑源码，打包后的 runtime 里它位于
 * <runtime>/node_modules/@lumo/dsh-node/，按相对路径上溯到的是 node_modules 而非仓库，
 * 运行期读不到 platform/shared/。生成物落在包内、随包复制，运行期一定在。
 */

/** 一条基线插件 pin。 */
export interface BaselinePluginPin {
  /** npm 包名。 */
  name: string
  /** 精确版本；不接受范围写法，桌面构建不得因 registry 上的 tag 移动而改变行为。 */
  version: string
  /** \`name@version\`，安装时直接使用。 */
  spec: string
  /** 这个插件是什么、为什么钉这个版本。 */
  note: string
}

/** 桌面包固定安装的上游社区插件（顺序 = 清单顺序）。 */
export const BASELINE_PLUGIN_PINS: readonly BaselinePluginPin[] = [
${pins}
]

/** 曾被考虑但已移出基线的插件。保留是为了防止有人再把它加回来。 */
export const BASELINE_EXCLUDED_PLUGINS: readonly { name: string; reason: string }[] = [
${exclusions}
]

/** 首方模块中需要 symlink 进 DSH_HOME/profiles/node_modules 的那部分。 */
export const PACKAGED_FIRST_PARTY_MODULES: readonly string[] = [
${firstParty}
]

/**
 * 打包 runtime 下需要 symlink 进 DSH_HOME/profiles/node_modules 的完整名单。
 * = 首方名单 + 基线包名。漏一个时 Loader 报 Cannot find package，整棵插件树挂载失败，
 * 因此这里由清单拼装而不是手抄。
 */
export const PACKAGED_PROFILE_MODULES: readonly string[] = [
  ...PACKAGED_FIRST_PARTY_MODULES,
  ...BASELINE_PLUGIN_PINS.map(pin => pin.name),
]
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
      console.error(`生成物缺失：${outputPath}\n请运行 pnpm run codegen:plugin-baseline`)
      process.exitCode = 1
      return
    }
    if (actual !== expected) {
      console.error(
        `生成物与清单不一致：${outputPath}\n`
        + '清单改过但没重新生成，或生成物被手工编辑过。请运行 pnpm run codegen:plugin-baseline 后提交。',
      )
      process.exitCode = 1
      return
    }
    console.log(`基线插件生成物与清单一致（${normalized.baseline.length} 条基线 pin）`)
    return
  }

  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, expected)
  console.log(
    `已生成 ${outputPath}`
    + `（基线 ${normalized.baseline.length} 条、排除 ${normalized.excluded.length} 条、`
    + `首方 ${normalized.packagedFirstParty.length} 条）`,
  )
}

main()

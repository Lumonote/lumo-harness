#!/usr/bin/env node
/**
 * 合成 dsh workspace 各包运行时入口 `lib/<stem>.js`（tsdown 的等价产物）。
 *
 * 为什么需要：上游 master 重构期（2026-09）其 tsdown 根配置对 dsh-root 的
 * 花括号条目解析断裂（`Cannot find entry: ["lib/types/{index,invariant,startup}.js"]`），
 * 且宿主侧 lib 产物存在日期不一致——runtime 复制旧产物导致打包启动崩溃
 * （dsh-brand 空壳 / SESSION_CONTROLLER_REMOTE_EVENTS 缺失 / session-turn-outline 缺 lib）。
 * 而 `tsc -b tsconfig.host.json / tsconfig.client.json` 的引用图 emit 是正常的
 * （212 个组合项目全部产出 lib/types/*.js，零 error）。
 *
 * tsdown 主机面产物的语义 = 「把 lib/types/*.js 打包合并进 lib/<stem>.js」；
 * 对 ESM 包，`export * from './types/<stem>.js'` 与其可互换（运行时 named-export
 * 检测走同一份静态分析，declarations 不变）；CJS 包用 require 转发。本脚本按
 * package.json `type` 选形。不触碰 dsh 源码与 package.json（artifacts only）。
 *
 * 与 `export *` 的差异：**只 re-export named**。模板里的 loader 入口型包
 * （typert-registry / api-gateway / client-modules，`export default <plugin class>`）
 * 若只用 `export *`，default 会被丢掉——cordis-plugin-loader 的 unwrapExports
 * 拿 `default ?? module`，得到空对象即报 "invalid plugin ... received object"。
 * 因此 types 里声明 default 时补一行显式 default 转发；`apply`-named 型模块
 * 无需处理（命名导出本身就是命名空间对象的属性）。
 *
 * 第二处同类差异：**打在扁平层上的自引用清单**（见 syncFlatManifest）。tsdown 打包把
 * 语句从 `lib/types/` 搬到扁平的 `lib/`，相对路径随之从「`lib/`」变成「包根」；
 * `export *` 转发不做这次搬迁，于是 `'../package.json'` 落空。只对真的自引用的包补。
 *
 * 幂等：重复运行按当前 lib/types 内容重写。
 *
 * 另外按 package.json 自己声明的入口名补齐**缺失的** ESM 入口（见 declaredLibEntries）：
 * 绝大多数包声明 `lib/index.js`，与按 `lib/types/<stem>.js` 推出的名字一致；但
 * `vendor/schemastery`（唯一 vendor 进来的外部 npm 项目）声明 `lib/index.mjs`，
 * 于是全新检出（CI 无上游 tsdown 残留）时会缺文件、解析失败。该补齐**只在目标
 * 不存在时写**，绝不覆盖上游真实 bundle；`.cjs` 不补（ESM 无法忠实同步再导出成 CJS）。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const dshRoot = process.env.LUMO_DSH_SOURCE_ROOT === undefined
  ? resolve(repoRoot, 'deepseek-harness')
  : resolve(process.env.LUMO_DSH_SOURCE_ROOT)

/** 目录项判断：packages/* 下混有 AGENTS.md 这类文件，跳过。 */
function subdirs(parent) {
  return readdirSync(parent)
    .map(name => join(parent, name))
    .filter(candidate => statSync(candidate).isDirectory())
}

function packageDirs(root) {
  const found = []
  for (const [dir, depth] of [['packages', 2], ['vendor', 1], ['apps', 2]]) {
    const base = join(root, dir)
    if (!existsSync(base)) continue
    if (depth === 1) {
      found.push(...subdirs(base))
    } else {
      for (const group of subdirs(base)) found.push(...subdirs(group))
    }
  }
  found.push(root) // dsh-root（根包）
  return found
}

/** 判定 tsc 产物是否带 default 导出：字面 `export default X` 或再导出 `export { default } from …`。 */
function hasDefaultExport(source) {
  return /\bexport\s+default\b/u.test(source) || /export\s*\{[^}]*\bdefault\b[^}]*\}/u.test(source)
}

/** ESM 入口内容：薄再导出，与 tsdown 打包结果在 named-export 语义上等价。 */
function esmEntry(stem, hasDefault) {
  return `export * from './types/${stem}.js';\n${hasDefault ? `export { default } from './types/${stem}.js';\n` : ''}`
}

/**
 * 编译产物里「读自己的清单」的形态。上游 `packages/llm/llm/src/attribution.ts:16` 与
 * `packages/session/session-telemetry-otel/src/index.ts` 都这么取版本号，源码注释把
 * 契约写得很直白：*"the relative path resolves from both `src/` and the bundled `lib/`"* ——
 * 因为 tsdown 把 `lib/types/index.js` 打包成**扁平**的 `lib/index.js`，语句跟着搬家，
 * `'../package.json'` 正好等于包根清单。
 */
const MANIFEST_SELF_REFERENCE = /\bcreateRequire\s*\(\s*import\.meta\.url\s*\)\s*\(\s*'\.\.\/package\.json'\s*\)/u

/**
 * 扁平层清单：把自引用会读到的两个字段投影到 `lib/package.json`。
 *
 * 为什么需要：本脚本用 `export *` 替代打包，named-export 语义等价，但**语句位置没搬迁** ——
 * 自引用仍留在 `lib/types/<stem>.js`，`'../package.json'` 于是指向 `lib/package.json`，
 * 落空即 `Cannot find module '../package.json'`。该模块一被 import 就抛，属于**收集期**
 * 失败（`session-log/__tests__/backfill.spec.ts` 于 2026-09-15 实测：0 test、报错指回
 * `lib/types/attribution.js`，与 DSN 无关），修的是「活体用例根本没机会跑」。
 *
 * 为什么只投影 `type` + `version`、**刻意不写 `name`**：
 *   - `type` 必须与包根一致，否则 `lib/` 下的 `.js` 会被当成 CJS（本仓库两个受影响包都是
 *     `module`）；
 *   - 不写 `name`，包内若出现 `import '<本包名>'` 的**自我引用**，解析会**走过**这一层、
 *     落回真正的包根清单；若写了 `name`，自我引用会命中最内层并按其 `exports` 相对 `lib/`
 *     解析，静默指向 `lib/lib/...`。当前两处都没有自我引用（2026-09-15 核查），这条是
 *     留给以后的安全边界；
 *   - 同理不投影 `main` / `exports`：那会让「把 `lib/` 当包根解析」的调用方拿到错路径。
 */
function syncFlatManifest(packageDir, typesDir, jsFiles, pkg) {
  const readsOwnManifest = jsFiles.some(file =>
    MANIFEST_SELF_REFERENCE.test(readFileSync(join(typesDir, file), 'utf8')))
  if (!readsOwnManifest) return false
  const projected = `${JSON.stringify({ type: pkg.type, version: pkg.version }, null, 2)}\n`
  const target = join(packageDir, 'lib', 'package.json')
  if (existsSync(target) && readFileSync(target, 'utf8') === projected) return false
  writeFileSync(target, projected)
  return true
}

/**
 * 收集包自己声明的、落在 `lib/` 下的入口相对路径（`exports` 任意层级 + `main` + `module`）。
 * 绝大多数 dsh 包声明的是 `lib/index.js`，与按 `lib/types/<stem>.js` 推出的文件名一致；
 * 少数包（vendored 外部项目）声明的是别的文件名，必须按声明补。
 */
function declaredLibEntries(pkg) {
  const found = new Set()
  const visit = node => {
    if (typeof node === 'string') {
      const normalized = node.replace(/^\.\//u, '')
      if (normalized.startsWith('lib/')) found.add(normalized)
      return
    }
    if (node === null || typeof node !== 'object') return
    for (const value of Object.values(node)) visit(value)
  }
  visit(pkg.exports)
  visit(pkg.main)
  visit(pkg.module)
  return found
}

let synthesized = 0
let flatManifests = 0
const skipped = []

for (const packageDir of packageDirs(dshRoot)) {
  const packageJsonPath = join(packageDir, 'package.json')
  if (!existsSync(packageJsonPath)) continue
  const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'))
  const typesDir = join(packageDir, 'lib', 'types')
  if (!existsSync(typesDir)) continue
  const jsFiles = readdirSync(typesDir).filter(name => name.endsWith('.js'))
  const isModule = pkg.type === 'module'
  for (const file of jsFiles) {
    const stem = file.slice(0, -3)
    const out = join(packageDir, 'lib', `${stem}.js`)
    const typed = readFileSync(join(typesDir, file), 'utf8')
    // 两种默认导出形态：字面 `export default X`，或 tsc 的再导出
    // `export { default, ... } from './service.js'`（star export 会把后者丢掉）。
    // 两种都必须补显式 default 转发，否则 loader 包拿不到 default。
    writeFileSync(out, isModule
      ? esmEntry(stem, hasDefaultExport(typed))
      : `"use strict";\nmodule.exports = require('./types/${stem}.js');\n`)
    synthesized++
  }

  // 上面只产出 `lib/<stem>.js`，但少数包的 `exports` 指向**别的文件名**：
  // `vendor/schemastery`（唯一 vendor 进来的外部 npm 项目）声明
  // `exports["."].import = ./lib/index.mjs`、`main = ./lib/index.cjs`。全新检出时
  // （CI 没有上游 tsdown 残留产物）`lib/index.mjs` 不存在 → vitest 解析报
  // `Failed to resolve entry for package "@deepseek-ai/schemastery"`。
  // 这里按包自己的声明补齐**缺失的 ESM 入口**，内容与 `lib/<stem>.js` 同形。
  //
  // 两条边界：① 只在目标不存在时写 —— 纯增量，绝不覆盖上游真实 bundle，本机行为不变；
  // ② 不补 `.cjs` —— ESM 无法被忠实地同步再导出成 CJS，而 ESM 消费方（vitest、
  // Node `import`）走的是 `import` 条件，正是失败的那条路径。
  for (const entry of declaredLibEntries(pkg)) {
    if (!entry.endsWith('.mjs')) continue
    const out = join(packageDir, entry)
    if (existsSync(out)) continue
    const stem = basename(entry).replace(/\.mjs$/u, '')
    const typedPath = join(typesDir, `${stem}.js`)
    if (!existsSync(typedPath)) {
      skipped.push(`${pkg.name ?? packageDir}: ${entry}（缺 lib/types/${stem}.js）`)
      continue
    }
    writeFileSync(out, esmEntry(stem, hasDefaultExport(readFileSync(typedPath, 'utf8'))))
    synthesized++
  }

  // 自引用清单的包（llm/llm、session-telemetry-otel）在扁平层补一份最小清单，
  // 否则它们的 `'../package.json'` 一 import 就抛。见 syncFlatManifest。
  if (syncFlatManifest(packageDir, typesDir, jsFiles, pkg)) flatManifests++
}

console.log(`synthesize-dsh-libs: wrote ${synthesized} lib entry re-exports under ${dshRoot}`)
if (flatManifests > 0) {
  console.log(`synthesize-dsh-libs: wrote ${flatManifests} flat-layer package.json for manifest self-references`)
}
if (skipped.length > 0) {
  console.warn(`synthesize-dsh-libs: ${skipped.length} declared entry(ies) had no lib/types source:\n  ${skipped.join('\n  ')}`)
}

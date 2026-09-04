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
 * 幂等：重复运行按当前 lib/types 内容重写。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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

let synthesized = 0
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
    const hasDefault = /\bexport\s+default\b/u.test(typed)
      || /export\s*\{[^}]*\bdefault\b[^}]*\}/u.test(typed)
    writeFileSync(out, isModule
      ? `export * from './types/${stem}.js';\n${hasDefault ? `export { default } from './types/${stem}.js';\n` : ''}`
      : `"use strict";\nmodule.exports = require('./types/${stem}.js');\n`)
    synthesized++
  }
}

console.log(`synthesize-dsh-libs: wrote ${synthesized} lib entry re-exports under ${dshRoot}`)

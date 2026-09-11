import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'

// 桌面构建链的 DSH Client 面类型前置检查：快照里「哪些项目必须先有 tsc 产物」
// 的名单规则。这条规则错了只会在全新克隆上炸成 tsdown 的 UNRESOLVED_ENTRY，
// 所以单独成模块、与 build-runtime.mjs 的构建步骤分开读。

/** 包是否从 src/client/index.ts 编译出浏览器半（lib/types/client/index.js）。 */
function hasDshClientSource(packageDirectory) {
  return existsSync(resolve(packageDirectory, 'src', 'client', 'index.ts'))
}

// The root Client tsdown workspace consumes each client package's emitted
// `lib/types/index.js`. A package-local build can be absent, or its sourcemap
// can still name a source file removed by a newer upstream checkout. Detect
// both cases from the staged tree so the repair stays inside the snapshot.
// 名单不等于 packages/client/*：Client 编译面还拥有 packages/api、
// packages/experimental、packages/extensions、packages/session-query 下的
// face-specific 叶子项目，clientBundle() 的浏览器入口 lib/types/client/index.js
// 只有它们会产出（host 面从不编译 src/client/**）。按目录名枚举会漏掉这些包，
// 全新克隆因此只带 host 面产物进快照，Client tsdown 序当场 UNRESOLVED_ENTRY。
//
// 还有第二类漏网：没有 src/client 的纯 Node 客户端库（tsdown 走
// clientLibrary()/clientOnly，只在 Client 面构建），入口同样是被 Client tsdown
// 消费的 lib/types/index.js。它们既不在 packages/client 组，也没有 src/client，
// 按下面的启发式会被整包漏掉——test-support/remote-mock 就是这么在 Client 序
// 炸 UNRESOLVED_ENTRY 的。这类包由 tsconfig.client.json 的 references 兜底枚举。
export function dshClientTypeConfigs(root) {
  const configs = new Set()
  const packagesRoot = resolve(root, 'packages')
  if (existsSync(packagesRoot)) {
    for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!group.isDirectory()) continue
      const groupRoot = resolve(packagesRoot, group.name)
      for (const entry of readdirSync(groupRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const directory = join('packages', group.name, entry.name)
        if (!existsSync(resolve(root, directory, 'tsdown.config.ts'))) continue
        // packages/client/* 整组都在 Client 面（含只做 staticLinked 的包，
        // 它们的入口同样是 lib/types）；组外只认真的产出浏览器半的包。
        if (group.name !== 'client' && !hasDshClientSource(resolve(root, directory))) continue
        const config = dshClientTypeConfig(root, directory)
        if (config !== undefined) configs.add(config)
      }
    }
  }
  // Client tsc 聚合项目点名了整张 Client 编译图：凡在该图里、又有 tsdown.config.ts
  // 的包，其 lib/types 都会被 Client tsdown 消费。这一层与上面的启发式取并集，
  // 顺序无关（Set 去重），已存在的包不受影响。
  for (const directory of dshClientReferencedDirectories(root)) {
    if (!existsSync(resolve(root, directory, 'tsdown.config.ts'))) continue
    const config = dshClientTypeConfig(root, directory)
    if (config !== undefined) configs.add(config)
  }
  return [...configs]
}

/** 包本地 Client tsc 配置：优先 tsconfig.json，其次 tsconfig.client.json。 */
function dshClientTypeConfig(root, directory) {
  const name = ['tsconfig.json', 'tsconfig.client.json']
    .find((candidate) => existsSync(resolve(root, directory, candidate)))
  return name === undefined ? undefined : join(directory, name)
}

// tsconfig.client.json 是 JSONC（注释 + 行尾逗号），不整体 parse，只按 key 取
// references 的 path 字符串。引用可以指向包目录，也可以直接指向 tsconfig 文件。
// 只认 packages/<group>/<package> 这一层，挡掉嵌套 tsconfig 与工作区外引用。
const TSCONFIG_REFERENCE_PATH = /"path"\s*:\s*"([^"]+)"/g

function dshClientReferencedDirectories(root) {
  const aggregate = resolve(root, 'tsconfig.client.json')
  if (!existsSync(aggregate)) return []
  const directories = new Set()
  for (const match of readFileSync(aggregate, 'utf8').matchAll(TSCONFIG_REFERENCE_PATH)) {
    const reference = match[1]
    if (!reference.startsWith('.')) continue
    const target = resolve(root, reference)
    const directory = relative(root, reference.endsWith('.json') ? dirname(target) : target)
      .split(sep).join('/')
    if (/^packages\/[^/]+\/[^/]+$/.test(directory)) directories.add(directory)
  }
  return [...directories].sort()
}

export function hasUsableDshClientTypes(root, config) {
  const packageDirectory = resolve(root, dirname(config))
  const entry = resolve(packageDirectory, 'lib', 'types', 'index.js')
  if (!existsSync(entry)) return false
  // clientBundle() 在 Client 面把入口解析为 lib/types/client/index.js，而只有
  // Client tsc 序会产出它。只跑过 host 面的树能通过上面的 node 半探测，却仍在
  // Client tsdown 序失败——这正是全新克隆（CI 桌面 job、新机器）的失败形态。
  if (hasDshClientSource(packageDirectory)
    && !existsSync(resolve(packageDirectory, 'lib', 'types', 'client', 'index.js'))) return false
  if (config === 'packages/client/ui-slots/tsconfig.json') {
    const declaration = resolve(packageDirectory, 'lib', 'types', 'index.d.ts')
    if (!existsSync(declaration) || !readFileSync(declaration, 'utf8').includes('ResourceProtocolMap')) return false
  }
  const typesDirectory = resolve(packageDirectory, 'lib', 'types')
  if (!existsSync(typesDirectory)) return false
  if (config === 'packages/client/web/tsconfig.json' && !hasFreshDshClientWebSeed(packageDirectory, typesDirectory)) return false
  return dshClientMapsHaveSources(typesDirectory)
}

function hasFreshDshClientWebSeed(packageDirectory, typesDirectory) {
  for (const [sourceName, outputName] of [['platform.ts', 'platform.js'], ['seed.ts', 'seed.js']]) {
    const sourcePath = resolve(packageDirectory, 'src', sourceName)
    const outputPath = resolve(typesDirectory, outputName)
    if (!existsSync(sourcePath) || !existsSync(outputPath)) return false
    const source = readFileSync(sourcePath, 'utf8')
    const output = readFileSync(outputPath, 'utf8')
    const specifiers = [...source.matchAll(/['"](@deepseek-ai\/[^'"]+)['"]/g)].map((match) => match[1])
    if (specifiers.some((specifier) => !output.includes(specifier))) return false
  }
  return true
}

function dshClientMapsHaveSources(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) {
      if (!dshClientMapsHaveSources(path)) return false
      continue
    }
    if (!entry.name.endsWith('.js.map')) continue
    let map
    try {
      map = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return false
    }
    if (!Array.isArray(map.sources) || map.sources.some((source) => typeof source !== 'string')) return false
    if (Array.isArray(map.sourcesContent)
      && map.sourcesContent.length === map.sources.length
      && map.sourcesContent.every((source) => typeof source === 'string')) continue
    const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
    if (map.sources.some((source) => !existsSync(resolve(dirname(path), sourceRoot, source)))) return false
  }
  return true
}

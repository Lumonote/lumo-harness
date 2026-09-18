import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { applyLumoDshOverrides, overriddenPackageDirectories } from './apply.mjs'
import { assertPristineProductSource, git } from './assert-pristine.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))

// lib/ 是 gitignored 的构建产物，HEAD 覆盖不到它；而 copyBuildOutputs 会把源树的
// lib/ 原样投影进快照。源树重新 `pnpm run build` 之后如果指纹不变，快照就带着旧产物
// 继续用——上一轮 ui-sidebar 插槽缺失正是这么安静地漏出去的。把投影口径内的 lib/
// 内容一并哈希（与 copyBuildOutputs 走同一份目录清单，口径不会漂移），产物一变
// 快照自动重建。
// native/system 的 flock binding（packages/*/bin/*.node）也是 gitignored 构建产物，
// 且不在 lib/ 投影口径内：copyTrackedTree 只拷 git-tracked 文件，快照里平台包只剩
// package.json + prebuilds.json。运行期 flock 懒加载才 require 该文件，表现为打包
// app 平时正常、发消息（会话加锁）即报 "Cannot find module .../bin/system.node"。
// 与上游 AGENTS.md 的口径一致（仓库测试只编 host addon）：宿主平台包缺 bin 时先编
// 一次；全部已存在的 bin/ 再投影进快照并纳入指纹，重编后二进制一变快照自动重建。
// 源树里的平台目录名是 `<platform>-<arch>`（native/system/packages/darwin-x64），带
// node-addon-system- 前缀的是 npm 包名；build.ts 按目录名遍历，两者不可混用。
// 曾按 npm 包名拼源树路径，existsSync 恒假 → 编译被静默跳过，上面的症状就是这么漏出去的。
function hostNativeAddonDirectoryName() {
  // flock 仅支持 darwin/linux；win32 无平台包，build.ts --host-addon-only 也会空转。
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  return `${process.platform}-${process.arch}`
}

export function ensureNativeAddonsBuilt(sourceRoot) {
  const directoryName = hostNativeAddonDirectoryName()
  if (directoryName === null) return
  const packagesRoot = resolve(sourceRoot, 'native', 'system', 'packages')
  if (!existsSync(packagesRoot)) return // 源树没有该工作区（旧上游），无需处理
  const hostPackage = resolve(packagesRoot, directoryName)
  if (!existsSync(resolve(hostPackage, 'prebuilds.json'))) {
    // 认错目录名曾经只是静默跳过，代价由用户承担（见上）。宁可构建期硬失败。
    throw new Error(`Lumo DSH staging: ${hostPackage} 不存在（宿主平台包目录名应为 ${directoryName}）；上游 native/system 目录布局变了`)
  }
  const binDirectory = resolve(hostPackage, 'bin')
  if (existsSync(binDirectory)) return
  const tsx = resolve(sourceRoot, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx')
  if (!existsSync(tsx)) {
    throw new Error('Lumo DSH staging: native/system 平台包缺 bin/ 且源树无 tsx，请先在 deepseek-harness 执行 pnpm build:native-system')
  }
  const result = spawnSync(tsx, ['native/system/scripts/build.ts', '--host-addon-only'], { cwd: sourceRoot, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) {
    throw new Error(`Lumo DSH staging: 构建宿主 native addon 失败（${String(result.status ?? result.signal)}）`)
  }
  // build.ts 成功却没落盘 = 上游产物路径变了，投影进快照的仍是空 bin/。
  if (!existsSync(binDirectory)) {
    throw new Error(`Lumo DSH staging: build.ts 执行成功但 ${binDirectory} 仍不存在；上游 native addon 产物路径变了`)
  }
}

function projectedNativeBinDirectories(sourceRoot) {
  const packagesRoot = resolve(sourceRoot, 'native', 'system', 'packages')
  if (!existsSync(packagesRoot)) return []
  return readdirSync(packagesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => resolve(packagesRoot, entry.name, 'bin'))
    .filter((bin) => existsSync(bin))
}

function fingerprint(root) {
  const commit = git(root, ['rev-parse', 'HEAD']).trim()
  const hash = createHash('sha256')
  hash.update(readFileSync(resolve(scriptRoot, 'apply.mjs')))
  for (const libDirectory of projectedLibDirectories(root)) {
    hashTree(libDirectory, libDirectory, hash)
  }
  for (const binDirectory of projectedNativeBinDirectories(root)) {
    hashTree(binDirectory, binDirectory, hash)
  }
  return `${commit}:${hash.digest('hex')}`
}

function hashTree(root, directory, hash) {
  const entries = readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  for (const entry of entries) {
    const path = resolve(directory, entry.name)
    hash.update(relative(root, path))
    hash.update('\0')
    if (entry.isDirectory()) hashTree(root, path, hash)
    else if (entry.isSymbolicLink()) hash.update(readlinkSync(path))
    else hash.update(readFileSync(path))
    hash.update('\0')
  }
}

function copyTrackedTree(sourceRoot, targetRoot) {
  const tracked = git(sourceRoot, ['ls-files', '-z'], null)
  for (const relativePath of tracked.toString().split('\0').filter(Boolean)) {
    const source = resolve(sourceRoot, relativePath)
    const target = resolve(targetRoot, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    const stat = lstatSync(source)
    if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target)
    else copyFileSync(source, target)
  }
}

function linkWorkspaceModules(sourceRoot, targetRoot) {
  const manifests = git(sourceRoot, ['ls-files', '-z', '**/package.json', 'package.json'], null)
    .toString().split('\0').filter(Boolean)
  for (const manifest of manifests) {
    const sourceModules = resolve(sourceRoot, dirname(manifest), 'node_modules')
    if (!existsSync(sourceModules)) continue
    const targetModules = resolve(targetRoot, dirname(manifest), 'node_modules')
    // A clean temporary build snapshot may track its dependency symlinks so
    // the snapshot itself passes the pristine-source gate. copyTrackedTree
    // has already projected those links; do not attempt to create them twice.
    if (existsSync(targetModules)) continue
    mkdirSync(dirname(targetModules), { recursive: true })
    symlinkSync(sourceModules, targetModules, 'junction')
  }
}

// A handful of subpath exports (`@deepseek-ai/dsh-api-*/remote`, the web
// worker entry) resolve to tsdown output, not tsc output — nothing in the
// snapshot can regenerate them, and `lib/` is gitignored so copyTrackedTree
// leaves it behind. Project the upstream worktree's build outputs in, skipping
// the overridden packages so their patched sources really do get rebuilt.
// fingerprint() 用同一份目录清单决定哈希口径，两处必须始终一致。
function projectedLibDirectories(sourceRoot) {
  const skipped = new Set(overriddenPackageDirectories.map((directory) => resolve(sourceRoot, directory, 'lib')))
  const manifests = git(sourceRoot, ['ls-files', '-z', '**/package.json', 'package.json'], null)
    .toString().split('\0').filter(Boolean)
  return manifests
    .map((manifest) => resolve(sourceRoot, dirname(manifest), 'lib'))
    .filter((sourceLib) => !skipped.has(sourceLib) && existsSync(sourceLib))
}

function copyBuildOutputs(sourceRoot, targetRoot) {
  const libDirectories = projectedLibDirectories(sourceRoot)
  for (const sourceLib of libDirectories) {
    cpSync(sourceLib, resolve(targetRoot, relative(sourceRoot, sourceLib)), { recursive: true, dereference: true })
  }
  if (libDirectories.length === 0) {
    throw new Error(`Lumo DSH staging: ${sourceRoot} has no build outputs to project; run \`pnpm run build\` there first`)
  }
  // native/system 平台包的 bin/（flock binding）：gitignored，见文件头部说明。
  for (const sourceBin of projectedNativeBinDirectories(sourceRoot)) {
    cpSync(sourceBin, resolve(targetRoot, relative(sourceRoot, sourceBin)), { recursive: true, dereference: true })
  }
  return libDirectories.length
}

// 上游 master 重构期（2026-09）`pnpm run build` 的 tsdown 主机面被 dsh-root 的花括号
// entry 卡死（Cannot find entry: ["lib/types/{index,invariant,startup}.js"]），运行时
// 只有 `tsc -b` 的产物可用。tsc 引用图 emit 是正常的（0 error），我们把它当作 tsdown
// 的等价片段：按包 `type` 合成 `lib/<stem>.js` 再导出（见 synthesize-dsh-libs.mjs）。
// 返回 false 表示产物已是现行形态（常见的增量重复构建），跳过重建。
// 源树 lib/ 必须已含这些导出，否则视为停在旧构建：覆盖层包（LUMO_STREAM_RESILIENCE
// 点名的 session-controller 等）消费的上游 API 比源树最后一次全量构建更新时，快照会
// 拿旧 .d.ts 编译打过补丁的源码而当场失败（assistantStreamChunks / InboxState /
// SessionProjectionMap 'inbox' 缺失）。与 brandString 同路：重跑上游 host tsc 重建。
// 全新克隆（CI 桌面 job 的第一棒）—— 源树一个 lib/ 都没有：先走 host tsc +
// 合成重建，而不是让 copyBuildOutputs 报「没有构建产物」死掉。本地增量构建的
// lib/ 存在且探针新鲜，仍然跳过，零行为变化。client tsc 依赖 host tsdown
// 稍后生成的 typert remote 投影，由 build-runtime.mjs 的后续阶段负责。
const LIB_FRESHNESS_PROBES = [
  ['packages/util/brand/lib/types/index.js', 'brandString'],
  ['packages/llm/llm/lib/types/assistant-stream.d.ts', 'assistantStreamChunks'],
  ['packages/core/agent/lib/types/types.d.ts', 'InboxState'],
  // session-controller's host entry imports both symbols. A source checkout can
  // be current while this gitignored declaration still predates the file-manager
  // reveal API, which makes the first overridden host-package compile fail.
  ['packages/util/native-command/lib/types/index.d.ts', 'nativeFileManager'],
  ['packages/util/native-command/lib/types/index.d.ts', 'revealNativePath'],
  // 0.1.5-alpha.1 的 agent 显式化重构把 AgentSetup 收敛为 (agentCtx, agent) 双参；
  // 旧 lib 仍是单参（"Expected 2 or more, but got 1" 此形状）。session-controller
  // 的 host 类型编译依赖该签名，探针必须盯住 index.d.ts 这一行而不能只看 types.d.ts。
  ['packages/core/agent/lib/types/index.d.ts', '(agentCtx: Context, agent: Agent)'],
  // 11d6bd05f3 给 SkillSummary 本身加了可选 path（侧栏文件/技能引用预览），
  // session-controller 的 skill-catalog 随即消费它；旧 .d.ts 只有 SkillCandidate /
  // SkillDefinition 上有 path，SkillSummary 没有，覆盖层 host 编译当场 TS2339
  // "Property 'path' does not exist"。探针必须盯住 SkillSummary 的 JSDoc 注释行——
  // 裸 `readonly path?: string` 会被同文件另两个接口满足而漏判；也不能只看 skill
  // 包的 src，它随 master 前进，lib/ 不会。
  ['packages/skill/skill/lib/types/index.d.ts', 'Absolute instruction file path when supplied by the provider'],
  // 上游把 TypertCodec 的 strict 变体从「静态 schema」改成「懒物化 create()」，
  // packages/api/gateway/src/index.ts 随即改用 codec.create()。源树 lib/ 停在旧契约
  // 时，快照里**被覆盖的** gateway host 编译当场 TS2339「Property 'create' does not
  // exist」——症状落在覆盖层包上，根因却在没被覆盖的 typert/protocol 产物上，很容易
  // 往补丁方向查错。探针盯住新形态的方法签名行。
  ['packages/typert/protocol/lib/types/types.d.ts', 'create: () => TypertSchema'],
]

export function ensureLibEntriesReexport(sourceRoot) {
  const brandTypes = resolve(sourceRoot, 'packages', 'util', 'brand', 'lib', 'types', 'index.js')
  const fresh = LIB_FRESHNESS_PROBES.every(([relativePath, marker]) => {
    const probe = resolve(sourceRoot, relativePath)
    return existsSync(probe) && readFileSync(probe, 'utf8').includes(marker)
  })
  if (!fresh) {
    // 合成脚本在 desktop/ 下（桌面打包链的共用脚本），不在 dsh-overrides/：
    // 之前写错的相对路径从未在本地触发——本地 lib 探针新鲜，唯有全新克隆
    //（CI 桌面 job）才会走进这条分支，也正是本次修复的目标路径。
    const script = resolve(scriptRoot, '..', 'desktop', 'synthesize-dsh-libs.mjs')
    const oldRoot = process.env['LUMO_DSH_SOURCE_ROOT']
    process.env['LUMO_DSH_SOURCE_ROOT'] = sourceRoot
    const tsc = resolve(sourceRoot, 'node_modules', 'typescript', 'bin', 'tsc')
    if (!existsSync(tsc)) {
      // 全新机器上 build.sh 只会浅克隆 dsh（ensure_dsh_source），依赖没装时这里
      // 原本抛裸的 MODULE_NOT_FOUND，看不出该做什么。install-components.sh 已补
      // 自动安装；直接 `cargo tauri build` 绕过它的人在这里拿到可执行的指引。
      throw new Error(`Lumo DSH staging: ${sourceRoot} 缺少 node_modules/typescript——桌面构建要求 deepseek-harness 工作区依赖已安装。请先执行 \`CI=true corepack pnpm install\`（在该目录下）。`)
    }
    // client 面依赖 host tsdown 稍后生成的 typert.remote-client.*；此处提前执行
    // 会在全新 clone 上产生一批必然的“找不到 remote”错误。client 类型由
    // refreshDshClientTypePrerequisites() 在 host 投影完成后刷新。
    for (const config of ['tsconfig.host.json']) {
      // dsh-root 的 host 构建本身也使用 4 GiB heap（见 package.json 的
      // build:lib:host）。全新 CI clone 会在这里首次编译整个引用图；Node
      // 默认堆在 macOS arm64 runner 上会耗尽并以 SIGABRT 退出。
      const result = spawnSync(process.execPath, ['--max-old-space-size=4096', tsc, '-b', config], {
        cwd: sourceRoot,
        stdio: 'inherit',
      })
      if (result.error !== undefined) throw result.error
      if (result.status !== 0) {
        throw new Error(`Lumo DSH staging: 重建 dsh host 类型产物失败（${String(result.status ?? result.signal)}）`)
      }
    }
    const synth = spawnSync(process.execPath, [script], { cwd: sourceRoot, stdio: 'inherit' })
    if (synth.error !== undefined) throw synth.error
    if (synth.status !== 0) throw new Error(`Lumo DSH staging: 合成 dsh lib 入口失败（${String(synth.status ?? synth.signal)}）`)
    if (oldRoot === undefined) delete process.env['LUMO_DSH_SOURCE_ROOT']
    else process.env['LUMO_DSH_SOURCE_ROOT'] = oldRoot
  }
  return true
}

/** 并发构建（用户 build.sh 与 CI 校验链撞在同一 .build 目录）会导致 rmdir ENOTEMPTY；重试吸收瞬态。 */
function retryRemove(targetRoot, attempts = 3) {
  for (let attempt = 1; ; attempt++) {
    try {
      rmSync(targetRoot, { recursive: true, force: true })
      return
    } catch (error) {
      if (attempt >= attempts) throw error
      console.warn(`Lumo DSH staging: 清理 ${targetRoot} 失败（${String(error)}），重试 ${attempt}...`)
      setTimeoutSync(250 * attempt)
    }
  }
}

function setTimeoutSync(ms) {
  const end = Date.now() + ms
  while (Date.now() < end) { /* busy-wait：CLI 构建无需事件循环 */ }
}

export function prepareRuntime(sourceRoot, targetRoot) {
  assertPristineProductSource(sourceRoot)
  // 宿主 native addon 缺 bin 时先编（fingerprint() 会把 bin 内容哈希进指纹，
  // 必须在算指纹之前完成，见文件头部说明）。
  ensureNativeAddonsBuilt(sourceRoot)
  // 源树 lib 若停留在重构前的旧构建（brand 缺 brandString），这里先重建再算指纹——
  // fingerprint() 对 lib/ 内容取哈希，产物一变快照自动重建。
  ensureLibEntriesReexport(sourceRoot)
  const expected = fingerprint(sourceRoot)
  const marker = resolve(targetRoot, '.lumo-stage')
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === expected) {
    // The source workspace can be installed after this snapshot was created.
    // Keep the content cache, but refresh package-level node_modules links so
    // TypeScript can resolve dependencies such as packages/api/gateway -> ws.
    linkWorkspaceModules(sourceRoot, targetRoot)
    return targetRoot
  }

  retryRemove(targetRoot)
  mkdirSync(targetRoot, { recursive: true })
  copyTrackedTree(sourceRoot, targetRoot)
  linkWorkspaceModules(sourceRoot, targetRoot)
  copyBuildOutputs(sourceRoot, targetRoot)
  applyLumoDshOverrides(targetRoot)
  writeFileSync(marker, `${expected}\n`)
  return targetRoot
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceRoot = process.argv[2]
  const targetRoot = process.argv[3]
  if (sourceRoot === undefined || targetRoot === undefined) {
    throw new Error('usage: node platform/dsh-overrides/prepare-runtime.mjs <source-dsh-root> <target-dsh-root>')
  }
  const prepared = prepareRuntime(resolve(sourceRoot), resolve(targetRoot))
  const rel = relative(process.cwd(), prepared)
  process.stdout.write(`Lumo: prepared isolated DSH runtime at ${rel || '.'}\n`)
}

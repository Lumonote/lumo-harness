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
function fingerprint(root) {
  const commit = git(root, ['rev-parse', 'HEAD']).trim()
  const hash = createHash('sha256')
  hash.update(readFileSync(resolve(scriptRoot, 'apply.mjs')))
  for (const libDirectory of projectedLibDirectories(root)) {
    hashTree(libDirectory, libDirectory, hash)
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
// SessionProjectionMap 'inbox' 缺失）。与 brandString 同路：重跑上游 tsc 双面重建。
// 全新克隆（CI 桌面 job 的第一棒）—— 源树一个 lib/ 都没有：走同一套 tsc 双面 +
// 合成重建，而不是让 copyBuildOutputs 报「没有构建产物」死掉。本地增量构建的
// lib/ 存在且探针新鲜，仍然跳过，零行为变化。
const LIB_FRESHNESS_PROBES = [
  ['packages/util/brand/lib/types/index.js', 'brandString'],
  ['packages/llm/llm/lib/types/assistant-stream.d.ts', 'assistantStreamChunks'],
  ['packages/core/agent/lib/types/types.d.ts', 'InboxState'],
  // 0.1.5-alpha.1 的 agent 显式化重构把 AgentSetup 收敛为 (agentCtx, agent) 双参；
  // 旧 lib 仍是单参（"Expected 2 or more, but got 1" 此形状）。session-controller
  // 的 host 类型编译依赖该签名，探针必须盯住 index.d.ts 这一行而不能只看 types.d.ts。
  ['packages/core/agent/lib/types/index.d.ts', '(agentCtx: Context, agent: Agent)'],
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
    for (const [config, label] of [['tsconfig.host.json', 'host'], ['tsconfig.client.json', 'client']]) {
      // dsh-root 的 host 构建本身也使用 4 GiB heap（见 package.json 的
      // build:lib:host）。全新 CI clone 会在这里首次编译整个引用图；Node
      // 默认堆在 macOS arm64 runner 上会耗尽并以 SIGABRT 退出。
      const result = spawnSync(process.execPath, ['--max-old-space-size=4096', tsc, '-b', config], {
        cwd: sourceRoot,
        stdio: 'inherit',
      })
      if (result.error !== undefined) throw result.error
      if (result.status !== 0) {
        if (label === 'host') throw new Error(`Lumo DSH staging: 重建 dsh ${label} 类型产物失败（${String(result.status ?? result.signal)}）`)
        // client 面失败可容忍：typert/generator 产出的 lib/typert.remote-client.* 是一
        // 种「来自 Host FaceModel」的 tsdown 主机面产物，tsc -b 无法再生。源树该文件
        // 停留在旧 master 形态时 client 面 tsc 必然报旧形状 API 缺失（如 ui-goal 的
        // goals.get / TypertRemoteNamespace），且本机根本无法自愈——它由 build-runtime.mjs
        // 的 rebuildDshHostArtifacts() 在快照主机面 tsdown 序重产出并回拷源树。此处
        // 放行，真正的 client 类型刷新在快照侧由 refreshDshClientTypePrerequisites 承担。
        console.warn(`Lumo DSH staging: [WARN] 重建 dsh ${label} 类型产物失败（${String(result.status ?? result.signal)}），先放行 —— typert 投影将在快照主机面 tsdown 序重产出（rebuildDshHostArtifacts）`)
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
  // 源树 lib 若停留在重构前的旧构建（brand 缺 brandString），这里先重建再算指纹——
  // fingerprint() 对 lib/ 内容取哈希，产物一变快照自动重建。
  ensureLibEntriesReexport(sourceRoot)
  const expected = fingerprint(sourceRoot)
  const marker = resolve(targetRoot, '.lumo-stage')
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === expected) return targetRoot

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

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

export function prepareRuntime(sourceRoot, targetRoot) {
  assertPristineProductSource(sourceRoot)
  const expected = fingerprint(sourceRoot)
  const marker = resolve(targetRoot, '.lumo-stage')
  if (existsSync(marker) && readFileSync(marker, 'utf8').trim() === expected) return targetRoot

  rmSync(targetRoot, { recursive: true, force: true })
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

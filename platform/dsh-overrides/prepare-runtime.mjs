import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { applyLumoDshOverrides } from './apply.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))

function git(root, args, encoding = 'utf8') {
  const result = spawnSync('git', ['-C', root, ...args], { encoding })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(result.stderr).trim()}`)
  return result.stdout
}

function assertPristineProductSource(root) {
  const tracked = git(root, ['status', '--porcelain', '--untracked-files=no']).trim()
  if (tracked !== '') {
    throw new Error('DeepSeek Harness has tracked modifications. Move product changes to platform overlays before building.\n' + tracked)
  }
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .split('\n').filter(path => path.startsWith('apps/') || path.startsWith('packages/'))
  if (untracked.length > 0) {
    throw new Error('DeepSeek Harness contains generated/product files under apps or packages. Clean them before building.\n' + untracked.join('\n'))
  }
}

function fingerprint(root) {
  const commit = git(root, ['rev-parse', 'HEAD']).trim()
  const hash = createHash('sha256')
  hash.update(readFileSync(resolve(scriptRoot, 'apply.mjs')))
  return `${commit}:${hash.digest('hex')}`
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
    mkdirSync(dirname(targetModules), { recursive: true })
    symlinkSync(sourceModules, targetModules, 'junction')
  }
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

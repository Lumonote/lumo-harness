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
import { applyLumoDshOverrides } from './apply.mjs'
import { assertPristineProductSource, git } from './assert-pristine.mjs'

const scriptRoot = dirname(fileURLToPath(import.meta.url))

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

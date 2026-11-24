#!/usr/bin/env node
// 统一入口：pnpm guard [--only a,b] [--update-baseline] [--verbose]
// 在 platform/ 目录下运行；退出码 1 表示有错误（警告不影响退出码）。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadJson, saveJson } from './lib.mjs'
import * as fileSize from './file-size.mjs'
import * as dshBoundary from './dsh-boundary.mjs'
import * as noBackup from './no-backup-files.mjs'
import * as cssVars from './css-vars.mjs'
import * as migrations from './migrations-append-only.mjs'
import * as colors from './hardcoded-colors.mjs'

export const GUARDS = [fileSize, dshBoundary, noBackup, cssVars, migrations, colors]
const here = path.dirname(fileURLToPath(import.meta.url))

export function baselinePath(name, dir = path.join(here, 'baselines')) {
  return path.join(dir, `${name}.json`)
}

export function runGuards({ platformRoot, repoRoot, only, update = false, verbose = false, baselineDir, checkGit = true, log = console.log }) {
  let failed = 0
  for (const g of GUARDS) {
    if (only && !only.includes(g.name)) continue
    const file = baselinePath(g.name, baselineDir)
    const baseline = loadJson(file, {})
    if (update && g.snapshot) {
      saveJson(file, g.snapshot({ platformRoot, repoRoot, baseline }))
      log(`↻ ${g.name}: baseline 已更新 → ${path.relative(platformRoot, file)}`)
      continue
    }
    const { errors, warnings } = g.check({ platformRoot, repoRoot, baseline, verbose, checkGit })
    const mark = errors.length ? '✗' : '✓'
    log(`${mark} ${g.name} — ${g.description}${errors.length ? `（${errors.length} 个错误）` : ''}${warnings.length ? `（${warnings.length} 个警告）` : ''}`)
    for (const e of errors) log(`    error: ${e}`)
    for (const w of verbose || g.name !== 'hardcoded-colors' ? warnings : warnings.slice(0, 10)) log(`    warn:  ${w}`)
    if (!verbose && g.name === 'hardcoded-colors' && warnings.length > 10) log(`    …其余 ${warnings.length - 10} 条，用 --verbose 查看`)
    failed += errors.length
  }
  return failed
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  const onlyIdx = args.indexOf('--only')
  const only = onlyIdx >= 0 ? args[onlyIdx + 1].split(',') : undefined
  const platformRoot = path.resolve(here, '../..')
  const repoRoot = path.resolve(platformRoot, '..')
  const failed = runGuards({ platformRoot, repoRoot, only, update: args.includes('--update-baseline'), verbose: args.includes('--verbose') })
  if (failed) {
    console.log(`\n守卫失败：${failed} 个错误。规则与 baseline 说明见 tools/guards/README.md`)
    process.exit(1)
  }
}

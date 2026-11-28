import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { diagnoseOverlayAnchors, overriddenPackageDirectories } from './apply.mjs'
import { git } from './assert-pristine.mjs'
import { validateOverlayInventory, snapshotOverlayFiles, auditOverlayEffects } from './inventory.mjs'

// No package installation or compilation: check all anchors in a disposable
// source copy before CI spends time on Rust, Python and native dependencies.
export function checkOverlayCompatibility(sourceRoot) {
  validateOverlayInventory(overriddenPackageDirectories)
  const root = mkdtempSync(resolve(tmpdir(), 'lumo-overlay-check-'))
  try {
    const files = git(sourceRoot, ['ls-tree', '-rz', '--name-only', 'HEAD', '--', 'tsdown.config.ts', ...overriddenPackageDirectories], null)
      .toString().split('\0').filter(Boolean)
    for (const file of files) {
      const target = resolve(root, file)
      mkdirSync(dirname(target), { recursive: true })
      // Read the committed bytes, just like overlay.spec.ts. A developer's
      // generated files must not make compatibility checks pass accidentally.
      writeFileSync(target, git(sourceRoot, ['show', `HEAD:${file}`], null))
    }
    const before = snapshotOverlayFiles(root)
    const misses = diagnoseOverlayAnchors(root)
    if (misses.length > 0) {
      throw new Error(`DSH overlay is incompatible with upstream ${git(sourceRoot, ['rev-parse', 'HEAD']).trim()}:\n`
        + misses.map(({ file, kind, anchor }) => `- ${file}: ${kind} ${JSON.stringify(anchor)}`).join('\n'))
    }
    const report = auditOverlayEffects(before, snapshotOverlayFiles(root))
    const revision = git(sourceRoot, ['rev-parse', 'HEAD']).trim()
    console.log(`DSH overlay compatibility: ${report.packageCount} registered packages + root tsdown; ${report.changedFiles.length} changed files; all anchors match ${revision}`)
    return { ...report, revision }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceRoot = process.argv[2]
  if (!sourceRoot) throw new Error('usage: node check-compatibility.mjs <upstream-dsh-root>')
  checkOverlayCompatibility(resolve(sourceRoot))
}

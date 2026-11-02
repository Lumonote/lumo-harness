import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { assertPristineProductSource } from './assert-pristine.mjs'
import { ensureLibEntriesReexport } from './prepare-runtime.mjs'

// CI and desktop builds must share prerequisite ordering and heap limits.
// This helper generates Typert remote faces before tsc, then synthesizes lib
// entries; invoking tsc directly on a fresh checkout misses those remote types.
const sourceRoot = resolve(process.argv[2] ?? '../deepseek-harness')
assertPristineProductSource(sourceRoot)
ensureLibEntriesReexport(sourceRoot)
// PTC's process.js is an executable entry, renamed from process-entry.js by
// its package config. A generic re-export of types/process.js only loads the
// implementation and exits without opening the control channel. Build this
// package with its own config so runtime tests exercise the actual worker.
const requireFromSource = createRequire(resolve(sourceRoot, 'package.json'))
const worker = spawnSync(process.execPath, [requireFromSource.resolve('tsdown/run')], {
  cwd: resolve(sourceRoot, 'packages/ptc-runtime/ptc-runtime-node'),
  stdio: 'inherit',
})
if (worker.error !== undefined) throw worker.error
if (worker.status !== 0) throw new Error(`Lumo DSH staging: PTC worker bundle failed (${String(worker.status ?? worker.signal)})`)
assertPristineProductSource(sourceRoot)

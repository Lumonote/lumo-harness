import { resolve } from 'node:path'
import { assertPristineProductSource } from './assert-pristine.mjs'
import { ensureLibEntriesReexport } from './prepare-runtime.mjs'

// CI and desktop builds must share prerequisite ordering and heap limits.
// This helper generates Typert remote faces before tsc, then synthesizes lib
// entries; invoking tsc directly on a fresh checkout misses those remote types.
const sourceRoot = resolve(process.argv[2] ?? '../deepseek-harness')
assertPristineProductSource(sourceRoot)
ensureLibEntriesReexport(sourceRoot)
assertPristineProductSource(sourceRoot)

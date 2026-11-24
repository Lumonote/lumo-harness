import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runGuards, GUARDS } from '../run.mjs'
import { fixture } from './helpers.mjs'

test('统一入口：--update-baseline 后再检查通过；错误计入退出码', () => {
  const repo = fixture({
    'platform/dsh-plugins/lumo-ui/src/client/lumo.css': ':root { --lumo-ink: #000 }\n',
    'platform/deploy/migrations/001_a.sql': 'x',
    'platform/src/huge.ts': 'x'.repeat(70 * 1024),
  })
  const platformRoot = path.join(repo, 'platform')
  const baselineDir = path.join(repo, 'baselines')
  const log = () => {}
  assert.equal(runGuards({ platformRoot, repoRoot: repo, baselineDir, checkGit: false, log }) > 0, true)
  runGuards({ platformRoot, repoRoot: repo, baselineDir, update: true, checkGit: false, log })
  assert.equal(runGuards({ platformRoot, repoRoot: repo, baselineDir, checkGit: false, log }), 0)
  fs.writeFileSync(path.join(repo, 'platform/src/x.ts.bak'), '')
  assert.equal(runGuards({ platformRoot, repoRoot: repo, baselineDir, checkGit: false, log }), 1)
  assert.equal(runGuards({ platformRoot, repoRoot: repo, baselineDir, checkGit: false, log, only: ['file-size'] }), 0)
})

test('六个守卫都已注册且有 check', () => {
  assert.deepEqual(GUARDS.map((g) => g.name), ['file-size', 'dsh-boundary', 'no-backup-files', 'css-vars', 'migrations-append-only', 'hardcoded-colors'])
  for (const g of GUARDS) assert.equal(typeof g.check, 'function')
})

import test from 'node:test'
import assert from 'node:assert/strict'
import { check, isBackupName } from '../no-backup-files.mjs'
import { fixture } from './helpers.mjs'

test('识别各种备份文件名', () => {
  for (const n of ['a.ts.bak', 'a.ts.bak-gugu', 'a.bak2', 'store.go.orig', 'x.orig3', 'p.rej', 'n.md~']) assert.ok(isBackupName(n), n)
  for (const n of ['a.ts', 'origin.ts', 'backup.md', 'orig.go']) assert.ok(!isBackupName(n), n)
})

test('仓库内备份文件报错，node_modules / deepseek-harness 下忽略', () => {
  const root = fixture({
    'platform/src/a.ts': '', 'platform/src/a.ts.orig': '', 'README.md.bak-gugu': '',
    'node_modules/x.orig': '', 'deepseek-harness/y.bak': '',
  })
  const r = check({ repoRoot: root })
  assert.deepEqual(r.errors.map((e) => e.split(':')[0]).sort(), ['README.md.bak-gugu', 'platform/src/a.ts.orig'])
})

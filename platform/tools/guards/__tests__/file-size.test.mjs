import test from 'node:test'
import assert from 'node:assert/strict'
import { check, snapshot } from '../file-size.mjs'
import { fixture } from './helpers.mjs'

const big = (n) => 'x'.repeat(n)

test('新文件超过上限报错，未超限通过', () => {
  const root = fixture({ 'a.ts': big(200), 'b.ts': big(50), 'c.md': big(500) })
  const r = check({ platformRoot: root, baseline: { limitBytes: 100 } })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /^a\.ts/)
})

test('baseline 中的大文件只许变小', () => {
  const root = fixture({ 'a.tsx': big(300) })
  assert.equal(check({ platformRoot: root, baseline: { limitBytes: 100, files: { 'a.tsx': 300 } } }).errors.length, 0)
  assert.equal(check({ platformRoot: root, baseline: { limitBytes: 100, files: { 'a.tsx': 299 } } }).errors.length, 1)
  const shrunk = check({ platformRoot: root, baseline: { limitBytes: 100, files: { 'a.tsx': 400 } } })
  assert.equal(shrunk.errors.length, 0)
  assert.match(shrunk.warnings[0], /收紧/)
})

test('跳过 node_modules / lib 等目录，snapshot 只记录超限文件', () => {
  const root = fixture({ 'node_modules/x.js': big(500), 'pkg/lib/y.js': big(500), 'src/z.go': big(150), 'src/s.go': big(10) })
  assert.deepEqual(snapshot({ platformRoot: root, baseline: { limitBytes: 100 } }), { limitBytes: 100, files: { 'src/z.go': 150 } })
})

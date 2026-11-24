import test from 'node:test'
import assert from 'node:assert/strict'
import { check, findColors } from '../hardcoded-colors.mjs'
import { fixture } from './helpers.mjs'

test('findColors 识别字符串里的 hex / rgb / hsl，忽略注释与 var()', () => {
  const src = [
    "const a = { color: '#ff0000' }",
    'const b = `rgba(0, 0, 0, .5)`',
    "const c = 'hsl(10 20% 30%)'",
    "// '#123456' 注释里不算",
    "const d = 'var(--lumo-ink)'",
    "const e = 'issue #12'",
  ].join('\n')
  assert.deepEqual(findColors(src).map((h) => h.line), [1, 2, 3])
})

test('只警告不报错，测试文件跳过', () => {
  const root = fixture({
    'dsh-plugins/x/src/A.tsx': "export const A = () => <div style={{ color: '#fff' }} />\n",
    'dsh-plugins/x/__tests__/A.spec.tsx': "'#000'\n",
  })
  const r = check({ platformRoot: root })
  assert.equal(r.errors.length, 0)
  assert.equal(r.warnings.length, 1)
  assert.match(r.warnings[0], /A\.tsx: 1 处/)
})

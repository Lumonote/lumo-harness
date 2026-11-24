import test from 'node:test'
import assert from 'node:assert/strict'
import { check, classify, snapshot } from '../dsh-boundary.mjs'
import { fixture } from './helpers.mjs'

test('classify：公开入口放行，内部路径拦截', () => {
  assert.equal(classify('@deepseek-ai/dsh-session'), null)
  assert.equal(classify('@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'), null)
  assert.ok(classify('@deepseek-ai/dsh-session/src/index.ts'))
  assert.ok(classify('@deepseek-ai/dsh-llm/lib/x.js'))
  assert.ok(classify('../../../../deepseek-harness/packages/core/session/lib/index.js'))
  assert.equal(classify('./local'), null)
})

test('越界引用超过 baseline 报错，等于 baseline 通过', () => {
  const root = fixture({
    'p/a.ts': "import x from '../../deepseek-harness/packages/a/src/index.ts'\nconst y = await import('@deepseek-ai/dsh-tools/internal/z')\n",
    'p/b.ts': "import { s } from '@deepseek-ai/dsh-session'\n",
  })
  const r = check({ platformRoot: root, checkGit: false })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /p\/a\.ts: 2 处/)
  assert.equal(check({ platformRoot: root, checkGit: false, baseline: { files: { 'p/a.ts': 2 } } }).errors.length, 0)
  assert.deepEqual(snapshot({ platformRoot: root }), { files: { 'p/a.ts': 2 } })
})

test('require 与 vi.mock 也算引用', () => {
  const root = fixture({ 't.spec.ts': "vi.mock('@deepseek-ai/dsh-agent/dist/x.js')\nrequire('deepseek-harness/a')\n" })
  assert.equal(snapshot({ platformRoot: root }).files['t.spec.ts'], 2)
})

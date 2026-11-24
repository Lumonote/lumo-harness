import test from 'node:test'
import assert from 'node:assert/strict'
import { check, snapshot, TOKENS_FILE } from '../css-vars.mjs'
import { fixture } from './helpers.mjs'

test('未定义变量报错，已定义与 runtimeVars 放行', () => {
  const root = fixture({
    [TOKENS_FILE]: ':root { --lumo-ink: #000; --lumo-line: #ccc; }\n.a { color: var(--lumo-ink); animation-delay: calc(var(--lumo-order, 0) * 1ms) }\n',
    'dsh-plugins/x/src/panel.css': '.b { border: 1px solid var(--lumo-line); }\n.c { color: var( --lumo-missing ); }\n',
  })
  const r = check({ platformRoot: root, baseline: { runtimeVars: ['--lumo-order'] } })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /panel\.css:L2 .*--lumo-missing/)
  assert.equal(check({ platformRoot: root, baseline: {} }).errors.length, 2)
})

test('缺少 lumo.css 时报错', () => {
  const root = fixture({ 'a.css': '' })
  assert.equal(check({ platformRoot: root }).errors.length, 1)
})

test('legacy 登记的存量缺失变量放行，snapshot 生成 legacy', () => {
  const root = fixture({
    [TOKENS_FILE]: ':root { --lumo-ink: #000 }\n',
    'p/old.css': '.x { color: var(--lumo-text); }\n',
    'p/new.css': '.y { color: var(--lumo-text); }\n',
  })
  const baseline = { legacy: { 'p/old.css': ['--lumo-text'] } }
  const r = check({ platformRoot: root, baseline })
  assert.equal(r.errors.length, 1)
  assert.match(r.errors[0], /^p\/new\.css/)
  assert.deepEqual(snapshot({ platformRoot: root, baseline: {} }).legacy, { 'p/new.css': ['--lumo-text'], 'p/old.css': ['--lumo-text'] })
})

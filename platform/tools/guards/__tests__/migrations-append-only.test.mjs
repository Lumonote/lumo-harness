import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { check, snapshot } from '../migrations-append-only.mjs'
import { fixture } from './helpers.mjs'

const setup = () => fixture({ 'deploy/migrations/001_a.sql': 'create table a();\n', 'deploy/migrations/002_b.sql': 'create table b();\n' })

test('未改动通过；追加新迁移只告警', () => {
  const root = setup()
  const baseline = snapshot({ platformRoot: root })
  assert.deepEqual(check({ platformRoot: root, baseline }), { errors: [], warnings: [] })
  fs.writeFileSync(path.join(root, 'deploy/migrations/003_c.sql'), 'x')
  const r = check({ platformRoot: root, baseline })
  assert.equal(r.errors.length, 0)
  assert.equal(r.warnings.length, 1)
})

test('修改或删除旧迁移报错；CRLF 不算修改', () => {
  const root = setup()
  const baseline = snapshot({ platformRoot: root })
  fs.writeFileSync(path.join(root, 'deploy/migrations/001_a.sql'), 'create table a();\r\n')
  assert.equal(check({ platformRoot: root, baseline }).errors.length, 0)
  fs.writeFileSync(path.join(root, 'deploy/migrations/001_a.sql'), 'drop table a;\n')
  fs.rmSync(path.join(root, 'deploy/migrations/002_b.sql'))
  assert.equal(check({ platformRoot: root, baseline }).errors.length, 2)
})

test('插队编号、重复编号、无编号都报错', () => {
  const root = setup()
  const baseline = snapshot({ platformRoot: root })
  fs.writeFileSync(path.join(root, 'deploy/migrations/001_dup.sql'), 'x')
  fs.writeFileSync(path.join(root, 'deploy/migrations/fix.sql'), 'x')
  const errs = check({ platformRoot: root, baseline }).errors.join('\n')
  assert.match(errs, /不大于已发布的最大编号/)
  assert.match(errs, /重复/)
  assert.match(errs, /数字编号开头/)
})

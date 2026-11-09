import assert from 'node:assert/strict'
import { test } from 'node:test'
import { verifyGoTestReport } from '../verify-go-test-report.mjs'

const line = (Action, Test, extra = {}) => ({ Package: 'example/module/pkg', Action, ...(Test ? { Test } : {}), ...extra })
const report = events => events.map(event => JSON.stringify(event)).join('\n') + '\n'
const passing = () => [line('start'), line('run', 'TestParent'), line('run', 'TestParent/child'), line('output', 'TestParent/child', { Output: 'real assertion\n' }), line('pass', 'TestParent/child'), line('pass', 'TestParent'), line('pass')]

test('counts a completed parent/subtest and explicit no-test package', () => {
  const events = [...passing(), { Package: 'example/module/cmd', Action: 'start' }, { Package: 'example/module/cmd', Action: 'output', Output: '?   example/module/cmd\t[no test files]\n' }, { Package: 'example/module/cmd', Action: 'skip' }]
  assert.deepEqual(verifyGoTestReport(report(events), ['example/module/pkg', 'example/module/cmd']), { packages: 2, passed: 2, failed: 0, skipped: 0 })
})
test('accepts pause/continue and concurrent package events', () => {
  const events = passing(); events.splice(2, 0, line('pause', 'TestParent'), line('cont', 'TestParent'))
  assert.equal(verifyGoTestReport(report(events)).passed, 2)
})
test('rejects any skipped test even when the package passes', () => {
  const events = passing(); events[4] = line('skip', 'TestParent/child')
  assert.throws(() => verifyGoTestReport(report(events)), /Go test skipped/u)
})
test('rejects empty, malformed, failed and unfinished evidence', () => {
  for (const source of ['', 'not json', report([line('start')]), report([line('start'), line('pass')]), report([line('start'), line('fail')]), report([line('start'), line('run', 'TestParent'), line('pass')])]) assert.throws(() => verifyGoTestReport(source))
})
test('rejects duplicate test execution or duplicate terminal events', () => {
  const duplicateTest = passing(); duplicateTest.splice(2, 0, line('run', 'TestParent'))
  assert.throws(() => verifyGoTestReport(report(duplicateTest)), /Duplicate test/u)
  assert.throws(() => verifyGoTestReport(report([...passing(), line('pass')])), /after package completion/u)
})
test('rejects package skip without explicit no-test-files evidence', () => {
  assert.throws(() => verifyGoTestReport(report([...passing(), { Package: 'other', Action: 'start' }, { Package: 'other', Action: 'skip' }])) , /no-test-files/u)
})
test('requires exact discovered package coverage', () => {
  for (const packages of [[], ['missing'], ['example/module/pkg', 'missing'], ['example/module/pkg', 'example/module/pkg']]) assert.throws(() => verifyGoTestReport(report(passing()), packages))
})
test('rejects a passed test without an execution start and failures in another package', () => {
  assert.throws(() => verifyGoTestReport(report([line('start'), line('pass', 'TestForged'), line('pass')])), /active execution/u)
  assert.throws(() => verifyGoTestReport(report([...passing(), { Package: 'broken', Action: 'build-fail' }])) , /Go reported failure/u)
})

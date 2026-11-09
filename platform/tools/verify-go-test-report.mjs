/** Validate go test -json evidence, including subtests and package completion. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyGoTestReport(source, expectedPackages) {
  assert.equal(typeof source, 'string', 'Expected JSONL test evidence')
  const packages = new Map()
  let passed = 0
  for (const [index, line] of source.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue
    let event
    try { event = JSON.parse(line) } catch { throw new Error(`Invalid Go JSON event at line ${index + 1}`) }
    assert.ok(event && typeof event === 'object' && !Array.isArray(event), 'Expected a Go JSON event')
    assert.ok(typeof event.Package === 'string' && event.Package.length > 0, 'Go event has no package identity')
    assert.ok(['start', 'run', 'pause', 'cont', 'output', 'pass', 'skip', 'fail', 'build-output', 'build-fail'].includes(event.Action), `Unknown Go event action: ${event.Action}`)
    assert.ok(!['fail', 'build-fail'].includes(event.Action), `Go reported failure: ${event.Package} ${event.Test ?? ''}`)
    let pkg = packages.get(event.Package)
    if (!pkg) { pkg = { started: false, terminal: false, noTests: false, tests: new Map() }; packages.set(event.Package, pkg) }
    assert.equal(pkg.terminal, false, `Events after package completion: ${event.Package}`)
    if (event.Test !== undefined) {
      assert.ok(typeof event.Test === 'string' && event.Test.length > 0, 'Missing test identity')
      assert.equal(pkg.started, true, `Test preceded package start: ${event.Package}`)
      assert.notEqual(event.Action, 'skip', `Go test skipped: ${event.Package} ${event.Test}`)
      const state = pkg.tests.get(event.Test)
      if (event.Action === 'run') {
        assert.equal(state, undefined, `Duplicate test execution: ${event.Package} ${event.Test}`)
        pkg.tests.set(event.Test, 'running')
      } else {
        assert.equal(state, 'running', `Test event without active execution: ${event.Package} ${event.Test}`)
        if (event.Action === 'pass') { pkg.tests.set(event.Test, 'passed'); passed++ }
        else assert.ok(['output', 'pause', 'cont'].includes(event.Action), `Invalid test action: ${event.Action}`)
      }
    } else if (event.Action === 'start') {
      assert.equal(pkg.started, false, `Duplicate package start: ${event.Package}`)
      pkg.started = true
    } else if (event.Action === 'output' || event.Action === 'build-output') {
      assert.equal(typeof event.Output, 'string', 'Output event has no output')
      if (/^\?\s+\S+\s+\[no test files\]\s*$/u.test(event.Output)) pkg.noTests = true
    } else if (event.Action === 'pass' || event.Action === 'skip') {
      assert.equal(pkg.started, true, `Package completion without start: ${event.Package}`)
      if (event.Action === 'skip') {
        assert.ok(pkg.noTests && pkg.tests.size === 0, `Package skipped without explicit no-test-files evidence: ${event.Package}`)
      } else {
        assert.ok(pkg.tests.size > 0, `Package passed without executing tests: ${event.Package}`)
        assert.ok([...pkg.tests.values()].every(value => value === 'passed'), `Incomplete test execution: ${event.Package}`)
      }
      pkg.terminal = true
    } else assert.fail(`Unexpected package action: ${event.Action}`)
  }
  assert.ok(packages.size > 0 && passed > 0, 'Go report contains no executed tests')
  assert.ok([...packages.values()].every(pkg => pkg.terminal), 'Go report ended before every package completed')
  if (expectedPackages !== undefined) {
    assert.ok(Array.isArray(expectedPackages) && expectedPackages.length > 0, 'Expected package discovery must not be empty')
    assert.ok(expectedPackages.every(name => typeof name === 'string' && name.length > 0), 'Invalid discovered package identity')
    assert.equal(new Set(expectedPackages).size, expectedPackages.length, 'Duplicate discovered package identity')
    assert.deepEqual([...packages.keys()].sort(), [...expectedPackages].sort(), 'Go evidence does not cover the discovered packages')
  }
  return { packages: packages.size, passed, failed: 0, skipped: 0 }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.ok(process.argv.length === 3 || process.argv.length === 5 && process.argv[3] === '--packages', 'Usage: node verify-go-test-report.mjs <go-jsonl-report> [--packages <go-list-file>]')
    const expected = process.argv[4] ? readFileSync(process.argv[4], 'utf8').trim().split(/\r?\n/u) : undefined
    console.log(JSON.stringify(verifyGoTestReport(readFileSync(process.argv[2], 'utf8'), expected)))
  } catch (error) { console.error(`Go test evidence failed: ${error.message}`); process.exitCode = 1 }
}

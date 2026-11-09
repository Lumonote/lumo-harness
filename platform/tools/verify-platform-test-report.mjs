/** A successful Vitest exit code can still contain skipped dependency suites. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export function verifyPlatformTestReport(report) {
  assert.ok(report && typeof report === 'object' && !Array.isArray(report), 'Expected a Vitest JSON report')
  assert.equal(report.success, true, 'Vitest reported a failed or incomplete run')
  for (const key of ['numTotalTests', 'numPassedTests', 'numTotalTestSuites', 'numPassedTestSuites']) {
    assert.ok(Number.isSafeInteger(report[key]) && report[key] > 0, `${key} must contain actual executed tests`)
  }
  assert.ok(Array.isArray(report.testResults) && report.testResults.length > 0, 'No test files were reported')
  const files = new Set()
  let passed = 0
  for (const file of report.testResults) {
    assert.ok(typeof file.name === 'string' && file.name.length > 0 && !files.has(file.name), 'Missing or duplicate test file identity')
    files.add(file.name)
    assert.equal(file.status, 'passed', `Test file did not pass: ${file.name}`)
    assert.ok(Array.isArray(file.assertionResults) && file.assertionResults.length > 0, `No tests executed in ${file.name}`)
    for (const test of file.assertionResults) {
      assert.equal(test.status, 'passed', `Test did not execute successfully: ${file.name}: ${test.fullName ?? test.title} (${test.status})`)
      assert.ok(Array.isArray(test.failureMessages) && test.failureMessages.length === 0, `Test retained failures: ${test.fullName ?? test.title}`)
      passed++
    }
  }
  for (const key of ['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites']) {
    assert.equal(report[key], 0, `${key} must be zero; missing dependencies and disabled tests are not a passing run`)
  }
  assert.equal(report.numPassedTests, passed, 'Reported pass count disagrees with actual test results')
  assert.equal(report.numTotalTests, passed, 'The report includes tests that did not execute successfully')
  assert.equal(report.numPassedTestSuites, report.numTotalTestSuites, 'The report includes suites that did not pass')
  return { files: files.size, passed, failed: 0, skipped: 0, todo: 0 }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    assert.equal(process.argv.length, 3, 'Usage: node verify-platform-test-report.mjs <vitest-json-report>')
    const result = verifyPlatformTestReport(JSON.parse(readFileSync(process.argv[2], 'utf8')))
    console.log(`Full platform evidence: ${result.files} files, ${result.passed} passed, 0 failed, 0 skipped, 0 todo`)
  } catch (error) { console.error(`Platform test evidence failed: ${error.message}`); process.exitCode = 1 }
}

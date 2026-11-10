import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { verifyPlatformTestReport } from '../verify-platform-test-report.mjs'

const workflow = readFileSync(new URL('../../../.github/workflows/ci.yml', import.meta.url), 'utf8')
const platform = workflow.match(/^  platform:\n([\s\S]*?)(?=^  [\w-]+:|$(?![\s\S]))/mu)![1]!.replace(/^\s*#.*$/gmu, '')

describe('full platform CI dependency and evidence wiring', () => {
  it('opens every current live dependency gate for one complete test discovery', () => {
    for (const gate of ['LUMO_TEST_PG_DSN: postgres://', 'SESSION_LOG_TEST_REDIS: redis://',
      'OBJECT_STORE_TEST_ENDPOINT: 127.0.0.1:19000', 'OBJECT_STORE_TEST_CREDS: lumo_ci:', "LUMO_AUTH_PROXY_TEST: '1'", 'LUMO_PPT_PYTHON:']) {
      expect(platform).toContain(gate)
    }
    expect(platform).toContain('image: pgvector/pgvector:pg16')
    expect(platform).toContain('image: redis:7-alpine')
    expect(platform).toContain('docker build --file deploy/minio-source.Dockerfile')
    expect(platform).toContain('127.0.0.1:19000:9000')
    expect(platform).toContain('/minio/health/ready')
    expect(platform).toContain('--constraint upstream/ppt-constraints.txt -r upstream/skills/ppt-master/requirements.txt')
    expect(platform).toContain("-I -c 'import fitz, openpyxl, pptx'")
    // runner context exists for steps, not jobs.<job_id>.env.
    expect(platform.slice(0,platform.indexOf('    services:'))).not.toContain('runner.temp')
    expect(platform).toContain('echo "LUMO_PPT_PYTHON=$LUMO_PPT_PYTHON" >> "$GITHUB_ENV"')
    const command = platform.replace(/\\\r?\n\s*/gu, ' ').match(/pnpm exec vitest run[^\n]*/u)![0]
    expect(command).toContain('--maxWorkers=2 --testTimeout=30000 --hookTimeout=30000')
    expect(command).toContain('--reporter=json --outputFile.json="$RUNNER_TEMP/platform-vitest.json"')
    expect(command).not.toMatch(/\.spec\.|--exclude|--testNamePattern|--passWithNoTests/u)
    expect(platform.match(/pnpm exec vitest run/gu)).toHaveLength(1)
    expect(platform).toContain('node tools/verify-platform-test-report.mjs "$RUNNER_TEMP/platform-vitest.json"')
    expect(platform).toContain("steps.platform-tests.outcome != 'skipped'")
    expect(platform).toContain('path: ${{ runner.temp }}/platform-vitest.json')
    expect(platform).toContain('docker rm --force lumo-ci-minio')
  })
})

function report() {
  return { success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
    numTotalTestSuites: 2, numPassedTestSuites: 2, numFailedTestSuites: 0, numPendingTestSuites: 0,
    testResults: [{ name: '/platform/first.spec.ts', status: 'passed', assertionResults: [
      { fullName: 'actual execution', status: 'passed', failureMessages: [] },
      { fullName: 'actual live IO', status: 'passed', failureMessages: [] },
    ] }] }
}

describe('actual zero-skip Vitest report guard', () => {
  it('counts actual per-file assertions in a passing report', () => {
    expect(verifyPlatformTestReport(report())).toEqual({ files: 1, passed: 2, failed: 0, skipped: 0, todo: 0 })
  })
  it('reports the failing file, test and original error when Vitest marks the run unsuccessful', () => {
    const r = report(); r.success = false; r.testResults[0]!.status = 'failed'
    const test = r.testResults[0]!.assertionResults[1]!
    test.status = 'failed'; test.failureMessages.push('AssertionError: expected 2 to equal 1' as never)
    expect(() => verifyPlatformTestReport(r)).toThrow('/platform/first.spec.ts: actual live IO (failed)\nAssertionError: expected 2 to equal 1')
  })
  it('reports collection failures that have no per-test assertions', () => {
    const r = { ...report(), success: false, testResults: [
      { name: '/platform/broken.spec.ts', status: 'failed', assertionResults: [], message: 'Cannot find module required-by-test' },
    ] }
    expect(() => verifyPlatformTestReport(r)).toThrow('/platform/broken.spec.ts (failed)\nCannot find module required-by-test')
  })
  it('retains the failed-run error for incomplete or malformed file evidence', () => {
    const invalidLabel = { toString: null }
    for (const testResults of [undefined, 'invalid', [null], [
      { name: invalidLabel, status: invalidLabel, assertionResults: [
        { fullName: invalidLabel, title: invalidLabel, status: invalidLabel, failureMessages: [] },
      ] },
    ]]) {
      expect(() => verifyPlatformTestReport({ success: false, testResults })).toThrow('Vitest reported a failed or incomplete run')
    }
  })
  it.each(['pending', 'skipped', 'todo', 'disabled', 'failed'])('rejects %s even when the process and top-level report claim success', status => {
    const r = report(); r.testResults[0]!.assertionResults[1]!.status = status
    expect(() => verifyPlatformTestReport(r)).toThrow('actual live IO')
  })
  it.each(['numFailedTests', 'numPendingTests', 'numTodoTests', 'numFailedTestSuites', 'numPendingTestSuites'])('rejects nonzero %s', key => {
    const r = { ...report(), [key]: 1 }
    expect(() => verifyPlatformTestReport(r)).toThrow(key)
  })
  it('rejects missing, empty, collection-failed and duplicate test files', () => {
    const r = report()
    for (const testResults of [[], [{ ...r.testResults[0], assertionResults: [] }], [{ ...r.testResults[0], status: 'failed' }], [r.testResults[0], r.testResults[0]]]) {
      expect(() => verifyPlatformTestReport({ ...r, testResults })).toThrow()
    }
  })
  it('rejects empty runs and summary counts that disagree with executed assertions', () => {
    for (const partial of [{ success: false }, { numTotalTests: 0 }, { numPassedTests: 3 }, { numTotalTests: 3 }, { numTotalTestSuites: 3 }]) {
      expect(() => verifyPlatformTestReport({ ...report(), ...partial })).toThrow()
    }
  })
  it('rejects a nominally passing assertion that retained failure evidence', () => {
    const r = report(); r.testResults[0]!.assertionResults[0]!.failureMessages.push('unhandled native error' as never)
    expect(() => verifyPlatformTestReport(r)).toThrow('retained failures')
  })
})

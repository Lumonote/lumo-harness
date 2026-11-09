import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { enforceRuntimeBudget, measureRuntime, writeRuntimeSizeReport } from '../runtime-size.mjs'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lumo size ')); roots.push(root)
  const runtime = join(root, 'runtime'); mkdirSync(runtime)
  const write = (name: string, content: string) => { const path = join(runtime, name); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); return path }
  return { root, runtime, write }
}
const budgets = { schemaVersion: 1, growth: { contentBytes: 1.1, fileCount: 1.1 }, targets: { 'darwin-arm64': { total: { contentBytes: 100, fileCount: 10 }, components: { python: 50 } } } }
describe('runtime size evidence and limits', () => {
  it('counts files and hardlinks separately from unique bytes and does not recurse through links', () => {
    const f = fixture(); const path = f.write('python/bin/python', '1234567890'); linkSync(path, join(f.runtime, 'hardlink')); f.write('skills/a.svg', 'abc')
    if (process.platform !== 'win32') symlinkSync('python', join(f.runtime, 'cycle'))
    const report = measureRuntime(f.runtime, { target: 'darwin-arm64', version: '1.1.1', sourceRevision: 'source', upstreamRevision: 'upstream' })
    expect(report.total).toMatchObject({ contentBytes: 23, uniqueBytes: 13, fileCount: 3, linkCount: process.platform === 'win32' ? 0 : 1 })
    expect(report.components.python).toMatchObject({ contentBytes: 10, fileCount: 1 })
    expect(() => enforceRuntimeBudget(report, budgets)).not.toThrow()
  })
  it('rejects total/component budgets and growth from a matching target baseline', () => {
    const f = fixture(); f.write('python/lib', 'a'.repeat(60))
    const report = measureRuntime(f.runtime, { target: 'darwin-arm64', version: '2' })
    expect(() => enforceRuntimeBudget(report, budgets)).toThrow(/python/)
    const baseline = { ...report, version: '1', total: { ...report.total, contentBytes: 40 } }
    expect(() => enforceRuntimeBudget(report, { ...budgets, targets: { 'darwin-arm64': { total: { contentBytes: 100 } } } }, baseline)).toThrow(/1 基线/)
    expect(() => enforceRuntimeBudget(report, budgets, { ...baseline, target: 'win-x64' })).toThrow(/目标不匹配/)
  })
  it('writes a rejected report for CI to retain rather than losing the failure evidence', () => {
    const f = fixture(); f.write('node', 'x'.repeat(101)); const path = join(f.root, 'budgets.json'); writeFileSync(path, JSON.stringify(budgets))
    const output = join(f.root, 'report.json')
    expect(() => writeRuntimeSizeReport(f.runtime, { target: 'darwin-arm64', version: '1', output, budgetPath: path })).toThrow(/超限/)
    expect(JSON.parse(readFileSync(output, 'utf8')).total.contentBytes).toBe(101)
    expect(() => measureRuntime(f.runtime, { target: 'unknown', version: '1' })).toThrow(/目标与版本/)
  })
})

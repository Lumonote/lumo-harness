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
  it('includes exact component counts in a Windows file limit failure without hiding files or relaxing its budget', () => {
    const f = fixture(); f.write('node_modules/package/a.js', 'runtime'); f.write('python/Lib/source.py', 'source')
    f.write('python/Lib/__pycache__/source.pyc', 'bytecode'); f.write('skills/template.svg', 'template')
    const report = measureRuntime(f.runtime, { target: 'win-x64', version: 'test' })
    const policy = { schemaVersion: 1, targets: { 'win-x64': { total: { contentBytes: 100, fileCount: 3 } } } }
    expect(report.total.fileCount).toBe(4)
    expect(() => enforceRuntimeBudget(report, policy)).toThrow(/win-x64.*fileCount 4 > 3.*python: 2 files \/ 14 bytes/)
    expect(report.components.python.fileCount).toBe(2)
    expect(policy.targets['win-x64'].total.fileCount).toBe(3)
  })
  it.each([
    ['darwin-arm64', 89660, 98626],
    ['darwin-x64', 89010, 97911],
    ['win-x64', 90510, 99561],
  ])('calibrates the %s file limit from its original staged-runtime evidence and keeps all other gates', (target, observed, limit) => {
    const evidence = `docs/verification/runtime-size-${target}-2026-11-10.json`
    const measured = JSON.parse(readFileSync(new URL(`../../../${evidence}`, import.meta.url), 'utf8'))
    const policy = JSON.parse(readFileSync(new URL('../runtime-size-budgets.json', import.meta.url), 'utf8'))
    const calibration = policy.targets[target].fileCountCalibration
    expect(measured.target).toBe(target)
    expect(measured.total.fileCount).toBe(observed)
    expect(calibration).toMatchObject({ observed: measured.total.fileCount, headroomRatio: 1.1, evidence, sourceRevision: measured.sourceRevision, upstreamRevision: measured.upstreamRevision, stage: 'staged-runtime-before-installer' })
    // Use the exact 110/100 fraction: binary 1.1 makes Math.ceil(90510 * 1.1)
    // spuriously add another file even though ten percent is an integer here.
    expect(policy.targets[target].total.fileCount).toBe(limit)
    expect(policy.targets[target].total.fileCount).toBe(Math.ceil(measured.total.fileCount * 110 / 100))
    expect(policy.targets[target].total.contentBytes).toBe(2147483648)
    expect(policy.targets[target].components).toEqual({ node_modules: 1717986918, python: 536870912, skills: 268435456 })
    expect(() => enforceRuntimeBudget(measured, policy)).not.toThrow()
    const previous = structuredClone(policy); previous.targets[target].total.fileCount = 80000
    expect(() => enforceRuntimeBudget(measured, previous)).toThrow(new RegExp(`fileCount ${observed} > 80000`))
    const overFiles = structuredClone(measured); overFiles.total.fileCount = Number(limit) + 1
    expect(() => enforceRuntimeBudget(overFiles, policy)).toThrow(new RegExp(`fileCount ${Number(limit) + 1} > ${limit}`))
    const overBytes = structuredClone(measured); overBytes.total.contentBytes = 2147483649
    expect(() => enforceRuntimeBudget(overBytes, policy)).toThrow(/contentBytes 2147483649 > 2147483648/)
    for (const [name, componentLimit] of Object.entries(policy.targets[target].components)) {
      const overComponent = structuredClone(measured); overComponent.components[name].contentBytes = Number(componentLimit) + 1
      expect(() => enforceRuntimeBudget(overComponent, policy)).toThrow(new RegExp(`${name} ${Number(componentLimit) + 1} > ${componentLimit}`))
    }
    for (const metric of ['contentBytes', 'fileCount']) {
      expect(policy.growth[metric]).toBe(1.1)
      const historical = structuredClone(measured); historical.version = 'prior'; historical.total[metric] = Math.floor(measured.total[metric] / 1.1) - 1
      expect(() => enforceRuntimeBudget(measured, policy, historical)).toThrow(new RegExp(`${metric} 超过 prior 基线的 1.1 倍`))
    }
  })
})

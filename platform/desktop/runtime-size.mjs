import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const desktop = dirname(fileURLToPath(import.meta.url))
const targets = new Set(['darwin-arm64', 'darwin-x64', 'win-x64'])
function gitRevision(root) {
  const result = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
  return result.status === 0 ? result.stdout.trim() : null
}

export function measureRuntime(root, { target, version, sourceRevision = null, upstreamRevision = null } = {}) {
  if (!targets.has(target) || typeof version !== 'string' || !version.trim()) throw Error('runtime 尺寸报告需要明确的目标与版本')
  const components = {}
  const total = { contentBytes: 0, uniqueBytes: 0, allocatedBytes: 0, fileCount: 0, linkCount: 0 }
  const inodes = new Set()
  const visit = path => {
    const stat = lstatSync(path)
    if (stat.isDirectory()) { for (const entry of readdirSync(path)) visit(resolve(path, entry)); return }
    const key = relative(root, path).split(sep)[0]
    const component = components[key] ??= { contentBytes: 0, fileCount: 0, linkCount: 0 }
    if (stat.isSymbolicLink()) { total.linkCount++; component.linkCount++; return }
    if (!stat.isFile()) throw Error(`runtime 尺寸统计不接受特殊文件：${path}`)
    total.contentBytes += stat.size; total.fileCount++
    component.contentBytes += stat.size; component.fileCount++
    const inode = `${stat.dev}:${stat.ino}`
    if (!inodes.has(inode)) {
      inodes.add(inode); total.uniqueBytes += stat.size
      if (Number.isFinite(stat.blocks) && total.allocatedBytes !== null) total.allocatedBytes += stat.blocks * 512
      else total.allocatedBytes = null
    }
  }
  visit(resolve(root))
  return { schemaVersion: 1, target, version, sourceRevision, upstreamRevision, generatedAt: new Date().toISOString(), total, components }
}

function validMetric(value) { return Number.isSafeInteger(value) && value >= 0 }
export function enforceRuntimeBudget(report, budgets, baseline) {
  const budget = budgets?.targets?.[report.target]
  if (budgets?.schemaVersion !== 1 || !budget) throw Error(`没有 ${report.target} 的 runtime 尺寸预算`)
  const failures = []
  for (const [metric, cap] of Object.entries(budget.total ?? {})) {
    if (!validMetric(cap) || !validMetric(report.total?.[metric])) throw Error(`无效的 runtime 尺寸指标：${metric}`)
    if (report.total[metric] > cap) failures.push(`${metric} ${report.total[metric]} > ${cap}`)
  }
  for (const [name, cap] of Object.entries(budget.components ?? {})) {
    if (!validMetric(cap)) throw Error(`无效的组件尺寸预算：${name}`)
    const bytes = report.components[name]?.contentBytes ?? 0
    if (bytes > cap) failures.push(`${name} ${bytes} > ${cap}`)
  }
  if (baseline !== undefined) {
    if (baseline?.schemaVersion !== 1 || baseline.target !== report.target || typeof baseline.version !== 'string'
      || !validMetric(baseline.total?.contentBytes) || !validMetric(baseline.total?.fileCount)) throw Error('runtime 尺寸基线格式或目标不匹配')
    for (const metric of ['contentBytes', 'fileCount']) {
      const ratio = budgets.growth?.[metric]
      if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 1) throw Error(`无效的 runtime 增长预算：${metric}`)
      if (report.total[metric] > Math.ceil(baseline.total[metric] * ratio)) failures.push(`${metric} 超过 ${baseline.version} 基线的 ${ratio} 倍`)
    }
  }
  if (failures.length) throw Error(`runtime 尺寸预算超限：${failures.join('；')}`)
}

export function writeRuntimeSizeReport(root, { target, version, output, budgetPath = resolve(desktop, 'runtime-size-budgets.json'), baselinePath } = {}) {
  const repo = resolve(desktop, '../..')
  const report = measureRuntime(root, { target, version, sourceRevision: gitRevision(repo), upstreamRevision: gitRevision(resolve(repo, 'deepseek-harness')) })
  mkdirSync(dirname(output), { recursive: true })
  // Write even on rejection so CI preserves the evidence causing the failure.
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`)
  const baseline = baselinePath ? JSON.parse(readFileSync(baselinePath, 'utf8')) : undefined
  enforceRuntimeBudget(report, JSON.parse(readFileSync(budgetPath, 'utf8')), baseline)
  return report
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [root, output] = process.argv.slice(2)
    if (!root || !output || !existsSync(resolve(root, 'runtime-manifest.json'))) throw Error('用法：node runtime-size.mjs RUNTIME REPORT.json（需要 runtime-manifest.json）')
    const manifest = JSON.parse(readFileSync(resolve(root, 'runtime-manifest.json'), 'utf8'))
    const report = writeRuntimeSizeReport(root, { target: manifest.target, version: manifest.version, output: resolve(output), baselinePath: process.env.LUMO_RUNTIME_SIZE_BASELINE })
    console.log(`${report.target} ${report.version}: ${report.total.contentBytes} bytes / ${report.total.fileCount} files`)
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}

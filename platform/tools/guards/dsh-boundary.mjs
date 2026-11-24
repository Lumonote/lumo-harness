// 守卫 2：deepseek-harness 边界。只允许走公开包入口（@deepseek-ai/<pkg> 或其公开子路径导出），
// 禁止相对路径穿进 deepseek-harness 源树、禁止深引 src/lib/dist/internal/tests/node_modules；
// 在有 git 的环境下还会检查 deepseek-harness 检出目录没有被就地修改。
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { walk, readText, lineOf } from './lib.mjs'

export const name = 'dsh-boundary'
export const description = '禁止 import / 修改 deepseek-harness 内部路径（存量按文件计数棘轮）'
const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*|vi\.mock\s*\(\s*)['"]([^'"\n]+)['"]/g

/** @returns {string|null} 违规原因 */
export function classify(spec) {
  if (/(^|\/)deepseek-harness\//.test(spec) || spec.startsWith('deepseek-harness')) return '相对/绝对路径穿进 deepseek-harness 源树'
  const m = /^@deepseek-ai\/[^/]+\/(.+)$/.exec(spec)
  if (m && /(^|\/)(src|lib|dist|internal|tests?|node_modules)(\/|$)/.test(m[1])) return '深引 @deepseek-ai 包的内部目录'
  return null
}

export function scan(platformRoot) {
  const out = {}
  for (const rel of walk(platformRoot)) {
    if (!CODE_EXT.includes(path.extname(rel))) continue
    if (rel.startsWith('tools/guards/')) continue
    const text = readText(path.join(platformRoot, rel))
    const hits = []
    for (const m of text.matchAll(IMPORT_RE)) {
      const why = classify(m[1])
      if (why) hits.push({ line: lineOf(text, m.index), spec: m[1], why })
    }
    if (hits.length) out[rel] = hits
  }
  return out
}

function dshTreeDirty(repoRoot) {
  const dsh = path.join(repoRoot, 'deepseek-harness')
  if (!fs.existsSync(path.join(dsh, '.git'))) return null
  const r = spawnSync('git', ['-C', dsh, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' })
  if (r.error || r.status !== 0) return null
  return r.stdout.trim()
}

export function check({ platformRoot, repoRoot, baseline = {}, checkGit = true }) {
  const allowed = baseline.files ?? {}
  const errors = []
  const warnings = []
  const found = scan(platformRoot)
  for (const [rel, hits] of Object.entries(found)) {
    const cap = allowed[rel] ?? 0
    if (hits.length > cap) {
      const sample = hits.slice(0, 3).map((h) => `L${h.line} '${h.spec}'（${h.why}）`).join('；')
      errors.push(`${rel}: ${hits.length} 处越界引用，baseline 允许 ${cap} 处。${sample}。请改走 @deepseek-ai/* 公开入口或 dsh-overrides 扩展点`)
    } else if (hits.length < cap) {
      warnings.push(`${rel}: 越界引用已从 ${cap} 降到 ${hits.length}，可运行 pnpm guard:baseline 收紧`)
    }
  }
  for (const rel of Object.keys(allowed)) {
    if (!found[rel]) warnings.push(`${rel}: 已无越界引用，可运行 pnpm guard:baseline 移出白名单`)
  }
  if (checkGit && repoRoot) {
    const dirty = dshTreeDirty(repoRoot)
    if (dirty) errors.push(`deepseek-harness/ 检出目录被就地修改（应只读，改动请走 dsh-overrides）：\n${dirty}`)
  }
  return { errors, warnings }
}

export function snapshot({ platformRoot }) {
  const files = {}
  for (const [rel, hits] of Object.entries(scan(platformRoot))) files[rel] = hits.length
  return { files }
}

// 守卫 6：组件内写死颜色（#hex / rgb() / hsl()）只告警，建议改用 var(--lumo-*)。不影响退出码。
import path from 'node:path'
import { walk, readText } from './lib.mjs'

export const name = 'hardcoded-colors'
export const description = '组件内禁止写死颜色（仅警告）'
const COLOR_IN_STRING = /(['"`])(?:(?!\1)[^\\\n]|\\.)*?(#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b|rgba?\(\s*\d|hsla?\(\s*\d)/g

export function findColors(source) {
  const hits = []
  source.split('\n').forEach((line, i) => {
    if (/^\s*(\/\/|\*)/.test(line)) return
    for (const m of line.matchAll(COLOR_IN_STRING)) hits.push({ line: i + 1, color: m[2] })
  })
  return hits
}

export function check({ platformRoot, verbose = false }) {
  const warnings = []
  for (const rel of walk(platformRoot)) {
    if (!rel.endsWith('.tsx')) continue
    if (!(rel.startsWith('dsh-plugins/') || rel.startsWith('console/'))) continue
    if (/(^|\/)__tests__\//.test(rel) || /\.(spec|test)\.tsx$/.test(rel)) continue
    const hits = findColors(readText(path.join(platformRoot, rel)))
    if (!hits.length) continue
    const shown = verbose ? hits : hits.slice(0, 3)
    warnings.push(`${rel}: ${hits.length} 处写死颜色（${shown.map((h) => `L${h.line} ${h.color}`).join('，')}${hits.length > shown.length ? ' …' : ''}），建议改用 var(--lumo-*)`)
  }
  return { errors: [], warnings }
}

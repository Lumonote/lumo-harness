// 守卫 5：数据库迁移只许追加。已登记迁移的内容哈希不得变化、不得删除；新迁移编号必须大于已登记的最大编号且不重复。
import path from 'node:path'
import fs from 'node:fs'
import { hashFile } from './lib.mjs'

export const name = 'migrations-append-only'
export const description = '迁移只能追加，不许改旧迁移（sha256 清单 baseline）'
export const MIGRATIONS_DIR = 'deploy/migrations'

function list(platformRoot, dir) {
  const abs = path.join(platformRoot, dir)
  if (!fs.existsSync(abs)) return {}
  const out = {}
  for (const f of fs.readdirSync(abs).sort()) if (f.endsWith('.sql')) out[f] = hashFile(path.join(abs, f))
  return out
}

const numberOf = (f) => { const m = /^(\d+)_/.exec(f); return m ? Number(m[1]) : NaN }

export function check({ platformRoot, baseline = {} }) {
  const dir = baseline.dir ?? MIGRATIONS_DIR
  const recorded = baseline.files ?? {}
  const current = list(platformRoot, dir)
  const errors = []
  const warnings = []
  for (const [f, h] of Object.entries(recorded)) {
    if (!(f in current)) errors.push(`${dir}/${f}: 已发布迁移被删除或改名（只能追加新迁移）`)
    else if (current[f] !== h) errors.push(`${dir}/${f}: 已发布迁移内容被修改（sha256 与 baseline 不符），请新增一个迁移来修正`)
  }
  const maxRecorded = Math.max(0, ...Object.keys(recorded).map(numberOf).filter(Number.isFinite))
  const seen = new Map()
  for (const f of Object.keys(current)) {
    const n = numberOf(f)
    if (!Number.isFinite(n)) { errors.push(`${dir}/${f}: 迁移文件名必须以数字编号开头（如 050_xxx.sql）`); continue }
    if (seen.has(n)) errors.push(`${dir}/${f}: 编号 ${n} 与 ${seen.get(n)} 重复`)
    seen.set(n, f)
    if (!(f in recorded)) {
      if (n <= maxRecorded) errors.push(`${dir}/${f}: 新迁移编号 ${n} 不大于已发布的最大编号 ${maxRecorded}，只能追加在末尾`)
      else warnings.push(`${dir}/${f}: 新迁移尚未登记，合入时运行 pnpm guard:baseline 登记哈希`)
    }
  }
  return { errors, warnings }
}

export function snapshot({ platformRoot, baseline = {} }) {
  const dir = baseline.dir ?? MIGRATIONS_DIR
  return { dir, files: list(platformRoot, dir) }
}

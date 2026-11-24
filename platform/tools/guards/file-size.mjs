// 守卫 1：源文件体积上限。新文件不得超过阈值；baseline 里的超大文件只许变小不许变大。
import fs from 'node:fs'
import path from 'node:path'
import { walk } from './lib.mjs'

export const name = 'file-size'
export const description = '源文件体积上限（baseline 棘轮：只许变小）'
export const LIMIT_BYTES = 60 * 1024
export const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.go', '.css', '.rs']

function sizes(platformRoot) {
  const out = {}
  for (const rel of walk(platformRoot)) {
    if (!EXTENSIONS.includes(path.extname(rel))) continue
    out[rel] = fs.statSync(path.join(platformRoot, rel)).size
  }
  return out
}

export function check({ platformRoot, baseline = {} }) {
  const limit = baseline.limitBytes ?? LIMIT_BYTES
  const files = baseline.files ?? {}
  const errors = []
  const warnings = []
  const current = sizes(platformRoot)
  for (const [rel, size] of Object.entries(current)) {
    const recorded = files[rel]
    if (recorded !== undefined) {
      if (size > recorded) {
        errors.push(`${rel}: ${size} 字节，超过 baseline ${recorded} 字节（超大文件只许变小，请拆分模块）`)
      } else if (size < recorded && size > limit) {
        warnings.push(`${rel}: 已从 ${recorded} 缩小到 ${size} 字节，可运行 pnpm guard:baseline 收紧 baseline`)
      }
    } else if (size > limit) {
      errors.push(`${rel}: ${size} 字节，超过上限 ${limit} 字节（新文件不允许超限，请拆分）`)
    }
  }
  for (const rel of Object.keys(files)) {
    if (current[rel] === undefined) warnings.push(`${rel}: baseline 中的文件已不存在，可运行 pnpm guard:baseline 清理`)
    else if (current[rel] <= limit) warnings.push(`${rel}: 已降到上限以内，可运行 pnpm guard:baseline 移出白名单`)
  }
  return { errors, warnings }
}

export function snapshot({ platformRoot, baseline = {} }) {
  const limit = baseline.limitBytes ?? LIMIT_BYTES
  const files = {}
  for (const [rel, size] of Object.entries(sizes(platformRoot))) if (size > limit) files[rel] = size
  return { limitBytes: limit, files }
}

// 守卫公共工具：纯 Node，无第三方依赖。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

/** 任意层级都跳过的目录名（构建产物、依赖、上游副本、本地工具状态）。 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', '.build', 'lib', 'dist', 'target', 'gen', 'coverage',
  'lumo-runtime', 'lumo-upstream-plugins', '.omc', '.pnpm-store', 'deepseek-harness',
  '.claude', '.superpowers', '.codegraph', '.serena', '.workbuddy', '.workbuddy-ai', '.idea',
])

/** 相对 platform 根跳过的前缀：固定上游 Skill 快照不归平台管。 */
export const SKIP_PREFIXES = ['upstream/skills/']

/**
 * 递归列出 root 下的文件（相对路径，统一 `/` 分隔，已排序）。
 * @param {string} root
 * @param {{skipDirs?: Set<string>, skipPrefixes?: string[]}} [opts]
 */
export function walk(root, opts = {}) {
  const skipDirs = opts.skipDirs ?? SKIP_DIRS
  const skipPrefixes = opts.skipPrefixes ?? SKIP_PREFIXES
  const out = []
  const visit = (rel) => {
    let entries
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) {
        if (skipDirs.has(e.name)) continue
        if (skipPrefixes.some((p) => `${r}/`.startsWith(p))) continue
        visit(r)
      } else if (e.isFile()) {
        out.push(r)
      }
    }
  }
  visit('')
  return out.sort()
}

export function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

/** sha256（先把 CRLF 归一成 LF，避免 Windows checkout 误报）。 */
export function hashFile(file) {
  const text = fs.readFileSync(file).toString('latin1').replace(/\r\n/g, '\n')
  return crypto.createHash('sha256').update(text, 'latin1').digest('hex')
}

export function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return fallback }
}

export function saveJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`)
}

/** 计算 1-based 行号。 */
export function lineOf(text, index) {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}

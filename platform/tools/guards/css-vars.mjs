// 守卫 4：CSS 中引用的 --lumo-* 变量必须在 lumo.css 中定义（运行时由 style 注入的变量登记在 baseline.runtimeVars）。
import path from 'node:path'
import fs from 'node:fs'
import { walk, readText, lineOf } from './lib.mjs'

export const name = 'css-vars'
export const description = 'CSS 引用的 --lumo-* 变量必须在 lumo.css 定义'
export const TOKENS_FILE = 'dsh-plugins/lumo-ui/src/client/lumo.css'

export function definedVars(css) {
  const out = new Set()
  for (const m of css.matchAll(/(--lumo-[\w-]+)\s*:/g)) out.add(m[1])
  return out
}

export function referencedVars(css) {
  const out = []
  for (const m of css.matchAll(/var\(\s*(--lumo-[\w-]+)/g)) out.push({ name: m[1], index: m.index })
  return out
}

export function check({ platformRoot, baseline = {} }) {
  const errors = []
  const tokensPath = path.join(platformRoot, baseline.tokensFile ?? TOKENS_FILE)
  if (!fs.existsSync(tokensPath)) return { errors: [`找不到主题变量文件 ${baseline.tokensFile ?? TOKENS_FILE}`], warnings: [] }
  const defined = definedVars(readText(tokensPath))
  for (const v of baseline.runtimeVars ?? []) defined.add(v)
  for (const rel of walk(platformRoot)) {
    if (!rel.endsWith('.css')) continue
    const css = readText(path.join(platformRoot, rel))
    const legacy = new Set(baseline.legacy?.[rel] ?? [])
    for (const ref of referencedVars(css)) {
      if (!defined.has(ref.name) && !legacy.has(ref.name)) errors.push(`${rel}:L${lineOf(css, ref.index)} 引用了未在 lumo.css 定义的 ${ref.name}`)
    }
  }
  return { errors, warnings: [] }
}

/** 存量未定义变量按文件登记为 legacy（只能删不能加）；runtimeVars 为人工登记项，原样保留。 */
export function snapshot({ platformRoot, baseline = {} }) {
  const tokensFile = baseline.tokensFile ?? TOKENS_FILE
  const defined = definedVars(readText(path.join(platformRoot, tokensFile)))
  for (const v of baseline.runtimeVars ?? []) defined.add(v)
  const legacy = {}
  for (const rel of walk(platformRoot)) {
    if (!rel.endsWith('.css')) continue
    const missing = [...new Set(referencedVars(readText(path.join(platformRoot, rel))).map((r) => r.name).filter((n) => !defined.has(n)))].sort()
    if (missing.length) legacy[rel] = missing
  }
  return { tokensFile, runtimeVars: baseline.runtimeVars ?? [], legacy }
}

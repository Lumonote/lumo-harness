import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/lumo.css', import.meta.url), 'utf8')

/**
 * 由 JS 在运行期设置、因此**不在这张样式表里定义**的变量。每一项都必须写明设置点——
 * 这张清单就是本用例的「运维自备清单」，与 `helm-verify.sh` 里那份同一个道理：
 * 一个被引用但既没被定义、也不在显式清单里的名字，必然是拼错或漏写。
 */
const setFromJavaScript = new Map([
  ['--lumo-native-sidebar-width', 'index.tsx:568 —— ResizeObserver 量出侧边栏宽度后 setProperty'],
  ['--lumo-order', 'index.tsx:961 / 1338 —— 列表项进入动画的序号，由行内 style 写入'],
])

describe('lumo.css', () => {
  it('defines every variable it uses, or names who sets it', () => {
    // A misspelled var() is not an error anywhere: the declaration is simply
    // dropped and the element inherits whatever was already there. So a rule can
    // reference a token that never existed and still "work" -- it just quietly
    // does nothing. This is the cheap check that makes those typos loud.
    const defined = new Set([...css.matchAll(/^\s*(--lumo-[a-z0-9-]+)\s*:/gm)].map(match => match[1]))
    const used = new Set([...css.matchAll(/var\(\s*(--lumo-[a-z0-9-]+)/g)].map(match => match[1]))
    const unaccounted = [...used]
      .filter(name => !defined.has(name) && !setFromJavaScript.has(name))
      .sort()
    expect(unaccounted).toEqual([])
  })

  it('keeps the JavaScript-set list honest', () => {
    // Otherwise the list above rots into a blanket exemption: a name that is no
    // longer set anywhere would still be waved through, and the next real typo
    // could hide behind it.
    const used = new Set([...css.matchAll(/var\(\s*(--lumo-[a-z0-9-]+)/g)].map(match => match[1]))
    const stale = [...setFromJavaScript.keys()].filter(name => !used.has(name)).sort()
    expect(stale).toEqual([])
  })

  it('balances its braces', () => {
    // A truncated file still parses as "some CSS" and the browser drops the rest
    // silently, so the styles for a whole surface can vanish without a signal.
    expect(css.split('{').length).toBe(css.split('}').length)
  })
})

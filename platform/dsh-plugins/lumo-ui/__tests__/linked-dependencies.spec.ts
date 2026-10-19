import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * 依赖必须真的能解析到磁盘上，而不是一条悬空链接。
 *
 * 2026-10 的事故：`@types/react` 曾 `link:` 到
 * `deepseek-harness/packages/client/ui-jobs/node_modules/@types/react`。上游 master
 * 把 @types/react 从 ui-jobs 的 devDependencies 挪到了仓库根，于是 pnpm 照旧按
 * package.json 建链接、`install --frozen-lockfile` 也不报错（它不校验 `link:` 目标
 * 是否存在），链接就此悬空。
 *
 * 症状与根因相隔很远：lumo-ui 的 `tsc -p` 报 TS7016「Could not find a declaration
 * file for module 'react'」，再连带几十条 TS7006 —— 失去 React 的上下文类型后，
 * 每个 JSX 回调参数都成了隐式 any，连 `<TopList>` 这类泛型组件的推断也塌成约束上界
 * （`row.model` 于是变成「UsageMeasure 上没有 model」）。整条 `cargo tauri build`
 * 挂在 beforeBuildCommand 上，日志里看不出与 `link:` 有任何关系。
 *
 * 判据放在这里而不是打包链上：`pnpm test` 一秒内红，桌面包要跑十分钟才红。
 */

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

interface Manifest {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const manifest = JSON.parse(readFileSync(resolve(pluginRoot, 'package.json'), 'utf8')) as Manifest
const declared = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
  .filter((entry): entry is [string, string] => typeof entry[1] === 'string')

/** 指向上游源码树的那些依赖 —— 上游改一次 devDependencies 就可能让它们悬空。 */
const linked = declared
  .filter(([, spec]) => spec.startsWith('link:'))
  .map(([name, spec]) => [name, resolve(pluginRoot, spec.slice('link:'.length))] as const)

describe('lumo-ui 的依赖解析', () => {
  it('至少登记了一条 link: 依赖（否则下面那条护栏等于没跑）', () => {
    expect(linked.length).toBeGreaterThan(0)
  })

  it.each(declared)('%s 能从 node_modules 解析到', (name) => {
    expect(
      existsSync(resolve(pluginRoot, 'node_modules', name, 'package.json')),
      `node_modules/${name} 解析不到 package.json（悬空链接或安装不完整？）`,
    ).toBe(true)
  })

  it.each(linked)('%s 的 link: 目标仍在磁盘上', (name, target) => {
    expect(existsSync(resolve(target, 'package.json')), `${name} 的 link: 目标不存在：${target}`).toBe(true)
  })
})

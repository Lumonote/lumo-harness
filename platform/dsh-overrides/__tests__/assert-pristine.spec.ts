import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assertPristineProductSource } from '../assert-pristine.mjs'

/**
 * 上游源码洁净度闸门。
 *
 * 构建**前**跑它，是为了拒绝把未迁移的产品改动打进包里；构建**后**再跑一次，是因为
 * `prepare-runtime.mjs` 会把源树的 node_modules 软链进暂存副本，pnpm 有可能顺着
 * workspace 链接把产物写回源码目录 —— 仓库里那 346 个 `.js/.d.ts/.map` 就是这么来的。
 * 只查前不查后，等于把这条路留着。
 *
 * 用临时 git 仓库测而不是真的 deepseek-harness：断言不能取决于用户此刻有没有还原。
 */

const temporaries: string[] = []
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true })
})

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' })
}

function write(root: string, relativePath: string, content: string): void {
  const target = resolve(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

/** 造一个形似 dsh 的最小仓库：apps/ 与 packages/ 各一个已提交文件。 */
function repository(label: string): string {
  const root = mkdtempSync(resolve(tmpdir(), `lumo-pristine-${label}-`))
  temporaries.push(root)
  git(root, ['init', '--quiet'])
  git(root, ['config', 'user.email', 'test@lumo.local'])
  git(root, ['config', 'user.name', 'lumo test'])
  write(root, 'apps/web/index.html', '<!doctype html>\n')
  write(root, 'packages/client/ui-theme/src/index.ts', 'export const upstream = true\n')
  write(root, 'README.md', 'upstream\n')
  git(root, ['add', '-A'])
  git(root, ['commit', '--quiet', '-m', 'baseline'])
  return root
}

describe('assertPristineProductSource', () => {
  it('干净的上游树放行', () => {
    expect(() => { assertPristineProductSource(repository('clean')) }).not.toThrow()
  })

  it('已跟踪文件被改则拒绝,并把改动清单带进报错', () => {
    const root = repository('tracked')
    write(root, 'packages/client/ui-theme/src/index.ts', 'export const upstream = false\n')
    expect(() => { assertPristineProductSource(root) })
      .toThrow(/tracked modifications[\s\S]*packages\/client\/ui-theme\/src\/index\.ts/u)
  })

  it('apps 或 packages 下的未跟踪产物被拒绝', () => {
    const compiled = repository('generated')
    write(compiled, 'packages/client/ui-theme/src/index.js', 'export const upstream = true\n')
    expect(() => { assertPristineProductSource(compiled) })
      .toThrow(/generated\/product files[\s\S]*packages\/client\/ui-theme\/src\/index\.js/u)

    const staged = repository('generated-apps')
    write(staged, 'apps/web/public/branding/logo.png', 'png')
    expect(() => { assertPristineProductSource(staged) }).toThrow(/apps\/web\/public\/branding\/logo\.png/u)
  })

  it('这两棵树之外的未跟踪文件放行 —— 工具状态与构建缓存不是产品改动', () => {
    const root = repository('outside')
    write(root, '.omc/state.json', '{}\n')
    write(root, 'scratch.txt', 'notes\n')
    expect(() => { assertPristineProductSource(root) }).not.toThrow()
  })

  it('被 .gitignore 排除的产物放行 —— node_modules 与 lib 是合法构建产物', () => {
    const root = repository('ignored')
    write(root, '.gitignore', 'node_modules/\nlib/\n')
    git(root, ['add', '.gitignore'])
    git(root, ['commit', '--quiet', '-m', 'ignore build output'])
    write(root, 'packages/client/ui-theme/node_modules/dep/index.js', '')
    write(root, 'packages/client/ui-theme/lib/index.js', '')
    expect(() => { assertPristineProductSource(root) }).not.toThrow()
  })
})

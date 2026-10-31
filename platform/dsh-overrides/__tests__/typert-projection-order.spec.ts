import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * typert 投影必须早于任何 `tsc -b`。
 *
 * `@deepseek-ai/dsh-api-<包名>/remote` 这些子路径的类型是 `scripts/generate-typert.ts` 的
 * 产物，而 `lib/` 是 gitignored：全新克隆（CI 桌面 job）一个都没有。开发树因为跑过
 * 全量构建而一直躺着这批文件，所以「顺序错了」在本机永远看不见 —— 2026-10-31 的
 * release run 41206681553 正是这么红的：两台 runner 各 10 条错误，三条 TS2307
 * 加上 ClientRemote 声明合并失效后的一连串级联。
 *
 * 判据盯「调用它的那一行」，不盯「提到它的那一行」：这两个脚本的注释里写满了这些
 * 名字，按第一次出现取下标会把注释当成调用点（本仓库已经踩过两次）。
 */

const here = dirname(fileURLToPath(import.meta.url))
const platformRoot = resolve(here, '..', '..')

function read(relativePath: string): string {
  return readFileSync(resolve(platformRoot, relativePath), 'utf8')
}

/** 取一个具名函数体的源码；找不到就当场失败，而不是让下面的下标比较空转。 */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`)
  expect(start, `${name} 不存在`).toBeGreaterThanOrEqual(0)
  const end = source.indexOf('\n}', start)
  expect(end, `${name} 的函数体没有结束标记`).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('typert 投影的生成时机', () => {
  it('prepare-runtime 在编 host 之前生成 typert 投影', () => {
    const body = functionBody(read('dsh-overrides/prepare-runtime.mjs'), 'ensureLibEntriesReexport')
    const generate = body.indexOf('generateTypertArtifacts(sourceRoot)')
    const compile = body.indexOf("'-b', config")
    expect(generate, 'ensureLibEntriesReexport 没有调用 generateTypertArtifacts').toBeGreaterThanOrEqual(0)
    expect(compile, 'ensureLibEntriesReexport 里找不到 host 编译调用').toBeGreaterThanOrEqual(0)
    expect(generate, 'typert 生成排在 host 编译之后——那正是 TS2307 的成因').toBeLessThan(compile)
  })

  it('build-runtime 在刷新 host 应用类型之前补齐 typert 投影', () => {
    const source = read('desktop/build-runtime.mjs')
    // 顶层调用点（行首无缩进），不是函数定义，也不是注释。
    const guard = source.indexOf('\nensureDshTypertRemoteProjection()\n')
    const refresh = source.indexOf('\nrefreshDshHostApplicationTypes()\n')
    expect(guard, 'build-runtime 的流水线里没有 ensureDshTypertRemoteProjection() 调用').toBeGreaterThanOrEqual(0)
    expect(refresh, 'build-runtime 的流水线里没有 refreshDshHostApplicationTypes() 调用').toBeGreaterThanOrEqual(0)
    expect(guard, 'typert 补齐排在 host 应用编译之后，编译仍会 TS2307').toBeLessThan(refresh)
  })

  it('源树缺投影时会让「lib 不新鲜」这条判据成立', () => {
    const source = read('dsh-overrides/prepare-runtime.mjs')
    // 探针列表里的这一条是唯一能触发全新克隆重建分支的东西：没有它，
    // 一个 lib/ 全空的源树也能让 fresh 判定为真，然后一路编译到 TS2307。
    expect(source).toContain("'packages/api/workspace-files/lib/typert.remote-client.d.ts'")
  })
})

import { readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureLibEntriesReexport } from '../prepare-runtime.mjs'

/**
 * prepare-runtime 的「源树自愈」回归护栏。
 *
 * CI 桌面 job 拿到的是 dsh 的全新克隆：gitignored 的 lib/ 一个都没有，而
 * copyBuildOutputs 在没有 lib/ 时直接抛错（该报错原本宣称「run pnpm run build
 * there first」—— 但当前 master 上 `pnpm run build` 的 tsdown 主机面是坏的，
 * 平台自己的等价管线 = tsc 双面 + synthesize-dsh-libs.mjs）。本用例钉住
 * ensureLibEntriesReexport 在「一个 lib 都没有」时也必须把 tsc 双面 + 合成
 * 跑起来，而不是返回跳过。
 *
 * 用假源树 + 假 tsc 测，不碰真正的 deepseek-harness：断言不能取决于构建机此刻
 * 是否装好了上游依赖（与 assert-pristine.spec.ts 同一纪律）。
 */

const temporaries: string[] = []
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true })
})

function write(root: string, relativePath: string, content: string): void {
  const target = resolve(root, relativePath)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, content)
}

/** 形似 dsh 的最小源树：三个包 + 假 tsc（把探针点名的 lib 文件写出来）。 */
function fakeDsh(label: string): { root: string; counter: string } {
  const root = mkdtempSync(resolve(tmpdir(), `lumo-prepare-${label}-`))
  temporaries.push(root)
  const counter = resolve(root, 'tsc-runs')
  write(root, 'package.json', '{"name":"fake-dsh","type":"module"}\n')
  write(root, 'tsconfig.host.json', '{"files":[]}\n')
  write(root, 'tsconfig.client.json', '{"files":[]}\n')
  write(root, 'packages/util/brand/package.json', '{"name":"@fake/brand","type":"module"}\n')
  write(root, 'packages/llm/llm/package.json', '{"name":"@fake/llm","type":"module"}\n')
  write(root, 'packages/core/agent/package.json', '{"name":"@fake/agent","type":"module"}\n')
  // 假 tsc：按探针清单把 lib/types 写出来，并在 counter 里记录每次被调用。
  // root 用 __dirname 推出（tsc 位于 <root>/node_modules/typescript/bin/），
  // 避免跨 spawnSync 传环境变量。
  write(root, 'node_modules/typescript/bin/tsc', `
const fs = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..', '..', '..')
const files = [
  ['packages/util/brand/lib/types/index.js', "export const brandString = 'runtime'\\n"],
  ['packages/llm/llm/lib/types/assistant-stream.d.ts', 'export declare function assistantStreamChunks(): void\\n'],
  ['packages/core/agent/lib/types/types.d.ts', 'export declare const InboxState: unknown\\n'],
  ['packages/core/agent/lib/types/index.d.ts', '(agentCtx: Context, agent: Agent)\\n'],
]
for (const [relative, content] of files) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
}
fs.appendFileSync(path.join(root, 'tsc-runs'), 'x')
`)
  return { root, counter }
}

describe('ensureLibEntriesReexport', () => {
  it('全新源树（无任何 lib/）自动执行 tsc 双面 + 合成，而不是跳过', () => {
    const { root, counter } = fakeDsh('fresh')

    expect(ensureLibEntriesReexport(root)).toBe(true)

    // tsc 双面各跑了一次；探针文件与合成包装都就位。
    expect(readFileSync(counter, 'utf8')).toHaveLength(2)
    expect(readFileSync(resolve(root, 'packages/util/brand/lib/types/index.js'), 'utf8'))
      .toContain('brandString')
    expect(readFileSync(resolve(root, 'packages/util/brand/lib/index.js'), 'utf8'))
      .toContain("export * from './types/index.js'")
    // 合成脚本只处理 lib/types 下的 .js；.d.ts 探针文件看内容就行。
    expect(readFileSync(resolve(root, 'packages/core/agent/lib/types/index.d.ts'), 'utf8'))
      .toContain('(agentCtx: Context, agent: Agent)')
  })

  it('已经新鲜的源树跳过重建（增量重复构建零成本）', () => {
    const { root, counter } = fakeDsh('fresh-then-idle')

    expect(ensureLibEntriesReexport(root)).toBe(true)
    const runsAfterFirst = readFileSync(counter, 'utf8').length

    // 第二次调用：探针全部新鲜 → 不再触发 tsc。
    expect(ensureLibEntriesReexport(root)).toBe(true)
    expect(readFileSync(counter, 'utf8')).toHaveLength(runsAfterFirst)
  })

  it('旧的 brand 空壳（缺 brandString 运行时导出）会被重跑 tsc 刷新', () => {
    const { root, counter } = fakeDsh('stale')
    // 先模拟「旧构建产物在位但缺少新导出」：只有核心探针文件，品牌仍缺 brandString。
    write(root, 'packages/util/brand/lib/types/index.js', 'export {};\n')
    write(root, 'packages/llm/llm/lib/types/assistant-stream.d.ts', 'export declare function assistantStreamChunks(): void\n')
    write(root, 'packages/core/agent/lib/types/types.d.ts', 'export declare const InboxState: unknown\n')
    write(root, 'packages/core/agent/lib/types/index.d.ts', '(agentCtx: Context, agent: Agent)\n')

    expect(ensureLibEntriesReexport(root)).toBe(true)

    expect(readFileSync(resolve(root, 'packages/util/brand/lib/types/index.js'), 'utf8'))
      .toContain('brandString')
    // 三处探针不新鲜只应触发一次双面重建（host + client），count 从 0 计。
    expect(readFileSync(counter, 'utf8')).toHaveLength(2)
  })
})

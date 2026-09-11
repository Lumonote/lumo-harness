import { chmodSync, existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureLibEntriesReexport, ensureNativeAddonsBuilt } from '../prepare-runtime.mjs'

/**
 * prepare-runtime 的「源树自愈」回归护栏。
 *
 * CI 桌面 job 拿到的是 dsh 的全新克隆：gitignored 的 lib/ 一个都没有，而
 * copyBuildOutputs 在没有 lib/ 时直接抛错（该报错原本宣称「run pnpm run build
 * there first」—— 但当前 master 上 `pnpm run build` 的 tsdown 主机面是坏的，
 * 平台自己的等价管线 = host tsc + synthesize-dsh-libs.mjs）。本用例钉住
 * ensureLibEntriesReexport 在「一个 lib 都没有」时也必须把 host tsc + 合成
 * 跑起来，而不是返回跳过。client tsc 依赖后续 host tsdown 生成的 remote 投影，
 * 由桌面构建链的后续阶段刷新。
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

/** 形似 dsh 的最小源树：探针包 + 假 tsc（把探针点名的 lib 文件写出来）。 */
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
  write(root, 'packages/util/native-command/package.json', '{"name":"@fake/native-command","type":"module"}\n')
  write(root, 'packages/skill/skill/package.json', '{"name":"@fake/skill","type":"module"}\n')
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
  ['packages/util/native-command/lib/types/index.d.ts', 'export { nativeFileManager, revealNativePath } from "./path-opener.ts"\\n'],
  // LIB_FRESHNESS_PROBES 的最后一处（SkillSummary.path）：漏写它会让「新鲜源树」
  // 永远判不新鲜，重复构建用例因此每轮都重跑 tsc。
  ['packages/skill/skill/lib/types/index.d.ts', '/** Absolute instruction file path when supplied by the provider */\\n'],
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

/**
 * 形似 dsh 的 native 工作区：平台包目录名是 `<platform>-<arch>`（与上游
 * native/system/packages/ 一致，npm 包名才带 node-addon-system- 前缀），外加一个
 * 假 tsx —— 像 build.ts 那样把宿主 addon 落到 <平台包>/bin/system.node。
 * 假脚本用 process.getBuiltinModule 取 fs/path（CJS/ESM 都可用，不赌 Node 对无扩展名
 * 文件的模块判定），路径按 cwd 推（prepare-runtime 就是以源树根为 cwd 调它）。
 */
function fakeNativeDsh(label: string): { root: string; counter: string; bin: string } {
  const root = mkdtempSync(resolve(tmpdir(), `lumo-native-${label}-`))
  temporaries.push(root)
  const host = `${process.platform}-${process.arch}`
  const counter = resolve(root, 'tsx-runs')
  const bin = resolve(root, 'native', 'system', 'packages', host, 'bin', 'system.node')
  write(root, 'package.json', '{"name":"fake-dsh","type":"module"}\n')
  write(root, `native/system/packages/${host}/prebuilds.json`,
    `{"platform":"${host}","binaries":[{"tool":"flock","kind":"node-api","napi":8,"path":"bin/system.node"}]}\n`)
  write(root, 'node_modules/.bin/tsx', `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
const bin = path.join(process.cwd(), 'native', 'system', 'packages', process.platform + '-' + process.arch, 'bin')
fs.mkdirSync(bin, { recursive: true })
fs.writeFileSync(path.join(bin, 'system.node'), 'fake-flock-binding')
fs.appendFileSync(path.join(process.cwd(), 'tsx-runs'), 'x')
`)
  chmodSync(resolve(root, 'node_modules', '.bin', 'tsx'), 0o755)
  return { root, counter, bin }
}

// win32 没有平台包（hostNativeAddonDirectoryName 返回 null），这段逻辑在 Windows 上不适用。
const posixOnly = it.skipIf(process.platform === 'win32')

describe('ensureNativeAddonsBuilt', () => {
  posixOnly('宿主平台包缺 bin/ 时按源树目录名 <platform>-<arch> 编译', () => {
    const { root, counter, bin } = fakeNativeDsh('host-addon')

    expect(existsSync(bin)).toBe(false)
    ensureNativeAddonsBuilt(root)

    // 回归：曾按 npm 包名 node-addon-system-<platform>-<arch> 拼源树路径，
    // existsSync 恒假 → 静默跳过编译 → 打出的 app 发消息才报
    // "Cannot find module .../bin/system.node"。
    expect(readFileSync(counter, 'utf8')).toHaveLength(1)
    expect(existsSync(bin)).toBe(true)
  })

  posixOnly('bin/ 已存在时不重复编译', () => {
    const { root, counter, bin } = fakeNativeDsh('host-addon-idempotent')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, 'already-built')

    ensureNativeAddonsBuilt(root)

    expect(existsSync(counter)).toBe(false)
    expect(readFileSync(bin, 'utf8')).toBe('already-built')
  })

  posixOnly('旧上游没有 native/system 工作区时跳过，不抛错', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lumo-native-absent-'))
    temporaries.push(root)
    write(root, 'package.json', '{"name":"fake-dsh","type":"module"}\n')

    expect(() => ensureNativeAddonsBuilt(root)).not.toThrow()
  })

  posixOnly('native 工作区在、却没有宿主平台目录时硬失败，而不是静默发出缺 addon 的包', () => {
    const root = mkdtempSync(resolve(tmpdir(), 'lumo-native-layout-'))
    temporaries.push(root)
    write(root, 'package.json', '{"name":"fake-dsh","type":"module"}\n')
    write(root, 'native/system/packages/other-x64/prebuilds.json', '{"platform":"other-x64","binaries":[]}\n')

    expect(() => ensureNativeAddonsBuilt(root)).toThrow(/上游 native\/system 目录布局变了/)
  })
})

describe('ensureLibEntriesReexport', () => {
  it('全新源树（无任何 lib/）自动执行 host tsc + 合成，而不是跳过', () => {
    const { root, counter } = fakeDsh('fresh')

    expect(ensureLibEntriesReexport(root)).toBe(true)

    // host tsc 跑了一次；探针文件与合成包装都就位。
    expect(readFileSync(counter, 'utf8')).toHaveLength(1)
    expect(readFileSync(resolve(root, 'packages/util/brand/lib/types/index.js'), 'utf8'))
      .toContain('brandString')
    expect(readFileSync(resolve(root, 'packages/util/brand/lib/index.js'), 'utf8'))
      .toContain("export * from './types/index.js'")
    // 合成脚本只处理 lib/types 下的 .js；.d.ts 探针文件看内容就行。
    expect(readFileSync(resolve(root, 'packages/core/agent/lib/types/index.d.ts'), 'utf8'))
      .toContain('(agentCtx: Context, agent: Agent)')
    expect(readFileSync(resolve(root, 'packages/util/native-command/lib/types/index.d.ts'), 'utf8'))
      .toContain('revealNativePath')
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
    write(root, 'packages/util/native-command/lib/types/index.d.ts', 'export { nativeFileManager, revealNativePath } from "./path-opener.ts"\n')

    expect(ensureLibEntriesReexport(root)).toBe(true)

    expect(readFileSync(resolve(root, 'packages/util/brand/lib/types/index.js'), 'utf8'))
      .toContain('brandString')
    // 三处探针不新鲜只应触发一次 host 重建，count 从 0 计。
    expect(readFileSync(counter, 'utf8')).toHaveLength(1)
  })
})

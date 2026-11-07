import { chmodSync, existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { ensureLibEntriesReexport, ensureNativeAddonsBuilt, hasTypertRemoteProjection } from '../prepare-runtime.mjs'

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
function fakeDsh(label: string, options: { typertProjection?: boolean } = {}): { root: string; counter: string } {
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
  // typert 投影（`@deepseek-ai/dsh-api-<包名>/remote` 的类型面）。它是 typert 生成物，
  // 不是 tsc 产物，所以假 tsc 不会写它——由夹具直接放好，表示「这棵树已经生成过」。
  // 缺它的场景单独用 options.typertProjection = false 构造。
  if (options.typertProjection !== false) {
    write(root, 'packages/api/workspace-files/lib/typert.remote-client.d.ts', 'interface TypertRemoteNamespaceMap {}\n')
  }
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
  // SkillSummary.path：漏写它会让「新鲜源树」
  // 永远判不新鲜，重复构建用例因此每轮都重跑 tsc。
  ['packages/skill/skill/lib/types/index.d.ts', '/** Absolute instruction file path when supplied by the provider */\\n'],
  ['packages/typert/protocol/lib/types/types.d.ts', 'create: () => TypertSchema\\n'],
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
 * 假 tsx —— 像 build.ts 那样按 manifest 把宿主/libc addon 落盘。
 * 假脚本用 process.getBuiltinModule 取 fs/path（CJS/ESM 都可用，不赌 Node 对无扩展名
 * 文件的模块判定），路径按 cwd 推（prepare-runtime 就是以源树根为 cwd 调它）。
 */
function fakeNativeDsh(label: string): { root: string; counter: string; bin: string } {
  const root = mkdtempSync(resolve(tmpdir(), `lumo-native-${label}-`))
  temporaries.push(root)
  const host = `${process.platform}-${process.arch}`
  const libc = process.platform === 'linux'
    ? ((process.report!.getReport() as { header: { glibcVersionRuntime?: string } }).header.glibcVersionRuntime ? 'glibc' : 'musl')
    : undefined
  const addonPath = libc === undefined ? 'bin/system.node' : `bin/${libc}/system.node`
  const counter = resolve(root, 'tsx-runs')
  const bin = resolve(root, 'native', 'system', 'packages', host, addonPath)
  write(root, 'package.json', '{"name":"fake-dsh","type":"module"}\n')
  write(root, `native/system/packages/${host}/prebuilds.json`,
    JSON.stringify({ platform: host, binaries: [{ tool: 'flock', kind: 'node-api', napi: 8, libc, path: addonPath }] }))
  write(root, 'node_modules/.bin/tsx', `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
const bin = path.resolve(process.cwd(), ${JSON.stringify(`native/system/packages/${host}/${addonPath}`)})
fs.mkdirSync(path.dirname(bin), { recursive: true })
fs.writeFileSync(bin, 'fake-flock-binding')
fs.appendFileSync(path.join(process.cwd(), 'tsx-runs'), 'x')
`)
  chmodSync(resolve(root, 'node_modules', '.bin', 'tsx'), 0o755)
  return { root, counter, bin }
}

describe('Typert projection completeness', () => {
  it('detects an omitted session-controller face even when workspace-files is present', () => {
    const { root } = fakeDsh('partial-typert')
    write(root, 'packages/api/session-controller/package.json', JSON.stringify({
      name: '@deepseek-ai/dsh-api-session-controller',
      exports: {
        './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
        './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
      },
    }))
    expect(hasTypertRemoteProjection(root)).toBe(false)
    write(root, 'packages/api/session-controller/lib/typert.remote-client.d.ts', 'interface TypertRemoteNamespaceMap {}\n')
    expect(hasTypertRemoteProjection(root)).toBe(false)
    write(root, 'packages/api/session-controller/lib/typert.host.d.ts', 'export declare const TYPERT: unknown\n')
    expect(hasTypertRemoteProjection(root)).toBe(true)
    rmSync(resolve(root, 'packages/api/session-controller/lib/typert.remote-client.d.ts'))
    expect(hasTypertRemoteProjection(root)).toBe(false)
  })
})

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

  posixOnly('宿主 addon 非空且已存在时不重复编译', () => {
    const { root, counter, bin } = fakeNativeDsh('host-addon-idempotent')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, 'already-built')

    ensureNativeAddonsBuilt(root)

    expect(existsSync(counter)).toBe(false)
    expect(readFileSync(bin, 'utf8')).toBe('already-built')
  })

  posixOnly('仅有 bin/ 目录或空 addon 时仍需编译', () => {
    const { root, counter, bin } = fakeNativeDsh('host-addon-empty')
    mkdirSync(dirname(bin), { recursive: true })
    writeFileSync(bin, '')

    ensureNativeAddonsBuilt(root)

    expect(readFileSync(counter, 'utf8')).toHaveLength(1)
    expect(readFileSync(bin, 'utf8')).toBe('fake-flock-binding')
  })

  posixOnly('manifest 未声明宿主 addon 时硬失败', () => {
    const { root, counter } = fakeNativeDsh('host-addon-manifest')
    write(root, `native/system/packages/${process.platform}-${process.arch}/prebuilds.json`, JSON.stringify({
      platform: `${process.platform}-${process.arch}`,
      binaries: [{ tool: 'landlock-run', kind: 'static-musl', path: 'bin/landlock-run' }],
    }))

    expect(() => ensureNativeAddonsBuilt(root)).toThrow(/未声明宿主/)
    expect(existsSync(counter)).toBe(false)
  })

  posixOnly('manifest 的 addon 路径不能逃出 bin/', () => {
    const { root, counter } = fakeNativeDsh('host-addon-path')
    const manifestPath = `native/system/packages/${process.platform}-${process.arch}/prebuilds.json`
    const manifest = JSON.parse(readFileSync(resolve(root, manifestPath), 'utf8'))
    manifest.binaries[0].path = '../system.node'
    write(root, manifestPath, JSON.stringify(manifest))

    expect(() => ensureNativeAddonsBuilt(root)).toThrow(/addon path 必须位于/)
    expect(existsSync(counter)).toBe(false)
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

  // 探针清单里的 typert 一条是唯一能让「其余产物都新鲜、只缺 remote 投影」的树进入
  // 重建分支的东西。少了它，fresh 判为真、函数直接返回，接着 build-runtime 的
  // `tsc -b apps/cli apps/desktop-host` 会在 `import type {} from '…/remote'` 处
  // TS2307 —— 正是 release run 41206681553 红掉的那 20 条。
  // 这条用例不断言「生成成功」（那要跑真 tsx），只断言分支确实被走进：假树没有
  // scripts/generate-typert.ts，所以它当场报一条可执行的错，而不是静默通过。
  it('只有 typert 投影缺失也算不新鲜，会走进生成分支而不是直接返回', () => {
    const { root } = fakeDsh('missing-typert-only', { typertProjection: false })
    // 其余探针全部写新鲜：只要 typert 没进清单，fresh 就会为真。
    write(root, 'packages/util/brand/lib/types/index.js', "export const brandString = 'runtime'\n")
    write(root, 'packages/llm/llm/lib/types/assistant-stream.d.ts', 'export declare function assistantStreamChunks(): void\n')
    write(root, 'packages/core/agent/lib/types/types.d.ts', 'export declare const InboxState: unknown\n')
    write(root, 'packages/core/agent/lib/types/index.d.ts', '(agentCtx: Context, agent: Agent)\n')
    write(root, 'packages/util/native-command/lib/types/index.d.ts', 'export { nativeFileManager, revealNativePath } from "./path-opener.ts"\n')
    write(root, 'packages/skill/skill/lib/types/index.d.ts', '/** Absolute instruction file path when supplied by the provider */\n')
    write(root, 'packages/typert/protocol/lib/types/types.d.ts', 'create: () => TypertSchema\n')

    expect(() => ensureLibEntriesReexport(root)).toThrow(/generate-typert\.ts/)
  })
})

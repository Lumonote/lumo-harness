import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import { applyLumoDshOverrides, diagnoseOverlayAnchors, overriddenPackageDirectories } from '../apply.mjs'
import { brandWebBuild } from '../brand-web.mjs'

/**
 * dsh 覆盖层的回归护栏。
 *
 * 这两个脚本是第一铁律的兑现方式：产品改动落在**暂存副本**上，上游 checkout 保持
 * 原样。代价是 `apply.mjs` 靠字符串锚点定位插入位置 —— 上游一次重构就会让锚点失配，
 * 而失败点原本只在跑完整桌面构建时才暴露。这里把它拉到单元测试里。
 *
 * `brand-web.mjs` 这部分接管的是上游 `apps/web/tests/pwa-manifest.e2e.ts` 曾经背的
 * 断言：那份用例当时被就地改成断言 Lumo 品牌，随迁移一并还原成上游版本，品牌契约
 * 从此由本文件负责。
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const dshRoot = resolve(process.env['LUMO_DSH_SOURCE_ROOT'] ?? resolve(repoRoot, 'deepseek-harness'))

/** 覆盖层触碰的上游文件；保留旧项目顺序以稳定现有用例的读取下标。 */
const PATCHED = [
  'packages/client/ui-conversation/src/client/apply.ts',
  'packages/client/ui-conversation/src/client/contract/slots.ts',
  // 2026-09（e62587c163）后 hero composer 的渲染点在这里：`ConversationRoot.tsx`
  // 已退化成转发壳，`heroWorkspaceRow` / `inputBar` 都搬进了本文件。
  'packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx',
  'packages/client/ui-sidebar/src/client/index.ts',
  'packages/client/ui-sidebar/src/client/contract/slots.ts',
  'packages/client/ui-sidebar/src/client/SidebarRoot.tsx',
  'packages/client/ui-model-selection/src/client/directory.ts',
  // 根 tsdown.config.ts 在列表尾部：前面 0-5 的下标是既有测试的读取约定。
  'tsdown.config.ts',
  'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx',
  'packages/client/ui-workspace/src/client/locales.ts',
  // LUMO_STREAM_RESILIENCE：流韧性三补丁（背压/载波退避/会话自动重开）。
  'packages/api/gateway/src/stream-server.ts',
  'packages/api/gateway/src/client/remote-stream.ts',
  'packages/api/session-controller/src/client/sessions/session.ts',
  // Client activation audit and initial entry creation isolation.
  'packages/client/web/src/boot-client.ts',
  'packages/client/modules/src/client/entries.ts',
  // LUMO_BEST_EFFORT_BOOT：web 启动壳里的插件降级点。
  'packages/client/web/src/boot.ts',
  // LUMO_LIBRARY_FILE_PREVIEW：导出 DSH 原生阅读器并重建该客户端包。
  'packages/client/ui-sidebar-documentpreview/src/client/index.ts',
]

const temporaries: string[] = []
afterEach(() => {
  for (const path of temporaries.splice(0)) rmSync(path, { recursive: true, force: true })
})

function temporaryRoot(label: string): string {
  const root = mkdtempSync(resolve(tmpdir(), `lumo-overlay-${label}-`))
  temporaries.push(root)
  return root
}

/**
 * 把上游当前 HEAD 的文件铺进临时目录。走 `git show` 而不是读工作区 —— 工作区可能
 * 带着尚未迁移的改动，那样测的就不是「覆盖层能否作用于干净上游」了。
 *
 * 走 HEAD 而不是某个固定 tag：上游 checkout 跟随 master，所以这份护栏会自动对着
 * 最新上游跑，`git pull` 之后锚点若漂移，跑测试就红，不必等到打桌面包才发现。
 */
function stagePristineUpstream(label: string): string {
  const root = temporaryRoot(label)
  for (const relativePath of PATCHED) {
    const source = execFileSync('git', ['-C', dshRoot, 'show', `HEAD:${relativePath}`], { encoding: 'utf8' })
    const target = resolve(root, relativePath)
    mkdirSync(dirname(target), { recursive: true })
    writeFileSync(target, source)
  }
  return root
}

function read(root: string, relativePath: string): string {
  return readFileSync(resolve(root, relativePath), 'utf8')
}

describe('applyLumoDshOverrides', () => {
  it('全部锚点与上游 HEAD 同步,一次报全漂移点而不是逐个抛错', () => {
    // 上游一次重构常同时漂移多处，而 replaceExactlyOnce 在第一个失配处就抛错——
    // 逐个修要跑 N 遍完整桌面构建才知道下一个卡在哪。诊断模式一次报全：返回非空
    // 即覆盖层落后于上游，失败信息里直接给出文件与锚点文本。
    expect(diagnoseOverlayAnchors(stagePristineUpstream('diagnose'))).toEqual([])
  })

  it.each(['index,invariant,startup', 'index,startup'])('tsdown 兼容上游 %s 入口,保留 client 面且重复执行幂等', (entries) => {
    const root = stagePristineUpstream('tsdown-entry')
    const target = resolve(root, 'tsdown.config.ts')
    // 固定两代上游入口，避免 HEAD 前进后旧布局的兼容性失去覆盖。
    writeFileSync(target, `export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    entry: client ? '' : ['lib/types/{${entries}}.js'],
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
`)

    expect(diagnoseOverlayAnchors(root)).toEqual([])
    const patched = read(root, 'tsdown.config.ts')
    expect(patched).toContain("entry: client ? '' : ['lib/types/index.js'],")
    expect(patched).not.toContain('lib/types/{')
    expect(patched).toContain("plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })]")

    applyLumoDshOverrides(root)
    expect(read(root, 'tsdown.config.ts')).toBe(patched)
  })

  it('tsdown 出现未知入口布局时仍拒绝并报告失配', () => {
    const root = stagePristineUpstream('tsdown-unknown')
    writeFileSync(resolve(root, 'tsdown.config.ts'), "export default { entry: ['lib/types/renamed.js'] }\n")

    expect(() => { applyLumoDshOverrides(root) }).toThrow(/tsdown\.config\.ts does not contain the expected upstream anchor/u)
    expect(diagnoseOverlayAnchors(root)).toEqual([
      expect.objectContaining({ file: 'tsdown.config.ts', kind: 'missing' }),
    ])
  })

  /**
   * `send()` 回调体的两代形状。
   *
   * 上游 2026-10（master）把回调体从 `if (error) reject(error) / else resolve()` 改成
   * early-return + `alive()` 活跃度记账。旧写法把整块（含回调体）当锚，于是本地 checkout
   * 还停在 dsh-v0.2.1-alpha.1、CI 却 checkout master，**本机全绿而 Windows 桌面打包在
   * `beforeBuildCommand` 上失配**。这条用例把两代回调体都钉住：补丁只许依赖 send() 的
   * 结构骨架，不许依赖回调体长什么样。
   */
  const SEND_SHAPES: Record<string, { preamble: string; callback: string }> = {
    '旧回调体（dsh-v0.2.1-alpha.1）': {
      preamble: '',
      callback: "      this.socket.send(text, (error) => {\n"
        + "        if (error) reject(error)\n"
        + "        else resolve()\n"
        + "      })\n",
    },
    '新回调体（master 的 alive 记账）': {
      // `queued` 的声明在 send 调用之前，补丁的插入点正好落在两者之间 —— 夹具按真实
      // 布局分开写，否则「回调体原样保留」那条断言会因为插入点而被误判。
      preamble: "      let queued = false\n",
      callback: "      this.socket.send(text, (error) => {\n"
        + "        if (error) {\n"
        + "          reject(error)\n"
        + "          return\n"
        + "        }\n"
        + "        if (queued) this.alive()\n"
        + "        resolve()\n"
        + "      })\n"
        + "      // Read after send(): bytes still buffered mean the local send buffer was\n"
        + "      // full, so their completion requires the peer to acknowledge data.\n"
        + "      queued = this.socket.bufferedAmount > 0\n",
    },
    '压缩选项（0.2.2）': {
      preamble: '      let queued = false\n',
      callback: '      this.socket.send(text, {\n'
        + '        compress: this.compression && text.length >= 1024,\n'
        + '      }, (error) => {\n'
        + '        if (error) { reject(error); return }\n'
        + '        if (queued) this.alive()\n'
        + '        resolve()\n'
        + '      })\n'
        + '      queued = this.socket.bufferedAmount > 0\n',
    },
  }

  /**
   * 只保留补丁真正触碰的骨架：常量行、readyState 守卫、send 调用、writes 链尾。
   *
   * 夹具里**不能出现**补丁的护栏标记本身（`patchFile` 用 `source.includes(marker)`
   * 判「已打过」，标记出现在夹具里 = 整份文件被跳过，用例会以「补丁没落上」的形式
   * 失败，而真实原因是幂等判据把夹具当成了已打补丁的上游）。
   */
  function streamServerFixture(shape: { preamble: string; callback: string }): string {
    return "/** Fixture: the send() skeleton the stream-resilience patch anchors on. */\n"
      + "import WebSocket from 'ws'\n\n"
      + "const MAX_MISSED_HEARTBEATS = 2\n\n"
      + "export class RemoteStreamMuxConnection {\n"
      + "  private writes: Promise<void> = Promise.resolve()\n\n"
      + "  private send(text: string): Promise<void> {\n"
      + "    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {\n"
      + "      if (this.socket.readyState !== WebSocket.OPEN) {\n"
      + "        reject(new Error('api gateway: Remote stream socket is closed'))\n"
      + "        return\n"
      + "      }\n"
      + shape.preamble
      + shape.callback
      + "    }))\n"
      + "    this.writes = delivery.catch(() => undefined)\n"
      + "    return delivery\n"
      + "  }\n"
      + "}\n"
  }

  it.each(Object.entries(SEND_SHAPES))('stream-server 补丁不依赖 send() 回调体形状:%s', (_label, shape) => {
    const root = stagePristineUpstream('stream-server-shape')
    const relativePath = 'packages/api/gateway/src/stream-server.ts'
    writeFileSync(resolve(root, relativePath), streamServerFixture(shape))

    expect(diagnoseOverlayAnchors(root)).toEqual([])
    const patched = read(root, relativePath)
    // 背压上限、flush 截止时间、以及「落定即销表」三件事都要落在骨架上。
    expect(patched).toContain('bufferedAmount > LUMO_SEND_BUFFERED_LIMIT')
    expect(patched).toContain('LUMO_SEND_FLUSH_TIMEOUT_MS')
    expect(patched).toContain('did not flush before the deadline')
    expect(patched).toContain('const bounded = delivery.finally(')
    // 回调体原样保留 —— 补丁不该顺手改写上游的活跃度记账。
    expect(patched).toContain(shape.callback)
  })

  it.each([
    '      <div className={css.sectionHeader}>\n',
    '      <div className={clsx(css.sectionHeader, wide && searchSpacingMotionEnabled && css.searchSpacingMotion)}>\n',
    '      <div className={clsx(css.sectionHeader, wide && searchSpacingMotionEnabled && css.searchSpacingMotion)} data-sidebar-workspace-header="">\n',
  ])('不再覆盖历史目录 header:%s', (header) => {
    const root = stagePristineUpstream('history-header')
    const file = 'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx'
    writeFileSync(resolve(root, file), `function History() { return (\n${header}        native header\n      </div>\n) }`)
    expect(diagnoseOverlayAnchors(root)).toEqual([])
    const patched = read(root, file)
    expect(patched).toContain(header)
    expect(patched).not.toContain("actions.setGroupBy('flat'); setQuery('')")
    applyLumoDshOverrides(root)
    expect(read(root, file)).toBe(patched)
  })

  it('会话、侧栏与项目目录完全使用公开扩展位，保留原生源码字节', () => {
    const root = stagePristineUpstream('anchors')
    applyLumoDshOverrides(root)
    for (const file of [...PATCHED.slice(0, 6), 'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx', 'packages/client/ui-workspace/src/client/locales.ts']) {
      expect(read(root, file)).toBe(execFileSync('git', ['show', `HEAD:${file}`], { cwd: dshRoot, encoding: 'utf8' }))
    }
    for (const directory of ['packages/client/ui-conversation', 'packages/client/ui-sidebar', 'packages/client/ui-workspace']) {
      expect(overriddenPackageDirectories).not.toContain(directory)
    }

    // LUMO_STREAM_RESILIENCE：三处流韧性补丁都落上，且带各自的护栏标记。
    const streamServer = read(root, 'packages/api/gateway/src/stream-server.ts')
    expect(streamServer).toContain('LUMO_SEND_FLUSH_TIMEOUT_MS')
    expect(streamServer).toContain('LUMO_SEND_BUFFERED_LIMIT')
    expect(streamServer).toContain('bufferedAmount > LUMO_SEND_BUFFERED_LIMIT')
    expect(streamServer).toContain('did not flush before the deadline')

    const remoteStream = read(root, 'packages/api/gateway/src/client/remote-stream.ts')
    expect(remoteStream).toContain('LUMO_CARRIER_BACKOFF')
    expect(remoteStream).toContain('if (attempt <= 5)')
    // 保留原有「首次失败立即重试」的快速路径，只有后续失败才退避。
    expect(remoteStream).toContain('if (attempt === 1) return')

    const session = read(root, 'packages/api/session-controller/src/client/sessions/session.ts')
    expect(session).toContain('scheduleStreamReopen')
    expect(session).toContain('private reopenTimer')
    // terminal 失败不再是不归路：failEventStream 与 doOpen catch 都必须挂上自动重开。
    expect(session.match(/this\.scheduleStreamReopen\(\)/gu)?.length).toBeGreaterThanOrEqual(2)
    // 剪枝时清掉重开定时器，避免僵尸复活。
    expect(session).toContain('a pruned session must not resurrect itself')

  })

  it.each([false, true])('原生启动隔离保留上游源码 (session-status: %s)', (sessionStatus) => {
    const root = stagePristineUpstream('native-boot')
    const files = [
      'packages/client/web/src/boot-client.ts',
      'packages/client/modules/src/client/entries.ts',
      'packages/client/web/src/boot.ts',
    ]
    const statusLine = "  '@deepseek-ai/dsh-client-ui-session-status',\n"
    const sessionLine = "  '@deepseek-ai/dsh-client-ui-session',\n"
    const audit = read(root, files[0]!).replace(statusLine, '')
    writeFileSync(resolve(root, files[0]!), audit.replace(sessionLine, sessionLine + (sessionStatus ? statusLine : '')))
    const boot = read(root, files[2]!).replace(/(await bootClient\(\{\n        ctx,\n        )modules(?:: this\.modules)?,/u,
      sessionStatus ? '$1modules,' : '$1modules: this.modules,')
    writeFileSync(resolve(root, files[2]!), boot)
    const originals = files.map(file => read(root, file))
    applyLumoDshOverrides(root)
    expect(files.map(file => read(root, file))).toEqual(originals)
    expect(originals[0]).toContain('const requiredClientEntryNames = new Set<string>([')
    expect(originals[0]).toContain('if (required > 0) {')
    expect(originals[0]).toContain('throw new Error(`web boot: ${String(required)} required')
    expect(originals[0]).toContain('warn(`web boot: warning:')
    expect(originals[1]).toContain('.catch((error: unknown) => { loader.ctx.logger.error(error) })')
    expect(originals[2]).not.toContain('ClientActivationError')
  })

  it('旧版web启动仍兼容原有逐插件失败隔离', () => {
    const root = stagePristineUpstream('legacy-boot')
    writeFileSync(resolve(root, 'packages/client/web/src/boot-client.ts'),
      "import { STATE_LABELS } from './loader-status.ts'\n"
        + "    throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\\n${failures.join('\\n')}`)\n")
    writeFileSync(resolve(root, 'packages/client/modules/src/client/entries.ts'),
      "      await Promise.all(this.desired.plugins.map(async ({ id }) => {\n"
        + "        await this.create(loader, id)\n"
        + "      }))\n"
        + "      await loader.await()\n")
    writeFileSync(resolve(root, 'packages/client/web/src/boot.ts'),
      "import { bootClient } from './boot-client.ts'\n"
        + "   * Load and activate every client entry, then hand the mount point to the\n"
        + "   * UI renderer. Plugin failures remain visible on the boot page.\n"
        + "      await bootClient({\n"
        + "        ctx,\n"
        + "        modules: this.modules,\n"
        + "        manifest: this.manifest,\n"
        + "        onEntryState: (name, state) => {\n"
        + "          if (onFailure === undefined || state !== 'failed') this.page.setState(name, state)\n"
        + "        },\n"
        + "      })\n"
        + "      await mountClient(ctx, this.container)\n")
    applyLumoDshOverrides(root)
    const source = read(root, 'packages/client/web/src/boot.ts')
    const audit = read(root, 'packages/client/web/src/boot-client.ts')
    expect(source).toContain('LUMO_BEST_EFFORT_BOOT')
    expect(source).toMatch(/try \{\n\s+await bootClient\(\{/u)
    expect(source).not.toContain('entryStates')
    expect(audit).toContain('throw new ClientActivationError(failures)')
    expect(source).toContain('if (!(bootFailure instanceof ClientActivationError)) throw bootFailure')
    expect(source).toContain("if (ctx.get('uiRenderer') === undefined)")
    expect(source).toMatch(/for \(const failure of bootFailure.failures\)[^]*await mountClient\(ctx, this\.container\)/u)
  })

  it('原生启动的未知关键插件失败处理仍会报锚点失配', () => {
    const root = stagePristineUpstream('unknown-boot')
    const file = 'packages/client/web/src/boot-client.ts'
    writeFileSync(resolve(root, file), read(root, file).replace('if (required > 0) {', 'if (required > 1) {'))
    expect(() => { applyLumoDshOverrides(root) }).toThrow(/boot-client\.ts does not contain the expected upstream anchor/u)
    expect(diagnoseOverlayAnchors(root)).toEqual([
      expect.objectContaining({ file, kind: 'missing' }),
    ])
  })

  it('覆盖层改过的包都被登记为「要重建」,否则补丁永远不会进产物', () => {
    // 隔离构建会把 overriddenPackageDirectories 里的包的旧 lib/ 排除在投影之外，
    // 只让快照自己重编这些包。补丁打在没登记的包上 = 改了源码但产物仍是旧的
    // （上一轮 ui-sidebar 插槽缺失就是这么安静漏出去的），因此逐个核对。
    // 根级文件（tsdown.config.ts）不属于任何包，按定义没有可登记的目录。
    const directories = new Set(PATCHED
      .map(path => /^(packages\/[^/]+\/[^/]+)\//u.exec(path)?.[1])
      .filter((directory): directory is string => directory !== undefined))
    expect(directories.size).toBeGreaterThan(0)
    for (const directory of directories) {
      if (['packages/client/ui-conversation', 'packages/client/ui-sidebar', 'packages/client/ui-workspace'].includes(directory)) continue
      expect(overriddenPackageDirectories, `${directory} 未登记,补丁不会进产物`).toContain(directory)
    }
  })

  it('原生 input.dock 覆盖空白和已发消息会话，无会话冷启动保持原生禁用语义', () => {
    const root = stagePristineUpstream('scope')
    applyLumoDshOverrides(root)
    const source = read(root, PATCHED[2]!)
    expect(source).toContain("{zone !== undefined && renderSlot('conversation.input.dock', zone)}")
    expect(source).toContain('session === undefined || inputState === undefined ? undefined : { session, input: inputState }')
    expect(source).not.toContain('conversation.hero.composer.dock')
  })

  it('重复执行是幂等的,不会打第二遍', () => {
    const root = stagePristineUpstream('idempotent')
    applyLumoDshOverrides(root)
    const once = PATCHED.map(path => read(root, path))
    applyLumoDshOverrides(root)
    expect(PATCHED.map(path => read(root, path))).toEqual(once)
  })

  it('锚点消失时立刻报错并点名文件,而不是静默少打一个扩展位', () => {
    const root = stagePristineUpstream('missing')
    const target = resolve(root, 'packages/api/gateway/src/stream-server.ts')
    writeFileSync(target, readFileSync(target, 'utf8').replace('const MAX_MISSED_HEARTBEATS = 2', 'const MAX_MISSED_HEARTBEATS = 3'))
    expect(() => { applyLumoDshOverrides(root) }).toThrow(/stream-server\.ts does not contain the expected upstream anchor/u)
  })

  it('锚点出现多次时拒绝,而不是赌第一处是对的', () => {
    const root = stagePristineUpstream('ambiguous')
    const target = resolve(root, 'packages/api/gateway/src/stream-server.ts')
    const source = readFileSync(target, 'utf8')
    const anchor = 'const MAX_MISSED_HEARTBEATS = 2\n'
    writeFileSync(target, source.replace(anchor, anchor + anchor))
    expect(() => { applyLumoDshOverrides(root) }).toThrow(/contains the upstream anchor more than once/u)
  })
})

describe('brandWebBuild', () => {
  /** 造一份最小 dist：只有 brandWebBuild 会读写的两个文件。 */
  function stageDist(label: string, options: { index?: string; manifest?: string } = {}): string {
    const root = temporaryRoot(label)
    const dist = resolve(root, 'apps', 'web', 'dist')
    mkdirSync(dist, { recursive: true })
    if (options.index !== undefined) writeFileSync(resolve(dist, 'index.html'), options.index)
    if (options.manifest !== undefined) writeFileSync(resolve(dist, 'manifest.webmanifest'), options.manifest)
    return root
  }

  const UPSTREAM_INDEX = '<!doctype html><html><head>'
    + '<link rel="manifest" href="/manifest.webmanifest" />'
    + '<link rel="icon" type="image/svg+xml" href="/favicon.svg" />'
    + '<title>DSH Local Build</title></head><body></body></html>'
  const UPSTREAM_MANIFEST = JSON.stringify({
    name: 'DeepSeek Harness',
    short_name: 'DSH',
    start_url: '/',
    display: 'fullscreen',
    icons: [{ src: '/favicon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  })

  it('把构建产物换成 Lumo 品牌,并落下 PNG 图标', () => {
    const root = stageDist('brand', { index: UPSTREAM_INDEX, manifest: UPSTREAM_MANIFEST })
    brandWebBuild(root)

    const dist = resolve(root, 'apps', 'web', 'dist')
    const html = readFileSync(resolve(dist, 'index.html'), 'utf8')
    expect(html).toContain('<link rel="icon" type="image/png" href="/branding/logo.png" />')
    expect(html).toContain('<title>Lumo</title>')
    expect(html).not.toContain('favicon.svg')
    expect(html).not.toContain('DSH Local Build')
    // manifest 的 link 不是图标 link,替换正则不能顺手把它吃掉。
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />')

    const manifest = JSON.parse(readFileSync(resolve(dist, 'manifest.webmanifest'), 'utf8'))
    expect(manifest.name).toBe('Lumo')
    expect(manifest.short_name).toBe('Lumo')
    expect(manifest.icons).toEqual([{ src: '/branding/logo.png', sizes: '512x512', type: 'image/png', purpose: 'any' }])
    // start_url / display 是上游的产品决定,品牌覆盖不该动它们。
    expect(manifest.start_url).toBe('/')
    expect(manifest.display).toBe('fullscreen')

    expect(existsSync(resolve(dist, 'branding', 'logo.png'))).toBe(true)
  })

  it('对已品牌化的 dist 重跑仍然收敛到同一结果', () => {
    const root = stageDist('rebrand', { index: UPSTREAM_INDEX, manifest: UPSTREAM_MANIFEST })
    brandWebBuild(root)
    const dist = resolve(root, 'apps', 'web', 'dist')
    const once = readFileSync(resolve(dist, 'index.html'), 'utf8')
    brandWebBuild(root)
    expect(readFileSync(resolve(dist, 'index.html'), 'utf8')).toBe(once)
  })

  it('dist 不完整时报错,而不是产出一个半品牌化的包', () => {
    expect(() => { brandWebBuild(stageDist('no-manifest', { index: UPSTREAM_INDEX })) })
      .toThrow(/requires a completed DSH Web build/u)
    expect(() => { brandWebBuild(stageDist('no-index', { manifest: UPSTREAM_MANIFEST })) })
      .toThrow(/requires a completed DSH Web build/u)
  })
})

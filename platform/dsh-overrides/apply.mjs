import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const overlayRoot = dirname(fileURLToPath(import.meta.url))

// Copying and cache invalidation must use the same asset inventory.
export const overlayAssetPaths = ['sidebar-documentpreview/PdfDataPreview.tsx', 'sidebar-documentpreview/ExcelDataPreview.tsx']

/**
 * 锚点失配诊断开关。
 *
 * 跟随上游 master 的主要代价是锚点漂移（见 README）。`replaceExactlyOnce` 在第一个
 * 失配处就抛错，于是一次上游重构得跑 N 遍完整桌面构建才能把漂移点找全 —— 定位成本
 * 全压在打包链尾部的失败上。诊断模式下改为「记录失配、继续往下走」，
 * `diagnoseOverlayAnchors()` 一次给出完整清单。
 *
 * 收集模式仍然照常落盘，因为同一个文件常有多段补丁，后一段的锚点就是前一段的产物
 * （同一文件的后续替换可能消费先前的产物）。跳过落盘会把
 * 这类依赖报成假失配。诊断只在一次性副本上跑，写坏没有代价。
 */
const missedAnchors = []
let collecting = false

function replaceExactlyOnce(source, before, after, file) {
  const first = source.indexOf(before)
  if (first === -1) {
    if (collecting) {
      missedAnchors.push({ file, anchor: before, kind: 'missing' })
      return source
    }
    throw new Error(`Lumo DSH overlay: ${file} does not contain the expected upstream anchor: ${JSON.stringify(before.slice(0, 240))}`)
  }
  if (source.indexOf(before, first + before.length) !== -1) {
    if (collecting) {
      missedAnchors.push({ file, anchor: before, kind: 'ambiguous' })
      return source
    }
    throw new Error(`Lumo DSH overlay: ${file} contains the upstream anchor more than once`)
  }
  return source.slice(0, first) + after + source.slice(first + before.length)
}

function patchFile(root, relativePath, replacements, marker = 'LUMO_DSH_OVERLAY') {
  const file = resolve(root, relativePath)
  let source = readFileSync(file, 'utf8')
  if (source.includes(marker)) return
  for (const [before, after] of replacements) source = replaceExactlyOnce(source, before, after, relativePath)
  writeFileSync(file, source)
}

function addLibraryDocumentPreview(root) {
  const targetRoot = resolve(root, 'packages/client/ui-sidebar-documentpreview/src/client')
  for (const asset of overlayAssetPaths) {
    const name = asset.slice(asset.lastIndexOf('/') + 1)
    const target = resolve(targetRoot, name)
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(resolve(overlayRoot, asset), target)
  }
  const exportLine = "export type { DocumentLoadMode, DocumentPreviewDefinition } from './document/registry.ts'\n"
  patchFile(root, 'packages/client/ui-sidebar-documentpreview/src/client/index.ts', [[
    exportLine,
    `${exportLine}\n// LUMO_LIBRARY_FILE_PREVIEW: reuse DSH's lazy PDF and spreadsheet viewers for library bytes.\nexport { PdfDataPreview } from './PdfDataPreview.tsx'\nexport { ExcelDataPreview } from './ExcelDataPreview.tsx'\n`,
  ]], 'LUMO_LIBRARY_FILE_PREVIEW')
}

/**
 * The packages whose sources this overlay rewrites. They are the only packages
 * that must be rebuilt inside the snapshot; every other package can reuse the
 * build outputs the upstream worktree already produced. Staging reads this to
 * decide which build outputs to project, so keep it in step with the patches
 * applied below.
 */
export const overriddenPackageDirectories = [
  // Lumo 的资料库预览直接复用此包导出的 Office PDF 与表格查看器。
  'packages/client/ui-sidebar-documentpreview',
  'packages/client/ui-model-selection',
  // LUMO_STREAM_RESILIENCE: 聊天「内容消失 / 对话卡住」链路修复涉及的三个包
  // （服务端 WS mux 背压、客户端载波退避、Session 事件流自动重开）。
  'packages/api/gateway',
  'packages/api/session-controller',
  // Initial plugin creation and the Web activation audit must isolate failures.
  'packages/client/modules',
  // LUMO_BEST_EFFORT_BOOT: 单个插件未激活不阻止可用界面启动。
  'packages/client/web',
]

/**
 * Apply the existing overlay inventory (6 package scopes and root tsdown). This must
 * only be called for an isolated checkout/copy, never the upstream worktree.
 */
export function applyLumoDshOverrides(root) {
  addLibraryDocumentPreview(root)
  // 上游 master 重构期（2026-09 · 76fda72979）根配置的花括号 entry 对 dsh-root 解析
  // 断裂（Cannot find entry: ["lib/types/{index,invariant,startup}.js"]），整个 host
  // tsdown 序失败——typert 的 lib/typert.remote-client.* 投影与 host 包 bundle 全部
  // 缺失。改为 index 单入口：invariant/startup 的附加入口由 synthesize-dsh-libs.mjs
  // 以再导出形状补齐，dsh-root 本就不进运行时。typert 投影由 build-runtime.mjs 的
  // rebuildDshHostArtifacts() 在快照上重产出。
  // 上游后来移除了 invariant 入口；两种已知布局都仍需收敛为 index 单入口。
  // 只选择已知锚点，未知布局仍由 patchFile 报错，诊断模式也照常收集失配。
  const tsdownSource = readFileSync(resolve(root, 'tsdown.config.ts'), 'utf8')
  const tsdownHostEntries = tsdownSource.includes('lib/types/{index,invariant,startup}.js')
    ? 'index,invariant,startup'
    : 'index,startup'
  patchFile(root, 'tsdown.config.ts', [[
    `    entry: client ? '' : ['lib/types/{${tsdownHostEntries}}.js'],\n`,
    "    entry: client ? '' : ['lib/types/index.js'], // LUMO_DSH_TYSDOWN_ENTRY: 花括号 entry 在重构期对 dsh-root 解析断裂,见 apply.mjs 注释\n",
  ]], 'LUMO_DSH_TYSDOWN_ENTRY')

  patchFile(root, 'packages/client/ui-model-selection/src/client/directory.ts', [
    [
      "    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {\n",
      "    // LUMO_MODEL_CATALOG: advisory models do not wait for history restoration.\n"
        + "    if (catalog.status !== 'ready' || catalog.value === null) {\n",
    ],
    [
      "    const selection = projected.next ?? catalog.value.default\n",
      "    // A missing projection is unknown, not an empty durable selection.\n"
        + "    const selection = projected === undefined\n"
        + "      ? this.store.getSnapshot().current\n"
        + "      : projected.next ?? catalog.value.default\n",
    ],
    [
      "    const routable = catalog.value.groups.some(group => group.id === selection.provider\n",
      "    const routable = selection === null ? null : catalog.value.groups.some(group => group.id === selection.provider\n",
    ],
  ], 'LUMO_MODEL_CATALOG')

  // ── LUMO_STREAM_RESILIENCE ─────────────────────────────────────────────────
  // 桌面端「聊天内容突然消失 / 对话卡住」的链路修复。因果链：
  //   1. gateway stream-server 的 send() 把所有帧排进共享写链 this.writes，单个
  //      flush 回调不触发（WebView 停止消费/背压）会永久冻结整条连接的全部流，
  //      且无超时 —— 「卡住」。
  //   2. 客户端 RemoteStream 的载波重试在连接看似存活时第 2 次失败直接 terminal，
  //      无退避 —— 宿主短暂繁忙即被误判为终态。
  //   3. Session.failEventStream 收到 terminal 后置 openState='error' 且不自愈，
  //      会话停在错误态直到手动刷新 —— 「消失」。
  // 三处补丁对应消除 1/2/3。

  // 1) 服务端：每帧 flush 加截止时间 + bufferedAmount 上限；毒化 socket 直接
  //    terminate，让客户端走既有载波重连，而不是陪它一起冻结。
  patchFile(root, 'packages/api/gateway/src/stream-server.ts', [
    [
      "const MAX_MISSED_HEARTBEATS = 2\n",
      "const MAX_MISSED_HEARTBEATS = 2\n"
        + "// LUMO_STREAM_BACKPRESSURE: per-frame flush deadline and buffered-byte cap;\n"
        + "// both must exceed the heartbeat interval so heartbeat pongs stay the\n"
        + "// authoritative liveness signal.\n"
        + "const LUMO_SEND_FLUSH_TIMEOUT_MS = 30_000\n"
        + "const LUMO_SEND_BUFFERED_LIMIT = 8 * 1024 * 1024\n",
    ],
    // 下面四段都只锚 `send()` 的**结构骨架**，绝不锚回调体。
    //
    // 起因：上游 2026-10 把回调体从 `if (error) reject(error) / else resolve()` 改写成
    // early-return + `alive()` 记账（还顺手在 send 前后加了 `queued` 判定），于是
    // 「整块当锚」的写法在 CI 的 Windows 桌面打包里失配：`does not contain the expected
    // upstream anchor`，整条 `cargo tauri build` 挂在 beforeBuildCommand 上。
    //
    // 教训同 README「锚点只锚座位名、不锚 scope」：**锚的是这件事发生在哪，不是它长什么样**。
    // 回调体是上游正在演进的地方（背压、活跃度记账都往这里加），骨架才是稳定的：
    // `delivery = this.writes.then(...)`、readyState 守卫、`socket.send(text, cb)` 调用行、
    // `writes = delivery.catch(...)` 在这次重构里一行没动。
    //
    // 代价是「销表」从回调内挪到 promise 的 `finally` —— 语义等价（delivery 一落定就销表），
    // 换来的是不需要知道回调体长什么样。`settled` 标志也随之不再需要：promise 只落定一次，
    // 迟到的 send 回调再 reject 是空操作。
    [
      "    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {\n",
      "    let lumoSendDeadline: ReturnType<typeof setTimeout> | undefined\n"
        + "    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {\n",
    ],
    [
      "        reject(new Error('api gateway: Remote stream socket is closed'))\n"
        + "        return\n"
        + "      }\n",
      "        reject(new Error('api gateway: Remote stream socket is closed'))\n"
        + "        return\n"
        + "      }\n"
        + "      // LUMO_STREAM_BACKPRESSURE: a peer that stops draining the socket used\n"
        + "      // to wedge the shared writes chain forever, freezing every logical\n"
        + "      // stream on this connection with no timeout. Terminate the toxic\n"
        + "      // socket so clients reconnect via carrier retry instead of hanging.\n"
        + "      if (this.socket.bufferedAmount > LUMO_SEND_BUFFERED_LIMIT) {\n"
        + "        this.socket.terminate()\n"
        + "        reject(new Error('api gateway: Remote stream socket backpressure exceeded'))\n"
        + "        return\n"
        + "      }\n",
    ],
    [
      "      this.socket.send(text,",
      "      // LUMO_STREAM_BACKPRESSURE: bound the flush itself. A WebView that stops\n"
        + "      // consuming leaves the send callback pending forever; terminate on the\n"
        + "      // deadline so carrier retry, not a hung promise, owns recovery.\n"
        + "      lumoSendDeadline = setTimeout(() => {\n"
        + "        this.socket.terminate()\n"
        + "        reject(new Error('api gateway: Remote stream send did not flush before the deadline'))\n"
        + "      }, LUMO_SEND_FLUSH_TIMEOUT_MS)\n"
        + "      this.socket.send(text,",
    ],
    [
      "    this.writes = delivery.catch(() => undefined)\n"
        + "    return delivery\n",
      "    // LUMO_STREAM_BACKPRESSURE: release the deadline whichever way the frame\n"
        + "    // settles, so a flushed frame never leaves a 30s timer behind.\n"
        + "    const bounded = delivery.finally(() => {\n"
        + "      if (lumoSendDeadline !== undefined) clearTimeout(lumoSendDeadline)\n"
        + "    })\n"
        + "    this.writes = bounded.catch(() => undefined)\n"
        + "    return bounded\n",
    ],
  ], 'LUMO_STREAM_BACKPRESSURE')

  // 2) 客户端：连接看似存活时的连续载波失败由「第 2 次即 terminal」改为有界指数
  //    退避（2/4/8s，5 次封顶），宿主短暂繁忙不再撕裂会话的事件窗口。
  patchFile(root, 'packages/api/gateway/src/client/remote-stream.ts', [[
    "  signal.throwIfAborted()\n"
      + "  if (connection.generation.getSnapshot() !== undefined) {\n"
      + "    if (attempt === 1) return\n"
      + "    throw error\n"
      + "  }\n",
    "  signal.throwIfAborted()\n"
      + "  if (connection.generation.getSnapshot() !== undefined) {\n"
      + "    if (attempt === 1) return\n"
      + "    // LUMO_CARRIER_BACKOFF: an alive-looking connection that keeps failing\n"
      + "    // the carrier used to go terminal on the second attempt, tearing the\n"
      + "    // session's event window down. A bounded exponential backoff lets a\n"
      + "    // busy or restarting host self-heal before the domain layer sees a\n"
      + "    // terminal error.\n"
      + "    if (attempt <= 5) {\n"
      + "      await new Promise<void>((resolve, reject) => {\n"
      + "        let timer: ReturnType<typeof setTimeout> | undefined\n"
      + "        const aborted = (): void => {\n"
      + "          if (timer !== undefined) clearTimeout(timer)\n"
      + "          reject(new Error('Remote stream retry backoff aborted', { cause: signal.reason }))\n"
      + "        }\n"
      + "        timer = setTimeout(() => {\n"
      + "          signal.removeEventListener('abort', aborted)\n"
      + "          resolve()\n"
      + "        }, Math.min(1000 * 2 ** (attempt - 2), 8000))\n"
      + "        signal.addEventListener('abort', aborted, { once: true })\n"
      + "      })\n"
      + "      return\n"
      + "    }\n"
      + "    throw error\n"
      + "  }\n",
  ]], 'LUMO_CARRIER_BACKOFF')

  // 3) Session 层：terminal 失败后保留事件窗口（eventSource 本就不清），并以有界
  //    退避自动重开事件流；open() 成功走 replace 全量恢复窗口，无需手动刷新。
  patchFile(root, 'packages/api/session-controller/src/client/sessions/session.ts', [
    [
      "  /** Owns the addressed page/follow lifecycle while this Session is open. */\n"
        + "  private events: SessionEventStream | undefined\n",
      "  /** Owns the addressed page/follow lifecycle while this Session is open. */\n"
        + "  private events: SessionEventStream | undefined\n"
        + "  // LUMO_STREAM_RESILIENCE: pending auto-reopen timer and consecutive-failure count.\n"
        + "  private reopenTimer: ReturnType<typeof setTimeout> | undefined\n"
        + "  private reopenAttempts = 0\n",
    ],
    [
      // Clear at dispose entry, ahead of retirement callbacks and event teardown.
      "  async dispose(): Promise<void> {\n"
        + "    this.stopObservingInbox()\n",
      "  async dispose(): Promise<void> {\n"
        + "    if (this.reopenTimer !== undefined) {\n"
        + "      clearTimeout(this.reopenTimer) // LUMO_STREAM_RESILIENCE: a pruned session must not resurrect itself.\n"
        + "      this.reopenTimer = undefined\n"
        + "    }\n"
        + "    this.stopObservingInbox()\n",
    ],
    [
      "      await events.open(HISTORY_PAGE_OPTIONS)\n"
        + "      if (generation !== this.openGeneration || this.events !== events) return\n"
        + "      this.openState = 'open'\n",
      "      await events.open(HISTORY_PAGE_OPTIONS)\n"
        + "      if (generation !== this.openGeneration || this.events !== events) return\n"
        + "      this.openState = 'open'\n"
        + "      this.reopenAttempts = 0 // LUMO_STREAM_RESILIENCE: a healthy open resets the backoff ladder.\n",
    ],
    [
      "      if (!isRemoteFailure(error)) throw error\n"
        + "      this.events = undefined\n"
        + "      this.openState = 'error'\n"
        + "      this.openError = error\n"
        + "    } finally {\n",
      "      if (!isRemoteFailure(error)) throw error\n"
        + "      this.events = undefined\n"
        + "      this.openState = 'error'\n"
        + "      this.openError = error\n"
        + "      // LUMO_STREAM_RESILIENCE: same as failEventStream — keep the\n"
        + "      // resident eventSource window and schedule a bounded reopen\n"
        + "      // instead of leaving the session stuck in error until refresh.\n"
        + "      this.scheduleStreamReopen()\n"
        + "    } finally {\n",
    ],
    [
      "    this.openState = 'error'\n"
        + "    this.openError = error\n"
        + "    void events.dispose()\n"
        + "    this.notifier.markDirty()\n"
        + "  }\n",
      "    this.openState = 'error'\n"
        + "    this.openError = error\n"
        + "    void events.dispose()\n"
        + "    this.notifier.markDirty()\n"
        + "    // LUMO_STREAM_RESILIENCE: the visible event window survives in\n"
        + "    // eventSource; a bounded backoff reopen restores live delivery\n"
        + "    // (open() → replace) instead of leaving the session dead until a\n"
        + "    // manual refresh.\n"
        + "    this.scheduleStreamReopen()\n"
        + "  }\n"
        + "\n"
        + "  /** LUMO_STREAM_RESILIENCE: bounded exponential-backoff reopen of the event stream. */\n"
        + "  private scheduleStreamReopen(): void {\n"
        + "    if (this.reopenTimer !== undefined || this.openState !== 'error') return\n"
        + "    if (this.reopenAttempts >= 5) return\n"
        + "    const attempt = ++this.reopenAttempts\n"
        + "    this.reopenTimer = setTimeout(() => {\n"
        + "      this.reopenTimer = undefined\n"
        + "      if (this.openState !== 'error' || this.removed) return\n"
        + "      void this.open().catch(() => undefined).then(() => {\n"
        + "        // A failed reopen lands back in the 'error' state; keep backing off.\n"
        + "        if (this.openState === 'error') this.scheduleStreamReopen()\n"
        + "      })\n"
        + "    }, Math.min(1000 * 2 ** (attempt - 1), 15000))\n"
        + "  }\n",
    ],
  ], 'LUMO_STREAM_RESILIENCE')

  const bootAuditFile = 'packages/client/web/src/boot-client.ts'
  const bootAuditSource = readFileSync(resolve(root, bootAuditFile), 'utf8')
  if (bootAuditSource.includes('const requiredClientEntryNames = new Set<string>([')) {
    // fcc0ad46 upstream now owns optional-entry isolation and the required-entry
    // boot gate. Keep those sources intact; these no-op anchors still reject
    // unknown layouts instead of silently bypassing compatibility diagnostics.
    const bootFile = 'packages/client/web/src/boot.ts'
    const bootSource = readFileSync(resolve(root, bootFile), 'utf8')
    // 2e39e704 also requires session-status and passes the local module loader.
    const sessionStatusEntry = "  '@deepseek-ai/dsh-client-ui-session-status',\n"
    const nativeBootAnchors = [
      [bootAuditFile, [
        "const requiredClientEntryNames = new Set<string>([\n"
          + "  '@deepseek-ai/dsh-client-modules',\n"
          + "  '@deepseek-ai/dsh-api-session-controller',\n"
          + "  '@deepseek-ai/dsh-client-ui-renderer',\n"
          + "  '@deepseek-ai/dsh-client-ui-layout',\n"
          + "  '@deepseek-ai/dsh-client-ui-session',\n"
          + (bootAuditSource.includes(sessionStatusEntry) ? sessionStatusEntry : '')
          + "  '@deepseek-ai/dsh-client-ui-chat',\n"
          + "  '@deepseek-ai/dsh-client-ui-sidebar',\n"
          + "])\n",
        "  if (required > 0) {\n"
          + "    const lines = failures.map(({ name, reason }) => `${name}${isRequired(name) ? ' (required)' : ''}: ${reason}`)\n"
          + "    throw new Error(`web boot: ${String(required)} required ${entryNoun(required)} did not activate\\n${lines.join('\\n')}`)\n"
          + "  }\n",
        "  warn(`web boot: warning: ${String(failures.length)} ${entryNoun(failures.length)} did not activate\\n${lines.join('\\n')}`)\n",
      ]],
      ['packages/client/modules/src/client/entries.ts', [
        "      await Promise.all(this.desired.plugins.map(async ({ id }) => {\n"
          + "        await this.create(loader, id).catch((error: unknown) => { loader.ctx.logger.error(error) })\n"
          + "      }))\n"
          + "      await loader.await()\n",
      ]],
      [bootFile, [
        "import { bootClient } from './boot-client.ts'\n",
        "      await bootClient({\n"
          + "        ctx,\n"
          + (bootSource.includes('        modules: this.modules,\n') ? '        modules: this.modules,\n' : '        modules,\n')
          + "        manifest: this.manifest,\n"
          + "        // A failed entry may be optional; only the audit decides whether the boot page reports a failure.\n"
          + "        onEntryState: (name, state) => {\n"
          + "          if (state !== 'failed') this.page.setState(name, state)\n"
          + "        },\n"
          + "      })\n",
        "      await mountClient(ctx, this.container)\n"
          + "    } catch (reason) {\n"
          + "      console.error(reason)\n"
          + "      if (onFailure !== undefined) onFailure(reason)\n"
          + "      else this.page.fail(reason instanceof Error ? reason.message : String(reason))\n",
      ]],
    ]
    for (const [file, anchors] of nativeBootAnchors) {
      const source = readFileSync(resolve(root, file), 'utf8')
      for (const anchor of anchors) replaceExactlyOnce(source, anchor, anchor, file)
    }
    return
  }
  // A fiber starts PENDING and emits internal/status only on transitions. The
  // activation audit owns the final states; an event ledger can miss a plugin
  // that never receives a required service such as settingsScope.
  patchFile(root, 'packages/client/web/src/boot-client.ts', [
    [
      "import { STATE_LABELS } from './loader-status.ts'\n",
      "import { STATE_LABELS } from './loader-status.ts'\n\n"
        + "/** LUMO_CLIENT_ACTIVATION_ERROR: settled per-plugin failures, independent of bootstrap errors. */\n"
        + "export class ClientActivationError extends Error {\n"
        + "  constructor(readonly failures: readonly string[]) {\n"
        + "    super(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\\n${failures.join('\\n')}`)\n"
        + "    this.name = 'ClientActivationError'\n"
        + "  }\n"
        + "}\n",
    ],
    [
      "    throw new Error(`web boot: ${String(failures.length)} entr${failures.length === 1 ? 'y' : 'ies'} did not activate\\n${failures.join('\\n')}`)\n",
      "    throw new ClientActivationError(failures)\n",
    ],
  ], 'LUMO_CLIENT_ACTIVATION_ERROR')

  // Invalid plugin exports can reject loader.create() after its entry has been
  // inserted. Retain the entry for retry and settle the other creations before
  // auditing; a single rejection must not abort the rest of the roster.
  patchFile(root, 'packages/client/modules/src/client/entries.ts', [[
    `      await Promise.all(this.desired.plugins.map(async ({ id }) => {
        await this.create(loader, id)
      }))
      await loader.await()
`,
    `      // LUMO_INITIAL_ENTRY_ISOLATION: each rejected creation remains diagnosable and retryable.
      const failures: { id: string; message: string }[] = []
      await Promise.all(manifest.plugins.map(async ({ id }) => {
        try {
          await this.create(loader, id)
        } catch (error) {
          failures.push({ id, message: String(error) })
          console.warn('client-modules: initial plugin creation failed', id, error)
        }
      }))
      await loader.await()
      this.publish({ syncing: false, failures })
`,
  ]], 'LUMO_INITIAL_ENTRY_ISOLATION')

  // Only the typed activation audit is recoverable. Manifest/transport/kernel
  // failures still reach the boot failure page, as does an unavailable renderer.
  // Pending entries stay in the page controller so later service arrival or a
  // plugin retry can activate them without changing Host enablement.
  patchFile(root, 'packages/client/web/src/boot.ts', [
    [
      "import { bootClient } from './boot-client.ts'\n",
      "import { bootClient, ClientActivationError } from './boot-client.ts'\n",
    ],
    [
      "   * Load and activate every client entry, then hand the mount point to the\n"
        + "   * UI renderer. Plugin failures remain visible on the boot page.\n",
      "   * Activate available entries and mount the UI renderer. Individual plugin\n"
        + "   * failures are logged; bootstrap and renderer failures remain fatal.\n",
    ],
    [
    `      await bootClient({
        ctx,
        modules: this.modules,
        manifest: this.manifest,
        onEntryState: (name, state) => {
          if (onFailure === undefined || state !== 'failed') this.page.setState(name, state)
        },
      })
`,
    `      // LUMO_BEST_EFFORT_BOOT: use the authoritative audit, including fibers that never emit a status change.
      try {
        await bootClient({
          ctx,
          modules: this.modules,
          manifest: this.manifest,
          onEntryState: (name, state) => {
            if (state !== 'failed') this.page.setState(name, state)
          },
        })
      } catch (bootFailure) {
        if (!(bootFailure instanceof ClientActivationError)) throw bootFailure
        for (const failure of bootFailure.failures) {
          console.warn('dsh web: 插件未能激活，已跳过；工作台继续启动：', failure)
        }
      }
      if (ctx.get('uiRenderer') === undefined) {
        throw new Error('无法启动工作台：界面渲染服务未就绪。请重启应用或检查插件配置。')
      }
`,
    ],
  ], 'LUMO_BEST_EFFORT_BOOT')
}

/**
 * 一次性列出当前上游 HEAD 上失配的全部锚点。返回空数组即覆盖层与上游同步。
 *
 * 传一份上游的**干净副本**（临时目录即可，别传真正在用的暂存副本）：收集模式照常
 * 落盘，会就地改坏传进来的那棵树。
 * @param root - 上游 checkout 的干净拷贝。
 * @returns 每个失配锚点的文件、锚点文本与失配形态，顺序同补丁顺序。
 */
export function diagnoseOverlayAnchors(root) {
  missedAnchors.length = 0
  collecting = true
  try {
    applyLumoDshOverrides(resolve(root))
  } finally {
    collecting = false
  }
  return missedAnchors.slice()
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('usage: node platform/dsh-overrides/apply.mjs <staged-dsh-root>')
  applyLumoDshOverrides(resolve(root))
}

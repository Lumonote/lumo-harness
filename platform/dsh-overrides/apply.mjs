import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

function replaceExactlyOnce(source, before, after, file) {
  const first = source.indexOf(before)
  if (first === -1) throw new Error(`Lumo DSH overlay: ${file} does not contain the expected upstream anchor`)
  if (source.indexOf(before, first + before.length) !== -1) {
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

/**
 * The packages whose sources this overlay rewrites. They are the only packages
 * that must be rebuilt inside the snapshot; every other package can reuse the
 * build outputs the upstream worktree already produced. Staging reads this to
 * decide which build outputs to project, so keep it in step with the patches
 * applied below.
 */
export const overriddenPackageDirectories = [
  'packages/client/ui-conversation',
  'packages/client/ui-sidebar',
  'packages/client/ui-workspace',
  'packages/client/ui-model-selection',
  'packages/session/session-format-v0-to-v1',
  // LUMO_STREAM_RESILIENCE: 聊天「内容消失 / 对话卡住」链路修复涉及的三个包
  // （服务端 WS mux 背压、客户端载波退避、Session 事件流自动重开）。
  'packages/api/gateway',
  'packages/api/session-controller',
]

/**
 * Add the two homepage composer extension seats required by Lumo. This must
 * only be called for an isolated checkout/copy, never the upstream worktree.
 */
export function applyLumoDshOverrides(root) {
  // 上游 master 重构期（2026-09 · 76fda72979）根配置的花括号 entry 对 dsh-root 解析
  // 断裂（Cannot find entry: ["lib/types/{index,invariant,startup}.js"]），整个 host
  // tsdown 序失败——typert 的 lib/typert.remote-client.* 投影与 host 包 bundle 全部
  // 缺失。改为 index 单入口：invariant/startup 的附加入口由 synthesize-dsh-libs.mjs
  // 以再导出形状补齐，dsh-root 本就不进运行时。typert 投影由 build-runtime.mjs 的
  // rebuildDshHostArtifacts() 在快照上重产出。
  patchFile(root, 'tsdown.config.ts', [[
    "    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],\n",
    "    entry: client ? '' : ['lib/types/index.js'], // LUMO_DSH_TYSDOWN_ENTRY: 花括号 entry 在重构期对 dsh-root 解析断裂,见 apply.mjs 注释\n",
  ]], 'LUMO_DSH_TYSDOWN_ENTRY')

  patchFile(root, 'packages/client/ui-conversation/src/client/apply.ts', [[
    "      'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },\n",
    "      'conversation.hero.agentPreset': { kind: 'single', scope: 'root' },\n"
      + "      // LUMO_DSH_OVERLAY: root composer extension seats.\n"
      + "      'conversation.hero.input.left': { kind: 'list', scope: 'root' },\n"
      + "      'conversation.hero.composer.dock': { kind: 'list', scope: 'root' },\n",
  ]])

  patchFile(root, 'packages/client/ui-conversation/src/client/contract/slots.ts', [
    [
      "    'conversation.hero.agentPreset': { kind: 'single'; scope: 'root'; owner: HeroAgentPresetOwnerProps }\n",
      "    'conversation.hero.agentPreset': { kind: 'single'; scope: 'root'; owner: HeroAgentPresetOwnerProps }\n"
        + "    /** LUMO_DSH_OVERLAY: project/space control before a session exists. */\n"
        + "    'conversation.hero.input.left': { kind: 'list'; scope: 'root'; owner: HeroComposerOwnerProps }\n"
        + "    /** LUMO_DSH_OVERLAY: embedded design panel below the homepage input. */\n"
        + "    'conversation.hero.composer.dock': { kind: 'list'; scope: 'root'; owner: HeroComposerOwnerProps }\n",
    ],
    [
      // 锚在 InputZone 的声明行上，并插到它**之前**。块体里 `session` 的类型上游会来回改
      // （dsh-v0.1.1-rc.2 是 ConversationSnapshot，0.1.2-alpha.1 又改回 SessionSnapshot），
      // 把整块当锚点等于每次改名都得跟着校准一次。声明行本身稳定得多，而插入位置对
      // 顶层 interface 声明没有语义差别。
      // __tests__/overlay.spec.ts 对着 `git show HEAD:` 的原文跑，锚点漂移会当场红。
      "export interface InputZone {",
      "/** LUMO_DSH_OVERLAY: root-scoped currency for pre-session composer extensions. */\n"
        + "export interface HeroComposerOwnerProps {}\n\n"
        + "export interface InputZone {",
    ],
    [
      "    | 'conversation.hero.agentPreset'\n",
      "    | 'conversation.hero.agentPreset'\n"
        + "    | 'conversation.hero.input.left' // LUMO_DSH_OVERLAY\n"
        + "    | 'conversation.hero.composer.dock'\n",
    ],
  ])

  patchFile(root, 'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx', [
    // 上游把 composer 重构：`leftItems` 属性已移除，首页输入改为 `composer.bar` + `input.dock`。
    // 锚点移到 `heroWorkspaceRow`——它在 composerBar 里唯一且稳定；`hero` 守卫保证只在
    // 首页（无会话）渲染左侧项目/空间控制座位。
    [
      "      {hero && heroWorkspaceRow}\n",
      "      {hero && heroWorkspaceRow}\n"
        + "      {hero && renderSlot('conversation.hero.input.left', { input: inputState, inputActions })} {/* LUMO_DSH_OVERLAY: pre-session project scope control */}\n",
    ],
    [
      "      {inputBar}\n    </div>\n",
      "      {inputBar}\n"
        + "      {hero && renderSlot('conversation.hero.composer.dock', { input: inputState, inputActions })} {/* LUMO_DSH_OVERLAY */}\n"
        + "    </div>\n",
    ],
  ])

  // The Lumo workspace navigation belongs between New Session and the native
  // workspace/history browser. Add a dedicated seat in staged copies instead
  // of replacing ui-workspace or editing the upstream checkout.
  patchFile(root, 'packages/client/ui-sidebar/src/client/index.ts', [[
    "        'sidebar.brand.name': { kind: 'single', scope: 'root' },\n",
    "        'sidebar.brand.name': { kind: 'single', scope: 'root' },\n"
      + "        // LUMO_SIDEBAR_NAVIGATION: product navigation above session history.\n"
      + "        'sidebar.navigation': { kind: 'list', scope: 'root' },\n",
  ]], 'LUMO_SIDEBAR_NAVIGATION')

  patchFile(root, 'packages/client/ui-sidebar/src/client/contract/slots.ts', [
    [
      "    'sidebar.brand.name': { kind: 'single'; scope: 'root'; owner: SidebarBrandNameOwnerProps }\n",
      "    'sidebar.brand.name': { kind: 'single'; scope: 'root'; owner: SidebarBrandNameOwnerProps }\n"
        + "    /** LUMO_SIDEBAR_NAVIGATION: product navigation above native history. */\n"
        + "    'sidebar.navigation': { kind: 'list'; scope: 'root'; owner: SidebarNavigationOwnerProps }\n",
    ],
    [
      "/** Owner share of an action rendered beside Settings at the sidebar foot. */\nexport interface SidebarFooterActionOwnerProps {\n",
      "/** LUMO_SIDEBAR_NAVIGATION: geometry supplied to product navigation. */\n"
        + "export interface SidebarNavigationOwnerProps {\n"
        + "  /** Whether the sidebar renders wide content (false = 56px rail). */\n"
        + "  wide: boolean\n"
        + "}\n\n"
        + "/** Owner share of an action rendered beside Settings at the sidebar foot. */\nexport interface SidebarFooterActionOwnerProps {\n",
    ],
    [
      "    | 'sidebar.brand.name'\n",
      "    | 'sidebar.brand.name'\n"
        + "    | 'sidebar.navigation' // LUMO_SIDEBAR_NAVIGATION\n",
    ],
  ], 'LUMO_SIDEBAR_NAVIGATION')

  patchFile(root, 'packages/client/ui-sidebar/src/client/SidebarRoot.tsx', [
    [
      "      {/* The browsing region fills the column between the controls and the\n",
      "      {renderSlot('sidebar.navigation', { wide })} {/* LUMO_SIDEBAR_NAVIGATION */}\n\n"
        + "      {/* The browsing region fills the column between the controls and the\n",
    ],
  ], 'LUMO_SIDEBAR_NAVIGATION')

  patchFile(root, 'packages/client/ui-workspace/src/client/rows/WorkspaceBrowser.tsx', [[
    '      <div className={css.sectionHeader}>\n',
    `      {wide && (
        <div data-lumo-history-toggle className={css.sectionHeader}>
          <button type="button" className={css.iconButton} style={{ width: 'auto', padding: '0 8px' }}
            aria-pressed={groupBy === 'flat'} onClick={() => { actions.setGroupBy('flat'); setQuery('') }}>
            {t('groupBy.flat')}
          </button>
          <button type="button" className={css.iconButton} style={{ width: 'auto', padding: '0 8px' }}
            aria-pressed={groupBy === 'workspace'} onClick={() => { actions.setGroupBy('workspace'); setQuery('') }}>
            {t('groupBy.workspace')}
          </button>
        </div>
      )}
      <div className={css.sectionHeader}>
`,
  ]], 'data-lumo-history-toggle')

  patchFile(root, 'packages/client/ui-workspace/src/client/locales.ts', [
    ["  'groupBy.flat': '单列表',", "  'groupBy.flat': '全部对话',"],
    ["  'groupBy.flat': 'In one list',", "  'groupBy.flat': 'All conversations',"],
  ], "'All conversations'")

  // A sequential next turn proves the preceding turn was abandoned, including
  // a step whose closing event was not flushed. Keep all messages and sequence
  // references; pending tools still require recorded results before migration.
  patchFile(root, 'packages/session/session-format-v0-to-v1/src/relationships.ts', [[
    "      case 'turn/start':\n"
      + "        if (openTurn !== null || data['turn'] !== nextTurn) {\n"
      + "          throw new SessionFormatError(`turn/start ${JSON.stringify(data['turn'])} does not open expected turn ${nextTurn}`)\n"
      + "        }\n",
    "      case 'turn/start':\n"
      + "        if (openTurn !== null && data['turn'] === openTurn + 1) {\n"
      + "          // LUMO_SESSION_RECOVERY: the sequential next turn abandons an interrupted prior step/turn.\n"
      + "          assertNoUnresolvedTools(toolLifecycles, 'turn/start recovery')\n"
      + "          openTurn = null\n"
      + "          openStep = null\n"
      + "          nextTurn += 1\n"
      + "        }\n"
      + "        if (openTurn !== null || data['turn'] !== nextTurn) {\n"
      + "          throw new SessionFormatError(`turn/start ${JSON.stringify(data['turn'])} does not open expected turn ${nextTurn}`)\n"
      + "        }\n",
  ]], 'LUMO_SESSION_RECOVERY')

  patchFile(root, 'packages/client/ui-model-selection/src/client/directory.ts', [
    [
      "    if (catalog.status !== 'ready' || catalog.value === null || projected === undefined) {\n",
      "    // LUMO_MODEL_CATALOG: advisory models do not wait for history restoration.\n"
        + "    if (catalog.status !== 'ready' || catalog.value === null) {\n",
    ],
    [
      "    const current = projected.next ?? catalog.value.default\n",
      "    // A missing projection is unknown, not an empty durable selection.\n"
        + "    const current = projected === undefined\n"
        + "      ? this.store.getSnapshot().current\n"
        + "      : projected.next ?? catalog.value.default\n",
    ],
    [
      "      routable: catalog.value.routableProviders.includes(current.provider),\n",
      "      routable: current === null ? null : catalog.value.routableProviders.includes(current.provider),\n",
    ],
  ], 'LUMO_MODEL_CATALOG')

  // Root hero extensions need the same public draft/submit face as a live
  // session dock so Lumo can hand an OpenDesign/PPT brief to the native
  // conversation. The owner values remain optional for the cold no-session
  // state, where the native composer is intentionally inert.
  patchFile(root, 'packages/client/ui-conversation/src/client/contract/slots.ts', [[
      "export interface HeroComposerOwnerProps {}\n",
    "/** LUMO_HERO_INPUT_BRIDGE: optional native input currency for blank sessions. */\n"
      + "export interface HeroComposerOwnerProps {\n"
      // `ConversationRoot` always forwards the hook values, which may be
      // undefined during the no-session state. Keep the optional fields
      // explicitly undefined-able under exactOptionalPropertyTypes.
      + "  readonly input?: InputState | undefined\n"
      + "  readonly inputActions?: InputActions | undefined\n"
      + "}\n",
  ]], 'LUMO_HERO_INPUT_BRIDGE')

  // `inputState`/`inputActions` 已在组件的标准属性里；只把 `inputActions` 补进解构，
  // 让上面的 hero 座位能拿到原生输入面。载荷升级已并入第一段补丁，这里不再重复。
  patchFile(root, 'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx', [[
    "  renderSlot, renderSlotChain, selectWorkspace, t,\n",
    "  renderSlot, renderSlotChain, selectWorkspace, inputActions, t, // LUMO_HERO_INPUT_BRIDGE\n",
  ]], 'LUMO_HERO_INPUT_BRIDGE')

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
    [
      "    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {\n"
        + "      if (this.socket.readyState !== WebSocket.OPEN) {\n"
        + "        reject(new Error('api gateway: Remote stream socket is closed'))\n"
        + "        return\n"
        + "      }\n"
        + "      this.socket.send(text, (error) => {\n"
        + "        if (error) reject(error)\n"
        + "        else resolve()\n"
        + "      })\n"
        + "    }))\n",
      "    const delivery = this.writes.then(() => new Promise<void>((resolve, reject) => {\n"
        + "      if (this.socket.readyState !== WebSocket.OPEN) {\n"
        + "        reject(new Error('api gateway: Remote stream socket is closed'))\n"
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
        + "      }\n"
        + "      let settled = false\n"
        + "      const timer = setTimeout(() => {\n"
        + "        settled = true\n"
        + "        this.socket.terminate()\n"
        + "        reject(new Error('api gateway: Remote stream send did not flush before the deadline'))\n"
        + "      }, LUMO_SEND_FLUSH_TIMEOUT_MS)\n"
        + "      this.socket.send(text, (error) => {\n"
        + "        if (settled) return\n"
        + "        settled = true\n"
        + "        clearTimeout(timer)\n"
        + "        if (error) reject(error)\n"
        + "        else resolve()\n"
        + "      })\n"
        + "    }))\n",
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
      "      this.retireFailedSubmission(requestId)\n"
        + "    }\n"
        + "    this.openGeneration++\n"
        + "    const events = this.events\n",
      "      this.retireFailedSubmission(requestId)\n"
        + "    }\n"
        + "    if (this.reopenTimer !== undefined) {\n"
        + "      clearTimeout(this.reopenTimer) // LUMO_STREAM_RESILIENCE: a pruned session must not resurrect itself.\n"
        + "      this.reopenTimer = undefined\n"
        + "    }\n"
        + "    this.openGeneration++\n"
        + "    const events = this.events\n",
    ],
    [
      "      await events.open({ maxMessages: PAGE_MESSAGES })\n"
        + "      if (generation !== this.openGeneration || this.events !== events) return\n"
        + "      this.openState = 'open'\n",
      "      await events.open({ maxMessages: PAGE_MESSAGES })\n"
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
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('usage: node platform/dsh-overrides/apply.mjs <staged-dsh-root>')
  applyLumoDshOverrides(resolve(root))
}

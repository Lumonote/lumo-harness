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
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('usage: node platform/dsh-overrides/apply.mjs <staged-dsh-root>')
  applyLumoDshOverrides(resolve(root))
}

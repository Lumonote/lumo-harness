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
    [
      "    leftItems: zone === undefined ? null : renderSlot('conversation.input.left', zone),\n",
      "    // LUMO_DSH_OVERLAY: expose the same scope control on the homepage composer.\n"
        + "    leftItems: zone === undefined\n"
        + "      ? renderSlot('conversation.hero.input.left', {})\n"
        + "      : renderSlot('conversation.input.left', zone),\n",
    ],
    [
      "      {inputBar}\n    </div>\n",
      "      {inputBar}\n"
        + "      {hero && renderSlot('conversation.hero.composer.dock', {})} {/* LUMO_DSH_OVERLAY */}\n"
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

  patchFile(root, 'packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx', [
    [
      "  renderSlot, renderSlotChain, selectWorkspace, t,\n",
      "  renderSlot, renderSlotChain, selectWorkspace, inputActions, t, // LUMO_HERO_INPUT_BRIDGE\n",
    ],
    [
      "      ? renderSlot('conversation.hero.input.left', {})\n",
      "      ? renderSlot('conversation.hero.input.left', { input: inputState, inputActions })\n",
    ],
    [
      "      {hero && renderSlot('conversation.hero.composer.dock', {})}",
      "      {hero && renderSlot('conversation.hero.composer.dock', { input: inputState, inputActions })}",
    ],
  ], 'LUMO_HERO_INPUT_BRIDGE')
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('usage: node platform/dsh-overrides/apply.mjs <staged-dsh-root>')
  applyLumoDshOverrides(resolve(root))
}

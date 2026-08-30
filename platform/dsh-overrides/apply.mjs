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

function patchFile(root, relativePath, replacements) {
  const file = resolve(root, relativePath)
  let source = readFileSync(file, 'utf8')
  if (source.includes('LUMO_DSH_OVERLAY')) return
  for (const [before, after] of replacements) source = replaceExactlyOnce(source, before, after, relativePath)
  writeFileSync(file, source)
}

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
      "export interface InputZone {\n  readonly session: SessionState\n  readonly input: InputState\n}\n",
      "export interface InputZone {\n  readonly session: SessionState\n  readonly input: InputState\n}\n\n"
        + "/** LUMO_DSH_OVERLAY: root-scoped currency for pre-session composer extensions. */\n"
        + "export interface HeroComposerOwnerProps {}\n",
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
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = process.argv[2]
  if (root === undefined) throw new Error('usage: node platform/dsh-overrides/apply.mjs <staged-dsh-root>')
  applyLumoDshOverrides(resolve(root))
}

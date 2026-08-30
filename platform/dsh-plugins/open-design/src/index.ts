/**
 * @lumo/open-design —— OpenDesign 的 artifact-first 设计工作流。
 *
 * OpenDesign 本身是一个独立的本地优先设计工作台；这里注册的是它的
 * 可移植 Agent Skill 入口，而不是把 OpenDesign 的桌面应用或专用 dsh
 * --stdio profile 塞进 Lumo 的普通 web/headless profile。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'lumo-open-design'
export const inject = ['skills']

export const upstream = {
  repository: 'https://github.com/nexu-io/open-design',
  license: 'Apache-2.0',
} as const

const OPEN_DESIGN_SKILL = String.raw`# OpenDesign

Use this skill when the user asks for a web, desktop, or mobile prototype; a landing page; a live dashboard; a slide deck; a polished image or document; a motion/video artifact; a design-system application; or a visual refresh of an existing codebase.

OpenDesign is artifact-first: the deliverable is a real file in the user's workspace, not a prose-only description. Keep the conversation, source files, preview, and next refinement step connected.

## Workflow

1. Classify the requested artifact before writing code: prototype, dashboard/live artifact, deck, mobile screen, image, document, or video/HyperFrame.
2. Inspect the current workspace for DESIGN.md, existing tokens, components, assets, and export constraints. Treat the active DESIGN.md as the visual contract when one is present.
3. Lock a short direction: audience, purpose, content hierarchy, visual posture, interaction level, and output path. Preserve exact product names and user-provided copy.
4. Create the canonical artifact in the requested workspace. Prefer real HTML/CSS/components and local assets. Keep the first pass complete enough to preview and critique.
5. Preview the actual file at the target viewport. Check hierarchy, typography, contrast, responsive containment, interaction states, and whether the primary action is obvious.
6. Refine in focused passes. Change one visual or interaction concern at a time and keep unrelated structure stable.
7. Verify the final artifact and report its exact path, format, and any exports that were actually produced. Never claim a PDF, PPTX, MP4, screenshot, or visual review that was not generated or checked.

## Lumo theme contract

Every interactive artifact must support the four Lumo product themes: 'obsidian-signal', 'ember-foundry', 'orbital-glass', and 'infrared-grid'. Default to 'obsidian-signal', expose the active theme on the artifact root as data-lumo-theme, and keep surfaces, borders, focus rings, status colors, charts, and empty/loading/error states on semantic CSS variables. Do not bake a green or purple accent into components. When the artifact is embedded in Lumo, inherit the host --dsw-* tokens; when it is delivered as standalone HTML, provide the same four token maps locally and preserve the selected theme in the handoff metadata.

## OpenDesign CLI boundary

If the user has OpenDesign installed, use its od CLI for project-aware workflows and exports. Resolve the installed executable explicitly when macOS /usr/bin/od shadows OpenDesign's command. If the CLI or a requested exporter is unavailable, continue with the best file-native workflow and state the limitation; do not silently install software or send workspace data to a remote service.

The upstream OpenDesign application may provide additional skills, design systems, templates, and agent runtimes. This base skill supplies the portable design workflow only. Load extra resources only when the user requests them or they are already provisioned in the workspace.

## Safety and handoff

- Write only inside the user-authorized workspace and preserve existing source files unless a change is requested.
- Do not invent brand rules, source evidence, data, or export results.
- For an existing app, identify the files changed and keep the result runnable with the project's existing toolchain.
- End with the artifact path, what was verified, and the next concrete refinement option.`

export function apply(ctx: Context): void {
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('open-design: ctx.skills is unavailable')

  const unregister = skills.register({
    name: 'open-design',
    description: '以产物优先的方式创建、完善、预览并导出真实设计产物。',
    whenToUse: '适用于原型、落地页、看板、演示文稿、图片、文档、视频动效和现有代码的视觉升级。',
    source: 'bundled',
    provider: 'lumo-open-design',
    resourceBase: { kind: 'opaque', description: '已配置的开放设计工作流，以及用户授权的本地设计资源。' },
    content: OPEN_DESIGN_SKILL,
    invocation: { modelInvocable: true, userInvocable: true },
  })
  ctx.effect(() => () => { unregister() })
}

export default apply

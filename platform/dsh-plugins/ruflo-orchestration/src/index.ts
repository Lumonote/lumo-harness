/** Ruflo is an execution helper inside a Lumo TaskRun, never the business source of truth. */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'lumo-ruflo-orchestration'
export const inject = ['skills']
export const upstream = {
  repository: 'https://github.com/ruvnet/ruflo',
  commit: 'd33ef4bf8ab27a8f9ef08352c9c293b53312a861',
  package: 'ruflo@3.38.20',
  license: 'MIT',
} as const

function rufloBin(): string {
  const configured = process.env['LUMO_RUFLO_BIN']?.trim()
  if (configured) return configured
  const require = createRequire(import.meta.url)
  return join(dirname(require.resolve('ruflo/package.json')), 'bin', 'ruflo.js')
}

export function apply(ctx: Context): void {
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('ruflo-orchestration: ctx.skills is unavailable')
  const binary = rufloBin()
  // 普通模板字面量,不是 String.raw:正文里的 \` 必须还原成真反引号。
  // String.raw 会把反斜杠原样留在技能正文里,模型读到的就是 \`ruflo init\`。
  const content = `# Ruflo 多智能体编排

Use Ruflo only inside an already-authorized Lumo task run. Lumo owns task identity, assignment, permissions, scheduler placement, cancellation, audit, report and review. Ruflo owns the bounded sub-agent topology inside that run.

## Runtime

The pinned CLI entry is ${JSON.stringify(binary)}. Invoke it with the current Node executable. Do not run \`ruflo init\`, \`doctor --fix\`, a global install, or any command that rewrites AGENTS.md, CLAUDE.md, MCP settings or hooks. Do not start a daemon unless the user explicitly requests a persistent swarm.

## Bounded workflow

1. Read the active Lumo task id, run id, project and space. Refuse to orchestrate without that boundary.
2. Choose hierarchical for manager/worker delegation, mesh for peer review, or ring for staged handoff. Default to hierarchical and at most 8 agents.
3. Keep Ruflo state under \`.lumo/ruflo/<task-id>/<run-id>/\` in the active project. Never use a home-directory global state store.
4. Start or inspect the swarm through the pinned CLI. Every child assignment must map back to the Lumo task/run and must obey cancellation.
5. Export the live topology as Archify workflow or lifecycle JSON using exact task, run, worker and node identifiers. The Lumo operations surface is the control plane; an Archify artifact is a view, not business state.
6. On completion, write one outcome and report reference back to Lumo. Do not mark success when any required agent is failed, blocked or unreported.

Useful bounded command shape:

    "${process.execPath}" "${binary}" swarm init --topology hierarchical --max-agents 8

Never claim a swarm was started unless the command completed successfully.`
  const unregister = skills.register({
    name: 'ruflo-orchestration',
    description: '在 Lumo 任务运行边界内组织 Ruflo 多智能体拓扑、分工和回收。',
    whenToUse: '适用于需要多个专业智能体并行、复核、分阶段交付或失败重派的复杂任务。',
    source: 'bundled', provider: 'lumo-ruflo',
    resourceBase: { kind: 'opaque', description: `固定版本 Ruflo CLI：${binary}` },
    content, invocation: { modelInvocable: true, userInvocable: true },
  })
  ctx.effect(() => () => { unregister() })
}

export default apply

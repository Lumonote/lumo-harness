/**
 * @lumo/archify —— pinned Archify runtime plus Lumo task-topology contract.
 */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'lumo-archify'
export const inject = ['skills']

export const upstream = {
  repository: 'https://github.com/tt-a1i/archify',
  commit: 'b36d79fdbc3aec3728744341485a7e79f03c0071',
  license: 'MIT',
} as const

export interface Config { root?: string }

const repositorySkillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'upstream', 'skills', 'archify')

function archifyRoot(config: Config = {}): string {
  const bundled = process.env['LUMO_BUNDLED_SKILLS_ROOT']?.trim()
  return realpathSync(config.root?.trim() || (bundled ? resolve(bundled, 'archify') : repositorySkillRoot))
}

function loadArchify(config: Config): { directory: string; path: string; content: string } {
  const directory = archifyRoot(config)
  if (!lstatSync(directory).isDirectory()) throw new Error('archify: configured root is not a directory')
  const path = join(directory, 'SKILL.md')
  if (!lstatSync(path).isFile()) throw new Error('archify: SKILL.md is missing')
  const markdown = readFileSync(path, 'utf8')
  if (!markdown.startsWith('---\n')) throw new Error('archify: SKILL.md lacks frontmatter')
  const closing = markdown.indexOf('\n---\n', 4)
  if (closing === -1) throw new Error('archify: SKILL.md has unterminated frontmatter')
  return { directory, path, content: markdown.slice(closing + '\n---\n'.length).replace(/^\n/, '') }
}

const LUMO_EXTENSION = String.raw`

## Lumo task topology extension

For multi-agent scheduling views, use Archify workflow for assignment topology and lifecycle for Task/Run state. Use exact Lumo task IDs, run IDs, worker IDs and assigned node IDs; never invent an agent, edge or runtime status. Ruflo may coordinate child agents inside one run, but Lumo remains the source of truth for assignment, cancellation, audit, report and review. An exported Archify JSON/HTML file is a read model only.

Delivered HTML diagrams must support 'obsidian-signal', 'ember-foundry', 'orbital-glass', and 'infrared-grid', with 'obsidian-signal' as the default. Put the active choice on the document root as data-lumo-theme and use semantic CSS variables so an artifact can move between the Lumo shell and a standalone preview without losing its theme.`

export function apply(ctx: Context, config: Config = {}): void {
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('archify: ctx.skills is unavailable')
  const installed = loadArchify(config)
  const unregister = skills.register({
    name: 'archify',
    description: '创建经过验证的架构图、流程图、时序图、数据流图、生命周期图和多智能体调度拓扑。',
    whenToUse: '适用于系统地图、技术流程、API 时序、数据血缘、任务运行状态、智能体分工和 Mermaid 转换。',
    source: 'bundled', provider: 'lumo-archify',
    resourceBase: { kind: 'directory', path: installed.directory }, path: installed.path,
    content: `${installed.content}${LUMO_EXTENSION}`,
    invocation: { modelInvocable: true, userInvocable: true },
  })
  ctx.effect(() => () => { unregister() })
}

export default apply

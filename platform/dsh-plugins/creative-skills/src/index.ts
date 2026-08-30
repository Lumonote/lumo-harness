/** Register pinned, repository-backed creative skills without modifying DSH. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'

export const name = 'lumo-creative-skills'
export const inject = ['skills']

export const upstream = {
  image: {
    repository: 'https://github.com/freestylefly/awesome-gpt-image-2',
    commit: 'c7d293963b21c60bf338003915438cc5c39dd3ca',
    license: 'MIT',
  },
  presentation: {
    repository: 'https://github.com/hugohe3/ppt-master',
    commit: 'bf81f3ece547e769095a6c0b82f40d33be3d2cf7',
    license: 'MIT',
  },
} as const

export interface Config { root?: string }

interface BundledSkill {
  directory: string
  path: string
  content: string
}

const repositorySkillRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'upstream', 'skills')

export function resolveBundledSkillsRoot(config: Config = {}): string {
  const configured = config.root?.trim() || process.env['LUMO_BUNDLED_SKILLS_ROOT']?.trim()
  return realpathSync(configured || repositorySkillRoot)
}

function stripFrontmatter(markdown: string, expectedName: string): string {
  if (!markdown.startsWith('---\n')) throw new Error(`creative-skills: ${expectedName}/SKILL.md lacks frontmatter`)
  const closing = markdown.indexOf('\n---\n', 4)
  if (closing === -1) throw new Error(`creative-skills: ${expectedName}/SKILL.md has unterminated frontmatter`)
  const header = markdown.slice(4, closing)
  const name = header.match(/^name:\s*([^\n]+)\s*$/m)?.[1]?.trim().replace(/^['"]|['"]$/g, '')
  if (name !== expectedName) throw new Error(`creative-skills: expected ${expectedName}, got ${String(name)}`)
  return markdown.slice(closing + '\n---\n'.length).replace(/^\n/, '')
}

function loadSkill(root: string, expectedName: string): BundledSkill {
  const directory = realpathSync(resolve(root, expectedName))
  if (relative(root, directory).startsWith('..')) throw new Error(`creative-skills: ${expectedName} escapes root`)
  if (!lstatSync(directory).isDirectory()) throw new Error(`creative-skills: ${expectedName} is not a directory`)
  const path = join(directory, 'SKILL.md')
  if (!lstatSync(path).isFile()) throw new Error(`creative-skills: ${expectedName}/SKILL.md is not a file`)
  return { directory, path, content: stripFrontmatter(readFileSync(path, 'utf8'), expectedName) }
}

const LUMO_PPT_EXTENSION = String.raw`

## Lumo runtime boundary

Keep every source, generated SVG, preview, and exported PPTX inside the active Lumo project/space. Use the interpreter named by LUMO_PPT_PYTHON when it is set; otherwise use python3. Never install Python packages during a task. The desktop or deployment provisioner owns the isolated environment. Preserve PPT Master's blocking review gates and report only files that were actually generated.`

export function apply(ctx: Context, config: Config = {}): void {
  const skills = ctx.get('skills')
  if (skills === undefined) throw new Error('creative-skills: ctx.skills is unavailable')
  const root = resolveBundledSkillsRoot(config)
  const image = loadSkill(root, 'gpt-image-2-style-library')
  const presentation = loadSkill(root, 'ppt-master')
  const unregister = [
    skills.register({
      name: 'gpt-image-2-style-library',
      description: '从固定版本的 GPT Image 2 风格库选择模板、风格标签和工业级提示词结构。',
      whenToUse: '适用于海报、UI、信息图、品牌视觉、商品图、插画和系列图片提示词。',
      source: 'bundled', provider: 'lumo-creative-skills',
      resourceBase: { kind: 'directory', path: image.directory }, path: image.path, content: image.content,
      invocation: { modelInvocable: true, userInvocable: true },
    }),
    skills.register({
      name: 'ppt-master',
      description: '从主题、文档或现有模板生成、编辑和增强原生可编辑 PPTX。',
      whenToUse: '适用于演示文稿生成、模板填充、PPT 美化、动画、旁白和原生 PPTX 编辑。',
      source: 'bundled', provider: 'lumo-creative-skills',
      resourceBase: { kind: 'directory', path: presentation.directory }, path: presentation.path,
      content: `${presentation.content}${LUMO_PPT_EXTENSION}`,
      invocation: { modelInvocable: true, userInvocable: true },
    }),
  ]
  ctx.effect(() => () => { for (const dispose of unregister) dispose() })
}

export default apply

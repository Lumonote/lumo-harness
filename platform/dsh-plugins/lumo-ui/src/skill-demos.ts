/**
 * 已装配技能的原生示例发现。
 *
 * 创作工作台不再用 CSS 画假预览，而是直接展示技能目录里真实存在的示例文件：
 * - PPT Master 的品牌模板（`templates/decks/<名称>/templates/01_cover.svg`）
 * - Archify 之类技能自带的 `examples/*.html`
 * - 风格库之类技能自带的 `assets/*.png|jpg|webp|svg`
 *
 * 只读取 `resourceBase.kind === 'directory'` 的技能；技能正文与目录路径仍留在宿主侧，
 * 浏览器只拿到相对路径与可访问的同源 URL。资源出口做 realpath 包含性校验，
 * 防止通过 `..` 或符号链接读到技能目录之外的文件。
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'

export type SkillDemoKind = 'image' | 'html'

export interface SkillDemo {
  /** `<技能名>:<来源>:<标识>`，在一次快照内唯一。 */
  id: string
  skill: string
  title: string
  summary: string
  kind: SkillDemoKind
  /** 相对技能目录的 POSIX 路径，交回 `resolveSkillDemoAsset` 才能变成文件。 */
  path: string
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.svg', '.gif'])
const MAX_DEMOS_PER_SKILL = 24

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.html': 'text/html; charset=utf-8',
}

function posix(path: string): string {
  return path.split(sep).join('/')
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile() } catch { return false }
}

function listFiles(directory: string, accept: (extension: string) => boolean): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter(entry => entry.isFile() && accept(extname(entry.name).toLowerCase()))
      .map(entry => entry.name)
      .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  } catch {
    return []
  }
}

function titleFromFile(name: string): string {
  return name.replace(/\.[^.]+$/u, '').replace(/[-_]+/gu, ' ').trim()
}

function deckDemos(skill: string, directory: string): SkillDemo[] {
  const indexPath = join(directory, 'templates', 'decks', 'decks_index.json')
  if (!isFile(indexPath)) return []
  let index: unknown
  try { index = JSON.parse(readFileSync(indexPath, 'utf8')) } catch { return [] }
  if (index === null || typeof index !== 'object' || Array.isArray(index)) return []
  const demos: SkillDemo[] = []
  for (const [name, meta] of Object.entries(index as Record<string, unknown>)) {
    if (name.includes('/') || name.includes('\\') || name.startsWith('.')) continue
    const cover = join('templates', 'decks', name, 'templates', '01_cover.svg')
    if (!isFile(join(directory, cover))) continue
    const summary = meta !== null && typeof meta === 'object' && typeof (meta as { summary?: unknown }).summary === 'string'
      ? (meta as { summary: string }).summary
      : ''
    demos.push({ id: `${skill}:deck:${name}`, skill, title: name, summary, kind: 'image', path: posix(cover) })
  }
  return demos
}

function exampleDemos(skill: string, directory: string): SkillDemo[] {
  return listFiles(join(directory, 'examples'), extension => extension === '.html').map(name => ({
    id: `${skill}:example:${name}`, skill, title: titleFromFile(name), summary: '技能自带的 HTML 示例', kind: 'html' as const, path: `examples/${name}`,
  }))
}

function assetDemos(skill: string, directory: string): SkillDemo[] {
  return listFiles(join(directory, 'assets'), extension => IMAGE_EXTENSIONS.has(extension)).map(name => ({
    id: `${skill}:asset:${name}`, skill, title: titleFromFile(name), summary: '技能自带的示例图片', kind: 'image' as const, path: `assets/${name}`,
  }))
}

/**
 * 枚举一个技能目录里可展示的原生示例。目录不存在或不可读时返回空数组而不是抛错：
 * 示例是锦上添花，缺失不应让技能快照接口失败。
 * @param skill - 技能名。
 * @param directory - 技能 `resourceBase.path`。
 * @returns 按来源（品牌模板 → HTML 示例 → 图片）排序的示例列表。
 */
export function discoverSkillDemos(skill: string, directory: string): SkillDemo[] {
  if (!existsSync(directory)) return []
  return [...deckDemos(skill, directory), ...exampleDemos(skill, directory), ...assetDemos(skill, directory)].slice(0, MAX_DEMOS_PER_SKILL)
}

export interface ResolvedDemoAsset {
  file: string
  contentType: string
}

/**
 * 把浏览器交回的相对路径解析成技能目录内的真实文件。
 * @param directory - 技能 `resourceBase.path`。
 * @param relativePath - `SkillDemo.path`。
 * @returns 文件路径与 Content-Type；越界、非白名单扩展名或文件不存在时返回 undefined。
 */
export function resolveSkillDemoAsset(directory: string, relativePath: string): ResolvedDemoAsset | undefined {
  if (relativePath === '' || relativePath.includes('\0') || relativePath.startsWith('/')) return undefined
  const contentType = CONTENT_TYPES[extname(relativePath).toLowerCase()]
  if (contentType === undefined) return undefined
  let root: string
  let file: string
  try {
    root = realpathSync(directory)
    file = realpathSync(resolve(root, relativePath))
  } catch {
    return undefined
  }
  const inside = relative(root, file)
  if (inside === '' || inside.startsWith('..') || resolve(root, inside) !== file) return undefined
  if (!isFile(file)) return undefined
  return { file, contentType }
}

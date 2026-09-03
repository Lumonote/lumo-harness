/**
 * 上游技能的原生样例画廊。
 *
 * 开放设计与 PPT 生成两个工作台展示的不再是 Lumo 自己拼的卡片，而是技能项目自己
 * 公开的完整样例：
 * - PPT Master：https://hugohe3.github.io/ppt-master-examples/ 的 `examples/examples.json`，
 *   每个项目带全部页面的 SVG（图片已内嵌 base64，自包含）、缩略图与 PPTX 下载。
 * - OpenDesign：仓库 `docs/i18n/README.zh-CN.md` 的「## 演示」章节，按原型 / 仪表盘 /
 *   演示文稿 / 图片 / 视频五类给出截图与说明。
 *
 * 浏览器不直接访问这些外域：桌面壳的 CSP 只放行 127.0.0.1，dsh Web 也不该为第三方
 * 域名开洞。宿主侧在这里拉取、解析、缓存，再通过同源代理把资源交给页面；代理只放行
 * 白名单域名，SVG/HTML 一律带 sandbox CSP 输出。上游不可达时返回 `available: false`，
 * 页面回退到技能目录里的本地模板（见 skill-demos.ts）。
 */

export type GallerySkill = 'ppt-master' | 'open-design'

export interface GalleryPage {
  title: string
  description: string
  /** 同源代理地址。 */
  url: string
}

export interface GalleryDownload {
  label: string
  /** 上游原始地址，交给系统浏览器打开。 */
  url: string
}

export interface GalleryCollection {
  id: string
  title: string
  description: string
  /** 分类：PPT Master 用风格名，OpenDesign 用 README 小节标题。 */
  category: string
  tags: string[]
  /** 同源代理地址；可能与首页相同。 */
  cover: string
  pages: GalleryPage[]
  downloads: GalleryDownload[]
}

export interface Gallery {
  skill: GallerySkill
  title: string
  /** 上游画廊的人类可读入口。 */
  source: string
  fetchedAt: string
  collections: GalleryCollection[]
}

export type GalleryResult = { available: true; gallery: Gallery } | { available: false; skill: GallerySkill; error: string }

export interface ProxiedAsset {
  body: Uint8Array
  contentType: string
}

export const PPT_MASTER_EXAMPLES_BASE = 'https://hugohe3.github.io/ppt-master-examples/'
export const OPEN_DESIGN_README_URL = 'https://raw.githubusercontent.com/nexu-io/open-design/main/docs/i18n/README.zh-CN.md'
export const OPEN_DESIGN_GALLERY_PAGE = 'https://github.com/nexu-io/open-design/blob/main/docs/i18n/README.zh-CN.md#演示'

/** 允许代理的域名。README 里出现的图片全部落在这几个域下；新增来源时在此登记。 */
export const ALLOWED_ASSET_HOSTS: ReadonlySet<string> = new Set([
  'hugohe3.github.io',
  'raw.githubusercontent.com',
  'repo-assets.open-design.ai',
  'cms-assets.youmind.com',
  'static.heygen.ai',
])

const ASSET_PROXY_PATH = '/lumo/api/skills/demos/upstream/asset'
const GALLERY_TTL_MS = 10 * 60 * 1000
const ASSET_TTL_MS = 60 * 60 * 1000
const ASSET_CACHE_BYTES = 64 * 1024 * 1024
const ASSET_MAX_BYTES = 12 * 1024 * 1024
const FETCH_TIMEOUT_MS = 15_000

const ASSET_CONTENT_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/svg+xml', 'image/avif'])

/**
 * 把上游绝对地址变成同源代理地址。
 * @param upstream - 白名单域名下的绝对 URL。
 * @returns 浏览器可直接放进 `<img src>` 的同源地址。
 */
export function proxiedAssetUrl(upstream: string): string {
  return `${ASSET_PROXY_PATH}?url=${encodeURIComponent(upstream)}`
}

/**
 * 判断一个上游地址是否允许被代理。
 * @param raw - 浏览器交回的 `url` 查询参数。
 * @returns 解析后的 URL；协议非 https 或域名不在白名单时返回 undefined。
 */
export function allowedAssetUrl(raw: string): URL | undefined {
  let url: URL
  try { url = new URL(raw) } catch { return undefined }
  if (url.protocol !== 'https:' || !ALLOWED_ASSET_HOSTS.has(url.hostname) || url.username !== '' || url.password !== '') return undefined
  return url
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean) : []
}

/**
 * 解析 PPT Master 示例站的 `examples.json`。
 * @param manifest - 已 JSON.parse 的清单。
 * @param base - 示例站根地址。
 * @returns 每个示例项目一个 collection，页面即全部幻灯片。
 */
export function parsePptMasterExamples(manifest: unknown, base: string = PPT_MASTER_EXAMPLES_BASE): GalleryCollection[] {
  const projects = manifest !== null && typeof manifest === 'object' && Array.isArray((manifest as { projects?: unknown }).projects)
    ? (manifest as { projects: unknown[] }).projects
    : []
  const collections: GalleryCollection[] = []
  for (const raw of projects) {
    if (raw === null || typeof raw !== 'object') continue
    const project = raw as Record<string, unknown>
    const id = text(project['id'])
    if (id === '' || id.includes('/') || id.includes('..')) continue
    const folder = text(project['folder']) || `${id}/svg_final`
    if (folder.includes('..')) continue
    const slides = Array.isArray(project['slides']) ? project['slides'] : []
    const pages: GalleryPage[] = []
    for (const slide of slides) {
      if (slide === null || typeof slide !== 'object') continue
      const file = text((slide as { file?: unknown }).file)
      if (file === '' || file.includes('/') || file.includes('..')) continue
      pages.push({
        title: text((slide as { title?: unknown }).title, file.replace(/\.[^.]+$/u, '')),
        description: text((slide as { desc?: unknown }).desc),
        url: proxiedAssetUrl(new URL(encodeURI(`examples/${folder}/${file}`), base).href),
      })
    }
    if (pages.length === 0) continue
    const coverFile = text(project['cover'])
    const coverPage = pages.find(page => page.url === proxiedAssetUrl(new URL(encodeURI(`examples/${folder}/${coverFile}`), base).href)) ?? pages[0]!
    const thumb = proxiedAssetUrl(new URL(encodeURI(`examples/_thumbs/${folder.split('/')[0]!}.webp`), base).href)
    const downloads: GalleryDownload[] = []
    for (const [key, label] of [['pptx', '下载 PPTX'], ['pptxNative', '下载原生图表 / 表格版 PPTX']] as const) {
      const href = text(project[key])
      if (href !== '') downloads.push({ label, url: new URL(encodeURI(href), base).href })
    }
    const styleName = text(project['styleName'])
    const style = text(project['style'])
    collections.push({
      id,
      title: text(project['title'], id),
      description: text(project['description']) || text(project['desc']),
      category: styleName || style || '通用',
      tags: [...new Set([...(style ? [style] : []), ...stringList(project['tags'])])],
      cover: thumb,
      pages: coverPage === pages[0] ? pages : [coverPage, ...pages.filter(page => page !== coverPage)],
      downloads,
    })
  }
  return collections
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/gu, '').replace(/\s+/gu, ' ').trim()
}

function resolveReadmeAsset(src: string, readmeUrl: string): string | undefined {
  try {
    const url = new URL(src, readmeUrl)
    return allowedAssetUrl(url.href) === undefined ? undefined : url.href
  } catch {
    return undefined
  }
}

/**
 * 解析 OpenDesign 中文 README 的「## 演示」章节。
 * @param markdown - README 原文。
 * @param readmeUrl - README 的 raw 地址，用来解析相对图片路径。
 * @returns 每个 `###` 小节一个 collection，页面即小节里的截图。
 */
export function parseOpenDesignShowcase(markdown: string, readmeUrl: string = OPEN_DESIGN_README_URL): GalleryCollection[] {
  const start = markdown.search(/^## 演示\s*$/mu)
  if (start === -1) return []
  const rest = markdown.slice(start + '## 演示'.length)
  const end = rest.search(/^## /mu)
  const section = end === -1 ? rest : rest.slice(0, end)
  const collections: GalleryCollection[] = []
  const blocks = section.split(/^### /mu).slice(1)
  for (const [index, block] of blocks.entries()) {
    const newline = block.indexOf('\n')
    const heading = (newline === -1 ? block : block.slice(0, newline)).trim()
    const body = newline === -1 ? '' : block.slice(newline + 1)
    const title = heading.replace(/^\d+\s*[·.、]\s*/u, '').replace(/`/gu, '').trim()
    const intro = body.split(/\n\s*\n/u).map(paragraph => paragraph.trim()).find(paragraph => paragraph !== '' && !paragraph.startsWith('<') && !paragraph.startsWith('**') && !paragraph.startsWith('['))
    const pages: GalleryPage[] = []
    const cells = body.split(/<td\b[^>]*>|<\/td>/u)
    for (const cell of cells) {
      const image = cell.match(/<img\s+[^>]*src="([^"]+)"[^>]*?(?:alt="([^"]*)")?[^>]*>/u)
      if (image === null) continue
      const upstream = resolveReadmeAsset(image[1]!, readmeUrl)
      if (upstream === undefined) continue
      const caption = cell.match(/<sub>([\s\S]*?)<\/sub>/u)?.[1] ?? ''
      const bold = caption.match(/<b>([\s\S]*?)<\/b>/u)?.[1]
      const captionTitle = bold === undefined ? '' : stripTags(bold)
      const description = stripTags(caption.replace(/<b>[\s\S]*?<\/b>/u, '')).replace(/^[—–\-·\s]+/u, '')
      pages.push({ title: captionTitle || stripTags(image[2] ?? '') || `示例 ${String(pages.length + 1)}`, description, url: proxiedAssetUrl(upstream) })
    }
    if (pages.length === 0) continue
    collections.push({
      id: `open-design:${String(index + 1)}`,
      title,
      description: intro === undefined ? '' : stripTags(intro).replace(/`/gu, ''),
      category: title,
      tags: [],
      cover: pages[0]!.url,
      pages,
      downloads: [],
    })
  }
  return collections
}

interface CacheEntry<T> { value: T; expiresAt: number }

export interface UpstreamDemoServiceOptions {
  fetch?: typeof fetch
  now?: () => number
}

export interface UpstreamDemoService {
  gallery(skill: GallerySkill): Promise<GalleryResult>
  asset(upstream: URL): Promise<ProxiedAsset | undefined>
}

/**
 * 建一个带内存缓存的上游画廊服务。
 * @param options - 可注入的 fetch 与时钟，便于测试。
 * @returns 画廊读取与资源代理两个能力。
 */
export function createUpstreamDemoService(options: UpstreamDemoServiceOptions = {}): UpstreamDemoService {
  const fetchImpl = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const galleries = new Map<GallerySkill, CacheEntry<Gallery>>()
  const assets = new Map<string, CacheEntry<ProxiedAsset>>()
  let assetBytes = 0

  const request = async (url: string, accept: string): Promise<Response> => {
    const response = await fetchImpl(url, {
      headers: { accept, 'user-agent': 'lumo-harness/0.1 (+skill demo gallery)' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (!response.ok) throw new Error(`${url} 返回 ${String(response.status)}`)
    return response
  }

  const load = async (skill: GallerySkill): Promise<Gallery> => {
    if (skill === 'ppt-master') {
      const manifest: unknown = await (await request(new URL('examples/examples.json', PPT_MASTER_EXAMPLES_BASE).href, 'application/json')).json()
      return { skill, title: 'PPT Master 示例库', source: PPT_MASTER_EXAMPLES_BASE, fetchedAt: new Date(now()).toISOString(), collections: parsePptMasterExamples(manifest) }
    }
    const markdown = await (await request(OPEN_DESIGN_README_URL, 'text/plain')).text()
    return { skill, title: 'OpenDesign 演示', source: OPEN_DESIGN_GALLERY_PAGE, fetchedAt: new Date(now()).toISOString(), collections: parseOpenDesignShowcase(markdown) }
  }

  const evictAssets = (): void => {
    for (const [key, entry] of assets) {
      if (entry.expiresAt <= now()) { assets.delete(key); assetBytes -= entry.value.body.byteLength }
    }
    // Map 迭代按插入顺序，最早缓存的先出，够用的近似 LRU。
    for (const [key, entry] of assets) {
      if (assetBytes <= ASSET_CACHE_BYTES) break
      assets.delete(key); assetBytes -= entry.value.body.byteLength
    }
  }

  return {
    async gallery(skill) {
      const cached = galleries.get(skill)
      if (cached !== undefined && cached.expiresAt > now()) return { available: true, gallery: cached.value }
      try {
        const gallery = await load(skill)
        if (gallery.collections.length === 0) throw new Error('上游画廊没有可解析的样例')
        galleries.set(skill, { value: gallery, expiresAt: now() + GALLERY_TTL_MS })
        return { available: true, gallery }
      } catch (error) {
        // 过期缓存好于空白：网络抖动时继续用上一份。
        if (cached !== undefined) return { available: true, gallery: cached.value }
        return { available: false, skill, error: error instanceof Error ? error.message : String(error) }
      }
    },
    async asset(upstream) {
      const key = upstream.href
      const cached = assets.get(key)
      if (cached !== undefined && cached.expiresAt > now()) return cached.value
      let response: Response
      try { response = await request(key, 'image/*,*/*;q=0.5') } catch { return undefined }
      const declared = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      const contentType = ASSET_CONTENT_TYPES.has(declared) ? declared : declared === 'application/octet-stream' && key.endsWith('.svg') ? 'image/svg+xml' : undefined
      if (contentType === undefined) return undefined
      const length = Number(response.headers.get('content-length') ?? '0')
      if (Number.isFinite(length) && length > ASSET_MAX_BYTES) return undefined
      const body = new Uint8Array(await response.arrayBuffer())
      if (body.byteLength > ASSET_MAX_BYTES) return undefined
      const value: ProxiedAsset = { body, contentType }
      if (cached !== undefined) assetBytes -= cached.value.body.byteLength
      assets.set(key, { value, expiresAt: now() + ASSET_TTL_MS })
      assetBytes += body.byteLength
      evictAssets()
      return value
    },
  }
}

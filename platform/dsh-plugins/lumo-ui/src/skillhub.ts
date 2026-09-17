/**
 * SkillHub catalog adapter for the Lumo capability market.
 *
 * SkillHub (skillhub.cn) is an external skill source that installs through the
 * `skillhub` CLI into a local directory; it is not a DSH Cordis runtime plugin.
 * Desktop installation delegates to the official CLI with the runtime's skill
 * root, then verifies native discovery before recording success. Expert packs
 * install their constituent skills behind one native expert entry skill.
 * DSH plugins are installed through the separate plugin market.
 */
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join, relative, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execa } from 'execa'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { InstalledSkill, SkillHubRuntime } from './skillhub-runtime.ts'
import {
  PACK_CATEGORIES,
  PLUGIN_CATEGORIES,
  SEED_PACKS as GENERATED_SEED_PACKS,
  SEED_PLUGINS as GENERATED_SEED_PLUGINS,
  SEED_SKILLS as GENERATED_SEED_SKILLS,
  SKILL_CATEGORIES,
} from './generated/skillhub-seed.ts'

export type SkillHubKind = 'skill' | 'pack' | 'plugin'

export interface SkillHubSkill {
  id: string
  name: string
  tag: string
  description: string
  rating: number
  downloads: number
  source: string
  verified: boolean
  /** Catalog command hint; installation resolves the actual native name. */
  command: string
  apiKey: boolean
  /** Optional icon URL from SkillHub. */
  icon?: string
  /** Publisher / owner display name. */
  publisher?: string
  /** Free-form tags from SkillHub. */
  tags?: string[]
  /** SkillHub detail page. */
  homepage?: string
}

export interface SkillHubPack {
  id: string
  name: string
  role: string
  category: string
  description: string
  /** Number of bundled skills. */
  skills: number
  source: string
  /** Optional primary command if installing exposes an entry skill. */
  command?: string
  skillSlugs?: string[]
  icon?: string
}

export interface SkillHubPlugin {
  id: string
  name: string
  category: string
  description: string
  stars: number
  forks: number
  source: string
  installable: boolean
  repo: string
  icon?: string
  homepage?: string
}

export interface SkillHubInstalls {
  skills: string[]
  packs: string[]
  plugins: string[]
  /** Actual runtime names, keyed by `kind:id`; old UI-only records have none. */
  commands?: Record<string, string[]>
  /** Materialized skill files, used to invalidate receipts after removal. */
  files?: Record<string, string[]>
}

export interface SkillHubCategories {
  skills: string[]
  packs: string[]
  plugins: string[]
}

export interface SkillHubCatalog {
  /** `skillhub` = fetched live, `cache` = last successful fetch on disk, `seed` = bundled fallback. */
  source: 'skillhub' | 'cache' | 'seed'
  generatedAt: string
  counts: { skills: number; packs: number; plugins: number }
  /** Human-readable category names per surface, taken from SkillHub when live. */
  categories: SkillHubCategories
  skills: SkillHubSkill[]
  packs: SkillHubPack[]
  plugins: SkillHubPlugin[]
  installed: SkillHubInstalls
  /** Transient install feedback (failed constituent skills); never cached. */
  notice?: string
}

export interface SkillHubConfig {
  /** Absolute path to the optional catalog index file; unreadable => seed fallback. */
  catalogFile: string
  /** Absolute path where installs are recorded (workspace-owned state). */
  installFile: string
  /** Absolute directory skills are installed into (only used when CLI present). */
  root: string
  /** Absolute path to the skill snapshot file for skill-local provider. */
  snapshotFile: string
  /** SkillHub API base URL. */
  apiBase: string
  /** Executable name/path of the `skillhub` CLI; empty disables delegation. */
  command: string
  runtime?: SkillHubRuntime | undefined
  /** Injectable fetch for testing. */
  fetch?: typeof fetch
  /**
   * GitHub repositories (`owner/repo`) already installed as Lumo base/profile
   * plugins. Any catalog plugin whose `repo` matches is reported as installed,
   * so the market does not show a misleading 「安装」button for a bundled plugin.
   */
  preinstalledRepositories?: string[]
}

const EMPTY_INSTALLS: SkillHubInstalls = { skills: [], packs: [], plugins: [] }

/**
 * Bundled seed mirroring the SkillHub home surfaces so the panel works offline.
 *
 * 数据不写在这里：它是远端首页的快照，也是 refreshCatalog 的最后兜底（实时 → 磁盘缓存 →
 * 本数据），必须编译进包，不能变成运行期文件读取。真相源是
 * shared/manifests/skillhub-seed.manifest.json，由 tools/gen-skillhub-seed.mjs 生成到
 * ./generated/skillhub-seed.ts（lumo-ui 的 tsconfig 是 rootDir: src，跨包 import 编译不过）。
 * 要改数据就改清单，不要改生成物。
 */
const SEED_SKILLS: SkillHubSkill[] = GENERATED_SEED_SKILLS
const SEED_PACKS: SkillHubPack[] = GENERATED_SEED_PACKS
const SEED_PLUGINS: SkillHubPlugin[] = GENERATED_SEED_PLUGINS

/** Seed filter labels used when SkillHub is unreachable. */
export const SkillHubTags = { skills: SKILL_CATEGORIES }
export const SkillHubSeedCategories = { packs: PACK_CATEGORIES, plugins: PLUGIN_CATEGORIES }

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!existsSync(file)) return fallback
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return value as T
  } catch {
    return fallback
  }
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(dirname(file), { recursive: true })
  const temporary = `${file}.tmp-${randomUUID()}`
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(temporary, file)
}

function normalizeInstalls(installs: unknown): SkillHubInstalls {
  const source = (typeof installs === 'object' && installs !== null ? installs : {}) as Record<string, unknown>
  const asStringArray = (value: unknown): string[] => Array.isArray(value) ? value.filter(item => typeof item === 'string') : []
  const asStringRecord = (value: unknown): Record<string, string[]> => Object.fromEntries(Object.entries(
    typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {},
  ).map(([key, item]) => [key, asStringArray(item)]))
  const commands = Object.fromEntries(Object.entries(asStringRecord(source.commands))
    .map(([key, names]) => [key, names.filter(isSkillName)]))
  const files = asStringRecord(source.files)
  const installed = (key: string): boolean => files[key] !== undefined
    ? files[key].length > 0 && files[key].every(file => existsSync(file))
    : Boolean(commands[key]?.length)
  // Earlier versions wrote success even when the CLI failed. Those records
  // must offer Install again so the real files can be materialized.
  return {
    skills: asStringArray(source.skills).filter(id => installed(`skill:${id}`)),
    packs: asStringArray(source.packs).filter(id => installed(`pack:${id}`)),
    plugins: asStringArray(source.plugins),
    commands,
    files,
  }
}

interface SkillHubAPISkill {
  slug: string
  displayName?: string
  name: string
  summary?: string
  description?: string
  description_zh?: string
  downloads?: number
  installs?: number
  stars?: number
  category?: string
  tags?: string[]
  source?: string
  iconUrl?: string
  icon_url?: string | null
  homepage?: string
  ownerName?: string
  owner_name?: string
  namespace?: { displayName?: string }
  publisher?: { verified?: boolean; name?: string }
  verified?: boolean
  labels?: { requires_api_key?: 'true' | 'false' }
}

interface SkillHubAPISkillSet {
  slug: string
  displayName?: string
  displayNameEn?: string
  summary?: string
  summaryEn?: string
  scene?: string
  subScene?: string
  skillCount?: number
  skillSlugs?: string[]
  iconUrl?: string
}

interface SkillHubAPIPlugin {
  fullName: string
  description?: string
  stars?: number
  forks?: number
  categoryKey?: string
  avatarUrl?: string
  repositoryUrl?: string
  installability?: string
  banned?: boolean
}

interface SkillHubAPICategory { key: string; name?: string; displayName?: string }

/** SkillHub skillset `scene` keys → Chinese labels used on skillhub.cn. */
const PACK_SCENE_LABELS: Record<string, string> = {
  finance: '金融', tech: '科技', design: '设计', marketing: '营销', legal: '法律', academic: '学术', education: '教育',
  hr: '人力资源', ecommerce: '电商', media: '媒体', healthcare: '医疗', mysticism: '玄学', 'content-creation': '内容创作', lifestyle: '生活服务',
}

const API_TIMEOUT_MS = 6000
/** SkillHub list endpoints (`/api/skills`, `/api/v1/plugins`, `/api/v1/skillsets`) page with
 * `page` + `pageSize`; the server caps `pageSize` at 100 (`limit` is ignored). */
const PLUGIN_PAGE_MAX = 100
const PLUGIN_PAGE_DEFAULT = 60

async function getJson<T>(fetchFn: typeof fetch, url: string): Promise<T> {
  const response = await fetchFn(url, { signal: AbortSignal.timeout(API_TIMEOUT_MS), headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`skillhub ${new URL(url).pathname}: HTTP ${response.status}`)
  return await response.json() as T
}

type CategoryMap = Map<string, string>

/** `/api/skills` envelope: `{ code: 0, data: { skills, total } }` — the real market listing. */
interface SkillHubSkillsPageEnvelope {
  code?: number
  message?: string
  data?: { skills?: SkillHubAPISkill[]; total?: number }
}

/**
 * SkillHub's market listing (`/api/skills`): the full skill catalog with
 * server-side `page`/`pageSize` paging and a real `total` — unlike
 * `/api/v1/search`, which caps at 100 hits and never reports a total.
 */
async function fetchSkillsPage(fetchFn: typeof fetch, base: string, page: number, pageSize: number, options: { keyword?: string; categoryKey?: string; sortBy?: string; order?: string } = {}): Promise<{ skills: SkillHubAPISkill[]; total: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize), sortBy: options.sortBy ?? 'score', order: options.order ?? 'desc' })
  if (options.keyword !== undefined && options.keyword !== '') params.set('keyword', options.keyword)
  if (options.categoryKey !== undefined && options.categoryKey !== '') params.set('category', options.categoryKey)
  const envelope = await getJson<SkillHubSkillsPageEnvelope>(fetchFn, `${base}/api/skills?${params.toString()}`)
  if (envelope.code !== undefined && envelope.code !== 0) throw new Error(envelope.message || `skillhub /api/skills: code ${envelope.code}`)
  return { skills: envelope.data?.skills ?? [], total: envelope.data?.total ?? 0 }
}

async function fetchCategoryMaps(fetchFn: typeof fetch, apiBase: string): Promise<{ skills: CategoryMap; plugins: CategoryMap }> {
  const [skillCats, pluginCats] = await Promise.all([
    getJson<{ items?: SkillHubAPICategory[] }>(fetchFn, `${apiBase}/api/v1/categories`).catch(() => ({ items: [] })),
    getJson<{ items?: SkillHubAPICategory[] }>(fetchFn, `${apiBase}/api/v1/plugins/categories`).catch(() => ({ items: [] })),
  ])
  const toMap = (items: SkillHubAPICategory[] | undefined): CategoryMap => new Map((items ?? []).map(item => [item.key, item.name ?? item.displayName ?? item.key]))
  return { skills: toMap(skillCats.items), plugins: toMap(pluginCats.items) }
}

function mapSkill(s: SkillHubAPISkill, categories: CategoryMap): SkillHubSkill {
  const icon = s.iconUrl ?? (typeof s.icon_url === 'string' ? s.icon_url : undefined)
  const publisher = s.publisher?.name ?? s.namespace?.displayName ?? s.ownerName ?? s.owner_name
  return {
    id: s.slug,
    name: s.displayName ?? s.name,
    tag: s.category ? (categories.get(s.category) ?? s.category) : '其他',
    description: (s.description_zh ?? s.description ?? s.summary ?? '').trim(),
    rating: s.stars ?? 0,
    downloads: s.downloads ?? s.installs ?? 0,
    source: s.source === 'enterprise' ? 'SkillHub' : s.source === 'clawhub' ? 'ClawHub' : 'Community',
    verified: s.publisher?.verified ?? s.verified ?? false,
    command: s.slug,
    apiKey: s.labels?.requires_api_key === 'true',
    ...(icon ? { icon } : {}),
    ...(publisher ? { publisher } : {}),
    ...(Array.isArray(s.tags) && s.tags.length ? { tags: s.tags.slice(0, 6) } : {}),
    ...(s.homepage ? { homepage: s.homepage } : {}),
  }
}

function mapPack(p: SkillHubAPISkillSet): SkillHubPack {
  const scene = p.scene ?? p.subScene ?? ''
  return {
    id: p.slug,
    name: p.displayName || p.displayNameEn || p.slug,
    role: '',
    category: PACK_SCENE_LABELS[scene] ?? (scene || '其他'),
    description: (p.summary || p.summaryEn || '').trim(),
    skills: p.skillCount ?? p.skillSlugs?.length ?? 0,
    source: 'SkillHub',
    command: p.slug,
    ...(p.skillSlugs === undefined ? {} : { skillSlugs: p.skillSlugs }),
    ...(p.iconUrl ? { icon: p.iconUrl } : {}),
  }
}

function mapPlugin(p: SkillHubAPIPlugin, categories: CategoryMap): SkillHubPlugin {
  return {
    id: p.fullName,
    name: p.fullName,
    category: p.categoryKey ? (categories.get(p.categoryKey) ?? p.categoryKey) : '其他',
    description: (p.description ?? '').trim(),
    stars: p.stars ?? 0,
    forks: p.forks ?? 0,
    source: 'GitHub',
    installable: p.banned !== true && (p.installability === undefined || p.installability === 'verified' || p.installability === 'installable'),
    repo: p.fullName,
    ...(p.avatarUrl ? { icon: p.avatarUrl } : {}),
    ...(p.repositoryUrl ? { homepage: p.repositoryUrl } : {}),
  }
}

/**
 * Mark catalog plugins that are already installed as Lumo base/profile plugins
 * (matched by GitHub repo) as installed, so the market does not offer a
 * misleading「安装」button for a bundled plugin.
 */
function applyPreinstalledCatalog(catalog: SkillHubCatalog, config: SkillHubConfig): SkillHubCatalog {
  const normalizeRepo = (value: string): string => value.trim()
    .replace(/^https?:\/\/(?:www\.)?github\.com\//iu, '')
    .replace(/^git@github\.com:/iu, '')
    .replace(/\.git\/?$/iu, '')
    .replace(/^\/+|\/+$/gu, '')
    .toLowerCase()
  const repos = new Set((config.preinstalledRepositories ?? []).map(normalizeRepo).filter(Boolean))
  if (repos.size === 0) return catalog
  const extra = catalog.plugins
    .filter(plugin => repos.has(normalizeRepo(plugin.repo)))
    .map(plugin => plugin.id)
  if (extra.length === 0) return catalog
  return {
    ...catalog,
    installed: { ...catalog.installed, plugins: Array.from(new Set([...catalog.installed.plugins, ...extra])) },
  }
}

function seedCatalog(installed: SkillHubInstalls, config: SkillHubConfig): SkillHubCatalog {
  return applyPreinstalledCatalog({
    source: 'seed',
    generatedAt: new Date().toISOString(),
    counts: { skills: SEED_SKILLS.length, packs: SEED_PACKS.length, plugins: SEED_PLUGINS.length },
    categories: { skills: SkillHubTags.skills, packs: PACK_CATEGORIES, plugins: PLUGIN_CATEGORIES },
    skills: SEED_SKILLS,
    packs: SEED_PACKS,
    plugins: SEED_PLUGINS,
    installed,
  }, config)
}

function categoriesFor(prefix: string, values: Iterable<string>): string[] {
  return [prefix, ...Array.from(new Set(values)).filter(value => value !== '' && value !== prefix)]
}

/**
 * Fetch SkillHub live: hot skills, all skillsets and the first page of plugins,
 * plus both category dictionaries. On success the result is cached to
 * `catalogFile`; on any failure it falls back to the cache, then to the seed.
 */
export async function refreshCatalog(config: SkillHubConfig): Promise<SkillHubCatalog> {
  const fetchFn = config.fetch ?? fetch
  const base = config.apiBase.replace(/\/+$/, '')
  try {
    const [categories, hot, sets, pluginPage, skillTotals] = await Promise.all([
      fetchCategoryMaps(fetchFn, base),
      getJson<{ skills?: SkillHubAPISkill[] }>(fetchFn, `${base}/api/v1/showcase/hot`),
      // 全量专家包：官方页面用 page/pageSize 翻页（pageSize=200 一次拿完）；total 才是真实计数。
      getJson<{ skillSets?: SkillHubAPISkillSet[]; total?: number }>(fetchFn, `${base}/api/v1/skillsets?page=1&pageSize=200`),
      getJson<{ items?: SkillHubAPIPlugin[]; total?: number }>(fetchFn, `${base}/api/v1/plugins?page=1&pageSize=${PLUGIN_PAGE_MAX}`),
      // 技能真实总数：拿一条就够，失败不拖垮整个目录（回退到热门列表长度）。
      fetchSkillsPage(fetchFn, base, 1, 1).catch(() => null),
    ])
    const skills = (hot.skills ?? []).map(s => mapSkill(s, categories.skills))
    const packs = (sets.skillSets ?? []).map(mapPack)
    const plugins = (pluginPage.items ?? []).map(p => mapPlugin(p, categories.plugins))
    if (skills.length === 0 && packs.length === 0 && plugins.length === 0) throw new Error('skillhub returned an empty catalog')
    const catalog: SkillHubCatalog = {
      source: 'skillhub',
      generatedAt: new Date().toISOString(),
      counts: { skills: skillTotals?.total ?? skills.length, packs: sets.total ?? packs.length, plugins: pluginPage.total ?? plugins.length },
      categories: {
        skills: categoriesFor('全部', categories.skills.size ? categories.skills.values() : skills.map(s => s.tag)),
        packs: categoriesFor('全部', packs.map(p => p.category)),
        plugins: categoriesFor('全部分类', categories.plugins.size ? categories.plugins.values() : plugins.map(p => p.category)),
      },
      skills,
      packs,
      plugins,
      installed: normalizeInstalls(readJson(config.installFile, EMPTY_INSTALLS)),
    }
    try { writeJson(config.catalogFile, catalog) } catch { /* cache is best effort */ }
    return applyPreinstalledCatalog(catalog, config)
  } catch {
    return buildCatalog(config)
  }
}

/**
 * Build the catalog from the on-disk cache (last successful live fetch), falling
 * back to the bundled seed. Install state is always merged from disk and the
 * `source` field tells the UI what it is looking at.
 */
export function buildCatalog(config: SkillHubConfig): SkillHubCatalog {
  const installed = normalizeInstalls(readJson(config.installFile, EMPTY_INSTALLS))
  const external = readJson<Partial<SkillHubCatalog> | null>(config.catalogFile, null)
  if (external === null || external.source !== 'skillhub') return seedCatalog(installed, config)
  const skills = Array.isArray(external.skills) && external.skills.length ? external.skills : SEED_SKILLS
  const packs = Array.isArray(external.packs) && external.packs.length ? external.packs : SEED_PACKS
  const plugins = Array.isArray(external.plugins) && external.plugins.length ? external.plugins : SEED_PLUGINS
  const seedCats = seedCatalog(installed, config).categories
  return applyPreinstalledCatalog({
    source: 'cache',
    generatedAt: typeof external.generatedAt === 'string' ? external.generatedAt : new Date().toISOString(),
    counts: { skills: external.counts?.skills ?? skills.length, packs: external.counts?.packs ?? packs.length, plugins: external.counts?.plugins ?? plugins.length },
    categories: {
      skills: external.categories?.skills?.length ? external.categories.skills : seedCats.skills,
      packs: external.categories?.packs?.length ? external.categories.packs : seedCats.packs,
      plugins: external.categories?.plugins?.length ? external.categories.plugins : seedCats.plugins,
    },
    skills,
    packs,
    plugins,
    installed,
  }, config)
}

export interface SkillHubSearchQuery {
  kind: SkillHubKind
  /** Free-text query; empty means "browse". */
  q: string
  /** Human-readable category label as shown in the UI; '' / 全部 / 全部分类 means no filter. */
  category: string
  limit?: number
  /** 1-based page. */
  page?: number
}

export interface SkillHubSearchResult {
  kind: SkillHubKind
  q: string
  category: string
  /** `skillhub` when the live API answered, otherwise the local catalog was filtered. */
  source: 'skillhub' | 'cache' | 'seed'
  total: number
  page: number
  pageSize: number
  skills: SkillHubSkill[]
  packs: SkillHubPack[]
  plugins: SkillHubPlugin[]
}

function isAllCategory(category: string): boolean {
  return category === '' || category === '全部' || category === '全部分类'
}

function matchesText(q: string, ...fields: Array<string | undefined>): boolean {
  if (q === '') return true
  const needle = q.toLowerCase()
  return fields.some(field => (field ?? '').toLowerCase().includes(needle))
}

function keyForLabel(categories: CategoryMap, label: string): string | undefined {
  for (const [key, name] of categories) if (name === label || key === label) return key
  return undefined
}

function pageSlice<T>(items: T[], page: number, pageSize: number): T[] {
  return items.slice((page - 1) * pageSize, page * pageSize)
}

/**
 * Query SkillHub directly. Skills use the real market listing `/api/skills` with
 * `page`/`pageSize`, `keyword`, `category=<key>` and `sortBy` paging; skillsets
 * page with `category`-equivalent `scene=<key>` and `keyword`; plugins use the
 * server-side `q` search and paging. Any network failure degrades to filtering
 * (and paging) the local catalog so the UI always gets an answer with the same shape.
 */
export async function searchCatalog(config: SkillHubConfig, query: SkillHubSearchQuery): Promise<SkillHubSearchResult> {
  const fetchFn = config.fetch ?? fetch
  const base = config.apiBase.replace(/\/+$/, '')
  const q = query.q.trim()
  const category = isAllCategory(query.category) ? '' : query.category
  const limit = Math.min(Math.max(query.limit ?? PLUGIN_PAGE_DEFAULT, 1), 200)
  const pageSize = Math.min(limit, PLUGIN_PAGE_MAX)
  const page = Math.max(1, Math.floor(query.page ?? 1))
  const empty: SkillHubSearchResult = { kind: query.kind, q, category, source: 'skillhub', total: 0, page: 1, pageSize, skills: [], packs: [], plugins: [] }
  try {
    if (query.kind === 'skill') {
      const categories = await fetchCategoryMaps(fetchFn, base)
      const key = category === '' ? undefined : keyForLabel(categories.skills, category)
      const listing = await fetchSkillsPage(fetchFn, base, page, pageSize, { keyword: q, ...(key === undefined ? {} : { categoryKey: key }) })
      const skills = (listing.skills ?? []).map(s => mapSkill(s, categories.skills))
        // Unknown label (not in the live dictionary): the server saw no filter, so narrow the page locally.
        .filter(s => category === '' || s.tag === category)
      return { ...empty, total: listing.total, page, pageSize, skills }
    }
    if (query.kind === 'pack') {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
      if (q !== '') params.set('keyword', q)
      const scene = category === '' ? undefined : keyForLabel(new Map(Object.entries(PACK_SCENE_LABELS)), category)
      if (scene !== undefined) params.set('scene', scene)
      const data = await getJson<{ skillSets?: SkillHubAPISkillSet[]; total?: number }>(fetchFn, `${base}/api/v1/skillsets?${params.toString()}`)
      const packs = (data.skillSets ?? []).map(mapPack)
      return { ...empty, total: data.total ?? packs.length, page, pageSize, packs }
    }
    const categories = await fetchCategoryMaps(fetchFn, base)
    const key = category === '' ? undefined : keyForLabel(categories.plugins, category)
    const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) })
    if (q !== '') params.set('q', q)
    if (key !== undefined) params.set('category', key)
    const data = await getJson<{ items?: SkillHubAPIPlugin[]; total?: number; page?: number; pageSize?: number }>(fetchFn, `${base}/api/v1/plugins?${params.toString()}`)
    const plugins = (data.items ?? []).map(p => mapPlugin(p, categories.plugins))
      // Unknown label (not in the live dictionary): the server saw no filter, so narrow the page locally.
      .filter(p => category === '' || key !== undefined || p.category === category)
    return { ...empty, total: data.total ?? plugins.length, page: data.page ?? page, pageSize: data.pageSize ?? pageSize, plugins }
  } catch {
    const local = buildCatalog(config)
    const skills = query.kind === 'skill' ? local.skills.filter(s => (category === '' || s.tag === category) && matchesText(q, s.id, s.name, s.description, s.tag)) : []
    const packs = query.kind === 'pack' ? local.packs.filter(p => (category === '' || p.category === category) && matchesText(q, p.id, p.name, p.description, p.role)) : []
    const plugins = query.kind === 'plugin' ? local.plugins.filter(p => (category === '' || p.category === category) && matchesText(q, p.name, p.description, p.category)) : []
    if (query.kind === 'plugin') return { ...empty, source: local.source, total: plugins.length, page, pageSize, plugins: pageSlice(plugins, page, pageSize) }
    const localItems = query.kind === 'skill' ? skills : packs
    return { ...empty, source: local.source, total: localItems.length, page, pageSize, skills: pageSlice(skills, page, pageSize), packs: pageSlice(packs, page, pageSize) }
  }
}

const installing = new Map<string, Promise<SkillHubCatalog>>()

function isInstallId(id: unknown): id is string {
  return typeof id === 'string' && /^[\w@][\w.@/-]{0,127}$/.test(id)
    && id.split('/').every(part => part !== '' && part !== '..' && part !== '.')
}

function recordInstall(config: SkillHubConfig, kind: 'skill' | 'pack', id: string, skills: InstalledSkill[], commands = skills.filter(skill => skill.userInvocable).map(skill => skill.name)): void {
  const installs = normalizeInstalls(readJson(config.installFile, EMPTY_INSTALLS))
  const previous = JSON.stringify(installs)
  const bucket = kind === 'skill' ? 'skills' : 'packs'
  if (!installs[bucket].includes(id)) installs[bucket].push(id)
  const key = `${kind}:${id}`
  installs.commands = { ...installs.commands, [key]: [...new Set(commands)] }
  installs.files = { ...installs.files, [key]: [...new Set(skills.map(skill => skill.path))] }
  if (JSON.stringify(installs) !== previous) writeJson(config.installFile, installs)
}

/** Serialize installs per root so concurrent requests cannot lose receipts. */
export async function installItem(config: SkillHubConfig, kind: SkillHubKind, id: string): Promise<SkillHubCatalog> {
  return serializeInstall(config, () => install(config, kind, id))
}

async function serializeInstall(config: SkillHubConfig, operation: () => Promise<SkillHubCatalog>): Promise<SkillHubCatalog> {
  const previous = installing.get(config.root)
  const pending = (previous ?? Promise.resolve()).catch(() => {}).then(operation)
  installing.set(config.root, pending)
  try { return await pending } finally { if (installing.get(config.root) === pending) installing.delete(config.root) }
}

/**
 * Resolve a path that may not exist yet to the form the filesystem reports.
 *
 * The runtime's skill provider reports the *physical* path of every skill it
 * discovers, so a path built from `config.root` can only be compared with — or
 * relativized against — a discovered path once it is physical too. macOS makes
 * the difference visible: `/var` is a symlink to `private/var`, so a root under
 * `os.tmpdir()` yields `/var/…` while discovery yields `/private/var/…`, and a
 * string equality test between the two never matches.
 *
 * `realpathSync` throws on a path that does not exist, so climb to the deepest
 * existing ancestor and re-append the segments that are still missing.
 */
function physicalPath(target: string): string {
  const absolute = resolve(target)
  const missing: string[] = []
  let current = absolute
  for (;;) {
    try {
      return join(realpathSync(current), ...missing)
    } catch {
      const parent = dirname(current)
      // Filesystem root: nothing left to resolve, so the logical path is the best answer available.
      if (parent === current) return absolute
      missing.unshift(basename(current))
      current = parent
    }
  }
}

async function installPackEntry(config: SkillHubConfig, pack: SkillHubPack, skills: InstalledSkill[]): Promise<void> {
  if (config.runtime === undefined) throw new Error('当前运行时未启用本地技能安装。')
  const digest = createHash('sha256').update(pack.id).digest('hex').slice(0, 16)
  const command = pack.command && isSkillName(pack.command) ? pack.command
    : isSkillName(pack.id) ? pack.id : `expert-${digest}`
  // Physical, because everything below is compared against — or relativized
  // against — a path the runtime reported for a discovered skill.
  const directory = physicalPath(join(config.root, `lumo-expert-${digest}`))
  const file = join(directory, 'SKILL.md')
  const isExpertEntry = (skill: InstalledSkill): boolean =>
    skill.path === file && skill.name === command && skill.userInvocable
  const constituents = skills.filter(skill => skill.path !== file)
  if (constituents.length === 0) throw new Error(`「${pack.name}」没有可用技能，未安装专家入口。`)
  const existing = constituents.find(skill => skill.name === command && skill.userInvocable)
  if (existing !== undefined) {
    recordInstall(config, 'pack', pack.id, constituents, [existing.name])
    return
  }
  const content = [
    '---',
    `name: ${command}`,
    `description: ${JSON.stringify(`以「${pack.name}」专家身份处理任务。${pack.description ?? ''}`)}`,
    'user-invocable: true',
    'disable-model-invocation: true',
    '---',
    `# ${pack.name}`,
    '',
    `你是「${pack.name}」${pack.role ? `，角色：${pack.role}` : '专家'}。${pack.description ?? ''}`,
    '在当前对话中以此专家身份理解任务、执行并给出统一答复，直到用户明确切换角色。',
    '根据任务选择下列相关技能，先读取对应 SKILL.md 并遵循其中的步骤、资源路径和前置条件。',
    '不必同时执行所有技能，也不要要求用户逐个输入技能命令。保持已有对话上下文。',
    '',
    '## 可用技能',
    ...constituents.map(skill => `- ${skill.name}: ${JSON.stringify(relative(directory, skill.path).replaceAll('\\', '/'))}`),
    '',
  ].join('\n')
  mkdirSync(directory, { recursive: true })
  const unchanged = existsSync(file) && readFileSync(file, 'utf8') === content
  const discovered = skills.find(isExpertEntry)
  if (unchanged && discovered !== undefined) {
    recordInstall(config, 'pack', pack.id, [...constituents, discovered], [discovered.name])
    return
  }
  if (!unchanged) {
    const temporary = `${file}.tmp-${randomUUID()}`
    writeFileSync(temporary, content, { mode: 0o600 })
    renameSync(temporary, file)
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    if (attempt > 0) await delay(250)
    const entry = (await config.runtime.refresh()).find(isExpertEntry)
    if (entry !== undefined) {
      recordInstall(config, 'pack', pack.id, [...constituents, entry], [entry.name])
      return
    }
  }
  throw new Error(`专家入口未能加载：${command}`)
}

export async function loadCatalog(config: SkillHubConfig, cachedOnly = false): Promise<SkillHubCatalog> {
  return serializeInstall(config, async () => {
    const catalog = cachedOnly ? buildCatalog(config) : await refreshCatalog(config)
    if (config.runtime === undefined || catalog.installed.packs.length === 0) return catalog
    const available = await config.runtime.refresh()
    const unavailable = new Set<string>()
    const notices: string[] = []
    for (const id of catalog.installed.packs) {
      const key = `pack:${id}`
      const commands = catalog.installed.commands?.[key] ?? []
      const files = catalog.installed.files?.[key]
      const loaded = available.filter(skill => files ? files.includes(skill.path) : commands.includes(skill.name))
      const pack = catalog.packs.find(item => item.id === id) ?? { id, name: id, role: '', category: '', description: '', skills: loaded.length, source: 'cache' }
      try {
        await installPackEntry(config, pack, loaded)
      } catch (error) {
        unavailable.add(id)
        notices.push(`「${pack.name}」专家入口暂不可用，请重新安装：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const installed = buildCatalog(config).installed
    return {
      ...catalog,
      installed: {
        ...installed,
        packs: installed.packs.filter(id => !unavailable.has(id)),
        commands: Object.fromEntries(Object.entries(installed.commands ?? {}).filter(([key]) => !key.startsWith('pack:') || !unavailable.has(key.slice(5)))),
      },
      ...(notices.length ? { notice: notices.join('；') } : {}),
    }
  })
}

async function install(config: SkillHubConfig, kind: SkillHubKind, id: string): Promise<SkillHubCatalog> {
  if (!['skill', 'pack', 'plugin'].includes(kind)) throw new TypeError(`unknown skillhub kind: ${kind}`)
  if (!isInstallId(id)) throw new TypeError(`skillhub: invalid ${kind} id`)
  if (kind === 'plugin') throw new TypeError('请在插件市场安装 DSH 插件。')
  if (config.runtime === undefined) throw new Error('当前运行时未启用本地技能安装。')
  if (config.command === '') throw new Error('未配置 SkillHub CLI，请先安装 CLI 并配置 skillhubCommand。')
  let catalog = buildCatalog(config)
  const inCatalog = (c: SkillHubCatalog): boolean => kind === 'skill'
    ? c.skills.some(item => item.id === id)
    : c.packs.some(item => item.id === id)
  // Items found through live search may not be in the cached catalog; confirm with SkillHub before installing.
  if (!inCatalog(catalog)) {
    const live = await searchCatalog(config, { kind, q: id, category: '' })
    if (live.source !== 'skillhub' || !inCatalog({ ...catalog, skills: live.skills, packs: live.packs, plugins: live.plugins })) throw new TypeError(`skillhub: ${kind} ${id} not found in catalog`)
    catalog = { ...catalog, skills: live.skills, packs: live.packs, plugins: live.plugins }
  }
  let slugs = kind === 'skill' ? [id] : catalog.packs.find(pack => pack.id === id)?.skillSlugs
  // Older catalog caches and seed packs predate constituent-skill metadata.
  if (kind === 'pack' && !slugs?.length) {
    const live = await searchCatalog(config, { kind, q: id, category: '' })
    slugs = live.packs.find(pack => pack.id === id)?.skillSlugs
  }
  if (!Array.isArray(slugs) || !slugs.length) throw new Error('无法取得该专家包的技能清单，请检查 SkillHub 连接后重试。')
  if (!slugs.every(isInstallId)) throw new TypeError('专家包包含非法技能标识')
  const loaded = new Map<string, InstalledSkill>()
  // Expert-pack constituents can be individually unavailable (the API published
  // a stale slug list, or the download endpoint 404s a delisted skill). A pack
  // install still succeeds for the healthy skills and reports the rest; a
  // single-skill install keeps failing hard so the UI never lies about it.
  const skipped: string[] = []
  mkdirSync(config.root, { recursive: true })
  for (const slug of new Set(slugs)) {
    const shortName = slug.split('/').pop()!.replace(/@[^@]+$/, '')
    const receipts = normalizeInstalls(readJson(config.installFile, EMPTY_INSTALLS))
    const recordedFiles = new Set(receipts.files?.[`skill:${slug}`] ?? [])
    const matches = (skill: InstalledSkill): boolean => skill.name === shortName
      || basename(dirname(skill.path)) === shortName || recordedFiles.has(skill.path)
    const available = await config.runtime.refresh()
    let installed = available.filter(matches)
    if (!installed.length) {
      const before = new Set(available.map(skill => skill.path))
      try {
        const args = ['install', slug, '--dir', config.root]
        const nodeScript = /\.[cm]?js$/i.test(config.command)
        await execa(nodeScript ? process.execPath : config.command, nodeScript ? [config.command, ...args] : args, {
          timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true,
          env: { PATH: [dirname(process.execPath), join(homedir(), '.local', 'bin'), process.env.PATH ?? ''].join(delimiter) },
        })
      } catch (error) {
        const failure = error as Error & { code?: string; stderr?: string }
        if (failure.code === 'ENOENT') throw new Error('未找到 SkillHub CLI。请按 https://skillhub.cn/install/skillhub.md 安装 CLI，或配置 LUMO_SKILLHUB_COMMAND。')
        if (kind === 'skill') throw new Error(`SkillHub 安装失败（${slug}）：${(failure.stderr || failure.message).trim().slice(0, 1000)}`)
        skipped.push(slug)
        continue
      }
      // 服务发现往往慢于 CLI 的收尾（解压重命名、watcher 摄取）：CLI 成功后给
      // 一小段重试窗口，避免把刚落盘的 SKILL.md 误判成缺失。
      for (let attempt = 0; attempt < 8 && installed.length === 0; attempt += 1) {
        if (attempt > 0) await delay(250)
        installed = (await config.runtime.refresh()).filter(skill => matches(skill) || !before.has(skill.path))
      }
    }
    if (installed.length === 0) {
      if (kind === 'skill') throw new Error(`SkillHub 未安装可加载的 SKILL.md：${slug}`)
      skipped.push(slug)
      continue
    }
    recordInstall(config, 'skill', slug, installed)
    for (const skill of installed) loaded.set(skill.path, skill)
  }
  if (kind === 'pack') {
    if (loaded.size === 0) throw new Error(`专家包的全部技能均不可用：${skipped.join('、')}`)
    await installPackEntry(config, catalog.packs.find(pack => pack.id === id)!, [...loaded.values()])
  }
  const result = buildCatalog(config)
  if (skipped.length === 0) return result
  const name = result.packs.find(pack => pack.id === id)?.name ?? id
  return {
    ...result,
    notice: `「${name}」已安装（${loaded.size} 个技能），${skipped.length} 个构成技能不可用：${skipped.join('、')}。`,
  }
}

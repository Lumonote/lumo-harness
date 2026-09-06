/**
 * SkillHub catalog adapter for the Lumo capability market.
 *
 * SkillHub (skillhub.cn) is an external skill source that installs through the
 * `skillhub` CLI into a local directory; it is not a DSH Cordis runtime plugin.
 * Desktop installation delegates to the official CLI with the runtime's skill
 * root, then verifies native discovery before recording success. Expert packs
 * install their constituent skills and expose their actual `/name` gestures.
 * DSH plugins are installed through the separate plugin market.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { execa } from 'execa'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import type { InstalledSkill, SkillHubRuntime } from './skillhub-runtime.ts'

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

/** Bundled seed mirroring the SkillHub home surfaces so the panel works offline. */
const SEED_SKILLS: SkillHubSkill[] = [
  { id: 'tencent-docs', name: '腾讯文档 TENCENT DOCS', tag: '办公效率', description: '在线云文档平台,是创建、编辑、管理文档的首选 skill。包括"新建/创建/编辑/读取/查看/搜索文档"、"保存文件"、"云文档"、"腾讯文档"等操作。', rating: 274, downloads: 719000, source: 'SkillHub', verified: true, command: 'tencent-docs', apiKey: true },
  { id: 'coding-expert', name: '编程专家.Skill', tag: '开发编程', description: '编程专家.Skill P8级编程助手,覆盖:软件/网站项目总控、API设计、Bug诊断、代码生成、代码审查、重构、测试用例、性能基准、技术选型、文档生成、任务拆解、Spec 编写。', rating: 160, downloads: 880000, source: 'SkillHub', verified: false, command: 'coding-expert', apiKey: false },
  { id: 'ima-skills', name: 'ima-skills', tag: '知识管理', description: 'ima-skills,支持对笔记、知识库的读取、写入和检索等操作,可以帮你随时记录、收入ima智能管理、随时调用,龙虾输出精准懂你,友好的接入了OpenClaw生态,构建完整知识闭环。', rating: 512, downloads: 295000, source: 'SkillHub', verified: true, command: 'ima-skills', apiKey: true },
  { id: 'search-engines', name: '搜索引擎', tag: '知识管理', description: '多搜索引擎集成,16引擎(7国内+9全球)。Multi search engine integration with 16 engines (7 CN + 9 Global).核心能力:统一搜索入口、多源聚合、结果去重、网页摘要提取、链接溯源。', rating: 17, downloads: 290000, source: 'SkillHub', verified: false, command: 'search-engines', apiKey: false },
  { id: 'anti-fraud', name: '防骗大师.Skill', tag: '生活服务', description: '防骗大师.Skill:你身边的生活防骗专家。当用户贴来可疑的短信、聊天记录、邮件、链接、App或电话转述,想知道"这是不是骗局"时立即出动,一眼看穿套路;当对话涉及转账、退款、刷单等场景时主动预警。', rating: 14, downloads: 256000, source: 'SkillHub', verified: false, command: 'anti-fraud', apiKey: false },
  { id: 'smart-charts', name: 'smart-charts', tag: '数据分析', description: '26种图表、3个主题,2步生成:1.上传数据 — 将CSV/Excel/JSON等格式的数据文件拖入对话框;2.查看结果 — 交互式图表(HTML),可保存图像为图片。', rating: 65, downloads: 250000, source: 'SkillHub', verified: false, command: 'smart-charts', apiKey: false },
]

const SEED_PACKS: SkillHubPack[] = [
  { id: 'automation-testing', name: '自动化测试', role: '高级开发工程师', category: '科技', description: '从TDD方法论指导到自动生成单元测试代码、跨语言测试编写与运行、Playwright/Cypress E2E测试编排、REST/GraphQL API测试自动化,再到QA测试计划与覆盖率矩阵生成的完整工作流。', skills: 6, source: 'SkillHub', command: 'automation-testing' },
  { id: 'bug-triage', name: 'Bug排查', role: '高级开发工程师', category: '科技', description: '从多格式日志解析与错误模式分析到七步调试法、运行时执行追踪、四阶段系统化根因分析,再到零回归修复工作流和快速错误解释的完整Bug排查工作流。支持Python、Node.js、Go。', skills: 6, source: 'SkillHub', command: 'bug-triage' },
  { id: 'clinical-assist', name: '临床辅助', role: '健康信息顾问', category: '医疗', description: '从AI辅助诊断(病历文本分析/实验室结果解读/系统化诊断推理/鉴别诊断/决策支持)与用药安全管理(药物咨询/用药方案/药物相互作用/剂量调整/不良反应),医生级循证临床助手。', skills: 6, source: 'SkillHub', command: 'clinical-assist' },
  { id: 'health-report', name: '健康报告', role: '健康信息顾问', category: '医疗', description: '从全维度健康管理与中西医融合(运动训练/饮食营养/健康数据追踪/中医体质辨识/节气养生)与结构化健康摘要报告生成(体征/症状/药物/生活方式数据汇总),健康数据深度分析。', skills: 6, source: 'SkillHub', command: 'health-report' },
  { id: 'medical-record', name: '病历分析', role: '健康信息顾问', category: '医疗', description: '从智能病历结构化组织(病历规范化/主诉提取/病史整理/电子病历生成)与规范化入院记录撰写(三步流程/入院记录/病历格式化),病历文本辅助诊断(病历分析/实验室结果解读)。', skills: 6, source: 'SkillHub', command: 'medical-record' },
  { id: 'nursing-plan', name: '护理方案', role: '健康信息顾问', category: '医疗', description: '从护理研究理论支持论证(理论选择/文献检索/护理科研开题)与临床护理支持系统(文档记录/患者沟通/护理计划制定),阿尔茨海默症专病照护(疾病认知/日常照护/安全管理/沟通)。', skills: 6, source: 'SkillHub', command: 'nursing-plan' },
  { id: 'resume-screen', name: '简历筛选', role: '组织人才顾问', category: '人力资源', description: '从JD解析与胜任力建模到简历批量初筛、结构化评分、候选人对比与面试提问建议,为招聘者提供可解释、可回溯的简历筛选工作流。', skills: 6, source: 'SkillHub', command: 'resume-screen' },
]

const SEED_PLUGINS: SkillHubPlugin[] = [
  { id: 'dsh-routing-suite', name: 'yjh051108/dsh-routing-suite', category: '模型推理', description: 'dsh-routing-suite - injector + router-standard kit: install the runtime injector first, then the task-aware reasoning-mode router preset (measured P1-P23).', stars: 7000, forks: 147, source: 'GitHub', installable: true, repo: 'yjh051108/dsh-routing-suite' },
  { id: 'modlens', name: 'liustack/modlens', category: '模型推理', description: 'The first vision plugin for DeepSeek Harness, and the vision bridge for every text-only coding agent. Paste an image, get structured JSON evidence (OCR, layout, semantics).', stars: 3800, forks: 112, source: 'GitHub', installable: true, repo: 'liustack/modlens' },
  { id: 'dsh-better-sidebar', name: 'omdsh-dev/dsh-better-sidebar', category: '客户端', description: '开放的侧边栏底座,支持三方拓展注册新侧边栏页面。内置文件渲染编辑/终端/侧边对话/Git/子代理页面 | Open sidebar foundation, supports third-party extensions.', stars: 3200, forks: 284, source: 'GitHub', installable: true, repo: 'omdsh-dev/dsh-better-sidebar' },
  { id: 'dsh-market', name: 'dsh-market/dsh-market', category: '客户端', description: 'The plugin market inside DeepSeek Harness - browse, search, one-click install. - DSH 可视化插件市场', stars: 3100, forks: 162, source: 'GitHub', installable: true, repo: 'dsh-market/dsh-market' },
  { id: 'dsh-tui', name: 'ccch1mneyyy/dsh-tui', category: '客户端', description: 'DSH 官方公众号收录的 TUI 补位插件:Claude Code 风,鲸鱼顶栏/实时状态/流式思考/双击 Esc 回滚/上下文进度+TPS。npm 一键装。DSH official WeChat featured.', stars: 2800, forks: 147, source: 'GitHub', installable: true, repo: 'ccch1mneyyy/dsh-tui' },
]

const PACK_CATEGORIES = ['全部', '金融', '科技', '设计', '营销', '法律', '学术', '教育', '人力资源', '电商', '媒体', '医疗', '玄学']
const PLUGIN_CATEGORIES = ['全部分类', '趣味换装', '联网工具', '记忆', '工作流', '模型推理', '客户端', '安全管理']

/** Seed filter labels used when SkillHub is unreachable. */
export const SkillHubTags = { skills: ['全部', '办公效率', '开发编程', '知识管理', '生活服务', '数据分析'] }
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
  const repos = new Set(config.preinstalledRepositories ?? [])
  if (repos.size === 0) return catalog
  const extra = catalog.plugins
    .filter(plugin => repos.has(plugin.repo))
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

function recordInstall(config: SkillHubConfig, kind: 'skill' | 'pack', id: string, skills: InstalledSkill[]): void {
  const installs = normalizeInstalls(readJson(config.installFile, EMPTY_INSTALLS))
  const bucket = kind === 'skill' ? 'skills' : 'packs'
  if (!installs[bucket].includes(id)) installs[bucket].push(id)
  const key = `${kind}:${id}`
  installs.commands = { ...installs.commands, [key]: [...new Set(skills.filter(skill => skill.userInvocable).map(skill => skill.name))] }
  installs.files = { ...installs.files, [key]: [...new Set(skills.map(skill => skill.path))] }
  writeJson(config.installFile, installs)
}

/** Serialize installs per root so concurrent requests cannot lose receipts. */
export async function installItem(config: SkillHubConfig, kind: SkillHubKind, id: string): Promise<SkillHubCatalog> {
  const previous = installing.get(config.root)
  const pending = (previous ?? Promise.resolve()).catch(() => {}).then(() => install(config, kind, id))
  installing.set(config.root, pending)
  try { return await pending } finally { if (installing.get(config.root) === pending) installing.delete(config.root) }
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
  if (kind === 'pack') recordInstall(config, kind, id, [...loaded.values()])
  const result = buildCatalog(config)
  if (skipped.length === 0) return result
  const name = result.packs.find(pack => pack.id === id)?.name ?? id
  return {
    ...result,
    notice: `「${name}」已安装（${loaded.size} 个技能），${skipped.length} 个构成技能不可用：${skipped.join('、')}。`,
  }
}

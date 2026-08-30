import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type ButtonHTMLAttributes, type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent, type ReactNode,
} from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { BASE_PLUGIN_BY_ID, BASE_PLUGIN_CATALOG } from '../base-plugins.ts'
import {
  LUMO_THEME_EVENT,
  LUMO_THEME_OPTIONS,
  installLumoThemes,
  isLumoTheme,
  readLumoTheme,
  requestLumoTheme,
  type LumoThemeId,
} from './themes.ts'
import './lumo.css'

// Keep this UI package independently typecheckable. The running DSH shell
// declares the same seats; importing its client entry here would pull the
// entire conversation source project into this package's isolated compiler.
interface ComposerInputOwner {
  readonly session: unknown
  readonly input: unknown
}

interface HeroComposerOwner {}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'conversation.input.left': { kind: 'list'; scope: 'session'; owner: ComposerInputOwner }
    'conversation.composer.dock': { kind: 'list'; scope: 'session'; owner: ComposerInputOwner }
    'conversation.hero.input.left': { kind: 'list'; scope: 'root'; owner: HeroComposerOwner }
    'conversation.hero.composer.dock': { kind: 'list'; scope: 'root'; owner: HeroComposerOwner }
  }
}

type Surface = 'knowledge' | 'skills' | 'connectors' | 'operations' | 'account' | 'market'
type OverlayProps = PropsRuntime<'shell.overlay'>
type SidebarProps = PropsRuntime<'sidebar.footer.action'>
type ComposerScopeProps = PropsRuntime<'conversation.input.left'>
type ComposerDockProps = PropsRuntime<'conversation.composer.dock'>
type HeroComposerScopeProps = PropsRuntime<'conversation.hero.input.left'>
type HeroComposerDockProps = PropsRuntime<'conversation.hero.composer.dock'>

interface ServiceState { ok: boolean; status: number; error?: string }
interface NodeState { node_id?: string; cluster_id?: string; capacity?: number; residency?: string }
interface DeploymentState { mode: 'local' | 'standalone' | 'cluster'; label: string; storage: 'sqlite' | 'postgres'; middleware: string[]; distributed: boolean; desktop: boolean; clusterReady: boolean; clusterOnly: boolean }
interface Operation { name?: string; method?: string; write?: boolean; sensitivity?: string }
interface Row { id?: string; name?: string; status?: string; realm?: string; version?: number; protocol?: string; operations?: Operation[]; projectId?: string; visibility?: string; author?: string; triggerKind?: string; triggerSpec?: string; flowRef?: string; enabled?: boolean; reviewComment?: string }
interface Automation { automationId: string; projectId: string; triggerKind: string; triggerSpec: string; flowRef: string; enabled: boolean }
interface Placement { task_id?: string; realm?: string; node_id?: string; attempt?: number; state?: string; fencing_token?: number }
interface DelegationCandidate { user_id: string; worker_id: string; worker_kind?: 'human' | 'agent'; agent_ref?: string; display_name: string; department_id?: string; tags: string[]; skills: string[]; matched_tags: string[]; matched_skills: string[]; score: number; confidence_band?: 'AUTO' | 'SUGGESTED' | 'MANUAL'; score_breakdown?: Record<string, unknown>; score_weights?: Record<string, number>; active_tasks: number; eligible: boolean; rationale: string[] }
interface DelegationPreview { title?: string; intent: string; project_id?: string; required_tags: string[]; required_skills: string[]; intent_terms: string[]; inferred_tags: string[]; inferred_skills: string[]; candidates: DelegationCandidate[] }
interface DelegatedTask { id: string; title: string; intent: string; project_id?: string; requester_user_id: string; assignee_user_id: string; assignee_worker_id?: string; worker_id?: string; worker_kind?: 'human' | 'agent'; assignee_name?: string; business_state?: string; confidence_band?: 'AUTO' | 'SUGGESTED' | 'MANUAL'; state: string; match_score: number; selected_skills: string[]; scheduler_task_id?: string; assigned_node_id?: string; last_error?: string; created_at: string; updated_at: string }
interface DelegationCreated { task?: DelegatedTask; run?: { id: string; state: string; worker_id: string; attempt: number }; id?: string; title?: string; state?: string }
type AssignmentMode = 'auto' | 'manual'
interface DirectoryUser { id: string; display_name: string; primary_dept_id?: string; status?: string }
interface Plugin { id: string; label: string; description: string; surface: Surface; kind: 'runtime' | 'governance' }
interface Overview {
  generatedAt: string
  deployment: DeploymentState
  services: Record<string, ServiceState>
  cluster: { leader?: { holder?: string }; nodes: NodeState[] }
  projects: Row[]
  flows: Row[]
  connectors: Row[]
  plugins: Plugin[]
}
interface Dashboard { project?: Row; yourRole?: string; members?: unknown[]; artifacts?: unknown[]; spaces?: unknown[]; automations?: Automation[]; usage?: unknown[]; budget?: { amount?: number; remaining?: number } }
interface ProbeResult { status?: number; url?: string; durationMs?: number; redacted?: boolean; contentType?: string; body?: unknown; headers?: Record<string, string>; encoding?: string }
interface KnowledgeHit { docId: string; sourceVersion: number; score: number; text: string }
interface KnowledgeResult { query: string; scope: 'published'; hits: KnowledgeHit[] }
interface RuntimeSkill { name: string; description: string; whenToUse?: string; invocation: { modelInvocable: boolean; userInvocable: boolean }; source: string; provider: string }
interface SkillSnapshot { complete: boolean; skills: RuntimeSkill[] }
interface GovernedSkill { id: string; realm: string; name: string; kind: 'prompt' | 'workflow' | 'tool' | 'connector'; visibility: string; current_version: string; created_by: string }
interface UpstreamResult { ok: boolean; status: number; data?: unknown; error?: string }
interface StudioSpace { id: string; label: string; description: string; accent: string }
interface StudioProject { id: string; label: string; summary: string; spaces: StudioSpace[] }
interface StudioScope { projectId: string; spaceId: string }
interface GovernanceSnapshot { features: UpstreamResult; departments: UpstreamResult; roles: UpstreamResult; catalog: UpstreamResult; effective: UpstreamResult }
type AuthAccount = {
  mode: 'session'; provider: 'lumo-governance'; username: string; displayName: string; userId: string
  realm: string; roles: string[]; department: string; clientIp: string; captchaMode: 'always'
}

const emptyOverview: Overview = { generatedAt: '', deployment: { mode: 'standalone', label: '服务器单例', storage: 'postgres', middleware: [], distributed: false, desktop: false, clusterReady: false, clusterOnly: false }, services: {}, cluster: { nodes: [] }, projects: [], flows: [], connectors: [], plugins: [] }
const surfaceMeta: Record<Surface, { label: string; eyebrow: string; description: string; short: string }> = {
  operations: { label: '运营管理', eyebrow: '运营工作台', description: '项目、流程、节点和治理状态集中在一个工作区。', short: '总览' },
  knowledge: { label: '知识库', eyebrow: '知识连接', description: '检索已发布知识，保留来源、版本与相关度。', short: '知识' },
  skills: { label: '专家技能', eyebrow: '技能目录', description: '查看可调用技能，并进入治理目录创建受控能力。', short: '技能' },
  connectors: { label: '连接器', eyebrow: '连接器网关', description: '检查能力清单、调用协议与受控 Web 出站。', short: '连接' },
  account: { label: '用户中心', eyebrow: '身份与安全', description: '查看治理用户身份、安全策略与当前会话。', short: '账户' },
  market: { label: '插件市场', eyebrow: '基础插件中心', description: '查看已随桌面本地运行时装配的能力，并打开对应功能。', short: '市场' },
}
const surfaces = Object.keys(surfaceMeta) as Surface[]
const surfaceGroups: Array<{ label: string; items: Surface[] }> = [
  { label: '工作区', items: ['operations', 'knowledge', 'skills', 'connectors', 'market'] },
  { label: '控制中心', items: ['account'] },
]
const OPEN_EVENT = 'lumo:open-workbench'
const skillNameLabels: Record<string, string> = {
  'open-design': '开放设计',
  '@lumo/open-design': '开放设计',
  archify: '架构与调度图',
  '@lumo/archify': '架构与调度图',
  'gpt-image-2-style-library': '图像风格库',
  'ppt-master': '演示文稿生成',
  'ruflo-orchestration': '多智能体编排',
  'dsh-market': '插件市场',
  dshmarket: '插件市场',
  modlens: '视觉理解',
  '@liustack/modlens': '视觉理解',
  'dsh-browser': '浏览器自动化',
  '@anweat/dsh-browser': '浏览器自动化',
  'dsh-context': '上下文洞察',
  'dsh-cost-meter': '费用统计',
}
const skillProviderLabels: Record<string, string> = {
  'lumo-open-design': 'Lumo 内置',
  'lumo-archify': 'Lumo 内置',
  'lumo-creative-skills': 'Lumo 创作能力',
  'lumo-ruflo': 'Lumo 编排能力',
  'lumo-local-snapshot': '本地技能快照',
  '@lumo/open-design': 'Lumo 内置',
  '@lumo/archify': 'Lumo 内置',
  dshmarket: '插件市场',
  '@liustack/modlens': '视觉理解',
  '@anweat/dsh-browser': '浏览器自动化',
  'dsh-context': '上下文洞察',
  'dsh-cost-meter': '费用统计',
}

function localizedSkillName(name: string): string {
  const normalized = name.toLowerCase()
  if (normalized.includes('open-design')) return '开放设计'
  if (normalized.includes('archify')) return '架构与调度图'
  if (normalized.includes('gpt-image-2') || normalized.includes('style-library')) return '图像风格库'
  if (normalized.includes('ppt-master')) return '演示文稿生成'
  if (normalized.includes('ruflo')) return '多智能体编排'
  if (normalized.includes('modlens')) return '视觉理解'
  if (normalized.includes('browser')) return '浏览器自动化'
  if (normalized.includes('context')) return '上下文洞察'
  if (normalized.includes('cost-meter') || normalized.includes('costmeter')) return '费用统计'
  if (normalized.includes('dshmarket') || normalized.includes('dsh-market')) return '插件市场'
  return skillNameLabels[name] ?? skillNameLabels[name.replace(/^.*\//, '')] ?? '未命名技能'
}

function localizedProvider(provider: string): string {
  const normalized = provider.toLowerCase()
  if (normalized.includes('open-design')) return '开放设计'
  if (normalized.includes('archify')) return '架构图'
  if (normalized.includes('creative-skills')) return 'Lumo 创作能力'
  if (normalized.includes('ruflo')) return 'Lumo 编排能力'
  if (normalized.includes('modlens')) return '视觉理解'
  if (normalized.includes('browser')) return '浏览器自动化'
  if (normalized.includes('context')) return '上下文洞察'
  if (normalized.includes('cost-meter') || normalized.includes('costmeter')) return '费用统计'
  if (normalized.includes('dshmarket') || normalized.includes('dsh-market')) return '插件市场'
  return skillProviderLabels[provider] ?? '已装配插件'
}

function localizedPluginKind(kind: Plugin['kind']): string {
  return kind === 'governance' ? '治理能力' : '运行时能力'
}

function localizedServiceName(name: string): string {
  return ({
    scheduler: '调度服务',
    projects: '项目服务',
    flows: '流程服务',
    connector: '连接器网关',
    governance: '治理服务',
  } as Record<string, string>)[name] ?? '平台服务'
}

function localizedTaskState(state: string): string {
  return ({
    DRAFT: '草稿', ROUTING: '路由中', ASSIGNED: '已分派', EXECUTING: '执行中',
    VERIFYING: '核验中', IN_REVIEW: '待审核', DONE: '已完成', REJECTED: '已驳回', ARCHIVED: '已归档',
    QUEUED: '排队中', RUNNING: '运行中', COMPLETED: '运行完成', FAILED: '运行失败',
    CANCELLED: '已取消', BLOCKED: '已阻塞',
  } as Record<string, string>)[state] ?? state
}

function localizedSource(source: string): string {
  if (source === 'bundled') return '随应用内置'
  if (source === 'custom') return '本地快照'
  if (source === 'remote') return '远程插件'
  if (source === 'community') return '社区插件'
  return '已装配插件'
}

function localizedSkillKind(kind: string): string {
  return ({ prompt: '提示词', workflow: '工作流', tool: '工具', connector: '连接器' } as Record<string, string>)[kind] ?? '其他能力'
}

function localizedVisibility(visibility: string): string {
  return ({ private: '私有', public: '公开', internal: '内部' } as Record<string, string>)[visibility] ?? '未分类'
}

function localizedSkillDescription(skill: Pick<RuntimeSkill, 'name' | 'description'>): string {
  const name = skill.name.toLowerCase()
  if (name.includes('dshmarket') || name.includes('dsh-market')) return '浏览、搜索、安装和更新 DSH 社区插件。'
  if (name.includes('modlens')) return '读取图片、截图和附件，提供 OCR 与视觉证据。'
  if (name.includes('browser')) return '通过 Playwright 和 OpenCLI 打开页面、点击、输入、滚动、读取和截图。'
  if (name.includes('context')) return '查看当前会话上下文组成、趋势、事件和消息。'
  if (name.includes('cost-meter') || name.includes('costmeter')) return '统计会话、当日与历史费用，支持预算和模型价格。'
  if (name.includes('gpt-image-2') || name.includes('style-library')) return '从固定版本风格库选择图片模板、风格标签和提示词结构。'
  if (name.includes('ppt-master')) return '从主题、文档或模板生成、编辑和增强原生可编辑 PPTX。'
  if (name.includes('ruflo')) return '在 Lumo 任务运行边界内组织多智能体拓扑、分工、复核和回收。'
  return /[\u4e00-\u9fff]/u.test(skill.description) ? skill.description : '由已装配插件提供的运行时能力。'
}

function localizedSkillWhenToUse(skill: Pick<RuntimeSkill, 'name' | 'whenToUse'>): string {
  const name = skill.name.toLowerCase()
  if (name.includes('dshmarket') || name.includes('dsh-market')) return '用于发现、安装和管理 DSH 插件。'
  if (name.includes('modlens')) return '用于图片理解、截图分析和 OCR。'
  if (name.includes('browser')) return '用于网页访问、交互操作和页面证据采集。'
  if (name.includes('context')) return '用于查看上下文预算、组成与注入事件。'
  if (name.includes('cost-meter') || name.includes('costmeter')) return '用于费用、预算、价格和用量分析。'
  if (name.includes('gpt-image-2') || name.includes('style-library')) return '用于海报、UI、信息图、品牌视觉和系列图片提示词。'
  if (name.includes('ppt-master')) return '用于演示文稿生成、模板填充、PPT 美化、动画和旁白。'
  if (name.includes('ruflo')) return '用于复杂任务的多智能体并行、复核、分阶段交付和失败重派。'
  return skill.whenToUse && /[\u4e00-\u9fff]/u.test(skill.whenToUse) ? skill.whenToUse : '可在当前工作区按策略调用。'
}

const studioProjects: StudioProject[] = [
  {
    id: 'lumo-desktop', label: 'Lumo Desktop', summary: '本地优先的 AI 工作台', spaces: [
      { id: 'product', label: '产品设计', description: '交互、信息架构与体验语言', accent: '#f49a58' },
      { id: 'build', label: '桌面构建', description: '打包、运行时与交付验证', accent: '#65c9bb' },
      { id: 'research', label: '体验研究', description: '场景、反馈与设计证据', accent: '#8ba8ee' },
    ],
  },
  {
    id: 'growth-lab', label: '增长实验室', summary: '从机会到可测量的落地页', spaces: [
      { id: 'launch', label: '发布策略', description: '活动页与内容节奏', accent: '#edc56f' },
      { id: 'campaign', label: '创意活动', description: '视觉主张与投放物料', accent: '#df83a6' },
    ],
  },
  {
    id: 'ops-archive', label: '运营资料库', summary: '跨团队流程与可复用资产', spaces: [
      { id: 'playbooks', label: '工作手册', description: '标准流程与操作说明', accent: '#a7b5c8' },
      { id: 'automation', label: '自动化', description: '任务流与执行检查点', accent: '#73b4ec' },
    ],
  },
]

let studioScope: StudioScope = { projectId: 'lumo-desktop', spaceId: 'product' }
const studioScopeListeners = new Set<() => void>()

function projectFor(scope: StudioScope): StudioProject {
  return studioProjects.find(project => project.id === scope.projectId) ?? studioProjects[0]!
}

function spaceFor(scope: StudioScope): StudioSpace {
  const project = projectFor(scope)
  return project.spaces.find(space => space.id === scope.spaceId) ?? project.spaces[0]!
}

function updateStudioScope(next: StudioScope): void {
  const project = projectFor(next)
  const space = project.spaces.find(item => item.id === next.spaceId) ?? project.spaces[0]!
  if (studioScope.projectId === project.id && studioScope.spaceId === space.id) return
  studioScope = { projectId: project.id, spaceId: space.id }
  studioScopeListeners.forEach(listener => listener())
}

function useStudioScope(): { project: StudioProject; space: StudioSpace } {
  const scope = useSyncExternalStore(
    listener => {
      studioScopeListeners.add(listener)
      return () => { studioScopeListeners.delete(listener) }
    },
    () => studioScope,
    () => studioScope,
  )
  return { project: projectFor(scope), space: spaceFor(scope) }
}

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const value = (body as { error?: unknown; message?: unknown }).error ?? (body as { message?: unknown }).message
    if (typeof value === 'string' && value !== '') return value
  }
  return fallback
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body: unknown = null
  try { body = text === '' ? null : JSON.parse(text) } catch { body = text }
  if (!response.ok) throw new Error(errorMessage(body, `请求失败 (${response.status})`))
  return body as T
}

async function optionalApi<T>(path: string, fallback: T): Promise<T> {
  try { return await api<T>(path) } catch { return fallback }
}

function querySurface(): Surface | null {
  const value = new URLSearchParams(location.search).get('lumo')
  if (value === 'ops') return 'operations'
  return surfaces.includes(value as Surface) ? value as Surface : null
}

function setQuerySurface(surface: Surface | null): void {
  const url = new URL(location.href)
  if (surface === null) url.searchParams.delete('lumo')
  else url.searchParams.set('lumo', surface)
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

function openSurface(surface: Surface): void {
  window.dispatchEvent(new CustomEvent<Surface>(OPEN_EVENT, { detail: surface }))
}

function Glyph({ surface }: { surface: Surface }) {
  const paths: Record<Surface, ReactNode> = {
    knowledge: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v14H6.5A2.5 2.5 0 0 0 4 19.5z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v14h4.5a2.5 2.5 0 0 1 2.5 2.5z" /></>,
    skills: <><path d="m12 3 1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5z" /><path d="m18.5 15 .75 2.25L21.5 18l-2.25.75L18.5 21l-.75-2.25L15.5 18z" /></>,
    connectors: <><path d="M8 7V4M16 7V4M6 7h12v4a6 6 0 0 1-12 0z" /><path d="M12 17v4" /></>,
    operations: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="8" cy="6" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="10" cy="18" r="2" /></>,
    account: <><circle cx="12" cy="8" r="4" /><path d="M4.5 21a7.5 7.5 0 0 1 15 0" /></>,
    market: <><path d="M4 7.5 12 3l8 4.5v9L12 21l-8-4.5z" /><path d="m8 9 4 2.25L16 9M12 11.25V17" /></>,
  }
  return <svg className="lumo-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>{paths[surface]}</svg>
}

function SidebarEntry({ wide, surface }: SidebarProps & { surface: Surface }) {
  return <button type="button" className="lumo-sidebar-entry" title="打开 Lumo 工作区" aria-label="打开 Lumo 工作区" onClick={() => openSurface(surface)}><span className="lumo-sidebar-orb"><Glyph surface={surface} /></span>{wide ? <span><b>Lumo 工作区</b><small>市场 · 知识 · 技能 · 连接器</small></span> : null}<i /></button>
}

function ComposerScopeControl(_props: ComposerScopeProps) {
  const { project, space } = useStudioScope()
  const [menu, setMenu] = useState<'project' | 'space' | null>(null)
  const chooseProject = (next: StudioProject) => {
    updateStudioScope({ projectId: next.id, spaceId: next.spaces[0]!.id })
    setMenu(null)
  }
  const chooseSpace = (next: StudioSpace) => {
    updateStudioScope({ projectId: project.id, spaceId: next.id })
    setMenu(null)
  }
  return <div className="lumo-composer-scope">
    <button type="button" className="lumo-scope-chip" aria-label={`选择项目：${project.label}`} aria-haspopup="dialog" aria-expanded={menu === 'project'} onClick={() => setMenu(value => value === 'project' ? null : 'project')}><span className="lumo-scope-icon">⌘</span><span>项目</span><b>{project.label}</b><i>⌄</i></button>
    <button type="button" className="lumo-scope-chip space" aria-label={`选择空间：${space.label}`} aria-haspopup="dialog" aria-expanded={menu === 'space'} onClick={() => setMenu(value => value === 'space' ? null : 'space')}><span className="lumo-scope-dot" style={{ background: space.accent }} /><span>空间</span><b>{space.label}</b><i>⌄</i></button>
    {menu === 'project' ? <div className="lumo-scope-popover" role="dialog" aria-label="项目列表"><header><span>项目</span><small>选择后会同步创作空间</small></header>{studioProjects.map(item => <button type="button" key={item.id} className={item.id === project.id ? 'selected' : ''} onClick={() => chooseProject(item)}><span className="lumo-project-glyph">{item.label.slice(0, 1)}</span><span><b>{item.label}</b><small>{item.summary}</small></span>{item.id === project.id ? <i>当前</i> : null}</button>)}</div> : null}
    {menu === 'space' ? <div className="lumo-scope-popover" role="dialog" aria-label="空间列表"><header><span>{project.label}</span><small>选择任务落点</small></header>{project.spaces.map(item => <button type="button" key={item.id} className={item.id === space.id ? 'selected' : ''} onClick={() => chooseSpace(item)}><span className="lumo-space-glyph" style={{ background: item.accent }} /><span><b>{item.label}</b><small>{item.description}</small></span>{item.id === space.id ? <i>当前</i> : null}</button>)}</div> : null}
  </div>
}

function HeroComposerScopeControl(_props: HeroComposerScopeProps) {
  return <ComposerScopeControl {...(_props as unknown as ComposerScopeProps)} />
}

const designFormats = [
  { id: 'ui', label: '界面原型', icon: '⌘', prompt: '为当前项目建立一个清晰的核心任务界面，先锁定信息层级、状态与主操作。' },
  { id: 'wireframe', label: '线框图', icon: '▦', prompt: '梳理关键流程的低保真线框，标出用户决策点与异常分支。' },
  { id: 'mobile', label: '移动应用', icon: '▯', prompt: '把核心流程压缩为移动端单手可完成的任务路径，并定义反馈状态。' },
  { id: 'deck', label: '演示文稿', icon: '▤', prompt: '把当前主题变成一份可汇报的故事线，先定义开场、证据和结论。' },
] as const

const designExamples = [
  { id: 'focus', kind: '产品落地页', title: 'Lumo 产品控制台', className: 'sunset' },
  { id: 'flow', kind: '工作流', title: '项目控制流程', className: 'blueprint' },
  { id: 'board', kind: '数据看板', title: '创意评审看板', className: 'mosaic' },
] as const

function OpenDesignDock(_props: ComposerDockProps) {
  const { project, space } = useStudioScope()
  const [expanded, setExpanded] = useState(true)
  const [format, setFormat] = useState<(typeof designFormats)[number]['id']>('ui')
  const [brief, setBrief] = useState('')
  const [notice, setNotice] = useState('')
  const active = designFormats.find(item => item.id === format) ?? designFormats[0]
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const intent = brief.trim() || active.prompt
    setNotice(`已为 ${project.label} / ${space.label} 准备 ${active.label}：${intent}`)
  }
  const useExample = (example: (typeof designExamples)[number]) => {
    setBrief(`参考「${example.title}」的结构，为${project.label}的${space.label}制作一个可继续迭代的${active.label}。`)
    setNotice(`已载入 ${example.title} 的创作方向。`)
  }
  return <section className={`lumo-opendesign-dock ${expanded ? 'expanded' : ''}`} aria-label="开放设计嵌入式创作面板">
    <button type="button" className="lumo-opendesign-bar" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}><span className="lumo-opendesign-mark">◢</span><span><b>开放设计</b><small>在当前项目空间内创建可预览的设计产物</small></span><em>{project.label} · {space.label}</em><i>{expanded ? '收起' : '展开'}⌄</i></button>
    {expanded ? <div className="lumo-opendesign-body">
      <div className="lumo-opendesign-heading"><div><span className="lumo-eyebrow">嵌入式创作面</span><h2>把想法变成可以继续编辑的产物</h2></div><span className="lumo-scope-readout"><i style={{ background: space.accent }} />{project.label}<b>/</b>{space.label}</span></div>
      <div className="lumo-design-format-row" role="tablist" aria-label="开放设计产物类型">{designFormats.map(item => <button type="button" role="tab" aria-label={`选择开放设计类型：${item.label}`} aria-selected={item.id === format} key={item.id} className={item.id === format ? 'active' : ''} onClick={() => { setFormat(item.id); setNotice('') }}><i>{item.icon}</i>{item.label}</button>)}</div>
      <form className="lumo-design-composer" onSubmit={submit}><label><span>创作意图</span><textarea value={brief} onChange={event => setBrief(event.target.value)} placeholder={`${active.prompt} 也可在原生输入框继续补充任务。`} aria-label="开放设计创作意图" rows={3} /></label><div className="lumo-design-composer-footer"><span><i>✦</i> 设计上下文会跟随当前项目与空间</span><button type="submit" aria-label="准备设计意图">准备设计意图 <b>↑</b></button></div></form>
      {notice ? <div className="lumo-design-notice" role="status"><span>✓</span>{notice}<button type="button" aria-label="关闭创作提示" onClick={() => setNotice('')}>×</button></div> : null}
      <div className="lumo-design-example-head"><span>从一个方向开始</span><small>点击示例会填充创作意图</small></div><div className="lumo-design-examples">{designExamples.map(example => <button type="button" key={example.id} className="lumo-design-example" onClick={() => useExample(example)}><span className={`lumo-design-preview ${example.className}`}><i /><i /><i /><b /></span><span><small>{example.kind}</small><b>{example.title}</b></span></button>)}</div>
    </div> : null}
  </section>
}

function HeroOpenDesignDock(_props: HeroComposerDockProps) {
  return <OpenDesignDock {...(_props as unknown as ComposerDockProps)} />
}

function CommandPalette({ open, surface, select, close }: { open: boolean; surface: Surface; select: (surface: Surface) => void; close: () => void }) {
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = surfaces.filter(item => `${surfaceMeta[item].label} ${surfaceMeta[item].eyebrow}`.toLowerCase().includes(query.trim().toLowerCase()))
  useEffect(() => { if (open) setQuery('') }, [open])
  useEffect(() => { setActiveIndex(index => Math.min(index, Math.max(matches.length - 1, 0))) }, [matches.length])
  if (!open) return null
  const choose = (item: Surface | undefined) => { if (item === undefined) return; select(item); close() }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => matches.length ? (index + 1) % matches.length : 0) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => matches.length ? (index - 1 + matches.length) % matches.length : 0) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(matches[activeIndex]) }
  }
  return <div className="lumo-command-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close() }}><section className="lumo-command" role="dialog" aria-modal="true" aria-label="Lumo 工作区菜单"><header><div><span className="lumo-eyebrow">快速跳转</span><b>跳转到工作区</b></div><kbd>ESC</kbd></header><label className="lumo-command-search"><span>⌘</span><input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="搜索知识、技能、连接器、插件市场或运营管理" aria-label="搜索工作区" /></label><div className="lumo-command-list">{matches.length ? matches.map((item, index) => <button type="button" key={item} className={surface === item || activeIndex === index ? 'active' : ''} onClick={() => choose(item)}><Glyph surface={item} /><span><b>{surfaceMeta[item].label}</b><small>{surfaceMeta[item].description}</small></span><kbd>{item === 'operations' ? '⌘ 1' : item === 'knowledge' ? '⌘ 2' : item === 'skills' ? '⌘ 3' : item === 'connectors' ? '⌘ 4' : item === 'market' ? '⌘ 5' : '⌘ 6'}</kbd></button>) : <Empty>没有匹配的工作区。</Empty>}</div><footer><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></footer></section></div>
}

function DeploymentBanner({ deployment }: { deployment: DeploymentState }) {
  const local = deployment.mode === 'local'
  return <section className={`lumo-deployment-banner ${local ? 'local' : deployment.mode}`} aria-label="当前部署形态"><div className="lumo-deployment-mode"><span className="lumo-deployment-signal"><i className="lumo-live-dot" />{local ? '本地模式' : deployment.mode === 'cluster' ? '集群模式' : '单机模式'}</span><b>{deployment.label}</b><small>{deployment.storage === 'sqlite' ? '本机 SQLite' : '服务端 PostgreSQL'}</small></div><div className="lumo-deployment-line"><span>{local ? '本地单机不连接任何分布式中间件' : deployment.mode === 'cluster' ? '集群能力由服务端配置与就绪门禁共同决定' : '服务器单例：服务端组件各一份'}</span>{deployment.middleware.length ? <div className="lumo-middleware-list">{deployment.middleware.map(item => <i key={item}>{item}</i>)}</div> : <strong>无 RocketMQ · 无 Nacos · 无 MinIO · 无 Redis</strong>}</div><span className={`lumo-deployment-gate ${deployment.clusterReady ? 'ready' : ''}`}>{deployment.clusterReady ? '集群已就绪' : deployment.clusterOnly ? '集群未解锁' : local ? '离线优先' : '单机服务'}</span></section>
}

function MagneticButton({ className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  const ref = useRef<HTMLButtonElement>(null)
  const move = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = (event.clientX - rect.left - rect.width / 2) * .11
    const y = (event.clientY - rect.top - rect.height / 2) * .11
    event.currentTarget.style.transform = `translate3d(${x}px,${y}px,0)`
  }
  const reset = () => { if (ref.current !== null) ref.current.style.transform = '' }
  return <button ref={ref} type="button" className={`lumo-button lumo-magnetic ${className}`} onPointerMove={move} onPointerLeave={reset} {...props}>{children}</button>
}

function BusyButton({ busy, className = '', children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <MagneticButton className={className} disabled={busy || props.disabled} {...props}>{busy ? <span className="lumo-spinner" /> : null}{children}</MagneticButton>
}

function SpotlightCard({ className = '', index = 0, children, onClick }: { className?: string; index?: number; children: ReactNode; onClick?: () => void }) {
  const move = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect()
    event.currentTarget.style.setProperty('--spot-x', `${event.clientX - rect.left}px`)
    event.currentTarget.style.setProperty('--spot-y', `${event.clientY - rect.top}px`)
  }
  return <article className={`lumo-spotlight ${className}`} onPointerMove={move} onClick={onClick} style={{ '--lumo-order': String(index) } as CSSProperties}>{children}</article>
}

function ClickSpark({ children }: { children: ReactNode }) {
  const [sparks, setSparks] = useState<Array<{ id: number; x: number; y: number }>>([])
  const spark = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return
    const item = { id: Date.now() + Math.random(), x: event.clientX, y: event.clientY }
    setSparks(previous => [...previous.slice(-5), item])
    window.setTimeout(() => setSparks(previous => previous.filter(value => value.id !== item.id)), 620)
  }
  return <div className="lumo-click-spark" onPointerDown={spark}>{children}{sparks.map(item => <span className="lumo-spark" key={item.id} style={{ left: item.x, top: item.y }}>{Array.from({ length: 8 }, (_, index) => <i key={index} style={{ '--spark-angle': `${index * 45}deg` } as CSSProperties} />)}</span>)}</div>
}

function Section({ title, meta, actions, children, className = '' }: { title: string; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`lumo-section ${className}`}><div className="lumo-section-title"><div><b>{title}</b>{meta === undefined ? null : <span>{meta}</span>}</div>{actions}</div>{children}</section>
}

function Empty({ children }: { children: ReactNode }) { return <p className="lumo-muted lumo-empty">{children}</p> }
function Notice({ error, children, close }: { error?: boolean; children: ReactNode; close?: () => void }) { return <div className={`lumo-alert ${error ? 'error' : 'notice'}`}><span>{children}</span>{close ? <button type="button" onClick={close} aria-label="关闭提示">×</button> : null}</div> }
function countOnline(data: Overview): number { return Object.values(data.services).filter(service => service.ok).length }
function rowsOf<T>(result: UpstreamResult | undefined, key: string): T[] { const data = result?.data; if (typeof data !== 'object' || data === null) return []; const value = (data as Record<string, unknown>)[key]; return Array.isArray(value) ? value as T[] : [] }
function formatSync(value: string): string { return value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '尚未同步' }

function SurfaceIntro({ surface, trailing }: { surface: Surface; trailing?: ReactNode }) {
  const meta = surfaceMeta[surface]
  return <div className="lumo-surface-intro"><div><span className="lumo-eyebrow">{meta.eyebrow}</span><h1>{meta.label}</h1><p>{meta.description}</p></div>{trailing}</div>
}

function Metric({ label, value, note, tone = '' }: { label: string; value: string; note: string; tone?: string }) {
  return <SpotlightCard className={`lumo-metric ${tone}`}><small>{label}</small><strong>{value}</strong><span>{note}</span></SpotlightCard>
}

function KnowledgeSurface() {
  const [result, setResult] = useState<KnowledgeResult | null>(null)
  const [queryText, setQueryText] = useState('')
  const [topK, setTopK] = useState('8')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedHit, setSelectedHit] = useState<KnowledgeHit | null>(null)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const text = queryText.trim()
    if (!text) { setError('先输入要检索的问题。'); return }
    setBusy(true); setError(''); setSelectedHit(null)
    try { setResult(await api('/lumo/api/knowledge/query', { method: 'POST', body: JSON.stringify({ text, topK: Number(topK) }) })) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const useExample = (text: string) => { setQueryText(text); setError('') }
  return <div className="lumo-surface lumo-knowledge-surface">
    <SurfaceIntro surface="knowledge" trailing={<div className="lumo-scope-card"><span>检索范围</span><b>已发布知识</b><small>按 realm / 角色校验</small></div>} />
    <div className="lumo-context-strip"><span><i className="lumo-live-dot" /> 当前身份可见</span><span>语义召回</span><span>来源可追溯</span><span className="lumo-context-end">查询不会改变知识内容</span></div>
    <Section title="向知识空间提问" meta="只读查询 · 最多 20 个来源"><div className="lumo-search-layout"><form className="lumo-search-form" onSubmit={submit}><label><span>问题</span><textarea name="text" aria-label="向知识空间提问" value={queryText} maxLength={2000} rows={4} placeholder="例如：生产环境连接器的审批边界是什么？" onChange={event => setQueryText(event.target.value)} /></label><div className="lumo-search-controls"><label className="lumo-compact-field"><span>召回数</span><select name="topK" value={topK} onChange={event => setTopK(event.target.value)}><option value="5">5</option><option value="8">8</option><option value="12">12</option><option value="20">20</option></select></label><BusyButton type="submit" busy={busy} className="lumo-primary">检索知识</BusyButton></div></form><div className="lumo-example-queries"><span>可以从这些问题开始</span><button type="button" onClick={() => useExample('生产环境连接器的审批边界是什么？')}>连接器审批边界</button><button type="button" onClick={() => useExample('哪些角色可以发布工作流？')}>工作流发布角色</button><button type="button" onClick={() => useExample('如何处理跨 realm 的知识访问？')}>跨 realm 访问</button></div></div></Section>
    {error ? <Notice error>{error}</Notice> : null}
    <Section title="检索结果" meta={result === null ? '等待查询' : `${result.hits.length} 个来源片段`} actions={result ? <span className="lumo-query-summary">“{result.query}”</span> : null}>
      {busy ? <div className="lumo-hit-list">{[0, 1, 2].map(index => <div className="lumo-skeleton-hit" key={index}><span /><b /><i /></div>)}</div> : result === null ? <div className="lumo-hero-empty"><Glyph surface="knowledge" /><b>知识结果会在这里展开</b><p>查询会带入当前会话 realm 与角色，只读已发布知识，并保留 docId、源版本和相关度。</p></div> : result.hits.length === 0 ? <Empty>没有命中可见的已发布知识。可以调整问题表达后重试。</Empty> : <div className="lumo-result-layout"><div className="lumo-hit-list">{result.hits.map((hit, index) => <SpotlightCard className={`lumo-hit ${selectedHit?.docId === hit.docId && selectedHit.sourceVersion === hit.sourceVersion ? 'selected' : ''}`} index={index} key={`${hit.docId}-${hit.sourceVersion}-${index}`} onClick={() => setSelectedHit(hit)}><div className="lumo-hit-meta"><span>{hit.docId} · v{hit.sourceVersion}</span><b>{Math.round(hit.score * 100)}%</b></div><p>{hit.text}</p><footer><span>来源版本 {hit.sourceVersion}</span><span>查看来源详情 ↗</span></footer></SpotlightCard>)}</div><aside className="lumo-inspector">{selectedHit ? <><span className="lumo-inspector-label">来源检查</span><h3>{selectedHit.docId}</h3><p>该片段来自已发布知识版本 {selectedHit.sourceVersion}，当前相关度为 {Math.round(selectedHit.score * 100)}%。</p><div className="lumo-detail-stack"><div><span>来源 ID</span><b>{selectedHit.docId}</b></div><div><span>源版本</span><b>v{selectedHit.sourceVersion}</b></div><div><span>相关度</span><b>{Math.round(selectedHit.score * 100)}%</b></div></div></> : <div className="lumo-inspector-empty"><span>选择一个来源片段</span><p>右侧会展示该片段的版本和相关度信息。</p></div>}</aside></div>}
    </Section>
  </div>
}

function SkillsSurface() {
  const [runtime, setRuntime] = useState<SkillSnapshot | null>(null)
  const [governance, setGovernance] = useState<GovernanceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedName, setSelectedName] = useState('')
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [runtimeData, governanceData] = await Promise.all([api<SkillSnapshot>('/lumo/api/skills'), api<GovernanceSnapshot>('/lumo/api/governance')])
      setRuntime(runtimeData); setGovernance(governanceData)
      setSelectedName(current => current || runtimeData.skills[0]?.name || '')
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const name = String(fields.get('name') ?? '').trim()
    const kind = String(fields.get('kind') ?? 'prompt')
    if (!name) { setNotice('请输入技能名称。'); return }
    setCreating(true)
    try {
      await api<GovernedSkill>('/lumo/api/governance/skills', { method: 'POST', body: JSON.stringify({ name, kind, visibility: 'private' }) })
      form.reset(); setNotice(`私有${kind === 'workflow' ? '工作流' : '提示词'}技能「${name}」已进入治理目录。`); await load()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setCreating(false) }
  }
  const governed = rowsOf<GovernedSkill>(governance?.catalog, 'skills')
  const effective = rowsOf<GovernedSkill>(governance?.effective, 'skills')
  const skills = runtime?.skills ?? []
  const filteredSkills = useMemo(() => skills.filter(skill => `${localizedSkillName(skill.name)} ${localizedSkillDescription(skill)} ${localizedProvider(skill.provider)}`.toLowerCase().includes(filter.toLowerCase())), [filter, skills])
  const selected = skills.find(skill => skill.name === selectedName) ?? filteredSkills[0]
  return <div className="lumo-surface">
    <SurfaceIntro surface="skills" trailing={<BusyButton className="lumo-secondary" busy={loading} onClick={() => void load()}>重新同步</BusyButton>} />
    {error ? <Notice error>{error}</Notice> : null}{notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}
    <div className="lumo-metric-grid"><Metric label="运行时可见" value={String(skills.length)} note={runtime?.complete === false ? '目录仍在收敛' : '目录已完整'} tone="mint" /><Metric label="治理目录" value={String(governed.length)} note={governance?.catalog.ok ? '集群目录' : '当前模式不可用'} /><Metric label="模型可调用" value={String(skills.filter(skill => skill.invocation.modelInvocable).length)} note="调用策略" /><Metric label="当前生效" value={String(effective.length)} note="生效策略" /></div>
    <Section title="运行时技能" meta={loading ? '正在读取技能目录' : '当前运行时快照'} actions={<label className="lumo-filter"><span>筛选</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="技能名或提供方" /></label>}>
      {loading ? <div className="lumo-skill-grid">{[0, 1, 2, 3].map(index => <div className="lumo-skeleton-skill" key={index}><span /><div><b /><i /><i /></div></div>)}</div> : filteredSkills.length ? <div className="lumo-skill-layout"><div className="lumo-skill-grid">{filteredSkills.map((skill, index) => <SpotlightCard className={`lumo-skill-card ${selected?.name === skill.name ? 'selected' : ''}`} index={index} key={skill.name} onClick={() => setSelectedName(skill.name)}><span className="lumo-skill-mark">{localizedSkillName(skill.name).slice(0, 1)}</span><div><b>{localizedSkillName(skill.name)}</b><p>{localizedSkillDescription(skill)}</p><small>{localizedSkillWhenToUse(skill)}</small><footer><i>{localizedProvider(skill.provider)}</i><span>{skill.invocation.modelInvocable ? '模型可调用' : '仅用户可调用'}</span></footer></div></SpotlightCard>)}</div><aside className="lumo-inspector lumo-skill-inspector">{selected ? <><span className="lumo-inspector-label">技能检查</span><h3>技能详情 · {localizedSkillName(selected.name)}</h3><p>{localizedSkillDescription(selected)}</p><div className="lumo-detail-stack"><div><span>技能状态</span><b>运行时目录</b></div><div><span>来源</span><b>{localizedSource(selected.source)}</b></div><div><span>提供方</span><b>{localizedProvider(selected.provider)}</b></div><div><span>用户可调用</span><b>{selected.invocation.userInvocable ? '允许' : '关闭'}</b></div><div><span>模型可调用</span><b>{selected.invocation.modelInvocable ? '允许' : '关闭'}</b></div></div></> : <Empty>选择技能查看详细策略。</Empty>}</aside></div> : <Empty>当前技能目录没有匹配项。</Empty>}
    </Section>
    <Section title="创建受控专家能力" meta="私有 prompt / workflow 可直接进入治理目录"><form className="lumo-governance-form" onSubmit={create}><label><span>技能名称</span><input name="name" maxLength={120} placeholder="例如：campaign-review" /></label><label><span>能力类型</span><select name="kind" defaultValue="prompt"><option value="prompt">提示词技能</option><option value="workflow">工作流技能</option></select></label><BusyButton type="submit" busy={creating} className="lumo-primary">写入治理目录</BusyButton></form><p className="lumo-form-hint">Tool / Connector 或非私有发布仍由治理插件执行 realm_admin 闸门。</p></Section>
    <Section title="治理技能目录" meta={governance?.catalog.ok ? `${governed.length} 条` : `HTTP ${governance?.catalog.status ?? '未连接'}`}>
      {governed.length ? <div className="lumo-table-list">{governed.map(skill => <div key={skill.id}><span><b>{localizedSkillName(skill.name)}</b><small>{skill.id} · 创建者 {skill.created_by}</small></span><i>{localizedSkillKind(skill.kind)}</i><em>{localizedVisibility(skill.visibility)} · {skill.current_version}</em></div>)}</div> : <Empty>{governance?.catalog.error || '当前部署模式没有治理技能目录，运行时技能目录仍可独立使用。'}</Empty>}
    </Section>
  </div>
}

function MarketSurface() {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState('全部')
  const [selectedId, setSelectedId] = useState(BASE_PLUGIN_CATALOG[0]?.id ?? 'dshmarket')
  const [notice, setNotice] = useState('')
  const categories = ['全部', ...Array.from(new Set(BASE_PLUGIN_CATALOG.map(plugin => plugin.category)))]
  const filtered = BASE_PLUGIN_CATALOG.filter(plugin => {
    const matchesCategory = category === '全部' || plugin.category === category
    const searchable = `${plugin.label} ${plugin.id} ${plugin.packageName} ${plugin.summary} ${plugin.tags.join(' ')}`.toLowerCase()
    return matchesCategory && searchable.includes(query.trim().toLowerCase())
  })
  const selected = BASE_PLUGIN_BY_ID[selectedId] ?? filtered[0] ?? BASE_PLUGIN_CATALOG[0]
  const bundledByLumo = selected?.packageName.startsWith('@lumo/') ?? false
  const installCommand = selected === undefined
    ? ''
    : bundledByLumo
      ? '已随 Lumo 运行时安装，无需单独执行命令'
      : `dsh plugin --profile web add ${selected.packageName}@${selected.version}`
  const copyCommand = async () => {
    if (!installCommand || bundledByLumo) return
    try {
      await navigator.clipboard.writeText(installCommand)
      setNotice('安装命令已复制。桌面版已预装这些基础插件，无需再次安装。')
    } catch {
      setNotice(installCommand)
    }
  }
  return <div className="lumo-surface lumo-market-surface">
    <SurfaceIntro surface="market" trailing={<div className="lumo-market-status"><i className="lumo-live-dot" /><span>基础插件已装配</span><small>离线可见 · 版本已固定</small></div>} />
    <div className="lumo-context-strip"><span><i className="lumo-live-dot" /> 桌面本地运行时随包提供</span><span>5 个基础插件 · 5 个创作与编排能力</span><span>上游功能可追溯</span><span className="lumo-context-end">点击卡片查看能力入口</span></div>
    {notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}
    <Section title="基础插件" meta={`${filtered.length} / ${BASE_PLUGIN_CATALOG.length} 个能力`} actions={<label className="lumo-filter"><span>搜索</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="插件名称、功能或标签" /></label>}>
      <div className="lumo-market-category-row" role="tablist" aria-label="插件分类">{categories.map(item => <button type="button" role="tab" aria-selected={category === item} className={category === item ? 'active' : ''} key={item} onClick={() => setCategory(item)}>{item}</button>)}</div>
      {filtered.length ? <div className="lumo-market-layout"><div className="lumo-market-grid">{filtered.map((plugin, index) => <button type="button" className={`lumo-market-card ${selected?.id === plugin.id ? 'selected' : ''}`} style={{ '--market-accent': plugin.accent, '--lumo-order': String(index) } as CSSProperties} key={plugin.id} onClick={() => setSelectedId(plugin.id)}><span className="lumo-market-mark">{plugin.label.slice(0, 1)}</span><span className="lumo-market-card-main"><span className="lumo-market-card-head"><b>{plugin.label}</b><i>已内置</i></span><small>{plugin.packageName} · v{plugin.version}</small><p>{plugin.summary}</p><span className="lumo-market-tags">{plugin.tags.map(tag => <em key={tag}>{tag}</em>)}</span></span><span className="lumo-market-arrow">↗</span></button>)}</div><aside className="lumo-market-inspector">{selected ? <><span className="lumo-inspector-label">插件详情</span><div className="lumo-market-detail-title"><span className="lumo-market-mark" style={{ background: selected.accent }}>{selected.label.slice(0, 1)}</span><div><h3>{selected.label}</h3><small>{selected.packageName} · v{selected.version}</small></div></div><p>{selected.summary}</p><div className="lumo-detail-stack"><div><span>能力入口</span><b>{selected.capability}</b></div><div><span>分类</span><b>{selected.category}</b></div><div><span>装配状态</span><b className="lumo-ready-text">桌面基础插件</b></div><div><span>许可证</span><b>{selected.license}</b></div></div><div className="lumo-market-actions"><button type="button" className="lumo-button lumo-primary" disabled={bundledByLumo} onClick={() => void copyCommand()}>{bundledByLumo ? '已随运行时安装' : '复制安装命令'}</button><a className="lumo-button" href={selected.repository} target="_blank" rel="noreferrer">查看上游仓库 ↗</a></div><code className="lumo-market-command">{installCommand}</code></> : <Empty>没有匹配的基础插件。</Empty>}</aside></div> : <Empty>没有匹配的基础插件。</Empty>}
    </Section>
    <Section title="装配说明" meta="桌面版启动时直接读取本地运行时"><div className="lumo-market-note-grid"><div><span>本地优先</span><b>首次打开不再执行插件下载</b><small>构建阶段已把插件包和生产依赖放进 Lumo.app，配置只建立本地链接。</small></div><div><span>可追溯</span><b>每张卡片保留上游仓库</b><small>插件的包名、版本、许可证与能力入口都在这里显示，方便升级和审计。</small></div><div><span>中文界面</span><b>产品文案统一使用中文</b><small>技术包名保留在次要信息位，避免把可读的功能名直接显示成英文。</small></div></div></Section>
  </div>
}

function parseOptionalJSON(value: string, label: string): unknown {
  if (!value.trim()) return undefined
  try { return JSON.parse(value) as unknown } catch { throw new Error(`${label}必须是合法 JSON。`) }
}

function parseOptionalObject(value: string, label: string): Record<string, string> | undefined {
  const parsed = parseOptionalJSON(value, label)
  if (parsed === undefined) return undefined
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error(`${label}必须是 JSON 对象。`)
  return Object.fromEntries(Object.entries(parsed).map(([key, item]) => [key, String(item)]))
}

function splitCSV(value: string): string[] {
  return value.split(/[，,\n]/u).map(item => item.trim()).filter(Boolean)
}

function parseSchedulerRequirements(value: string): Array<{ key: string; value: string }> {
  return splitCSV(value).map(item => {
    const [key, ...rest] = item.split('=')
    return { key: key?.trim() ?? '', value: rest.join('=').trim() }
  }).filter(item => item.key !== '')
}

function ConnectorsSurface() {
  const [data, setData] = useState<Overview>(emptyOverview)
  const [loading, setLoading] = useState(true)
  const [probeBusy, setProbeBusy] = useState(false)
  const [invokeBusy, setInvokeBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [invokeResult, setInvokeResult] = useState<ProbeResult | null>(null)
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [invokeOperation, setInvokeOperation] = useState('')
  const [pathParams, setPathParams] = useState('')
  const [queryParams, setQueryParams] = useState('')
  const [invokeBody, setInvokeBody] = useState('')
  const load = useCallback(async () => { setLoading(true); try { const next = await api<Overview>('/lumo/api/overview'); setData(next); setSelectedId(current => current || next.connectors[0]?.id || ''); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  const connectors = useMemo(() => data.connectors.filter(connector => `${connector.name ?? ''} ${connector.id ?? ''} ${connector.protocol ?? ''}`.toLowerCase().includes(filter.toLowerCase())), [data.connectors, filter])
  const selected = data.connectors.find(connector => connector.id === selectedId) ?? connectors[0]
  const operations = selected?.operations ?? []
  useEffect(() => { if (selected && !operations.some(operation => operation.name === invokeOperation)) setInvokeOperation(operations[0]?.name ?? '') }, [invokeOperation, operations, selected])
  const remove = async (connector: Row) => {
    if (!connector.id) return
    try { await api(`/lumo/api/connectors/${encodeURIComponent(connector.id)}`, { method: 'DELETE' }); setConfirm(null); setNotice(`连接器「${connector.name ?? connector.id}」已停用。`); await load() }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
  }
  const invoke = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected?.id || !invokeOperation) { setNotice('请选择一个可调用操作。'); return }
    setInvokeBusy(true); setNotice(''); setInvokeResult(null)
    try {
      const result = await api<ProbeResult>(`/lumo/api/connectors/${encodeURIComponent(selected.id)}/invoke`, { method: 'POST', body: JSON.stringify({ operation: invokeOperation, pathParams: parseOptionalObject(pathParams, '路径参数'), query: parseOptionalObject(queryParams, '查询参数'), body: parseOptionalJSON(invokeBody, '请求体'), correlationId: `lumo-ui-${Date.now()}` }) })
      setInvokeResult(result); setNotice('连接器调用已完成，结果经过网关脱敏。')
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setInvokeBusy(false) }
  }
  const probeWeb = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const url = String(new FormData(event.currentTarget).get('url') ?? '').trim(); if (!url) { setNotice('请输入需要检查的 URL。'); return }
    setProbeBusy(true); setNotice('')
    try { setProbe(await api('/lumo/api/web/fetch', { method: 'POST', body: JSON.stringify({ url }) })); setNotice('Web 出站策略已返回结果。') }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setProbeBusy(false) }
  }
  return <div className="lumo-surface">
    <SurfaceIntro surface="connectors" trailing={<div className="lumo-gateway-status"><i className="lumo-live-dot" /><span>网关已就绪</span></div>} />
    {error ? <Notice error>{error}</Notice> : null}{notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}
    <Section title="连接器目录" meta={`${connectors.length} 个可见能力`} actions={<label className="lumo-filter"><span>搜索</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="连接器名称、协议或 ID" /></label>}>
      {connectors.length ? <div className="lumo-connector-layout"><div className="lumo-connector-grid">{connectors.map((connector, index) => <SpotlightCard className={`lumo-connector-card ${selected?.id === connector.id ? 'selected' : ''}`} index={index} key={connector.id} onClick={() => setSelectedId(connector.id ?? '')}><header><span className="lumo-connector-mark">{(connector.name ?? connector.id ?? 'C').slice(0, 1).toUpperCase()}</span><div><b>{connector.name ?? connector.id}</b><small>{connector.protocol ?? '未知协议'} · {connector.operations?.length ?? 0} 项操作</small></div><i className="lumo-status-dot" /></header><div className="lumo-operation-list">{connector.operations?.slice(0, 5).map(operation => <span key={operation.name}>{operation.method || '调用'} · {operation.name}</span>)}</div><footer><span>{connector.version ? `能力清单 v${connector.version}` : '能力清单已启用'}</span><span>查看能力 ↗</span></footer>{confirm === connector.id ? <div className="lumo-inline-confirm" onClick={event => event.stopPropagation()}><p>停用后运行中的工作流将无法调用它。</p><span><BusyButton onClick={() => setConfirm(null)}>取消</BusyButton><BusyButton className="lumo-danger" onClick={() => void remove(connector)}>确认停用</BusyButton></span></div> : <BusyButton className="lumo-danger lumo-small" onClick={event => { event.stopPropagation(); setConfirm(connector.id ?? null) }}>停用连接器</BusyButton>}</SpotlightCard>)}</div><aside className="lumo-inspector lumo-connector-inspector">{selected ? <><span className="lumo-inspector-label">连接器检查</span><h3>连接器详情 · {selected.name ?? selected.id}</h3><p>所有外部调用都经过网关策略、凭证闸门、限流、熔断和审计。</p><div className="lumo-detail-stack"><div><span>连接器 ID</span><b>{selected.id}</b></div><div><span>协议</span><b>{selected.protocol ?? '未声明'}</b></div><div><span>版本</span><b>{selected.version ?? '未声明'}</b></div><div><span>可用操作</span><b>{selected.operations?.length ?? 0}</b></div></div><div className="lumo-operation-detail"><span>操作面</span>{selected.operations?.length ? selected.operations.map(operation => <div key={operation.name}><b>{operation.name}</b><small>{operation.method || '调用'} · {operation.write ? '写入需审批' : '只读'}</small></div>) : <Empty>该能力清单没有声明操作。</Empty>}</div><form className="lumo-invoke-form" onSubmit={invoke}><label><span>操作</span><select value={invokeOperation} onChange={event => setInvokeOperation(event.target.value)}><option value="" disabled>选择操作</option>{operations.map(operation => <option key={operation.name} value={operation.name}>{operation.name} · {operation.method || '调用'}</option>)}</select></label><label><span>路径参数 JSON</span><textarea rows={2} value={pathParams} onChange={event => setPathParams(event.target.value)} placeholder='{"id":"order-42"}' /></label><label><span>查询参数 JSON</span><textarea rows={2} value={queryParams} onChange={event => setQueryParams(event.target.value)} placeholder='{"limit":"20"}' /></label><label><span>请求体 JSON</span><textarea rows={3} value={invokeBody} onChange={event => setInvokeBody(event.target.value)} placeholder='{"dryRun":true}' /></label><BusyButton type="submit" busy={invokeBusy} className="lumo-primary">受控调用</BusyButton></form>{invokeResult ? <div className="lumo-invoke-result"><div><b>{invokeResult.status ?? '未返回'}</b><span>{invokeResult.contentType ?? '响应'} · {invokeResult.durationMs ?? 0} ms</span></div><small>{invokeResult.redacted ? '响应已按策略脱敏' : '响应未脱敏'}</small><pre>{typeof invokeResult.body === 'string' ? invokeResult.body : JSON.stringify(invokeResult.body ?? {}, null, 2)}</pre></div> : null}</> : <Empty>当前没有可见连接器。</Empty>}</aside></div> : <Empty>{loading ? '正在读取连接器能力清单' : '连接器清单为空；登记成功的能力清单会出现在这里。'}</Empty>}
    </Section>
    <Section title="Web 出站诊断" meta="复用连接器网关的 SSRF / 出站策略"><form className="lumo-inline-form" onSubmit={probeWeb}><label><span>目标 URL</span><input name="url" type="url" placeholder="https://api.example.com/health" /></label><BusyButton type="submit" busy={probeBusy} className="lumo-primary">检查策略</BusyButton></form>{probe ? <div className="lumo-probe-result"><b>{probe.status ?? '未返回'}</b><span>{probe.contentType ?? '响应'} · {probe.durationMs ?? 0} ms</span><small>{probe.redacted ? '响应已按策略脱敏' : probe.url ?? '策略允许访问'}</small></div> : <div className="lumo-diagnostic-empty"><span>输入公网 URL 进行一次受控探测</span><small>私有网络、凭证和未经允许的请求会被网关拒绝。</small></div>}</Section>
  </div>
}

const capabilityGroups = [
  { label: '调度与运营', ids: ['project', 'control', 'metering', 'job-control', 'ruflo-orchestration', 'subagent-local', 'subagent-host', 'subagent-remote'] },
  { label: '数据与内容', ids: ['knowledge', 'attachments', 'object-store', 'storage', 'provenance'] },
  { label: '协作与恢复', ids: ['mailbox', 'session-log', 'recovery'] },
  { label: '连接与出站', ids: ['connector', 'web-gateway'] },
  { label: '技能与治理', ids: ['skill-local', 'open-design', 'archify', 'gpt-image-2-style-library', 'ppt-master'] },
]

function diagramID(value: string): string {
  const normalized = value.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '')
  return normalized || 'item'
}

function archifyTaskTopology(tasks: DelegatedTask[]) {
  const visible = tasks.slice(0, 8)
  const nodes: Array<Record<string, unknown>> = [{ id: 'lumo-control', lane: 'control', col: 0, type: 'security', label: 'Lumo 控制面', sublabel: '任务与权限事实源' }]
  const edges: Array<Record<string, unknown>> = []
  for (const [index, task] of visible.entries()) {
    const taskNode = `task-${diagramID(task.id)}-${index}`
    const workerID = task.assignee_worker_id ?? task.worker_id ?? task.assignee_user_id
    const workerNode = `worker-${diagramID(workerID)}-${index}`
    const executionNode = `node-${diagramID(task.assigned_node_id ?? 'pending')}-${index}`
    nodes.push(
      { id: taskNode, lane: 'task', col: 2, type: 'messagebus', label: task.title.slice(0, 48), sublabel: `${task.id} · ${localizedTaskState(task.business_state ?? task.state)}` },
      { id: workerNode, lane: 'worker', col: 3, type: 'backend', label: task.assignee_name ?? workerID, sublabel: task.selected_skills.join(' / ') || '意图匹配' },
      { id: executionNode, lane: 'runtime', col: 5, type: task.assigned_node_id ? 'cloud' : 'external', label: task.assigned_node_id ?? '等待执行节点', sublabel: task.state },
    )
    edges.push(
      { id: `route-${index}`, from: 'lumo-control', to: taskNode, label: '分发', variant: 'default' },
      { id: `assign-${index}`, from: taskNode, to: workerNode, label: task.selected_skills.includes('ruflo-orchestration') ? 'Ruflo 子群' : '执行', variant: 'emphasis' },
      { id: `place-${index}`, from: workerNode, to: executionNode, label: '放置', variant: task.last_error ? 'security' : 'default' },
    )
  }
  const first = visible[0]
  const mainPath = first ? ['lumo-control', `task-${diagramID(first.id)}-0`, `worker-${diagramID(first.assignee_worker_id ?? first.worker_id ?? first.assignee_user_id)}-0`, `node-${diagramID(first.assigned_node_id ?? 'pending')}-0`] : undefined
  return {
    schema_version: 1, diagram_type: 'workflow',
    meta: { title: 'Lumo 多智能体任务调度', locale: 'zh-CN', quality_profile: 'standard', viewBox: [960, Math.max(420, visible.length * 92 + 180)] },
    lanes: [{ id: 'control', label: '控制面' }, { id: 'task', label: '业务任务' }, { id: 'worker', label: '智能体 / 执行者' }, { id: 'runtime', label: '运行节点' }],
    nodes, edges, ...(mainPath ? { mainPath } : {}),
  }
}

function downloadArchifyTopology(tasks: DelegatedTask[]): void {
  const blob = new Blob([`${JSON.stringify(archifyTaskTopology(tasks), null, 2)}\n`], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = `lumo-agent-topology-${new Date().toISOString().replace(/[:.]/gu, '-')}.workflow.json`
  anchor.click()
  URL.revokeObjectURL(url)
}

function OrchestrationTopology({ tasks, busy, cancel }: { tasks: DelegatedTask[]; busy: string; cancel: (task: DelegatedTask) => Promise<void> }) {
  const visible = tasks.slice(0, 8)
  return <div className="lumo-orchestration" data-archify-diagram="workflow">
    <header><div><span className="lumo-inspector-label">Ruflo 编排 · Archify 视图</span><b>多智能体调度拓扑</b><small>Lumo 保留任务事实；Ruflo 组织运行内子群；Archify 导出可验证视图。</small></div><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={!visible.length} onClick={() => downloadArchifyTopology(visible)}>导出 Archify JSON</button></header>
    <div className="lumo-orchestration-lanes"><span>控制面</span><span>业务任务</span><span>智能体 / 执行者</span><span>运行节点</span><span>控制</span></div>
    {visible.length ? <div className="lumo-orchestration-rows">{visible.map(task => <div className="lumo-orchestration-row" key={task.id}><span className="control"><b>Lumo</b><small>授权 · 调度</small></span><i>→</i><span><b>{task.title}</b><small>{task.id} · {localizedTaskState(task.business_state ?? task.state)}</small></span><i>→</i><span className={task.selected_skills.includes('ruflo-orchestration') ? 'ruflo' : ''}><b>{task.assignee_name ?? task.assignee_worker_id ?? task.assignee_user_id}</b><small>{task.selected_skills.includes('ruflo-orchestration') ? 'Ruflo 子群' : task.selected_skills.join(' / ') || '单执行者'}</small></span><i>→</i><span><b>{task.assigned_node_id ?? '等待节点'}</b><small>{task.last_error || task.state}</small></span>{['ASSIGNED', 'QUEUED', 'RUNNING'].includes(task.state) ? <BusyButton busy={busy === `task-${task.id}`} className="lumo-small lumo-danger" onClick={() => void cancel(task)}>取消</BusyButton> : <em>{localizedTaskState(task.state)}</em>}</div>)}</div> : <Empty>还没有可展示的任务；创建委派后会生成真实任务、执行者和节点拓扑。</Empty>}
  </div>
}

function LocalModePanel({ plugins }: { plugins: Plugin[] }) {
  const capabilities = plugins.filter(plugin => plugin.id !== 'platform-ui')
  return <div className="lumo-local-mode">
    <div className="lumo-local-intro"><span className="lumo-eyebrow">本地优先运行时</span><h2>离线工作台已就绪</h2><p>数据写入本机 SQLite；本模式不连接 PostgreSQL、Redis、MinIO、RocketMQ 或 Nacos。跨用户委派、集群调度和服务端治理请切换到服务器形态。</p></div>
    <div className="lumo-local-grid"><Section title="本机已装配能力" meta={`${capabilities.length} 个本地能力`}><div className="lumo-local-capabilities">{capabilities.length ? capabilities.map(plugin => <button type="button" key={plugin.id} onClick={() => openSurface(plugin.surface)}><span>{plugin.label.slice(0, 1)}</span><div><b>{plugin.label}</b><small>{plugin.description}</small></div><i>本机</i></button>) : <Empty>当前没有额外的本地能力。</Empty>}</div></Section><Section title="服务器能力边界" meta="按形态显式隔离"><div className="lumo-boundary-list"><div><i>01</i><span><b>知识库语义检索</b><small>依赖服务端向量/图引擎，本地不会用 SQLite 冒充。</small></span><em>服务器</em></div><div><i>02</i><span><b>上下游任务协同</b><small>意图、标签、技能和节点负载匹配仅在集群开放。</small></span><em>集群</em></div><div><i>03</i><span><b>连接器与 Web 出站</b><small>凭证、策略、审计和外部网络调用由服务器网关承载。</small></span><em>网关</em></div></div></Section></div>
    <Section title="下一步" meta="保持数据边界清晰"><div className="lumo-local-next"><span><i className="lumo-live-dot" /> 当前是可独立运行的桌面应用</span><b>需要团队协同？启动服务器集群并从这里继续。</b><small>桌面端可以作为上游老板工作台连接 Cluster；本地 SQLite 数据不会自动上传。</small></div></Section>
  </div>
}

function OperationsSurface() {
  const [data, setData] = useState<Overview>(emptyOverview)
  const [governance, setGovernance] = useState<GovernanceSnapshot | null>(null)
  const [delegations, setDelegations] = useState<DelegatedTask[]>([])
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
  const [profileUserID, setProfileUserID] = useState('')
  const [profileTags, setProfileTags] = useState('')
  const [profileNotice, setProfileNotice] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const [delegationPreview, setDelegationPreview] = useState<DelegationPreview | null>(null)
  const [selectedAssignee, setSelectedAssignee] = useState('')
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>('auto')
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [busy, setBusy] = useState('')
  const delegationFormRef = useRef<HTMLFormElement>(null)
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [overview, governed, taskData, directoryData] = await Promise.all([
        api<Overview>('/lumo/api/overview'), api<GovernanceSnapshot>('/lumo/api/governance'),
        optionalApi<{ tasks?: DelegatedTask[] }>('/lumo/api/delegations', { tasks: [] }),
        optionalApi<{ users?: DirectoryUser[] }>('/lumo/api/users', { users: [] }),
      ])
      setData(overview); setGovernance(governed); setDelegations(taskData.tasks ?? []); setDirectory(directoryData.users ?? [])
    }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30_000); return () => window.clearInterval(timer) }, [load])
  useEffect(() => { if (!profileUserID && directory[0]?.id) setProfileUserID(directory[0].id) }, [directory, profileUserID])
  useEffect(() => {
    if (!profileUserID) { setProfileTags(''); return }
    let alive = true
    void optionalApi<{ tags?: string[] }>(`/lumo/api/users/${encodeURIComponent(profileUserID)}/tags`, { tags: [] }).then(result => {
      if (alive) { setProfileTags((result.tags ?? []).join(', ')); setProfileNotice('') }
    })
    return () => { alive = false }
  }, [profileUserID])
  const run = async <T,>(key: string, success: string, operation: () => Promise<T>): Promise<T | undefined> => { setBusy(key); try { const result = await operation(); setNotice(success); await load(); return result } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); return undefined } finally { setBusy('') } }
  const createProject = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const name = String(new FormData(form).get('name') ?? '').trim(); if (!name) return; await run('project', `项目「${name}」已创建。`, () => api('/lumo/api/projects', { method: 'POST', body: JSON.stringify({ name }) })); form.reset() }
  const createFlow = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); const project = String(fields.get('project') ?? ''); const name = String(fields.get('name') ?? '').trim(); if (!project || !name) return; await run('flow', `流程「${name}」已创建为草稿。`, () => api(`/lumo/api/projects/${encodeURIComponent(project)}/flows`, { method: 'POST', body: JSON.stringify({ name, definition: { nodes: [{ id: 'start', operator: 'identity' }], edges: [] } }) })); form.reset() }
  const openProject = async (project: Row) => { if (!project.id) return; setBusy(project.id); try { setDashboard(await api(`/lumo/api/projects/${encodeURIComponent(project.id)}/dashboard`)) } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy('') } }
  const triggerFlow = async (flow: Row, action: 'submit' | 'review' | 'run' | 'deprecate' | 'rollback') => {
    const flowID = flow.id; if (!flowID) return
    const body = action === 'review' ? { approve: true, comment: '运营端审核通过' } : action === 'run' ? { input: { source: 'lumo-operations' } } : action === 'rollback' ? { version: Math.max(1, (flow.version ?? 1) - 1) } : {}
    const message = action === 'submit' ? `流程「${flow.name ?? flowID}」已提交审核。` : action === 'review' ? `流程「${flow.name ?? flowID}」已通过审核。` : action === 'deprecate' ? `流程「${flow.name ?? flowID}」已停用。` : action === 'rollback' ? `流程「${flow.name ?? flowID}」已回滚。` : `流程「${flow.name ?? flowID}」试运行完成。`
    await run(flowID, message, () => api(`/lumo/api/flows/${encodeURIComponent(flowID)}/${action}`, { method: 'POST', body: JSON.stringify(body) }))
  }
  const scheduleTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget); const taskID = String(fields.get('task_id') ?? '').trim(); if (!taskID) { setNotice('请输入任务 ID。'); return }
    const priority = Number(fields.get('priority') ?? 0); const deadline = Number(fields.get('deadline_ms') ?? 0); const weight = Number(fields.get('weight') ?? 1)
    const result = await run<Placement>('placement', `任务「${taskID}」已提交调度。`, () => api<Placement>('/lumo/api/scheduler/placements', { method: 'POST', body: JSON.stringify({ task_id: taskID, cluster_id: String(fields.get('cluster_id') ?? '').trim(), requires: parseSchedulerRequirements(String(fields.get('requires') ?? '')), priority: Number.isFinite(priority) ? priority : 0, residency: String(fields.get('residency') ?? '').trim(), deadline_ms: Number.isFinite(deadline) ? deadline : 0, queue: String(fields.get('queue') ?? 'default').trim(), weight: Number.isFinite(weight) && weight > 0 ? weight : 1, avoid_nodes: splitCSV(String(fields.get('avoid_nodes') ?? '')) }) }))
    if (result) setPlacement(result)
  }
  const refreshPlacement = async () => { if (!placement?.task_id) return; const result = await run<Placement>('placement-refresh', '调度任务状态已刷新。', () => api<Placement>(`/lumo/api/scheduler/placements/${encodeURIComponent(placement.task_id!)}`)); if (result) setPlacement(result) }
  const previewDelegation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget); const intent = String(fields.get('intent') ?? '').trim(); if (!intent) { setNotice('请先描述要交付的工作意图。'); return }
    setBusy('delegation-preview'); setNotice('')
    try {
      const result = await api<DelegationPreview>('/lumo/api/delegations/preview', { method: 'POST', body: JSON.stringify({ intent, project_id: String(fields.get('project_id') ?? '').trim(), required_tags: splitCSV(String(fields.get('required_tags') ?? '')), required_skills: splitCSV(String(fields.get('required_skills') ?? '')), residency: String(fields.get('residency') ?? '').trim() }) })
      const candidates = result.candidates.map(candidate => ({ ...candidate, worker_id: candidate.worker_id || candidate.user_id, user_id: candidate.user_id || candidate.worker_id }))
      setDelegationPreview({ ...result, candidates }); setSelectedAssignee(candidates.find(candidate => candidate.eligible)?.worker_id ?? ''); setAssignmentMode('auto')
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy('') }
  }
  const dispatchDelegation = async () => {
    const form = delegationFormRef.current; if (!form || !delegationPreview) return
    const fields = new FormData(form); const intent = String(fields.get('intent') ?? '').trim(); const title = String(fields.get('title') ?? '').trim() || intent
    const selected = delegationPreview.candidates.find(candidate => candidate.worker_id === selectedAssignee || candidate.user_id === selectedAssignee)
    const assignee = selected?.display_name ?? selectedAssignee
    const result = await run<DelegatedTask>('delegation', assignmentMode === 'auto' ? `任务「${title}」已按意图、标签、技能和负载自动分发。` : `任务「${title}」已分发给 ${assignee}。`, async () => {
      const created = await api<DelegationCreated>('/lumo/api/delegations', { method: 'POST', body: JSON.stringify({ title, intent, project_id: String(fields.get('project_id') ?? '').trim(), required_tags: splitCSV(String(fields.get('required_tags') ?? '')), required_skills: splitCSV(String(fields.get('required_skills') ?? '')), assignee_user_id: assignmentMode === 'auto' || selected?.worker_kind === 'agent' ? '' : selected?.user_id ?? '', assignee_worker_id: assignmentMode === 'auto' ? '' : selected?.worker_id ?? selectedAssignee, auto_assign: assignmentMode === 'auto', schedule: { cluster_id: String(fields.get('cluster_id') ?? '').trim(), requires: parseSchedulerRequirements(String(fields.get('requires') ?? '')), priority: Number(fields.get('priority') ?? 0) || 0, residency: String(fields.get('residency') ?? '').trim(), queue: 'delegated', weight: 1, avoid_nodes: [] } }) })
      return created.task ?? created as DelegatedTask
    })
    if (result) { setDelegationPreview(null); setSelectedAssignee(''); form.reset() }
  }
  const updateTaskStatus = async (task: DelegatedTask, state: string) => { await run(`task-${task.id}`, `任务「${task.title}」状态已更新为 ${state}。`, () => api(`/lumo/api/delegations/${encodeURIComponent(task.id)}/status`, { method: 'POST', body: JSON.stringify({ state }) })) }
  const cancelTask = async (task: DelegatedTask) => { await updateTaskStatus(task, 'CANCELLED') }
  const saveProfileTags = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!profileUserID) return
    setProfileBusy(true); setProfileNotice('')
    try {
      const result = await api<{ tags?: string[] }>(`/lumo/api/users/${encodeURIComponent(profileUserID)}/tags`, { method: 'PUT', body: JSON.stringify({ tags: splitCSV(profileTags) }) })
      setProfileTags((result.tags ?? []).join(', ')); setProfileNotice('人员标签已保存，后续意图分发会使用最新画像。')
    } catch (reason) { setProfileNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setProfileBusy(false) }
  }
  const refreshDashboard = async () => { const projectID = dashboard?.project?.id; if (!projectID) return; try { setDashboard(await api<Dashboard>(`/lumo/api/projects/${encodeURIComponent(projectID)}/dashboard`)) } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } }
  const projectLifecycle = async (action: 'archive' | 'unarchive') => { const projectID = dashboard?.project?.id; if (!projectID) return; const result = await run(`project-${action}`, action === 'archive' ? '项目已归档。' : '项目已恢复。', () => api(`/lumo/api/projects/${encodeURIComponent(projectID)}/${action}`, { method: 'POST' })); if (result !== undefined) setDashboard(null) }
  const online = countOnline(data)
  const roles = rowsOf<Record<string, unknown>>(governance?.roles, 'roles')
  const departments = rowsOf<Record<string, unknown>>(governance?.departments, 'departments')
  const configured = data.plugins
  const grouped = capabilityGroups.map(group => ({ ...group, plugins: configured.filter(plugin => group.ids.includes(plugin.id)) })).filter(group => group.plugins.length > 0)
  const ungrouped = configured.filter(plugin => !capabilityGroups.some(group => group.ids.includes(plugin.id)) && plugin.id !== 'platform-ui')
  if (data.deployment.mode === 'local') {
    return <div className="lumo-surface"><SurfaceIntro surface="operations" trailing={<div className="lumo-sync-control"><span><i className="lumo-live-dot" /> 本地运行</span><BusyButton className="lumo-secondary lumo-small" busy={loading} onClick={() => void load()}>刷新状态</BusyButton></div>} /><DeploymentBanner deployment={data.deployment} /><LocalModePanel plugins={configured} /></div>
  }
  return <div className="lumo-surface">
    <SurfaceIntro surface="operations" trailing={<div className="lumo-sync-control"><span><i className="lumo-live-dot" /> {loading ? '同步中' : '实时连接'}</span><BusyButton className="lumo-secondary lumo-small" busy={loading} onClick={() => void load()}>刷新数据</BusyButton></div>} />
    <DeploymentBanner deployment={data.deployment} />
    {notice ? <Notice error={notice.includes('失败') || notice.includes('unavailable')} close={() => setNotice('')}>{notice}</Notice> : null}
    <div className="lumo-metric-grid"><Metric label="控制服务" value={`${online}/${Object.keys(data.services).length || 5}`} note={loading ? '同步中' : '实时健康'} tone="mint" /><Metric label="执行节点" value={String(data.cluster.nodes.length)} note={data.cluster.leader?.holder ?? '等待主节点'} /><Metric label="装配插件" value={String(data.plugins.length)} note="生效装配" /><Metric label="当前项目" value={String(data.projects.length)} note={data.generatedAt ? `同步 ${formatSync(data.generatedAt)}` : '尚未同步'} /></div>
    <Section title="服务与调度" meta={data.generatedAt ? `同步 ${formatSync(data.generatedAt)}` : '尚未同步'}><div className="lumo-service-grid">{Object.entries(data.services).map(([name, service], index) => <SpotlightCard className="lumo-service-card" index={index} key={name}><i className={service.ok ? 'online' : 'offline'} /><span><b>{localizedServiceName(name)}</b><small>{service.ok ? '就绪' : service.error || '不可用'}</small></span><em>{service.ok ? '在线' : '未连接'}</em></SpotlightCard>)}</div>{data.cluster.nodes.length ? <div className="lumo-node-strip">{data.cluster.nodes.map(node => <span key={node.node_id}><i />{node.node_id}<small>{node.capacity ?? 0} 个名额</small></span>)}</div> : <div className="lumo-inline-empty">调度目录暂时没有执行节点。</div>}</Section>
    <Section title="提交调度任务" meta="调度放置 · 支持能力、驻留和队列约束"><form className="lumo-placement-form" onSubmit={scheduleTask}><label><span>任务 ID</span><input name="task_id" required placeholder="例如 report-2026-001" /></label><label><span>集群 ID</span><input name="cluster_id" placeholder="cluster-a" /></label><label><span>队列</span><input name="queue" defaultValue="default" /></label><label><span>优先级</span><input name="priority" type="number" defaultValue="0" /></label><label><span>截止时间戳</span><input name="deadline_ms" type="number" placeholder="可选，Unix ms" /></label><label><span>权重</span><input name="weight" type="number" min="1" defaultValue="1" /></label><label className="wide"><span>能力要求</span><input name="requires" placeholder="gpu=1, region=cn-east" /></label><label><span>数据驻留</span><input name="residency" placeholder="cn-east" /></label><label><span>避让节点</span><input name="avoid_nodes" placeholder="node-b, node-c" /></label><BusyButton type="submit" busy={busy === 'placement'} className="lumo-primary">提交调度</BusyButton></form>{placement ? <div className="lumo-placement-result"><div><b>{placement.state ?? '等待中'}</b><span>{placement.task_id} · {placement.node_id ?? '等待节点'} · 尝试 {placement.attempt ?? 0}</span></div><small>隔离令牌 {placement.fencing_token ?? '未分配'}</small><BusyButton className="lumo-secondary lumo-small" busy={busy === 'placement-refresh'} onClick={() => void refreshPlacement()}>刷新任务状态</BusyButton></div> : null}</Section>
    <div className="lumo-split"><Section title="项目边界" meta={`${data.projects.length} 个`}><form className="lumo-inline-form" onSubmit={createProject}><label><span>新项目</span><input name="name" placeholder="项目名称" /></label><BusyButton type="submit" busy={busy === 'project'} className="lumo-primary">创建</BusyButton></form><div className="lumo-compact-list">{data.projects.length ? data.projects.map(project => <button type="button" key={project.id} onClick={() => void openProject(project)}><span><b>{project.name ?? project.id}</b><small>{project.realm ?? '当前 realm'}</small></span><em>{busy === project.id ? '读取中' : '详情 ↗'}</em></button>) : <Empty>还没有项目。创建一个项目后，流程、知识空间和用量会在这里汇总。</Empty>}</div></Section><Section title="流程管理" meta={`${data.flows.length} 条`}><form className="lumo-flow-form" onSubmit={createFlow}><label><span>归属项目</span><select name="project" defaultValue="" aria-label="归属项目"><option value="" disabled>选择项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name ?? project.id}</option>)}</select></label><label><span>流程名称</span><input name="name" placeholder="流程名称" /></label><BusyButton type="submit" busy={busy === 'flow'} className="lumo-primary">新建</BusyButton></form><div className="lumo-compact-list">{data.flows.length ? data.flows.map(flow => <div key={flow.id}><span><b>{flow.name ?? flow.id}</b><small>{flow.status === 'unknown' || !flow.status ? '未声明状态' : flow.status} · v{flow.version ?? 1}</small></span>{flow.status === 'draft' ? <BusyButton busy={busy === flow.id} className="lumo-small" onClick={() => void triggerFlow(flow, 'submit')}>提交审核</BusyButton> : flow.status === 'submitted' ? <BusyButton busy={busy === flow.id} className="lumo-small" onClick={() => void triggerFlow(flow, 'review')}>审核通过</BusyButton> : ['published', 'targeted'].includes(flow.status ?? '') ? <span className="lumo-flow-actions"><BusyButton busy={busy === flow.id} className="lumo-small" onClick={() => void triggerFlow(flow, 'run')}>试运行</BusyButton><BusyButton busy={busy === flow.id} className="lumo-small lumo-danger" onClick={() => void triggerFlow(flow, 'deprecate')}>停用</BusyButton></span> : flow.status === 'deprecated' ? <em>已停用</em> : <em>治理中</em>}</div>) : <Empty>还没有流程。流程从草稿开始，提交后进入治理审核。</Empty>}</div></Section></div>
    <Section title="上下游任务协同" meta={governance?.features.ok ? '集群已就绪 · 意图、标签、有效技能交集' : '仅集群已就绪时开放跨用户委派'}><div className="lumo-delegation-layout"><form ref={delegationFormRef} className="lumo-delegation-form" onSubmit={previewDelegation}><label><span>任务标题</span><input name="title" placeholder="例如：华东客户合同复核" /></label><label className="wide"><span>工作意图</span><textarea name="intent" rows={3} required placeholder="描述交付结果、业务范围和约束，例如：跟进华东客户的合同复核并标出高风险条款。" /></label><label><span>项目边界</span><select name="project_id" defaultValue=""><option value="">不绑定项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name ?? project.id}</option>)}</select></label><label><span>必须标签</span><input name="required_tags" placeholder="华东, 客户" /></label><label><span>必须技能</span><input name="required_skills" placeholder="合同复核" /></label><label><span>调度集群</span><input name="cluster_id" placeholder="cluster-a" /></label><label className="wide"><span>节点能力</span><input name="requires" placeholder="cpu, region=cn-east" /></label><label><span>优先级</span><input name="priority" type="number" defaultValue="0" /></label><label><span>数据驻留</span><input name="residency" placeholder="cn-east" /></label><BusyButton type="submit" busy={busy === 'delegation-preview'} className="lumo-primary">识别候选人</BusyButton></form><div className="lumo-delegation-preview">{delegationPreview ? <><div className="lumo-preview-head"><div><span className="lumo-inspector-label">匹配预览</span><b>{delegationPreview.candidates.filter(candidate => candidate.eligible).length} 个可分发对象</b></div><small>{delegationPreview.intent_terms.join(' · ') || '未提取词项'}</small></div><div className="lumo-inference"><span>识别标签：{delegationPreview.inferred_tags.join('、') || '无'}</span><span>识别技能：{delegationPreview.inferred_skills.join('、') || '无'}</span></div><div className="lumo-assignment-mode"><label><input type="checkbox" checked={assignmentMode === 'auto'} onChange={event => setAssignmentMode(event.target.checked ? 'auto' : 'manual')} /> <b>自动分发</b><span>按意图 · 标签 · 技能 · 当前负载选择</span></label><small>{assignmentMode === 'auto' ? '系统将在服务端再次计算候选集并写入审计理由。' : '手动指定仅可选择满足硬约束的候选人。'}</small></div><div className="lumo-candidate-list">{delegationPreview.candidates.slice(0, 8).map(candidate => <button type="button" disabled={!candidate.eligible} className={assignmentMode === 'manual' && selectedAssignee === candidate.user_id ? 'selected' : ''} key={candidate.user_id} onClick={() => { setSelectedAssignee(candidate.user_id); setAssignmentMode('manual') }}><span><b>{candidate.display_name}</b><small>{candidate.user_id} · {candidate.active_tasks} 个进行中任务</small></span><em>{candidate.eligible ? `${candidate.score} · ${candidate.matched_tags.concat(candidate.matched_skills).join(' / ') || '可接收'}` : candidate.rationale[0] ?? '不满足条件'}</em></button>)}</div><BusyButton busy={busy === 'delegation'} disabled={assignmentMode === 'manual' && !selectedAssignee} className="lumo-primary" onClick={() => void dispatchDelegation()}>{assignmentMode === 'auto' ? `自动分发${delegationPreview.candidates.find(candidate => candidate.eligible)?.display_name ? ` · 推荐 ${delegationPreview.candidates.find(candidate => candidate.eligible)?.display_name}` : ''}` : `确认分发给 ${delegationPreview.candidates.find(candidate => candidate.user_id === selectedAssignee)?.display_name ?? '候选人'}`}</BusyButton></> : <div className="lumo-delegation-empty"><Glyph surface="operations" /><b>先描述任务，再生成可解释分发建议</b><p>系统只使用当前 realm 的启用用户、用户标签和已生效技能；没有满足交集时不会强行分发。</p></div>}</div></div><div className="lumo-task-tracker"><header><b>任务跟踪</b><span>{delegations.length} 条记录 · 30 秒同步</span></header>{delegations.length ? delegations.map(task => <div className="lumo-task-row" key={task.id}><span className="lumo-task-state"><i className={task.state === 'COMPLETED' ? 'done' : task.state === 'FAILED' || task.state === 'BLOCKED' ? 'bad' : 'live'} />{localizedTaskState(task.business_state ?? task.state)}</span><span className="lumo-task-main"><b>{task.title}</b><small>{task.assignee_name ?? task.assignee_user_id} · {task.selected_skills.join(' / ') || '意图匹配'} · {task.assigned_node_id ?? '等待节点'}</small></span><em>{task.updated_at ? formatSync(task.updated_at) : '刚刚'}</em>{['ASSIGNED', 'QUEUED', 'RUNNING'].includes(task.state) ? <BusyButton busy={busy === `task-${task.id}`} className="lumo-small lumo-danger" onClick={() => void updateTaskStatus(task, 'CANCELLED')}>取消任务</BusyButton> : null}</div>) : <Empty>还没有委派任务。识别候选人后，系统会保留委派、技能快照和节点调度状态。</Empty>}</div></Section>
    <Section title="人员画像" meta="标签直接参与意图分发与负载排序"><div className="lumo-profile-layout">{directory.length ? <form className="lumo-profile-form" onSubmit={saveProfileTags}><label><span>人员</span><select value={profileUserID} onChange={event => setProfileUserID(event.target.value)}>{directory.map(user => <option value={user.id} key={user.id}>{user.display_name} · {user.id}</option>)}</select></label><label className="wide"><span>标签</span><input value={profileTags} onChange={event => setProfileTags(event.target.value)} placeholder="华东, 合同, 客户成功" /></label><BusyButton type="submit" busy={profileBusy} className="lumo-primary">保存标签</BusyButton>{profileNotice ? <small className="lumo-form-note">{profileNotice}</small> : null}</form> : <div className="lumo-profile-empty"><b>人员目录不可用</b><span>只有集群已就绪且当前身份具备 task:delegate 权限时，才能编辑人员画像。</span></div>}<div className="lumo-profile-hint"><span>分发判定</span><b>标签硬约束 + 技能交集 + 当前负载</b><small>保存后立即影响下一次预览；已经分发的任务保留当时的技能快照与匹配理由，便于审计。</small></div></div></Section>
    <Section title="平台能力" meta="根据当前装配状态自动分组"><div className="lumo-platform-groups">{grouped.map(group => <div className="lumo-platform-group" key={group.label}><header><b>{group.label}</b><span>{group.plugins.length} 个模块</span></header><div>{group.plugins.map(plugin => <button type="button" key={plugin.id} onClick={() => openSurface(plugin.surface)}><span>{plugin.label.slice(0, 1)}</span><b>{plugin.label}</b><small>{plugin.description}</small><i>{localizedPluginKind(plugin.kind)}</i></button>)}</div></div>)}{ungrouped.length ? <div className="lumo-platform-group"><header><b>其他已装配能力</b><span>{ungrouped.length} 个模块</span></header><div>{ungrouped.map(plugin => <button type="button" key={plugin.id} onClick={() => openSurface(plugin.surface)}><span>{plugin.label.slice(0, 1)}</span><b>{plugin.label}</b><small>{plugin.description}</small><i>{localizedPluginKind(plugin.kind)}</i></button>)}</div></div> : null}{!grouped.length && !ungrouped.length ? <Empty>当前没有额外的插件声明。</Empty> : null}</div><div className="lumo-governance-strip"><span><b>{roles.length}</b>角色策略</span><span><b>{departments.length}</b>组织节点</span><span className={governance?.features.ok ? 'ready' : ''}><b>{governance?.features.ok ? '已启用' : '未启用'}</b>治理特性</span></div></Section>
    <Section title="多智能体调度图" meta="Ruflo 运行内编排 · Archify 可验证导出"><OrchestrationTopology tasks={delegations} busy={busy} cancel={cancelTask} /></Section>
    {dashboard ? <DashboardSheet data={dashboard} close={() => setDashboard(null)} refresh={refreshDashboard} lifecycle={projectLifecycle} /> : null}
  </div>
}

function DashboardSheet({ data, close, refresh, lifecycle }: { data: Dashboard; close: () => void; refresh: () => Promise<void>; lifecycle: (action: 'archive' | 'unarchive') => Promise<void> }) {
  const project = data.project ?? {}
  const [spaceName, setSpaceName] = useState('')
  const [automationID, setAutomationID] = useState('')
  const [triggerKind, setTriggerKind] = useState('event')
  const [triggerSpec, setTriggerSpec] = useState('')
  const [flowRef, setFlowRef] = useState('')
  const [resourceBusy, setResourceBusy] = useState('')
  const [resourceNotice, setResourceNotice] = useState('')
  const projectID = project.id ?? ''
  const facts = [['成员', data.members?.length ?? 0], ['知识空间', data.spaces?.length ?? 0], ['制品', data.artifacts?.length ?? 0], ['自动化', data.automations?.length ?? 0], ['计量事件', data.usage?.length ?? 0], ['预算', data.budget?.remaining ?? data.budget?.amount ?? '未设置']]
  const addSpace = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!projectID || !spaceName.trim()) return; setResourceBusy('space'); setResourceNotice(''); try { await api(`/lumo/api/projects/${encodeURIComponent(projectID)}/spaces`, { method: 'POST', body: JSON.stringify({ name: spaceName.trim() }) }); setSpaceName(''); setResourceNotice('知识空间已创建。'); await refresh() } catch (reason) { setResourceNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setResourceBusy('') } }
  const saveAutomation = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); if (!projectID || !automationID.trim() || !triggerSpec.trim() || !flowRef.trim()) return; setResourceBusy('automation'); setResourceNotice(''); try { await api(`/lumo/api/projects/${encodeURIComponent(projectID)}/automations/${encodeURIComponent(automationID.trim())}`, { method: 'PUT', body: JSON.stringify({ triggerKind, triggerSpec: triggerSpec.trim(), flowRef: flowRef.trim(), enabled: true }) }); setResourceNotice('自动化调度已保存。'); await refresh() } catch (reason) { setResourceNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setResourceBusy('') } }
  const spaces = (data.spaces ?? []) as Array<Record<string, unknown>>
  const automations = (data.automations ?? []) as unknown as Array<Record<string, unknown>>
  return <aside className="lumo-sheet" aria-label="项目详情"><header><div><span className="lumo-eyebrow">项目详情卡</span><h3>{project.name ?? project.id}</h3><p>{data.yourRole ?? '成员'} · {project.realm ?? '未设置'} · {project.status === 'active' ? '启用中' : project.status ?? '未声明状态'}</p></div><div className="lumo-sheet-actions"><BusyButton className="lumo-secondary lumo-small" onClick={() => void refresh()}>刷新</BusyButton><BusyButton className="lumo-danger lumo-small" onClick={() => void lifecycle(project.status === 'archived' ? 'unarchive' : 'archive')}>{project.status === 'archived' ? '恢复项目' : '归档项目'}</BusyButton><MagneticButton aria-label="关闭项目详情" className="lumo-quiet" onClick={close}>×</MagneticButton></div></header><div className="lumo-fact-grid">{facts.map(([label, value]) => <div key={String(label)}><small>{label}</small><b>{String(value)}</b></div>)}</div>{resourceNotice ? <Notice close={() => setResourceNotice('')}>{resourceNotice}</Notice> : null}<div className="lumo-sheet-grid"><div><h4>知识空间</h4>{spaces.length ? <div className="lumo-sheet-list">{spaces.map(space => <span key={String(space.spaceId ?? space.id)}><b>{String(space.name ?? space.spaceId ?? space.id)}</b><small>{String(space.spaceId ?? space.id ?? '')}</small></span>)}</div> : <Empty>项目还没有知识空间。</Empty>}<form className="lumo-resource-form" onSubmit={addSpace}><input aria-label="知识空间名称" value={spaceName} onChange={event => setSpaceName(event.target.value)} placeholder="新空间名称" /><BusyButton type="submit" busy={resourceBusy === 'space'} className="lumo-primary lumo-small">新建空间</BusyButton></form></div><div><h4>自动化调度</h4>{automations.length ? <div className="lumo-sheet-list">{automations.map(automation => <span key={String(automation.automationId ?? automation.id)}><b>{String(automation.automationId ?? automation.id)}</b><small>{String(automation.triggerKind ?? '')} · {String(automation.flowRef ?? '')} · {automation.enabled === false ? '停用' : '启用'}</small></span>)}</div> : <Empty>项目还没有自动化规则。</Empty>}<form className="lumo-resource-form lumo-automation-form" onSubmit={saveAutomation}><input aria-label="自动化 ID" value={automationID} onChange={event => setAutomationID(event.target.value)} placeholder="automation-id" /><select aria-label="触发类型" value={triggerKind} onChange={event => setTriggerKind(event.target.value)}><option value="event">事件</option><option value="cron">定时</option><option value="webhook">Webhook</option></select><input aria-label="触发规则" value={triggerSpec} onChange={event => setTriggerSpec(event.target.value)} placeholder="事件名或 cron 表达式" /><input aria-label="流程引用" value={flowRef} onChange={event => setFlowRef(event.target.value)} placeholder="flow-id" /><BusyButton type="submit" busy={resourceBusy === 'automation'} className="lumo-primary lumo-small">保存规则</BusyButton></form></div></div></aside>
}

function AccountSurface() {
  const [account, setAccount] = useState<AuthAccount | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const authHeaders = { 'X-Lumo-Auth-Request': '1' }
  const load = useCallback(async () => { setLoading(true); try { setAccount(await api<AuthAccount>('/auth/account', { headers: authHeaders })); setNotice('') } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  const savePassword = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); const currentPassword = String(fields.get('currentPassword') ?? ''); const newPassword = String(fields.get('newPassword') ?? ''); const confirmation = String(fields.get('confirmation') ?? ''); if (newPassword !== confirmation) { setNotice('两次输入的新密码不一致。'); return } setBusy(true); try { await api('/auth/account/password', { method: 'POST', headers: authHeaders, body: JSON.stringify({ currentPassword, newPassword }) }); location.assign('/auth/login?state=password-changed') } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const logout = async () => { setBusy(true); try { await api('/auth/logout', { method: 'POST', headers: authHeaders }); location.assign('/auth/login') } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); setBusy(false) } }
  return <div className="lumo-surface">
    <SurfaceIntro surface="account" trailing={<div className="lumo-account-state"><i className="lumo-live-dot" /> 会话受保护</div>} />
    {notice ? <Notice error={account === null && !loading} close={() => setNotice('')}>{notice}</Notice> : null}
    <Section title="身份概览" meta="治理用户"><div className="lumo-account-hero"><div className="lumo-avatar"><Glyph surface="account" /></div><div><span>{account?.displayName ?? (loading ? '读取中' : '未读取')}</span><b>{account?.username ?? 'lumo-governance'}</b><small>{account ? `${account.realm} · ${account.department || '未分配部门'} · ${account.clientIp}` : '正在读取当前身份'}</small></div><BusyButton busy={busy} className="lumo-danger" onClick={() => void logout()}>退出登录</BusyButton></div></Section>
    <div className="lumo-account-grid"><Section title="登录保护" meta="固定安全基线"><div className="lumo-security-list"><div><i className="ready" /><span><b>交互式验证码</b><small>每次登录必填点选，一张验证码仅验证一次</small></span><em>始终开启</em></div><div><i className="ready" /><span><b>会话凭据</b><small>HttpOnly Cookie，服务端仅存令牌摘要</small></span><em>不可见令牌</em></div><div><i className="ready" /><span><b>权限来源</b><small>{account?.roles.join(' · ') || '读取中'}</small></span><em>角色权限</em></div></div></Section><Section title="修改密码" meta="更新后撤销全部旧会话"><form className="lumo-stacked-form" onSubmit={savePassword}><label><span>当前密码</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label><label><span>新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={10} maxLength={256} required /></label><label><span>确认新密码</span><input name="confirmation" type="password" autoComplete="new-password" minLength={10} maxLength={256} required /></label><BusyButton type="submit" busy={busy} className="lumo-primary">更新并重新登录</BusyButton></form></Section></div>
    <Section title="会话详情" meta="服务端解析结果"><div className="lumo-session-facts"><div><span>用户 ID</span><b>{account?.userId ?? '读取中'}</b></div><div><span>Realm</span><b>{account?.realm ?? '读取中'}</b></div><div><span>部门</span><b>{account?.department || '未分配'}</b></div><div><span>验证码模式</span><b>{account?.captchaMode ?? '读取中'}</b></div></div></Section>
  </div>
}

function LumoThemePicker() {
  const [theme, setTheme] = useState<LumoThemeId>(() => readLumoTheme())
  useEffect(() => {
    const sync = (event: Event) => {
      const next = (event as CustomEvent<unknown>).detail
      if (isLumoTheme(next)) setTheme(next)
    }
    window.addEventListener(LUMO_THEME_EVENT, sync)
    return () => { window.removeEventListener(LUMO_THEME_EVENT, sync) }
  }, [])
  return <label className="lumo-theme-picker"><span>界面主题</span><select aria-label="界面主题" value={theme} onChange={event => requestLumoTheme(event.target.value as LumoThemeId)}>{LUMO_THEME_OPTIONS.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
}

function Workbench({ surface, close, select, commandOpen, toggleCommand }: { surface: Surface; close: () => void; select: (surface: Surface) => void; commandOpen: boolean; toggleCommand: () => void }) {
  const meta = surfaceMeta[surface]
  return <div className="lumo-backdrop"><section className="lumo-workbench" role="dialog" aria-modal="true" aria-label={`${meta.label}工作台`}>
    <aside className="lumo-workbench-rail"><button type="button" className="lumo-workspace-switch" onClick={toggleCommand} aria-haspopup="dialog" aria-expanded={commandOpen}><span className="lumo-brand-mark">L</span><span><b>Lumo 工作区</b><small>本地能力与运营面</small></span><kbd>⌘ K</kbd></button><div className="lumo-rail-menu-head"><span>能力菜单</span><small>快捷跳转</small></div><nav aria-label="Lumo 能力工作台">{surfaceGroups.map(group => <div className="lumo-nav-group" key={group.label}><span className="lumo-nav-label">{group.label}</span>{group.items.map(item => <button type="button" key={item} className={surface === item ? 'active' : ''} aria-label={surfaceMeta[item].label} title={surfaceMeta[item].label} onClick={() => select(item)}><Glyph surface={item} /><span>{surfaceMeta[item].label}</span><small>{surfaceMeta[item].short}</small></button>)}</div>)}</nav><div className="lumo-rail-footer"><span><i className="lumo-live-dot" /> Lumo 服务</span><small>权限和状态由服务端执法</small></div></aside>
    <div className="lumo-workbench-main"><header className="lumo-workbench-header"><div className="lumo-header-location"><span>工作区</span><i>›</i><b>{meta.label}</b><small>当前模块</small></div><div className="lumo-header-actions"><LumoThemePicker /><button type="button" className="lumo-command-trigger" onClick={toggleCommand}><span>跳转</span><kbd>⌘ K</kbd></button><span className="lumo-identity-chip"><i className="lumo-live-dot" /> 会话受保护</span><MagneticButton className="lumo-quiet" aria-label="关闭工作台" onClick={close}>×</MagneticButton></div></header><main>{surface === 'knowledge' ? <KnowledgeSurface /> : surface === 'skills' ? <SkillsSurface /> : surface === 'connectors' ? <ConnectorsSurface /> : surface === 'operations' ? <OperationsSurface /> : surface === 'market' ? <MarketSurface /> : <AccountSurface />}</main><footer className="lumo-workbench-footer"><span>身份、realm 与权限由各插件服务端执法</span><span>按 Esc 返回原生 DSH</span></footer></div>
    <CommandPalette open={commandOpen} surface={surface} select={select} close={toggleCommand} />
  </section></div>
}

export function LumoOverlay(_props: OverlayProps) {
  // The native DSH conversation owns the main screen. Lumo's project controls
  // and OpenDesign dock are injected into that live composer; this overlay is
  // now an on-demand operations workbench rather than a full-screen takeover.
  const [surface, setSurface] = useState<Surface | null>(() => querySurface())
  const [commandOpen, setCommandOpen] = useState(false)
  useEffect(() => {
    const open = (event: Event) => { const next = (event as CustomEvent<Surface>).detail; setSurface(next); setQuerySurface(next) }
    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSurface(current => current ?? 'operations')
        setCommandOpen(current => !current)
      } else if (event.key === 'Escape') { if (commandOpen) setCommandOpen(false); else { setSurface(null); setQuerySurface(null) } }
    }
    window.addEventListener(OPEN_EVENT, open); window.addEventListener('keydown', key)
    return () => { window.removeEventListener(OPEN_EVENT, open); window.removeEventListener('keydown', key) }
  }, [commandOpen])
  const close = () => { setSurface(null); setQuerySurface(null) }
  const select = (next: Surface) => { setSurface(next); setQuerySurface(next) }
  const toggleCommand = () => setCommandOpen(current => !current)
  return <ClickSpark>{surface === null ? null : <Workbench surface={surface} close={close} select={select} commandOpen={commandOpen} toggleCommand={toggleCommand} />}</ClickSpark>
}

export const inject = ['slots', 'theme']
export function apply(ctx: ClientContext): void {
  installLumoThemes(ctx)
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'lumo-workspace', order: 10, label: 'Lumo 工作区' },
    props => <SidebarEntry {...props} surface="operations" />,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'lumo-platform', order: 100 }, LumoOverlay))
  ctx.slots.inject('conversation.input.left', () => ctx.slots.register(
    { name: 'conversation.input.left', id: 'lumo-project-scope', order: 40, label: '项目与空间' },
    ComposerScopeControl,
  ))
  ctx.slots.inject('conversation.hero.input.left', () => ctx.slots.register(
    { name: 'conversation.hero.input.left', id: 'lumo-project-scope-hero', order: 40, label: '项目与空间' },
    HeroComposerScopeControl,
  ))
  ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register(
    { name: 'conversation.composer.dock', id: 'lumo-open-design', order: 20, label: '开放设计' },
    OpenDesignDock,
  ))
  ctx.slots.inject('conversation.hero.composer.dock', () => ctx.slots.register(
    { name: 'conversation.hero.composer.dock', id: 'lumo-open-design-hero', order: 20, label: '开放设计' },
    HeroOpenDesignDock,
  ))
}

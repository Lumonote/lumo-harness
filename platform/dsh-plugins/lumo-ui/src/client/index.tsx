import type { Surface, ServiceState, NodeState, DeploymentState, Row, Plugin, Overview, AuthAccount } from './surface-types.ts'
import { ApiError, api, optionalApi, type OptionalApiResult } from './api.ts'
import { surfaceMeta, availableSurfaces, navigationSurfaces, OPEN_EVENT, CLOSE_EVENT, querySurface, setQuerySurface, openSurface } from './surface-navigation.ts'
import { Glyph, MagneticButton, BusyButton, ConfirmButton, SpotlightCard, ClickSpark, Section, Empty, Notice, formatSync, WorkspaceHero, DomainTabs, Metric } from './surface-shell.tsx'
import { useFocusTrap } from './focus-trap.ts'
import { KnowledgeSurface } from './knowledge-surface.tsx'
import { MarketSurface } from './market-surface.tsx'
import { AccountSurface } from './account-surface.tsx'
export { KnowledgeSurface } from './knowledge-surface.tsx'
import {
  useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type FormEvent, type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// ctx.slots 的 Context 增强随上游 be531688f3（移除 Runtime）搬到了 ui-renderer。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  getThemeRegistryState,
  LUMO_DEFAULT_THEME,
  LUMO_THEME_IDENTITY,
  installLumoThemes,
  subscribeThemeRegistry,
  type LumoThemeId,
  type ThemeRegistryState,
} from './themes.ts'
import './lumo.css'
// 协作空间的布局与状态派生是纯函数（见 collaboration-layout.ts 的文件头）：
// 同一个任务必须永远落在同一个位置，否则「右上角那个」就不再是一句有效的指代。
import { employeeFlowEdges, layoutCollaboration, NODE_LIFT_Y, type AgentInput, type EmployeeInput, type EmployeeState, type FlowTaskInput } from './collaboration-layout.ts'
// 任务板与员工视图共用同一套几何常量，所以切换视图时同一件事不会跳到别处。
import { layoutTaskBoard, type BoardTaskInput, type BoardTaskState, type TeamProgressInput } from './collaboration-board.ts'
// 侧边栏登录态的映射规则（纯函数，见该文件头）：三条分支的区别就是它的全部内容。
import { resolveSidebarIdentity, type SidebarIdentity } from './sidebar-identity.ts'
import { ClusterNodesPanel, SchedulerClustersPanel, SkillAccessPanel, ProjectMembersPanel, ConnectorManifestPanel, ConnectorAccountPanel, AgentPresetEditor, FlowManagementPanel, TaskIntentContractPanel, TaskCollaboratorsPanel, TaskCollaborationPanel, TaskEvidencePanel, SessionControlPanel, ThreadBoardPanel, type AgentPreset, type ProjectMember, type TaskIntentFacts, type TaskIntentContract, type TaskScoreBreakdown, type TaskResultFacts, type TaskCollaborationFacts } from './cluster-panels.tsx'
import { AgentOutputProfileField, TEXT_OUTPUT_PROFILE, agentOutputProfileError, agentOutputProfileLabel, useClusterCapabilities } from './cluster-panels.tsx'
import { TokenUsagePanel } from './token-usage-panel.tsx'
import { ProjectDirectoryPanel } from './project-directory-panel.tsx'
import { WorkforceProgressPanel, TaskProgressPanel } from './workforce-progress-panel.tsx'
import { UserSecurityPanel } from './user-security-panel.tsx'
import { ProjectSettingsPanel } from './project-settings-panel.tsx'
import { ProjectBudgetPanel } from './project-budget-panel.tsx'
import { ProjectSpacesPanel, ProjectAutomationsPanel, ProjectArtifactsPanel, type ProjectResourceSpace, type ProjectResourceArtifact } from './project-resources-panel.tsx'
import { TeamLauncher, type TeamCapabilities } from './team-launcher.tsx'
import { OPERATIONS_TARGET_EVENT, PROJECTS_CHANGED_EVENT, queueOperationsTarget, takeOperationsTarget, type OperationsTarget } from './operations-navigation.ts'
import { RunReviewPanel, type ReviewActor } from './run-review-panel.tsx'
import { UserDirectoryPagination, userDirectoryURL } from './user-directory.tsx'
import { DirectoryUserPicker } from './directory-user-picker.tsx'
import { RolePermissionsPanel } from './role-permissions-panel.tsx'
import { RecoveryWorkflowPanel } from './recovery-workflow-panel.tsx'
import { StorageQuotaPanel } from './storage-quota-panel.tsx'
import type { ThreadFacts } from './thread-board.ts'
import { installDesktopPetBridge, registerDesktopPetSurface, type DesktopPetServices } from './desktop-pet.ts'
import { DesktopPetTasks } from './desktop-pet-tasks.tsx'
import { ComputerUsePanel } from './computer-use-panel.tsx'
import { installComputerUseServices, type ComputerUseClientServices } from './computer-use-services.ts'
import { installAnchoredOverlayFallback } from './anchored-overlays.ts'

// A desktop WebView can evaluate more than one copy of this bundle while the
// native shell is recovering from a loader replay. Keep the root-scoped mount
// ledger on globalThis so separate bundle instances still share it.
const LUMO_CLIENT_ROOTS = Symbol.for('@lumo/dsh-platform-ui/client-roots')

function activeClientRoots(): WeakSet<object> {
  const shared = globalThis as typeof globalThis & { [LUMO_CLIENT_ROOTS]?: WeakSet<object> }
  return shared[LUMO_CLIENT_ROOTS] ??= new WeakSet<object>()
}

// The bridge only reads the draft; submission state and admission belong to
// the upstream input actions. Derive the consumed field from the slot contract.
type ConversationInputState = Pick<ComposerDockProps['input'], 'draft'>

interface ConversationInputActions {
  setDraft(text: string): void
  submit(): void
}

type OverlayProps = PropsRuntime<'shell.overlay'>
type SidebarNavigationProps = PropsRuntime<'sidebar.navigation'>
type ComposerDockProps = PropsRuntime<'conversation.input.dock'>
type HeroComposerDockProps = PropsRuntime<'conversation.hero.composer.dock'>

interface Automation { automationId: string; projectId: string; triggerKind: string; triggerSpec: string; flowRef: string; enabled: boolean; revision: number }
interface FlowDefinition { nodes?: Array<{ id?: string; operator?: string }>; edges?: Array<{ from?: string; to?: string }> }
interface FlowVersionSnapshot { flow_id: string; version: number; reviewer: string; definition: FlowDefinition }
interface FlowVersionDiff { flow: Row; previous: FlowVersionSnapshot; current: FlowVersionSnapshot }
interface Placement { task_id?: string; realm?: string; node_id?: string; attempt?: number; state?: string; fencing_token?: number; preemption_requested_task_id?: string }
interface DelegationCandidate { user_id: string; worker_id: string; worker_kind?: 'human' | 'agent'; agent_ref?: string; display_name: string; department_id?: string; tags: string[]; skills: string[]; matched_tags: string[]; matched_skills: string[]; score: number; confidence_band?: 'AUTO' | 'SUGGESTED' | 'MANUAL'; score_breakdown?: Record<string, unknown>; score_weights?: Record<string, number>; active_tasks: number; eligible: boolean; rationale: string[] }
interface DelegationPreview { title?: string; intent: string; project_id?: string; required_tags: string[]; required_skills: string[]; intent_terms: string[]; inferred_tags: string[]; inferred_skills: string[]; candidates: DelegationCandidate[] }
interface DelegatedTask { id: string; title: string; intent: string; project_id?: string; requester_user_id: string; assignee_user_id: string; assignee_worker_id?: string; worker_id?: string; worker_kind?: 'human' | 'agent'; assignee_name?: string; business_state?: string; confidence_band?: 'AUTO' | 'SUGGESTED' | 'MANUAL'; state: string; match_score: number; selected_skills: string[]; scheduler_task_id?: string; assigned_node_id?: string; last_error?: string; created_at: string; updated_at: string
  // 治理面的任务读面本来就返回这些列；之前只是没在这里声明，于是运维面
  // 看得见任务却看不见它当初承诺了什么。全部可选：老数据行可能没有契约。
  required_tags?: string[]; required_skills?: string[]; inferred_tags?: string[]; inferred_skills?: string[]; rationale?: string[]
  intent_contract?: TaskIntentContract; score_breakdown?: TaskScoreBreakdown; score_weights?: Record<string, number>; schedule?: unknown
}
interface DelegationCreated { task?: DelegatedTask; run?: { id: string; state: string; worker_id: string; attempt: number }; id?: string; title?: string; state?: string }
interface TaskRun { id: string; attempt: number; worker_id: string; session_ref?: string; scheduler_task_id?: string; assigned_node_id?: string; state: string; failure_kind?: string; last_error?: string; started_at?: string; ended_at?: string; created_at: string }
interface TaskAuditEvent { id: string; event: string; actor: string; detail: Record<string, unknown>; created_at: string }
interface PermissionDecision { allowed: boolean; action: string; reason: string; matched_policies: string[] }
interface WorkerProfile { worker_id: string; worker_kind: 'human' | 'agent'; display_name: string; status: string; runtime_status?: string; runtime_updated_at?: string; active_tasks: number; load: number; max_concurrency: number; eligible: boolean }
interface GovernanceRole { id: string; name: string; description?: string; status: string; parent_role_id?: string; permission_revision?: number }
interface GovernanceDepartment { id: string; name: string; parent_dept_id?: string; manager_user_id?: string; status: string }
type AssignmentMode = 'auto' | 'manual'
interface DirectoryUser { id: string; display_name: string; primary_dept_id?: string; status?: string }
interface UserRole { role_id: string; name: string; status: string; expires_at?: string; granted_by: string }
interface UserAccess { username: string; login_enabled: boolean; local_login_enabled?: boolean; roles: UserRole[]; oidc_available?: boolean; oidc_issuer?: string; oidc?: { issuer: string; subject: string; enabled: boolean } }

interface ConnectorApproval {
  id: string; requester_user_id: string; project_id?: string; connector_id: string; connector_version: number; operation: string
  status: 'pending' | 'approved' | 'rejected' | 'consumed' | 'expired'; approver_user_id?: string; created_at: string; expires_at: string
}
interface ConnectorApprovals { approvals: ConnectorApproval[] }

interface OverviewProject { id: string; name: string; status?: string }
interface Dashboard { project?: Row; yourRole?: string; members?: unknown[]; artifacts?: unknown[]; spaces?: unknown[]; automations?: Automation[]; usage?: unknown[]; budget?: { amount?: number; remaining?: number } }
interface ProbeResult { status?: number; url?: string; durationMs?: number; redacted?: boolean; contentType?: string; body?: unknown; headers?: Record<string, string>; encoding?: string }

/** 单机版 vault 知识源运行态（/lumo/api/knowledge/vault/status；未装配=集群版） */

interface RuntimeSkill { name: string; description: string; whenToUse?: string; invocation: { modelInvocable: boolean; userInvocable: boolean }; source: string; provider: string }
interface SkillSnapshot { complete: boolean; skills: RuntimeSkill[]; error?: string }
interface SkillHubSkill { id: string; name: string; tag: string; description: string; rating: number; downloads: number; source: string; verified: boolean; command: string; apiKey: boolean; icon?: string; publisher?: string; tags?: string[]; homepage?: string }
interface SkillHubPack { id: string; name: string; role: string; category: string; description: string; skills: number; source: string; command?: string; icon?: string }
interface SkillHubPlugin { id: string; name: string; category: string; description: string; stars: number; forks: number; source: string; installable: boolean; repo: string; icon?: string; homepage?: string }
interface SkillHubInstalls { skills: string[]; packs: string[]; plugins: string[]; commands?: Record<string, string[]> }
interface SkillHubCatalog { source: 'skillhub' | 'cache' | 'seed'; generatedAt: string; counts: { skills: number; packs: number; plugins: number }; categories?: { skills: string[]; packs: string[]; plugins: string[] }; skills: SkillHubSkill[]; packs: SkillHubPack[]; plugins: SkillHubPlugin[]; installed: SkillHubInstalls; notice?: string; canInstall?: boolean }
interface SkillHubSearchResult { kind: SkillHubKind; q: string; category: string; source: 'skillhub' | 'cache' | 'seed'; total: number; page: number; pageSize: number; skills: SkillHubSkill[]; packs: SkillHubPack[]; plugins: SkillHubPlugin[] }
type SkillHubTab = '专家' | '技能'
type SkillHubKind = 'skill' | 'pack' | 'plugin'
interface GovernedSkill { id: string; realm: string; name: string; description?: string; kind: 'prompt' | 'workflow' | 'tool' | 'connector'; visibility: string; current_version: string; published_version?: string; published_digest?: string; published_by?: string; published_at?: string; created_by: string }
interface GovernedSkillVersion { realm: string; skill_id: string; version: string; content: string; digest: string; created_by: string; created_at: string }
interface UpstreamResult { ok: boolean; status: number; data?: unknown; error?: string }
interface StudioSpace { id: string; label: string; description: string; accent: string }
interface StudioProject { id: string; label: string; summary: string; spaces: StudioSpace[] }
interface StudioScope { projectId: string; spaceId: string }
interface GovernanceSnapshot { local?: boolean; features: UpstreamResult; departments: UpstreamResult; roles: UpstreamResult; catalog: UpstreamResult; effective: UpstreamResult; permissions: UpstreamResult }

const emptyOverview: Overview = { generatedAt: '', deployment: { mode: 'standalone', label: '服务器单例', storage: 'postgres', middleware: [], distributed: false, desktop: false, clusterReady: false, clusterOnly: false }, services: {}, cluster: { nodes: [] }, projects: [], flows: [], connectors: [], plugins: [] }

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
  const fallback = name.replace(/^.*\//u, '').replace(/[-_]+/gu, ' ').trim()
  return skillNameLabels[name] ?? skillNameLabels[name.replace(/^.*\//u, '')] ?? (fallback || '未命名技能')
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

function localizedServiceName(name: string): string {
  return ({
    scheduler: '调度服务',
    projects: '项目服务',
    flows: '流程服务',
    connector: '连接器网关',
    governance: '治理服务',
    registry: '制品注册服务',
    'session-control': '会话控制服务',
    'llm-gateway': '模型网关',
    'usage-ledger': '计量台账服务',
    'edge-gateway': '边缘网关',
    'terminal-gateway': '终端网关',
  } as Record<string, string>)[name] ?? '平台服务'
}

function localizedServiceHealth(service: ServiceState): string {
  if (service.ok) return '进程探活正常'
  if (service.error === 'upstream_not_configured') return '未配置'
  if (service.status === 0) return '探测失败'
  return `HTTP ${service.status}`
}

function localizedTaskState(state: string): string {
  return ({
    DRAFT: '草稿', ROUTING: '路由中', ASSIGNED: '已分派', EXECUTING: '执行中',
    VERIFYING: '核验中', IN_REVIEW: '待审核', DONE: '已完成', REJECTED: '已驳回', ARCHIVED: '已归档',
    QUEUED: '排队中', RUNNING: '运行中', CANCELLING: '取消中', COMPLETED: '运行完成', FAILED: '运行失败',
    CANCELLED: '已取消', BLOCKED: '已阻塞',
  } as Record<string, string>)[state] ?? state
}

// Cancellation is an execution-state safety signal and must not be hidden by
// the independently tracked business state (for example, ASSIGNED).
function localizedTaskDisplayState(task: DelegatedTask): string {
  return localizedTaskState(task.state === 'CANCELLING' ? task.state : task.business_state ?? task.state)
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

// A feature may be unavailable in a deployment, but its failure must never be
// rendered as an indistinguishable empty list. Callers choose a fallback data
// shape while retaining the actual reason for an explicit UI state.

/**
 * 协作空间里的「描述目标」把文字交给**「项目」那一个委派流程**，而不是自己再建一条创建路径。
 *
 * 委派创建在那边已经完整：标题/意图/项目/标签/技能/集群/节点能力/优先级/驻留 → 候选人排序
 * 预览 → 自动或手动分发。在这里重写一份，就会有两个必须就创建体保持一致的调用点——
 * 而它们迟早会分叉，症状是「同一句话在两个入口分发结果不同」。
 *
 * 用模块级变量而不是事件载荷：`OPEN_EVENT` 的 detail 契约是 `Surface`，有两处监听，
 * 为一次跳转改它不划算。值在被读取时**立即清空**，所以它不会变成隐藏状态——
 * 下一次进入「项目」不会莫名其妙地又填上上一次的目标。
 */
let pendingDelegationGoal = ''
function handOffDelegationGoal(goal: string, surface: Surface): void {
  pendingDelegationGoal = goal
  openSurface(surface)
}
function takeDelegationGoal(): string {
  const goal = pendingDelegationGoal
  pendingDelegationGoal = ''
  return goal
}

function openOperationsTarget(target: OperationsTarget): void {
  queueOperationsTarget(target)
  openSurface('operations')
  window.dispatchEvent(new Event(OPERATIONS_TARGET_EVENT))
}

/** 项目状态的显示名。集中一处：触发器和列表项用同一个函数，两处不会说出不同的状态。 */
function projectStatusLabel(status: string | undefined): string {
  if (status === 'active') return '活跃'
  if (status === 'archived') return '已归档'
  return status ?? '未声明状态'
}

/**
 * 侧边栏底部的登录态。四种结局必须分开，不能都渲染成一句「未登录」：
 *
 * - `signed-in` —— 有会话，显示名 + realm/角色，点开用户中心（退出登录在那里）；
 * - `anonymous` —— **这个部署有会话鉴权，而当前浏览器没有会话**（`/auth/account` 回 401）。
 *   显示「未登录」，点击去登录页；
 * - `unavailable` —— 404 / 网络失败 / 单机版根本没挂 auth 代理。那种装配里没有「登录」
 *   这回事，摆一个「未登录」是在陈述一个不存在的问题，所以**什么都不渲染**；
 * - `loading` —— 一次请求那么长的空窗。同样不渲染：用骨架屏去填它只会让侧边栏先闪一下。
 *
 * 三条映射规则本身在 `sidebar-identity.ts`（纯函数，node 环境的 spec 钉得住），
 * 这里只负责发请求、把结局交给它、并把结论画出来。
 */
type SidebarIdentityState = SidebarIdentity | { state: 'loading' }

async function readSidebarIdentity(): Promise<SidebarIdentityState> {
  try {
    const body = await api<unknown>('/auth/account', { headers: { 'X-Lumo-Auth-Request': '1' } })
    return resolveSidebarIdentity({ ok: true, body })
  } catch (reason) {
    return resolveSidebarIdentity({ ok: false, status: reason instanceof ApiError ? reason.status : undefined })
  }
}

/**
 * 侧边栏底部的登录态。挂在 `sidebar.footer.action` 槽上——外壳把 footer 动作排在「设置」
 * 之上、两种栏宽都渲染。不塞进 `sidebar.navigation`：那个槽装的是工作区入口，身份不是工作区。
 */
function SidebarIdentityChip({ wide }: { wide: boolean }) {
  const [identity, setIdentity] = useState<SidebarIdentityState>({ state: 'loading' })
  useEffect(() => {
    let active = true
    void readSidebarIdentity().then(next => { if (active) setIdentity(next) })
    return () => { active = false }
  }, [])
  if (identity.state === 'loading' || identity.state === 'unavailable') return null
  if (identity.state === 'anonymous') {
    return <button type="button" className="lumo-sidebar-identity anonymous" aria-label="未登录，前往登录" onClick={() => location.assign('/auth/login')}>
      <span className="lumo-sidebar-identity-mark" aria-hidden="true"><Glyph surface="account" /></span>
      {wide ? <span className="lumo-sidebar-identity-text"><b>未登录</b><small>点击前往登录</small></span> : null}
    </button>
  }
  const label = identity.facts === '' ? identity.name : `${identity.name}（${identity.facts}）`
  return <button type="button" className="lumo-sidebar-identity" aria-label={`当前登录身份：${label}，打开用户中心`} onClick={() => openSurface('account')}>
    {/* 首字母字位而不是头像图：这一列里没有真实头像可用，而一个画出来的占位头像
        会被读成「有头像只是没加载出来」。字位说的是「这是一个人」。 */}
    <span className="lumo-sidebar-identity-mark" aria-hidden="true">{identity.name.slice(0, 1)}</span>
    {wide ? <span className="lumo-sidebar-identity-text">
      <b>{identity.name}</b>
      <small>{identity.facts === '' ? '已登录' : identity.facts}</small>
    </span> : null}
  </button>
}

function SidebarNavigation({ wide }: SidebarNavigationProps) {
  const projectTriggerRef = useRef<HTMLButtonElement>(null)
  const projectSwitcherRef = useRef<HTMLDivElement>(null)
  const projectMenuRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState<Surface | null>(() => querySurface())
  const [projectMenuOpen, setProjectMenuOpen] = useState(false)
  const [projects, setProjects] = useState<OverviewProject[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string>(() => localStorage.getItem('lumo:currentProjectId') ?? '')
  // 本地桌面只展示有本地运行时能力的工作区。overview 返回前按服务端菜单渲染。
  const [localMode, setLocalMode] = useState(false)

  useEffect(() => {
    let generation = 0
    let active = true
    const load = () => {
      const reading = ++generation
      void api<{ projects: OverviewProject[]; deployment: DeploymentState }>('/lumo/api/overview')
      .then(data => {
        if (!active || reading !== generation) return
        setProjects(data.projects)
        setLocalMode(data.deployment.mode === 'local')
        setCurrentProjectId(current => {
          const next = data.projects.some(project => project.id === current) ? current : data.projects[0]?.id ?? ''
          if (next) localStorage.setItem('lumo:currentProjectId', next)
          else localStorage.removeItem('lumo:currentProjectId')
          return next
        })
      })
      .catch(() => { if (active && reading === generation) setProjects([]) })
    }
    load()
    window.addEventListener(PROJECTS_CHANGED_EVENT, load)
    return () => { active = false; generation++; window.removeEventListener(PROJECTS_CHANGED_EVENT, load) }
  }, [])
  
  const currentProject = projects.find(p => p.id === currentProjectId) ?? projects[0]
  const selectProject = (id: string) => {
    setCurrentProjectId(id)
    localStorage.setItem('lumo:currentProjectId', id)
    setProjectMenuOpen(false)
    // 选完把焦点还给触发器。不还的话焦点会掉到 body 上，键盘用户下一次 Tab 要从
    // 文档开头重新走过来——而他才刚用完这个按钮。
    projectTriggerRef.current?.focus()
    openOperationsTarget({ kind: 'project', id })
  }
  // 打开项目菜单时：接管焦点，并支持上下选择 / Home / End / Esc / 点到别处关闭。
  // 这几条不是加分项：这个浮层盖住的正是下面那几行导航入口，而它先前**只能**靠再点一次
  // 触发器关掉——先用鼠标点开、再用键盘，就是一条死路。
  useEffect(() => {
    if (!projectMenuOpen) return
    const items = (): HTMLElement[] => [...(projectMenuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])]
    // 先落到**当前项目**那一项，而不是第一项：多数时候人打开它只是想确认自己在哪儿。
    const current = items().find(item => item.getAttribute('aria-current') === 'true')
    ;(current ?? items()[0])?.focus()
    const onPointerDown = (event: MouseEvent) => {
      if (projectSwitcherRef.current?.contains(event.target as Node) === true) return
      setProjectMenuOpen(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setProjectMenuOpen(false)
        projectTriggerRef.current?.focus()
        return
      }
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
      const list = items()
      if (list.length === 0) return
      event.preventDefault()
      const index = list.indexOf(document.activeElement as HTMLElement)
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? list.length - 1
          : index < 0 ? (event.key === 'ArrowUp' ? list.length - 1 : 0)
            : event.key === 'ArrowDown' ? (index + 1) % list.length
              : (index - 1 + list.length) % list.length
      list[next]?.focus()
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [projectMenuOpen])
  useEffect(() => {
    const open = (event: Event) => setActive((event as CustomEvent<Surface>).detail)
    const close = () => setActive(null)
    window.addEventListener(OPEN_EVENT, open)
    window.addEventListener(CLOSE_EVENT, close)
    return () => { window.removeEventListener(OPEN_EVENT, open); window.removeEventListener(CLOSE_EVENT, close) }
  }, [])
  const visibleSurfaces = navigationSurfaces(localMode)
  return <nav className={`lumo-sidebar-navigation ${wide ? 'wide' : 'rail'}`} aria-label="Lumo 功能菜单">
    {wide && currentProject ? (
      <div className="lumo-project-switcher" ref={projectSwitcherRef}>
        <button
          type="button"
          ref={projectTriggerRef}
          className="lumo-project-current"
          onClick={() => setProjectMenuOpen(!projectMenuOpen)}
          aria-label={`当前项目：${currentProject.name ?? currentProject.id}`}
          aria-haspopup="menu"
          aria-expanded={projectMenuOpen}
        >
          <span className="lumo-project-initial" aria-hidden="true">{(currentProject.name ?? currentProject.id).slice(0, 1)}</span>
          <div className="lumo-project-info">
            <b>{currentProject.name ?? currentProject.id}</b>
            <small>{projectStatusLabel(currentProject.status)}</small>
          </div>
          {/* 画出来的 V 而不是文字 `⌄`：那个字形的墨迹落在它的 em 框里偏低，网格居中之后
              看过去仍然歪 6–7px，而它偏多少取决于字体回退到了哪一个。图形没有这个自由度。 */}
          <i className="lumo-project-caret" aria-hidden="true">
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="M2.75 4.5 6 7.75l3.25-3.25" /></svg>
          </i>
        </button>
        {projectMenuOpen ? (
          <div className="lumo-project-menu" role="menu" aria-label="切换项目" ref={projectMenuRef}>
            {/* 活跃与已归档分组。原先是一张平表，靠每行那个小字去分——而小字正是人扫读时
                最先跳过的东西，于是「已归档」和「活跃」在列表里长得一模一样。 */}
            {([['活跃', projects.filter(project => project.status !== 'archived')],
              ['已归档', projects.filter(project => project.status === 'archived')]] as const)
              .map(([label, list]) => list.length === 0 ? null : <div className={label === '已归档' ? 'lumo-project-group archived' : 'lumo-project-group'} key={label}>
                <span className="lumo-project-group-label">{label}</span>
                {list.map(project => (
                  <button
                    key={project.id}
                    type="button"
                    role="menuitem"
                    aria-current={project.id === currentProjectId}
                    className={project.id === currentProjectId ? 'selected' : ''}
                    onClick={() => selectProject(project.id)}
                  >
                    <span className="lumo-project-initial" aria-hidden="true">{(project.name ?? project.id).slice(0, 1)}</span>
                    <span>
                      <b>{project.name ?? project.id}</b>
                      <small>{projectStatusLabel(project.status)}</small>
                    </span>
                    {project.id === currentProjectId ? <i aria-hidden="true">✓</i> : null}
                  </button>
                ))}
              </div>)}
          </div>
        ) : null}
      </div>
    ) : null}
    {visibleSurfaces.map(surface => <button type="button" key={surface} className={active === surface ? 'active' : ''} title={surfaceMeta[surface].label} aria-label={surfaceMeta[surface].label} onClick={() => openSurface(surface)}><Glyph surface={surface} />{wide ? <span>{surfaceMeta[surface].label}</span> : null}</button>)}
  </nav>
}

interface NativeConversationBridge {
  getDraft(): string
  setDraft(text: string): void
  submit(): void
}

let nativeConversationBridge: NativeConversationBridge | null = null
const nativeConversationBridges = new Set<NativeConversationBridge>()
const nativeConversationListeners = new Set<() => void>()

function publishNativeConversationBridge(next: NativeConversationBridge | null): void {
  nativeConversationBridge = next
  nativeConversationListeners.forEach(listener => listener())
}

function useNativeConversationBridge(): NativeConversationBridge | null {
  return useSyncExternalStore(
    listener => { nativeConversationListeners.add(listener); return () => { nativeConversationListeners.delete(listener) } },
    () => nativeConversationBridge,
    () => null,
  )
}

function NativeConversationBridgeMount({ input, inputActions }: { input: ConversationInputState | undefined; inputActions: ConversationInputActions | undefined }) {
  const draft = useRef('')
  draft.current = input?.draft ?? ''
  useEffect(() => {
    if (inputActions === undefined) return
    const bridge: NativeConversationBridge = { getDraft: () => draft.current, setDraft: text => inputActions.setDraft(text), submit: () => inputActions.submit() }
    nativeConversationBridges.add(bridge)
    publishNativeConversationBridge(bridge)
    return () => {
      nativeConversationBridges.delete(bridge)
      if (nativeConversationBridge === bridge) publishNativeConversationBridge([...nativeConversationBridges].at(-1) ?? null)
    }
  }, [inputActions])
  return null
}

function invokeNativeSkill(bridge: NativeConversationBridge | null, skill: string, prompt: string): boolean {
  if (bridge === null) return false
  bridge.setDraft(`/${skillCommandName(skill)} ${prompt}`)
  bridge.submit()
  return true
}

const designFormats = [
  { id: 'ui', label: '界面原型', icon: '⌘', prompt: '为当前项目建立一个清晰的核心任务界面，先锁定信息层级、状态与主操作。' },
  { id: 'wireframe', label: '线框图', icon: '▦', prompt: '梳理关键流程的低保真线框，标出用户决策点与异常分支。' },
  { id: 'mobile', label: '移动应用', icon: '▯', prompt: '把核心流程压缩为移动端单手可完成的任务路径，并定义反馈状态。' },
  { id: 'brand', label: '品牌视觉', icon: '◇', prompt: '建立品牌视觉方向、字体、色彩和可复用图形语言。' },
  { id: 'deck', label: '演示文稿', icon: '▤', prompt: '为演示文稿建立版式与视觉叙事，产物仍由开放设计工作流执行。' },
  { id: 'document', label: '文档', icon: '▧', prompt: '把内容组织成清晰、可阅读并可继续编辑的视觉文档。' },
] as const

type CreativeSurface = 'design' | 'presentation'
type CreativeExample = {
  id: string
  skillName: string
  kind: string
  title: string
  description: string
  className: string
  prompt: string
  seed: string
}

const creativePreviewClasses: Record<CreativeSurface, readonly string[]> = {
  design: ['sunset', 'blueprint', 'mosaic', 'mobile'],
  presentation: ['violet', 'blue', 'green', 'orange', 'cyan', 'purple'],
}

function isCreativeSkill(skill: RuntimeSkill, surface: CreativeSurface): boolean {
  const searchable = `${skill.name} ${skill.description} ${skill.whenToUse ?? ''}`.toLowerCase()
  if (surface === 'presentation') {
    if (skillCommandName(skill.name) === 'open-design') return false
    return /ppt|presentation|slide|deck|演示|幻灯/u.test(searchable)
  }
  return /open[- ]?design|prototype|landing|dashboard|visual|design|image|原型|落地页|看板|视觉/u.test(searchable)
}

function skillCommandName(name: string): string {
  return name.replace(/^.*\//u, '')
}

function creativeExamples(snapshot: SkillSnapshot, surface: CreativeSurface): CreativeExample[] {
  const classes = creativePreviewClasses[surface]
  return snapshot.skills
    .filter(skill => skill.invocation.userInvocable && isCreativeSkill(skill, surface))
    .map((skill, index) => {
      const title = localizedSkillName(skill.name)
      const description = localizedSkillDescription(skill)
      const seed = localizedSkillWhenToUse(skill)
      return {
        id: `${surface}:${skill.name}`,
        skillName: skill.name,
        kind: localizedProvider(skill.provider),
        title,
        description,
        className: classes[index % classes.length]!,
        prompt: seed,
        seed,
      }
    })
}

function useRuntimeSkills(): SkillSnapshot | null {
  const [snapshot, setSnapshot] = useState<SkillSnapshot | null>(null)
  useEffect(() => {
    let mounted = true
    void optionalApi<SkillSnapshot>('/lumo/api/skills', { complete: false, skills: [] }).then(next => {
      if (mounted) setSnapshot({ ...next.data, ...(next.error === undefined ? {} : { error: next.error }) })
    })
    return () => { mounted = false }
  }, [])
  return snapshot
}

interface SkillDemo { id: string; skill: string; title: string; summary: string; kind: 'image' | 'html'; url: string }
interface SkillDemoSnapshot { complete: boolean; demos: SkillDemo[]; error?: string }

function useSkillDemos(): SkillDemoSnapshot | null {
  const [snapshot, setSnapshot] = useState<SkillDemoSnapshot | null>(null)
  useEffect(() => {
    let mounted = true
    void optionalApi<SkillDemoSnapshot>('/lumo/api/skills/demos', { complete: false, demos: [] }).then(next => {
      if (mounted) setSnapshot({ ...next.data, ...(next.error === undefined ? {} : { error: next.error }) })
    })
    return () => { mounted = false }
  }, [])
  return snapshot
}

/** 原生示例卡片：图片直接 <img>，HTML 示例放进无权限的 iframe，绝不再画 CSS 假预览。 */
function SkillDemoCard({ demo, label, onPick }: { demo: SkillDemo; label: string; onPick: (demo: SkillDemo) => void }) {
  return <button type="button" className="lumo-demo-card" aria-label={`使用原生示例：${demo.title}`} onClick={() => onPick(demo)}>
    <span className="lumo-demo-frame">{demo.kind === 'html'
      ? <iframe src={demo.url} title={demo.title} sandbox="" loading="lazy" tabIndex={-1} />
      : <img src={demo.url} alt="" loading="lazy" />}</span>
    <span><small>{label}</small><b>{demo.title}</b>{demo.summary ? <em>{demo.summary}</em> : null}</span>
  </button>
}

interface GalleryPage { title: string; description: string; url: string }
interface GalleryCollection { id: string; title: string; description: string; category: string; tags: string[]; cover: string; pages: GalleryPage[]; downloads: Array<{ label: string; url: string }> }
interface Gallery { skill: 'ppt-master' | 'open-design'; title: string; source: string; fetchedAt: string; collections: GalleryCollection[] }
type GalleryState = { available: true; gallery: Gallery } | { available: false; skill: string; error: string }

/** 上游技能项目自己公开的完整样例（经宿主同源代理）；不可达时 available=false，页面回退到本地模板。 */
function useUpstreamGallery(skill: Gallery['skill']): GalleryState | null {
  const [state, setState] = useState<GalleryState | null>(null)
  useEffect(() => {
    let mounted = true
    void optionalApi<GalleryState>(`/lumo/api/skills/demos/upstream?skill=${skill}`, { available: false, skill, error: '' }).then(next => {
      if (!mounted) return
      setState(next.data.available ? next.data : { available: false, skill, error: next.error ?? next.data.error })
    })
    return () => { mounted = false }
  }, [skill])
  return state
}

function galleryCategories(collections: GalleryCollection[]): string[] {
  return ['全部', ...new Set(collections.map(item => item.category))]
}

type GalleryFocus = { collection: GalleryCollection; index: number }

/** 资源失败时保留样例信息；查看器内可以重新请求当前图片。 */
function GalleryImage({ src, title, lazy = false, retry = false }: { src: string; title: string; lazy?: boolean; retry?: boolean }) {
  const [failed, setFailed] = useState(false)
  const [attempt, setAttempt] = useState(0)
  return <span className="lumo-gallery-image">{failed
    ? <span className="lumo-gallery-image-error" role="status"><span>预览图片暂时无法加载</span>{retry ? <button type="button" className="lumo-secondary lumo-small" onClick={() => { setFailed(false); setAttempt(value => value + 1) }}>重新加载图片</button> : null}</span>
    : <img key={attempt} src={src} alt={title} loading={lazy ? 'lazy' : 'eager'} onError={() => setFailed(true)} />}</span>
}

/**
 * 完整样例查看器：逐页翻看上游样例（PPT 的每一页幻灯片 / OpenDesign 的每张截图），
 * 底部可直接把当前样例送进创作意图。嵌在工作台对话框内部，Esc 只关闭自己。
 */
function GalleryViewer({ focus, useLabel, onIndex, onClose, onUse }: { focus: GalleryFocus; useLabel: string; onIndex: (index: number) => void; onClose: () => void; onUse: (collection: GalleryCollection, page: GalleryPage) => void }) {
  const ref = useRef<HTMLElement>(null)
  const { collection, index } = focus
  const pages = collection.pages
  const page = pages[Math.min(index, pages.length - 1)] ?? pages[0]!
  useFocusTrap(ref, true)
  const step = (delta: number) => { if (pages.length) onIndex((index + delta + pages.length) % pages.length) }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); step(1) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); step(-1) }
    else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose() }
  }
  return <div className="lumo-gallery-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}>
    <section ref={ref} tabIndex={-1} className="lumo-gallery-viewer" role="dialog" aria-modal="true" aria-label={`样例：${collection.title}`} onKeyDown={onKeyDown}>
      <header><div><span className="lumo-eyebrow">{collection.category}</span><b>{collection.title}</b>{collection.description ? <small>{collection.description}</small> : null}</div><div><span className="lumo-gallery-counter" aria-live="polite">{index + 1} / {pages.length}</span><button type="button" className="lumo-quiet" aria-label="关闭样例查看器" onClick={onClose}>×</button></div></header>
      <div className="lumo-gallery-stage"><button type="button" className="lumo-gallery-nav prev" aria-label="上一页" disabled={pages.length < 2} onClick={() => step(-1)}>‹</button><figure><GalleryImage key={page.url} src={page.url} title={page.title} retry /><figcaption><b>{page.title}</b>{page.description ? <span>{page.description}</span> : null}</figcaption></figure><button type="button" className="lumo-gallery-nav next" aria-label="下一页" disabled={pages.length < 2} onClick={() => step(1)}>›</button></div>
      {pages.length > 1 ? <div className="lumo-gallery-strip" role="tablist" aria-label="样例页面">{pages.map((item, position) => <button type="button" role="tab" key={`${collection.id}:${String(position)}`} aria-selected={position === index} aria-label={`第 ${String(position + 1)} 页：${item.title}`} className={position === index ? 'active' : ''} onClick={() => onIndex(position)}><GalleryImage key={item.url} src={item.url} title="" lazy /></button>)}</div> : null}
      <footer><div>{collection.downloads.map(item => <a key={item.url} href={item.url} target="_blank" rel="noreferrer noopener">{item.label}</a>)}</div><button type="button" className="lumo-primary" onClick={() => onUse(collection, page)}>{useLabel}</button></footer>
    </section>
  </div>
}

function GalleryCollectionCard({ collection, onOpen }: { collection: GalleryCollection; onOpen: (collection: GalleryCollection, index: number) => void }) {
  return <button type="button" className="lumo-gallery-card" aria-label={`查看样例：${collection.title}`} onClick={() => onOpen(collection, 0)}>
    <span className="lumo-demo-frame"><GalleryImage key={collection.cover} src={collection.cover} title="" lazy /></span>
    <span><small>{collection.category} · {collection.pages.length} 页</small><b>{collection.title}</b>{collection.description ? <em>{collection.description}</em> : null}{collection.tags.length ? <span className="lumo-gallery-tags">{collection.tags.slice(0, 4).map(tag => <i key={tag}>{tag}</i>)}</span> : null}</span>
  </button>
}

function GalleryPageCard({ collection, index, onOpen }: { collection: GalleryCollection; index: number; onOpen: (collection: GalleryCollection, index: number) => void }) {
  const page = collection.pages[index]!
  return <button type="button" className="lumo-gallery-card" aria-label={`查看样例：${page.title}`} onClick={() => onOpen(collection, index)}>
    <span className="lumo-demo-frame"><GalleryImage key={page.url} src={page.url} title="" lazy /></span>
    <span><small>{collection.category}</small><b>{page.title}</b>{page.description ? <em>{page.description}</em> : null}</span>
  </button>
}

/** Lumo 创作命令：在原生 `/` 菜单里登记，回车后打开对应工作台，命令后的文字作为创作意图。 */
const lumoCreativeCommands = [
  { name: 'design', label: '开放设计', description: '打开开放设计工作台，用原生 open-design 技能生成设计产物', kind: 'design' as const },
  { name: 'ppt', label: 'PPT 生成', description: '打开 PPT 生成工作台，用原生 ppt-master 模板生成演示文稿', kind: 'presentation' as const },
] as const

type DesignFormatId = (typeof designFormats)[number]['id']
type CreativeSeed = { kind: 'design'; skillName?: string; formatId?: DesignFormatId; brief?: string } | { kind: 'presentation'; skillName?: string; openHash?: boolean; brief?: string }
let creativeSeed: CreativeSeed | null = null

function openCreativeSurface(seed: CreativeSeed): void {
  creativeSeed = seed
  openSurface(seed.kind === 'design' ? 'design' : 'presentation')
}

function takeCreativeSeed<T extends CreativeSeed['kind']>(kind: T): Extract<CreativeSeed, { kind: T }> | null {
  if (creativeSeed?.kind !== kind) return null
  const seed = creativeSeed as Extract<CreativeSeed, { kind: T }>
  creativeSeed = null
  return seed
}

// aria-modal alone does not retain keyboard focus. The command palette is a
// nested modal, so its own trap temporarily supersedes the workbench trap.

function OpenDesignDock(props: ComposerDockProps) {
  return <NativeConversationBridgeMount input={props.input} inputActions={props.inputActions} />
}

// 首页只保留原生对话桥；开放设计 / PPT 生成改由 /design、/ppt 命令或 ⌘K 打开，
// 不再在输入框下方常驻一块创作工作台。
function HeroOpenDesignDock(props: HeroComposerDockProps) {
  return <NativeConversationBridgeMount input={props.input} inputActions={props.inputActions} />
}

function CommandPalette({ open, surface, available, select, close }: { open: boolean; surface: Surface; available: Surface[]; select: (surface: Surface) => void; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const matches = available.filter(item => `${surfaceMeta[item].label} ${surfaceMeta[item].eyebrow}`.toLowerCase().includes(query.trim().toLowerCase()))
  useEffect(() => { if (open) setQuery('') }, [open])
  useEffect(() => { setActiveIndex(index => Math.min(index, Math.max(matches.length - 1, 0))) }, [matches.length])
  useFocusTrap(ref, open)
  if (!open) return null
  const choose = (item: Surface | undefined) => { if (item === undefined) return; select(item); close() }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => matches.length ? (index + 1) % matches.length : 0) }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => matches.length ? (index - 1 + matches.length) % matches.length : 0) }
    else if (event.key === 'Enter') { event.preventDefault(); choose(matches[activeIndex]) }
  }
  return <div ref={ref} className="lumo-command-layer" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) close() }}><section className="lumo-command" role="dialog" aria-modal="true" aria-label="Lumo 工作区菜单"><header><div><span className="lumo-eyebrow">快速跳转</span><b>跳转到工作区</b></div><kbd>ESC</kbd></header><label className="lumo-command-search"><span>⌘</span><input autoFocus value={query} onChange={event => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="搜索工作区" aria-label="搜索工作区" /></label><div className="lumo-command-list">{matches.length ? matches.map((item, index) => <button type="button" key={item} className={surface === item || activeIndex === index ? 'active' : ''} onClick={() => choose(item)}><Glyph surface={item} /><span><b>{surfaceMeta[item].label}</b><small>{surfaceMeta[item].description}</small></span></button>) : <Empty>没有匹配的工作区。</Empty>}</div><footer><span>↑↓ 选择</span><span>Enter 打开</span><span>Esc 关闭</span></footer></section></div>
}

function DeploymentBanner({ deployment }: { deployment: DeploymentState }) {
  const local = deployment.mode === 'local'
  return <section className={`lumo-deployment-banner ${local ? 'local' : deployment.mode}`} aria-label="当前部署形态"><div className="lumo-deployment-mode"><span className="lumo-deployment-signal"><i className="lumo-live-dot" />{local ? '本地模式' : deployment.mode === 'cluster' ? '集群模式' : '单机模式'}</span><b>{deployment.label}</b><small>{deployment.storage === 'sqlite' ? '本机 SQLite' : '服务端 PostgreSQL'}</small></div><div className="lumo-deployment-line"><span>{local ? '本地单机不连接任何分布式中间件' : deployment.mode === 'cluster' ? '集群能力由服务端配置与就绪门禁共同决定' : '服务器单例：服务端组件各一份'}</span>{deployment.middleware.length ? <div className="lumo-middleware-list">{deployment.middleware.map(item => <i key={item}>{item}</i>)}</div> : <strong>无 RocketMQ · 无 Nacos · 无 MinIO · 无 Redis</strong>}</div><span className={`lumo-deployment-gate ${deployment.clusterReady ? 'ready' : ''}`}>{deployment.clusterReady ? '集群已就绪' : deployment.clusterOnly ? '集群未解锁' : local ? '离线优先' : '单机服务'}</span></section>
}

// 磁性按钮：早期「按钮跟随指针」的花式动效。已简化为普通按钮，避免廉价交互噪音。

/** Destructive action that arms on first click and confirms inline.
 *
 * The desktop shell runs in a WKWebView whose UI delegate does not surface
 * window.confirm, so a native confirmation would silently cancel the action.
 */

// 点击火花：早期装饰性粒子动效。已按「克制、不廉价」的视觉方向移除，仅保留定位用
// 的包裹层，避免改变壳内的绝对定位上下文。

function countOnline(data: Overview): number { return Object.values(data.services).filter(service => service.ok).length }
function rowsOf<T>(result: UpstreamResult | undefined, key: string): T[] { const data = result?.data; if (typeof data !== 'object' || data === null) return []; const value = (data as Record<string, unknown>)[key]; return Array.isArray(value) ? value as T[] : [] }

/** Obsidian 打开协议 URI（Mac/Linux/Windows 通用；路径与名称需 url-encode）。 */

/** vault 名 = 目录 basename（Obsidian 以目录名标识 vault）；无配置时为空串。 */

/** vault docId（base64url(相对路径)）→ vault 相对路径（与 Provider 的编码互逆）。 */

function flowVersionChanges(previous: FlowDefinition, current: FlowDefinition): string[] {
  const nodeMap = (definition: FlowDefinition) => new Map((definition.nodes ?? []).filter(node => node.id).map(node => [node.id!, node.operator ?? '']))
  const edgeSet = (definition: FlowDefinition) => new Set((definition.edges ?? []).filter(edge => edge.from && edge.to).map(edge => `${edge.from}→${edge.to}`))
  const beforeNodes = nodeMap(previous); const afterNodes = nodeMap(current)
  const added = [...afterNodes.keys()].filter(id => !beforeNodes.has(id))
  const removed = [...beforeNodes.keys()].filter(id => !afterNodes.has(id))
  const changed = [...afterNodes.entries()].filter(([id, operator]) => beforeNodes.has(id) && beforeNodes.get(id) !== operator).map(([id, operator]) => `${id}（${beforeNodes.get(id)} → ${operator}）`)
  const beforeEdges = edgeSet(previous); const afterEdges = edgeSet(current)
  const edgeAdded = [...afterEdges].filter(edge => !beforeEdges.has(edge))
  const edgeRemoved = [...beforeEdges].filter(edge => !afterEdges.has(edge))
  const changes: string[] = []
  if (added.length) changes.push(`新增节点：${added.join('、')}`)
  if (removed.length) changes.push(`移除节点：${removed.join('、')}`)
  if (changed.length) changes.push(`节点算子变更：${changed.join('、')}`)
  if (edgeAdded.length) changes.push(`新增连线：${edgeAdded.join('、')}`)
  if (edgeRemoved.length) changes.push(`移除连线：${edgeRemoved.join('、')}`)
  return changes.length ? changes : ['两个发布快照的节点、算子和连线一致。']
}

function SkillsSurface({ onClose }: { onClose: () => void }) {
  const [runtime, setRuntime] = useState<SkillSnapshot | null>(null)
  const [governance, setGovernance] = useState<GovernanceSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [creating, setCreating] = useState(false)
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedName, setSelectedName] = useState('')
  const [selectedGoverned, setSelectedGoverned] = useState<GovernedSkill | null>(null)
  const [selectedVersion, setSelectedVersion] = useState<GovernedSkillVersion | null>(null)
  const [versionLoading, setVersionLoading] = useState(false)
  const [publishingVersion, setPublishingVersion] = useState(false)
  const [promotingVersion, setPromotingVersion] = useState(false)
  const [deletingSkill, setDeletingSkill] = useState('')
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
    const description = String(fields.get('description') ?? '').trim()
    const version = String(fields.get('version') ?? '1.0.0').trim()
    const content = String(fields.get('content') ?? '').trim()
    if (!name) { setNotice('请输入技能名称。'); return }
    if (!content) { setNotice('请填写技能版本内容；治理目录不会创建没有来源内容的技能。'); return }
    setCreating(true)
    try {
      await api<GovernedSkill>('/lumo/api/governance/skills', { method: 'POST', body: JSON.stringify({ name, kind, description, current_version: version, content, visibility: 'private' }) })
      form.reset(); setNotice(governance?.local ? `本地技能「${name}」已创建并载入运行时。` : `私有${kind === 'workflow' ? '工作流' : '提示词'}技能「${name}」的 ${version} 内容已进入治理目录。`); await load()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setCreating(false) }
  }
  const viewGoverned = async (skill: GovernedSkill) => {
    setSelectedGoverned(skill); setSelectedVersion(null); setVersionLoading(true)
    try {
      setSelectedVersion(await api<GovernedSkillVersion>(`/lumo/api/governance/skills/${encodeURIComponent(skill.id)}/versions/${encodeURIComponent(skill.current_version)}`))
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setVersionLoading(false) }
  }
  const createVersion = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    if (selectedGoverned === null) return
    const fields = new FormData(event.currentTarget)
    const version = governance?.local ? selectedGoverned.current_version : String(fields.get('version') ?? '').trim()
    const content = String(fields.get('content') ?? '').trim()
    if (!version || !content) { setNotice('新版本号和内容均为必填。'); return }
    setPublishingVersion(true)
    try {
      if (governance?.local) {
        await api<GovernedSkill>(`/lumo/api/governance/skills/${encodeURIComponent(selectedGoverned.id)}`, { method: 'PATCH', body: JSON.stringify({ description: String(fields.get('description') ?? '').trim(), content }) })
        const next = await api<GovernedSkillVersion>(`/lumo/api/governance/skills/${encodeURIComponent(selectedGoverned.id)}/versions/${encodeURIComponent(version)}`)
        setSelectedVersion(next)
        setNotice(`本地技能「${selectedGoverned.name}」已修改并重新载入运行时。`)
      } else {
        const next = await api<GovernedSkillVersion>(`/lumo/api/governance/skills/${encodeURIComponent(selectedGoverned.id)}/versions`, { method: 'POST', body: JSON.stringify({ version, content }) })
        setSelectedVersion(next); setSelectedGoverned({ ...selectedGoverned, current_version: next.version }); form.reset()
        setNotice(`已保存不可覆盖的治理版本 ${next.version}；它尚未自动发布到运行时。`)
      }
      await load()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setPublishingVersion(false) }
  }
  const deleteGoverned = async (skill: GovernedSkill) => {
    setDeletingSkill(skill.id)
    try {
      await api(`/lumo/api/governance/skills/${encodeURIComponent(skill.id)}`, { method: 'DELETE' })
      if (selectedGoverned?.id === skill.id) { setSelectedGoverned(null); setSelectedVersion(null) }
      setNotice(`本地技能「${skill.name}」已删除。`)
      await load()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setDeletingSkill('') }
  }
  const publishVersion = async () => {
    if (selectedGoverned === null || selectedVersion === null) return
    setPromotingVersion(true)
    try {
      const published = await api<GovernedSkill>(`/lumo/api/governance/skills/${encodeURIComponent(selectedGoverned.id)}/versions/${encodeURIComponent(selectedVersion.version)}/publish`, { method: 'POST' })
      setSelectedGoverned(published)
      setNotice(`已将不可变版本 ${selectedVersion.version} 发布为运行时快照。节点仍需由 Provisioner 对账并安装后才会实际调用。`)
      await load()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setPromotingVersion(false) }
  }
  const governed = rowsOf<GovernedSkill>(governance?.catalog, 'skills')
  const effective = rowsOf<GovernedSkill>(governance?.effective, 'skills')
  const skills = runtime?.skills ?? []
  const filteredSkills = useMemo(() => skills.filter(skill => `${localizedSkillName(skill.name)} ${localizedSkillDescription(skill)} ${localizedProvider(skill.provider)}`.toLowerCase().includes(filter.toLowerCase())), [filter, skills])
  const selected = skills.find(skill => skill.name === selectedName) ?? filteredSkills[0]
  return <div className="lumo-surface lumo-skills-surface lumo-workspace-page">
    <WorkspaceHero surface="skills" onClose={onClose} statement="查看运行时技能，管理可用版本。" description="技能目录、调用策略和治理版本集中在此处。">
      <div className={'lumo-workspace-status' + (error ? ' degraded' : '')}><span>技能状态</span><b><i aria-hidden="true" />{loading ? '正在同步' : error ? '目录不可用' : '目录已同步'}</b><dl><div><dt>运行时</dt><dd>{skills.length}</dd></div><div><dt>模型可调用</dt><dd>{skills.filter(skill => skill.invocation.modelInvocable).length}</dd></div><div><dt>治理目录</dt><dd>{governed.length}</dd></div></dl><small>{governance?.local ? '本地技能管理' : governance?.catalog.ok ? '治理服务已连接' : '当前部署无治理目录'}</small></div>
    </WorkspaceHero>
    <div className="lumo-workspace-toolbar"><button type="button" className="lumo-button lumo-secondary" onClick={() => openSurface('connectors')}>连接器管理</button><BusyButton className="lumo-secondary" busy={loading} onClick={() => void load()}>重新同步</BusyButton></div>
    {error ? <Notice error>{error}</Notice> : null}{notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}
    <div className="lumo-metric-grid"><Metric label="运行时可见" value={String(skills.length)} note={runtime?.complete === false ? '目录仍在收敛' : '目录已完整'} tone="mint" /><Metric label={governance?.local ? '本地自建' : '治理目录'} value={String(governed.length)} note={governance?.local ? '保存在桌面数据目录' : governance?.catalog.ok ? '集群目录' : '当前模式不可用'} /><Metric label="模型可调用" value={String(skills.filter(skill => skill.invocation.modelInvocable).length)} note="调用策略" /><Metric label="当前生效" value={String(effective.length)} note="生效策略" /></div>
    <Section title="运行时技能" meta={loading ? '正在读取技能目录' : '当前运行时快照'} actions={<label className="lumo-filter"><span>筛选</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="技能名或提供方" /></label>}>
      {loading ? <div className="lumo-skill-grid">{[0, 1, 2, 3].map(index => <div className="lumo-skeleton-skill" key={index}><span /><div><b /><i /><i /></div></div>)}</div> : filteredSkills.length ? <div className="lumo-skill-layout"><div className="lumo-skill-grid">{filteredSkills.map((skill, index) => <SpotlightCard className={`lumo-skill-card ${selected?.name === skill.name ? 'selected' : ''}`} index={index} key={skill.name} onClick={() => setSelectedName(skill.name)}><span className="lumo-skill-mark">{localizedSkillName(skill.name).slice(0, 1)}</span><div><b>{localizedSkillName(skill.name)}</b><p>{localizedSkillDescription(skill)}</p><small>{localizedSkillWhenToUse(skill)}</small><footer><i>{localizedProvider(skill.provider)}</i><span>{skill.invocation.modelInvocable ? '模型可调用' : '仅用户可调用'}</span></footer></div></SpotlightCard>)}</div><aside className="lumo-inspector lumo-skill-inspector">{selected ? <><span className="lumo-inspector-label">技能检查</span><h3>技能详情 · {localizedSkillName(selected.name)}</h3><p>{localizedSkillDescription(selected)}</p><div className="lumo-detail-stack"><div><span>技能状态</span><b>运行时目录</b></div><div><span>来源</span><b>{localizedSource(selected.source)}</b></div><div><span>提供方</span><b>{localizedProvider(selected.provider)}</b></div><div><span>用户可调用</span><b>{selected.invocation.userInvocable ? '允许' : '关闭'}</b></div><div><span>模型可调用</span><b>{selected.invocation.modelInvocable ? '允许' : '关闭'}</b></div></div></> : <Empty>选择技能查看详细策略。</Empty>}</aside></div> : <Empty>当前技能目录没有匹配项。</Empty>}
    </Section>
    <Section title={governance?.local ? '创建本地技能' : '创建治理技能'} meta={governance?.local ? '保存后立即进入本机运行时' : '创建首个不可覆盖版本；初始为未发布草稿'}><form className="lumo-governance-form lumo-governance-skill-form lumo-skill-compose" onSubmit={create}><label><span>技能名称</span><input name="name" maxLength={120} placeholder="例如：campaign-review" /></label><label><span>技能类型</span><select name="kind" defaultValue="prompt"><option value="prompt">提示词技能</option><option value="workflow">工作流技能</option></select></label><label><span>首个版本</span><input name="version" defaultValue="1.0.0" maxLength={64} /></label><label className="wide"><span>用途说明</span><input name="description" maxLength={500} placeholder="说明它解决什么问题，以及何时使用" /></label><label className="wide"><span>版本内容</span><textarea name="content" aria-label="技能版本内容" maxLength={131072} rows={7} placeholder={'---\nname: campaign-review\ndescription: 审核营销活动内容\n---\n\n写入提示词、工作流约定或 Markdown 技能说明。'} /></label><BusyButton type="submit" busy={creating} className="lumo-primary">{governance?.local ? '创建技能' : '保存技能草稿'}</BusyButton></form><p className="lumo-form-hint">{governance?.local ? '技能保存在桌面应用数据目录，创建或修改后会立即刷新本机技能列表。' : '保存只创建治理草稿。发布要求内容含有效 SKILL.md frontmatter（名称须与技能名称一致、必须有 description）；realm_admin 选择的发布源仍须在受保护发布环境中签名为 Registry 制品，之后 Provisioner 才会验签、对账并安装到节点。'}</p></Section>
    <Section title={governance?.local ? '本地技能目录' : '治理技能目录'} meta={governance?.catalog.ok ? `${governed.length} 条` : `HTTP ${governance?.catalog.status ?? '未连接'}`}>
      {governed.length ? <div className="lumo-table-list lumo-skill-admin-list">{governed.map(skill => <div key={skill.id} className={selectedGoverned?.id === skill.id ? 'selected' : ''}><span><b>{localizedSkillName(skill.name)}</b><small>{skill.description || '未填写用途说明'} · 创建者 {skill.created_by}</small></span><i>{localizedSkillKind(skill.kind)}</i><em>{localizedVisibility(skill.visibility)} · 版本 {skill.current_version}</em><span className="lumo-row-actions"><button type="button" className="lumo-button lumo-secondary lumo-version-open" onClick={() => void viewGoverned(skill)}>{governance?.local ? '编辑' : '查看内容'}</button>{governance?.local ? <ConfirmButton busy={deletingSkill === skill.id} confirmLabel="确认删除" onConfirm={() => deleteGoverned(skill)}>删除</ConfirmButton> : null}</span></div>)}</div> : <Empty>{governance?.catalog.error || (governance?.local ? '尚未创建本地技能。' : '当前部署模式没有治理技能目录，运行时技能目录仍可独立使用。')}</Empty>}
    </Section>
    {selectedGoverned ? <Section title={`${governance?.local ? '编辑本地技能' : '治理版本'} · ${localizedSkillName(selectedGoverned.name)}`} meta={versionLoading ? '正在读取来源内容' : `当前版本 ${selectedGoverned.current_version}`}><div className="lumo-governed-version-layout"><div className="lumo-governed-source"><p>{selectedVersion ? `来源摘要 ${selectedVersion.digest} · 创建者 ${selectedVersion.created_by}` : '版本内容会显示在这里。'}</p><pre>{selectedVersion?.content ?? (versionLoading ? '正在读取…' : '未能读取该版本内容。')}</pre><small>{governance?.local ? '保存修改后，本机技能运行时会立即刷新。' : selectedGoverned.published_version === selectedVersion?.version ? `此版本已选为治理运行时源${selectedGoverned.published_digest ? ` · ${selectedGoverned.published_digest}` : ''}；还需由受信任发布器签名为 Registry Bundle，节点安装事实以 Provisioner 回报为准。` : '这是治理草稿内容，尚未成为可构建的运行时源。'}</small></div><form className="lumo-stacked-form lumo-version-form" onSubmit={createVersion}><b>{governance?.local ? '修改当前技能' : '保存新草稿版本'}</b>{governance?.local ? <label><span>用途说明</span><input name="description" maxLength={500} defaultValue={selectedGoverned.description ?? ''} /></label> : <label><span>新版本号</span><input name="version" maxLength={64} placeholder="例如：1.1.0" /></label>}<label><span>{governance?.local ? '技能内容' : '新版本内容'}</span><textarea key={selectedVersion?.digest ?? selectedGoverned.id} name="content" aria-label={governance?.local ? '编辑技能内容' : '新技能版本内容'} maxLength={131072} rows={7} defaultValue={governance?.local ? selectedVersion?.content ?? '' : undefined} placeholder={'---\nname: campaign-review\ndescription: 审核营销活动内容\n---\n\n写入技能说明。'} /></label><div className="lumo-form-actions"><BusyButton type="submit" busy={publishingVersion} className="lumo-primary">{governance?.local ? '保存修改' : '保存新版本'}</BusyButton>{governance?.local ? null : <BusyButton type="button" busy={promotingVersion} disabled={selectedVersion === null || selectedVersion.version === selectedGoverned.published_version} className="lumo-secondary" onClick={() => void publishVersion()}>发布为运行时源</BusyButton>}</div><small>{governance?.local ? '名称用于命令调用，创建后不可修改；用途说明和技能内容可以随时编辑。' : '仅创建者或 realm_admin 可以读取和写入来源；发布运行时源仅限 realm_admin。签名制品构建与节点实际安装分别由受保护发布器和 Provisioner 完成。'}</small></form></div></Section> : null}
    {selectedGoverned && !governance?.local ? <SkillAccessPanel key={selectedGoverned.id} request={api} skillID={selectedGoverned.id} version={selectedVersion?.version ?? selectedGoverned.current_version} /> : null}
  </div>
}

const SKILLHUB_TABS: SkillHubTab[] = ['专家', '技能']
const SKILLHUB_KIND: Record<SkillHubTab, SkillHubKind> = { '专家': 'pack', '技能': 'skill' }
/** 与 SkillHub 官网一致的分页大小：服务端单页上限 100，24 一页在 4 列网格里是 6 行。 */
const SKILLHUB_PAGE_SIZE = 24

const skillhubTabMeta: Record<SkillHubTab, { label: string; meta: string; empty: string; placeholder: string }> = {
  '专家': { label: '专家', meta: '带角色与技能组合的协作伙伴', empty: '没有匹配的专家。', placeholder: '搜索专家名称、职责或场景…' },
  '技能': { label: '技能', meta: '可安装的单项能力', empty: 'SkillHub 没有匹配的技能。', placeholder: '搜索技能，例如「文档」「爬虫」「PPT」…' },
}

const skillhubTagAccent: Record<string, string> = {
  '办公效率': 'blue', '内容创作': 'orange', '开发编程': 'violet', '数据分析': 'cyan', '设计多媒体': 'orange', 'AI Agent': 'mint', '知识管理': 'green', '生活服务': 'orange', 'Pay Skill': 'cyan',
  '科技': 'violet', '医疗': 'green', '人力资源': 'blue', '金融': 'cyan', '法律': 'blue', '媒体': 'orange', '玄学': 'violet', '内容': 'orange',
  '模型推理': 'violet', '客户端': 'blue', '工作流': 'mint', '记忆': 'green', '联网工具': 'cyan', '安全管理': 'orange', '趣味换装': 'orange',
}

function metricValue(value: number): string {
  if (value >= 10000) return (value / 10000).toFixed(1) + '万'
  return String(value)
}

function mentionInComposer(bridge: NativeConversationBridge | null, names: string[]): boolean {
  if (bridge === null || names.length === 0) return false
  const draft = bridge.getDraft()
  const existing = new Set(draft.split(/\s+/))
  const tokens = names.map(name => '/' + name).filter(token => !existing.has(token))
  if (tokens.length) bridge.setDraft(draft + (draft && !/\s$/.test(draft) ? ' ' : '') + tokens.join(' ') + ' ')
  return true
}

const SEED_SKILLHUB_FILTERS: Record<SkillHubTab, string[]> = {
  '专家': ['全部', '金融', '科技', '设计', '营销', '法律', '学术', '教育', '人力资源', '电商', '媒体', '医疗', '玄学'],
  '技能': ['全部', '办公效率', '开发编程', '知识管理', '生活服务', '数据分析'],
}

function SkillHubMark({ icon, name, tone }: { icon?: string | undefined; name: string; tone: string }) {
  const [broken, setBroken] = useState(false)
  if (icon && !broken) return <span className="lumo-skillhub-mark has-icon" data-tone={tone}><img src={icon} alt="" loading="lazy" onError={() => setBroken(true)} /></span>
  return <span className="lumo-skillhub-mark" data-tone={tone}>{name.replace(/^[\w.-]+\//, '').slice(0, 1).toUpperCase()}</span>
}

function SkillHubCard({ children, tone, index }: { children: ReactNode; tone: string; index: number }) {
  return <article className="lumo-skillhub-card" data-tone={tone} style={{ '--lumo-order': String(index) } as CSSProperties}>{children}</article>
}

/**
 * 宿主 dsh 当前生效的模型（provider + model）。
 *
 * 创建 / 编辑专家不再让用户手填 Provider 与模型，而是沿用「当前选中的模型」。
 * 该状态归宿主所有：`ctx.sessions` 给出当前会话，`ctx.modelDirectories` 给出该会话
 * 解析后的生效模型（未显式选过时回落到模型目录的默认值）。
 *
 * Lumo 的 Surface 拿不到 ctx（`SkillHubSurface()` 无 props，`shell.overlay` 的
 * PropsRuntime 只带 input / inputActions），所以由 `apply()` 在装配时把这个解析器
 * 挂到模块级变量上。**按需解析而不是订阅**：表单打开与提交各解析一次，
 * 避免为一个只读展示去维护跨插件的订阅生命周期。
 */
interface HostModelSelection { provider: string; model: string }

let hostModelResolver: (() => HostModelSelection | undefined) | undefined

function resolveHostModel(): HostModelSelection | undefined {
  try { return hostModelResolver?.() } catch { return undefined }
}

function SkillHubSurface({ onClose }: { onClose: () => void }) {
  const capability = useClusterCapabilities(api)
  const [tab, setTab] = useState<SkillHubTab>('专家')
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('全部')
  // 输入 320ms 防抖后提交；切 tab 时立即清空，避免带着旧关键词查询新 tab。
  const [committedQuery, setCommittedQuery] = useState('')
  const [catalog, setCatalog] = useState<SkillHubCatalog | null>(null)
  const [result, setResult] = useState<SkillHubSearchResult | null>(null)
  const [skills, setSkills] = useState<SkillHubSkill[]>([])
  const [packs, setPacks] = useState<SkillHubPack[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [loading, setLoading] = useState(true)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [installing, setInstalling] = useState('')
  const [experts, setExperts] = useState<AgentPreset[]>([])
  const [expertDirectoryState, setExpertDirectoryState] = useState<OptionalApiResult<{ agent_presets: AgentPreset[] }>['state']>('unavailable')
  const [expertDirectoryError, setExpertDirectoryError] = useState('')
  const [expertDirectoryLocal, setExpertDirectoryLocal] = useState(false)
  const [createExpertOpen, setCreateExpertOpen] = useState(false)
  const [creatingExpert, setCreatingExpert] = useState(false)
  const [editingExpert, setEditingExpert] = useState<AgentPreset | null>(null)
  const [savingExpert, setSavingExpert] = useState(false)
  const [deletingExpert, setDeletingExpert] = useState('')
  // 宿主当前选中的模型；解析不到时保留手填字段（否则服务端 requiredString 会直接 400）。
  const [hostModel, setHostModel] = useState<HostModelSelection | undefined>(undefined)
  const bridge = useNativeConversationBridge()
  const allLabel = '全部'
  // 表单打开时解析一次宿主当前模型；提交时会再解析一次（见 createExpert / updateExpert），
  // 这样表单开着时用户切换了模型也不会写进过期的值。
  useEffect(() => {
    if (!createExpertOpen && editingExpert === null) { setHostModel(undefined); return }
    setHostModel(resolveHostModel())
  }, [createExpertOpen, editingExpert])
  const listEndRef = useRef<HTMLDivElement>(null)
  const loadMoreRef = useRef<() => void>(() => {})
  const searchSeq = useRef(0)

  useEffect(() => { const timer = window.setTimeout(() => setCommittedQuery(query.trim()), 320); return () => window.clearTimeout(timer) }, [query])

  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [next, expertDirectory] = await Promise.all([
        api<SkillHubCatalog>('/lumo/api/skillhub/catalog'),
        optionalApi<{ agent_presets: AgentPreset[]; local?: boolean }>('/lumo/api/agent-presets', { agent_presets: [], local: false }),
      ])
      setCatalog(next)
      setNotice(next.notice ?? '')
      setExperts(expertDirectory.data.agent_presets ?? [])
      setExpertDirectoryLocal(expertDirectory.data.local === true)
      setExpertDirectoryState(expertDirectory.state)
      setExpertDirectoryError(expertDirectory.error ?? '')
    }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])

  // 列表恒为 SkillHub 实时分页（浏览也是第 1 页）：服务端按 page/pageSize 翻页并
  // 返回真实 total，因此 tab/关键词/分类变化时重载第 1 页即可，滚动由哨兵追加。
  useEffect(() => {
    const seq = ++searchSeq.current
    setSearching(true)
    const params = new URLSearchParams({ kind: SKILLHUB_KIND[tab], q: committedQuery, category: filter === allLabel ? '' : filter, page: '1', limit: String(SKILLHUB_PAGE_SIZE) })
    api<SkillHubSearchResult>('/lumo/api/skillhub/search?' + params.toString())
      .then(next => {
        if (searchSeq.current !== seq) return
        setResult(next); setSkills(next.skills ?? []); setPacks(next.packs ?? []); setTotal(next.total); setPage(next.page ?? 1)
      })
      .catch(reason => {
        if (searchSeq.current !== seq) return
        setResult(null); setSkills([]); setPacks([]); setTotal(0); setPage(1)
        setNotice(reason instanceof Error ? reason.message : String(reason))
      })
      .finally(() => { if (searchSeq.current === seq) setSearching(false) })
  }, [tab, committedQuery, filter, allLabel])

  const install = async (kind: SkillHubKind, id: string, name: string) => {
    if (installing !== '' || catalog?.canInstall === false) return
    setInstalling(kind + ':' + id); setNotice('')
    try {
      const next = await api<SkillHubCatalog>('/lumo/api/skillhub/install', { method: 'POST', body: JSON.stringify({ kind, id }) })
      setCatalog(next)
      setNotice(next.notice ?? '「' + name + '」已安装。')
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason))
      try { setCatalog(await api<SkillHubCatalog>('/lumo/api/skillhub/catalog?cached=1')) } catch { /* keep the installation error */ }
    }
    finally { setInstalling('') }
  }

  const createExpert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (creatingExpert) return
    const form = event.currentTarget
    const fields = new FormData(form)
    const name = String(fields.get('name') ?? '').trim()
    const description = String(fields.get('description') ?? '').trim()
    // 沿用宿主当前选中的模型；解析不到时才回落到手填字段（那时表单会显示这两个输入）。
    const active = resolveHostModel() ?? hostModel
    const provider = active?.provider ?? String(fields.get('provider') ?? '').trim()
    const modelRef = active?.model ?? String(fields.get('model_ref') ?? '').trim()
    const outputProfile = String(fields.get('output_profile') ?? TEXT_OUTPUT_PROFILE)
    const systemPromptRef = String(fields.get('system_prompt_ref') ?? '').trim()
    if (!name || !description) {
      setNotice('请填写专家名称与职责说明。')
      return
    }
    if (!provider || !modelRef) {
      setNotice('没有解析到当前选中的模型，请先选择模型，或填写 Provider 与模型。')
      return
    }
    const profileError = agentOutputProfileError(outputProfile, { system_prompt_ref: systemPromptRef, connector_ids: [], knowledge_space_ids: [] }, capability?.clusterReady === true && !expertDirectoryLocal)
    if (profileError) { setNotice(profileError); return }
    setCreatingExpert(true); setNotice('')
    try {
      const expert = await api<AgentPreset>('/lumo/api/agent-presets', {
        method: 'POST',
        body: JSON.stringify({
          name, description, provider, model_ref: modelRef,
          project_id: String(fields.get('project_id') ?? '').trim(),
          system_prompt_ref: systemPromptRef, output_profile: outputProfile,
          connector_ids: [], knowledge_space_ids: [], max_concurrency: 1,
          max_budget_cents: 0, timeout_seconds: 3600, max_delegation_depth: 0,
        }),
      })
      setExperts(current => [...current.filter(item => item.id !== expert.id), expert])
      setExpertDirectoryState('ok'); setExpertDirectoryError('')
      form.reset(); setCreateExpertOpen(false)
      setNotice(`专家「${name}」已创建，可在项目中继续配置技能与资源。`)
    } catch (reason) {
      setNotice(reason instanceof Error ? reason.message : String(reason))
    } finally { setCreatingExpert(false) }
  }

  const updateExpert = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (editingExpert === null || savingExpert) return
    const fields = new FormData(event.currentTarget)
    // 与创建一致：沿用宿主当前选中的模型，解析不到才回落到手填字段。
    const active = resolveHostModel() ?? hostModel
    const outputProfile = String(fields.get('output_profile') ?? TEXT_OUTPUT_PROFILE)
    const systemPromptRef = String(fields.get('system_prompt_ref') ?? '').trim()
    const profileError = agentOutputProfileError(outputProfile, { system_prompt_ref: systemPromptRef, connector_ids: editingExpert.connector_ids, knowledge_space_ids: editingExpert.knowledge_space_ids }, capability?.clusterReady === true && !expertDirectoryLocal)
    if (profileError) { setNotice(profileError); return }
    setSavingExpert(true); setNotice('')
    try {
      const updated = await api<AgentPreset>(`/lumo/api/agent-presets/${encodeURIComponent(editingExpert.id)}`, {
        method: 'PATCH',
        body: JSON.stringify({
          revision: editingExpert.revision,
          name: String(fields.get('name') ?? '').trim(), description: String(fields.get('description') ?? '').trim(),
          provider: active?.provider ?? String(fields.get('provider') ?? '').trim(), model_ref: active?.model ?? String(fields.get('model_ref') ?? '').trim(),
          project_id: String(fields.get('project_id') ?? '').trim(), system_prompt_ref: systemPromptRef, output_profile: outputProfile,
          max_concurrency: Number(fields.get('max_concurrency') ?? 1),
        }),
      })
      setExperts(current => current.map(item => item.id === updated.id ? updated : item))
      setEditingExpert(null)
      setNotice(`专家「${updated.name}」已更新。`)
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setSavingExpert(false) }
  }

  const deleteExpert = async (expert: AgentPreset) => {
    setDeletingExpert(expert.id); setNotice('')
    try {
      await api(`/lumo/api/agent-presets/${encodeURIComponent(expert.id)}`, { method: 'DELETE' })
      setExperts(current => current.filter(item => item.id !== expert.id))
      if (editingExpert?.id === expert.id) setEditingExpert(null)
      setNotice(`专家「${expert.name}」已删除。`)
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setDeletingExpert('') }
  }

  const installedSkills = new Set(catalog?.installed.skills ?? [])
  const installedPacks = new Set(catalog?.installed.packs ?? [])
  const installedPlugins = new Set(catalog?.installed.plugins ?? [])

  const categoryKey = tab === '技能' ? 'skills' : 'packs'
  const filters = catalog?.categories?.[categoryKey]?.length ? catalog.categories[categoryKey] : SEED_SKILLHUB_FILTERS[tab]

  const loadedCount = tab === '技能' ? skills.length : packs.length
  const hasMore = total > 0 && loadedCount < total

  const mention = (kind: SkillHubKind, id: string) => {
    const names = catalog?.installed.commands?.[`${kind}:${id}`] ?? []
    if (mentionInComposer(bridge, names)) {
      window.dispatchEvent(new CustomEvent(CLOSE_EVENT))
    } else {
      setNotice('请先选择工作区并创建会话，再把任务交给它。')
    }
  }

  // 底哨兵：滚近末尾就翻页追加。服务端没有总页数，按 loaded < total 判断；排序分页
  // 可能漂移，追加时按 id 去重。jsdom 没有 IntersectionObserver 时跳过（测试确定性）。
  useEffect(() => {
    if (!hasMore || typeof IntersectionObserver === 'undefined') return
    const node = listEndRef.current
    if (node === null) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) loadMoreRef.current()
    }, { root: null, rootMargin: '320px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [hasMore, page, searching, tab, committedQuery, filter])

  const loadMore = () => {
    if (searching || !hasMore) return
    const seq = ++searchSeq.current
    const nextPage = page + 1
    setSearching(true)
    const params = new URLSearchParams({ kind: SKILLHUB_KIND[tab], q: committedQuery, category: filter === allLabel ? '' : filter, page: String(nextPage), limit: String(SKILLHUB_PAGE_SIZE) })
    api<SkillHubSearchResult>('/lumo/api/skillhub/search?' + params.toString())
      .then(next => {
        if (searchSeq.current !== seq) return
        setResult(next); setTotal(next.total); setPage(next.page ?? nextPage)
        const seenSkills = new Set(skills.map(item => item.id))
        const seenPacks = new Set(packs.map(item => item.id))
        const nextSkills = (next.skills ?? []).filter(item => !seenSkills.has(item.id))
        const nextPacks = (next.packs ?? []).filter(item => !seenPacks.has(item.id))
        setSkills(current => [...current, ...nextSkills])
        setPacks(current => [...current, ...nextPacks])
        // 深层翻页若返回空（或全被去重），说明 service 已到底：把 total 收敛到已加载数防止空转。
        if (nextSkills.length + nextPacks.length === 0) setTotal(loadedCount)
      })
      .catch(reason => { if (searchSeq.current === seq) setNotice(reason instanceof Error ? reason.message : String(reason)) })
      .finally(() => { if (searchSeq.current === seq) setSearching(false) })
  }
  loadMoreRef.current = loadMore

  const toneFor = (value: string) => skillhubTagAccent[value] ?? 'mint'
  const installedCount = installedSkills.size + installedPacks.size + installedPlugins.size
  const source = result?.source ?? catalog?.source
  const sourceLabel = source === 'skillhub' ? 'SkillHub 实时' : source === 'cache' ? '本地缓存' : source === 'seed' ? '内置示例' : '同步中'
  const expertDirectoryMessage = expertDirectoryError.trim() === 'CLUSTER_ONLY'
    ? '当前部署未启用专属专家目录；创建和管理专属专家需集群模式。'
    : expertDirectoryError || '当前部署只提供 SkillHub 专家模板；连接治理服务后可创建和管理专属专家。'
  const syncedAt = catalog ? new Date(catalog.generatedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : ''
  const switchTab = (next: SkillHubTab) => { setTab(next); setCreateExpertOpen(false); setEditingExpert(null); setQuery(''); setFilter('全部'); setCommittedQuery(''); setSkills([]); setPacks([]); setTotal(0); setPage(1); setResult(null) }
  const visibleExperts = experts.filter(expert => filter === allLabel && `${expert.name} ${expert.description ?? ''} ${expert.provider} ${expert.model_ref}`.toLowerCase().includes(query.trim().toLowerCase()))

  const actions = (kind: SkillHubKind, id: string, name: string, installed: boolean, label = '安装') => {
    const busy = installing === (kind + ':' + id)
    if (installed) return <><span className="lumo-skillhub-installed">已安装</span>{catalog?.installed.commands?.[`${kind}:${id}`]?.length ? <button type="button" className="lumo-button lumo-secondary" onClick={() => mention(kind, id)} aria-label={'在对话中使用 ' + name}>用于对话</button> : <span className="lumo-skillhub-installed">自动调用</span>}</>
    if (catalog?.canInstall === false) return <span className="lumo-skillhub-installed">仅管理员可安装</span>
    if (busy) return <span className="lumo-skillhub-installing"><BusyButton className="lumo-primary" busy>{label}</BusyButton><em>正在安装…</em><span className="lumo-skillhub-progress" role="progressbar" aria-label={`正在安装 ${name}`} aria-valuetext="安装中"><i /></span></span>
    return <BusyButton className="lumo-primary" disabled={installing !== ''} onClick={() => void install(kind, id, name)}>{label}</BusyButton>
  }

  return <div className="lumo-surface lumo-skillhub-surface lumo-workspace-page">
    <WorkspaceHero surface="skillhub" onClose={onClose} statement="找到合适的专家，按需补齐技能。" description="先选专家或单项技能，再按领域与关键词收窄目录。安装状态来自当前工作区，不把目录收录误作已可用。">
      <div className={'lumo-workspace-status' + (error ? ' degraded' : '')}>
        <span>目录状态</span><b><i aria-hidden="true" />{sourceLabel}</b>
        <dl><div><dt>模板</dt><dd>{catalog ? metricValue(catalog.counts.packs) : '—'}</dd></div><div><dt>技能</dt><dd>{catalog ? metricValue(catalog.counts.skills) : '—'}</dd></div><div><dt>已安装</dt><dd>{installedCount}</dd></div></dl>
        <small>{syncedAt ? `${syncedAt} 同步 · ` : ''}专属专家目录{expertDirectoryState === 'ok' ? '已连接' : '未连接'}</small>
      </div>
    </WorkspaceHero>
    {error ? <Notice error>{error}</Notice> : null}
    {notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}

    <div className="lumo-skillhub-modebar">
      <div className="lumo-skillhub-tabs" role="tablist" aria-label="技能中心目录">{SKILLHUB_TABS.map(item => <button type="button" role="tab" aria-label={item} aria-selected={item === tab} key={item} className={item === tab ? 'active' : ''} onClick={() => switchTab(item)}><b>{item}<span>{catalog ? metricValue(item === '技能' ? catalog.counts.skills : catalog.counts.packs + experts.length) : '–'}</span></b><small>{item === '专家' ? '组合多个技能，处理完整任务' : '按需安装，交给当前对话调用'}</small></button>)}</div>
      <div className="lumo-skillhub-mode-actions">{tab === '专家' ? <button type="button" className="lumo-button lumo-primary lumo-new-expert-button" disabled={expertDirectoryState !== 'ok'} title={expertDirectoryState === 'ok' ? undefined : expertDirectoryMessage} onClick={() => { setEditingExpert(null); setCreateExpertOpen(open => !open) }}>{createExpertOpen ? '收起创建' : '＋ 新建专家'}</button> : <button type="button" className="lumo-button lumo-secondary" onClick={() => openSurface('skills')}>管理已安装技能</button>}<BusyButton className="lumo-secondary" busy={loading} onClick={() => void load()}>刷新</BusyButton></div>
    </div>

    {tab === '专家' && createExpertOpen ? <form className="lumo-expert-create" onSubmit={createExpert}>
      <header><div><span>CREATE EXPERT</span><h2>创建一个专属专家</h2><p>先定义职责和模型，创建后可在项目中继续配置技能、知识与连接器。</p></div><button type="button" className="lumo-quiet" onClick={() => setCreateExpertOpen(false)} aria-label="关闭新建专家">×</button></header>
      <div className="lumo-expert-create-grid">
        <label><span>专家名称</span><input name="name" required maxLength={160} placeholder="例如：合同复核专家" /></label>
        {hostModel === undefined
          ? <>
            <label><span>Provider</span><select name="provider" defaultValue="openai"><option value="openai">OpenAI</option><option value="anthropic">Anthropic</option><option value="deepseek">DeepSeek</option><option value="custom">自定义 Provider</option></select></label>
            <label><span>模型</span><input name="model_ref" required defaultValue="gpt-5" placeholder="例如：gpt-5" /></label>
          </>
          : <div className="wide lumo-expert-model"><span>模型</span><p>沿用当前选中的模型 <b>{hostModel.provider}</b> · <b>{hostModel.model}</b></p></div>}
        <label><span>项目范围</span><input name="project_id" placeholder="留空则对整个 Realm 生效" /></label>
        <AgentOutputProfileField allowFiles={capability?.clusterReady === true && !expertDirectoryLocal} />
        <label className="wide"><span>职责说明</span><textarea name="description" required maxLength={500} rows={3} placeholder="说明它负责什么、如何判断结果，以及哪些事项需要交回给人。" /></label>
        <label className="wide"><span>系统提示引用 <i>可选</i></span><input name="system_prompt_ref" maxLength={256} placeholder="受保护配置中的引用名称" /></label>
      </div>
      <footer><small>{expertDirectoryState === 'ok' ? '专家会保存为可管理的 Agent 资产。' : '当前部署尚未连接专家资产目录，提交时会保留明确错误。'}</small><span><button type="button" className="lumo-button lumo-secondary" onClick={() => setCreateExpertOpen(false)}>取消</button><BusyButton type="submit" busy={creatingExpert} className="lumo-primary">创建专家</BusyButton></span></footer>
    </form> : null}

    {tab === '专家' && editingExpert ? <form className="lumo-expert-create" onSubmit={updateExpert}>
      <header><div><span>EDIT EXPERT</span><h2>编辑专家</h2><p>修改会保存到专家目录，并立即反映在当前列表中。</p></div><button type="button" className="lumo-quiet" onClick={() => setEditingExpert(null)} aria-label="关闭编辑专家">×</button></header>
      <div className="lumo-expert-create-grid">
        <label><span>专家名称</span><input name="name" required maxLength={160} defaultValue={editingExpert.name} /></label>
        {hostModel === undefined
          ? <>
            <label><span>Provider</span><input name="provider" required maxLength={128} defaultValue={editingExpert.provider} /></label>
            <label><span>模型</span><input name="model_ref" required maxLength={256} defaultValue={editingExpert.model_ref} /></label>
          </>
          : <div className="wide lumo-expert-model"><span>模型</span><p>保存后沿用当前选中的模型 <b>{hostModel.provider}</b> · <b>{hostModel.model}</b>；原为 {editingExpert.provider} · {editingExpert.model_ref}</p></div>}
        <label><span>最大并发</span><input name="max_concurrency" required type="number" min={1} max={1000} defaultValue={editingExpert.max_concurrency} /></label>
        <label><span>项目范围</span><input name="project_id" maxLength={128} defaultValue={editingExpert.project_id ?? ''} placeholder="留空则对整个 Realm 生效" /></label>
        <AgentOutputProfileField profile={editingExpert.output_profile} allowFiles={capability?.clusterReady === true && !expertDirectoryLocal} />
        <label><span>系统提示引用</span><input name="system_prompt_ref" maxLength={256} defaultValue={editingExpert.system_prompt_ref ?? ''} /></label>
        <label className="wide"><span>职责说明</span><textarea name="description" required maxLength={500} rows={3} defaultValue={editingExpert.description ?? ''} /></label>
      </div>
      <footer><small>当前修订 {editingExpert.revision}；若数据已被更新，会提示刷新后重试。</small><span><button type="button" className="lumo-button lumo-secondary" onClick={() => setEditingExpert(null)}>取消</button><BusyButton type="submit" busy={savingExpert} className="lumo-primary">保存修改</BusyButton></span></footer>
    </form> : null}

    <div className="lumo-skillhub-browser">
      <aside className="lumo-skillhub-facet">
        <header><b>领域筛选</b><small>{tab === '专家' ? '按协作场景' : '按单项能力'}</small></header>
        <div className="lumo-skillhub-filters" role="group" aria-label={skillhubTabMeta[tab].label + '分类'}>{filters.map(tag => <button type="button" key={tag} data-tone={toneFor(tag)} className={filter === tag ? 'active' : ''} onClick={() => setFilter(tag)}>{tag}</button>)}</div>
        <p>筛选只作用于当前目录，切换专家与技能时会重置。</p>
      </aside>
      <section className="lumo-skillhub-results" aria-label={tab + '目录结果'}>
        <div className="lumo-skillhub-toolbar">
          <label className="lumo-skillhub-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" /></svg><input value={query} onChange={event => setQuery(event.target.value)} placeholder={skillhubTabMeta[tab].placeholder} aria-label={'搜索' + skillhubTabMeta[tab].label} />{query ? <button type="button" aria-label="清空搜索" onClick={() => setQuery('')}>×</button> : null}{searching ? <i className="lumo-skillhub-spinner" aria-hidden="true" /> : null}</label>
          <span className="lumo-skillhub-count">{searching && loadedCount === 0 ? '正在查询目录…' : tab === '专家' ? `我的专家 ${visibleExperts.length} · 模板 ${metricValue(total)}` : `共 ${metricValue(total)} 个技能${hasMore ? ` · 已加载 ${loadedCount}` : ''}`}</span>
        </div>

    {loading ? <div className="lumo-skillhub-grid">{[0, 1, 2, 3, 4, 5].map(index => <div className="lumo-skeleton-skill" key={index}><span /><div><b /><i /><i /></div></div>)}</div>
      : tab === '技能' ? (skills.length ? <div className="lumo-skillhub-grid">{skills.map((skill, index) => <SkillHubCard key={skill.id} index={index} tone={toneFor(skill.tag)}>
        <header><SkillHubMark icon={skill.icon} name={skill.name} tone={toneFor(skill.tag)} /><div className="lumo-skillhub-title"><b title={skill.name}>{skill.name}</b><small>{skill.publisher ? skill.publisher + ' · ' : ''}{skill.source}{skill.verified ? <em className="lumo-skillhub-verified">✓ 认证</em> : null}</small></div></header>
        <p>{skill.description || '暂无描述。'}</p>
        <div className="lumo-skillhub-chips"><span className="lumo-skillhub-tag" data-tone={toneFor(skill.tag)}>{skill.tag}</span>{skill.apiKey ? <span className="lumo-skillhub-key">需 API Key</span> : null}{(skill.tags ?? []).slice(0, 2).map(tag => <span key={tag} className="lumo-skillhub-tag">{tag}</span>)}</div>
        <footer><span className="lumo-skillhub-stats"><span>★ {skill.rating}</span><span>下载 {metricValue(skill.downloads)}</span><code>/{skill.command}</code></span><span className="lumo-skillhub-actions">{actions('skill', skill.id, skill.name, installedSkills.has(skill.id))}</span></footer>
      </SkillHubCard>)}</div> : <Empty>{skillhubTabMeta[tab].empty}</Empty>)
      : <div className="lumo-expert-directory">
        {visibleExperts.length ? <section className="lumo-expert-block"><header><div><b>我的专家</b><span>已创建、可继续治理的 Agent 资产</span></div><em>{visibleExperts.length}</em></header><div className="lumo-skillhub-grid">{visibleExperts.map((expert, index) => <SkillHubCard key={expert.id} index={index} tone="mint">
          <header><span className="lumo-skillhub-mark lumo-expert-mark" data-tone="mint">{expert.name.slice(0, 1)}</span><div className="lumo-skillhub-title"><b title={expert.name}>{expert.name}</b><small>{expert.provider} · {expert.model_ref}</small></div><span className={`lumo-expert-status ${expert.status}`}>{expert.status === 'active' ? '已启用' : '已停用'}</span></header>
          <p>{expert.description || '尚未填写职责说明。'}</p>
          <div className="lumo-skillhub-chips"><span className="lumo-skillhub-tag" data-tone="mint">专属专家</span><span className="lumo-skillhub-tag">{agentOutputProfileLabel(expert.output_profile)}</span>{expert.project_id ? <span className="lumo-skillhub-tag">项目 · {expert.project_id}</span> : <span className="lumo-skillhub-tag">全 Realm</span>}</div>
          <footer><span className="lumo-skillhub-stats"><span>并发 {expert.max_concurrency}</span><span>版本 {expert.version}</span></span><span className="lumo-skillhub-actions"><button type="button" className="lumo-button lumo-secondary" onClick={() => { setCreateExpertOpen(false); setEditingExpert(expert) }}>编辑</button>{expertDirectoryLocal ? <ConfirmButton busy={deletingExpert === expert.id} confirmLabel="确认删除" onConfirm={() => deleteExpert(expert)}>删除</ConfirmButton> : null}</span></footer>
        </SkillHubCard>)}</div></section> : expertDirectoryState !== 'ok' ? <div className="lumo-expert-directory-note"><b>专属专家目录未连接</b><p>{expertDirectoryMessage}</p></div> : null}
        <section className="lumo-expert-block"><header><div><b>专家模板</b><span>按场景预装的一组技能，可直接加入工作区</span></div><em>{metricValue(total)}</em></header>{packs.length ? <div className="lumo-skillhub-grid">{packs.map((pack, index) => <SkillHubCard key={pack.id} index={index} tone={toneFor(pack.category)}>
          <header><SkillHubMark icon={pack.icon} name={pack.name} tone={toneFor(pack.category)} /><div className="lumo-skillhub-title"><b title={pack.name}>{pack.name}</b><small>{pack.role || '通用专家'} · {pack.source}</small></div></header>
          <p>{pack.description || '暂无描述。'}</p>
          <div className="lumo-skillhub-chips"><span className="lumo-skillhub-tag" data-tone={toneFor(pack.category)}>{pack.category}</span><span className="lumo-skillhub-tag">包含 {pack.skills} 个技能</span></div>
          <footer><span className="lumo-skillhub-stats" /><span className="lumo-skillhub-actions">{actions('pack', pack.id, pack.name, installedPacks.has(pack.id), '添加专家')}</span></footer>
        </SkillHubCard>)}</div> : <Empty>{skillhubTabMeta[tab].empty}</Empty>}</section>
      </div>}
        {!loading && hasMore ? <div ref={listEndRef} className="lumo-skillhub-more" role="status">{searching ? <span><i className="lumo-skillhub-spinner" aria-hidden="true" />正在加载更多…</span> : tab === '技能' ? '继续向下滚动，加载更多技能' : '继续向下滚动，加载更多专家模板'}</div> : null}
      </section>
    </div>
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

function ConnectorsSurface({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<Overview>(emptyOverview)
  const [loading, setLoading] = useState(true)
  const [probeBusy, setProbeBusy] = useState(false)
  const [invokeBusy, setInvokeBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirm, setConfirm] = useState<string | null>(null)
  const [probe, setProbe] = useState<ProbeResult | null>(null)
  const [invokeResult, setInvokeResult] = useState<ProbeResult | null>(null)
  const [approvals, setApprovals] = useState<ConnectorApproval[]>([])
  const [approvalBusy, setApprovalBusy] = useState('')
  const [filter, setFilter] = useState('')
  const [selectedId, setSelectedId] = useState('')
  const [invokeOperation, setInvokeOperation] = useState('')
  const [pathParams, setPathParams] = useState('')
  const [queryParams, setQueryParams] = useState('')
  const [invokeBody, setInvokeBody] = useState('')
  const load = useCallback(async () => { setLoading(true); try { const [next, approvalData, connectorData] = await Promise.all([api<Overview>('/lumo/api/overview'), api<ConnectorApprovals>('/lumo/api/connector-approvals').catch(() => null), api<{ connectors: Row[] }>('/lumo/api/connectors?includeDisabled=true').catch(() => null)]); const merged = { ...next, connectors: connectorData?.connectors ?? next.connectors }; setData(merged); setApprovals(approvalData?.approvals ?? []); setSelectedId(current => current || merged.connectors[0]?.id || ''); setError('') } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) } }, [])
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
  const enable = async (connector: Row) => {
    if (!connector.id) return
    try { await api(`/lumo/api/connectors/${encodeURIComponent(connector.id)}/enable`, { method: 'POST' }); setNotice(`连接器「${connector.name ?? connector.id}」已恢复。`); await load() }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
  }
  const invokeCurrent = async (approvalId?: string) => {
    if (!selected?.id || !invokeOperation) { setNotice('请选择一个可调用操作。'); return }
    setInvokeBusy(true); setNotice(''); setInvokeResult(null)
    try {
      const result = await api<ProbeResult>(`/lumo/api/connectors/${encodeURIComponent(selected.id)}/invoke`, { method: 'POST', body: JSON.stringify({ operation: invokeOperation, pathParams: parseOptionalObject(pathParams, '路径参数'), query: parseOptionalObject(queryParams, '查询参数'), body: parseOptionalJSON(invokeBody, '请求体'), correlationId: `lumo-ui-${Date.now()}`, ...(approvalId === undefined ? {} : { approvalId }) }) })
      setInvokeResult(result); setNotice('连接器调用已完成，结果经过网关脱敏。')
    } catch (reason) {
      const approval = reason instanceof ApiError && reason.status === 428 && typeof reason.body === 'object' && reason.body !== null ? (reason.body as { approval?: ConnectorApproval }).approval : undefined
      if (approval !== undefined) { setApprovals(current => [approval, ...current.filter(item => item.id !== approval.id)]); setNotice(`高敏感写操作已创建审批「${approval.id}」。管理员批准后，使用下方“按已批准请求执行”按钮重试同一请求。`) }
      else setNotice(reason instanceof Error ? reason.message : String(reason))
    }
    finally { setInvokeBusy(false) }
  }
  const invoke = (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void invokeCurrent() }
  const decideApproval = async (approval: ConnectorApproval, decision: 'approve' | 'reject') => {
    setApprovalBusy(`${decision}:${approval.id}`); setNotice('')
    try { await api(`/lumo/api/connector-approvals/${encodeURIComponent(approval.id)}/${decision}`, { method: 'POST' }); setNotice(decision === 'approve' ? '审批已通过；申请人可按原请求执行一次。' : '审批已拒绝。'); await load() }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setApprovalBusy('') }
  }
  const probeWeb = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const url = String(new FormData(event.currentTarget).get('url') ?? '').trim(); if (!url) { setNotice('请输入需要检查的 URL。'); return }
    setProbeBusy(true); setNotice('')
    try { setProbe(await api('/lumo/api/web/fetch', { method: 'POST', body: JSON.stringify({ url }) })); setNotice('Web 出站策略已返回结果。') }
    catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { setProbeBusy(false) }
  }
  return <div className="lumo-surface lumo-connectors-surface lumo-workspace-page">
    <WorkspaceHero surface="connectors" onClose={onClose} statement="管理连接器能力与受控调用。" description="查看已登记能力、审批状态和 Web 出站策略。">
      <div className={'lumo-workspace-status' + (!loading && (error || !data.services.connector?.ok) ? ' degraded' : '')}><span>网关状态</span><b><i aria-hidden="true" />{loading ? '正在同步' : error ? '目录不可用' : data.services.connector?.ok ? '网关已就绪' : '等待网关'}</b><dl><div><dt>连接器</dt><dd>{data.connectors.length}</dd></div><div><dt>操作</dt><dd>{data.connectors.reduce((count, connector) => count + (connector.operations?.length ?? 0), 0)}</dd></div><div><dt>审批</dt><dd>{approvals.length}</dd></div></dl><small>{data.deployment.clusterReady ? '集群配置入口已开放' : '配置入口需要集群模式'}</small></div>
    </WorkspaceHero>
    {error ? <Notice error>{error}</Notice> : null}{notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}
    <Section title="连接器目录" meta={`${connectors.length} 个可见能力`} actions={<label className="lumo-filter"><span>搜索</span><input value={filter} onChange={event => setFilter(event.target.value)} placeholder="连接器名称、协议或 ID" /></label>}>
      {connectors.length ? <div className="lumo-connector-layout"><div className="lumo-connector-grid">{connectors.map((connector, index) => <SpotlightCard className={`lumo-connector-card ${selected?.id === connector.id ? 'selected' : ''}`} index={index} key={connector.id} onClick={() => setSelectedId(connector.id ?? '')}><header><span className="lumo-connector-mark">{(connector.name ?? connector.id ?? 'C').slice(0, 1).toUpperCase()}</span><div><b>{connector.name ?? connector.id}</b><small>{connector.protocol ?? '未知协议'} · {connector.operations?.length ?? 0} 项操作</small></div><i className={`lumo-status-dot ${connector.enabled === false ? 'disabled' : ''}`} /></header><div className="lumo-operation-list">{connector.operations?.slice(0, 5).map(operation => <span key={operation.name}>{operation.method || '调用'} · {operation.name}</span>)}</div><footer><span>{connector.enabled === false ? '已停用 · 可恢复' : connector.version ? `能力清单 v${connector.version}` : '能力清单已启用'}</span><span>查看能力 ↗</span></footer>{connector.enabled === false ? <BusyButton className="lumo-primary lumo-small" onClick={event => { event.stopPropagation(); void enable(connector) }}>恢复连接器</BusyButton> : confirm === connector.id ? <div className="lumo-inline-confirm" onClick={event => event.stopPropagation()}><p>停用后运行中的工作流将无法调用它。</p><span><BusyButton onClick={() => setConfirm(null)}>取消</BusyButton><BusyButton className="lumo-danger" onClick={() => void remove(connector)}>确认停用</BusyButton></span></div> : <BusyButton className="lumo-danger lumo-small" onClick={event => { event.stopPropagation(); setConfirm(connector.id ?? null) }}>停用连接器</BusyButton>}</SpotlightCard>)}</div><aside className="lumo-inspector lumo-connector-inspector">{selected ? <><span className="lumo-inspector-label">连接器检查</span><h3>连接器详情 · {selected.name ?? selected.id}</h3><p>所有外部调用都经过网关策略、凭证闸门、限流、熔断和审计。</p><div className="lumo-detail-stack"><div><span>连接器 ID</span><b>{selected.id}</b></div><div><span>协议</span><b>{selected.protocol ?? '未声明'}</b></div><div><span>版本</span><b>{selected.version ?? '未声明'}</b></div><div><span>可用操作</span><b>{selected.operations?.length ?? 0}</b></div></div><div className="lumo-operation-detail"><span>操作面</span>{selected.operations?.length ? selected.operations.map(operation => <div key={operation.name}><b>{operation.name}</b><small>{operation.method || '调用'} · {operation.write ? '写入需审批' : '只读'}</small></div>) : <Empty>该能力清单没有声明操作。</Empty>}</div>{selected.enabled === false ? <Empty>该连接器已停用，恢复后才能再次调用。</Empty> : <form className="lumo-invoke-form" onSubmit={invoke}><label><span>操作</span><select value={invokeOperation} onChange={event => setInvokeOperation(event.target.value)}><option value="" disabled>选择操作</option>{operations.map(operation => <option key={operation.name} value={operation.name}>{operation.name} · {operation.method || '调用'}</option>)}</select></label><label><span>路径参数 JSON</span><textarea rows={2} value={pathParams} onChange={event => setPathParams(event.target.value)} placeholder='{"id":"order-42"}' /></label><label><span>查询参数 JSON</span><textarea rows={2} value={queryParams} onChange={event => setQueryParams(event.target.value)} placeholder='{"limit":"20"}' /></label><label><span>请求体 JSON</span><textarea rows={3} value={invokeBody} onChange={event => setInvokeBody(event.target.value)} placeholder='{"dryRun":true}' /></label><BusyButton type="submit" busy={invokeBusy} className="lumo-primary">受控调用</BusyButton></form>}{invokeResult ? <div className="lumo-invoke-result"><div><b>{invokeResult.status ?? '未返回'}</b><span>{invokeResult.contentType ?? '响应'} · {invokeResult.durationMs ?? 0} ms</span></div><small>{invokeResult.redacted ? '响应已按策略脱敏' : '响应未脱敏'}</small><pre>{typeof invokeResult.body === 'string' ? invokeResult.body : JSON.stringify(invokeResult.body ?? {}, null, 2)}</pre></div> : null}</> : <Empty>当前没有可见连接器。</Empty>}</aside></div> : <Empty>{loading ? '正在读取连接器能力清单' : '连接器清单为空；登记成功的能力清单会出现在这里。'}</Empty>}
    </Section>
    {data.deployment.clusterReady ? <ConnectorManifestPanel request={api} refresh={load} /> : <div className="lumo-workspace-note" role="status">连接器配置与 OAuth 管理需要集群模式。当前仍可查看已登记连接器、审批和 Web 出站诊断。</div>}
    {data.deployment.clusterReady && selected?.enabled !== false && selected?.id ? <ConnectorAccountPanel request={api} connectorID={selected.id} /> : null}
    <Section title="高敏感写入审批" meta="审批绑定连接器版本、操作和请求参数；每次批准只能执行一次" actions={<BusyButton busy={loading} onClick={() => void load()}>刷新</BusyButton>}>
      {approvals.length ? <div className="lumo-market-note-grid">{approvals.map(approval => <div key={approval.id}><span>{approval.status === 'pending' ? '等待管理员处理' : approval.status === 'approved' ? '已批准 · 等待一次执行' : approval.status === 'consumed' ? '已使用' : approval.status === 'expired' ? '已过期' : '已拒绝'}</span><b>{approval.connector_id} · {approval.operation}</b><small>申请人 {approval.requester_user_id} · v{approval.connector_version} · 到期 {approval.expires_at}{approval.approver_user_id ? ` · 处理人 ${approval.approver_user_id}` : ''}</small>{approval.status === 'pending' ? <span className="lumo-surface-actions"><BusyButton busy={approvalBusy === `approve:${approval.id}`} onClick={() => void decideApproval(approval, 'approve')}>批准</BusyButton><BusyButton className="lumo-danger" busy={approvalBusy === `reject:${approval.id}`} onClick={() => void decideApproval(approval, 'reject')}>拒绝</BusyButton></span> : null}{approval.status === 'approved' && selected?.id === approval.connector_id && invokeOperation === approval.operation ? <BusyButton className="lumo-primary" busy={invokeBusy} onClick={() => void invokeCurrent(approval.id)}>按已批准请求执行</BusyButton> : null}</div>)}</div> : <Empty>没有待展示的连接器审批。高敏感写操作会在网关策略命中后创建一次性审批。</Empty>}
    </Section>
    <Section title="Web 出站诊断" meta="复用连接器网关的 SSRF / 出站策略"><form className="lumo-inline-form" onSubmit={probeWeb}><label><span>目标 URL</span><input name="url" type="url" placeholder="https://api.example.com/health" /></label><BusyButton type="submit" busy={probeBusy} className="lumo-primary">检查策略</BusyButton></form>{probe ? <div className="lumo-probe-result"><b>{probe.status ?? '未返回'}</b><span>{probe.contentType ?? '响应'} · {probe.durationMs ?? 0} ms</span><small>{probe.redacted ? '响应已按策略脱敏' : probe.url ?? '策略允许访问'}</small></div> : <div className="lumo-diagnostic-empty"><span>输入公网 URL 进行一次受控探测</span><small>私有网络、凭证和未经允许的请求会被网关拒绝。</small></div>}</Section>
  </div>
}

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
      { id: taskNode, lane: 'task', col: 2, type: 'messagebus', label: task.title.slice(0, 48), sublabel: `${task.id} · ${localizedTaskDisplayState(task)}` },
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

function OrchestrationTopology({ tasks, busy, cancel, retry, reassign, showRuns }: {
  tasks: DelegatedTask[]
  busy: string
  cancel: (task: DelegatedTask) => Promise<void>
  retry: (task: DelegatedTask) => Promise<void>
  reassign: (task: DelegatedTask) => Promise<void>
  showRuns: (task: DelegatedTask) => Promise<void>
}) {
  const visible = tasks.slice(0, 8)
  return <div className="lumo-orchestration" data-archify-diagram="workflow">
    <header><div><span className="lumo-inspector-label">任务执行投影 · Archify 导出</span><b>Task → 当前 Run 视图</b><small>展示任务、当前执行者和节点；尚未接入真实子 Agent 运行树。</small></div><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={!visible.length} onClick={() => downloadArchifyTopology(visible)}>导出任务视图 JSON</button></header>
    <div className="lumo-orchestration-lanes"><span>控制面</span><span>业务任务</span><span>智能体 / 执行者</span><span>运行节点</span><span>控制</span></div>
    {visible.length ? <div className="lumo-orchestration-rows">{visible.map(task => {
      const terminal = ['FAILED', 'CANCELLED', 'BLOCKED'].includes(task.state)
      return <div className="lumo-orchestration-row" key={task.id}>
        <span className="control"><b>Lumo</b><small>授权 · 调度</small></span><i>→</i>
        <span><b>{task.title}</b><small>{task.id} · {localizedTaskDisplayState(task)}</small></span><i>→</i>
        <span className={task.selected_skills.includes('ruflo-orchestration') ? 'ruflo' : ''}><b>{task.assignee_name ?? task.assignee_worker_id ?? task.assignee_user_id}</b><small>{task.selected_skills.includes('ruflo-orchestration') ? 'Ruflo 子群' : task.selected_skills.join(' / ') || '单执行者'}</small></span><i>→</i>
        <span><b>{task.assigned_node_id ?? '等待节点'}</b><small>{task.last_error || task.state}</small></span>
        <span className="lumo-orchestration-actions">
          <BusyButton busy={busy === `runs-${task.id}`} className="lumo-small" onClick={() => void showRuns(task)}>执行详情</BusyButton>
          {['ASSIGNED', 'QUEUED', 'RUNNING'].includes(task.state) ? <BusyButton busy={busy === `task-${task.id}`} className="lumo-small lumo-danger" onClick={() => void cancel(task)}>取消</BusyButton> : null}
          {task.state === 'CANCELLING' ? <em>取消中</em> : null}
          {terminal ? <><BusyButton busy={busy === `retry-${task.id}`} className="lumo-small" onClick={() => void retry(task)}>重试</BusyButton><BusyButton busy={busy === `reassign-${task.id}`} className="lumo-small" onClick={() => void reassign(task)}>改派</BusyButton></> : null}
        </span>
      </div>
    })}</div> : <Empty>还没有可展示的任务；创建委派后会生成真实任务、执行者和节点拓扑。</Empty>}
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

// 协作空间：**节点是注册节点的员工，边是员工之间的上下游，智能体挂在它服务的员工下面。**
//
// 拼接全在 `collaboration-layout.ts` 的纯函数里（有单测）；这里只负责取四个面、渲染，
// 以及把「未绑定」如实画出来。
//
// 四个面各司其职，**谁也不替谁说话**：
//   `/lumo/api/users`                 → 员工是谁
//   `/lumo/api/desktop-nodes`         → 每个员工名下有哪些注册节点、在不在线
//   `/lumo/api/delegations`           → 任务在谁手里；上下游由父子任务的承担者折出来
//   `/lumo/api/collaboration/teams`   → dsh 的团队名册；成员靠 `ownerUserId` 挂到员工下
//
// 四个读面**各自降级**：任何一个拿不到，只在图上少一块并说明原因，不让整张图变空——
// 空图读起来是「组织里没有任何协作」，那是一个结论，而事实只是某个面没读到。
const employeeStateLabels: Record<EmployeeState, string> = {
  'awaiting-review': '等待审核',
  offline: '节点离线',
  blocked: '下游阻塞',
  executing: '执行中',
  delivered: '已交付',
  queued: '排队中',
  unknown: '无任务',
}

const boardTaskStateLabels: Record<BoardTaskState, string> = {
  // 「可认领」与「阻塞」都来自 `teamProgress()` 的派生集合，不是从状态字面量推的——
  // pending 的任务里，这两者的差别正是整张任务板唯一值得区分的一件事。
  ready: '可认领',
  blocked: '阻塞',
  executing: '执行中',
  delivered: '已完成',
  failed: '失败',
  queued: '排队中',
  unknown: '状态未知',
}

interface CollabUser { id: string; display_name?: string; status?: string }
interface CollabNode { id: string; owner_user_id?: string; status?: string }
interface CollabTeamMember { name: string; role?: string; model?: string; status?: string; ownerUserId?: string }
interface CollabTeam {
  id: string
  name: string
  topology?: string
  settled?: boolean
  members?: CollabTeamMember[]
  // 宿主路由把 `team.tasks` 与 `progress` 一起带出来了（见 lumo-ui/src/index.ts 的
  // collaboration/teams 分支）。任务板视图直接用它们，**不在客户端重算 ready/blocked**
  // ——那套判据是 agentTeams 自己的定义，重算就会有两份会分叉的规则。
  tasks?: BoardTaskInput[]
  progress?: TeamProgressInput
}

/**
 * `/lumo/api/delegations` 的行：协作图与线程看板读的是**同一批行**，只是两份切片。
 *
 * 分开声明而不是各拿一个宽类型：图要的是承担者与父子关系，看板要的是时间戳与节点
 * （静默时长、等待上限都落在 `updated_at` 上）。合成一个类型之后，两边会开始互相以为
 * 对方已经读过自己要的字段——而「看板把没有时间戳的行当成刚有动静」这类错不会报错。
 */
type DelegationRow = FlowTaskInput & ThreadFacts
interface ThreadFleet {
  threads: ThreadFacts[]
  capabilities: { threadRegistry: boolean; controlState: boolean }
  errors: string[]
  pagination?: { nextTaskCursor: string; nextThreadCursor: string; taskCount: number }
}

/**
 * 渲染坐标系：`renderY(y) = -y`。
 *
 * 布局函数给的 y 是 `-depth * NODE_LIFT_Y`（越深越靠上），取反之后**上游落在上面、
 * 下游往下流**——这是读图的人默认的方向，也是「谁在等谁」这句话的读法。
 *
 * 取反只发生在渲染这一层，`collaboration-layout.ts` 一个字不动：位置的确定性来自
 * 那个纯函数（同深度按 id 排序、同一批数据换个顺序请求位置不变），这里只决定哪一头朝上。
 */
function nodeTransform(x: number, y: number): CSSProperties {
  // 用 translate(-50%,-50%) 让节点以自己的中心落在给定坐标上，不再靠
  // `margin: -48px 0 0 -88px` 这种把节点尺寸写死一半的写法——卡片高度随内容变，
  // 那个 48 从来只是近似，改一次字号就会歪。
  return { transform: `translate(calc(${x}px - 50%), calc(${-y}px - 50%))` }
}

/** 层带：一层一条横线加一个层号，给「同一层」一条横向基准。 */
function layerTransform(level: number): CSSProperties {
  return { transform: `translate(0, ${level * NODE_LIFT_Y}px)` }
}

/**
 * 一条光轨的几何：**从 from 摆到 to**。
 *
 * 元素锚在 from（`left:50%/top:50%` 让世界原点落在画布中心），`transform-origin: 0 50%`
 * 让旋转绕它的左端发生，长度取两点距离——于是它恰好覆盖 from→to 这一段。
 *
 * 旧写法把元素锚在**中点**却仍按全长延伸，画出来的是 mid → (3·to − from)/2：
 * 前半段没画，末端还多出一截越过目标、指向空气的线。这张图「谁给谁供活」全靠这几条线，
 * 所以那不是一个视觉小瑕疵——它是在陈述一个不成立的关系。
 */
function railGeometry(from: { x: number; y: number }, to: { x: number; y: number }): CSSProperties {
  const dx = to.x - from.x
  const dy = from.y - to.y
  return {
    width: `${Math.hypot(dx, dy).toFixed(1)}px`,
    transform: `translate(${from.x}px, ${-from.y}px) rotate(${((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(2)}deg)`,
  }
}

/**
 * 世界层的变换：缩放 + 把整张图垂直居中。
 *
 * 平移量要**乘 zoom**：transform 从右往左生效，`translateY(…) scale(…)` 是先缩放再平移，
 * 平移落在父坐标系里。少了这个乘法，图会随着缩放一路滑出画布。
 */
function worldTransform(levels: number, zoom: number): CSSProperties {
  const centre = ((Math.max(levels, 1) - 1) / 2) * NODE_LIFT_Y
  return { transform: `translateY(${(-centre * zoom).toFixed(1)}px) scale(${zoom})` }
}

/** 图例的一行：颜色条 + 状态名 + 在当前这张图上出现的次数。 */
function CollaborationLegend({ entries }: { entries: Array<{ state: string; label: string; count: number }> }): ReactNode {
  return <div className="lumo-collaboration-legend">
    {entries.map(entry => <div key={entry.state} className={entry.state}>
      <i aria-hidden="true" />
      <span>{entry.label}</span>
      <em>{entry.count}</em>
    </div>)}
  </div>
}

function collaborationReadError(reason: unknown): string {
  if (reason instanceof ApiError) {
    const detail = typeof reason.body === 'object' && reason.body !== null
      ? (reason.body as { detail?: unknown }).detail : undefined
    return `${reason.status} · ${typeof detail === 'string' && detail !== '' ? detail : reason.message}`
  }
  return reason instanceof Error ? reason.message : String(reason)
}

function CollaborationSurface({ onClose }: { onClose: () => void }) {
  const bridge = useNativeConversationBridge()
  const [teamCapabilities, setTeamCapabilities] = useState<TeamCapabilities | null>(null)
  const [users, setUsers] = useState<CollabUser[] | null>(null)
  const [nodes, setNodes] = useState<CollabNode[] | null>(null)
  const [delegations, setDelegations] = useState<DelegationRow[] | null>(null)
  const [threadFleet, setThreadFleet] = useState<ThreadFleet | null>(null)
  const [teams, setTeams] = useState<CollabTeam[] | null>(null)
  const [runtimeNodes, setRuntimeNodes] = useState<NodeState[] | null>(null)
  const [deploymentMode, setDeploymentMode] = useState<DeploymentState['mode'] | null>(null)
  const [absent, setAbsent] = useState<string[]>([])
  const [errorDetails, setErrorDetails] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  // 任务板上选中的是**任务**，不是人。两张图各选各的：右栏该说谁的事，取决于你点的是
  // 哪张图上的东西。共用一个 selected 的后果是任务板上点一个任务、右栏开始讲某位员工的
  // 注册节点——答非所问比不答更费人的时间。
  const [selectedTask, setSelectedTask] = useState<string | null>(null)
  const [zoom, setZoom] = useState(0.8)
  // 三个视图共用同一批读面，切换时同一件事不会跳到别处：
  //   'people' 答「谁在等谁」，'board' 答「哪一条卡住了」，
  //   'threads' 答「现在该我做什么」——而且是分格回答：要进入心流的审，与只要一次点击的答。
  const [view, setView] = useState<'people' | 'board' | 'threads' | 'progress'>('people')
  const [teamId, setTeamId] = useState<string | null>(null)
  const [goal, setGoal] = useState('')
  const [fleetPages, setFleetPages] = useState([{ task: '', thread: '' }])
  const fleetPagesRef = useRef(fleetPages)
  const loadGeneration = useRef(0)
  const fleetPage = fleetPages[fleetPages.length - 1]!

  const load = useCallback(async (requestedPages?: { task: string; thread: string }[]) => {
    const generation = ++loadGeneration.current
    const targetPages = requestedPages ?? fleetPagesRef.current
    const targetPage = targetPages[targetPages.length - 1]!
    setLoading(true)
    // 先读部署形态。Standalone/Local 的三个治理面有明确的 Cluster 门禁；
    // 在那两种形态里请求它们只会得到永久的 403，不能当成暂时故障提示重试。
    const [overviewFace, teamFace] = await Promise.allSettled([
      api<Overview>('/lumo/api/overview'),
      api<{ teams?: CollabTeam[]; capabilities?: TeamCapabilities | null }>('/lumo/api/collaboration/teams'),
    ])
    if (generation !== loadGeneration.current) return
    const missing: string[] = []
    const details: Record<string, string> = {}
    const failed = (label: string, reason: unknown): null => {
      missing.push(label)
      details[label] = collaborationReadError(reason)
      return null
    }
    const mode = overviewFace.status === 'fulfilled' ? overviewFace.value.deployment.mode : null
    const clusterOnly = mode === 'local' || mode === 'standalone'
    setDeploymentMode(mode)
    setTeamCapabilities(teamFace.status === 'fulfilled' ? teamFace.value.capabilities ?? null : null)
    setTeams(teamFace.status === 'fulfilled' ? teamFace.value?.teams ?? [] : failed('智能体名册', teamFace.reason))
    // Scheduler 的 `/v1/nodes` 在 Standalone / Cluster 形态背后读 Nacos Naming。
    setRuntimeNodes(overviewFace.status === 'fulfilled' ? overviewFace.value.cluster.nodes ?? [] : failed('Nacos 节点目录', overviewFace.reason))
    if (clusterOnly) {
      setUsers(null)
      setNodes(null)
      setDelegations(null)
      setThreadFleet(null)
      setSelected(null)
      setView('board')
    } else {
      // Cluster 三个治理面各自降级；overview 失败时也尝试读取，避免丢掉可用数据。
      const [userFace, nodeFace, delegationFace, threadFace] = await Promise.allSettled([
        api<{ users?: CollabUser[] }>('/lumo/api/users'),
        api<{ nodes?: CollabNode[] }>('/lumo/api/desktop-nodes'),
        api<DelegationRow[] | { tasks: DelegationRow[] }>('/lumo/api/delegations'),
        api<ThreadFleet>(`/lumo/api/collaboration/threads?${new URLSearchParams({ task_cursor: targetPage.task, thread_after: targetPage.thread })}`),
      ])
      if (generation !== loadGeneration.current) return
      setUsers(userFace.status === 'fulfilled' ? userFace.value?.users ?? [] : failed('员工目录', userFace.reason))
      setNodes(nodeFace.status === 'fulfilled' ? nodeFace.value?.nodes ?? [] : failed('注册节点', nodeFace.reason))
      const taskRows = delegationFace.status === 'fulfilled'
        ? Array.isArray(delegationFace.value) ? delegationFace.value : delegationFace.value?.tasks : undefined
      setDelegations(Array.isArray(taskRows) ? taskRows : failed('委派任务', delegationFace.status === 'rejected' ? delegationFace.reason : '响应不是任务列表'))
      if (threadFace.status === 'fulfilled' && Array.isArray(threadFace.value?.threads)
        && typeof threadFace.value?.capabilities?.controlState === 'boolean'
        && typeof threadFace.value?.capabilities?.threadRegistry === 'boolean' && Array.isArray(threadFace.value.errors)
        && (targetPage.thread === '' || threadFace.value.capabilities.threadRegistry)
        && (threadFace.value.pagination === undefined || (
          threadFace.value.pagination !== null && typeof threadFace.value.pagination === 'object'
          && typeof threadFace.value.pagination.nextTaskCursor === 'string'
          && typeof threadFace.value.pagination.nextThreadCursor === 'string'
          && Number.isInteger(threadFace.value.pagination.taskCount)
          && threadFace.value.pagination.taskCount >= 0 && threadFace.value.pagination.taskCount <= 200))) {
        setThreadFleet(threadFace.value)
        fleetPagesRef.current = targetPages
        setFleetPages(targetPages)
        if (threadFace.value.errors.length > 0) failed('线程聚合', threadFace.value.errors.join('；'))
      } else {
        // Keep the last successful page and its cursor together. A failed page
        // read must never relabel the default delegation list as the next page.
        if (threadFace.status === 'rejected' && threadFace.reason instanceof ApiError
          && (threadFace.reason.status === 401 || threadFace.reason.status === 403)) {
          setThreadFleet(null)
          setDelegations(null)
          fleetPagesRef.current = [{ task: '', thread: '' }]
          setFleetPages(fleetPagesRef.current)
          failed('线程聚合', threadFace.reason)
        } else failed('线程聚合', `读取失败，仍显示上次成功读取的页面；${collaborationReadError(threadFace.status === 'rejected' ? threadFace.reason : '响应不是可读的线程页')}`)
      }
      if (userFace.status === 'fulfilled') {
        const first = (userFace.value?.users ?? [])[0]
        if (first !== undefined) setSelected(current => current ?? first.id)
      }
    }
    setAbsent(missing)
    setErrorDetails(details)
    setUpdatedAt(new Date())
    setLoading(false)
  }, [])

  useEffect(() => {
    void load()
    return () => { loadGeneration.current++ }
  }, [load])

  const employees = useMemo<EmployeeInput[]>(() => (users ?? []).map(user => ({
    id: user.id,
    name: user.display_name ?? user.id,
    // 条件展开而不是直接写 `status: node.status`：客户端配置开了
    // exactOptionalPropertyTypes，「有值但可能是 undefined」与「这个键可以没有」
    // 是两回事——把 undefined 显式塞进可选属性在这里是类型错误，而在别处只是不严谨。
    nodes: (nodes ?? []).filter(node => node.owner_user_id === user.id)
      .map(node => ({ id: node.id, ...node.status === undefined ? {} : { status: node.status } })),
  })), [users, nodes])

  const agents = useMemo<AgentInput[]>(() => (teams ?? []).flatMap(team =>
    (team.members ?? []).map(member => ({
      name: member.name,
      ...member.role === undefined ? {} : { role: member.role },
      ...member.model === undefined ? {} : { model: member.model },
      ...member.status === undefined ? {} : { status: member.status },
      // **原样透传**：缺省就是缺省。这里若补一个空串，客户端就再也分不出
      // 「没绑定」与「绑定到了一个空 id」，而图上看起来都只是「没挂上」。
      ...member.ownerUserId === undefined ? {} : { ownerUserId: member.ownerUserId },
      teamId: team.id,
      teamName: team.name,
    }))), [teams])

  const graph = useMemo(() => {
    const tasks = delegations ?? []
    const edges = employeeFlowEdges(tasks, new Set(employees.map(employee => employee.id)))
    return layoutCollaboration(employees, edges, tasks, agents)
  }, [employees, delegations, agents])

  const positioned = useMemo(() => new Map(graph.placed.map(node => [node.id, node])), [graph])
  const selectedEmployee = selected === null ? undefined : positioned.get(selected)

  // 任务板**按团队**：TeamTask 属于某个团队，不跨团队存在。
  const activeTeam = useMemo(() => {
    if (teams === null || teams.length === 0) return null
    return teams.find(team => team.id === teamId) ?? teams[0] ?? null
  }, [teams, teamId])
  const board = useMemo(() => activeTeam === null
    ? null
    : layoutTaskBoard(activeTeam.tasks ?? [], activeTeam.progress ?? null), [activeTeam])
  const boardPlaced = useMemo(() => new Map((board?.placed ?? []).map(node => [node.id, node])), [board])
  const selectedTaskNode = selectedTask === null ? undefined : boardPlaced.get(selectedTask)
  const selectedTaskFlow = useMemo(() => {
    if (selectedTask === null || board === null) return { upstream: [] as string[], downstream: [] as string[] }
    const label = (id: string): string => boardPlaced.get(id)?.subject ?? id
    return {
      upstream: board.edges.filter(edge => edge.to === selectedTask).map(edge => label(edge.from)),
      downstream: board.edges.filter(edge => edge.from === selectedTask).map(edge => label(edge.to)),
    }
  }, [board, boardPlaced, selectedTask])
  // 图例只列**当前这张图上真出现过的**状态。写死一张全量表迟早会说出一个图上没有的状态，
  // 而图例的全部用处就是替读的人解释他正看着的这一张图。顺序取状态表本身的顺序
  // （即 employeeState 的优先级），所以「最该被看到的」排在最前。
  const employeeLegend = useMemo(() => (Object.keys(employeeStateLabels) as EmployeeState[])
    .map(state => ({ state, label: employeeStateLabels[state], count: graph.placed.filter(node => node.state === state).length }))
    .filter(entry => entry.count > 0), [graph])

  const totalDesktopNodes = employees.reduce((sum, employee) => sum + (employee.nodes?.length ?? 0), 0)
  const onlineDesktopNodes = employees.reduce((sum, employee) => sum + (employee.nodes?.filter(node => node.status?.trim().toUpperCase() === 'ONLINE').length ?? 0), 0)
  const attentionCount = graph.placed.filter(node => ['awaiting-review', 'blocked', 'offline'].includes(node.state)).length
  const executingCount = graph.placed.filter(node => node.state === 'executing').length
  const clusterOnly = deploymentMode === 'local' || deploymentMode === 'standalone'
  const readableFaces = clusterOnly ? 2 : 5
  const teamTasks = (teams ?? []).flatMap(team => team.tasks ?? [])
  const viewMeta = view === 'people'
    ? { eyebrow: '组织脉络', title: '协作关系图', description: '从上游到下游，查看每个人正在推进什么，以及谁在等待谁。' }
    : view === 'board'
      ? { eyebrow: '任务依赖', title: '任务流向图', description: '沿着依赖关系定位阻塞点，快速找到可以立即认领的下一步。' }
      : { eyebrow: '注意力路由', title: '线程看板', description: '把需要深度审阅、轻量回应和持续观察的线程分开处理。' }
  const statusLabel = loading ? '正在同步' : absent.length > 0 ? '部分数据不可用' : clusterOnly ? '单例数据已同步' : '数据已同步'

  return <section className={`lumo-collaboration ${view === 'threads' || view === 'progress' ? 'solo' : ''}`}>
    <header className="lumo-collaboration-hero">
      <button type="button" className="lumo-collaboration-back" onClick={onClose} aria-label="返回对话">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m12.5 4.5-5.5 5.5 5.5 5.5" /><path d="M7.5 10H17" /></svg>
        返回对话
      </button>
      <div className="lumo-collaboration-hero-copy">
        <span className="lumo-collaboration-kicker"><i aria-hidden="true" /> 团队与任务</span>
        <h1>团队协作</h1>
        <p>把团队、任务和需要你做的决定放在同一张图里。先看阻塞，再推进下一步。</p>
      </div>
      <div className={`lumo-collaboration-sync ${absent.length > 0 ? 'degraded' : ''}`}>
        <div className="lumo-collaboration-sync-head"><span>数据链路</span><b><i aria-hidden="true" />{statusLabel}</b></div>

        <div className="lumo-collaboration-sync-foot"><span>{absent.length > 0 ? `缺少 ${absent.length} 个读面` : `${readableFaces} 个适用读面连接正常`}</span><time>{updatedAt === null ? '等待首次同步' : `更新于 ${updatedAt.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`}</time></div>
        <button type="button" className="lumo-collaboration-refresh" onClick={() => void load()} disabled={loading}>
          <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M16 7a6.5 6.5 0 1 0 .2 5.4" /><path d="M16 3v4h-4" /></svg>
          {loading ? '同步中' : '重新读取'}
        </button>
      </div>
    </header>

    {clusterOnly ? <div className="lumo-collaboration-metrics" aria-label="协作概览">
      <div><span>智能体团队</span><b>{teams === null ? '—' : teams.length}</b><small>{teams === null ? '名册未读到' : '本节点的团队'}</small></div>
      <div><span>团队成员</span><b>{teams === null ? '—' : agents.length}</b><small>由智能体名册提供</small></div>
      <div><span>团队任务</span><b>{teams === null ? '—' : teamTasks.length}</b><small>按团队展示依赖</small></div>
      <div><span>执行节点</span><b>{runtimeNodes === null ? '—' : runtimeNodes.length}</b><small>Nacos 健康实例</small></div>
    </div> : <div className="lumo-collaboration-metrics" aria-label="协作概览">
      <div><span>团队成员</span><b>{graph.placed.length}</b><small>{graph.unbound.length > 0 ? `${graph.unbound.length} 个智能体待绑定` : '绑定关系正常'}</small></div>
      <div><span>正在推进</span><b>{executingCount}</b><small>{delegations?.length ?? 0} 条任务线程</small></div>
      <div className={attentionCount > 0 ? 'attention' : ''}><span>需要关注</span><b>{attentionCount}</b><small>{attentionCount > 0 ? '审核、阻塞或离线' : '当前没有阻塞'}</small></div>
      <div><span>员工节点在线</span><b>{onlineDesktopNodes}<i>/{totalDesktopNodes}</i></b><small>{totalDesktopNodes === 0 ? '尚未注册节点' : `${Math.round((onlineDesktopNodes / totalDesktopNodes) * 100)}% 可用`}</small></div>
    </div>}

    <section className="lumo-collaboration-fleet" aria-label="Nacos 执行节点">
      <header><div><span>execution layer</span><b>Nacos 执行节点</b></div><em>{runtimeNodes === null ? '读取失败' : `${runtimeNodes.length} 个健康实例`}</em></header>
      {runtimeNodes === null
        ? <p>节点目录这次没有返回；协作图仍保留其他读面的真实结果。</p>
        : runtimeNodes.length === 0
          ? <p>当前 realm 的 Nacos 目录里没有健康、已启用的执行节点。</p>
          : <div className="lumo-collaboration-fleet-list">{runtimeNodes.map((node, index) => <article key={node.node_id ?? `${node.cluster_id ?? 'node'}-${index}`}>
            <i aria-hidden="true" /><div><b>{node.node_id ?? '未命名节点'}</b><span>{node.cluster_id ?? 'default'} · 容量 {node.capacity ?? 1}</span></div>
            <small>{node.residency || '未声明驻留域'}</small>
            <em>{(node.capabilities ?? []).length > 0 ? (node.capabilities ?? []).join(' · ') : '通用执行'}</em>
          </article>)}</div>}
    </section>

    <div className="lumo-collaboration-commandbar">
      <div className="lumo-collaboration-views" role="tablist" aria-label="协作视图">
        <button type="button" role="tab" aria-label="协作空间" aria-selected={view === 'people'} className={view === 'people' ? 'active' : ''} disabled={clusterOnly} onClick={() => setView('people')}><span>协作空间</span><small>{clusterOnly ? '需就绪的集群' : '谁在等待谁'}</small></button>
        <button type="button" role="tab" aria-label="任务流向" aria-selected={view === 'board'} className={view === 'board' ? 'active' : ''} onClick={() => setView('board')}><span>任务流向</span><small>哪里被卡住</small></button>
        <button type="button" role="tab" aria-label="团队进度" aria-selected={view === 'progress'} className={view === 'progress' ? 'active' : ''} disabled={clusterOnly} onClick={() => setView('progress')}><span>团队进度</span><small>进展、阻塞与交接</small></button>
        <button type="button" role="tab" aria-label="线程看板" aria-selected={view === 'threads'} className={view === 'threads' ? 'active' : ''} disabled={clusterOnly} onClick={() => setView('threads')}><span>线程看板</span><small>{clusterOnly ? '需就绪的集群' : '现在处理什么'}</small></button>
      </div>
      <div className="lumo-collaboration-controls">
        {view === 'board' && teams !== null && teams.length > 0
          ? <label className="lumo-collaboration-team-filter"><span>团队</span><select aria-label="选择团队" value={activeTeam?.id ?? ''} onChange={event => setTeamId(event.target.value)}>{teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
          : null}
        {view === 'threads' || view === 'progress' ? null : <span className="lumo-collaboration-zoom" aria-label="画布缩放">
          <button type="button" aria-label="缩小空间" onClick={() => setZoom(value => Math.max(0.4, Number((value - 0.1).toFixed(2))))}>−</button>
          <span>{Math.round(zoom * 100)}%</span>
          <button type="button" aria-label="放大空间" onClick={() => setZoom(value => Math.min(1.6, Number((value + 0.1).toFixed(2))))}>＋</button>
        </span>}
      </div>
    </div>

    {view === 'progress' ? <WorkforceProgressPanel request={api} onOpen={id => openOperationsTarget({ kind: 'task', id })} /> : <div className={`lumo-collaboration-layout ${view === 'threads' ? 'solo' : ''}`}>
    <main className="lumo-collaboration-stage">
      <header className="lumo-collaboration-panel-head">
        <div><span>{viewMeta.eyebrow}</span><h2>{viewMeta.title}</h2><p>{viewMeta.description}</p></div>
        <p className="lumo-collaboration-caption">{view === 'people'
          ? `${graph.placed.length} 名员工 · ${graph.edges.length} 条上下游 · ${graph.unbound.length} 个未绑定智能体`
          : view === 'threads'
            ? `${threadFleet?.threads.length ?? delegations?.length ?? 0} 条线程与任务（当前页） · 按注意力分五格`
            : board === null
              ? '还没有可显示的团队'
              : `${board.placed.length} 条任务 · ${board.edges.length} 条依赖 · 阻塞 ${board.placed.filter(node => node.state === 'blocked').length} · 可认领 ${board.placed.filter(node => node.state === 'ready').length}`}</p>
      </header>
      {clusterOnly ? <div className="lumo-collaboration-notice" role="status">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 18 17H2z" /><path d="M10 7v4M10 14v.1" /></svg>
        <span><b>当前是{deploymentMode === 'local' ? '本地单机' : '服务器单例'}部署</b>员工目录、注册节点和委派任务由就绪的 Cluster 提供。这里展示当前可用的智能体团队与执行节点。</span>
      </div> : null}
      {absent.length > 0 ? <div className="lumo-collaboration-notice" role="status">
        <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 18 17H2z" /><path d="M10 7v4M10 14v.1" /></svg>
        <span><b>部分信息暂时不可用</b>{absent.map(label => `${label}：${errorDetails[label] ?? '读取失败'}`).join('；')}。画布中的空白不代表没有数据。</span>
      </div> : null}
      {view === 'threads' ? <nav className="lumo-fleet-pages" aria-label="线程与任务分页">
        <span>{loading ? '正在读取 · ' : ''}第 {fleetPages.length} 次读取 · 本页 {threadFleet?.pagination?.taskCount ?? delegations?.length ?? 0} 个任务{threadFleet === null ? '（仅治理任务首批）' : ''}</span>
        <button type="button" disabled={loading || fleetPages.length === 1} onClick={() => void load(fleetPages.slice(0, -1))}>返回上一页</button>
        <button type="button" disabled={loading || fleetPages.length === 1} onClick={() => void load([{ task: '', thread: '' }])}>回到首页</button>
        <button type="button" disabled={loading || !threadFleet?.pagination?.nextThreadCursor} onClick={() => void load([...fleetPages, { task: fleetPage.task, thread: threadFleet!.pagination!.nextThreadCursor }])}>下一批线程</button>
        <button type="button" disabled={loading || !threadFleet?.pagination?.nextTaskCursor} onClick={() => void load([...fleetPages, { task: threadFleet!.pagination!.nextTaskCursor, thread: '' }])}>下一页任务</button>
      </nav> : null}
      {view === 'threads'
        ? <ThreadBoardPanel
          threads={threadFleet?.threads ?? delegations ?? []}
          loading={loading && threadFleet === null && delegations === null}
          error={threadFleet === null && absent.includes('委派任务') ? '线程与任务这次没读到；空白不表示没有线程。' : ''}
          label={localizedTaskState}
          controlState={threadFleet?.capabilities.controlState ?? false}
        />
        : view === 'board'
        ? (board === null || board.placed.length === 0
          ? <div className={`lumo-collaboration-empty ${teams === null ? 'degraded' : ''}`}><span className="lumo-collaboration-empty-mark"><Glyph surface="operations" /></span><div><b>{teams === null ? '暂时无法读取智能体名册' : teams.length === 0 ? '还没有智能体团队' : '这个团队还没有任务'}</b><p>{teams === null ? '请查看上方的具体错误，修复后重新读取。' : teams.length === 0 ? '团队创建后，成员与任务依赖会显示在这里。' : '任务板按团队展示。目标被分发后，任务与依赖关系会出现在这里。'}</p></div></div>
          : <div className="lumo-collaboration-space">
            <div className="lumo-collaboration-world" style={worldTransform(board.depths, zoom)}>
              {Array.from({ length: board.depths }, (_, level) => <div key={level} className="lumo-collaboration-layer" style={layerTransform(level)}>
                <span>第 {level + 1} 层</span>
              </div>)}
              {board.edges.map(edge => {
                const from = boardPlaced.get(edge.from)
                const to = boardPlaced.get(edge.to)
                if (from === undefined || to === undefined) return null
                return <i key={`${edge.from}->${edge.to}`} className={`lumo-collaboration-rail ${to.state}`} style={railGeometry(from, to)} />
              })}
              {board.placed.map(node => <button
                type="button"
                key={node.id}
                className={`lumo-collaboration-node task ${node.state} ${selectedTask === node.id ? 'selected' : ''}`}
                style={nodeTransform(node.x, node.y)}
                onClick={() => setSelectedTask(node.id)}
              >
                <span className="lumo-collaboration-owner">{node.id} · {node.assignee}</span>
                <b>{node.subject}</b>
                <small className="lumo-collaboration-state">{boardTaskStateLabels[node.state]}</small>
              </button>)}
            </div>
          </div>)
        : loading && users === null && nodes === null
        ? <div className="lumo-collaboration-loading" role="status" aria-label="正在读取员工与注册节点"><i /><i /><i /><span>正在建立协作关系图</span></div>
        : users === null && nodes === null
          ? <div className="lumo-collaboration-empty degraded"><span className="lumo-collaboration-empty-mark"><Glyph surface="collaboration" /></span><div><b>暂时无法建立协作关系图</b><p>员工目录和注册节点都没有返回。可以重新读取，或稍后再试。</p></div><button type="button" onClick={() => void load()}>重新读取</button></div>
        : graph.placed.length === 0
          ? <div className="lumo-collaboration-empty"><span className="lumo-collaboration-empty-mark"><Glyph surface="collaboration" /></span><div><b>等待第一位协作者加入</b><p>当前 realm 还没有员工记录。添加成员和注册节点后，这里会自动形成协作图。</p></div></div>
          : <div className="lumo-collaboration-space">
            <div className="lumo-collaboration-world" style={worldTransform(graph.depths, zoom)}>
              {/* 层带先画，所以它在线与节点之下。层号把「谁在上游」直接写出来，
                  不再让读的人从纵坐标反推——而这张图的全部内容就是这件事。 */}
              {Array.from({ length: graph.depths }, (_, level) => <div key={level} className="lumo-collaboration-layer" style={layerTransform(level)}>
                <span>第 {level + 1} 层</span>
              </div>)}
              {graph.edges.map(edge => {
                const from = positioned.get(edge.from)
                const to = positioned.get(edge.to)
                if (from === undefined || to === undefined) return null
                return <i key={`${edge.from}->${edge.to}`} className="lumo-collaboration-rail" style={railGeometry(from, to)} />
              })}
              {graph.placed.map(node => <button
                type="button"
                key={node.id}
                className={`lumo-collaboration-node ${node.state} ${selected === node.id ? 'selected' : ''}`}
                style={nodeTransform(node.x, node.y)}
                onClick={() => setSelected(node.id)}
              >
                <span className="lumo-collaboration-owner">{node.name}</span>
                {/* 状态与节点数分两行。挤成一行时，196px 的卡片放不下
                    「等待审核 · 注册节点 1/1 在线」，于是它从「在线」中间断开——
                    而中文里断在词中间比换行本身难读得多。 */}
                <small className="lumo-collaboration-state">{employeeStateLabels[node.state]}</small>
                <small className="lumo-collaboration-nodes">注册节点 {node.onlineNodes}/{node.nodeCount} 在线</small>
                {node.agents.length > 0
                  ? <span className="lumo-collaboration-agents">{node.agents.map(item => <i key={item.name} title={item.role ?? ''}>{item.name}{item.status === 'working' ? ' · 工作中' : ''}</i>)}</span>
                  : <small className="lumo-collaboration-nobody">名下没有智能体</small>}
              </button>)}
            </div>
          </div>}
      {clusterOnly && agents.length > 0 ? <div className="lumo-collaboration-unbound">
        <b>智能体成员 {agents.length}</b><span>{agents.map(item => `${item.name} · ${item.teamName}`).join('、')}</span>
      </div> : !clusterOnly && graph.unbound.length > 0 ? <div className="lumo-collaboration-unbound">
        <b>未绑定智能体 {graph.unbound.length}</b>
        {/* 单独成区而不是随便挂一个人：挂错人的智能体看起来是正常的，比空着难发现得多。 */}
        <span>这些成员没有 `ownerUserId`，因此不知道它们为谁工作。{graph.unbound.map(item => item.name).join('、')}</span>
      </div> : null}
    </main>
    {/* 线程看板**没有右栏**：它吃的是同一个委派读面、五格自带全部信息，而预留着的
        320–380px 会把五格各挤到九十来像素宽——「陈亦然 · 12 分 钟前」那种拦腰断词
        就是这么挤出来的。看板要的是宽度，不是面板。 */}
    {view === 'threads' ? null : <aside className="lumo-collaboration-detail">
      <header><span>context</span><b>{view === 'board' ? '任务详情' : '协作者详情'}</b></header>
      {view === 'board'
        ? (selectedTaskNode === undefined
          ? <>
            <div className="lumo-collaboration-detail-card intro"><span className="lumo-collaboration-detail-icon"><Glyph surface="operations" /></span><b>点一个任务查看依赖</b><p>光轨从上游指向下游。阻塞的路径会变成琥珀色，方便快速定位等待点。</p></div>
            {board !== null ? <div className="lumo-collaboration-detail-card"><div className="lumo-collaboration-detail-title"><b>当前团队</b><span>{activeTeam?.name ?? '未选择团队'}</span></div>
              <div className="lumo-compact-list">
                <div><span><b>任务</b><small>{board.placed.length} 条</small></span></div>
                <div><span><b>依赖</b><small>{board.edges.length} 条</small></span></div>
                <div><span><b>阻塞</b><small>{board.placed.filter(node => node.state === 'blocked').length} 条 · 下游全在等</small></span></div>
                <div><span><b>可认领</b><small>{board.placed.filter(node => node.state === 'ready').length} 条 · 现在就能动手</small></span></div>
              </div>
            </div> : null}
          </>
          : <div className="lumo-collaboration-detail-card"><div className="lumo-collaboration-detail-title"><b>{selectedTaskNode.subject}</b><span>{boardTaskStateLabels[selectedTaskNode.state]}</span></div>
            <div className="lumo-compact-list">
              <div><span><b>任务 ID</b><small>{selectedTaskNode.id}</small></span></div>
              <div><span><b>承担者</b><small>{selectedTaskNode.assignee}</small></span></div>
              <div><span><b>依赖链深度</b><small>第 {selectedTaskNode.depth + 1} 层</small></span></div>
              <div><span><b>上游</b><small>{selectedTaskFlow.upstream.length === 0 ? '没有上游，它就是这条链的起点' : selectedTaskFlow.upstream.join('、')}</small></span></div>
              <div><span><b>下游</b><small>{selectedTaskFlow.downstream.length === 0 ? '没有下游' : selectedTaskFlow.downstream.join('、')}</small></span></div>
            </div>
          </div>)
        : <>
          {selectedEmployee === undefined
            ? <div className="lumo-collaboration-detail-card intro"><span className="lumo-collaboration-detail-icon"><Glyph surface="collaboration" /></span><b>选中一名协作者</b><p>查看他的注册节点、上下游深度，以及正在为他工作的智能体。</p></div>
            : <div className="lumo-collaboration-detail-card"><div className="lumo-collaboration-detail-title"><b>{selectedEmployee.name}</b><span>{employeeStateLabels[selectedEmployee.state]}</span></div>
              <div className="lumo-compact-list">
                <div><span><b>注册节点</b><small>{selectedEmployee.nodeCount === 0 ? '该员工还没有注册节点' : `${selectedEmployee.onlineNodes}/${selectedEmployee.nodeCount} 在线`}</small></span></div>
                <div><span><b>名下智能体</b><small>{selectedEmployee.agents.length === 0 ? '没有智能体为他工作' : selectedEmployee.agents.map(item => item.name).join('、')}</small></span></div>
                <div><span><b>上下游深度</b><small>第 {selectedEmployee.depth + 1} 层{graph.edges.some(edge => edge.to === selectedEmployee.id) ? ' · 有上游在给它供活' : ''}</small></span></div>
              </div>
            </div>}
          <div className="lumo-collaboration-detail-card"><div className="lumo-collaboration-detail-title"><b>状态图例</b><span>本图出现的状态</span></div>
            <CollaborationLegend entries={employeeLegend} />
          </div>
        </>}
    </aside>}
    </div>}

    <TeamLauncher capabilities={teamCapabilities} bridge={bridge} onPrepared={onClose} />

    {/* 目标入口。它只把文字交给「项目」里唯一的委派流程，不在这里复制创建契约。 */}
    <form className="lumo-collaboration-goal" onSubmit={event => {
      event.preventDefault()
      const text = goal.trim()
      if (text === '') return
      handOffDelegationGoal(text, 'operations')
      setGoal('')
    }}>
      <div className="lumo-collaboration-goal-copy"><span>新目标</span><b>{clusterOnly ? '治理委派需要就绪的集群' : '把下一件事交给团队'}</b></div>
      <label><Glyph surface="collaboration" /><input value={goal} onChange={event => setGoal(event.target.value)} disabled={clusterOnly} placeholder={clusterOnly ? '当前部署无法使用治理委派' : '描述目标、期望结果和时间要求…'} aria-label="描述目标" /></label>
      <button type="submit" className="lumo-primary" disabled={clusterOnly || goal.trim() === ''}>下达目标 <span aria-hidden="true">↗</span></button>
    </form>
  </section>
}

function OperationsSurface({ onClose }: { onClose: () => void }) {
  const [area, setArea] = useState<'projects' | 'delivery' | 'progress' | 'operations' | 'token-usage' | 'users' | 'departments' | 'roles' | 'permissions' | 'recovery' | 'storage'>(() => pendingDelegationGoal ? 'delivery' : 'projects')
  const [data, setData] = useState<Overview>(emptyOverview)
  const [organizationAllowed, setOrganizationAllowed] = useState(false)
  const [platformAdmin, setPlatformAdmin] = useState(false)
  const [reviewActor, setReviewActor] = useState<ReviewActor | null>(null)
  const [governance, setGovernance] = useState<GovernanceSnapshot | null>(null)
  const [delegations, setDelegations] = useState<DelegatedTask[]>([])
  const [directory, setDirectory] = useState<DirectoryUser[]>([])
	const [delegationError, setDelegationError] = useState('')
	const [directoryError, setDirectoryError] = useState('')
	const [agentPresets, setAgentPresets] = useState<AgentPreset[]>([])
	const [agentPresetError, setAgentPresetError] = useState('')
	const [agentWorkers, setAgentWorkers] = useState<WorkerProfile[]>([])
	const [agentRuntimeError, setAgentRuntimeError] = useState('')
  const [profileUserID, setProfileUserID] = useState('')
  const [profileTags, setProfileTags] = useState('')
  const [profileNotice, setProfileNotice] = useState('')
  const [profileBusy, setProfileBusy] = useState(false)
  const profileReadEpoch = useRef(0)
  const profileWriteEpoch = useRef(0)
  const profilePending = useRef(false)
  const [profileReady, setProfileReady] = useState(false)
  const [profileRetry, setProfileRetry] = useState(0)
  const [delegationPreview, setDelegationPreview] = useState<DelegationPreview | null>(null)
  const taskDetailEpoch = useRef(0)
  const evidenceEpoch = useRef(0)
  useEffect(() => () => { ++taskDetailEpoch.current; ++evidenceEpoch.current }, [])
	const [runsTask, setRunsTask] = useState<DelegatedTask | null>(null)
	const [taskRuns, setTaskRuns] = useState<TaskRun[]>([])
	const [taskAudit, setTaskAudit] = useState<TaskAuditEvent[]>([])
	const [taskCollaboration, setTaskCollaboration] = useState<TaskCollaborationFacts | null>(null)
	const [collaborationError, setCollaborationError] = useState('')
	const [runEvidence, setRunEvidence] = useState<{ runID: string; result: TaskResultFacts | null } | null>(null)
	const [evidenceError, setEvidenceError] = useState('')
	const [evidenceBusy, setEvidenceBusy] = useState('')
	// 会话控制台按 Run 打开：Run 是运维面唯一能拿到的、指向某个具体会话的句柄
	// （`TaskRun.session_ref`）。没有它就无从知道该控制哪个会话，所以入口挂在 Run 行上。
	const [controlSession, setControlSession] = useState('')
	const [flowVersionDiff, setFlowVersionDiff] = useState<FlowVersionDiff | null>(null)
  const [selectedAssignee, setSelectedAssignee] = useState('')
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>('auto')
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState('')
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const projectDetailEpoch = useRef(0)
  const dashboardReadEpoch = useRef(0)
  const dashboardProjectID = useRef('')
  const overviewEpoch = useRef(0)
  const [busy, setBusy] = useState('')
  const delegationFormRef = useRef<HTMLFormElement>(null)
  const pendingRequestKeys = useRef(new Map<string, string>())
  const operationsPending = useRef(false)
  const delegationPreviewEpoch = useRef(0)
  const delegationPreviewInput = useRef('')
  const previewPending = useRef(false)
  const createOnce = async <T,>(path: string, body: string): Promise<T> => {
    const scope = JSON.stringify([path, body])
    let key = pendingRequestKeys.current.get(scope)
    if (key === undefined) { key = crypto.randomUUID(); pendingRequestKeys.current.set(scope, key) }
    const result = await api<T>(path, { method: 'POST', body, headers: { 'Idempotency-Key': key } })
    // Retain the key after a lost response. Retrying the unchanged action then
    // reads its receipt; a confirmed success allows a deliberate new action.
    if (pendingRequestKeys.current.get(scope) === key) pendingRequestKeys.current.delete(scope)
    return result
  }
  // 从协作空间跳过来时，把那边输入的目标填进工作意图。表单是非受控的（提交时读 FormData），
  // 所以这里直接写 DOM 值——把它改成受控组件会牵动整个表单的取值路径，而收益只是这一处。
  // 取用即清空（见 takeDelegationGoal），所以手动进「项目」不会被上一次的目标污染。
  useEffect(() => {
    const goal = takeDelegationGoal()
    if (goal === '') return
    const field = delegationFormRef.current?.elements.namedItem('intent')
    if (field instanceof HTMLTextAreaElement) field.value = goal
  }, [])

  useEffect(() => {
    let active = true
    const accountRead = api<AuthAccount>('/auth/account', { headers: { 'X-Lumo-Auth-Request': '1' } }).then(account => {
      if (active) setReviewActor(account.realm && account.userId ? { realm: account.realm, userId: account.userId } : null)
      return account
    })
    void Promise.all([
      api<{ organization: boolean }>('/lumo/api/capabilities'),
      accountRead,
    ]).then(([capabilities, account]) => {
      if (active) {
        setOrganizationAllowed(capabilities.organization === true && account.roles.some(role => ['platform_admin', 'realm_admin', 'admin'].includes(role)))
        setPlatformAdmin(account.roles.includes('platform_admin'))
      }
    }).catch(() => { if (active) setOrganizationAllowed(false) })
    return () => { active = false }
  }, [])

  const load = useCallback(async () => {
    const generation = ++overviewEpoch.current
    setLoading(true)
    try {
      const [overview, governed, taskData, directoryData, presetResult, workerResult] = await Promise.all([
        api<Overview>('/lumo/api/overview'), api<GovernanceSnapshot>('/lumo/api/governance'),
        optionalApi<{ tasks?: DelegatedTask[] }>('/lumo/api/delegations', { tasks: [] }),
        optionalApi<{ users?: DirectoryUser[] }>('/lumo/api/users', { users: [] }),
			api<{ agent_presets?: AgentPreset[] }>('/lumo/api/agent-presets')
				.then(result => ({ presets: result.agent_presets ?? [], error: '' }))
				.catch(reason => ({ presets: [] as AgentPreset[], error: reason instanceof Error ? reason.message : String(reason) })),
			api<{ workers?: WorkerProfile[] }>('/lumo/api/workers')
				.then(result => ({ workers: (result.workers ?? []).filter(worker => worker.worker_kind === 'agent'), error: '' }))
				.catch(reason => ({ workers: [] as WorkerProfile[], error: reason instanceof Error ? reason.message : String(reason) })),
      ])
		if (generation !== overviewEpoch.current) return
		setData(overview); setGovernance(governed); setDelegations(taskData.data.tasks ?? []); setDirectory(directoryData.data.users ?? []); setDelegationError(taskData.error ?? ''); setDirectoryError(directoryData.error ?? ''); setAgentPresets(presetResult.presets); setAgentPresetError(presetResult.error); setAgentWorkers(workerResult.workers); setAgentRuntimeError(workerResult.error)
    }
    catch (reason) { if (generation === overviewEpoch.current) setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (generation === overviewEpoch.current) setLoading(false) }
  }, [])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30_000); return () => { window.clearInterval(timer); overviewEpoch.current++; projectDetailEpoch.current++; taskDetailEpoch.current++; evidenceEpoch.current++ } }, [load])
  useEffect(() => { if (!directory.some(user => user.id === profileUserID)) setProfileUserID(directory[0]?.id ?? '') }, [directory, profileUserID])
  useEffect(() => {
    const generation = ++profileReadEpoch.current
    ++profileWriteEpoch.current; profilePending.current = false; setProfileBusy(false)
    setProfileTags(''); setProfileNotice(''); setProfileReady(false)
    if (!profileUserID) return
    void optionalApi<{ tags?: string[] }>(`/lumo/api/users/${encodeURIComponent(profileUserID)}/tags`, { tags: [] }).then(result => {
      if (generation !== profileReadEpoch.current) return
      const tags = result.data.tags === null ? [] : result.data.tags
      const valid = result.state === 'ok' && Array.isArray(tags) && tags.every(tag => typeof tag === 'string')
      setProfileTags(valid ? tags!.join(', ') : ''); setProfileReady(valid)
      setProfileNotice(result.error ?? (valid ? '' : '人员标签响应不完整，请重新读取。'))
    })
    return () => { ++profileReadEpoch.current; ++profileWriteEpoch.current }
  }, [profileUserID, profileRetry])
  const run = async <T,>(key: string, success: string, operation: () => Promise<T>): Promise<T | undefined> => { if (operationsPending.current) return undefined; operationsPending.current = true; setBusy(key); try { const result = await operation(); setNotice(success); await load(); return result } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); return undefined } finally { operationsPending.current = false; setBusy(current => current === key ? '' : current) } }
  const createProject = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const name = String(new FormData(form).get('name') ?? '').trim(); if (!name) return; const created = await run('project', `项目「${name}」已创建。`, () => api('/lumo/api/projects', { method: 'POST', body: JSON.stringify({ name }) })); if (created !== undefined) { form.reset(); window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT)) } }
  const createFlow = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); const project = String(fields.get('project') ?? ''); const name = String(fields.get('name') ?? '').trim(); if (!project || !name) return; const created = await run('flow', `流程「${name}」已创建为草稿。`, () => api(`/lumo/api/projects/${encodeURIComponent(project)}/flows`, { method: 'POST', body: JSON.stringify({ name, definition: { nodes: [{ id: 'start', operator: 'identity' }], edges: [] } }) })); if (created !== undefined) form.reset() }
  const openProject = async (project: Row) => {
    if (!project.id) return
    const id = project.id
    const generation = ++projectDetailEpoch.current
    ++dashboardReadEpoch.current
    dashboardProjectID.current = id
    setDashboard(null); setBusy(id); setNotice('')
    try {
      const next = await api<Dashboard>(`/lumo/api/projects/${encodeURIComponent(id)}/dashboard`)
      if (generation !== projectDetailEpoch.current) return
      if (next?.project?.id !== id) throw new Error('项目详情与所选项目不一致，请重新读取。')
      setDashboard(next)
    } catch (reason) { if (generation === projectDetailEpoch.current) setNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (generation === projectDetailEpoch.current) setBusy(current => current === id ? '' : current) }
  }
  const closeDashboard = () => { ++projectDetailEpoch.current; ++dashboardReadEpoch.current; dashboardProjectID.current = ''; setDashboard(null) }
  const triggerFlow = async (flow: Row, action: 'submit' | 'review' | 'run' | 'deprecate' | 'rollback') => {
    const flowID = flow.id; if (!flowID) return
    const body = action === 'review' ? { approve: true, comment: '运营端审核通过' } : action === 'run' ? { input: { source: 'lumo-operations' } } : action === 'rollback' ? { version: Math.max(1, (flow.version ?? 1) - 1) } : {}
    const message = action === 'submit' ? `流程「${flow.name ?? flowID}」已提交审核。` : action === 'review' ? `流程「${flow.name ?? flowID}」已通过审核。` : action === 'deprecate' ? `流程「${flow.name ?? flowID}」已停用。` : action === 'rollback' ? `流程「${flow.name ?? flowID}」已回滚。` : `流程「${flow.name ?? flowID}」试运行完成。`
    const path = `/lumo/api/flows/${encodeURIComponent(flowID)}/${action}`
    await run(flowID, message, () => action === 'run' ? createOnce(path, JSON.stringify(body)) : api(path, { method: 'POST', body: JSON.stringify(body) }))
  }
  const compareFlowVersions = async (flow: Row) => {
    const flowID = flow.id; const currentVersion = flow.version ?? 0
    if (!flowID || currentVersion < 2) { setNotice('至少需要两个已发布快照才能比较版本差异。'); return }
    setBusy(`flow-diff-${flowID}`)
    try {
      const [previous, current] = await Promise.all([
        api<FlowVersionSnapshot>(`/lumo/api/flows/${encodeURIComponent(flowID)}/versions/${currentVersion - 1}`),
        api<FlowVersionSnapshot>(`/lumo/api/flows/${encodeURIComponent(flowID)}/versions/${currentVersion}`),
      ])
      setFlowVersionDiff({ flow, previous, current })
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy('') }
  }
  const scheduleTask = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget); const taskID = String(fields.get('task_id') ?? '').trim(); if (!taskID) { setNotice('请输入任务 ID。'); return }
    const priority = Number(fields.get('priority') ?? 0); const deadline = Number(fields.get('deadline_ms') ?? 0); const weight = Number(fields.get('weight') ?? 1)
    const result = await run<Placement>('placement', `任务「${taskID}」已提交调度。`, () => api<Placement>('/lumo/api/scheduler/placements', { method: 'POST', body: JSON.stringify({ task_id: taskID, cluster_id: String(fields.get('cluster_id') ?? '').trim(), requires: parseSchedulerRequirements(String(fields.get('requires') ?? '')), priority: Number.isFinite(priority) ? priority : 0, residency: String(fields.get('residency') ?? '').trim(), deadline_ms: Number.isFinite(deadline) ? deadline : 0, queue: String(fields.get('queue') ?? 'default').trim(), weight: Number.isFinite(weight) && weight > 0 ? weight : 1, avoid_nodes: splitCSV(String(fields.get('avoid_nodes') ?? '')) }) }))
    if (result) setPlacement(result)
  }
  const refreshPlacement = async () => { if (!placement?.task_id) return; const result = await run<Placement>('placement-refresh', '调度任务状态已刷新。', () => api<Placement>(`/lumo/api/scheduler/placements/${encodeURIComponent(placement.task_id!)}`)); if (result) setPlacement(result) }
  const previewDelegation = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (previewPending.current || operationsPending.current) return
    const form = event.currentTarget
    const generation = ++delegationPreviewEpoch.current
    const input = JSON.stringify([...new FormData(form).entries()])
    const fields = new FormData(form); const intent = String(fields.get('intent') ?? '').trim(); if (!intent) { setNotice('请先描述要交付的工作意图。'); return }
    previewPending.current = true
    setDelegationPreview(null); delegationPreviewInput.current = ''
    setBusy('delegation-preview'); setNotice('')
    try {
      const result = await api<DelegationPreview>('/lumo/api/delegations/preview', { method: 'POST', body: JSON.stringify({ intent, project_id: String(fields.get('project_id') ?? '').trim(), required_tags: splitCSV(String(fields.get('required_tags') ?? '')), required_skills: splitCSV(String(fields.get('required_skills') ?? '')), residency: String(fields.get('residency') ?? '').trim() }) })
      if (generation !== delegationPreviewEpoch.current || input !== JSON.stringify([...new FormData(form).entries()])) return
      const strings = (value: unknown): string[] => {
        if (value === null) return []
        if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) throw new Error('候选人响应不完整，请重新识别。')
        return value as string[]
      }
      if (!result || (result.candidates !== null && !Array.isArray(result.candidates))) throw new Error('候选人响应不完整，请重新识别。')
      delegationPreviewInput.current = input
      const candidates = (result.candidates ?? []).map(candidate => {
        if (!candidate || !(candidate.worker_id || candidate.user_id) || typeof candidate.display_name !== 'string' || typeof candidate.eligible !== 'boolean' || !Number.isFinite(candidate.score) || !Number.isSafeInteger(candidate.active_tasks)) throw new Error('候选人响应不完整，请重新识别。')
        return { ...candidate, worker_id: candidate.worker_id || candidate.user_id, user_id: candidate.user_id || candidate.worker_id,
          matched_tags: strings(candidate.matched_tags), matched_skills: strings(candidate.matched_skills), rationale: strings(candidate.rationale) }
      })
      setDelegationPreview({ ...result, candidates, intent_terms: strings(result.intent_terms), inferred_tags: strings(result.inferred_tags), inferred_skills: strings(result.inferred_skills) }); setSelectedAssignee(candidates.find(candidate => candidate.eligible)?.worker_id ?? ''); setAssignmentMode('auto')
    } catch (reason) { if (generation === delegationPreviewEpoch.current) setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { previewPending.current = false; setBusy(current => current === 'delegation-preview' ? '' : current) }
  }
  const dispatchDelegation = async () => {
    const form = delegationFormRef.current; if (!form || !delegationPreview || operationsPending.current) return
    if (delegationPreviewInput.current !== JSON.stringify([...new FormData(form).entries()])) { setDelegationPreview(null); setNotice('任务条件已变化，请重新识别候选人。'); return }
    const fields = new FormData(form); const intent = String(fields.get('intent') ?? '').trim(); const title = String(fields.get('title') ?? '').trim() || intent
    const submittedInput = JSON.stringify([...fields.entries()])
    const selected = delegationPreview.candidates.find(candidate => candidate.worker_id === selectedAssignee || candidate.user_id === selectedAssignee)
    if (assignmentMode === 'manual' ? !selected?.eligible : !delegationPreview.candidates.some(candidate => candidate.eligible)) { setNotice('当前没有满足条件的执行者，请重新识别候选人。'); return }
    const assignee = selected?.display_name ?? selectedAssignee
    const result = await run<DelegatedTask>('delegation', assignmentMode === 'auto' ? `任务「${title}」已按意图、标签、技能和负载自动分发。` : `任务「${title}」已分发给 ${assignee}。`, async () => {
      const created = await createOnce<DelegationCreated>('/lumo/api/delegations', JSON.stringify({ title, intent, project_id: String(fields.get('project_id') ?? '').trim(), required_tags: splitCSV(String(fields.get('required_tags') ?? '')), required_skills: splitCSV(String(fields.get('required_skills') ?? '')), assignee_user_id: assignmentMode === 'auto' || selected?.worker_kind === 'agent' ? '' : selected?.user_id ?? '', assignee_worker_id: assignmentMode === 'auto' ? '' : selected?.worker_id ?? selectedAssignee, auto_assign: assignmentMode === 'auto', schedule: { cluster_id: String(fields.get('cluster_id') ?? '').trim(), requires: parseSchedulerRequirements(String(fields.get('requires') ?? '')), priority: Number(fields.get('priority') ?? 0) || 0, residency: String(fields.get('residency') ?? '').trim(), queue: 'delegated', weight: 1, avoid_nodes: [] } }))
      return created.task ?? created as DelegatedTask
    })
    if (result && submittedInput === JSON.stringify([...new FormData(form).entries()])) { setDelegationPreview(null); setSelectedAssignee(''); form.reset() }
  }
  const cancelTask = async (task: DelegatedTask) => {
    await run(`task-${task.id}`, `已向执行节点请求取消「${task.title}」；将在收到终态回报后显示最终结果。`, () =>
      api(`/lumo/api/delegations/${encodeURIComponent(task.id)}/cancel`, { method: 'POST' }),
    )
  }
	const retryTask = async (task: DelegatedTask) => {
		await run(`retry-${task.id}`, `任务「${task.title}」已创建新的执行尝试；历史 Run 已保留。`, () =>
			api(`/lumo/api/delegations/${encodeURIComponent(task.id)}/retry`, { method: 'POST', body: JSON.stringify({ reason: '从运营台重试' }) }),
		)
	}
	const reassignTask = async (task: DelegatedTask) => {
		await run(`reassign-${task.id}`, `任务「${task.title}」已改派给下一位合格执行者；原 Run 已保留。`, () =>
			api(`/lumo/api/delegations/${encodeURIComponent(task.id)}/reassign`, { method: 'POST', body: JSON.stringify({ reason: '从运营台改派' }) }),
		)
	}
	const showTaskRuns = async (task: DelegatedTask, generation = ++taskDetailEpoch.current) => {
    ++evidenceEpoch.current; setControlSession('')
		setBusy(`runs-${task.id}`)
		setRunEvidence(null); setEvidenceError('')
		try {
			const [runs, audit, collaboration] = await Promise.all([
				api<{ runs?: TaskRun[] }>(`/lumo/api/tasks/${encodeURIComponent(task.id)}/runs`),
				api<{ events?: TaskAuditEvent[] }>(`/lumo/api/tasks/${encodeURIComponent(task.id)}/audit`),
				// 子任务进度与 Run 列表是两条读面：协作面要求委派权限，缺权限时
				// 只有这一块不可用，不能让整张执行视图跟着变成空白。
				optionalApi<TaskCollaborationFacts | null>(`/lumo/api/tasks/${encodeURIComponent(task.id)}/collaboration`, null),
			])
      if (generation !== taskDetailEpoch.current) return
			setRunsTask(task); setTaskRuns(runs.runs ?? []); setTaskAudit(audit.events ?? [])
			setTaskCollaboration(collaboration.data); setCollaborationError(collaboration.error ?? '')
		} catch (reason) { if (generation === taskDetailEpoch.current) setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { if (generation === taskDetailEpoch.current) setBusy('') }
	}
	// 结果全文是独立读面：列表里只有 Run 的调度信息，产出必须单独取，
	// 而且取不到（未上报 / 标识符被代理拒绝）要显示原因，不能显示成空产出。
	const loadRunEvidence = async (task: DelegatedTask, runID: string) => {
    const generation = ++evidenceEpoch.current
		setEvidenceBusy(runID); setEvidenceError(''); setRunEvidence({ runID, result: null })
		try {
			const result = await api<TaskResultFacts>(`/lumo/api/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(runID)}/result`)
      if (generation !== evidenceEpoch.current) return
			setRunEvidence({ runID, result })
		} catch (reason) { if (generation === evidenceEpoch.current) setEvidenceError(reason instanceof Error ? reason.message : String(reason)) }
		finally { if (generation === evidenceEpoch.current) setEvidenceBusy('') }
	}
	const closeEvidence = () => { ++evidenceEpoch.current; setEvidenceBusy(''); setRunEvidence(null); setEvidenceError('') }
  // 单独读取授权后的详情，分页目录不限制协作任务的可打开范围。
  const openTaskByID = async (taskID: string) => {
    const generation = ++taskDetailEpoch.current
    try {
      const task = await api<DelegatedTask>(`/lumo/api/delegations/${encodeURIComponent(taskID)}`)
      if (generation !== taskDetailEpoch.current) return
      await showTaskRuns(task, generation)
    } catch (reason) { if (generation === taskDetailEpoch.current) setNotice(reason instanceof Error ? reason.message : String(reason)) }
  }
  const openChildTask = (child: TaskIntentFacts) => { void openTaskByID(child.id) }
	const closeTaskRuns = () => { ++taskDetailEpoch.current; setBusy(''); setRunsTask(null); setTaskRuns([]); setTaskAudit([]); setTaskCollaboration(null); setCollaborationError(''); setControlSession(''); closeEvidence() }
  const saveProfileTags = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (!profileUserID || !profileReady || profilePending.current) return
    const generation = ++profileWriteEpoch.current
    const id = profileUserID
    profilePending.current = true
    setProfileBusy(true); setProfileNotice('')
    try {
      const result = await api<{ tags?: string[] }>(`/lumo/api/users/${encodeURIComponent(id)}/tags`, { method: 'PUT', body: JSON.stringify({ tags: splitCSV(profileTags) }) })
      if (generation !== profileWriteEpoch.current) return
      if (!Array.isArray(result.tags) || !result.tags.every(tag => typeof tag === 'string')) throw new Error('标签保存回执不完整，请核对后再继续。')
      setProfileTags(result.tags.join(', ')); setProfileNotice('人员标签已保存，后续意图分发会使用最新画像。')
      ++delegationPreviewEpoch.current; delegationPreviewInput.current = ''; setDelegationPreview(null)
    } catch (reason) { if (generation === profileWriteEpoch.current) setProfileNotice(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (generation === profileWriteEpoch.current) { profilePending.current = false; setProfileBusy(false) } }
  }
	const toggleAgentPreset = async (preset: AgentPreset) => {
		const nextStatus = preset.status === 'active' ? 'disabled' : 'active'
		await run(`agent-preset-${preset.id}`, `Agent「${preset.name}」已${nextStatus === 'active' ? '启用' : '停用'}；新的委派匹配会立即遵循该状态。`, () =>
			api(`/lumo/api/agent-presets/${encodeURIComponent(preset.id)}`, { method: 'PATCH', body: JSON.stringify({ revision: preset.revision, status: nextStatus }) }),
		)
	}
  const refreshDashboard = async () => {
    const projectID = dashboard?.project?.id
    if (!projectID) throw new Error('项目详情不可用，请重新打开。')
    const generation = projectDetailEpoch.current
    const reading = ++dashboardReadEpoch.current
    try {
      const next = await api<Dashboard>(`/lumo/api/projects/${encodeURIComponent(projectID)}/dashboard`)
      if (generation !== projectDetailEpoch.current || reading !== dashboardReadEpoch.current || dashboardProjectID.current !== projectID) return
      if (next?.project?.id !== projectID) throw new Error('项目详情与所选项目不一致，请重新读取。')
      setDashboard(next)
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT))
    } catch (reason) {
      if (generation === projectDetailEpoch.current && reading === dashboardReadEpoch.current && reason instanceof ApiError && [401, 403, 404].includes(reason.status)) closeDashboard()
      throw reason
    }
  }
  const projectLifecycle = async (action: 'archive' | 'unarchive') => {
    const projectID = dashboard?.project?.id
    if (!projectID) throw new Error('项目详情不可用，请重新打开。')
    const generation = projectDetailEpoch.current
    setBusy(`project-${action}`); setNotice('')
    try {
      await api(`/lumo/api/projects/${encodeURIComponent(projectID)}/${action}`, { method: 'POST' })
      setNotice(action === 'archive' ? '项目已归档。' : '项目已恢复。')
      window.dispatchEvent(new Event(PROJECTS_CHANGED_EVENT))
      if (generation === projectDetailEpoch.current) closeDashboard()
      await load()
    } finally { setBusy('') }
  }
  useEffect(() => {
    const navigate = () => {
      const target = takeOperationsTarget()
      if (!target) return
      if (target.kind === 'task') { setArea('delivery'); void openTaskByID(target.id) }
      else { setArea('projects'); void openProject({ id: target.id }) }
    }
    navigate()
    window.addEventListener(OPERATIONS_TARGET_EVENT, navigate)
    return () => window.removeEventListener(OPERATIONS_TARGET_EVENT, navigate)
  }, [])
  const online = countOnline(data)
  const permissionDecisions = rowsOf<PermissionDecision>(governance?.permissions, 'decisions')
	const agentWorkerByPreset = new Map(agentWorkers.map(worker => [worker.worker_id.replace(/^agent:/u, ''), worker]))
	const agentRuntimeLabel = (preset: AgentPreset) => {
		const worker = agentWorkerByPreset.get(preset.id)
		if (!worker) return agentRuntimeError ? '执行态不可读取' : '执行态未上报'
		if (worker.runtime_status === 'not_reported') return '执行态未上报'
		return `执行态 ${worker.runtime_status ?? worker.status} · ${worker.active_tasks}/${worker.max_concurrency} 运行中`
	}
  const configured = data.plugins
  if (data.deployment.mode === 'local') {
    return <div className="lumo-surface lumo-workspace-page lumo-project-surface"><WorkspaceHero surface="operations" onClose={onClose} statement="让每个项目都有清楚的边界与下一步。" description="从项目资产到流程执行，在一个工作区里确认状态、推进任务并追踪结果。"><div className="lumo-workspace-status"><span>local workspace</span><b><i aria-hidden="true" />{loading ? '正在同步' : '本地运行'}</b><dl><div><dt>项目</dt><dd>{data.projects.length}</dd></div><div><dt>插件</dt><dd>{configured.length}</dd></div><div><dt>存储</dt><dd>本机</dd></div></dl><BusyButton className="lumo-secondary" busy={loading} onClick={() => void load()}>刷新状态</BusyButton></div></WorkspaceHero><DeploymentBanner deployment={data.deployment} /><LocalModePanel plugins={configured} /></div>
  }
  return <div className="lumo-surface lumo-workspace-page lumo-project-surface">
    <WorkspaceHero surface="operations" onClose={onClose} statement="让每个项目都有清楚的边界与下一步。" description="从项目资产到流程执行，在一个工作区里确认状态、推进任务并追踪结果。">
      <div className={`lumo-workspace-status ${online === 0 && !loading ? 'degraded' : ''}`}><span>project control</span><b><i aria-hidden="true" />{loading ? '正在同步' : online > 0 ? '控制面已连接' : '等待控制服务'}</b><dl><div><dt>项目</dt><dd>{data.projects.length}</dd></div><div><dt>流程</dt><dd>{data.flows.length}</dd></div><div><dt>执行节点</dt><dd>{data.cluster.nodes.length}</dd></div></dl><BusyButton className="lumo-secondary" busy={loading} onClick={() => void load()}>重新读取</BusyButton></div>
    </WorkspaceHero>
    <DomainTabs label="项目与运营分区" value={area} onChange={setArea} items={[
      { id: 'projects', title: '项目资产', description: '项目、流程与项目详情' },
      { id: 'delivery', title: '协作执行', description: '委派、专家与运行证据' },
      ...(data.deployment.clusterReady ? [{ id: 'progress' as const, title: '团队进度', description: '员工、智能体、阻塞与交接' }] : []),
      { id: 'operations', title: '集群与服务', description: '节点、调度与服务健康' },
      ...(platformAdmin ? [{ id: 'token-usage' as const, title: 'Token 用量', description: '平台模型 token 与费用统计' }] : []),
      ...(organizationAllowed && data.deployment.clusterReady ? [
        { id: 'users' as const, title: '用户管理', description: '用户资料、登录方式与角色分配' },
        { id: 'departments' as const, title: '部门管理', description: '部门目录、上下级关系与负责人' },
        { id: 'roles' as const, title: '角色管理', description: '角色目录、启停与授权维护' },
        { id: 'recovery' as const, title: '恢复审批', description: '双人审批、恢复执行与回执核对' },
        { id: 'storage' as const, title: '存储配额', description: '逻辑引用容量与租户、项目上限' },
      ] : []),
      ...(data.deployment.clusterReady ? [{ id: 'permissions' as const, title: '权限', description: '查看当前身份的有效权限和判定原因' }] : []),
    ]} />
    {notice ? <Notice error={notice.includes('失败') || notice.includes('unavailable')} close={() => setNotice('')}>{notice}</Notice> : null}
    {area === 'progress' && data.deployment.clusterReady ? <WorkforceProgressPanel request={api} onOpen={id => { setArea('delivery'); void openTaskByID(id) }} /> : null}
    {area === 'operations' ? <>
    <DeploymentBanner deployment={data.deployment} />
    {data.deployment.clusterReady ? <ClusterNodesPanel request={api} /> : null}
    {data.deployment.clusterReady && platformAdmin ? <SchedulerClustersPanel request={api} /> : null}
    <div className="lumo-metric-grid"><Metric label="在线服务" value={`${online}/${Object.keys(data.services).length}`} note={loading ? '同步中' : '服务进程探活'} tone="mint" /><Metric label="Nacos 执行节点" value={String(data.cluster.nodes.length)} note={data.cluster.leader?.holder ?? '等待主节点'} /><Metric label="装配插件" value={String(data.plugins.length)} note="生效装配" /><Metric label="当前项目" value={String(data.projects.length)} note={data.generatedAt ? `同步 ${formatSync(data.generatedAt)}` : '尚未同步'} /></div>
    <div className="lumo-project-control-grid">
    <Section title="服务与调度" meta={data.generatedAt ? `进程探活 · 同步 ${formatSync(data.generatedAt)}` : '尚未同步'}><div className="lumo-service-grid">{Object.entries(data.services).map(([name, service], index) => <SpotlightCard className="lumo-service-card" index={index} key={name}><i className={service.ok ? 'online' : 'offline'} /><span><b>{localizedServiceName(name)}</b><small>{localizedServiceHealth(service)}</small></span><em>{service.ok ? '可达' : '不可达'}</em></SpotlightCard>)}</div><div className="lumo-inline-empty">服务卡片来自 /healthz 进程探活；Nacos 执行节点、调度集群心跳与受管桌面节点各自独立统计。</div>{data.cluster.nodes.length ? <div className="lumo-node-strip">{data.cluster.nodes.map(node => <span key={node.node_id}><i />{node.node_id}<small>{node.capacity ?? 0} 个名额</small></span>)}</div> : <div className="lumo-inline-empty">Nacos 调度目录暂时没有健康、已启用的执行节点。</div>}</Section>
    <Section title="提交调度任务" meta="调度放置 · 支持能力、驻留和队列约束"><form className="lumo-placement-form" onSubmit={scheduleTask}><label><span>任务 ID</span><input name="task_id" required placeholder="例如 report-2026-001" /></label><label><span>集群 ID</span><input name="cluster_id" placeholder="cluster-a" /></label><label><span>队列</span><input name="queue" defaultValue="default" /></label><label><span>优先级</span><input name="priority" type="number" defaultValue="0" /></label><label><span>截止时间戳</span><input name="deadline_ms" type="number" placeholder="可选，Unix ms" /></label><label><span>权重</span><input name="weight" type="number" min="1" defaultValue="1" /></label><label className="wide"><span>能力要求</span><input name="requires" placeholder="gpu=1, region=cn-east" /></label><label><span>数据驻留</span><input name="residency" placeholder="cn-east" /></label><label><span>避让节点</span><input name="avoid_nodes" placeholder="node-b, node-c" /></label><BusyButton type="submit" busy={busy === 'placement'} className="lumo-primary">提交调度</BusyButton></form>{placement ? <div className="lumo-placement-result"><div><b>{placement.state ?? '等待中'}</b><span>{placement.task_id} · {placement.node_id ?? '等待节点'} · 尝试 {placement.attempt ?? 0}{placement.preemption_requested_task_id ? ` · 已向 ${placement.preemption_requested_task_id} 请求抢占，等待其终态释放名额` : ''}</span></div><small>隔离令牌 {placement.fencing_token ?? '未分配'}</small><BusyButton className="lumo-secondary lumo-small" busy={busy === 'placement-refresh'} onClick={() => void refreshPlacement()}>刷新任务状态</BusyButton></div> : null}</Section>
    </div>
    </> : null}
    {area === 'projects' ? <>
    {data.deployment.clusterReady ? <FlowManagementPanel request={api} projects={data.projects} refresh={load} /> : null}
    <div className="lumo-split"><Section title="项目边界" meta={`${data.projects.length} 个`}><form className="lumo-inline-form" onSubmit={createProject}><label><span>新项目</span><input name="name" placeholder="项目名称" /></label><BusyButton type="submit" busy={busy === 'project'} className="lumo-primary">创建</BusyButton></form><ProjectDirectoryPanel request={api} onOpen={id => void openProject({ id })} openingId={busy} refreshKey={data.generatedAt} /></Section><Section title="流程管理" meta={`${data.flows.length} 条`}><form className="lumo-flow-form" onSubmit={createFlow}><label><span>归属项目</span><select name="project" defaultValue="" aria-label="归属项目"><option value="" disabled>选择项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name ?? project.id}</option>)}</select></label><label><span>流程名称</span><input name="name" placeholder="流程名称" /></label><BusyButton type="submit" busy={busy === 'flow'} disabled={data.projects.length === 0} className="lumo-primary">新建</BusyButton></form><div className="lumo-compact-list">{data.flows.length ? data.flows.map(flow => <div key={flow.id}><span><b>{flow.name ?? flow.id}</b><small>{flow.status === 'unknown' || !flow.status ? '未声明状态' : flow.status} · v{flow.version ?? 1}</small></span>{flow.status === 'draft' ? <BusyButton busy={busy === flow.id} className="lumo-small" onClick={() => void triggerFlow(flow, 'submit')}>提交审核</BusyButton> : flow.status === 'submitted' ? <BusyButton busy={busy === flow.id} className="lumo-small" onClick={() => void triggerFlow(flow, 'review')}>审核通过</BusyButton> : ['published', 'targeted'].includes(flow.status ?? '') ? <span className="lumo-flow-actions"><BusyButton busy={busy === flow.id} className="lumo-small" onClick={() => void triggerFlow(flow, 'run')}>试运行</BusyButton><BusyButton busy={busy === `flow-diff-${flow.id}`} disabled={(flow.version ?? 0) < 2} className="lumo-small lumo-secondary" onClick={() => void compareFlowVersions(flow)}>版本差异</BusyButton><BusyButton busy={busy === flow.id} className="lumo-small lumo-danger" onClick={() => void triggerFlow(flow, 'deprecate')}>停用</BusyButton></span> : flow.status === 'deprecated' ? <em>已停用</em> : <em>治理中</em>}</div>) : <Empty>还没有流程。流程从草稿开始，提交后进入治理审核。</Empty>}</div>{flowVersionDiff ? <div className="lumo-flow-version-diff"><header><span><b>流程版本对比</b><small>{flowVersionDiff.flow.name ?? flowVersionDiff.flow.id} · v{flowVersionDiff.previous.version} → v{flowVersionDiff.current.version} · 审核人 {flowVersionDiff.previous.reviewer || '未记录'} / {flowVersionDiff.current.reviewer || '未记录'}</small></span><button type="button" className="lumo-quiet" onClick={() => setFlowVersionDiff(null)} aria-label="关闭版本对比">×</button></header><ul>{flowVersionChanges(flowVersionDiff.previous.definition, flowVersionDiff.current.definition).map(change => <li key={change}>{change}</li>)}</ul><p>对比的是已发布不可变快照；草稿编辑不会改变此结果。</p></div> : null}</Section></div>
    </> : null}
    {area === 'delivery' ? <>
    {data.deployment.clusterReady ? <AgentPresetEditor request={api} presets={agentPresets} refresh={load} /> : null}
    <Section title="上下游任务协同" meta={governance?.features.ok ? '集群已就绪 · 意图、标签、有效技能交集' : '仅集群已就绪时开放跨用户委派'}><div className="lumo-delegation-layout"><form ref={delegationFormRef} className="lumo-delegation-form" onSubmit={previewDelegation} onChange={() => { ++delegationPreviewEpoch.current; delegationPreviewInput.current = ''; setDelegationPreview(null); setSelectedAssignee('') }}><label><span>任务标题</span><input name="title" placeholder="例如：华东客户合同复核" /></label><label className="wide"><span>工作意图</span><textarea name="intent" rows={3} required placeholder="描述交付结果、业务范围和约束，例如：跟进华东客户的合同复核并标出高风险条款。" /></label><label><span>项目边界</span><select name="project_id" defaultValue=""><option value="">不绑定项目</option>{data.projects.map(project => <option key={project.id} value={project.id}>{project.name ?? project.id}</option>)}</select></label><label><span>必须标签</span><input name="required_tags" placeholder="华东, 客户" /></label><label><span>必须技能</span><input name="required_skills" placeholder="合同复核" /></label><label><span>调度集群</span><input name="cluster_id" placeholder="cluster-a" /></label><label className="wide"><span>节点能力</span><input name="requires" placeholder="cpu, region=cn-east" /></label><label><span>优先级</span><input name="priority" type="number" defaultValue="0" /></label><label><span>数据驻留</span><input name="residency" placeholder="cn-east" /></label><BusyButton type="submit" busy={busy === 'delegation-preview'} className="lumo-primary">识别候选人</BusyButton></form><div className="lumo-delegation-preview">{delegationPreview ? <><div className="lumo-preview-head"><div><span className="lumo-inspector-label">匹配预览</span><b>{delegationPreview.candidates.filter(candidate => candidate.eligible).length} 个可分发对象</b></div><small>{delegationPreview.intent_terms.join(' · ') || '未提取词项'}</small></div><div className="lumo-inference"><span>识别标签：{delegationPreview.inferred_tags.join('、') || '无'}</span><span>识别技能：{delegationPreview.inferred_skills.join('、') || '无'}</span></div><div className="lumo-assignment-mode"><label><input type="checkbox" checked={assignmentMode === 'auto'} onChange={event => setAssignmentMode(event.target.checked ? 'auto' : 'manual')} /> <b>自动分发</b><span>按意图 · 标签 · 技能 · 当前负载选择</span></label><small>{assignmentMode === 'auto' ? '系统将在服务端再次计算候选集并写入审计理由。' : '手动指定仅可选择满足硬约束的候选人。'}</small></div><div className="lumo-candidate-list">{delegationPreview.candidates.slice(0, 8).map(candidate => <button type="button" disabled={!candidate.eligible} className={assignmentMode === 'manual' && selectedAssignee === candidate.worker_id ? 'selected' : ''} key={candidate.worker_id} onClick={() => { setSelectedAssignee(candidate.worker_id ?? candidate.user_id); setAssignmentMode('manual') }}><span><b>{candidate.display_name}</b><small>{candidate.user_id} · {candidate.active_tasks} 个进行中任务</small></span><em>{candidate.eligible ? `${candidate.score} · ${candidate.matched_tags.concat(candidate.matched_skills).join(' / ') || '可接收'}` : candidate.rationale[0] ?? '不满足条件'}</em></button>)}</div><BusyButton busy={busy === 'delegation'} disabled={assignmentMode === 'manual' ? !delegationPreview.candidates.some(candidate => candidate.eligible && candidate.worker_id === selectedAssignee) : !delegationPreview.candidates.some(candidate => candidate.eligible)} className="lumo-primary" onClick={() => void dispatchDelegation()}>{assignmentMode === 'auto' ? `自动分发${delegationPreview.candidates.find(candidate => candidate.eligible)?.display_name ? ` · 推荐 ${delegationPreview.candidates.find(candidate => candidate.eligible)?.display_name}` : ''}` : `确认分发给 ${delegationPreview.candidates.find(candidate => candidate.worker_id === selectedAssignee)?.display_name ?? '候选人'}`}</BusyButton></> : <div className="lumo-delegation-empty"><Glyph surface="operations" /><b>先描述任务，再生成可解释分发建议</b><p>系统只使用当前 realm 的启用用户、用户标签和已生效技能；没有满足交集时不会强行分发。</p></div>}</div></div><div className="lumo-task-tracker"><header><b>任务跟踪</b><span>{delegationError ? '请求未完成' : `${delegations.length} 条记录 · 30 秒同步`}</span></header>{delegations.length ? delegations.map(task => <div className="lumo-task-row" key={task.id}><span className="lumo-task-state"><i className={task.state === 'COMPLETED' ? 'done' : task.state === 'FAILED' || task.state === 'BLOCKED' ? 'bad' : 'live'} />{localizedTaskDisplayState(task)}</span><span className="lumo-task-main"><b>{task.title}</b><small>{task.assignee_name ?? task.assignee_user_id} · {task.selected_skills.join(' / ') || '意图匹配'} · {task.assigned_node_id ?? '等待节点'}</small></span><em>{task.updated_at ? formatSync(task.updated_at) : '刚刚'}</em>{['ASSIGNED', 'QUEUED', 'RUNNING'].includes(task.state) ? <BusyButton busy={busy === `task-${task.id}`} className="lumo-small lumo-danger" onClick={() => void cancelTask(task)}>取消任务</BusyButton> : task.state === 'CANCELLING' ? <em>取消中，等待执行节点确认</em> : null}</div>) : <Empty>{delegationError || '还没有委派任务。识别候选人后，系统会保留委派、技能快照和节点调度状态。'}</Empty>}</div></Section>
    <Section title="人员画像" meta="标签直接参与意图分发与负载排序"><div className="lumo-profile-layout">{directory.length ? <form className="lumo-profile-form" onSubmit={saveProfileTags}><label><span>人员</span><select value={profileUserID} onChange={event => setProfileUserID(event.target.value)}>{directory.map(user => <option value={user.id} key={user.id}>{user.display_name} · {user.id}</option>)}</select></label><label className="wide"><span>标签</span><input disabled={profileBusy || !profileReady} value={profileTags} onChange={event => setProfileTags(event.target.value)} placeholder="华东, 合同, 客户成功" /></label><BusyButton type="submit" busy={profileBusy} disabled={!profileReady} className="lumo-primary">保存标签</BusyButton><button type="button" className="lumo-button lumo-secondary" disabled={profileBusy} onClick={() => setProfileRetry(value => value + 1)}>重新读取标签</button>{profileNotice ? <small className="lumo-form-note">{profileNotice}</small> : null}</form> : <div className="lumo-profile-empty"><b>{directoryError ? '人员目录请求失败' : '人员目录不可用'}</b><span>{directoryError || '只有集群已就绪且当前身份具备 task:delegate 权限时，才能编辑人员画像。'}</span></div>}<div className="lumo-profile-hint"><span>分发判定</span><b>标签硬约束 + 技能交集 + 当前负载</b><small>保存后立即影响下一次预览；已经分发的任务保留当时的技能快照与匹配理由，便于审计。</small></div></div></Section>
    <Section title="专家运行管理" meta={agentPresetError ? '专家目录不可用' : `${agentPresets.length} 个专家 · 配置与运行态分离`} actions={<button type="button" className="lumo-button lumo-secondary" onClick={() => openSurface('skillhub')}>前往技能中心新建专家</button>}><div className="lumo-agent-preset-layout directory"><div className="lumo-table-list">{agentPresets.length ? agentPresets.map(preset => <div key={preset.id}><span><b>{preset.name}</b><small>{preset.provider} · {preset.model_ref} · {agentOutputProfileLabel(preset.output_profile)} · v{preset.version} · 所有者 {preset.owner_user_id}{preset.project_id ? ` · 项目 ${preset.project_id}` : ' · 全 Realm'}</small></span><em>{preset.status === 'active' ? `启用 · ${preset.max_concurrency} 并发 · ${agentRuntimeLabel(preset)}` : `已停用 · ${agentRuntimeLabel(preset)}`}</em><BusyButton className={preset.status === 'active' ? 'lumo-danger lumo-small' : 'lumo-secondary lumo-small'} busy={busy === `agent-preset-${preset.id}`} onClick={() => void toggleAgentPreset(preset)}>{preset.status === 'active' ? '停用' : '启用'}</BusyButton></div>) : <Empty>{agentPresetError || '尚未创建专家。普通成员只能看到自己拥有的专家。'}</Empty>}</div></div></Section>
    </> : null}
    {area === 'permissions' ? <Section title="权限诊断" meta="Realm ∩ Project ∩ Space · 未知边界默认拒绝"><p className="lumo-form-hint">这里展示当前登录身份的有效权限和判定依据；用户角色分配在“用户管理”中维护。</p><div className="lumo-compact-list">{governance?.permissions?.ok ? permissionDecisions.map(decision => <div key={decision.action}><span><b>{decision.action}</b><small>{decision.reason}</small></span><em>{decision.allowed ? `允许 · ${decision.matched_policies.join(' + ')}` : '拒绝'}</em></div>) : <Empty>{governance?.permissions?.error || '权限策略版本尚未部署；当前不会将其伪装为空权限。'}</Empty>}</div></Section> : null}
    {area === 'token-usage' && platformAdmin ? <TokenUsagePanel platformAdmin={platformAdmin} /> : null}
    {area === 'recovery' && organizationAllowed && data.deployment.clusterReady ? <RecoveryWorkflowPanel request={api} /> : null}
    {area === 'storage' && organizationAllowed && data.deployment.clusterReady ? <StorageQuotaPanel request={api} /> : null}
    {area === 'delivery' ? <>
    <Section title="任务执行视图" meta="Task → 当前 Run 投影 · 非子 Agent 运行树"><OrchestrationTopology tasks={delegations} busy={busy} cancel={cancelTask} retry={retryTask} reassign={reassignTask} showRuns={showTaskRuns} /></Section>
    {runsTask ? <Section title={`执行详情 · ${runsTask.title}`} meta={`${taskRuns.length} 次不可变 Run · ${taskCollaboration?.summary.total ?? 0} 个子任务`} actions={<BusyButton className="lumo-secondary lumo-small" onClick={closeTaskRuns}>关闭</BusyButton>}>
      <TaskIntentContractPanel task={taskCollaboration?.task ?? runsTask} />
      <TaskProgressPanel key={runsTask.id} request={api} taskID={runsTask.id} />
      <TaskCollaboratorsPanel request={api} taskID={runsTask.id} />
      <TaskCollaborationPanel progress={taskCollaboration} error={collaborationError} label={localizedTaskState} open={openChildTask} />
      <div className="lumo-compact-list">{taskRuns.length ? taskRuns.map(run => <div key={run.id}><span><b>尝试 {run.attempt} · {localizedTaskState(run.state)}</b><small>{run.worker_id} · {run.assigned_node_id ?? '等待节点'}{run.last_error ? ` · ${run.last_error}` : ''}</small></span><em>{run.ended_at ? `结束 ${formatSync(run.ended_at)}` : run.started_at ? `开始 ${formatSync(run.started_at)}` : formatSync(run.created_at)}</em>{run.session_ref ? <BusyButton className="lumo-secondary lumo-small" onClick={() => setControlSession(current => current === run.session_ref ? '' : (run.session_ref ?? ''))}>会话控制</BusyButton> : null}<BusyButton className="lumo-secondary lumo-small" busy={evidenceBusy === run.id} onClick={() => void loadRunEvidence(runsTask, run.id)}>查看证据</BusyButton></div>) : <Empty>该任务尚未生成 Run；创建新尝试时会保留旧调度记录。</Empty>}</div>
      {taskRuns.filter(run => run.state === 'COMPLETED' && !taskRuns.some(other => other.attempt > run.attempt)).map(run => <RunReviewPanel<DelegatedTask> key={`${reviewActor?.realm}:${reviewActor?.userId}:${runsTask.id}:${run.id}`} request={api} actor={reviewActor} taskID={runsTask.id} projectID={runsTask.project_id} run={run} workers={agentWorkers} workersError={agentRuntimeError} onOpen={task => void showTaskRuns(task)} />)}
      {runEvidence ? <TaskEvidencePanel taskID={runsTask.id} request={api} runID={runEvidence.runID} result={runEvidence.result} error={evidenceError} busy={evidenceBusy !== ''} label={localizedTaskState} close={closeEvidence} /> : null}
      {controlSession ? <SessionControlPanel request={api} sessionRef={controlSession} close={() => setControlSession('')} /> : null}
      <div className="lumo-compact-list"><header><b>操作审计</b><span>{taskAudit.length} 条</span></header>{taskAudit.length ? taskAudit.map(event => <div key={event.id}><span><b>{event.event}</b><small>{event.actor} · {Object.entries(event.detail).map(([key, value]) => `${key}=${String(value)}`).join(' · ') || '无额外详情'}</small></span><em>{formatSync(event.created_at)}</em></div>) : <Empty>尚无可显示的控制操作。</Empty>}</div>
    </Section> : null}
    </> : null}
    {['users', 'departments', 'roles'].includes(area) && organizationAllowed && data.deployment.clusterReady ? <OrganizationManagement view={area as 'users' | 'departments' | 'roles'} /> : null}
    {dashboard ? <DashboardSheet key={dashboard.project?.id} data={dashboard} clusterReady={data.deployment.clusterReady} close={closeDashboard} refresh={refreshDashboard} lifecycle={projectLifecycle} /> : null}
  </div>
}

export function DashboardSheet({ data, clusterReady, close, refresh, lifecycle, request = api }: { data: Dashboard; clusterReady: boolean; close: () => void; refresh: () => Promise<void>; lifecycle: (action: 'archive' | 'unarchive') => Promise<void>; request?: typeof api }) {
  const project = data.project ?? {}
  const projectID = project.id ?? ''
  const owner = data.yourRole === 'owner'
  const canEdit = clusterReady && project.status === 'active' && (owner || data.yourRole === 'editor')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const pending = useRef(false)
  const facts = [['成员', data.members?.length ?? 0], ['知识空间', data.spaces?.length ?? 0], ['制品', data.artifacts?.length ?? 0], ['自动化', data.automations?.length ?? 0], ['计量事件', data.usage?.length ?? 0], ['预算', data.budget?.remaining ?? data.budget?.amount ?? '未设置']]
  const [budgetOpen, setBudgetOpen] = useState(false)
  const perform = async (key: string, operation: () => Promise<unknown>) => {
    if (pending.current) return
    pending.current = true; setBusy(key); setError('')
    try { await operation() } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; setBusy('') }
  }
  return <aside className="lumo-sheet" aria-label="项目详情">
    <header><div><span className="lumo-eyebrow">项目详情卡</span><h3>{project.name ?? project.id}</h3><p>{data.yourRole ?? '成员'} · {project.realm ?? '未设置'} · {project.status === 'active' ? '启用中' : project.status ?? '未声明状态'}</p></div><div className="lumo-sheet-actions"><BusyButton busy={busy === 'refresh'} disabled={busy !== ''} className="lumo-secondary lumo-small" onClick={() => void perform('refresh', refresh)}>刷新</BusyButton>{owner && clusterReady ? <BusyButton busy={busy === 'lifecycle'} disabled={busy !== ''} className="lumo-danger lumo-small" onClick={() => void perform('lifecycle', () => lifecycle(project.status === 'archived' ? 'unarchive' : 'archive'))}>{project.status === 'archived' ? '恢复项目' : '归档项目'}</BusyButton> : null}<MagneticButton aria-label="关闭项目详情" className="lumo-quiet" onClick={close}>×</MagneticButton></div></header>
    <div className="lumo-fact-grid">{facts.map(([label, value]) => <div key={String(label)}><small>{label}</small><b>{String(value)}</b></div>)}</div>
    {error ? <div className="lumo-cluster-feedback error" role="alert">{error}</div> : null}
    {clusterReady && projectID ? <ProjectSettingsPanel key={projectID} request={request} project={{ id: projectID, name: project.name ?? '', status: project.status ?? '' }} role={data.yourRole ?? ''} refresh={refresh} /> : null}
    {clusterReady && projectID ? <details className="lumo-budget-details" onToggle={event => setBudgetOpen(event.currentTarget.open)}>
      <summary>项目预算<span>查看额度与管理本期预算</span></summary>
      {budgetOpen ? <ProjectBudgetPanel key={projectID} request={request} projectID={projectID} editable={owner && project.status === 'active'} /> : null}
    </details> : null}
    {clusterReady ? <ProjectMembersPanel request={request} projectID={projectID} members={(data.members ?? []) as ProjectMember[]} editable={owner} refresh={refresh} /> : null}
    <ProjectSpacesPanel key={`spaces:${projectID}`} request={request} projectID={projectID} spaces={(data.spaces ?? []) as ProjectResourceSpace[]} editable={canEdit} refresh={refresh} canManageGrants={owner && clusterReady} members={(data.members ?? []) as ProjectMember[]} />
    <ProjectAutomationsPanel key={`automations:${projectID}`} request={request} projectID={projectID} automations={data.automations ?? []} editable={canEdit} refresh={refresh} />
    <ProjectArtifactsPanel key={`artifacts:${projectID}`} request={request} projectID={projectID} artifacts={(data.artifacts ?? []) as ProjectResourceArtifact[]} editable={canEdit} refresh={refresh} />
  </aside>
}

export function OrganizationManagement({ view }: { view: 'users' | 'departments' | 'roles' }) {
  const pageSize = 50
  const [users, setUsers] = useState<DirectoryUser[]>([])
  const [roles, setRoles] = useState<GovernanceRole[]>([])
  const [departments, setDepartments] = useState<GovernanceDepartment[]>([])
  const [selectedUserID, setSelectedUserID] = useState('')
  const [selectedRoleID, setSelectedRoleID] = useState('')
  const [editingDepartment, setEditingDepartment] = useState<GovernanceDepartment | null>(null)
  const [editingRole, setEditingRole] = useState<GovernanceRole | null>(null)
  const [permissionRole, setPermissionRole] = useState<GovernanceRole | null>(null)
  const [creating, setCreating] = useState(false)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [departmentID, setDepartmentID] = useState('')
  const [page, setPage] = useState({ total: 0, offset: 0, hasMore: false, search: '', status: 'all', departmentID: '' })
  const [loading, setLoading] = useState(true)
  const [access, setAccess] = useState<UserAccess | null>(null)
  const [accessError, setAccessError] = useState('')
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState('')
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const selected = users.find(user => user.id === selectedUserID)
  const sequence = useRef(0)
  const pendingSelection = useRef('')
  const pendingMutation = useRef(false)
  const currentPage = page.search === search && page.status === status && page.departmentID === departmentID
  const searchPending = query.trim() !== search
  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 250); return () => window.clearTimeout(timer) }, [query])
  const load = useCallback(async (offset = 0) => {
    const current = ++sequence.current
    setLoading(true)
    try {
      type DirectoryPage = { users?: DirectoryUser[]; total?: number; has_more?: boolean }
      const readPage = (requestedOffset: number) => api<DirectoryPage>(userDirectoryURL({ query: search, status, departmentId: departmentID, limit: pageSize, offset: requestedOffset }))
      const [firstPage, roleResult, departmentResult] = await Promise.all([
        readPage(offset), api<{ roles?: GovernanceRole[] }>('/lumo/api/roles'), api<{ departments?: GovernanceDepartment[] }>('/lumo/api/departments'),
      ])
      if (current !== sequence.current) return
      let userResult = firstPage
      let resolvedOffset = offset
      // A directory can shrink while an administrator is on a later page.
      // Keep the displayed rows and range together until a valid page arrives.
      for (let correction = 0; resolvedOffset > 0 && typeof userResult.total === 'number' && resolvedOffset >= userResult.total; correction++) {
        resolvedOffset = correction < 2 ? Math.max(0, Math.floor((userResult.total - 1) / pageSize) * pageSize) : 0
        userResult = await readPage(resolvedOffset)
        if (current !== sequence.current) return
      }
      const preferredID = search === pendingSelection.current && status === 'all' && !departmentID ? pendingSelection.current : ''
      while (preferredID && !userResult.users?.some(user => user.id === preferredID) && userResult.has_more && (userResult.users?.length ?? 0) > 0) {
        resolvedOffset += pageSize
        userResult = await readPage(resolvedOffset)
        if (current !== sequence.current) return
      }
      setUsers(userResult.users ?? []); setRoles(roleResult.roles ?? []); setDepartments(departmentResult.departments ?? [])
      setPage({ total: userResult.total ?? userResult.users?.length ?? 0, offset: resolvedOffset, hasMore: userResult.has_more ?? false, search, status, departmentID })
      setSelectedUserID(id => userResult.users?.some(user => user.id === preferredID) ? preferredID : userResult.users?.some(user => user.id === id) ? id : userResult.users?.[0]?.id ?? '')
      if (pendingSelection.current === preferredID) pendingSelection.current = ''
      setSelectedRoleID(id => roleResult.roles?.some(role => role.id === id && role.status === 'active') ? id : roleResult.roles?.find(role => role.status === 'active')?.id ?? '')
      setError('')
    } catch (reason) { if (current === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (current === sequence.current) setLoading(false) }
  }, [search, status, departmentID])
  useEffect(() => { void load(0); return () => { sequence.current++ } }, [load])
  useEffect(() => {
    setAccess(null); setAccessError('')
    if (!selectedUserID || creating) return
    let active = true
    void api<UserAccess>(`/lumo/api/users/${encodeURIComponent(selectedUserID)}/access`)
      .then(value => { if (active) setAccess(value) })
      .catch(reason => { if (active) setAccessError(reason instanceof Error ? reason.message : String(reason)) })
    return () => { active = false }
  }, [selectedUserID, creating, revision])
  const run = async (key: string, success: string, operation: () => Promise<unknown>, refresh = true): Promise<boolean> => {
    if (pendingMutation.current) return false
    pendingMutation.current = true; setBusy(key); setError(''); setNotice('')
    try { await operation(); setNotice(success); if (refresh) await load(currentPage ? page.offset : 0); setRevision(value => value + 1); return true }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); return false }
    finally { pendingMutation.current = false; setBusy('') }
  }
  const saveUser = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const displayName = String(fields.get('display_name') ?? '').trim()
    const body = { display_name: displayName, primary_dept_id: String(fields.get('primary_dept_id') ?? '') }
    if (creating) {
      const id = String(fields.get('id') ?? '').trim()
      const password = String(fields.get('password') ?? '')
      if (password !== String(fields.get('confirmation') ?? '')) { setError('两次输入的密码不一致。'); return }
      if (await run('user', `用户「${displayName}」已创建。`, () => api('/lumo/api/users', { method: 'POST', body: JSON.stringify({ ...body, id, username: String(fields.get('username') ?? '').trim(), password }) }), false)) {
        form.reset(); pendingSelection.current = id; setCreating(false); setQuery(id); setSearch(id); setStatus('all'); setDepartmentID('')
        if (search === id && status === 'all' && !departmentID) void load(0)
      }
    } else if (selected) {
      await run('user', `用户「${displayName}」已更新。`, () => api(`/lumo/api/users/${encodeURIComponent(selected.id)}`, { method: 'PUT', body: JSON.stringify({ ...body, status: String(fields.get('status') ?? 'active') }) }))
    }
  }
  const saveCredentials = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected) return
    const form = event.currentTarget; const fields = new FormData(form)
    const password = String(fields.get('password') ?? '')
    if (password !== String(fields.get('confirmation') ?? '')) { setError('两次输入的密码不一致。'); return }
    if (await run('credentials', '登录凭证已更新，原有会话已失效。', () => api(`/lumo/api/users/${encodeURIComponent(selected.id)}/credentials`, { method: 'PUT', body: JSON.stringify({ username: String(fields.get('username') ?? '').trim(), password }) }))) form.reset()
  }
  const linkOIDC = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selected) return
    const subject = String(new FormData(event.currentTarget).get('subject') ?? '')
    await run('oidc', '企业身份已关联。', () => api(`/lumo/api/users/${encodeURIComponent(selected.id)}/oidc`, { method: 'PUT', body: JSON.stringify({ subject }) }))
  }
  const assignRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!selectedUserID || !selectedRoleID) return
    const expiry = String(new FormData(event.currentTarget).get('expires_at') ?? '')
    await run('role', '角色分配已保存。', () => api(`/lumo/api/users/${encodeURIComponent(selectedUserID)}/roles/${encodeURIComponent(selectedRoleID)}`, { method: 'PUT', body: JSON.stringify({ expires_at: expiry ? new Date(expiry).toISOString() : null }) }))
  }
  const revokeRole = async (role: UserRole) => {
    await run(`revoke-${role.role_id}`, `角色「${role.name}」已撤销。`, () => api(`/lumo/api/users/${encodeURIComponent(selectedUserID)}/roles/${encodeURIComponent(role.role_id)}`, { method: 'DELETE' }))
  }
  const saveDepartment = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); const name = String(fields.get('name') ?? '').trim(); if (!name) return
    const body = { name, parent_dept_id: String(fields.get('parent_dept_id') ?? ''), manager_user_id: String(fields.get('manager_user_id') ?? '').trim(), ...(editingDepartment ? { status: String(fields.get('status') ?? 'active') } : {}) }
    if (await run('department', `部门「${name}」已${editingDepartment ? '更新' : '创建'}。`, () => api(`/lumo/api/departments${editingDepartment ? `/${encodeURIComponent(editingDepartment.id)}` : ''}`, { method: editingDepartment ? 'PUT' : 'POST', body: JSON.stringify(body) }))) { form.reset(); setEditingDepartment(null) }
  }
  const saveRole = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form)
    const body = { name: String(fields.get('name') ?? '').trim(), description: String(fields.get('description') ?? '').trim(), ...(editingRole ? { status: String(fields.get('status') ?? 'active') } : { id: String(fields.get('id') ?? '').trim() }) }
    if (await run('catalog-role', `角色已${editingRole ? '更新' : '创建'}。`, () => api(`/lumo/api/roles${editingRole ? `/${encodeURIComponent(editingRole.id)}` : ''}`, { method: editingRole ? 'PUT' : 'POST', body: JSON.stringify(body) }))) { form.reset(); setEditingRole(null) }
  }
  const canParentDepartment = (department: GovernanceDepartment) => {
    if (department.status !== 'active') return false
    const visited = new Set<string>()
    let current: GovernanceDepartment | undefined = department
    while (current) {
      if (current.id === editingDepartment?.id || visited.has(current.id)) return false
      visited.add(current.id)
      current = departments.find(item => item.id === current?.parent_dept_id)
    }
    return true
  }
  const statusName = (value?: string) => value === 'disabled' ? '已停用' : value === 'suspended' ? '已暂停' : '正常'
  const visible = users
  const departmentOptions = departments.filter(department => department.status === 'active').map(department => <option key={department.id} value={department.id}>{department.name}</option>)
  const title = view === 'users' ? '用户管理' : view === 'departments' ? '部门管理' : '角色管理'
  const meta = loading ? '正在同步' : view === 'users' ? `${page.total} 位用户` : view === 'departments' ? `${departments.length} 个部门` : `${roles.length} 个角色`
  return <Section title={title} meta={meta} actions={<div className="lumo-form-actions"><BusyButton className="lumo-secondary" busy={loading} disabled={Boolean(busy) || searchPending} onClick={() => void load(currentPage ? page.offset : 0)}>刷新</BusyButton>{view === 'users' ? <BusyButton className="lumo-primary" disabled={Boolean(busy)} onClick={() => { setCreating(true); setError(''); setNotice('') }}>新建用户</BusyButton> : null}</div>}>
    {error ? <Notice error>{error}</Notice> : null}
    {notice ? <Notice close={() => setNotice('')}>{notice}</Notice> : null}
    <div className="lumo-organization-grid" id="lumo-organization-users" hidden={view !== 'users'}>
      <div>
        <div className="lumo-organization-filter"><label><span>搜索用户</span><input value={query} disabled={Boolean(busy)} onChange={event => setQuery(event.target.value)} placeholder="名称或用户 ID" /></label><label><span>用户状态</span><select value={status} disabled={Boolean(busy)} onChange={event => setStatus(event.target.value)}><option value="all">全部状态</option><option value="active">正常</option><option value="suspended">已暂停</option><option value="disabled">已停用</option></select></label><label><span>所属部门</span><select value={departmentID} disabled={Boolean(busy)} onChange={event => setDepartmentID(event.target.value)}><option value="">全部部门</option>{departments.map(department => <option key={department.id} value={department.id}>{department.name}{department.status === 'active' ? '' : '（已停用）'}</option>)}</select></label></div>
        <div className="lumo-organization-users" aria-label="用户目录" aria-busy={loading || searchPending}>{visible.map(user => <button type="button" key={user.id} className={!creating && selectedUserID === user.id ? 'selected' : ''} disabled={Boolean(busy) || loading || searchPending || !currentPage} aria-pressed={!creating && selectedUserID === user.id} onClick={() => { setSelectedUserID(user.id); setCreating(false); setError(''); setNotice('') }}><span><b>{user.display_name}</b><small>{user.id} · {departments.find(department => department.id === user.primary_dept_id)?.name ?? (user.primary_dept_id || '未分配部门')}</small></span><em>{statusName(user.status)}</em></button>)}</div>
        {!visible.length ? <Empty>{loading ? '正在读取用户。' : error ? '用户目录读取失败。' : '没有匹配的用户。'}</Empty> : null}
        {error && visible.length ? <p className="lumo-muted">目录尚未更新，当前显示上次成功读取的结果。</p> : null}
        <UserDirectoryPagination total={page.total} limit={pageSize} offset={page.offset} hasMore={page.hasMore} loading={loading || searchPending || Boolean(busy) || !currentPage} onOffsetChange={offset => void load(offset)} />
      </div>
      <div className="lumo-organization-detail">
        {creating || selected ? <>
          <h3>{creating ? '新建用户' : selected!.display_name}</h3>
          <form key={creating ? 'create' : `${selected!.id}:${selected!.display_name}:${selected!.status}:${selected!.primary_dept_id}`} className="lumo-governance-form lumo-user-form" onSubmit={saveUser} aria-label={creating ? '新建用户' : '用户资料'}>
            {creating ? <label><span>用户 ID</span><input name="id" required maxLength={128} pattern="[A-Za-z0-9_\x2d][A-Za-z0-9._\x2d]{0,127}" /></label> : null}
            <label><span>显示名称</span><input name="display_name" required maxLength={160} defaultValue={creating ? '' : selected?.display_name} /></label>
            <label><span>主部门</span><select name="primary_dept_id" defaultValue={creating ? '' : selected?.primary_dept_id ?? ''}><option value="">未分配</option>{!creating && selected?.primary_dept_id && !departments.some(department => department.id === selected.primary_dept_id && department.status === 'active') ? <option value={selected.primary_dept_id}>{selected.primary_dept_id}</option> : null}{departmentOptions}</select></label>
            {creating ? <><label><span>登录名</span><input name="username" required maxLength={128} autoComplete="off" /></label><label><span>初始密码</span><input name="password" type="password" required minLength={10} maxLength={72} autoComplete="new-password" /></label><label><span>确认密码</span><input name="confirmation" type="password" required minLength={10} maxLength={72} autoComplete="new-password" /></label></> : <label><span>状态</span><select name="status" defaultValue={selected?.status ?? 'active'}><option value="active">正常</option><option value="suspended">暂停</option><option value="disabled">停用</option></select></label>}
            <div className="lumo-user-form-actions"><BusyButton type="submit" busy={busy === 'user'} disabled={Boolean(busy)} className="lumo-primary">{creating ? '创建用户' : '保存资料'}</BusyButton>{creating ? <BusyButton className="lumo-secondary" disabled={Boolean(busy)} onClick={() => setCreating(false)}>取消</BusyButton> : null}</div>
          </form>
          {!creating && selected ? <>
            {view === 'users' ? <UserSecurityPanel key={selected.id} request={api} userId={selected.id} userName={selected.display_name} refreshKey={revision} disabled={Boolean(busy)} /> : null}
            {accessError ? <Notice error>{accessError}</Notice> : null}
            {access ? <>
              <h3>本地登录凭证 <small>{access.username ? (access.local_login_enabled ?? access.login_enabled) ? '可登录' : '登录已停用' : '未设置'}</small></h3>
              <form key={`${selected.id}:${access.username}:${revision}`} className="lumo-governance-form lumo-user-form" onSubmit={saveCredentials} aria-label="登录凭证">
                <label><span>登录名</span><input name="username" required maxLength={128} defaultValue={access.username} autoComplete="off" /></label><label><span>新密码</span><input name="password" type="password" required minLength={10} maxLength={72} autoComplete="new-password" /></label><label><span>确认新密码</span><input name="confirmation" type="password" required minLength={10} maxLength={72} autoComplete="new-password" /></label><div className="lumo-user-form-actions"><BusyButton type="submit" busy={busy === 'credentials'} disabled={Boolean(busy)} className="lumo-danger">{access.username ? '重置登录凭证' : '设置登录凭证'}</BusyButton></div>
              </form>
              {access.oidc_available || access.oidc ? <>
                <h3>企业身份 <small>{access.oidc ? access.oidc.enabled ? '已关联' : '已解除' : '未关联'}{!access.oidc_available ? ' · 身份源未启用' : ''}</small></h3>
                <form key={`oidc:${selected.id}:${revision}`} className="lumo-governance-form lumo-user-form" onSubmit={linkOIDC} aria-label="企业身份">
                  <label><span>身份提供方</span><input value={access.oidc?.issuer ?? access.oidc_issuer ?? ''} readOnly /></label>
                  <label><span>企业用户标识（sub）</span><input name="subject" required maxLength={255} defaultValue={access.oidc?.subject ?? ''} readOnly={Boolean(access.oidc)} autoComplete="off" /></label>
                  <div className="lumo-user-form-actions">{access.oidc?.enabled ? <BusyButton className="lumo-danger" busy={busy === 'oidc'} disabled={Boolean(busy)} onClick={() => void run('oidc', '企业身份已解除，相关登录会话已撤销。', () => api(`/lumo/api/users/${encodeURIComponent(selected.id)}/oidc`, { method: 'DELETE' }))}>解除关联</BusyButton> : <BusyButton type="submit" className="lumo-primary" busy={busy === 'oidc'} disabled={Boolean(busy) || !access.oidc_available || selected.status !== 'active' || Boolean(access.oidc && access.oidc.issuer !== access.oidc_issuer)}>{access.oidc ? '恢复关联' : '关联企业身份'}</BusyButton>}</div>
                </form>
              </> : null}
              <h3>已分配角色</h3>
              <div className="lumo-organization-roles">{access.roles.map(role => <div key={role.role_id}><span><b>{role.name}</b><small>{role.expires_at ? `到期 ${new Date(role.expires_at).toLocaleString('zh-CN')}` : '长期有效'}{role.status !== 'active' ? ' · 已停用' : role.expires_at && Date.parse(role.expires_at) <= Date.now() ? ' · 已过期' : ''}</small></span><BusyButton className="lumo-danger lumo-small" busy={busy === `revoke-${role.role_id}`} disabled={Boolean(busy)} onClick={() => void revokeRole(role)} aria-label={`撤销角色 ${role.name}`}>撤销</BusyButton></div>)}</div>
              {!access.roles.length ? <Empty>尚未分配角色。</Empty> : null}
              <form className="lumo-organization-controls" onSubmit={assignRole}><label><span>角色</span><select value={selectedRoleID} onChange={event => setSelectedRoleID(event.target.value)}>{roles.filter(role => role.status === 'active').map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><label><span>到期时间</span><input name="expires_at" type="datetime-local" /></label><BusyButton type="submit" className="lumo-primary" busy={busy === 'role'} disabled={Boolean(busy) || !selectedRoleID}>分配角色</BusyButton></form>
            </> : !accessError ? <Empty>正在读取用户权限。</Empty> : null}
          </> : null}
        </> : <Empty>请选择用户。</Empty>}
      </div>
    </div>
    <div className="lumo-organization-grid lumo-organization-catalogs" hidden={view === 'users'}>
      <div id="lumo-organization-departments" hidden={view !== 'departments'}><h3>部门目录</h3><div className="lumo-compact-list">{departments.map(department => <div key={department.id}><span><b>{department.name}</b><small>{department.id}{department.parent_dept_id ? ` · 上级 ${department.parent_dept_id}` : ''}</small></span><em>{department.status === 'active' ? '正常' : '已停用'}</em><BusyButton className="lumo-secondary lumo-small" disabled={Boolean(busy)} onClick={() => setEditingDepartment(department)}>编辑</BusyButton></div>)}</div>
        <h3>{editingDepartment ? `编辑部门 · ${editingDepartment.name}` : '新建部门'}</h3>
        <form key={editingDepartment?.id ?? 'new-department'} className="lumo-governance-form lumo-user-form" onSubmit={saveDepartment}>
          <label><span>部门名称</span><input name="name" required maxLength={160} defaultValue={editingDepartment?.name ?? ''} /></label>
          <label><span>上级部门</span><select name="parent_dept_id" defaultValue={editingDepartment?.parent_dept_id ?? ''}><option value="">根部门</option>{departments.filter(canParentDepartment).map(department => <option key={department.id} value={department.id}>{department.name}</option>)}</select></label>
          {view === 'departments' ? <DirectoryUserPicker request={api} initialUserId={editingDepartment?.manager_user_id ?? ''} disabled={Boolean(busy)} /> : null}
          {editingDepartment ? <label><span>状态</span><select name="status" defaultValue={editingDepartment.status}><option value="active">正常</option><option value="disabled">停用</option></select></label> : null}
          <div className="lumo-user-form-actions"><BusyButton type="submit" busy={busy === 'department'} disabled={Boolean(busy)} className="lumo-primary">{editingDepartment ? '保存部门' : '创建部门'}</BusyButton>{editingDepartment ? <BusyButton className="lumo-secondary" disabled={Boolean(busy)} onClick={() => setEditingDepartment(null)}>取消</BusyButton> : null}</div>
        </form>
      </div>
      <div id="lumo-organization-roles" hidden={view !== 'roles'}><h3>角色目录</h3><div className="lumo-compact-list">{roles.map(role => <div key={role.id}><span><b>{role.name}</b><small>{role.id}{role.description ? ` · ${role.description}` : ''}</small></span><em>{role.status === 'active' ? '正常' : '已停用'}</em><BusyButton className="lumo-secondary lumo-small" disabled={Boolean(busy)} onClick={() => setEditingRole(role)}>编辑</BusyButton><BusyButton className="lumo-secondary lumo-small" disabled={Boolean(busy)} onClick={() => setPermissionRole(role)}>配置权限</BusyButton></div>)}</div>
        {view === 'roles' && permissionRole ? <RolePermissionsPanel key={permissionRole.id} request={api} role={roles.find(role => role.id === permissionRole.id) ?? permissionRole} roles={roles} disabled={Boolean(busy)} refreshKey={revision} /> : null}
        <h3>{editingRole ? `编辑角色 · ${editingRole.name}` : '新建角色'}</h3>
        <form key={editingRole?.id ?? 'new-role'} className="lumo-governance-form lumo-user-form" onSubmit={saveRole}>
          <label><span>角色 ID</span><input name="id" required readOnly={Boolean(editingRole)} defaultValue={editingRole?.id ?? ''} maxLength={128} pattern="[A-Za-z0-9_\x2d][A-Za-z0-9._\x2d]{0,127}" /></label>
          <label><span>角色名称</span><input name="name" required maxLength={160} defaultValue={editingRole?.name ?? ''} /></label>
          <label><span>角色说明</span><input name="description" maxLength={500} defaultValue={editingRole?.description ?? ''} /></label>
          {editingRole ? <label><span>状态</span><select name="status" defaultValue={editingRole.status}><option value="active">正常</option><option value="disabled">停用</option></select></label> : null}
          <div className="lumo-user-form-actions"><BusyButton type="submit" busy={busy === 'catalog-role'} disabled={Boolean(busy)} className="lumo-primary">{editingRole ? '保存角色' : '创建角色'}</BusyButton>{editingRole ? <BusyButton className="lumo-secondary" disabled={Boolean(busy)} onClick={() => setEditingRole(null)}>取消</BusyButton> : null}</div>
        </form>
      </div>
    </div>
  </Section>
}

function StudioComposerTools({ format, command, submitLabel }: { format: ReactNode; command: string; submitLabel: string }) {
  const { project } = useStudioScope()
  return <div className="lumo-studio-tools"><span>{format}</span><span><i className="lumo-live-dot" />{project.label}</span><em>/{command}</em><button type="submit" className="lumo-studio-send" aria-label={submitLabel}>↑</button></div>
}

function OpenDesignSurface({ onConversationStart }: { onConversationStart: () => void }) {
  const { project } = useStudioScope()
  const bridge = useNativeConversationBridge()
  const runtime = useRuntimeSkills()
  const designExamples = runtime === null ? [] : creativeExamples(runtime, 'design')
  const [seed] = useState(() => takeCreativeSeed('design'))
  const seededExample = designExamples.find(example => example.skillName === seed?.skillName) ?? null
  const [selectedExample, setSelectedExample] = useState<CreativeExample | null>(null)
  const [format, setFormat] = useState<DesignFormatId>(() => seed?.formatId ?? 'ui')
  const [category, setCategory] = useState('全部')
  const [brief, setBrief] = useState(seed?.brief ?? '')
  const [notice, setNotice] = useState('')
  const [focus, setFocus] = useState<GalleryFocus | null>(null)
  const gallery = useUpstreamGallery('open-design')
  const collections = gallery?.available ? gallery.gallery.collections : []
  const categories = galleryCategories(collections)
  const demos = useSkillDemos()
  const designDemos = demos === null ? [] : demos.demos.filter(demo => designExamples.some(example => example.skillName === demo.skill))
  const openDesignExample = designExamples.find(item => skillCommandName(item.skillName) === 'open-design') ?? null
  useEffect(() => {
    if (selectedExample !== null || seededExample === null) return
    setSelectedExample(seededExample)
    setBrief(`${seededExample.prompt} 参考「${seededExample.title}」的信息层级，但保持当前项目的品牌与内容。`)
    setNotice(`已从首页载入「${seededExample.title}」，可继续补充后发送。`)
  }, [seededExample?.skillName, selectedExample])
  const active = designFormats.find(item => item.id === format) ?? designFormats[0]
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const skill = selectedExample ?? designExamples[0]
    if (skill === undefined) {
      setNotice(runtime === null ? '正在同步设计技能，请稍后再试。' : '当前运行时没有可用的设计技能，请先同步技能目录。')
      return
    }
    const intent = brief.trim() || active.prompt
    const creation = skillCommandName(skill.skillName) === 'open-design' ? `创建${active.label}` : `使用「${skill.title}」能力创建${active.label}`
    const workflow = skillCommandName(skill.skillName) === 'open-design' ? '请遵循 open-design 产物优先工作流' : '请遵循产物优先工作流'
    const prompt = `在项目「${project.label}」中${creation}。${intent} ${workflow}，创建真实可预览、可继续编辑的文件，并报告实际产物路径。`
    if (!invokeNativeSkill(bridge, skill.skillName, prompt)) {
      setNotice('请先选择工作区并创建会话，再把任务交给当前设计技能。')
      return
    }
    onConversationStart()
  }
  const useDemo = (demo: SkillDemo) => {
    const example = designExamples.find(item => item.skillName === demo.skill) ?? null
    setSelectedExample(example)
    setBrief(`参考「${demo.title}」这个原生示例的结构与视觉层级，${active.prompt} 保持当前项目的品牌与内容。`)
    setNotice(`已载入原生示例「${demo.title}」，可继续补充后发送。`)
  }
  const useGalleryPage = (collection: GalleryCollection, page: GalleryPage) => {
    setSelectedExample(openDesignExample)
    setBrief(`参考 OpenDesign 官方示例「${page.title}」（${collection.title}）：${page.description || collection.description} ${active.prompt} 保持当前项目的品牌与内容。`)
    setFocus(null)
    setNotice(`已载入 OpenDesign 示例「${page.title}」，可继续补充后发送。`)
  }
  const visibleCollections = category === '全部' ? collections : collections.filter(item => item.category === category)
  return <div className="lumo-studio-page lumo-creative-studio lumo-design-studio lumo-workspace-page">
    <WorkspaceHero surface="design" onClose={onConversationStart} statement="从一句想法开始，生成可继续编辑的设计方案。" description="选择产物类型和参考样例，再把创作意图发送到当前会话。">
      <div className={'lumo-workspace-status' + (bridge === null || runtime === null || designExamples.length === 0 ? ' degraded' : '')}><span>创作状态</span><b><i aria-hidden="true" />{bridge === null ? '等待会话' : runtime === null ? '同步技能目录' : designExamples.length ? '设计技能已就绪' : '暂无设计技能'}</b><dl><div><dt>技能</dt><dd>{designExamples.length}</dd></div><div><dt>官方示例</dt><dd>{collections.length}</dd></div><div><dt>当前类型</dt><dd>{active.label}</dd></div></dl><small>原生技能 /open-design</small></div>
    </WorkspaceHero>
    <section className="lumo-creation-section" aria-label="开放设计创作">
    <div className="lumo-studio-tabs" role="tablist" aria-label="开放设计产物类型">{designFormats.map(item => <button type="button" role="tab" aria-selected={item.id === format} aria-label={`选择开放设计类型：${item.label}`} key={item.id} className={item.id === format ? 'active' : ''} onClick={() => { setFormat(item.id); setNotice('') }}><i>{item.icon}</i>{item.label}</button>)}</div>
    <form className="lumo-studio-composer" onSubmit={submit}>{selectedExample ? <span className="lumo-selected-example">{selectedExample.title}<button type="button" aria-label="移除设计样例" onClick={() => { setSelectedExample(null); setBrief('') }}>×</button></span> : null}<textarea aria-label="开放设计创作意图" rows={5} value={brief} onChange={event => setBrief(event.target.value)} placeholder="描述你想设计的产品、页面或流程" /><StudioComposerTools format={<><i>{active.icon}</i>{active.label}</>} command={selectedExample ? skillCommandName(selectedExample.skillName) : 'open-design'} submitLabel="发送到 OpenDesign" /></form>
    {notice ? <div className="lumo-studio-notice" role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div> : null}
    </section>
    <section className="lumo-inspiration" aria-label="OpenDesign 官方示例"><header><div><b>OpenDesign 完整示例</b><span>来自 open-design 仓库 README「演示」章节的真实产物截图，按原型 / 仪表盘 / 演示文稿 / 图片 / 视频分类；点开逐张查看，再送进创作意图</span></div>{gallery?.available ? <a href={gallery.gallery.source} target="_blank" rel="noreferrer noopener">上游原文 ↗</a> : null}</header>
      {gallery === null ? <p role="status">正在拉取 OpenDesign 示例…</p> : gallery.available ? <>
        <div className="lumo-studio-categories" aria-label="设计样例分类">{categories.map(item => <button type="button" key={item} className={category === item ? 'active' : ''} onClick={() => setCategory(item)}>{item}</button>)}</div>
        <div className="lumo-gallery-grid">{visibleCollections.flatMap(collection => collection.pages.map((_page, index) => <GalleryPageCard key={`${collection.id}:${String(index)}`} collection={collection} index={index} onOpen={(item, position) => setFocus({ collection: item, index: position })} />))}</div>
      </> : <Empty>OpenDesign 示例暂时不可用{gallery.error ? `：${gallery.error}` : ''}。可以直接描述意图发送，或使用下方本地示例。</Empty>}
    </section>
    {demos !== null && designDemos.length ? <section className="lumo-inspiration" aria-label="本地技能示例"><header><div><b>本地技能示例</b><span>已装配技能目录里自带的真实文件</span></div></header><div className="lumo-demo-grid">{designDemos.map(demo => <SkillDemoCard key={demo.id} demo={demo} label={localizedSkillName(demo.skill)} onPick={useDemo} />)}</div></section> : null}
    {focus === null ? null : <GalleryViewer focus={focus} useLabel="以此样例创建" onIndex={index => setFocus({ collection: focus.collection, index })} onClose={() => setFocus(null)} onUse={useGalleryPage} />}
  </div>
}

function presentationHashQuery(value: string): string | null {
  const match = value.match(/(?:^|\s)#([^\s#]*)$/u)
  return match?.[1] ?? null
}

function PresentationSurface({ onConversationStart }: { onConversationStart: () => void }) {
  const { project } = useStudioScope()
  const bridge = useNativeConversationBridge()
  const runtime = useRuntimeSkills()
  const presentationExamples = runtime === null ? [] : creativeExamples(runtime, 'presentation')
  const [seed] = useState(() => takeCreativeSeed('presentation'))
  const seededExample = presentationExamples.find(example => example.skillName === seed?.skillName) ?? null
  const [draft, setDraft] = useState(seed?.openHash ? '#' : seed?.brief ?? '')
  const [focus, setFocus] = useState<GalleryFocus | null>(null)
  const [style, setStyle] = useState('全部')
  const gallery = useUpstreamGallery('ppt-master')
  const collections = gallery?.available ? gallery.gallery.collections : []
  const styles = galleryCategories(collections)
  const visibleCollections = style === '全部' ? collections : collections.filter(item => item.category === style)
  const [selected, setSelected] = useState<CreativeExample | null>(null)
  const [popup, setPopup] = useState(seed?.openHash === true)
  const [activeIndex, setActiveIndex] = useState(0)
  const [notice, setNotice] = useState('')
  const useGalleryDeck = (collection: GalleryCollection, page: GalleryPage) => {
    const example = presentationExamples[0] ?? null
    setSelected(example)
    const detail = draft.replace(/^#[^\s]+\s*/u, '').replace(/参考 PPT Master 官方示例「[^」]*」[^。]*。\s*/u, '').trim()
    setDraft(`${example === null ? '' : `#${example.title} `}参考 PPT Master 官方示例「${collection.title}」（${collection.category}，共 ${String(collection.pages.length)} 页，当前看的是「${page.title}」）：${collection.description}。${detail}`.trimEnd())
    setPopup(false)
    setFocus(null)
    setNotice(`已选择 PPT Master 示例「${collection.title}」，继续描述听众、时长和重点后发送。`)
  }
  useEffect(() => {
    if (selected !== null || seededExample === null) return
    setSelected(seededExample)
    setDraft(`#${seededExample.title} `)
  }, [seededExample?.skillName, selected])
  const query = presentationHashQuery(draft) ?? ''
  const matches = presentationExamples.filter(example => `${example.title}${example.description}`.includes(query))
  useEffect(() => { setActiveIndex(index => Math.min(index, Math.max(matches.length - 1, 0))) }, [matches.length])
  const changeDraft = (value: string) => {
    setDraft(value)
    const hash = presentationHashQuery(value)
    setPopup(hash !== null)
    if (!value.startsWith(`#${selected?.title ?? ''}`)) setSelected(null)
  }
  const choose = (example: CreativeExample | undefined) => {
    if (example === undefined) return
    setSelected(example)
    setDraft(`#${example.title} `)
    setPopup(false)
    setNotice(`已插入「${example.title}」样例，继续描述听众、时长和重点后发送。`)
  }
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const example = selected ?? presentationExamples.find(item => draft.startsWith(`#${item.title}`)) ?? presentationExamples[0]
    if (example === undefined) {
      setNotice(runtime === null ? '正在同步演示技能，请稍后再试。' : '当前运行时没有可用的 PPT 技能，请先同步技能目录。')
      return
    }
    const detail = draft.replace(/^#[^\s]+\s*/u, '').trim()
    const prompt = `在项目「${project.label}」中，使用「${example.title}」样例生成原生可编辑 PPTX。${example.seed}${detail ? ` 用户补充：${detail}` : ''} 请遵循 ppt-master 的内容确认、设计确认和生成审阅门禁，所有源文件、预览和导出都保存在当前工作区。`
    if (!invokeNativeSkill(bridge, example.skillName, prompt)) {
      setNotice('请先选择工作区并创建会话，再把任务交给当前 PPT 技能。')
      return
    }
    onConversationStart()
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (popup && event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(index => matches.length ? (index + 1) % matches.length : 0) }
    else if (popup && event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(index => matches.length ? (index - 1 + matches.length) % matches.length : 0) }
    else if (popup && event.key === 'Enter') { event.preventDefault(); choose(matches[activeIndex]) }
    else if (popup && event.key === 'Escape') { event.preventDefault(); setPopup(false) }
    else if (!popup && event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.form?.requestSubmit() }
  }
  return <div className="lumo-studio-page lumo-creative-studio lumo-presentation-studio lumo-workspace-page">
    <WorkspaceHero surface="presentation" onClose={onConversationStart} statement="先选故事结构，再和 AI 一起完成整套演示。" description="选一个样例，补充听众和时长，再发送到当前会话。">
      <div className={'lumo-workspace-status' + (bridge === null ? ' degraded' : '')}><span>创作状态</span><b><i aria-hidden="true" />{bridge === null ? '等待会话' : '会话已就绪'}</b><dl><div><dt>技能样例</dt><dd>{presentationExamples.length}</dd></div><div><dt>官方示例</dt><dd>{collections.length}</dd></div><div><dt>已选择</dt><dd>{selected ? '1' : '0'}</dd></div></dl><small>原生技能 /ppt-master</small></div>
    </WorkspaceHero>
    <ol className="lumo-presentation-steps"><li className="active"><i>1</i>选择样例</li><li><i>2</i>对话完善</li><li><i>3</i>生成文稿</li></ol>
    <div className="lumo-presentation-layout"><main><section className="lumo-creation-section" aria-label="演示文稿创作"><div className="lumo-assistant-prompt"><Glyph surface="skills" /><p>告诉我这次演示的主题、听众和预计时长。你也可以输入 <b>#</b> 从样例开始。</p></div><div className={`lumo-presentation-composer-wrap ${popup ? 'popup-open' : ''}`}>
      {popup ? <section className="lumo-example-popup" role="dialog" aria-label="选择演示样例"><header><b># 选择演示样例</b><span>{query ? `筛选：${query}` : '输入样例名可筛选'}</span></header><div>{matches.map((example, index) => <button type="button" key={example.id} className={activeIndex === index ? 'active' : ''} onMouseEnter={() => setActiveIndex(index)} onClick={() => choose(example)}><i className={example.className} /><span><b>{example.title}</b><small>{example.description}</small></span></button>)}</div><footer>↑↓ 选择 · Enter 插入 · Esc 关闭</footer></section> : null}
      <form className="lumo-presentation-composer" onSubmit={submit}>{selected ? <span className="lumo-selected-example">#{selected.title}<button type="button" aria-label="移除演示样例" onClick={() => { setSelected(null); setDraft('') }}>×</button></span> : null}<textarea autoFocus aria-label="PPT 对话输入" rows={5} value={draft} onChange={event => changeDraft(event.target.value)} onKeyDown={onKeyDown} placeholder="输入 # 选择样例，然后继续描述听众、时长和重点" /><StudioComposerTools format={<>▤ 演示文稿</>} command={selected ? skillCommandName(selected.skillName) : 'ppt-master'} submitLabel="发送到 PPT Master" /></form>
    </div>{notice ? <div className="lumo-studio-notice" role="status">{notice}<button type="button" aria-label="关闭提示" onClick={() => setNotice('')}>×</button></div> : null}</section>
    <section className="lumo-inspiration" aria-label="PPT Master 官方示例"><header><div><b>PPT Master 完整示例</b><span>来自 ppt-master 示例站的真实生成结果，每个示例都能逐页翻看全部幻灯片并下载 PPTX</span></div>{gallery?.available ? <a href={gallery.gallery.source} target="_blank" rel="noreferrer noopener">示例站 ↗</a> : null}</header>
      {gallery === null ? <p role="status">正在拉取 PPT Master 示例…</p> : gallery.available ? <>
        <div className="lumo-studio-categories" aria-label="演示风格筛选">{styles.map(item => <button type="button" key={item} className={style === item ? 'active' : ''} onClick={() => setStyle(item)}>{item}</button>)}</div>
        <div className="lumo-gallery-grid">{visibleCollections.map(collection => <GalleryCollectionCard key={collection.id} collection={collection} onOpen={(item, index) => setFocus({ collection: item, index })} />)}</div>
      </> : <Empty>PPT Master 示例暂时不可用{gallery.error ? `：${gallery.error}` : ''}；仍可用 # 选择本地样例生成。</Empty>}
    </section></main></div>
    {focus === null ? null : <GalleryViewer focus={focus} useLabel="用这个样例生成" onIndex={index => setFocus({ collection: focus.collection, index })} onClose={() => setFocus(null)} onUse={useGalleryDeck} />}
  </div>
}

function useThemeRegistry(): ThemeRegistryState {
  return useSyncExternalStore(subscribeThemeRegistry, getThemeRegistryState, getThemeRegistryState)
}

/** 当前主题名对应的视觉身份（surface / emphasis / effects），供 Workbench 根元素以
 * data-* 暴露给 CSS 做按主题分支。活动主题变化时重读身份并触发重渲染；第三方皮肤
 * （如 dsh-dream-skin）未登记视觉身份时回退到默认身份。 */
function useActiveThemeIdentity(): { surface: string; emphasis: string; effects: string } {
  const { activeId } = useThemeRegistry()
  const identity = LUMO_THEME_IDENTITY[activeId as LumoThemeId] ?? LUMO_THEME_IDENTITY[LUMO_DEFAULT_THEME]
  return { surface: identity.surface, emphasis: identity.emphasis, effects: identity.effects }
}

function WorkbenchRail({ surface, available, select }: { surface: Surface; available: Surface[]; select: (surface: Surface) => void }) {
  return <aside className="lumo-workbench-rail" aria-label="工作台导航">
    <div className="lumo-rail-brand"><span className="lumo-brand-mark" aria-hidden="true">L</span><div><b>Lumo</b><small>WORKSPACE</small></div></div>
    <div className="lumo-rail-menu-head"><span>工作领域</span><kbd>⌘K</kbd></div>
    <nav aria-label="工作领域">
      <div className="lumo-nav-group">
        {available.map(item => <button
          type="button"
          key={item}
          className={surface === item ? 'active' : ''}
          title={surfaceMeta[item].label}
          aria-label={surfaceMeta[item].label}
          aria-current={surface === item ? 'page' : undefined}
          onClick={() => select(item)}
        >
          <Glyph surface={item} />
          <span>{surfaceMeta[item].label}</span>
        </button>)}
      </div>
    </nav>
    <div className="lumo-rail-footer"><span><i className="lumo-live-dot" />Lumo 工作台</span></div>
  </aside>
}

function Workbench({ surface, close, select, commandOpen, toggleCommand }: { surface: Surface; close: () => void; select: (surface: Surface) => void; commandOpen: boolean; toggleCommand: () => void }) {
  const ref = useRef<HTMLElement>(null)
  const meta = surfaceMeta[surface]
  const identity = useActiveThemeIdentity()
  const [localMode, setLocalMode] = useState(false)
  useEffect(() => {
    void api<{ deployment: DeploymentState }>('/lumo/api/overview')
      .then(data => setLocalMode(data.deployment.mode === 'local'))
      .catch(() => setLocalMode(false))
  }, [])
  const primaryNavigation = navigationSurfaces(localMode)
  const available = availableSurfaces(localMode)
  useFocusTrap(ref, !commandOpen)
  // 各工作区共用同一只滚动容器。若不在切换时归零，从长页面（尤其协作空间、项目）
  // 进入另一页会直接落到页面中段，连标题、事实摘要和返回入口都看不到。
  useEffect(() => {
    const main = ref.current?.querySelector<HTMLElement>(':scope > .lumo-workbench-main > main')
    if (main !== undefined && main !== null) main.scrollTop = 0
  }, [surface])
  return <div className="lumo-backdrop"><section ref={ref} tabIndex={-1} className="lumo-workbench" data-lumo-surface={identity.surface} data-lumo-emphasis={identity.emphasis} data-lumo-effects={identity.effects} data-lumo-view={surface} role="dialog" aria-modal="true" aria-label={`${meta.label}工作台`}>
    <WorkbenchRail surface={surface} available={primaryNavigation} select={select} />
    <div className="lumo-workbench-main"><header className="lumo-workbench-header"><div className="lumo-header-location"><span>Lumo 工作台</span><i>›</i><b>{meta.label}</b><small>{meta.eyebrow}</small></div></header><main>{surface === 'computer' ? <ComputerUsePanel onClose={close} /> : surface === 'collaboration' ? <CollaborationSurface onClose={close} /> : surface === 'knowledge' ? <KnowledgeSurface onClose={close} /> : surface === 'skills' ? <SkillsSurface onClose={close} /> : surface === 'connectors' ? <ConnectorsSurface onClose={close} /> : surface === 'operations' ? <OperationsSurface onClose={close} /> : surface === 'design' ? <OpenDesignSurface onConversationStart={close} /> : surface === 'presentation' ? <PresentationSurface onConversationStart={close} /> : surface === 'market' ? <MarketSurface onClose={close} /> : surface === 'skillhub' ? <SkillHubSurface onClose={close} /> : <AccountSurface onClose={close} />}</main><footer className="lumo-workbench-footer"><span>在对话中输入 /design 或 /ppt，开始创作</span><span>Esc 返回对话</span></footer></div>
    <CommandPalette open={commandOpen} surface={surface} available={available} select={select} close={toggleCommand} />
  </section></div>
}

export function LumoOverlay(_props: OverlayProps) {
  // The native DSH conversation owns the main screen. Lumo's project controls
  // and OpenDesign dock are injected into that live composer; this overlay is
  // now an on-demand operations workbench rather than a full-screen takeover.
  const [surface, setSurface] = useState<Surface | null>(() => querySurface())
  const [commandOpen, setCommandOpen] = useState(false)
  const [desktopTasks, setDesktopTasks] = useState(false)
  const openerRef = useRef<HTMLElement | null>(null)
  const openedRef = useRef(surface !== null)
  const captureOpener = () => {
    if (openedRef.current) return
    const active = document.activeElement
    openerRef.current = active instanceof HTMLElement ? active : null
    openedRef.current = true
  }
  useEffect(() => {
    if (surface !== null || desktopTasks) return
    if (openedRef.current && openerRef.current?.isConnected) openerRef.current.focus()
    openerRef.current = null
    openedRef.current = false
  }, [surface, desktopTasks])
  useEffect(() => {
    const open = (event: Event) => { const next = (event as CustomEvent<Surface>).detail; captureOpener(); setDesktopTasks(false); setSurface(next); setQuerySurface(next) }
    const closeWorkbench = () => { setDesktopTasks(false); setSurface(null); setQuerySurface(null) }
    const key = (event: globalThis.KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        captureOpener()
        setDesktopTasks(false)
        setSurface(current => current ?? 'knowledge')
        setCommandOpen(current => !current)
      } else if (event.key === 'Escape') { if (commandOpen) setCommandOpen(false); else closeWorkbench() }
    }
    window.addEventListener(OPEN_EVENT, open); window.addEventListener(CLOSE_EVENT, closeWorkbench); window.addEventListener('keydown', key)
    const stopPetSurface = registerDesktopPetSurface(window, target => {
      window.dispatchEvent(new CustomEvent(CLOSE_EVENT))
      if (target === 'tasks') { captureOpener(); setCommandOpen(false); setDesktopTasks(true) }
    })
    return () => { stopPetSurface(); window.removeEventListener(OPEN_EVENT, open); window.removeEventListener(CLOSE_EVENT, closeWorkbench); window.removeEventListener('keydown', key) }
  }, [commandOpen])
  const close = () => { setSurface(null); setQuerySurface(null) }
  const select = (next: Surface) => { setSurface(next); setQuerySurface(next) }
  const toggleCommand = () => setCommandOpen(current => !current)
  return <ClickSpark>{desktopTasks ? <DesktopPetTasks onClose={() => window.dispatchEvent(new CustomEvent(CLOSE_EVENT))} /> : surface === null ? null : <Workbench surface={surface} close={close} select={select} commandOpen={commandOpen} toggleCommand={toggleCommand} />}</ClickSpark>
}

/** 原生 `/` 触发源的最小结构投影；同样不把 ui-input-trigger 的源码项目拉进本包。 */
interface LumoCommandClaim { token: string; hint?: string; submit(args: string): Promise<{ kind: 'success' | 'error'; text?: string }> }
type LumoPickOutcome = { claim: LumoCommandClaim } | undefined
interface LumoInputTriggerSource {
  trigger: '/'
  name: string
  order?: number
  candidates(session: unknown, req: { query: string }): Promise<ReadonlyArray<{ name: string; description?: string }>>
  onPick(pick: { candidate: { name: string } }): LumoPickOutcome
  matchEnter(session: unknown, line: string): Promise<LumoPickOutcome>
}
interface LumoInputTriggerService { registerSource(source: LumoInputTriggerSource): () => void }

/**
 * `ctx.sessions` 的最小投影：只用到「当前会话 id」。无会话时为 undefined
 * （见 ui-conversation 的 `sessions.list.getSnapshot().current`）。
 */
interface LumoHostSessions {
  list: { getSnapshot(): { current?: string | null } }
}

/**
 * `ctx.modelDirectories` 的最小投影。`directoryFor` 返回该会话共享的模型目录
 * （与 /model 弹窗同一份状态），其 store 快照的 `current` 即生效模型——未显式
 * 选过时它已经回落到目录默认值，目录尚未加载完则为 null。未知会话会抛错，
 * 由 resolveHostModel 的 try/catch 兜住并退回手填字段。
 */
interface LumoHostModelDirectories {
  directoryFor(sessionId: string): { store: { getSnapshot(): { current?: { provider?: string; model?: string } | null } } }
}

function creativeCommandClaim(name: string): LumoCommandClaim | undefined {
  const command = lumoCreativeCommands.find(item => item.name === name)
  if (command === undefined) return undefined
  return {
    token: `/${command.name}`,
    hint: `${command.label} · 可附上创作意图后回车`,
    submit: async (args: string) => {
      openCreativeSurface({ kind: command.kind, brief: args.trim() })
      return { kind: 'success' }
    },
  }
}

export const lumoCreativeCommandSource: LumoInputTriggerSource = {
  trigger: '/',
  name: 'lumo',
  order: 1,
  async candidates(_session, { query }) {
    return lumoCreativeCommands.filter(item => item.name.startsWith(query)).map(item => ({ name: item.name, description: `${item.label} · ${item.description}` }))
  },
  onPick({ candidate }) {
    const claim = creativeCommandClaim(candidate.name)
    return claim === undefined ? undefined : { claim }
  },
  async matchEnter(_session, line) {
    const match = line.trim().match(/^\/([a-z-]+)(?:\s|$)/u)
    const claim = match === null ? undefined : creativeCommandClaim(match[1]!)
    return claim === undefined ? undefined : { claim }
  },
}

export const inject = ['slots', 'theme']
export function apply(ctx: ClientContext): void {
  const root = ((ctx as ClientContext & { root?: object }).root ?? ctx) as object
  const roots = activeClientRoots()
  if (roots.has(root)) return
  roots.add(root)
  ctx.effect(() => () => { roots.delete(root) }, 'lumo-ui: singleton client mount')
  if (typeof window !== 'undefined') ctx.effect(() => installAnchoredOverlayFallback(window), 'lumo-ui: CSS anchor compatibility')
  if (typeof window !== 'undefined' && (window as Window & { __LUMO_DESKTOP__?: boolean }).__LUMO_DESKTOP__ === true) {
    ctx.inject(['sessions', 'workspaces', 'conversation', 'uiWorkspace', 'layout'], (desktopCtx) => {
      const services = Object.fromEntries(['sessions', 'workspaces', 'conversation', 'uiWorkspace', 'layout'].map(name => [name, desktopCtx.get(name)]))
      if (Object.values(services).some(service => service === undefined)) return
      // Read the optional public upload service when it appears; text sending
      // remains available while an attachment provider is still loading.
      Object.defineProperty(services, 'fileUpload', { get: () => desktopCtx.get('fileUpload') })
      desktopCtx.effect(() => installDesktopPetBridge(window, services as unknown as DesktopPetServices), 'lumo-ui: desktop pet messaging')
    })
  }
  if (typeof window !== 'undefined') ctx.inject(['sessions', 'layout'], (computerCtx) => {
    const sessions = computerCtx.get('sessions')
    const layout = computerCtx.get('layout')
    if (sessions === undefined || layout === undefined) return
    computerCtx.effect(() => installComputerUseServices(window, { sessions, layout } as unknown as ComputerUseClientServices), 'lumo-ui: current conversation computer controls')
  })
  installLumoThemes(ctx)
  ctx.slots.inject('sidebar.navigation', () => ctx.slots.register(
    { name: 'sidebar.navigation', id: 'lumo-navigation', order: 10, label: 'Lumo 功能菜单' },
    SidebarNavigation,
  ))
  // 原生侧边栏品牌位：mark 用外壳自带的鱼形回退，名字槽由 Lumo 占下产品名，
  // 避免无官方品牌构建时外壳回退到「DSH 本地构建」文案（品牌名 slot 为上游公开契约）。
  ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register(
    { name: 'sidebar.brand.name' },
    () => <span className="lumo-sidebar-brand-name">DeepSeek Harness</span>,
  ))
  // 侧边栏底部的登录态。用外壳公开的 `sidebar.footer.action` 槽（list、两种栏宽都渲染、
  // 排在「设置」之上），而不是挤进 `sidebar.navigation` —— 那个槽是工作区入口的座位。
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register(
    { name: 'sidebar.footer.action', id: 'lumo-identity', order: 1000, label: '登录身份' },
    SidebarIdentityChip,
  ))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'lumo-platform', order: 100 }, LumoOverlay))

  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register(
    { name: 'conversation.input.dock', id: 'lumo-native-skill-bridge', order: 20, label: 'Lumo 原生技能桥' },
    OpenDesignDock,
  ))
  ctx.slots.inject('conversation.hero.composer.dock', () => ctx.slots.register(
    { name: 'conversation.hero.composer.dock', id: 'lumo-capability-launchers', order: 20, label: 'Lumo 功能入口' },
    HeroOpenDesignDock,
  ))
  // 创作入口收进原生 `/` 命令菜单：inputTriggers 由上游 ui-input-trigger 提供，
  // 用 ctx.inject 等它就绪，避免和它的装配顺序耦合。
  ctx.inject(['inputTriggers'], (triggerCtx) => {
    const inputTriggers = triggerCtx.get('inputTriggers') as LumoInputTriggerService | undefined
    if (inputTriggers === undefined) return
    triggerCtx.effect(() => inputTriggers.registerSource(lumoCreativeCommandSource), 'lumo-ui: creative slash commands')
  })
  // 创建 / 编辑专家沿用「宿主当前选中的模型」：sessions 给出当前会话，modelDirectories
  // 给出该会话解析后的生效模型。Surface 拿不到 ctx，所以在这里把解析器挂到模块级变量上
  // （见 hostModelResolver 的说明）。与 inputTriggers 同理用 ctx.inject 等这两个服务就绪，
  // 避免和它们的装配顺序耦合；任一缺失时解析器保持 undefined，表单会自动退回手填字段。
  ctx.inject(['sessions', 'modelDirectories'], (modelCtx) => {
    const sessions = modelCtx.get('sessions') as LumoHostSessions | undefined
    const modelDirectories = modelCtx.get('modelDirectories') as LumoHostModelDirectories | undefined
    if (sessions === undefined || modelDirectories === undefined) return
    hostModelResolver = () => {
      const sessionId = sessions.list.getSnapshot().current
      if (sessionId === undefined || sessionId === null) return undefined
      const current = modelDirectories.directoryFor(sessionId).store.getSnapshot().current
      if (current === undefined || current === null) return undefined
      const provider = String(current.provider ?? '').trim()
      const model = String(current.model ?? '').trim()
      return provider === '' || model === '' ? undefined : { provider, model }
    }
    modelCtx.effect(() => () => { hostModelResolver = undefined }, 'lumo-ui: host model selection bridge')
  })
}

import type { Surface } from './surface-types.ts'

export const surfaceMeta: Record<Surface, { label: string; eyebrow: string; description: string; short: string }> = {
  agents: { label: 'Agent 工作台', eyebrow: 'Personal AI Agents', description: '管理开发工具与模型，保存专属 Agent，组群协作并查看成员会话。', short: 'Agent' },
  computer: { label: '电脑操作', eyebrow: '本机自动化', description: '授权当前对话操作电脑，查看执行状态并随时停止。', short: '电脑' },
  collaboration: { label: '协作空间', eyebrow: '目标与协作', description: '把委派链、执行进度、交付物与待你决策的事项放在一张空间视图里。', short: '协作' },
  operations: { label: '管理', eyebrow: '管理工作台', description: '管理项目、运行环境、能力配置与账户权限。', short: '管理' },
  skills: { label: '技能管理', eyebrow: '运行时与治理', description: '检查已安装技能的调用策略、版本与治理状态。', short: '技能管理' },
  knowledge: { label: '资料库', eyebrow: '知识连接', description: '查找已发布资料，维护来源，检查索引。', short: '资料' },
  design: { label: '开放设计', eyebrow: 'OpenDesign', description: '组织设计上下文，并把任务交给原有 open-design 插件执行。', short: '设计' },
  presentation: { label: 'PPT 生成', eyebrow: 'PPT Master', description: '通过 # 选择样例，再交给原有 ppt-master 插件继续对话生成。', short: '演示' },
  skillhub: { label: '技能中心', eyebrow: '专家与技能', description: '选择可直接协作的专家，或为工作区安装单项技能。', short: '技能中心' },
  connectors: { label: '连接器', eyebrow: '连接器网关', description: '检查能力清单、调用协议与受控 Web 出站。', short: '连接' },
  account: { label: '用户中心', eyebrow: '身份与安全', description: '查看治理用户身份、安全策略与当前会话。', short: '账户' },
  market: { label: '管理', eyebrow: '管理工作台', description: '从设置进入，按用途管理项目、环境、能力和权限。', short: '管理' },
}

export const surfaces = Object.keys(surfaceMeta) as Surface[]

export function availableSurfaces(localMode: boolean): Surface[] {
  const localSurfaces: Surface[] = ['agents', 'operations', 'knowledge', 'design', 'presentation', 'skills', 'skillhub', 'market', 'computer']
  return localMode ? surfaces.filter(surface => localSurfaces.includes(surface)) : surfaces.filter(surface => surface !== 'computer' && surface !== 'agents')
}

export function navigationSurfaces(localMode: boolean): Surface[] {
  // Creation uses native slash commands; management is entered from Settings.
  return availableSurfaces(localMode).filter(surface => !['design', 'presentation', 'operations', 'market'].includes(surface))
}

export const OPEN_EVENT = 'lumo:open-workbench'

export const CLOSE_EVENT = 'lumo:close-workbench'

export function querySurface(): Surface | null {
  const value = new URLSearchParams(location.search).get('lumo')
  if (value === 'ops') return 'operations'
  return surfaces.includes(value as Surface) ? value as Surface : null
}

export function setQuerySurface(surface: Surface | null): void {
  const url = new URL(location.href)
  if (surface === null) url.searchParams.delete('lumo')
  else url.searchParams.set('lumo', surface)
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

export function openSurface(surface: Surface): void {
  window.dispatchEvent(new CustomEvent<Surface>(OPEN_EVENT, { detail: surface }))
}

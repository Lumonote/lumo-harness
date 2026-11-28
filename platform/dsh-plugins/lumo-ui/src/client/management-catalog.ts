import type { Surface } from './surface-types.ts'
import type { OperationsArea } from './operations-navigation.ts'

export const managementGroups = [
  { id: 'projects', title: '项目与任务', description: '维护项目，推进协作与交付。' },
  { id: 'runtime', title: '环境与连接', description: '本机、远端服务器与集群服务。' },
  { id: 'capabilities', title: '能力配置', description: '维护技能、连接器与发布版本。' },
  { id: 'account', title: '账户与权限', description: '管理身份、组织和访问权限。' },
] as const

export type ManagementAccess = { local: boolean; clusterReady: boolean; organization: boolean; platformAdmin: boolean }
export type ManagementEntry = {
  id: string; title: string; description: string
  group: typeof managementGroups[number]['id']
  surface?: Surface; area?: OperationsArea
  mode?: 'local' | 'server'; cluster?: boolean; admin?: boolean; platform?: boolean
}

const entries: ManagementEntry[] = [
  { id: 'projects', area: 'projects', group: 'projects', mode: 'server', title: '项目资产', description: '项目、成员、预算与资料' },
  { id: 'flows', area: 'flows', group: 'projects', mode: 'server', title: '流程自动化', description: '流程编辑、审核、版本与运行记录' },
  { id: 'delivery', area: 'delivery', group: 'projects', mode: 'server', title: '协作执行', description: '任务委派、专家与执行证据' },
  { id: 'progress', area: 'progress', group: 'projects', mode: 'server', cluster: true, title: '团队进度', description: '员工、智能体、阻塞与交接' },
  { id: 'agents', surface: 'agents', group: 'projects', mode: 'local', title: 'Agent 工作台', description: '开发工具、模型、Agent 通讯录与协作群组' },
  { id: 'connections', area: 'connections', group: 'runtime', title: '服务器连接', description: '当前运行环境、服务器地址簿与重新连接' },
  { id: 'local', area: 'local', group: 'runtime', mode: 'local', title: '本机状态', description: '查看本机存储与已装配能力' },
  { id: 'engines', area: 'engines', group: 'runtime', mode: 'local', title: '引擎会话', description: 'Claude Code、Codex 等引擎的会话管理' },
  { id: 'hosts', area: 'hosts', group: 'runtime', mode: 'local', title: '远端机器', description: 'SSH 接入、安装升级与隧道' },
  { id: 'operations', area: 'operations', group: 'runtime', mode: 'server', title: '集群与服务', description: '节点、调度与服务健康' },
  { id: 'recovery', area: 'recovery', group: 'runtime', mode: 'server', cluster: true, admin: true, title: '恢复审批', description: '审批、执行与回执核对' },
  { id: 'storage', area: 'storage', group: 'runtime', mode: 'server', cluster: true, admin: true, title: '存储配额', description: '租户与项目的容量上限' },
  { id: 'token-usage', area: 'token-usage', group: 'runtime', mode: 'server', platform: true, title: 'Token 用量', description: '平台模型用量与费用' },
  { id: 'skills', surface: 'skills', group: 'capabilities', title: '技能管理', description: '已安装技能的版本与调用策略' },
  { id: 'skillhub', surface: 'skillhub', group: 'capabilities', title: '技能中心', description: '添加专家或安装单项技能' },
  { id: 'connectors', surface: 'connectors', group: 'capabilities', mode: 'server', title: '连接器', description: '能力清单、凭证与审批' },
  { id: 'registry', group: 'capabilities', mode: 'server', title: '制品目录与灰度', description: '发布版本、安装计划与节点回报' },
  { id: 'account', surface: 'account', group: 'account', mode: 'server', title: '用户中心', description: '当前身份、安全策略与登录会话' },
  { id: 'users', area: 'users', group: 'account', mode: 'server', cluster: true, admin: true, title: '用户管理', description: '用户资料、登录方式与角色分配' },
  { id: 'departments', area: 'departments', group: 'account', mode: 'server', cluster: true, admin: true, title: '部门管理', description: '部门关系与负责人' },
  { id: 'roles', area: 'roles', group: 'account', mode: 'server', cluster: true, admin: true, title: '角色管理', description: '组织角色目录与授权' },
  { id: 'permissions', area: 'permissions', group: 'account', mode: 'server', cluster: true, title: '权限诊断', description: '当前身份的有效权限与判定原因' },
]

export const managementEntries = (access: ManagementAccess): ManagementEntry[] => entries.filter(entry =>
  (!entry.mode || entry.mode === (access.local ? 'local' : 'server')) &&
  (!entry.cluster || access.clusterReady) && (!entry.admin || access.organization) && (!entry.platform || access.platformAdmin),
)

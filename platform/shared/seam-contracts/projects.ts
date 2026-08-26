/**
 * 项目工作区契约（§11.1，设计说明 `docs/superpowers/specs/2026-08-26-project-workspace-design.md`）。
 *
 * 项目 = realm 内顶级协作工作区：成员、引用、知识库空间、会话与任务的挂载点，
 * 也是**计费记账的最小单元**（N3 拍板 B：项目是并行预算树——一次调用同时扣用户树
 * 与项目树，任一超限即拒）。
 *
 * 本文件是三闭集 + 两个纯函数（与 cost-events/budget-policy 同风格）：语义在此，
 * 数值不两处；Go 消费侧（control-plane/projects）跑同一矩阵——契约双实现，语义同源。
 */

/** 项目生命周期状态闭集。删除**不是状态**——归档是常态，删除是终局动作（须先归档 + 显式确认）。 */
export const PROJECT_STATUSES = ['active', 'archived'] as const
export type ProjectStatus = (typeof PROJECT_STATUSES)[number]

/**
 * 项目成员角色闭集（§11.1 权限行）。
 *
 * `owner` 全权；`editor` 可改引用与配置；`viewer` 只读。项目即 realm 内 RBAC 的
 * 承载体（§10.2）——不新建第四套授权体系，跨项目引用需 OPA 显式节点（P2，§6.3）。
 */
export const PROJECT_ROLES = ['owner', 'editor', 'viewer'] as const
export type ProjectRole = (typeof PROJECT_ROLES)[number]

/** 项目动作闭集（§11.1 表格直译：读/改/成员/生命周期/删除/预算）。 */
export const PROJECT_ACTIONS = [
  'project.read',
  'project.edit',
  'members.manage',
  'project.archive',
  'project.delete',
  'budget.configure',
] as const
export type ProjectAction = (typeof PROJECT_ACTIONS)[number]

/** 能力矩阵：role × action → 允许与否。逐格写死，无「默认放行」分支。 */
const CAPABILITY: Record<ProjectRole, Record<ProjectAction, boolean>> = {
  owner: {
    'project.read': true,
    'project.edit': true,
    'members.manage': true,
    'project.archive': true,
    'project.delete': true,
    'budget.configure': true,
  },
  editor: {
    'project.read': true,
    'project.edit': true,
    'members.manage': false,
    'project.archive': false,
    'project.delete': false,
    'budget.configure': false,
  },
  viewer: {
    'project.read': true,
    'project.edit': false,
    'members.manage': false,
    'project.archive': false,
    'project.delete': false,
    'budget.configure': false,
  },
}

/**
 * 角色能否执行动作。闭集外**抛错而非返回 false**——未知角色/动作是契约漂移，
 * 静默 false 会让「新加的动作全员不可用」藏到生产。
 */
export function canProject(role: ProjectRole, action: ProjectAction): boolean {
  if (!PROJECT_ROLES.includes(role)) {
    throw new Error(`未知项目角色 ${String(role)}，合法取值：${PROJECT_ROLES.join(' / ')}`)
  }
  if (!PROJECT_ACTIONS.includes(action)) {
    throw new Error(`未知项目动作 ${String(action)}，合法取值：${PROJECT_ACTIONS.join(' / ')}`)
  }
  return CAPABILITY[role][action]
}

/** 生命周期事件闭集。 */
export const PROJECT_EVENTS = ['archive', 'unarchive'] as const
export type ProjectEvent = (typeof PROJECT_EVENTS)[number]

/**
 * 生命周期状态机：`active ↔ archived`。
 *
 * **为什么删除不在状态机里**：「删除必须显式授权」（§11.1）落在两层上——先归档
 * （可逆的组织动作），再对 archived 态显式确认删除（不可逆）。让删除成为状态
 * `active` 的合法转移，等于允许一键跳过归档这道闸。自反转移幂等：重复 archive
 * 是重放不是错误（至少一次语义的自然延伸）。
 */
export function transitionProject(status: ProjectStatus, event: ProjectEvent): ProjectStatus {
  if (!PROJECT_STATUSES.includes(status)) {
    throw new Error(`未知项目状态 ${String(status)}，合法取值：${PROJECT_STATUSES.join(' / ')}`)
  }
  if (!PROJECT_EVENTS.includes(event)) {
    throw new Error(`未知生命周期事件 ${String(event)}，合法取值：${PROJECT_EVENTS.join(' / ')}`)
  }
  return event === 'archive' ? 'archived' : 'active'
}

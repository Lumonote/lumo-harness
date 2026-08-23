/**
 * 控制指令策略点（§6.3 OPA 单点评估的本地实现）。
 *
 * 权限合成规则（评审 N4）：**三层取交集，且项目权限不得提升 realm 权限**。
 * realm 层拒绝即拒绝——否则任何人建一个项目并给自己 owner 就能越权。
 */
import type { ControlCommand, ControlDecision, ControlPolicy } from '../../../shared/seam-contracts/control.ts'

/** realm 层角色 → 允许的控制指令（权限上限，项目层只能收窄不能放宽） */
export type RoleGrants = Record<string, readonly ControlCommand[]>

export const DEFAULT_ROLE_GRANTS: RoleGrants = {
  // 只读角色：无任何控制权
  viewer: [],
  // 操作者：可暂停/恢复/安全停止，不可硬中止、不可审批
  operator: ['pause', 'resume', 'stop', 'replay'],
  // 审批者：HITL 审批 + 降级
  approver: ['approve', 'reject', 'degrade'],
  // 管理员：全部
  admin: ['pause', 'resume', 'stop', 'abort', 'approve', 'reject', 'replay', 'degrade'],
}

export interface RbacPolicyConfig {
  /** realm 层授权表（权限上限） */
  roleGrants?: RoleGrants
  /** 项目层授权：project 角色 → 指令（只能是 realm 授权的子集，取交集） */
  projectGrants?: RoleGrants
  /** 当前 actor 的项目角色解析（装配层注入；返回 undefined = 无项目上下文） */
  resolveProjectRole?: (actor: string, sessionRef: string) => string | undefined
}

export class RbacControlPolicy implements ControlPolicy {
  private readonly roleGrants: RoleGrants
  private readonly projectGrants: RoleGrants
  private readonly resolveProjectRole?: (actor: string, sessionRef: string) => string | undefined

  constructor(config: RbacPolicyConfig = {}) {
    this.roleGrants = config.roleGrants ?? DEFAULT_ROLE_GRANTS
    this.projectGrants = config.projectGrants ?? {}
    this.resolveProjectRole = config.resolveProjectRole
  }

  evaluate(req: {
    command: ControlCommand
    actor: string
    role: string
    realm: string
    sessionRef: string
  }): ControlDecision {
    // 第一层：realm RBAC（权限上限）
    const realmAllowed = this.roleGrants[req.role] ?? []
    if (!realmAllowed.includes(req.command)) {
      return { allowed: false, reason: 'not-authorized' }
    }

    // 第二层：项目角色（只能收窄 —— 项目权限不得提升 realm 权限，评审 N4）
    const projectRole = this.resolveProjectRole?.(req.actor, req.sessionRef)
    if (projectRole !== undefined) {
      const projectAllowed = this.projectGrants[projectRole] ?? []
      if (!projectAllowed.includes(req.command)) {
        return { allowed: false, reason: 'policy-denied' }
      }
    }

    return { allowed: true }
  }
}

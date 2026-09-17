/**
 * 控制指令策略点（§6.3 OPA 单点评估的本地实现）。
 *
 * 权限合成规则（评审 N4）：**三层取交集，且项目权限不得提升 realm 权限**。
 * realm 层拒绝即拒绝——否则任何人建一个项目并给自己 owner 就能越权。
 *
 * # 本层是**前置**，不是权威
 *
 * 权威裁决是控制面里的 OPA（`deploy/policies/session-control.rego`，由 Go 侧
 * `internal/policy` 评估）。本层的两个作用：
 *
 *   1. `RbacControlPolicy`：明显越权的请求当场拒掉，不为一次必然被拒的调用打网络往返；
 *   2. `OpaControlPolicy`：在本地放行之后再问一次同一个策略包，让中心策略**收窄**本地授权
 *      （例如临时吊销某个角色）。
 *
 * 两者都只回答「本层拦不拦」，**不回答「指令生效了吗」**——那个问题的答案只能来自控制面。
 */
import type {
  ControlCommand,
  ControlPolicy,
  ControlPolicyVerdict,
} from '../../../shared/seam-contracts/control.ts'

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
  }): ControlPolicyVerdict {
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

/**
 * 中心策略可以收窄本地授权；**拿不到判定时绝不放行**。
 *
 * # 判据与 Go 侧 `internal/policy` 逐条对齐
 *
 * 同一个 OPA、同一个策略包，两侧对「什么算拿不到判定」必须给出同一个答案，否则会出现
 * 「插件说权限不足、控制面说引擎不可用」这种谁也解释不了的组合。Go 侧的判据（见
 * `session-control/internal/policy/policy.go`）是：
 *
 * | 情形 | Go | 本类 |
 * | --- | --- | --- |
 * | 未配置地址 | `ErrUnavailable` | 构造期就不装本类（回落纯 RBAC） |
 * | 连不上 / 超时 | `ErrUnavailable` | `policy-unavailable` |
 * | 非 2xx | `ErrUnavailable` | `policy-unavailable` |
 * | 响应读不懂 | `ErrUnavailable` | `policy-unavailable` |
 * | `result` 缺失或 null | `ErrUnavailable`（**策略包没加载**） | `policy-unavailable` |
 * | `result` 是 `false` | `Allowed=false`（永久拒绝） | `policy-denied` |
 *
 * 最后一档的上一档是这条注释存在的主要理由：`result` 缺失**不能**当成 `allow=false`。
 * 那会把「策略包没加载」静默成「权限不足」，于是把一次部署事故表现成「全公司突然都没有
 * 控制权限了」——运维会去查权限配置，而真正的问题在 OPA 的挂载路径上。
 */
export class OpaControlPolicy implements ControlPolicy {
  private readonly endpoint: string

  constructor(baseUrl: string, private readonly local: ControlPolicy, private readonly token = '') {
    const url = new URL(baseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('control: invalid OPA URL')
    }
    this.endpoint = `${url.href.replace(/\/+$/, '')}/v1/data/lumo/session_control/allow`
  }

  async evaluate(request: Parameters<ControlPolicy['evaluate']>[0]): Promise<ControlPolicyVerdict> {
    const local = await this.local.evaluate(request)
    if (!local.allowed) return local

    let response: Response
    try {
      response = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3_000),
        headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
        body: JSON.stringify({ input: request }),
      })
    } catch {
      // 网络层失败 = 拿不到判定。**不是**「策略说不行」。
      return { allowed: false, reason: 'policy-unavailable' }
    }
    if (!response.ok) {
      // 5xx 是 OPA 自己出问题，404 是路径写错（策略包没加载）。两种都是「拿不到判定」。
      return { allowed: false, reason: 'policy-unavailable' }
    }

    let body: { result?: unknown }
    try {
      body = await response.json() as { result?: unknown }
    } catch {
      return { allowed: false, reason: 'policy-unavailable' }
    }
    // `result` 缺失 / null / 不是布尔：策略包未加载或形状变了。**不能**当成 false。
    if (typeof body.result !== 'boolean') {
      return { allowed: false, reason: 'policy-unavailable' }
    }
    return body.result ? { allowed: true } : { allowed: false, reason: 'policy-denied' }
  }
}

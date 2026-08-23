/**
 * @lumo/control —— 共享执行控制（§8.4，铁律 18）。
 *
 * 提供：`ctx.sessionControl`（seam，契约 shared/seam-contracts/control.ts）
 * 作用点（dsh 公开挂点，零侵入）：
 *   - `agent/turn-stopping`（串行）：paused/stopping → 停转交还，不再产生新 turn
 *   - `tools/pre-execute`（瀑布，必须 next()）：aborted/paused → 拒绝工具执行；
 *     高敏感写操作在 pause 态下不得放行（§10.3 HITL 与 R2 幂等的协同前置）
 *
 * 控制指令本身不在此插件接收（它们来自终端/网关，经 seam 的 dispatch 落库）；
 * 本插件负责**让控制状态对 agent 生效**，并把状态暴露给其它组件。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { PgControlSeam, type SessionControlState } from './pg-control.ts'
import { RbacControlPolicy, DEFAULT_ROLE_GRANTS, type RoleGrants } from './policy.ts'
import type { ControlSeam } from '../../../shared/seam-contracts/control.ts'

export interface ControlConfig {
  connectionString: string
  /** realm 层角色授权表（权限上限；省略用内置默认） */
  roleGrants?: RoleGrants
  /** 项目层角色授权表（只能收窄 realm 授权 —— 评审 N4） */
  projectGrants?: RoleGrants
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionControl: ControlSeam
  }
}

/** Schemastery validation for {@link ControlConfig} */
export const Config: z<ControlConfig> = z.object({
  connectionString: z.string(),
  roleGrants: z.dict(z.array(z.string())),
  projectGrants: z.dict(z.array(z.string())),
}) as unknown as z<ControlConfig>

/** 暂停态下一律拒绝的工具前缀（外部写副作用；与 R2 幂等要求同源） */
const SIDE_EFFECT_TOOL_PREFIXES = ['bash', 'pwsh', 'write', 'edit', 'connector_', 'knowledge_publish']

export function apply(ctx: Context, config: ControlConfig): void {
  const policy = new RbacControlPolicy({
    roleGrants: config.roleGrants ?? DEFAULT_ROLE_GRANTS,
    projectGrants: config.projectGrants,
  })
  const seam = new PgControlSeam(config.connectionString, policy)

  ctx.effect(() => () => {
    void seam.close()
  })

  ctx.provide('sessionControl', seam)
  void seam.init()

  /** 会话状态缓存（避免每个工具调用打一次 DB；控制指令生效延迟 ≤ ttl） */
  const stateCache = new Map<string, { state: SessionControlState; at: number }>()
  const CACHE_TTL_MS = 1_000

  const currentState = async (sessionRef: string): Promise<SessionControlState> => {
    const hit = stateCache.get(sessionRef)
    const now = Date.now()
    if (hit && now - hit.at < CACHE_TTL_MS) return hit.state
    const state = await seam.state(sessionRef)
    stateCache.set(sessionRef, { state, at: now })
    return state
  }

  // 挂点 1：turn 边界停转（pause/stop 的落点 —— 释放 Slot，不空转，§8.1）
  ctx.on('agent/turn-stopping', async (payload) => {
    const sessionRef = payload.agent?.session?.id
    if (!sessionRef) return
    const state = await currentState(String(sessionRef))
    if (state === 'paused' || state === 'stopping' || state === 'aborted') {
      ctx.logger.info('lumo/control: 会话 %s 处于 %s —— turn 停转交还', sessionRef, state)
    }
  })

  // 挂点 2：工具执行前置闸（瀑布，必须 next()）
  ctx.on('tools/pre-execute', async function (exec, next) {
    const sessionRef = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
    if (!sessionRef) return next()

    const state = await currentState(String(sessionRef))
    if (state === 'aborted') {
      throw new Error('lumo/control: 会话已中止（abort）—— 拒绝工具执行')
    }
    if (state === 'paused' || state === 'stopping') {
      const toolName = String((exec as { name?: string }).name ?? '')
      // 暂停态：外部副作用一律拒绝；只读工具放行（便于暂停期间检视）
      if (SIDE_EFFECT_TOOL_PREFIXES.some((p) => toolName.startsWith(p))) {
        throw new Error(`lumo/control: 会话处于 ${state} —— 拒绝副作用工具 ${toolName}`)
      }
    }
    return next()
  })
}

export default apply
export { PgControlSeam, RbacControlPolicy, DEFAULT_ROLE_GRANTS }
export type { ControlSeam, SessionControlState, RoleGrants }

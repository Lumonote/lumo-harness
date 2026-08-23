/**
 * @lumo/session-log —— 复制式 SessionEvent 日志（评审 A1）。
 *
 * 订阅 dsh 已广播的 `session/event`，把日志同步复制到 PG 真相源，使会话状态可跨节点
 * resume/migrate。零侵入：只用公开事件与公开挂点。
 *
 * 挂点：
 *   - `session/event`：复制事件（每会话串行，保序）
 *   - `tools/pre-execute`：**本节点被 fence 掉后拒绝一切工具执行**——单边急停
 *   - `session/disposed`：让出租约
 *
 * ## 被接管后为什么必须单边急停
 *
 * 租约被抢走意味着另一个节点已经在接着跑这个会话了。此时本节点每多执行一个工具，
 * 就多一次与新持有者重复的外部副作用。不能走控制面下指令——控制权已经不在本节点，
 * 等一个来回就是等着重复写。所以在 `tools/pre-execute` 上就地抛错，立刻断掉副作用。
 * 日志已经写不进去了（fencing 拦着），继续执行也只是产生一段没人认的历史。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-session'

import { PgSessionLog } from './pg-log.ts'
import {
  FencedOutError,
  LogForkError,
  type SessionLogSeam,
} from '../../../shared/seam-contracts/session-log.ts'

export interface SessionLogConfig {
  connectionString: string
  /** 本节点标识；必须能区分同机重启（否则重启后的进程会被当成本人而续到旧租约） */
  holder: string
  /** 租约时长（毫秒）。过短会在 GC 停顿时误判失活，过长会拖慢故障接管。 */
  leaseTtlMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionLog: SessionLogSeam
  }
}

/** Schemastery validation for {@link SessionLogConfig} */
export const Config: z<SessionLogConfig> = z.object({
  connectionString: z.string(),
  holder: z.string(),
  leaseTtlMs: z.number(),
})

/** 工具服务须先挂载（本插件在其执行瀑布上装急停闸） */
export const inject = ['tools']

/** 默认租约 30s：够长以容忍常规 GC 停顿，够短以让故障接管在一分钟内完成。 */
const DEFAULT_LEASE_TTL_MS = 30_000

export function apply(ctx: Context, config: SessionLogConfig): void {
  const log = new PgSessionLog(config.connectionString)
  const ttlMs = config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const holder = config.holder

  void log.init()
  ctx.provide('sessionLog', log)

  /** 每会话的写入队列尾（保序：`session/event` 是同步回调，append 是异步的） */
  const tails = new Map<string, Promise<void>>()
  /** 已持有的租约令牌 */
  const tokens = new Map<string, number>()
  /** 已被 fence 掉的会话——本节点对它们只剩一件事可做：停手 */
  const fenced = new Map<string, string>()

  /**
   * 取得可写令牌。首次调用抢租；已持有则直接复用。
   * 返回 undefined 表示拿不到写权（他人持租未过期）——调用方须据此 fence 本会话。
   */
  async function ensureToken(sessionRef: string): Promise<number | undefined> {
    const held = tokens.get(sessionRef)
    if (held !== undefined) return held
    const lease = await log.acquire(sessionRef, holder, ttlMs)
    if (!lease) return undefined
    tokens.set(sessionRef, lease.fencingToken)
    return lease.fencingToken
  }

  /** 标记本会话已失去写权，并记录原因供 `tools/pre-execute` 拒绝时引用。 */
  function fence(sessionRef: string, reason: string): void {
    fenced.set(sessionRef, reason)
    tokens.delete(sessionRef)
    ctx.logger.error('session-log: 会话 %s 已被 fence —— %s', sessionRef, reason)
  }

  ctx.on('session/event', (session, event) => {
    const sessionRef = String(session.id)
    if (fenced.has(sessionRef)) return

    // 串到本会话队列尾：dsh 的 seq 已定序，但 append 是异步的，
    // 并发发起会让先到的事件后落库，read() 出来的顺序就不再是 seq 顺序。
    const prev = tails.get(sessionRef) ?? Promise.resolve()
    const nextTail = prev.then(async () => {
      if (fenced.has(sessionRef)) return
      const token = await ensureToken(sessionRef)
      if (token === undefined) {
        fence(sessionRef, '写者租约被他人持有——另一节点已在运行同一会话')
        return
      }
      try {
        await log.append({
          sessionRef,
          seq: event.seq,
          type: event.type,
          payload: event,
          time: event.time,
        }, token)
      } catch (error) {
        if (error instanceof FencedOutError) {
          fence(sessionRef, error.message)
          return
        }
        if (error instanceof LogForkError) {
          // 数据完整性事故：两条分支都可能已产生外部副作用，机器无权择一。
          fence(sessionRef, error.message)
          return
        }
        // 其余（网络/库故障）不 fence：本节点仍持租，重试的语义留给上层。
        // 但必须响亮——日志缺口意味着这段历史无法跨节点重建。
        ctx.logger.error('session-log: 会话 %s seq=%d 复制失败：%s',
          sessionRef, event.seq, error instanceof Error ? error.message : String(error))
      }
    })
    tails.set(sessionRef, nextTail)
  })

  ctx.on('session/disposed', (session) => {
    const sessionRef = String(session.id)
    const tail = tails.get(sessionRef) ?? Promise.resolve()
    // 等队列排空再让租约：提前释放会让接管者在本节点最后几条事件落库前就开始写。
    void tail.then(() => log.release(sessionRef, holder)).finally(() => {
      tails.delete(sessionRef)
      tokens.delete(sessionRef)
      fenced.delete(sessionRef)
    })
  })

  // 急停闸：被 fence 后拒绝一切工具执行（瀑布，放行路径必须 next()）
  ctx.on('tools/pre-execute', async function (exec, next) {
    const sessionRef = (exec as { agent?: { session?: { id?: string } } }).agent?.session?.id
    if (!sessionRef) return next()
    const reason = fenced.get(String(sessionRef))
    if (reason) {
      throw new Error(
        `lumo/session-log: 本节点已失去会话 ${String(sessionRef)} 的写权，拒绝执行工具 `
        + `${exec.name}。原因：${reason}`,
      )
    }
    return next()
  })

  // 续租：按 ttl/3 的节奏，容许连丢两次仍不失租
  const renewTimer = setInterval(() => {
    for (const sessionRef of tokens.keys()) {
      void log.acquire(sessionRef, holder, ttlMs).then((lease) => {
        if (!lease || lease.fencingToken !== tokens.get(sessionRef)) {
          // 续租却拿回不同令牌 = 中途被接管过。令牌变了，本节点的写已经无效。
          fence(sessionRef, '续租时发现令牌已变——租约中途被接管')
        }
      }, (error: unknown) => {
        // 续租失败不立即 fence：租约还没到期，下一轮可能就好了。
        ctx.logger.warn('session-log: 会话 %s 续租失败：%s',
          sessionRef, error instanceof Error ? error.message : String(error))
      })
    }
  }, Math.max(1_000, Math.floor(ttlMs / 3)))

  ctx.effect(() => async () => {
    clearInterval(renewTimer)
    // 排空在途写入再关连接池：`session/event` 是同步回调而 append 是异步的，
    // 停机时队列里通常还压着几条。不等它们落库，日志尾部就会缺一截——
    // 而恢复正是从日志末尾接着跑，缺尾意味着那几步会被重做。
    // （硬崩溃拦不住，那种情形由 @lumo/recovery 的写前意图去裁决。）
    await Promise.allSettled([...tails.values()])
    await log.close()
  })
}

export default apply
export { PgSessionLog } from './pg-log.ts'
export type { SessionLogSeam }

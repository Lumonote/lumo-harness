/**
 * @lumo/mailbox —— 持久信箱与 Future/Promise seam（评审 A3）。
 *
 * §8.1 承诺「背靠持久 mailbox，跨节点跨时间成立」，§5.2 却把信箱放 Redis。
 * Redis Cluster 不是持久消息存储：故障切换会丢已确认写入，于是出现
 * 「B 已 resolve，A 永不唤醒」的**静默挂起**——不崩溃、不报错，监控看不出来。
 *
 * 本插件把信箱落在 PG，并强制 TTL + 死信 + 对账扫描，使最坏情况从「无限挂起」
 * 降级为「超时重试」。集群形态可把 Provider 换成 RocketMQ，seam 不变。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { PgMailbox } from './pg-mailbox.ts'
import { defineMailboxTools } from './consumer.ts'
import type { MailboxSeam } from '../../../shared/seam-contracts/mailbox.ts'

export interface MailboxConfig {
  connectionString: string
  /** 本节点 realm —— 工具层固定注入，模型不可改 */
  realm: string
  /** 默认等待有效期 */
  defaultTtlMs?: number
  /** 等待有效期上限：模型给的 ttl 会被夹到此值内，防止绕过强制过期 */
  maxTtlMs?: number
  /** 单次 wait 的等待上限 */
  maxWaitMs?: number
  /** 未决项轮询间隔（唤醒延迟与库压力的折中） */
  pollIntervalMs?: number
  /** 对账扫描间隔 */
  sweepIntervalMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    mailbox: MailboxSeam
  }
}

/** Schemastery validation for {@link MailboxConfig} */
export const Config: z<MailboxConfig> = z.object({
  connectionString: z.string(),
  realm: z.string(),
  defaultTtlMs: z.number(),
  maxTtlMs: z.number(),
  maxWaitMs: z.number(),
  pollIntervalMs: z.number(),
  sweepIntervalMs: z.number(),
})

/** 工具服务须先挂载（本插件注册三个协同工具） */
export const inject = ['tools']

/** 默认等待 5 分钟：够长以覆盖人工审批，够短以让卡住的协同在一个班次内暴露。 */
const DEFAULT_TTL_MS = 5 * 60_000
/** 上限 24 小时：跨夜的人工环节仍在射程内，但不容许「实质无限」的等待。 */
const DEFAULT_MAX_TTL_MS = 24 * 60 * 60_000
/** 单次 wait 上限 10 分钟：超过就该让出 Slot 走 suspend/resume，而不是把 Slot 占死。 */
const DEFAULT_MAX_WAIT_MS = 10 * 60_000
/** 对账 30 秒一轮：TTL 到期后最迟半分钟进死信。 */
const DEFAULT_SWEEP_MS = 30_000

export function apply(ctx: Context, config: MailboxConfig): void {
  const mailbox = new PgMailbox({
    connectionString: config.connectionString,
    pollIntervalMs: config.pollIntervalMs,
  })

  ctx.provide('mailbox', mailbox)

  const unregister = defineMailboxTools(ctx, mailbox, {
    realm: config.realm,
    defaultTtlMs: config.defaultTtlMs ?? DEFAULT_TTL_MS,
    maxTtlMs: config.maxTtlMs ?? DEFAULT_MAX_TTL_MS,
    maxWaitMs: config.maxWaitMs ?? DEFAULT_MAX_WAIT_MS,
  })

  const ready = mailbox.init()

  // 对账扫描：唤醒通知可能丢失，扫描是最后一道防线。
  // 它不承担正确性（读路径已就地判过期），只负责把死信显性化供运维排查。
  ctx.effect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    let disposed = false
    void ready.then(() => {
      if (disposed) return
      timer = setInterval(() => {
        mailbox.sweep().then((n) => {
          if (n > 0) ctx.logger.warn('mailbox: %d 个等待项 TTL 到期未兑现，已入死信', n)
        }, (e: unknown) => {
          // 扫描失败不致命：读路径仍会就地判过期，下一轮重试。
          ctx.logger.warn('mailbox: 对账扫描失败（下一轮重试）: %s', e)
        })
      }, Math.max(config.sweepIntervalMs ?? DEFAULT_SWEEP_MS, 1_000))
      timer.unref?.()
    }).catch((e: unknown) => {
      ctx.logger.error('mailbox: 初始化失败，对账扫描未启动: %s', e)
    })
    return () => {
      disposed = true
      if (timer) clearInterval(timer)
    }
  })

  ctx.effect(() => async () => {
    unregister()
    await mailbox.close()
  })
}

export default apply
export { PgMailbox } from './pg-mailbox.ts'
export type { MailboxSeam }

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
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { PgSessionLog } from './pg-log.ts'
import { restoreSession, type RestoreHeaderHints } from './restore.ts'
import { PgColdLogArchiver } from './cold-log.ts'
import { RedisHotLog } from './hot-log.ts'
import { DiskReplicationSpool, ReplicationQueue, type SessionLogReplication } from './replication-queue.ts'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import {
  FencedOutError,
  LogForkError,
  type LogRecord,
  type SessionLogSeam,
} from '../../../shared/seam-contracts/session-log.ts'
import {
  stalenessOf,
  type SessionLogQuerySeam,
} from '../../../shared/seam-contracts/session-query.ts'
import type { ColdLogSeam } from '../../../shared/seam-contracts/cold-log.ts'
import type { HotLogSeam } from '../../../shared/seam-contracts/hot-log.ts'

export interface SessionLogConfig {
  connectionString: string
  /** 本节点标识；必须能区分同机重启（否则重启后的进程会被当成本人而续到旧租约） */
  holder: string
  /** 租约时长（毫秒）。过短会在 GC 停顿时误判失活，过长会拖慢故障接管。 */
  leaseTtlMs?: number
  /** Stable node-local directory; production mounts this on persistent storage. */
  spoolDirectory?: string
  maxPendingEvents?: number
  /**
   * 冷层（冷转 MinIO，§4.2）。缺省不启动归档——冷层是可选加速，不是写路径依赖。
   * `realm` 与 object-store 给定的节点 realm 一致（对象键身份前缀）。
   */
  coldLog?: {
    realm: string
    maxItems?: number
  }
  /**
   * 热层（每会话 Redis LIST 尾部窗口缓存，§4.2）。缺省不配置时行为与无热层完全相同
   * （读直连 PG）；配置后读路径先查窗口、未覆盖回退 PG，写路径在 PG 提交后透传镜像
   * （镜像失败只 warn——Redis 绝不参与写路径成败判定，fail-open / D-Continue）。
   * `realm` 与对象层一致（身份段，热键前缀隔离）。
   */
  hotCache?: {
    url: string
    realm: string
    ttlMs?: number
    maxLen?: number
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionLog: SessionLogSeam
    coldLog: ColdLogSeam
    sessionLogHot?: HotLogSeam
    sessionLogQuery: SessionLogQuerySeam
    sessionLogReplication: SessionLogReplication
  }
}

/** Schemastery validation for {@link SessionLogConfig} */
export const Config: z<SessionLogConfig> = z.object({
  connectionString: z.string(),
  holder: z.string(),
  leaseTtlMs: z.number(),
  spoolDirectory: z.string(),
  maxPendingEvents: z.number(),
  coldLog: z.object({ realm: z.string(), maxItems: z.number() }),
  hotCache: z.object({ url: z.string(), realm: z.string(), ttlMs: z.number(), maxLen: z.number() }),
})

/** 工具服务须先挂载（本插件在其执行瀑布上装急停闸）；冷层还要对象存储 seam */
export const inject = ['tools', 'objectStore']

/** 默认租约 30s：够长以容忍常规 GC 停顿，够短以让故障接管在一分钟内完成。 */
const DEFAULT_LEASE_TTL_MS = 30_000

export async function apply(ctx: Context, config: SessionLogConfig): Promise<void> {
  const log = new PgSessionLog(config.connectionString)
  const ttlMs = config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const holder = config.holder

  try { await log.init() } catch (error) { await log.close(); throw error }

  // 热层：每会话 Redis LIST 尾部窗口（§4.2 热 Redis）。配置了才启用。
  // 真相源始终是 PG——热层故障绝不放大为日志故障（fail-open / D-Continue）。
  const hot = config.hotCache
    ? new RedisHotLog({
        url: config.hotCache.url,
        realm: config.hotCache.realm,
        maxLen: config.hotCache.maxLen,
        ttlMs: config.hotCache.ttlMs,
        onWarn: (message) => ctx.logger.warn('session-log: %s', message),
      })
    : undefined

  if (hot) {
    // adapter：acquire/release/append/lease 直通 PG；read = 热窗口命中 ?? PG 兜底。
    // 用 undefined 判定而非 ||——覆盖窗口里 fromSeq 切空的空数组是合法结果，
    // || 会把它也吞掉再打一次 PG（仍正确，但空转）。热层 read 抛错同样回退 PG。
    ctx.provide('sessionLog', {
      acquire: (sessionRef, leaseHolder, leaseTtlMs) => log.acquire(sessionRef, leaseHolder, leaseTtlMs),
      release: (sessionRef, leaseHolder) => log.release(sessionRef, leaseHolder),
      append: (record, token) => log.append(record, token),
      read: async (sessionRef, fromSeq = 0) => {
        try {
          const fromHot = await hot.read(sessionRef, fromSeq)
          if (fromHot !== undefined && (fromHot.at(-1)?.seq ?? fromSeq) >= await log.head(sessionRef)) return fromHot
        } catch (error) {
          // fail-open：热层故障绝不放大为读失败——回退 PG 真相源
          ctx.logger.warn('session-log: 会话 %s 热层读取失败，回退 PG：%s',
            sessionRef, error instanceof Error ? error.message : String(error))
        }
        return log.read(sessionRef, fromSeq)
      },
      lease: (sessionRef) => log.lease(sessionRef),
    })
    ctx.provide('sessionLogHot', hot)
    // 停机时断开热层连接（与冷层、主连接池的 effect 异步段各自独立）
    ctx.effect(() => () => void hot.close())
  } else {
    ctx.provide('sessionLog', log)
  }

  /**
   * 读面缺省落后阈值：8 个事件。
   *
   * 出处：§21「复制日志读面保鲜」——容量无关的纯读面参数，与热层窗口/租约 TTL
   * 无关。取 8 的理由：足够小以让跨节点读方及时察觉投影落后（staleness 的意义
   * 在于显式暴露而不是掩盖），又足够大以吸收同库 standalone 场景下毫秒级的常规
   * 复制抖动（回填队列在途的几条事件），避免无意义的 stale 抖动。
   */
  const DEFAULT_QUERY_MAX_LAG = 8

  // 重建面：把复制日志变成一个**活的**本地会话（跨节点 resume 的平台侧落点）。
  //
  // **读的是 `log`（PG 真相源）而不是 `ctx.sessionLog`（热层加速器）**：热层按 MAXLEN
  // 裁剪，从它读到的是一段窗口，而重建要求「从 seq 0 起连续」——拿窗口去重建会被连续性
  // 检查判为断裂（响亮的失败，不是静默的错误结果），但那是一次**用错了来源**造成的失败。
  // 真相源在这里没有替代品。
  ctx.provide('sessionRestore', {
    restore: async (sessionRef: string, hints?: RestoreHeaderHints) => {
      await replication.flushSession(sessionRef)
      return restoreSession(ctx, log, sessionRef, hints)
    },
  })

  // 读面（行 3）：查询永远查「已复制到本地」的段。replicaHead 恒取 PG read() 的
  // 最大 seq——PG 是真相源、读面与 resume 同源；热层窗口是加速器，不作判别基准。
  ctx.provide('sessionLogQuery', {
    async queryWithStaleness(sessionRef, opts = {}) {
      if (opts.liveHead !== undefined) stalenessOf(opts.liveHead, 0, opts.maxLag ?? DEFAULT_QUERY_MAX_LAG)
      const records = await log.read(sessionRef)
      const replicaHead = records.length > 0 ? records[records.length - 1]!.seq : 0
      const liveHead = Math.max(opts.liveHead ?? 0, await log.head(sessionRef))
      const verdict = stalenessOf(liveHead, replicaHead, opts.maxLag ?? DEFAULT_QUERY_MAX_LAG)
      return verdict.fresh
        ? { kind: 'fresh', records }
        : { kind: 'stale', reason: 'replication-lag', replicaHead, liveHead, lag: verdict.lag }
    },
  })

  // 冷层：只读 PG 真源 → 段归档进 ctx.objectStore（MinIO），不占写者租约。
  // 缺省不启动（冷层是可选项）；配置了 coldLog 才初始化并提供 ctx.coldLog。
  if (config.coldLog) {
    const cold = new PgColdLogArchiver(
      { connectionString: config.connectionString, realm: config.coldLog.realm, maxItems: config.coldLog.maxItems },
      ctx.objectStore,
    )
    try { await cold.init() } catch (error) { await cold.close(); await log.close(); throw error }
    ctx.provide('coldLog', cold)
    // 停机时关闭冷层连接池（与下方主连接池的 effect 异步段各自独立）
    ctx.effect(() => () => void cold.close())
  }

  const tokens = new Map<string, number>()
  const fenced = new Map<string, string>()
  const observedHeads = new Map<string, number>()
  const sightSeen = new Set<string>()
  let renewalError: string | undefined

  function fence(sessionRef: string, reason: string): void {
    fenced.set(sessionRef, reason)
    tokens.delete(sessionRef)
    ctx.logger.error('session-log: session %s fenced: %s', sessionRef, reason)
  }

  async function refreshToken(sessionRef: string): Promise<number> {
    if (fenced.has(sessionRef)) throw new Error(fenced.get(sessionRef))
    const prior = tokens.get(sessionRef)
    const lease = await log.acquire(sessionRef, holder, ttlMs)
    // A new process may reopen its disk spool before its predecessor's lease
    // expires. Wait and retry; only a writer that previously held authority is
    // irreversibly fenced when that authority disappears.
    if (!lease && prior === undefined) throw new Error(`session-log: session ${sessionRef} is still leased by another writer`)
    if (!lease || (prior !== undefined && lease.fencingToken !== prior)) {
      const error = new FencedOutError(sessionRef, prior ?? 0, lease?.fencingToken)
      fence(sessionRef, error.message)
      throw error
    }
    tokens.set(sessionRef, lease.fencingToken)
    return lease.fencingToken
  }

  const spoolDirectory = config.spoolDirectory ?? join(tmpdir(), 'lumo-session-log',
    createHash('sha256').update(JSON.stringify([config.connectionString, holder])).digest('hex'))
  const replication = new ReplicationQueue({
    spool: new DiskReplicationSpool(spoolDirectory),
    maxPending: config.maxPendingEvents,
    onFatal: (sessionRef, error) => fence(sessionRef, error.message),
    write: async record => {
      const token = tokens.get(record.sessionRef) ?? await refreshToken(record.sessionRef)
      await log.publishHead(record.sessionRef, observedHeads.get(record.sessionRef) ?? record.seq, token)
      const result = await log.append(record, token)
      if (hot && result.status === 'appended') void hot.mirror(record).catch(error =>
        ctx.logger.warn('session-log: hot mirror failed: %s', error))
    },
  })
  ctx.provide('sessionLogReplication', {
    health: () => {
      const health = replication.health()
      const failure = renewalError ?? fenced.values().next().value
      return failure ? { ...health, ready: false, lastError: failure } : health
    },
    flush: async () => {
      await replication.flush()
      const failure = renewalError ?? fenced.values().next().value
      if (failure) throw new Error(failure)
    },
  })

  const stage = (sessionRef: string, events: readonly SessionEvent[]): void => {
    if (fenced.has(sessionRef)) return
    try {
      for (const event of events) {
        observedHeads.set(sessionRef, Math.max(event.seq, observedHeads.get(sessionRef) ?? 0))
        replication.stage({ sessionRef, seq: event.seq, type: event.type, payload: event, time: event.time })
      }
    } catch (error) {
      // A failed local durable write is a loss of recoverability. The event
      // listener cannot roll back DSH append, so prevent every later side effect.
      fence(sessionRef, error instanceof Error ? error.message : String(error))
    }
  }

  ctx.on('session/created', session => {
    stage(String(session.id), session.snapshotEvents())
  })
  ctx.on('session/event', (session, event) => {
    const sessionRef = String(session.id)
    if (!sightSeen.has(sessionRef)) {
      sightSeen.add(sessionRef)
      const live = session as { snapshotEvents?: () => readonly SessionEvent[]; events?: readonly SessionEvent[] }
      stage(sessionRef, live.snapshotEvents?.() ?? live.events ?? [])
    }
    stage(sessionRef, [event])
  })
  ctx.on('session/flush', async session => {
    const sessionRef = String(session.id)
    if (fenced.has(sessionRef)) throw new Error(fenced.get(sessionRef))
    await replication.flushSession(sessionRef)
  })
  ctx.on('tools/pre-execute', async function (exec, next) {
    const session = (exec as { agent?: { session?: { id?: string } } }).agent?.session
    if (!session?.id) return next()
    const sessionRef = String(session.id)
    // Refresh authority even if the previous lease expired while the event loop
    // was paused. Then require all preceding session events to be committed.
    await refreshToken(sessionRef)
    await replication.flushSession(sessionRef)
    return next()
  })
  ctx.on('session/disposed', session => {
    const sessionRef = String(session.id)
    if (fenced.has(sessionRef)) return
    void replication.flushSession(sessionRef).then(() => log.release(sessionRef, holder)).then(() => {
      tokens.delete(sessionRef)
      fenced.delete(sessionRef)
      sightSeen.delete(sessionRef)
      observedHeads.delete(sessionRef)
    }).catch(error => ctx.logger.error('session-log: unconfirmed events retained on disk for %s: %s', sessionRef, error))
  })

  let renewing = false
  const renewTimer = setInterval(() => {
    if (renewing) return
    renewing = true
    void Promise.all([...tokens.keys()].map(sessionRef => refreshToken(sessionRef)))
      .then(() => { renewalError = undefined }, error => {
        renewalError = error instanceof Error ? error.message : String(error)
        ctx.logger.warn('session-log: lease renewal failed: %s', renewalError)
      }).finally(() => { renewing = false })
  }, Math.max(1000, Math.floor(ttlMs / 3)))
  renewTimer.unref()
  void replication.flush().catch(error => ctx.logger.error('session-log: durable backlog recovery deferred: %s', error))

  ctx.effect(() => async () => {
    clearInterval(renewTimer)
    try { await replication.close() } finally { await log.close() }
  })
}

export default apply
export { PgSessionLog } from './pg-log.ts'
export type { SessionLogSeam }
export type {
  SessionLogQuerySeam,
  SessionQueryEnvelope,
  SessionQueryOptions,
} from '../../../shared/seam-contracts/session-query.ts'

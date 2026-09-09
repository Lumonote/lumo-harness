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
import { PgColdLogArchiver } from './cold-log.ts'
import { RedisHotLog } from './hot-log.ts'
import { queueBackfill } from './backfill.ts'
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
  }
}

/** Schemastery validation for {@link SessionLogConfig} */
export const Config: z<SessionLogConfig> = z.object({
  connectionString: z.string(),
  holder: z.string(),
  leaseTtlMs: z.number(),
  coldLog: z.object({ realm: z.string(), maxItems: z.number() }),
  hotCache: z.object({ url: z.string(), realm: z.string(), ttlMs: z.number(), maxLen: z.number() }),
})

/** 工具服务须先挂载（本插件在其执行瀑布上装急停闸）；冷层还要对象存储 seam */
export const inject = ['tools', 'objectStore']

/** 默认租约 30s：够长以容忍常规 GC 停顿，够短以让故障接管在一分钟内完成。 */
const DEFAULT_LEASE_TTL_MS = 30_000

export function apply(ctx: Context, config: SessionLogConfig): void {
  const log = new PgSessionLog(config.connectionString)
  const ttlMs = config.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS
  const holder = config.holder

  void log.init()

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
    void cold.init()
    ctx.provide('coldLog', cold)
    // 停机时关闭冷层连接池（与下方主连接池的 effect 异步段各自独立）
    ctx.effect(() => () => void cold.close())
  }

  /** 每会话的写入队列尾（保序：`session/event` 是同步回调，append 是异步的） */
  const tails = new Map<string, Promise<void>>()
  /** 已持有的租约令牌 */
  const tokens = new Map<string, number>()
  /** 已被 fence 掉的会话——本节点对它们只剩一件事可做：停手 */
  const fenced = new Map<string, string>()
  const observedHeads = new Map<string, number>()

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

  /**
   * 回填入队(created 触发与首 sight 兜底共用同一依赖组)。
   * snapshot 由调用方先取(created 时刻 / 首 sight 时刻的 events 快照)。
   */
  const backfill = (sessionRef: string, snapshot: readonly SessionEvent[]): void => {
    const head = snapshot.at(-1)?.seq
    if (head !== undefined) observedHeads.set(sessionRef, Math.max(head, observedHeads.get(sessionRef) ?? 0))
    queueBackfill(sessionRef, snapshot, {
      tails,
      isFenced: (ref) => fenced.has(ref),
      ensureToken,
      append: async (record, token) => {
        await log.publishHead(sessionRef, observedHeads.get(sessionRef) ?? record.seq, token)
        return log.append(record, token)
      },
      onMirror: hot === undefined ? undefined : (record) => {
        // 复用 firehose 写路径的镜像形态:PG 提交后 fire-and-forget,失败只 warn
        // ——绝不 fence、绝不阻塞队列尾(单连接命令有序 ⇒ 镜像序 == append 序)。
        void hot.mirror(record).catch((error: unknown) => {
          ctx.logger.warn('session-log: 会话 %s seq=%d 热层镜像失败(不影响写路径):%s',
            sessionRef, record.seq, error instanceof Error ? error.message : String(error))
        })
      },
      logger: ctx.logger,
    })
  }

  /** 已做过首 sight 补缺的会话(每会话一次;重复触发幂等吸收,防队列膨胀) */
  const sightSeen = new Set<string>()

  ctx.on('session/event', (session, event) => {
    const sessionRef = String(session.id)
    if (fenced.has(sessionRef)) return
    observedHeads.set(sessionRef, Math.max(event.seq, observedHeads.get(sessionRef) ?? 0))

    // 首 sight 补缺兜底(终审 I1 竞态收敛):created 时刻与构造/发布窗口存在时序
    // 双向竞态(承载 child 实测 seq 覆盖三形态 13/14/20 行)。firehose 首个发布
    // 事件必然到达,而此刻 session.events 已含全部构造期事件——全量快照经同一
    // 写者队列补拷,(session,seq) 幂等吸收与 firehose 的重复;与 created 触发
    // 共存(先到者先补,后到者 duplicate 吸收)。
    if (!sightSeen.has(sessionRef)) {
      sightSeen.add(sessionRef)
      // 真实会话必然带 events;对外部 emit 的极简形状(如测试直发)防御——无
      // events 即无构造期可补,跳过。
      const live = session as { snapshotEvents?: () => readonly SessionEvent[]; events?: readonly SessionEvent[] }
      const snapshot = live.snapshotEvents?.() ?? live.events
      if (snapshot !== undefined) backfill(sessionRef, snapshot)
    }

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
        await log.publishHead(sessionRef, observedHeads.get(sessionRef) ?? event.seq, token)
        const record: LogRecord = {
          sessionRef,
          seq: event.seq,
          type: event.type,
          payload: event,
          time: event.time,
        }
        const result = await log.append(record, token)
        // 热层透传：PG 已提交（append resolve）之后才发起镜像；重投 duplicate 不镜像。
        // mirror 失败只 warn——绝不 fence、绝不改 AppendResult、绝不阻塞队列尾
        // （void + catch，fire-and-forget；单连接命令有序 ⇒ 镜像序 == append 序）。
        if (hot !== undefined && result.status === 'appended') {
          void hot.mirror(record).catch((error: unknown) => {
            ctx.logger.warn('session-log: 会话 %s seq=%d 热层镜像失败（不影响写路径）：%s',
              sessionRef, record.seq, error instanceof Error ? error.message : String(error))
          })
        }
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

  // 构造期事件回填(终审 I1):`session/event` firehose 只发布已 attach 会话的 append;
  // 构造窗口内的事件(种子/end-seed、preset/permission、sandbox/mode、
  // subagent/descriptor……)从不发布,会在复制日志里留下永久缺失。
  // `session/created`(attach 完成、announce)时把该会话的 events 快照经既有写者
  // 队列补拷入 PG(`(session,seq)` 主键幂等,与 firehose 写路径任意顺序共存)。
  ctx.on('session/created', (session) => {
    // 监听体绝不抛:created 抛 = attach 回滚(成对 disposal),灾难。回填的一切失败
    // 都发生在队列任务的异步段;这里只做同步的 fenced 检查、快照与入队。
    try {
      const sessionRef = String(session.id)
      if (fenced.has(sessionRef)) return
      // 快照与依赖组复用 backfill()(与首 sight 兜底同一实现,无漂移面)。
      backfill(sessionRef, session.snapshotEvents())
    } catch (error) {
      ctx.logger.error('session-log: 会话 %s created 回填入队失败:%s',
        String(session.id), error instanceof Error ? error.message : String(error))
    }
  })

  ctx.on('session/flush', async session => {
    await tails.get(String(session.id))
  })

  ctx.on('session/disposed', (session) => {
    const sessionRef = String(session.id)
    const tail = tails.get(sessionRef) ?? Promise.resolve()
    // 等队列排空再让租约：提前释放会让接管者在本节点最后几条事件落库前就开始写。
    void tail.then(() => log.release(sessionRef, holder)).finally(() => {
      tails.delete(sessionRef)
      tokens.delete(sessionRef)
      fenced.delete(sessionRef)
      sightSeen.delete(sessionRef)
      observedHeads.delete(sessionRef)
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
export type {
  SessionLogQuerySeam,
  SessionQueryEnvelope,
  SessionQueryOptions,
} from '../../../shared/seam-contracts/session-query.ts'

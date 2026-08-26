import { Context, Service } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { LogRecord } from '../../../shared/seam-contracts/session-log.ts'
import { RedisHotLog } from '../src/hot-log.ts'
import { apply } from '../src/index.ts'
import { PgSessionLog } from '../src/pg-log.ts'
import { schemaDsn } from './pg-schema.ts'

/**
 * 热层对**真 PG + 真 Redis** 跑。
 *
 * 契约层（`shared/seam-contracts/__tests__/hot-log.spec.ts`）已锁键/序列化/窗口覆盖的
 * 纯函数；这里断言的才是热层的真实 IO 语义：
 *   - 镜像后热读与 PG 真相源逐字段相等、窗口覆盖判定与回退边界（fromSeq=0 / lastSeq+1）；
 *   - 重复投递不重复镜像（LIST 长度 == 唯一 seq 数）——走插件事件线装配验证写透传接线；
 *   - MAXLEN 裁剪后窗口收缩、head 水位仍对；TTL 过期后读回退、head 无缓存；
 *   - fail-open：坏端口镜像快速拒绝、adapter 读回退 PG、绝不 fence（Redis 不碰成败判定）。
 *
 * 无 DSN 时整组 skip 且 skip 可见；Redis 地址用 SESSION_LOG_TEST_REDIS（缺省本地 16379）。
 */
const DSN = process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
const REDIS = process.env['SESSION_LOG_TEST_REDIS'] ?? 'redis://127.0.0.1:16379'
const enabled = Boolean(DSN) && Boolean(REDIS)
const t = enabled ? it : it.skip
const suffix = enabled
  ? '已设置'
  : `PG=${DSN ? '已设置' : '未设置'} / Redis=${REDIS ? '已设置' : '未设置'} → 跳过，非通过`

/** 每次 run 独立 realm：热键前缀隔离（共享 Redis 上不同 spec 文件/不同 run 互不干扰）。 */
const REALM = `t-hot-${randomBytes(6).toString('hex')}`
const sessionOf = (tag: string): string => `s-${tag}-${randomBytes(4).toString('hex')}`

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function recordOf(sessionRef: string, seq: number, over: Partial<LogRecord> = {}): LogRecord {
  return {
    sessionRef,
    seq,
    type: over.type ?? 'user_message',
    payload: over.payload ?? { content: `msg-${seq}` },
    time: over.time ?? 1_700_000_000_000 + seq,
  }
}

async function withHot(
  options: { maxLen?: number; ttlMs?: number; url?: string },
  fn: (hot: RedisHotLog) => Promise<void>,
): Promise<void> {
  const hot = new RedisHotLog({
    url: options.url ?? REDIS,
    realm: REALM,
    maxLen: options.maxLen,
    ttlMs: options.ttlMs,
  })
  try {
    await fn(hot)
  } finally {
    await hot.close()
  }
}

/** 每个测试拿独立 schema（TRUNCATE 互不干扰，理由见 pg-schema.ts 注释）。 */
async function withLog(fn: (log: PgSessionLog) => Promise<void>): Promise<void> {
  const log = new PgSessionLog(await schemaDsn(DSN!, 'session_log_hot_test'))
  try {
    await log.init()
    await log.raw('TRUNCATE session_log, session_writer_lease')
    await fn(log)
  } finally {
    await log.close()
  }
}

/** 工具服务桩：占住插件 inject 槽（冒烟同法；本 spec 不 drive 工具瀑布）。 */
class ToolsStub extends Service {
  constructor(ctx: Context) {
    super(ctx)
  }
}

/** 事件线装配：apply 插件（hotCache 接线），并给一个同 schema 的 PG 直连做真相源对拍。 */
async function withAssembly(
  hotCache: { url: string; realm: string; ttlMs?: number; maxLen?: number },
  fn: (ctx: Context, pg: PgSessionLog) => Promise<void>,
): Promise<void> {
  const dsn = await schemaDsn(DSN!, 'session_log_hot_test')
  const pg = new PgSessionLog(dsn)
  await pg.init()
  await pg.raw('TRUNCATE session_log, session_writer_lease')
  const ctx = new Context()
  ctx.provide('tools', new ToolsStub(ctx))
  apply(ctx, {
    connectionString: dsn,
    holder: 'hot-test-node',
    leaseTtlMs: 30_000,
    hotCache,
  })
  try {
    // 插件内部 void init 建表：等 session_log 可用再开始
    await waitReady(() => ctx.sessionLog.lease('sess-probe'), 'session_log 表')
    await fn(ctx, pg)
  } finally {
    // 跑 effect 收尾：断热层连接、清续租定时器、关主连接池
    await ctx.fiber.dispose()
    await pg.close()
  }
}

/** 走事件线发一条会话事件（session/event → PG append → 写后透传镜像）。 */
function emitEvent(ctx: Context, sessionRef: string, seq: number): void {
  ctx.emit('session/event', { id: sessionRef }, { seq, type: 'user_message', time: 1_700_000_000_000 + seq })
}

/** 就绪探测：容忍「关系不存在」直到建表完成（冒烟同法）。 */
async function waitReady(probe: () => Promise<unknown>, desc: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      await probe()
      return
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!msg.includes('does not exist') && !msg.includes('relation')) throw error
      await sleep(50)
    }
  }
  throw new Error(`就绪超时：${desc}`)
}

/** 有界轮询（写透传 mirror 是 fire-and-forget，落盘时刻只能探测不能等句柄）。 */
async function poll<T>(
  probe: () => Promise<T | undefined>,
  done: (value: T) => boolean,
  desc: string,
): Promise<T> {
  let last: T | undefined
  for (let i = 0; i < 200; i++) {
    last = await probe()
    if (last !== undefined && done(last)) return last
    await sleep(50)
  }
  throw new Error(`轮询超时：${desc}（最后结果 ${JSON.stringify(last)})`)
}

describe(`热层 —— 对真 PG+Redis（需 SESSION_LOG_TEST_DSN，当前${suffix}）`, () => {
  t('mirror 后 read 与 PG read 逐字段相等、head 正确、seq 连续升序', async () => {
    const sessionRef = sessionOf('eq')
    await withLog(async (log) => {
      await log.acquire(sessionRef, 'node-a', 60_000)
      // 乱序写 PG（read 按 seq 出）；镜像按 seq 序投递（与插件队列一致）
      for (const seq of [3, 1, 2]) await log.append(recordOf(sessionRef, seq), 1)
      await withHot({}, async (hot) => {
        for (const seq of [1, 2, 3]) await hot.mirror(recordOf(sessionRef, seq))
        const got = await hot.read(sessionRef, 1)
        const fromPg = await log.read(sessionRef, 1)
        expect(got).toEqual(fromPg) // 逐字段（sessionRef/seq/type/payload/time）
        expect(got!.map((r) => r.seq)).toEqual([1, 2, 3]) // seq 连续升序
        const head = await hot.head(sessionRef)
        expect(head).toEqual({ seq: 3, time: 1_700_000_000_003 })
        // 窗口内从中间读：覆盖即裁剪
        expect((await hot.read(sessionRef, 2))!.map((r) => r.seq)).toEqual([2, 3])
      })
    })
  })

  t('窗口未覆盖回退：fromSeq=0 与 fromSeq=lastSeq+1 → undefined（回 PG）', async () => {
    const sessionRef = sessionOf('nocov')
    await withHot({}, async (hot) => {
      for (const seq of [5, 6, 7]) await hot.mirror(recordOf(sessionRef, seq))
      expect(await hot.read(sessionRef, 0)).toBeUndefined() // 0 < firstSeq=5
      expect(await hot.read(sessionRef, 8)).toBeUndefined() // lastSeq+1：缓存写落后于 PG 的瞬时窗口
      expect((await hot.read(sessionRef, 5))!.map((r) => r.seq)).toEqual([5, 6, 7])
      expect((await hot.read(sessionRef, 6))!.map((r) => r.seq)).toEqual([6, 7])
      // 无缓存会话：read/head 都 undefined
      const nokey = sessionOf('nokey')
      expect(await hot.read(nokey, 0)).toBeUndefined()
      expect(await hot.head(nokey)).toBeUndefined()
    })
  })

  t('duplicate 重投不重复镜像（LIST 长度 == 唯一 seq 数）——走插件事件线', async () => {
    const sessionRef = sessionOf('dup')
    await withAssembly({ url: REDIS, realm: REALM }, async (ctx, pg) => {
      const hot = ctx.sessionLogHot
      if (!hot) throw new Error('sessionLogHot 未装配')
      emitEvent(ctx, sessionRef, 1)
      emitEvent(ctx, sessionRef, 2)
      emitEvent(ctx, sessionRef, 2) // 至少一次投递的重投：PG 幂等吸收，热层不得再镜像
      emitEvent(ctx, sessionRef, 3)
      // 队列串行 ⇒ seq3 的镜像必在重投处理之后。若重投被错误镜像，窗口变成 [1,2,2,3]
      // 非连续 → read 永远 undefined → 轮询超时失败（而非假绿）。
      const got = await poll(
        () => hot.read(sessionRef, 1),
        (rows) => rows.length === 3,
        '热层窗口出现 [1,2,3]',
      )
      expect(got.map((r) => r.seq)).toEqual([1, 2, 3])
      // PG 真源也只有 3 行（重投被幂等吸收，未新增行）
      expect((await pg.read(sessionRef)).map((r) => r.seq)).toEqual([1, 2, 3])
    })
  })

  t('MAXLEN 裁剪：read(fromSeq=0) 变 undefined、head 仍对、窗口连续性保持', async () => {
    const sessionRef = sessionOf('trim')
    await withHot({ maxLen: 3 }, async (hot) => {
      for (const seq of [1, 2, 3, 4, 5]) await hot.mirror(recordOf(sessionRef, seq))
      // 裁剪后窗口 = [3,4,5]：fromSeq 在窗口之前 → 未覆盖
      expect(await hot.read(sessionRef, 0)).toBeUndefined()
      expect(await hot.read(sessionRef, 1)).toBeUndefined()
      // head 仍是最新一条（LINDEX -1 不受裁剪影响）
      expect(await hot.head(sessionRef)).toEqual({ seq: 5, time: 1_700_000_000_005 })
      // 窗口内从任意点读：连续升序
      expect((await hot.read(sessionRef, 3))!.map((r) => r.seq)).toEqual([3, 4, 5])
      expect((await hot.read(sessionRef, 5))!.map((r) => r.seq)).toEqual([5])
      expect(await hot.read(sessionRef, 6)).toBeUndefined()
    })
  })

  t('TTL 过期：read 回退（undefined）、head 无缓存', async () => {
    const sessionRef = sessionOf('ttl')
    await withHot({ ttlMs: 300 }, async (hot) => {
      await hot.mirror(recordOf(sessionRef, 1))
      await hot.mirror(recordOf(sessionRef, 2))
      expect((await hot.read(sessionRef, 1))!.map((r) => r.seq)).toEqual([1, 2])
      expect(await hot.head(sessionRef)).toBeDefined()
      await sleep(800) // 超过 ttl：键逻辑过期，任何访问视为不存在
      expect(await hot.read(sessionRef, 1)).toBeUndefined()
      expect(await hot.head(sessionRef)).toBeUndefined()
    })
  })

  t('fail-open 前提：坏端口镜像快速拒绝（不挂默认重试的 ~10s）', async () => {
    await withHot({ url: 'redis://127.0.0.1:16399' }, async (hot) => {
      const t0 = Date.now()
      await expect(hot.mirror(recordOf(sessionOf('bad'), 1))).rejects.toThrow()
      expect(Date.now() - t0).toBeLessThan(5_000)
    })
  })

  t('fail-open：坏端口下 adapter 读回退 PG、写路径照常、绝不 fence', async () => {
    const sessionRef = sessionOf('failopen')
    await withAssembly({ url: 'redis://127.0.0.1:16399', realm: REALM }, async (ctx, pg) => {
      emitEvent(ctx, sessionRef, 1)
      emitEvent(ctx, sessionRef, 2)
      // mirror 双双失败（只 warn）；adapter 读路径回退 PG 拿全量
      const rows = await poll(
        () => ctx.sessionLog.read(sessionRef, 1),
        (got) => got.length === 2,
        'adapter read 经 PG 回退拿到 2 条',
      )
      expect(rows.map((r) => r.seq)).toEqual([1, 2])
      // 无 fence：会话未被急停——继续发事件仍能追加（被 fence 的事件会被直接丢弃）
      emitEvent(ctx, sessionRef, 3)
      await poll(
        () => pg.read(sessionRef, 1),
        (got) => got.length === 3,
        'PG 真相源拿到 3 条（会话未被 fence）',
      )
    })
  })
})

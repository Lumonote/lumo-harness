import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import type { LogRecord } from '../../../shared/seam-contracts/session-log.ts'
import { FencedOutError } from '../../../shared/seam-contracts/session-log.ts'
import { queueBackfill, type QueueBackfillDeps } from '../src/backfill.ts'
import { apply } from '../src/index.ts'
import { PgSessionLog } from '../src/pg-log.ts'
import { schemaDsn } from './pg-schema.ts'

/**
 * 构造期事件回填(终审 I1)对**真 PG** 跑 + 队列/令牌/错误形状的纯单测(恒跑)。
 *
 * 真 PG 部分用一个**真 dsh SessionStore** 走两条真实创建路径:
 *   - `store.create(id, { seed })`:种子事件经 Session 构造器进入 events,从不发布到
 *     `session/event`(constructor seeds do not emit);构造函数还会补
 *     `session/end-seed` 标记——都是「构造期事件」的活样本。
 *   - `prepare` → 构造窗口 append → `enter` + `announce`:承载/child 会话的真实
 *     setup 窗口形状(attach 前的 append 不发布),created 于 announce 时发出。
 *
 * 断言的是「复制日志完整性」:构造期行全部落库、(session,seq) 幂等一下二次回填
 * 不增产、与 post-attach firehose 事件共存时 seq 连续无隙无重复、他人持租时回填
 * 不写不抢权。
 *
 * 无 DSN 时真 PG 部分整组 **skip 且可见**(与既有 spec 同纪律);队列/错误形状
 * 单测不需要库,**恒跑**。
 */
const DSN = process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
const t = DSN ? it : it.skip
const suffix = DSN ? '已设置' : '未设置 → 跳过，非通过'

const BASE_TIME = 1_700_000_000_000

/** 种子/单测共用的 Mini 事件(非 surface 类型,turn 词表来自 dsh-session 自身声明)。 */
function eventOf(seq: number, type: 'turn/start' | 'step/start' = 'turn/start'): SessionEvent {
  return type === 'turn/start'
    ? { type, seq, time: BASE_TIME + seq, data: { turn: seq + 1 } }
    : { type, seq, time: BASE_TIME + seq, data: { turn: seq + 1, step: 1 } }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 有界轮询(回填与 firehose 都是队列异步落库,时刻只能探测不能等句柄)。 */
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

/** 工具服务桩:占住插件 inject 槽(hot-log.spec 同法)。 */
class ToolsStub extends Service {
  constructor(ctx: Context) {
    super(ctx)
  }
}

/** 就绪探测:容忍「关系不存在」直到建表完成(hot-log.spec 同法)。 */
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

/** 每个测试拿独立 schema(TRUNCATE 互不干扰,理由见 pg-schema.ts 注释)。 */
async function withBoot(
  fn: (ctx: Context, store: SessionStore, pg: PgSessionLog) => Promise<void>,
): Promise<void> {
  const dsn = await schemaDsn(DSN!, 'session_log_backfill_test')
  const pg = new PgSessionLog(dsn)
  await pg.init()
  await pg.raw('TRUNCATE session_log, session_writer_lease')
  const ctx = new Context()
  ctx.provide('tools', new ToolsStub(ctx))
  await ctx.plugin(SessionStore)
  // 先装插件再 create:created 监听必须在创建之前注册(本插件挂 created/event/disposed)
  apply(ctx, {
    connectionString: dsn,
    holder: 'backfill-test-node',
    leaseTtlMs: 30_000,
  })
  try {
    await waitReady(() => ctx.sessionLog.lease('sess-probe'), 'session_log 表')
    await fn(ctx, ctx.sessions, pg)
  } finally {
    await ctx.fiber.dispose()
    await pg.close()
  }
}

/* -------------------------------------------------------------------------- */
/* 队列/令牌/错误形状 —— 恒跑(桩注入,无 IO)                                  */
/* -------------------------------------------------------------------------- */

interface Stub {
  tails: Map<string, Promise<void>>
  appended: Array<{ record: LogRecord; token: number }>
  mirrored: LogRecord[]
  errors: string[]
}

function stubDeps(over: Partial<QueueBackfillDeps> = {}): { deps: QueueBackfillDeps; s: Stub } {
  const s: Stub = { tails: new Map(), appended: [], mirrored: [], errors: [] }
  const deps: QueueBackfillDeps = {
    tails: s.tails,
    isFenced: () => false,
    ensureToken: async () => 7,
    append: async (record, token) => {
      s.appended.push({ record, token })
      return { status: 'appended', seq: record.seq } as const
    },
    onMirror: (record) => s.mirrored.push(record),
    logger: {
      error: (format: string, ...params: unknown[]) => {
        let i = 0
        s.errors.push(format.replace(/%[sd]/g, () => String(params[i++])))
      },
    },
    ...over,
  }
  return { deps, s }
}

describe('回填单元 —— queueBackfill 的队列/令牌/错误形状(恒跑,无 IO)', () => {
  it('已 fence → 跳过任务,不 append、不镜像', async () => {
    const { deps, s } = stubDeps({ isFenced: () => true })
    queueBackfill('u-fenced', [eventOf(0), eventOf(1)], deps)
    await s.tails.get('u-fenced')
    expect(s.appended).toHaveLength(0)
    expect(s.mirrored).toHaveLength(0)
  })

  it('他人持租(ensureToken=undefined)→ 不动手:不 append、不 fence 信号、任务完成', async () => {
    const { deps, s } = stubDeps({ ensureToken: async () => undefined })
    queueBackfill('u-held', [eventOf(0)], deps)
    await s.tails.get('u-held')
    expect(s.appended).toHaveLength(0)
    expect(s.errors.length).toBe(1) // 只 journal(回填跳过);无 fence 出口 ≈ 幂等
  })

  it('逐条 append;appended → 镜像完整记录;duplicate → 不镜像', async () => {
    const { deps, s } = stubDeps({
      append: async (record, token) => {
        s.appended.push({ record, token })
        return record.seq === 1 ? { status: 'duplicate', seq: 1 } : ({ status: 'appended', seq: record.seq } as const)
      },
    })
    const events = [eventOf(0, 'turn/start'), eventOf(1, 'step/start')]
    queueBackfill('u-dupe', events, deps)
    await s.tails.get('u-dupe')
    expect(s.appended.map((a) => a.record.seq)).toEqual([0, 1])
    expect(s.appended.every((a) => a.token === 7)).toBe(true)
    expect(s.mirrored.map((r) => r.seq)).toEqual([0])
    // 记录构造照 firehose:sessionRef/seq/type/payload:event/time
    const first = s.appended[0]!.record
    expect(first.sessionRef).toBe('u-dupe')
    expect(first.type).toBe('turn/start')
    expect(first.payload).toEqual(events[0])
    expect(first.time).toBe(events[0]!.time)
  })

  it('瞬时错误(append 抛 generic)→ 只 error 日志、不 fence 不抛,后续条继续', async () => {
    const { deps, s } = stubDeps({
      append: async (record) => {
        s.appended.push({ record, token: 7 })
        if (record.seq === 1) throw new Error('network down')
        return { status: 'appended', seq: record.seq } as const
      },
    })
    queueBackfill('u-err', [eventOf(0), eventOf(1), eventOf(2)], deps)
    await s.tails.get('u-err')
    expect(s.appended.map((a) => a.record.seq)).toEqual([0, 1, 2])
    expect(s.errors.length).toBe(1)
    expect(s.errors[0]).toContain('seq=1')
  })

  it('FencedOutError → 中止本批(后面不再逐条必错),只日志不 fence', async () => {
    const { deps, s } = stubDeps({
      append: async (record) => {
        s.appended.push({ record, token: 7 })
        if (record.seq === 1) throw new FencedOutError('u-fence', 7, 8)
        return { status: 'appended', seq: record.seq } as const
      },
    })
    queueBackfill('u-fence', [eventOf(0), eventOf(1), eventOf(2)], deps)
    await s.tails.get('u-fence')
    expect(s.appended.map((a) => a.record.seq)).toEqual([0, 1])
    expect(s.errors.length).toBe(1)
    expect(s.errors[0]).toContain('已失效')
  })

  it('串行:同会话两次 queueBackfill,append 顺序 = 入队顺序(与 firehose 共队列)', async () => {
    const { deps, s } = stubDeps()
    queueBackfill('u-order', [eventOf(0)], deps)
    queueBackfill('u-order', [eventOf(1)], deps)
    await s.tails.get('u-order')
    expect(s.appended.map((a) => a.record.seq)).toEqual([0, 1])
  })
})

/* -------------------------------------------------------------------------- */
/* 对真 PG —— 构造期回填的语义                                                */
/* -------------------------------------------------------------------------- */

describe(`回填 —— 对真 PG（需 SESSION_LOG_TEST_DSN，当前${suffix}）`, () => {
  t('构造期事件落库：store.create(seed) —— 种子 + 构造器补的 end-seed 全进 PG', async () => {
    await withBoot(async (ctx, store, pg) => {
      const session = store.create(SessionId('bf-seed-1'), {
        seed: [eventOf(0), eventOf(1, 'step/start'), eventOf(2)],
      })
      // 构造期样本：3 种子(seq 0-2)+ 构造器补的 session/end-seed(seq 3)= 4 条,
      // 全部只进 events、无一发布到 session/event
      expect(session.events.map((e) => e.type)).toEqual(['turn/start', 'step/start', 'turn/start', 'session/end-seed'])
      const rows = await poll(
        () => pg.read(String(session.id)),
        (got) => got.length === 4,
        '构造期 4 条落库',
      )
      expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3])
      expect(rows.map((r) => r.type)).toEqual(['turn/start', 'step/start', 'turn/start', 'session/end-seed'])
      // payload 为事件全文(与 firehose 写路径同一构造):seq/time/type/data 保真
      expect(rows[0]!.payload).toEqual({
        type: 'turn/start', seq: 0, time: BASE_TIME, data: { turn: 1 },
      })
    })
  })

  t('构造窗口 append（prepare → append → enter → announce 的真实 setup 窗口）', async () => {
    await withBoot(async (ctx, store, pg) => {
      const session = store.prepare(SessionId('bf-window'))
      // attach 前的 append：无 store 条目 → 不发布到 session/event
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 1 })
      const detach = store.enter(session)
      store.announce(session) // created 于此处发出 → 回填
      const rows = await poll(
        () => pg.read('bf-window'),
        (got) => got.length === 2,
        '构造窗口 2 条落库',
      )
      expect(rows.map((r) => r.seq)).toEqual([0, 1])
      expect(rows.map((r) => r.type)).toEqual(['turn/start', 'step/start'])
      detach()
    })
  })

  t('幂等：二次 created 回填(或重投)不增产 —— (session,seq) 主键吸收', async () => {
    await withBoot(async (ctx, store, pg) => {
      const session = store.create(SessionId('bf-idempotent'), {
        seed: [eventOf(0), eventOf(1)],
      })
      await poll(
        () => pg.read('bf-idempotent'),
        (got) => got.length === 3, // 2 种子 + end-seed
        '首轮回填 3 条落库',
      )
      // 同会话二次 created 回填(真实监听路径)——全部 duplicate,行数不变
      ctx.emit('session/created', session)
      await sleep(400)
      expect((await pg.read('bf-idempotent'))).toHaveLength(3)
    })
  })

  t('共存：回填 + post-attach firehose 事件 → seq 连续无隙无重复', async () => {
    await withBoot(async (ctx, store, pg) => {
      const session = store.create(SessionId('bf-mix'), {
        seed: [eventOf(0), eventOf(1, 'step/start')],
      })
      // 回填尚未落库时,后到事件已进 firehose 队列——两路最终都写、谁也不覆盖谁
      session.append('turn/start', { turn: 2 })
      session.append('step/start', { turn: 2, step: 2 })
      const rows = await poll(
        () => pg.read('bf-mix'),
        (got) => got.length === 5, // 2 种子 + end-seed + 2 firehose
        '回填+firehose 共 5 条',
      )
      expect(rows.map((r) => r.seq)).toEqual([0, 1, 2, 3, 4])
      expect(rows.map((r) => r.type)).toEqual([
        'turn/start', 'step/start', 'session/end-seed', 'turn/start', 'step/start',
      ])
    })
  })

  t('他人持租 → 回填不写、不抢权(租约保持他人持有)', async () => {
    await withBoot(async (ctx, store, pg) => {
      const other = new PgSessionLog(await schemaDsn(DSN!, 'session_log_backfill_test'))
      await other.init()
      await other.acquire('bf-held', 'other-node', 60_000)
      store.create(SessionId('bf-held'), { seed: [eventOf(0), eventOf(1)] })
      await sleep(400) // 队列任务完成窗口
      expect(await pg.read('bf-held')).toHaveLength(0)
      const lease = await pg.lease('bf-held')
      expect(lease?.holder).toBe('other-node') // 未抢权:他人租约原样
      await other.close()
    })
  })
})

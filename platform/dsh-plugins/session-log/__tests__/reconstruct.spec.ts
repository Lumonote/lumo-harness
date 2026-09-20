import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/**
 * 跨节点会话重建：**能不能把一份复制来的日志当历史，在另一个进程里把会话立起来并继续**。
 *
 * ## 这个实验为什么存在
 *
 * `remotability.ts` 把 `ctx.sessionPersistence` 定级为 `needs-design`，判据是
 * 「跨节点问题是**复制与一致性**，不是调用转发」，归属「复制式 SessionEvent 日志」——即平台
 * **刻意不**把持久化句柄过网。于是跨节点续跑的唯一正解是从复制日志**重建**，而这条路此前
 * 没有任何人验过：`resumeSessionId` 在全平台零命中，`ctx.sessions.create(id, {seed})` 只在
 * 测试里用来演示「构造期事件回填」，从没被当作恢复手段。
 *
 * 本仓的教训（E7b）是：判一条跨层链路通不通，必须沿**声明 → 写入 → 持久化 → 重载**四段走完。
 * 这里补的是**第四段 —— 日志重新变成活会话**。
 *
 * ## 实验过程中被推翻的两个写法（都留下了痕迹，因为它们看起来都对）
 *
 * 1. **第一版断言「重建出来的日志与原来逐条相同」。** 它红了，但**不是实现错**：dsh 的
 *    `Session` 构造函数在「传了 seed 且日志末尾不是 end-seed」时补一条 `session/end-seed`
 *    （`core/session/src/index.ts:617`）。而 dsh 对这条路径的说明正是
 *    「**a resumed session's constructor seed is its full stored log**」——末尾补标记是设计，
 *    不是损坏。**错的断言，不是错的实现。**
 * 2. **第一版用 `create(id, { seed })` 而不知道它与恢复的关系**，于是把「恢复」与「fork」
 *    当成两件需要区分的事。实际差别不在标记（两种 mode 都会补），而在 `firstLiveSeq` /
 *    `inheritedEventCount` 落在哪里——本文件不断言那条差别，因为它是**进程内构造事实**，
 *    恢复方真正要读的是日志本身。
 *
 * 留下来的断言因此只针对**可观测且被文档化的行为**：原事件逐条保留、标记补在哪、能否继续。
 */

const BASE_TIME = 1_700_000_000_000

function eventOf(seq: number, type: 'turn/start' | 'step/start' = 'turn/start'): SessionEvent {
  return type === 'turn/start'
    ? { type, seq, time: BASE_TIME + seq, data: { turn: seq + 1 } }
    : { type, seq, time: BASE_TIME + seq, data: { turn: seq + 1, step: 1 } }
}

/** 起一个独立的 dsh 会话容器——两个容器之间不共享任何对象，模拟两个进程。 */
async function boot(): Promise<{ ctx: Context; dispose: () => Promise<void> }> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  return { ctx, dispose: async () => { await ctx.fiber.dispose() } }
}

/** 造一份「原节点上跑过一段」的日志——模拟复制日志里那一行行记录。 */
async function originalLog(): Promise<{ log: readonly SessionEvent[]; createdAt: number }> {
  const { ctx, dispose } = await boot()
  try {
    const session = ctx.sessions.create(SessionId('sess-original'), { seed: [eventOf(0), eventOf(1, 'step/start')] })
    session.append('turn/start', { turn: 3 } as never)
    const header = (session as unknown as { header: { createdAt: number } }).header
    return { log: session.snapshotEvents(), createdAt: header.createdAt }
  } finally { await dispose() }
}

/**
 * 按复制日志重建（**收养**路径：`eventState: 'detached'` 走 `Session.fromRestore`）。
 *
 * header 不是日志的一部分，必须由重建方提供。`createdAt` 取**首个事件的时间**而不是
 * `Date.now()`：后者不会报错，只会让一个三天前的会话显示成刚创建。
 */
function restore(ctx: Context, id: string, log: readonly SessionEvent[], formatVersion: number) {
  return ctx.sessions.create(SessionId(id), {
    seed: [...log],
    meta: { version: formatVersion, id, createdAt: log[0]!.time, isSeeded: false },
    eventState: 'detached',
  } as never)
}

async function formatVersionOf(ctx: Context): Promise<number> {
  const probe = ctx.sessions.create(SessionId(`probe-${Math.random().toString(36).slice(2)}`))
  return (probe as unknown as { header: { version: number } }).header.version
}

describe('跨节点会话重建', () => {
  it('复制来的日志逐条保留：类型与 seq 原样成为重建会话的历史前缀', async () => {
    const { log } = await originalLog()
    const { ctx, dispose } = await boot()
    try {
      const rebuilt = restore(ctx, 'sess-original', log, await formatVersionOf(ctx))
      // 前缀逐条比对。只断言「长度接近」是不够的：长度对而顺序错、或 seq 被重新编号，
      // 都是内容有损，而它们在一次连接里和正常会话长得一样。
      expect(rebuilt.snapshotEvents().map(e => [e.type, e.seq]).slice(0, log.length))
        .toEqual(log.map(e => [e.type, e.seq]))
    } finally { await dispose() }
  })

  it('重建会在末尾补一条 session/end-seed —— 这是 dsh 的设计，不是损坏', async () => {
    const { log } = await originalLog()
    const { ctx, dispose } = await boot()
    try {
      const rebuilt = restore(ctx, 'sess-marker', log, await formatVersionOf(ctx))
      const events = rebuilt.snapshotEvents()
      // 补标记的判据（core/session/src/index.ts:617）：传了 seed 且**日志末尾不是
      // end-seed** 时补一条。原日志末尾是后来的 turn/start，所以这里必然补。
      expect(events.length).toBe(log.length + 1)
      expect(events.at(-1)!.type).toBe('session/end-seed')
      // 补的这条是**普通标记**（不是 inherited:true）——后者只在「带种子的 fork」分支。
      expect((events.at(-1)!.data as { inherited?: boolean }).inherited).toBeUndefined()
    } finally { await dispose() }
  })

  it('重建出来的会话可以继续追加，新事件落在标记之后', async () => {
    const { log } = await originalLog()
    const { ctx, dispose } = await boot()
    try {
      const rebuilt = restore(ctx, 'sess-continue', log, await formatVersionOf(ctx))
      const before = rebuilt.snapshotEvents().length
      const appended = rebuilt.append('turn/start', { turn: 9 } as never)
      // 「能追加」是重建有意义的分水岭：只读地还原一份日志谁都能做，而续跑要求这是一个
      // **活的**、seq 连续的 dsh 会话。
      expect(appended.seq).toBe(before)
      expect(rebuilt.snapshotEvents().length).toBe(before + 1)
      expect(rebuilt.snapshotEvents().at(-1)!.type).toBe('turn/start')
    } finally { await dispose() }
  })

  it('原容器销毁后照样成立 —— 重建不依赖任何进程内对象', async () => {
    const { ctx: source, dispose: disposeSource } = await boot()
    let log: readonly SessionEvent[]
    try {
      const session = source.sessions.create(SessionId('sess-die'), { seed: [eventOf(0)] })
      session.append('turn/start', { turn: 2 } as never)
      log = session.snapshotEvents()
    } finally { await disposeSource() }

    const { ctx, dispose } = await boot()
    try {
      const rebuilt = restore(ctx, 'sess-die', log, await formatVersionOf(ctx))
      expect(rebuilt.snapshotEvents().map(e => e.seq).slice(0, log.length))
        .toEqual(log.map(e => e.seq))
    } finally { await dispose() }
  })

  // header 不在日志里，而 `createdAt` 是「会话创建时刻」，与**首个事件的时间**是两回事
  // （原会话里前者是建会话时的墙钟，后者是种子事件自带的时间）。所以重建**无法还原**它，
  // 只能近似。这条把损失写下来，因为它的失败模式是静默的：拿 `Date.now()` 顶上去不报错，
  // 只让一个三天前的会话显示成刚创建。
  it('createdAt 无法从日志还原，只能用首个事件时间近似', async () => {
    const { log, createdAt } = await originalLog()
    const { ctx, dispose } = await boot()
    try {
      const rebuilt = restore(ctx, 'sess-header', log, await formatVersionOf(ctx))
      const header = (rebuilt as unknown as { header: { createdAt: number } }).header
      expect(header.createdAt).toBe(log[0]!.time)   // 重建方能拿到的最好近似
      expect(header.createdAt).not.toBe(createdAt)  // 而它不是原值：header 从不进日志
    } finally { await dispose() }
  })
})

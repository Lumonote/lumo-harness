import { describe, expect, it } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

import { PgSessionLog } from '../src/pg-log.ts'
import { apply } from '../src/index.ts'
import { deriveHeader, restoreSession, type RestoreLogRead } from '../src/restore.ts'
import { schemaDsn, truncateSessionLog } from './pg-schema.ts'

/**
 * 从**复制日志**重建活会话，对真 PG 跑。
 *
 * 这条链的意义：平台刻意不把 `ctx.sessionPersistence` 过网（`remotability.ts` 定级
 * `needs-design`），所以跨节点续跑只能「读复制日志 → 在本地把会话立起来」。本文件验的是
 * 端到端的那一步，而不是重建函数本身能不能跑——**节点 A 死掉、节点 B 从库里把它立回来**。
 *
 * 与 `reconstruct.spec.ts` 的分工：那个用纯内存证明「dsh 的收养路径成立」（四段验证的
 * 第四段），这个证明「那份日志真的是从 PG 里读出来的、且能直接喂进那条路径」。
 * **两个都要**：只有前者是没接线的形状，只有后者则不知道形状对不对。
 *
 * 无 DSN 时整组 **skip 且可见**（与既有 spec 同纪律）。
 */
const DSN = process.env['SESSION_LOG_TEST_DSN'] ?? process.env['METERING_TEST_DSN']
const t = DSN ? it : it.skip
const suffix = DSN ? '已设置' : '未设置 → 跳过，非通过'

const BASE_TIME = 1_700_000_000_000
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

class ToolsStub extends Service {
  constructor(ctx: Context) {
    super(ctx)
  }
}

/** 就绪探测：容忍「关系不存在」直到建表完成。 */
async function waitReady(probe: () => Promise<unknown>, desc: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try { await probe(); return } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error)
      if (!msg.includes('does not exist') && !msg.includes('relation')) throw error
      await sleep(50)
    }
  }
  throw new Error(`就绪超时：${desc}`)
}

/** 有界轮询：复制是队列异步落库，时刻只能探测不能等句柄。 */
async function poll<T>(probe: () => Promise<T>, done: (value: T) => boolean, desc: string): Promise<T> {
  let last: T | undefined
  for (let i = 0; i < 200; i++) {
    last = await probe()
    if (done(last)) return last
    await sleep(50)
  }
  throw new Error(`轮询超时：${desc}（最后结果 ${JSON.stringify(last)}）`)
}

function eventOf(seq: number, type: 'turn/start' | 'step/start' = 'turn/start'): SessionEvent {
  return type === 'turn/start'
    ? { type, seq, time: BASE_TIME + seq, data: { turn: seq + 1 } }
    : { type, seq, time: BASE_TIME + seq, data: { turn: seq + 1, step: 1 } }
}

/**
 * 清库。**必须做，且必须做在「起节点」之前**：schema 是固定命名复用的（`pg-schema.ts`
 * 刻意不 DROP），所以上一次跑留下的行会变成这一次的输入。
 *
 * 这不是理论风险：本文件第一次跑时「空日志」那条红了，库里的 `no-such-session` 真有 2 条——
 * 它们是**上一轮反向验证**留下的。当时我把空日志守卫去掉，看那条断言会不会红；它确实红了，
 * 但伪造出来的会话经 `announce` 触发了本插件的复制，**假事件就此进了持久日志**。
 * 于是下一轮跑时，一个「不存在的会话」在库里有了历史。清库把现场还原，但那条经验留在下面
 * 那条用例里：伪造的代价不只是内存里多一个对象，而是它会被复制成事实。
 */
async function resetSchema(pg: PgSessionLog): Promise<void> {
  await truncateSessionLog((sql) => pg.raw(sql))
}

/** 起一个**节点**：真 ctx + 真 SessionStore + 接上真 PG 的复制插件。 */
async function bootNode(schema: string, holder: string) {
  const dsn = await schemaDsn(DSN!, schema)
  const pg = new PgSessionLog(dsn)
  await pg.init()
  const ctx = new Context()
  ctx.provide('tools', new ToolsStub(ctx))
  await ctx.plugin(SessionStore)
  apply(ctx, { connectionString: dsn, holder, leaseTtlMs: 30_000 })
  await waitReady(() => ctx.sessionLog.lease('restore-probe'), 'session_log 表')
  return {
    ctx,
    pg,
    /** 模拟节点死掉：把 ctx 拆干净（连接、租约、内存里的会话一并消失）。 */
    kill: async () => { await ctx.fiber.dispose(); await pg.close() },
  }
}

describe(`从复制日志重建 —— 对真 PG（需 SESSION_LOG_TEST_DSN，当前${suffix}）`, () => {
  t('节点 A 写下日志并死掉，节点 B 从库里把会话立起来并继续', async () => {
    const schema = 'session_log_restore_test'
    const ref = 'restore-e2e-1'

    // ---- 节点 A：跑一段真实历史 ----
    const a = await bootNode(schema, 'node-a')
    let expected: readonly SessionEvent[]
    try {
      await resetSchema(a.pg)
      const session = a.ctx.sessions.create(SessionId(ref), { seed: [eventOf(0), eventOf(1, 'step/start')] })
      session.append('turn/start', { turn: 3 } as never)
      expected = session.snapshotEvents()
      // 复制是队列异步的：等它真的落库再「杀」这个节点，否则验的不是重建而是竞态。
      await poll(() => a.pg.read(ref), rows => rows.length === expected.length, '日志落库')
    } finally {
      await a.kill()
    }

    // ---- 节点 B：进程是新的，内存里什么都没有 ----
    const b = await bootNode(schema, 'node-b')
    try {
      expect(b.ctx.sessions.get(SessionId(ref))).toBeUndefined()

      const restored = await restoreSession(b.ctx, b.pg, ref)
      expect(restored).toBeDefined()
      // 收养计数**不含** dsh 在末尾补的那条标记。
      expect(restored!.restored).toBe(expected.length)

      // 原事件逐条成为重建会话的历史前缀。只比长度不够——长度对而顺序错、或 seq 被重编号，
      // 都是内容有损，而它们在一次连接里和正常会话长得一样。
      expect(restored!.session.snapshotEvents().map(e => [e.type, e.seq]).slice(0, expected.length))
        .toEqual(expected.map(e => [e.type, e.seq]))

      // 「能继续」才是重建有意义的分水岭：只读地还原一份日志谁都能做。
      const before = restored!.session.snapshotEvents().length
      const appended = restored!.session.append('turn/start', { turn: 9 } as never)
      expect(appended.seq).toBe(before)
      expect(restored!.session.snapshotEvents().length).toBe(before + 1)

      restored!.detach()
    } finally { await b.kill() }
  })

  t('日志里没有事件时不伪造空会话 —— 伪造出来的会被复制成事实', async () => {
    const b = await bootNode('session_log_restore_test', 'node-empty')
    try {
      await resetSchema(b.pg)
      // 空会话与「这个会话本来什么都没发生过」在运维面上长得一样，而后者会让人以为
      // 恢复成功了——所以这里必须是「没有可恢复的东西」，不是「恢复成了一个空会话」。
      expect(await restoreSession(b.ctx, b.pg, 'no-such-session')).toBeUndefined()
      expect(b.ctx.sessions.get(SessionId('no-such-session'))).toBeUndefined()

      // 这一条是**反向验证换来的**：把上面那行守卫去掉之后，伪造的会话经 `announce`
      // 触发了本插件的复制，假事件**进了持久日志**。所以这条断言不只是「返回值是
      // undefined」，而是「库里仍然一条都没有」——伪造的代价不止内存里多一个对象。
      expect(await b.pg.read('no-such-session')).toEqual([])
    } finally { await b.kill() }
  })

  t('日志有洞时响亮失败，而不是拼一份看起来连续的日志', async () => {
    const b = await bootNode('session_log_restore_test', 'node-hole')
    try {
      const holey: RestoreLogRead = {
        read: async () => ([
          { sessionRef: 'holey', seq: 0, type: 'turn/start', payload: eventOf(0), time: BASE_TIME },
          // seq 1 丢了
          { sessionRef: 'holey', seq: 2, type: 'turn/start', payload: eventOf(2), time: BASE_TIME + 2 },
        ]),
      }
      await expect(restoreSession(b.ctx, holey, 'holey')).rejects.toThrow(/断裂/)
    } finally { await b.kill() }
  })
})

describe('deriveHeader 的反推规则', () => {
  // 这是本模块唯一一处**推断**（header 不在日志里，只能从标记反推），所以单独钉。
  it('没有 inherited 标记 = 不是 seeded、继承切点为 0', () => {
    const events = [eventOf(0), eventOf(1, 'step/start')]
    const { header, inheritedEventCount } = deriveHeader('s1', events)
    expect(header.isSeeded).toBe(false)
    expect(inheritedEventCount).toBe(0)
  })

  it('{inherited:true} 标记的 seq 就是继承切点', () => {
    const events = [
      eventOf(0),
      { type: 'session/end-seed', seq: 1, time: BASE_TIME + 1, data: { inherited: true } } as SessionEvent,
      eventOf(2),
    ]
    const { header, inheritedEventCount } = deriveHeader('s2', events)
    expect(header.isSeeded).toBe(true)
    expect(inheritedEventCount).toBe(1)
  })

  // 普通的末尾标记（`{}`，不带 inherited）**不是**继承切点。
  it('不带 inherited 的普通标记不算继承切点', () => {
    const events = [
      eventOf(0),
      { type: 'session/end-seed', seq: 1, time: BASE_TIME + 1, data: {} } as SessionEvent,
    ]
    const { header, inheritedEventCount } = deriveHeader('s3', events)
    expect(header.isSeeded).toBe(false)
    expect(inheritedEventCount).toBe(0)
  })

  // 这一条才是 `=== true` 相对真值判断买到的东西。
  //
  // 它是被**反向验证逼出来的**：第一版写的是「用真值判断会把 `{}` 也算进去」，而那条断言
  // 在把判据改成真值判断后**照样通过**——因为 `{}` 的 `inherited` 是 `undefined`，两种写法
  // 都判它假。也就是说那条测试当时是空转的，它证明不了自己钉住了任何东西。
  //
  // 真正会分叉的是**真值但非 `true`** 的值：字段类型是 `{inherited?: true}`，所以 `1`
  // 或 `"yes"` 是**我们不认识的形状**。真值判断会把它们读成「这是继承切点」，于是一个普通
  // 会话被重建成「继承了前缀的子会话」——递归预算被重置、谱系凭空多一层，而且没有任何报错。
  // 词表外的东西不许被解释成有意义的声明，与执行闸门「词表外一律 fail-closed」同一条规矩。
  it('inherited 只认严格 true：真值但非 true 的畸形标记不算继承切点', () => {
    for (const bogus of [1, 'yes', {}] as unknown[]) {
      const events = [
        eventOf(0),
        { type: 'session/end-seed', seq: 1, time: BASE_TIME + 1, data: { inherited: bogus } } as SessionEvent,
      ]
      const { header, inheritedEventCount } = deriveHeader('s6', events)
      expect(header.isSeeded).toBe(false)
      expect(inheritedEventCount).toBe(0)
    }
  })

  it('createdAt 取首个事件时间；hints 里的项按原样进 header，缺的留空不补默认值', () => {
    const events = [eventOf(0)]
    const bare = deriveHeader('s4', events)
    expect(bare.header.createdAt).toBe(events[0]!.time)
    expect(bare.header.delegationDepth).toBeUndefined()
    expect(bare.header.agentPreset).toBeUndefined()
    expect(bare.header.cwd).toBeUndefined()
    // 有 hint 就带上——它们决定了恢复出来的会话能不能被模型继续使用
    // （preset 决定工具与提示词，深度决定递归预算），所以不能凭默认值编一个。
    const hinted = deriveHeader('s5', events, { delegationDepth: 3, agentPreset: 'analyst', cwd: '/w', parentSession: 's0' })
    expect(hinted.header.delegationDepth).toBe(3)
    expect(hinted.header.agentPreset).toBe('analyst')
    expect(hinted.header.cwd).toBe('/w')
    expect(hinted.header.parentSession).toBe('s0')
  })
})

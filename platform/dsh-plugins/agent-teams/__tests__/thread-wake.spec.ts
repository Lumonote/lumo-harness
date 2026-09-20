/**
 * 唤醒接线（§8.1 的三条纪律）。
 *
 * 会合面用 `MemoryCourier`（单机兜底实现，语义与 `@lumo/mailbox` 对齐：TTL、首次兑现
 * 为准、先兑现后等待也能读到值、过期就地判定）——本用例验的是**使用纪律**，
 * 不是 mailbox 本身。
 */
import { describe, expect, it } from 'vitest'

import { MemoryCourier, type TeamCourier } from '../src/courier.ts'
import { DEFAULT_WAKE_TTL_MS, MAX_WAKE_TTL_MS, type ThreadRound, type ThreadRow } from '../src/thread.ts'
import { ThreadWaker, type ThreadWakeEntry } from '../src/thread-wake.ts'

const ROUND: ThreadRound = { task_id: 'task-7', attempt: 1 }

function row(id: string, state: ThreadRow['state'] = 'awaiting'): ThreadRow {
  return {
    id,
    realm: 'realm-1',
    project_id: 'proj-1',
    task_id: 'task-7',
    coordinator_session_ref: 'coord-1',
    session_ref: `sess-${id}`,
    node_id: 'node-a',
    workspace: `thread/${id}/`,
    state,
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
  }
}

function buildWaker(courier: TeamCourier = new MemoryCourier(), warn?: (message: string) => void): ThreadWaker {
  return new ThreadWaker({
    resolveCourier: () => courier,
    ...warn === undefined ? {} : { warn },
  })
}

/** 对账的输入形状：一条线程 + 它当前那一轮。 */
function entry(id: string, state: ThreadRow['state'] = 'awaiting'): ThreadWakeEntry {
  return { thread: row(id, state), round: ROUND }
}

describe('唤醒等待项（每条等待都带 TTL）', () => {
  it('arm 出来的等待项在通道上，状态是 pending', async () => {
    const waker = buildWaker()
    const armed = await waker.arm('t-1', ROUND)
    expect(armed.channel).toBe('thread/t-1/wake/1')
    expect(armed.ttlMs).toBe(DEFAULT_WAKE_TTL_MS)
    await expect(waker.state('t-1', ROUND)).resolves.toBe('pending')
  })

  it('TTL 被收敛到上限：不会出现「实质无限」的等待', async () => {
    const waker = buildWaker()
    const armed = await waker.arm('t-1', ROUND, MAX_WAKE_TTL_MS * 100)
    expect(armed.ttlMs).toBe(MAX_WAKE_TTL_MS)
    // 非法 TTL 取默认（有限值），不落进「无上限」。
    await expect(waker.arm('t-2', ROUND, Number.NaN)).resolves.toMatchObject({ ttlMs: DEFAULT_WAKE_TTL_MS })
    await expect(waker.arm('t-3', ROUND, 0)).resolves.toMatchObject({ ttlMs: DEFAULT_WAKE_TTL_MS })
  })

  it('兑现一次唤醒后读到 resolved；重复兑现按首次为准', async () => {
    const waker = buildWaker()
    await waker.arm('t-1', ROUND)
    await expect(waker.wake('t-1', ROUND, { reason: 'ci-green' })).resolves.toEqual({ status: 'settled' })
    await expect(waker.state('t-1', ROUND)).resolves.toBe('resolved')
    await expect(waker.wake('t-1', ROUND, { reason: 'another' })).resolves.toEqual({ status: 'already-settled' })
    await expect(waker.wait('t-1', ROUND, 10)).resolves.toEqual({ state: 'resolved', value: { reason: 'ci-green' } })
  })

  it('带错误兑现（这一轮不会再来了）', async () => {
    const waker = buildWaker()
    await waker.arm('t-1', ROUND)
    await expect(waker.abandon('t-1', ROUND, '上游任务被取消')).resolves.toEqual({ status: 'settled' })
    await expect(waker.wait('t-1', ROUND, 10)).resolves.toEqual({ state: 'rejected', error: '上游任务被取消' })
  })

  it('TTL 到期返回 expired（正常返回），且绝不再进一次等待', async () => {
    let now = 0
    const waker = buildWaker(new MemoryCourier(() => now))
    await waker.arm('t-1', ROUND, 1_000)
    now = 1_001
    const first = await waker.wait('t-1', ROUND, 10_000)
    expect(first.state).toBe('expired')
    // 第二次等待立刻拿到同一结论（等待项已就地过期），而不是又挂一轮。
    const second = await waker.wait('t-1', ROUND, 10_000)
    expect(second.state).toBe('expired')
    await expect(waker.state('t-1', ROUND)).resolves.toBe('expired')
  })

  it('新一轮用新通道：旧一轮的迟到兑现满足不了它', async () => {
    const waker = buildWaker()
    await waker.arm('t-1', { task_id: 'task-7', attempt: 1 })
    await waker.arm('t-1', { task_id: 'task-7', attempt: 2 })
    await waker.wake('t-1', { task_id: 'task-7', attempt: 1 }, 'stale')
    await expect(waker.state('t-1', { task_id: 'task-7', attempt: 1 })).resolves.toBe('resolved')
    // 第 2 轮仍然在等 —— 迟到的第 1 轮兑现没有唤醒它。
    await expect(waker.state('t-1', { task_id: 'task-7', attempt: 2 })).resolves.toBe('pending')
  })
})

describe('对账扫描（§8.1 第三条纪律）', () => {
  it('三个桶互斥，且随 TTL 推进从 running 挪到 stranded', async () => {
    let now = 0
    const waker = buildWaker(new MemoryCourier(() => now))
    await waker.arm('t-wait', ROUND, 60_000)
    await waker.arm('t-late', ROUND, 500)
    await waker.arm('t-done', ROUND, 60_000)
    await waker.wake('t-done', ROUND, 'ok')

    // 到期前：还在等的那条进 running。
    now = 600
    const early = await waker.reconcile([entry('t-wait'), entry('t-late'), entry('t-done')])
    expect(early.running).toEqual(['t-wait'])
    expect(early.stranded).toEqual(['t-late'])
    expect(early.settling).toEqual(['t-done'])

    // 再往后：t-wait 也到期 → 进 stranded，running 清空。
    now = 60_001
    const late = await waker.reconcile([entry('t-wait'), entry('t-late'), entry('t-done')])
    expect(late.running).toEqual([])
    expect(late.stranded).toEqual(['t-wait', 't-late'])
    expect(late.settling).toEqual(['t-done'])
  })

  it('未 arm 过但状态是 awaiting → stranded 并告警（状态被推过头了）', async () => {
    const warnings: string[] = []
    const waker = buildWaker(new MemoryCourier(), message => warnings.push(message))
    await waker.arm('t-wait', ROUND, 60_000)
    const result = await waker.reconcile([entry('t-wait'), entry('t-ghost')])
    expect(result.running).toEqual(['t-wait'])
    expect(result.stranded).toEqual(['t-ghost'])
    // 读路径分不开「从未 arm」与「已被清理」，所以只能告警，不能自动改状态。
    expect(warnings.join('\n')).toContain('t-ghost')
  })

  it('没进过等待的线程不参与对账（否则每次对账都会报一批假搁浅）', async () => {
    const waker = buildWaker()
    const result = await waker.reconcile([
      entry('t-running', 'running'), entry('t-idle', 'idle'), entry('t-done', 'done'),
    ])
    expect(result).toEqual({ running: [], settling: [], stranded: [] })
  })

  it('对账不改状态：搁浅只是上报，处置由协调者决定', async () => {
    let now = 0
    const waker = buildWaker(new MemoryCourier(() => now))
    await waker.arm('t-1', ROUND, 10)
    now = 11
    const result = await waker.reconcile([entry('t-1')])
    expect(result.stranded).toEqual(['t-1'])
    // 通道仍是 expired（没有被谁改写成 resolved，也没有被重新 arm）。
    await expect(waker.state('t-1', ROUND)).resolves.toBe('expired')
  })
})

describe('会合面实例是现取的（装配顺序无关）', () => {
  it('resolveCourier 换掉之后，后续动作落进新会合面', async () => {
    // 构造时快照会把「mailbox 晚一步挂上」永久固化成内存兜底：等待项重启即丢，
    // 却看起来一切正常 —— 所以解析器是必须的。
    let current: TeamCourier = new MemoryCourier()
    const waker = new ThreadWaker({ resolveCourier: () => current })
    await waker.arm('t-1', ROUND)
    const upgraded = new MemoryCourier()
    current = upgraded
    // 新会合面上没有这条等待项 —— 反过来证明前一次确实落在了旧实例上。
    await expect(waker.state('t-1', ROUND)).resolves.toBe('unknown')
    await waker.arm('t-2', ROUND)
    await expect(upgraded.state('thread/t-2/wake/1')).resolves.toBe('pending')
  })
})

describe('通知（announce）：先 arm 再兑现，且强制带 TTL', () => {
  it('等待项不存在时先建出来再兑现 —— 否则这次通知会落空', async () => {
    const courier = new MemoryCourier()
    const waker = buildWaker(courier)
    // 协调者没在等（等待项从未 arm）：通知仍然要能被后到的等待者读到。
    const delivered = await waker.announce('t-1', ROUND, { kind: 'node-lost' })
    expect(delivered.channel).toBe('thread/t-1/wake/1')
    expect(delivered.settled.status).toBe('settled')
    expect(delivered.ttlMs).toBe(DEFAULT_WAKE_TTL_MS)
    await expect(courier.await('thread/t-1/wake/1', 10)).resolves.toEqual({
      state: 'resolved', value: { kind: 'node-lost' },
    })
  })

  it('重复通知不改写结局（首次为准）：至少一次投递下必然出现重复', async () => {
    const courier = new MemoryCourier()
    const waker = buildWaker(courier)
    await waker.announce('t-1', ROUND, { kind: 'node-lost' })
    const again = await waker.announce('t-1', ROUND, { kind: '别的' })
    expect(again.settled.status).toBe('already-settled')
    await expect(courier.await('thread/t-1/wake/1', 10)).resolves.toEqual({
      state: 'resolved', value: { kind: 'node-lost' },
    })
  })

  it('TTL 收敛到上限，且不存在「无限」这个值', async () => {
    const waker = buildWaker(new MemoryCourier())
    const huge = await waker.announce('t-1', ROUND, {}, Number.MAX_SAFE_INTEGER)
    expect(huge.ttlMs).toBe(MAX_WAKE_TTL_MS)
    const bogus = await waker.announce('t-2', ROUND, {}, -1)
    expect(bogus.ttlMs).toBe(DEFAULT_WAKE_TTL_MS)
  })

  it('已终态的等待项不会再被兑现（重复兑现按 already-settled 回报）', async () => {
    const courier = new MemoryCourier()
    const waker = buildWaker(courier)
    await waker.arm('t-1', ROUND)
    await waker.abandon('t-1', ROUND, '任务被取消')
    const after = await waker.announce('t-1', ROUND, { kind: 'node-lost' })
    expect(after.settled.status).toBe('already-settled')
    await expect(courier.await('thread/t-1/wake/1', 10)).resolves.toEqual({
      state: 'rejected', error: '任务被取消',
    })
  })
})

import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  createCourier,
  MailboxCourier,
  MemoryCourier,
  type CourierWait,
  type MailboxSeamLike,
} from '../src/courier.ts'

afterEach(() => {
  vi.useRealTimers()
})

describe('MemoryCourier（单机兜底）', () => {
  it('开槽后兑现，等待方拿到值', async () => {
    const courier = new MemoryCourier()
    await courier.open('c1', 1_000)
    const waiting = courier.await('c1')
    expect(await courier.settle('c1', { opinion: '可行' })).toEqual({ status: 'settled' })
    expect(await waiting).toEqual({ state: 'resolved', value: { opinion: '可行' } })
  })

  it('先兑现后等待也能读到值（覆盖 resolve 先于 wait 的竞态）', async () => {
    const courier = new MemoryCourier()
    await courier.open('c1', 1_000)
    await courier.settle('c1', 42)
    expect(await courier.await('c1')).toEqual({ state: 'resolved', value: 42 })
  })

  it('重复兑现按首次为准', async () => {
    const courier = new MemoryCourier()
    await courier.open('c1', 1_000)
    await courier.settle('c1', 'first')
    expect(await courier.settle('c1', 'second')).toEqual({ status: 'already-settled' })
    expect(await courier.await('c1')).toEqual({ state: 'resolved', value: 'first' })
  })

  it('兑现不存在的等待项返回 unknown', async () => {
    const courier = new MemoryCourier()
    expect(await courier.settle('ghost', 1)).toEqual({ status: 'unknown' })
  })

  it('带错误兑现返回 rejected', async () => {
    const courier = new MemoryCourier()
    await courier.open('c1', 1_000)
    const waiting = courier.await('c1')
    await courier.fail('c1', '成员执行失败')
    expect(await waiting).toEqual({ state: 'rejected', error: '成员执行失败' })
  })

  it('open 幂等，不重置已有槽的 TTL', async () => {
    let clock = 0
    const courier = new MemoryCourier(() => clock)
    await courier.open('c1', 1_000)
    clock = 900
    await courier.open('c1', 1_000)
    clock = 1_100   // 若第二次 open 重置了 TTL，这里还没到期
    expect(await courier.await('c1')).toMatchObject({ state: 'expired' })
  })

  it('TTL 到期即 expired，绝不无限等', async () => {
    let clock = 0
    const courier = new MemoryCourier(() => clock)
    await courier.open('c1', 1_000)
    clock = 5_000
    expect(await courier.await('c1')).toMatchObject({ state: 'expired' })
  })

  it('调用方 timeout 与 TTL 取更早者', async () => {
    vi.useFakeTimers()
    const courier = new MemoryCourier(() => Date.now())
    await courier.open('c1', 60_000)
    const waiting = courier.await('c1', 500)
    await vi.advanceTimersByTimeAsync(600)
    expect(await waiting).toMatchObject({ state: 'expired' })
  })

  it('等待中的槽被兑现时立刻唤醒', async () => {
    vi.useFakeTimers()
    const courier = new MemoryCourier(() => Date.now())
    await courier.open('c1', 60_000)
    const waiting = courier.await('c1')
    await vi.advanceTimersByTimeAsync(10)
    await courier.settle('c1', '到了')
    expect(await waiting).toEqual({ state: 'resolved', value: '到了' })
  })

  it('等待不存在的槽立即 expired，不挂住', async () => {
    const courier = new MemoryCourier()
    const outcome = await courier.await('never-opened')
    expect(outcome.state).toBe('expired')
  })

  it('close 释放所有等待方', async () => {
    const courier = new MemoryCourier()
    await courier.open('c1', 60_000)
    const waiting = courier.await('c1')
    await courier.close()
    expect(await waiting).toMatchObject({ state: 'expired' })
  })

  it('标记为不持久', () => {
    expect(new MemoryCourier().durable).toBe(false)
  })

  it('state 非阻塞报告 pending / resolved / rejected / unknown', async () => {
    const courier = new MemoryCourier()
    expect(await courier.state('c1')).toBe('unknown')
    await courier.open('c1', 1_000)
    expect(await courier.state('c1')).toBe('pending')
    await courier.settle('c1', 1)
    expect(await courier.state('c1')).toBe('resolved')

    await courier.open('c2', 1_000)
    await courier.fail('c2', 'boom')
    expect(await courier.state('c2')).toBe('rejected')
  })

  it('state 与 await 对「是否已过期」给出同一答案', async () => {
    let clock = 0
    const courier = new MemoryCourier(() => clock)
    await courier.open('c1', 1_000)
    clock = 5_000
    expect(await courier.state('c1')).toBe('expired')
    // 探针已把它推进终态，随后的 await 立刻返回，不会再等一轮。
    expect(await courier.await('c1')).toMatchObject({ state: 'expired' })
  })
})

describe('MailboxCourier（集群）', () => {
  /** `pollResult = null` 表示「记录不存在」。注意不能用 `undefined`：那会落回默认值。 */
  function fakeMailbox(pollResult: { state: string } | null = { state: 'pending' }): { seam: MailboxSeamLike; calls: string[] } {
    const calls: string[] = []
    const seam: MailboxSeamLike = {
      create: async (id, realm, ttl) => { calls.push(`create:${id}:${realm}:${ttl}`); return {} },
      resolve: async (id, value) => { calls.push(`resolve:${id}:${JSON.stringify(value)}`); return { status: 'settled' } },
      reject: async (id, error) => { calls.push(`reject:${id}:${error}`); return { status: 'already-settled' } },
      wait: async (id, timeoutMs) => {
        calls.push(`wait:${id}:${String(timeoutMs)}`)
        return { state: 'expired', error: 'ttl' }
      },
      poll: async (id) => { calls.push(`poll:${id}`); return pollResult ?? undefined },
    }
    return { seam, calls }
  }

  it('把 realm 与 TTL 透传给持久信箱', async () => {
    const { seam, calls } = fakeMailbox()
    const courier = new MailboxCourier(seam, 'realm-a')
    await courier.open('c1', 5_000)
    expect(calls).toEqual(['create:c1:realm-a:5000'])
  })

  it('兑现/失败/等待全部委托，并归一状态闭集', async () => {
    const { seam, calls } = fakeMailbox()
    const courier = new MailboxCourier(seam, 'r')
    expect(await courier.settle('c1', { v: 1 })).toEqual({ status: 'settled' })
    expect(await courier.fail('c1', 'boom')).toEqual({ status: 'already-settled' })
    expect(await courier.await('c1', 100)).toEqual({ state: 'expired', error: 'ttl' })
    expect(calls).toEqual(['resolve:c1:{"v":1}', 'reject:c1:boom', 'wait:c1:100'])
  })

  it('state 经 poll 读既有记录，不阻塞也不改状态', async () => {
    const { seam, calls } = fakeMailbox()
    const courier = new MailboxCourier(seam, 'r')
    expect(await courier.state('c1')).toBe('pending')
    expect(calls).toEqual(['poll:c1'])
  })

  it('state 把「不存在」与「闭集外的状态」都归一为 unknown', async () => {
    const missing = fakeMailbox(null)
    expect(await new MailboxCourier(missing.seam, 'r').state('c1')).toBe('unknown')
    const weird = fakeMailbox({ state: 'something-else' })
    expect(await new MailboxCourier(weird.seam, 'r').state('c1')).toBe('unknown')
  })

  it('标记为持久，且 close 不关闭共享的 mailbox 服务', async () => {
    const { seam, calls } = fakeMailbox()
    const courier = new MailboxCourier(seam, 'r')
    expect(courier.durable).toBe(true)
    await courier.close()
    expect(calls).toEqual([])
  })
})

describe('会合面选择', () => {
  it('有 mailbox 用持久实现', () => {
    const seam: MailboxSeamLike = {
      create: async () => ({}), resolve: async () => ({ status: 'settled' }),
      reject: async () => ({ status: 'settled' }), wait: async () => ({ state: 'expired', error: '' }),
      poll: async () => undefined,
    }
    expect(createCourier(seam, 'r')).toBeInstanceOf(MailboxCourier)
    expect(createCourier(seam, 'r').durable).toBe(true)
  })

  it('没有 mailbox 时回落进程内并如实告知', () => {
    const courier = createCourier(undefined, 'r')
    expect(courier).toBeInstanceOf(MemoryCourier)
    expect(courier.durable).toBe(false)
  })
})

describe('扇入（deliberation 拓扑的实际用法）', () => {
  it('planner 开 N 个槽，成员各自兑现，等齐后收敛', async () => {
    const courier = new MemoryCourier()
    const topics = ['性能', '安全', '可维护性']
    await Promise.all(topics.map((_, index) => courier.open(`opinion-${index}`, 60_000)))

    // 成员以任意顺序、不同时刻交回观点。
    await courier.settle('opinion-2', '模块边界不清')
    await courier.settle('opinion-0', 'p99 偏高')
    await courier.settle('opinion-1', '无越权路径')

    const collected: CourierWait[] = []
    for (let index = 0; index < topics.length; index += 1) {
      collected.push(await courier.await(`opinion-${index}`, 1_000))
    }
    expect(collected.map(o => (o.state === 'resolved' ? o.value : o.state)))
      .toEqual(['p99 偏高', '无越权路径', '模块边界不清'])
  })
})

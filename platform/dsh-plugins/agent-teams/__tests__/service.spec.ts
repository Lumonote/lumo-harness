import { describe, expect, it, vi } from 'vitest'

import { channelId, MemoryCourier, type TeamCourier } from '../src/courier.ts'
import { buildMemberPrompt, AgentTeamsService, type MemberSurface } from '../src/service.ts'
import { MemoryTeamStore } from '../src/store.ts'
import type { MemberProviderChoice, MemberRun, MemberSeam, MemberStartRequest } from '../src/roster.ts'

const NOW = 1_700_000_000_000
const SIGNAL = new AbortController().signal

const PROVIDER: MemberProviderChoice = { provider: 'spawn', kind: 'in-process', reason: 'test' }

/** 记录每次派发的请求，并回一个确定性结果。 */
function recordingSeam(reply: (request: MemberStartRequest) => { text: string; stopReason?: string } = request => ({ text: `完成 ${request.label}` })): {
  seam: MemberSeam
  calls: { provider: string; request: MemberStartRequest }[]
} {
  const calls: { provider: string; request: MemberStartRequest }[] = []
  const seam: MemberSeam = {
    list: () => [PROVIDER.provider],
    start: async (provider, request) => {
      calls.push({ provider, request })
      const { text, stopReason } = reply(request)
      const run: MemberRun = {
        id: `child-${calls.length}`,
        result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: stopReason ?? 'completed' }),
        dispose: async () => {},
      }
      return run
    },
  }
  return { seam, calls }
}

function makeService(
  seam: MemberSeam,
  options: { maxMembers?: number; warn?: (m: string) => void; courier?: TeamCourier } = {},
): AgentTeamsService {
  const { courier, ...rest } = options
  // 存储实例在解析器之外建一次：解析器每次调用都新建 store 会让状态在操作之间蒸发。
  const store = new MemoryTeamStore()
  return new AgentTeamsService({
    resolveStore: () => ({ store, durable: false }),
    resolveCourier: () => courier ?? new MemoryCourier(),
    resolveSeam: () => ({ seam, provider: PROVIDER }),
    now: () => NOW,
    ...rest,
  })
}

async function teamWith(service: AgentTeamsService, topology: 'planner-worker' | 'pipeline' | 'deliberation', subjects: string[], members = ['alice', 'bob']): Promise<string> {
  const id = 'demo'
  await service.create({ id, name: '演示团队', description: '把目标拆开做完', topology, subjects, captainSessionId: 's-1' })
  for (const name of members) await service.addMember(id, { name })
  return id
}

describe('建团队', () => {
  it('按拓扑铺种子任务并落 provider', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'pipeline', ['取数', '清洗'])
    const team = await service.get(id)
    expect(team.tasks.map(t => t.dependencies)).toEqual([[], ['t1']])
    expect(team.members.every(m => m.provider === 'spawn')).toBe(true)
  })

  it('记下成员为哪个员工工作，并把空白串归一成「没绑定」', async () => {
    // 这个字段是协作视图把智能体挂到员工下面的**唯一**依据：名字会重名会改、会话 id
    // 跨形态不通用，所以只能显式给。两种取值必须泾渭分明——有值 = 挂在那个员工下，
    // 没有 = 未绑定。空白串既不是员工 id 也不该被当成一个，所以在写入时就归一掉，
    // 而不是把两种含义相同的写法留给下游去猜。
    const { seam } = recordingSeam()
    const service = makeService(seam)
    // 显式给空的成员名单：teamWith 默认会塞两个成员（alice/bob），那样下面按下标断言
    // 就会断到别人身上——而测试仍然"通过"或"失败得很奇怪"。
    const id = await teamWith(service, 'pipeline', ['取数'], [])
    const team = await service.addMember(id, { name: '规划 Agent', role: 'planner', ownerUserId: ' employee-1 ' })
    expect(team.members[0]?.ownerUserId).toBe('employee-1')
    const unbound = await service.addMember(id, { name: '质检 Agent', ownerUserId: '   ' })
    expect(unbound.members[1]?.ownerUserId).toBeUndefined()
    expect('ownerUserId' in (unbound.members[1] ?? {})).toBe(false)
  })

  it('拒绝重复的团队 id', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    await teamWith(service, 'pipeline', ['a'])
    await expect(service.create({
      id: 'demo', name: 'x', topology: 'pipeline', subjects: ['b'], captainSessionId: 's',
    })).rejects.toMatchObject({ name: 'TeamError', code: 'DUPLICATE_TEAM' })
    // 原团队没被覆盖。
    expect((await service.get('demo')).tasks.map(t => t.subject)).toEqual(['a'])
  })

  it('成员数受上限约束', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam, { maxMembers: 1 })
    await service.create({ id: 'demo', name: 'x', topology: 'pipeline', subjects: ['a'], captainSessionId: 's' })
    await service.addMember('demo', { name: 'alice' })
    await expect(service.addMember('demo', { name: 'bob' })).rejects.toThrow(/上限/)
  })
})

describe('一轮调度', () => {
  it('只派发前沿任务，并写回结果', async () => {
    const { seam, calls } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'planner-worker', ['执行项 A', '执行项 B'])

    const first = await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })
    expect(first.dispatched.map(d => d.taskId)).toEqual(['t1'])
    expect(first.more).toBe(true)
    expect(calls).toHaveLength(1)

    const team = await service.get(id)
    expect(team.tasks[0]!.status).toBe('completed')
    expect(team.tasks[0]!.output).toBe('完成 演示团队/t1')
  })

  it('依赖齐了就并行派发下游（多 worker claim）', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'planner-worker', ['执行项 A', '执行项 B'])
    await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })
    const second = await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })
    expect(second.dispatched.map(d => d.taskId).sort()).toEqual(['t2', 't3'])
    expect(second.settled).toBe(true)
  })

  it('把上游产出带进下游成员的 prompt（one-shot 成员看不到团队状态）', async () => {
    const { seam, calls } = recordingSeam(request => ({ text: `产出:${request.label}` }))
    const service = makeService(seam)
    const id = await teamWith(service, 'pipeline', ['取数', '清洗'])
    await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })
    await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })

    const downstream = calls[1]!.request.prompt.join('\n')
    expect(downstream).toContain('上游任务的产出')
    expect(downstream).toContain('产出:演示团队/t1')
    expect(downstream).toContain('清洗')
  })

  it('没有成员时响亮拒绝，而不是空跑', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    await service.create({ id: 'demo', name: 'x', topology: 'pipeline', subjects: ['a'], captainSessionId: 's' })
    await expect(service.runRound({ teamId: 'demo', parent: {}, signal: SIGNAL })).rejects.toThrow(/没有可用成员/)
  })

  it('limit 限制单轮并行度', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'deliberation', ['性能', '安全', '可维护性'])
    const round = await service.runRound({ teamId: id, parent: {}, signal: SIGNAL, limit: 2 })
    expect(round.dispatched).toHaveLength(2)
    expect(round.more).toBe(true)
  })

  it('成员失败以失败态写回，不阻断同轮其它任务', async () => {
    // t1 正常完成、t2 报错：两条**并行**派发的写回互不覆盖，一条失败不阻断另一条。
    const { seam } = recordingSeam(request => (request.label.endsWith('t2')
      ? { text: '上游 500', stopReason: 'error' }
      : { text: 'ok' }))
    const service = makeService(seam)
    const id = await teamWith(service, 'deliberation', ['性能', '安全'])
    await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })
    const team = await service.get(id)
    expect(team.tasks[0]).toMatchObject({ id: 't1', status: 'completed', output: 'ok' })
    expect(team.tasks[1]).toMatchObject({ id: 't2', status: 'failed', output: '上游 500' })
    // 收敛任务依赖未齐，仍留在前沿之外。
    expect(team.tasks[2]).toMatchObject({ id: 't3', status: 'pending' })
  })

  it('派发期间被改派：迟到写回被拒并告警，不覆盖新结果', async () => {
    const warnings: string[] = []
    let service!: AgentTeamsService
    // 第一次派发过程中把任务改派给别人 —— 模拟「成员还在跑，船长改了派」。
    const seam: MemberSeam = {
      list: () => ['spawn'],
      start: async () => {
        await service.reassign('demo', 't1', 'bob')
        return {
          id: 'child',
          result: Promise.resolve({ output: [{ type: 'text', text: '旧执行者的结果' }], stopReason: 'completed' }),
          dispose: async () => {},
        }
      },
    }
    service = makeService(seam, { warn: message => warnings.push(message) })
    const id = await teamWith(service, 'pipeline', ['a'])
    await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })

    const team = await service.get(id)
    // 任务退回待认领（bob），旧结果没有落盘。
    expect(team.tasks[0]!.assignee).toBe('bob')
    expect(team.tasks[0]!.status).toBe('pending')
    expect(team.tasks[0]!.output).toBeUndefined()
    expect(warnings.join('\n')).toContain('写回被拒')
  })

  it('基础设施故障把任务退回失败态而不是悬着', async () => {
    const warnings: string[] = []
    const seam: MemberSeam = {
      list: () => ['spawn'],
      start: async () => ({
        id: 'child',
        result: Promise.reject(new Error('承载节点不可达')),
        dispose: async () => {},
      }),
    }
    const service = makeService(seam, { warn: message => warnings.push(message) })
    const id = await teamWith(service, 'pipeline', ['a'])
    const round = await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })
    expect(round.dispatched[0]).toMatchObject({ ok: false, stopReason: 'error' })
    const team = await service.get(id)
    expect(team.tasks[0]!.status).toBe('failed')
    expect(team.tasks[0]!.output).toContain('承载节点不可达')
    expect(warnings.join('\n')).toContain('派发失败')
  })
})

describe('跑到收敛', () => {
  it('流水线逐段推进直到全部完成', async () => {
    const { seam, calls } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'pipeline', ['取数', '清洗', '入湖'])
    const result = await service.runToSettle({ teamId: id, parent: {}, signal: SIGNAL })
    expect(result.settled).toBe(true)
    expect(calls).toHaveLength(3)
    const team = await service.get(id)
    expect(team.tasks.map(t => t.status)).toEqual(['completed', 'completed', 'completed'])
  })

  it('轮次上限生效并告警', async () => {
    const warnings: string[] = []
    const { seam } = recordingSeam()
    const service = makeService(seam, { warn: m => warnings.push(m) })
    const id = await teamWith(service, 'pipeline', ['a', 'b', 'c'])
    const result = await service.runToSettle({ teamId: id, parent: {}, signal: SIGNAL, maxRounds: 1 })
    expect(result.settled).toBe(false)
    expect(warnings.join('\n')).toContain('轮次上限')
  })
})

describe('状态与认领面', () => {
  it('status 汇总进度与能力画像', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'planner-worker', ['执行项'])
    const status = await service.status(id)
    expect(status.progress).toMatchObject({ total: 2, ready: ['t1'] })
    expect(status.settled).toBe(false)
    expect(status.capabilities).toMatchObject({
      provider: { provider: 'spawn', kind: 'in-process' },
      durableStore: false,
      durableCourier: false,
    })
  })

  it('claimable 只列出该成员能领的：指派给别人的不出现，未指派的都能领', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'deliberation', ['性能', '安全', '可维护性'])
    await service.reassign(id, 't1', 'alice')
    await service.reassign(id, 't2', 'bob')

    // t3 未指派 → 两人都能领；t1/t2 已指派 → 只对本人可见。
    expect(await service.claimable(id, 'alice')).toEqual(['t1', 't3'])
    expect(await service.claimable(id, 'bob')).toEqual(['t2', 't3'])
    // t4 是收敛任务，依赖 t1/t2/t3 未齐 → 谁都领不到。
    expect(await service.claimable(id, 'alice')).not.toContain('t4')
  })
})

describe('写序（并发读-改-写不互相覆盖）', () => {
  it('两个并发的读-改-写都不丢（内存存储与 storage 后端同受保护）', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'pipeline', ['a'])

    await Promise.all([
      service.addMember(id, { name: 'carol' }),
      service.addMember(id, { name: 'dave' }),
    ])

    expect((await service.get(id)).members.map(m => m.name).sort()).toEqual(['alice', 'bob', 'carol', 'dave'])
  })

  it('并行派发的多条写回全部落盘（多 worker claim 的真实场景）', async () => {
    const { seam } = recordingSeam(request => ({ text: `完成 ${request.label}` }))
    const service = makeService(seam)
    const id = await teamWith(service, 'deliberation', ['性能', '安全', '可维护性'])
    const round = await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })
    expect(round.dispatched).toHaveLength(3)
    const team = await service.get(id)
    expect(team.tasks.slice(0, 3).map(t => t.status)).toEqual(['completed', 'completed', 'completed'])
    expect(team.tasks[2]!.output).toBe('完成 演示团队/t3')
  })

  it('对不存在的团队写回抛 NOT_FOUND', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    await expect(service.claim('ghost', 't1', 'alice')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('一次写失败不毒化同团队的后续写', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'pipeline', ['a'])

    await expect(service.claim(id, 't9', 'alice')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect((await service.claim(id, 't1', 'alice')).tasks[0]!.status).toBe('claimed')
  })

  it('并发建同名团队只成功一次（check-then-act 在写链内）', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const input = { id: 'race', name: 'x', topology: 'pipeline' as const, subjects: ['a'], captainSessionId: 's' }
    const results = await Promise.allSettled([service.create(input), service.create(input)])
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(r => r.status === 'rejected')).toHaveLength(1)
  })

  it('非法团队 id 在铺任务之前就被闸住', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    await expect(service.create({
      id: 'a/b', name: 'x', topology: 'pipeline', subjects: ['a'], captainSessionId: 's',
    })).rejects.toThrow(/不合法/)
  })
})

describe('装配与按需解析', () => {
  it('未装配成员执行面时只读可用：status 能查，派发响亮失败', async () => {
    const store = new MemoryTeamStore()
    const service = new AgentTeamsService({
      resolveStore: () => ({ store, durable: false }),
      resolveCourier: () => new MemoryCourier(),
      now: () => NOW,
    })
    await service.create({ id: 'ro', name: '只读', topology: 'pipeline', subjects: ['a'], captainSessionId: 's' })

    const status = await service.status('ro')
    expect(status.capabilities).toBeNull()
    expect(status.progress.ready).toEqual(['t1'])
    // 不能派发要响亮，而不是静默什么都不做。
    await expect(service.addMember('ro', { name: 'alice' })).rejects.toThrow(/未提供成员 provider/)
  })

  it('按需解析：晚挂上来的执行面立刻可用，不被固化成只读', async () => {
    const store = new MemoryTeamStore()
    let surface: MemberSurface | undefined
    const service = new AgentTeamsService({
      resolveStore: () => ({ store, durable: false }),
      resolveCourier: () => new MemoryCourier(),
      resolveSeam: () => surface,
      now: () => NOW,
    })
    const { seam } = recordingSeam(() => ({ text: '晚挂也跑' }))

    await service.create({ id: 'late', name: 'x', topology: 'pipeline', subjects: ['a'], captainSessionId: 's' })
    // 装配那一刻执行面还没 provide（subagents 可能比本插件晚挂）。
    expect(service.capabilitiesOrNull()).toBeNull()

    surface = { seam, provider: PROVIDER }
    await service.addMember('late', { name: 'alice' })
    const round = await service.runRound({ teamId: 'late', parent: {}, signal: SIGNAL })
    expect(round.dispatched[0]).toMatchObject({ ok: true, text: '晚挂也跑' })
  })
})

describe('成员 prompt 构造', () => {
  it('含身份、目标、任务与交付约定', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'pipeline', ['取数'])
    const team = await service.get(id)
    const prompt = buildMemberPrompt(team, 't1', team.members[0]!).join('\n')
    expect(prompt).toContain('成员 alice')
    expect(prompt).toContain('团队目标：把目标拆开做完')
    expect(prompt).toContain('你的任务 t1：取数')
    expect(prompt).toContain('不要复述任务描述')
  })
})

describe('会合面（courier）', () => {
  it('派发把结局兑现进通道，外部可按（团队, 任务, 代数）等到', async () => {
    const courier = new MemoryCourier()
    const { seam } = recordingSeam(() => ({ text: '结论正文' }))
    const service = makeService(seam, { courier })
    const id = await teamWith(service, 'pipeline', ['a'])
    await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })

    expect(await service.awaitTask({ teamId: id, taskId: 't1' }))
      .toEqual({ state: 'resolved', value: '结论正文' })
  })

  it('成员失败时通道以失败兑现', async () => {
    const courier = new MemoryCourier()
    const { seam } = recordingSeam(() => ({ text: '上游 500', stopReason: 'error' }))
    const service = makeService(seam, { courier })
    const id = await teamWith(service, 'pipeline', ['a'])
    await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })

    expect(await service.awaitTask({ teamId: id, taskId: 't1' }))
      .toEqual({ state: 'rejected', error: '上游 500' })
  })

  it('代数进通道 id：改派后旧代数的等待拿不到新结果', async () => {
    const courier = new MemoryCourier()
    const { seam } = recordingSeam(() => ({ text: '结论' }))
    const service = makeService(seam, { courier })
    const id = await teamWith(service, 'pipeline', ['a'])

    const claimed = await service.claim(id, 't1', 'alice')
    const firstAttempt = claimed.tasks[0]!.attempt
    await service.reassign(id, 't1', 'bob')
    await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })

    // 缺省用任务当前代数 → 拿到 bob 这次的结论。
    expect(await service.awaitTask({ teamId: id, taskId: 't1' }))
      .toEqual({ state: 'resolved', value: '结论' })
    // 旧代数那次从未被兑现 → 等不到，而不是误拿新结果。
    expect(await service.awaitTask({ teamId: id, taskId: 't1', attempt: firstAttempt }))
      .toMatchObject({ state: 'expired' })
  })

  it('对账：通道 TTL 已过的执行中任务退回待认领，代数递增作废迟到写回', async () => {
    let clock = 0
    const courier = new MemoryCourier(() => clock)
    const { seam } = recordingSeam()
    const service = makeService(seam, { courier })
    const id = await teamWith(service, 'pipeline', ['a'])

    // 手工摆出「派发者已消失」的形状：任务已认领、通道已开，之后再没人兑现。
    const claimed = await service.claim(id, 't1', 'alice')
    const attempt = claimed.tasks[0]!.attempt
    await courier.open(channelId(id, 't1', attempt), 1_000)

    clock = 5_000   // 越过 TTL
    expect(await service.reconcile(id)).toEqual({ requeued: ['t1'], running: [], settling: [] })
    expect((await service.get(id)).tasks[0]).toMatchObject({
      status: 'pending', assignee: 'alice', attempt: attempt + 1,
    })
  })

  it('对账：从未开过通道的执行中任务同样退回（重启后无人认领的形态）', async () => {
    const { seam } = recordingSeam()
    const service = makeService(seam)
    const id = await teamWith(service, 'pipeline', ['a'])
    await service.claim(id, 't1', 'alice')

    // 通道 unknown ⇒ 那次派发不可能再写回 ⇒ 必须退回，否则团队永久卡在 claimed。
    expect((await service.reconcile(id)).requeued).toEqual(['t1'])
    expect((await service.get(id)).tasks[0]!.status).toBe('pending')
  })

  it('对账：仍在跑的任务不动', async () => {
    const courier = new MemoryCourier()
    const { seam } = recordingSeam()
    const service = makeService(seam, { courier })
    const id = await teamWith(service, 'pipeline', ['a'])

    const claimed = await service.claim(id, 't1', 'alice')
    await courier.open(channelId(id, 't1', claimed.tasks[0]!.attempt), 60_000)

    expect(await service.reconcile(id)).toEqual({ requeued: [], running: ['t1'], settling: [] })
    expect((await service.get(id)).tasks[0]!.status).toBe('claimed')
  })

  it('对账：已兑现但写回未落盘的任务归入 settling，不退回', async () => {
    const courier = new MemoryCourier()
    const { seam } = recordingSeam()
    const service = makeService(seam, { courier })
    const id = await teamWith(service, 'pipeline', ['a'])

    const claimed = await service.claim(id, 't1', 'alice')
    const channel = channelId(id, 't1', claimed.tasks[0]!.attempt)
    await courier.open(channel, 60_000)
    await courier.settle(channel, '结论')

    expect(await service.reconcile(id)).toEqual({ requeued: [], running: [], settling: ['t1'] })
    expect((await service.get(id)).tasks[0]!.status).toBe('claimed')
  })

  it('会合面故障不阻断派发（只告警）', async () => {
    const warnings: string[] = []
    const broken: TeamCourier = {
      durable: false,
      open: async () => { throw new Error('会合面不可达') },
      settle: async () => { throw new Error('会合面不可达') },
      fail: async () => { throw new Error('会合面不可达') },
      await: async () => ({ state: 'expired', error: '会合面不可达' }),
      state: async () => { throw new Error('会合面不可达') },
      close: async () => {},
    }
    const { seam } = recordingSeam(() => ({ text: '照常完成' }))
    const service = makeService(seam, { courier: broken, warn: m => warnings.push(m) })
    const id = await teamWith(service, 'pipeline', ['a'])

    const round = await service.runRound({ teamId: id, parent: {}, signal: SIGNAL })
    expect(round.dispatched[0]).toMatchObject({ ok: true, text: '照常完成' })
    expect((await service.get(id)).tasks[0]!.status).toBe('completed')
    expect(warnings.join('\n')).toContain('通道')
  })
})

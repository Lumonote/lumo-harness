import { describe, expect, it } from 'vitest'

import { MemoryCourier } from '../src/courier.ts'
import {
  addMember,
  addTasks,
  claimTask,
  completeTask,
  createTeam,
  memberByName,
  reassignTask,
  seedTasks,
  startTask,
  type TeamState,
} from '../src/model.ts'
import type { MemberProviderChoice, MemberRun, MemberSeam, MemberStartRequest } from '../src/roster.ts'
import { AgentTeamsService } from '../src/service.ts'
import { MemoryTeamStore } from '../src/store.ts'

const NOW = 1_700_000_000_000
const SIGNAL = new AbortController().signal
const CAPTAIN = 's-captain'
const PROVIDER: MemberProviderChoice = { provider: 'spawn', kind: 'in-process', reason: 'test' }

/** 名册里只有成员：船长是隐式的（即拥有团队的那个会话），不在 `members` 里。 */
function fixture(): TeamState {
  let team = createTeam({ id: 'demo', name: '演示团队', topology: 'pipeline', captainSessionId: CAPTAIN, now: NOW })
  team = addMember(team, { name: 'alice', provider: 'spawn' }, NOW)
  return addTasks(team, seedTasks('pipeline', ['取数']), NOW).team
}

/** 抓住同步抛出的错误，没抛错返回 undefined。 */
function caught(run: () => unknown): unknown {
  try {
    run()
    return undefined
  } catch (error: unknown) {
    return error
  }
}

function makeService(): { service: AgentTeamsService; calls: MemberStartRequest[] } {
  const calls: MemberStartRequest[] = []
  const seam: MemberSeam = {
    list: () => [PROVIDER.provider],
    start: async (_provider, request) => {
      calls.push(request)
      const run: MemberRun = {
        id: `child-${calls.length}`,
        result: Promise.resolve({ output: [{ type: 'text', text: '完成' }], stopReason: 'completed' }),
        dispose: async () => {},
      }
      return run
    },
  }
  // store 实例建在解析器之外：解析器每次调用都新建 store 会让团队状态在操作之间蒸发。
  const store = new MemoryTeamStore()
  const service = new AgentTeamsService({
    resolveStore: () => ({ store, durable: false }),
    resolveCourier: () => new MemoryCourier(),
    resolveSeam: () => ({ seam, provider: PROVIDER }),
    now: () => NOW,
  })
  return { service, calls }
}

/**
 * S2「协调者不执行，故永不被阻塞」（§24.1）的**现状锁**。
 *
 * 这里不新增机制，只把既有性质钉住：**协调者没有可执行的身份** —— 船长会话 id 不是
 * 名册条目，而任务板上的每一个执行入口（认领 / 开工 / 完成 / 改派）都以名册为闸。
 * 于是「协调者自己下场干活」在这套数据结构里根本无路可走，协调者的响应性也就
 * 不依赖它自己腾不腾得出时间。
 *
 * 闸门钉在 `claimTask` 而不是 `claimableBy`：后者是**提示面**（「你此刻能认领什么」），
 * 不校验名册；判定落在认领那一刻，读到的列表为空与否都不构成保证。
 *
 * **已知边界已于 2026-09-20 闭合。** 此前名册不校验 `name` 与 `captainSessionId` 的关系，
 * 于是绕开这道闸只要一步：**船长把自己的会话 id 填进 `name` 加为成员**，此后
 * `memberByName` 就能查到它，一切执行入口随之放行。当时的处置是「只登记、不写成断言」，
 * 因为那是一个未拍板的语义边界，断言会把它固化成「已定语义」。
 *
 * 拍板后的落法是**两点一判据**（`isCoordinatorName`）：
 *
 *   - `addMember` 挡住「先把协调者变成成员」——这是上面那一步绕行；
 *   - `memberByName` 挡住「以协调者身份行事」——它是认领、改派、指派、派发的共同收口点。
 *
 * 于是 `startTask` / `completeTask` / `failTask` **不需要第三人**：它们的判据是
 * `task.assignee === memberName`，而 `assignee` 只能由 `addTask` / `claimTask` /
 * `reassignTask` 三条路径设置，三条都过 `memberByName`。下面的用例把这条**推断**
 * 逐条钉住 —— 推断一旦不成立（有人加了第四条设置 assignee 的路），这里会红。
 *
 * 语义边界（写在这里免得被误读成「协调者什么都不能做」）：S2 的准确表述是
 * **「协调者不是成员」**。`cancelTask` 的注释写着「船长或指派者」——取消任务本来就是
 * 协调者的合法动作。本文件锁的是「不能持有成员身份、不能占据任务」，不是「不能行动」。
 */
describe('S2：协调者不执行（§24.1）', () => {
  it('建团队不顺手把船长写进名册：它是隐式的', () => {
    const team = fixture()
    expect(team.captainSessionId).toBe(CAPTAIN)
    expect(team.members.map(member => member.name)).not.toContain(CAPTAIN)
  })

  it('船长会话 id 认领任务：名册查不到，NOT_FOUND', () => {
    const team = fixture()
    expect(caught(() => claimTask(team, 't1', CAPTAIN, NOW)))
      .toMatchObject({ name: 'TeamError', code: 'NOT_FOUND' })
  })

  it('改派给船长同样走名册闸，不能把任务塞给自己', () => {
    expect(caught(() => reassignTask(fixture(), 't1', CAPTAIN, NOW)))
      .toMatchObject({ name: 'TeamError', code: 'NOT_FOUND' })
  })

  it('开工与完成也拦得住：没有认领就不可能有可推进的身份', () => {
    let team = fixture()
    expect(caught(() => startTask(team, 't1', CAPTAIN, NOW)))
      .toMatchObject({ name: 'TeamError', code: 'NOT_ASSIGNEE' })
    team = claimTask(team, 't1', 'alice', NOW)
    expect(caught(() => completeTask(team, 't1', CAPTAIN, '船长自己写的结论', NOW)))
      .toMatchObject({ name: 'TeamError', code: 'NOT_ASSIGNEE' })
  })

  it('服务面同一条闸：船长认领被拒，成员认领照常', async () => {
    const { service } = makeService()
    await service.create({
      id: 'demo', name: '演示团队', topology: 'pipeline', subjects: ['取数'], captainSessionId: CAPTAIN,
    })
    await service.addMember('demo', { name: 'alice' })

    await expect(service.claim('demo', 't1', CAPTAIN))
      .rejects.toMatchObject({ name: 'TeamError', code: 'NOT_FOUND' })
    // 对照组：锁的是「船长不能」，不是「认领坏了」——同一条任务成员认领得到。
    await expect(service.claim('demo', 't1', 'alice')).resolves.toBeDefined()
  })

  it('协调者会话不可登记为成员 —— 堵住绕开名册闸的那一步', () => {
    expect(caught(() => addMember(fixture(), { name: CAPTAIN, provider: 'spawn' }, NOW)))
      .toMatchObject({ name: 'TeamError', code: 'COORDINATOR_IS_NOT_A_MEMBER' })
  })

  it('协调者名与成员名重名之外的普通重名仍是 DUPLICATE_MEMBER（码没有混）', () => {
    // 对照组：新码不能把既有的重名判据吞掉，否则「越权尝试」与「名字打重了」
    // 又会被混成一类，而这正是新码存在的理由。
    const team = addMember(fixture(), { name: 'bob', provider: 'spawn' }, NOW)
    expect(caught(() => addMember(team, { name: 'bob', provider: 'spawn' }, NOW)))
      .toMatchObject({ name: 'TeamError', code: 'DUPLICATE_MEMBER' })
  })

  it('空名不被当成协调者（判据不靠空串的巧合成立）', () => {
    // isCoordinatorName 对空串返回 false；这条钉住它，免得将来有人把判据简化成
    // `name === team.captainSessionId` 而恰好某个团队的 captain 为空串时全线放行。
    expect(caught(() => addMember(fixture(), { name: '', provider: 'spawn' }, NOW)))
      .not.toMatchObject({ code: 'COORDINATOR_IS_NOT_A_MEMBER' })
  })

  it('以协调者身份派发被 memberByName 拦下（收口点确实在名册解析上）', () => {
    // service 的派发路径（`service.ts` 的 memberByName）与任务板用的是同一个收口点。
    // 这条断言的是**收口点的唯一性**：如果将来有人给派发另开一条直接读 members 的路，
    // 这里不会红（它测不到新路），但那条新路也就不再受 S2 约束 —— 复核时请一并看。
    expect(caught(() => memberByName(fixture(), CAPTAIN)))
      .toMatchObject({ name: 'TeamError', code: 'NOT_FOUND' })
  })

  it('协调者被拒的措辞点明原因，不与拼写错误长得一样', () => {
    const error = caught(() => memberByName(fixture(), CAPTAIN)) as Error
    expect(error.message).toContain('协调者')
    expect(error.message).toContain('§24.1')
    // 对照：普通不存在的名字不该提「协调者」。
    const plain = caught(() => memberByName(fixture(), 'nobody')) as Error
    expect(plain.message).not.toContain('协调者')
  })

  it('一轮调度只在名册里挑执行者，未指派的任务也不会落到船长名下', async () => {
    const { service, calls } = makeService()
    await service.create({
      id: 'demo', name: '演示团队', topology: 'pipeline', subjects: ['取数'], captainSessionId: CAPTAIN,
    })
    await service.addMember('demo', { name: 'alice' })

    await service.runRound({ teamId: 'demo', parent: {}, signal: SIGNAL })
    const team = await service.get('demo')
    expect(calls).toHaveLength(1)
    expect(team.tasks[0]).toMatchObject({ status: 'completed', assignee: 'alice' })
    expect(team.tasks[0]!.assignee).not.toBe(CAPTAIN)
  })
})

import { describe, expect, it } from 'vitest'

import {
  addMember,
  addTasks,
  assertDependencyGraph,
  blockersOf,
  cancelTask,
  claimTask,
  claimableBy,
  completeTask,
  createTeam,
  failTask,
  isSettled,
  readyTasks,
  reassignTask,
  removeMember,
  requeueTask,
  seedTasks,
  startTask,
  TeamError,
  teamProgress,
  type TeamState,
} from '../src/model.ts'

const NOW = 1_700_000_000_000

/** 建一个带两名成员的团队，并按拓扑铺好种子任务。 */
function fixture(topology: Parameters<typeof seedTasks>[0], subjects: readonly string[], names = ['alice', 'bob']): TeamState {
  let team = createTeam({ id: 'demo', name: 'demo', topology, captainSessionId: 's-captain', now: NOW })
  for (const name of names) team = addMember(team, { name, provider: 'spawn' }, NOW)
  return addTasks(team, seedTasks(topology, subjects), NOW).team
}

describe('拓扑种子图', () => {
  it('planner-worker 先规划后并行执行', () => {
    const team = fixture('planner-worker', ['写解析器', '写测试'])
    expect(team.tasks.map(t => t.id)).toEqual(['t1', 't2', 't3'])
    expect(team.tasks.map(t => t.dependencies)).toEqual([[], ['t1'], ['t1']])
    // 前沿只有规划任务：两个执行项都还没解锁。
    expect(readyTasks(team).map(t => t.id)).toEqual(['t1'])
  })

  it('pipeline 串成一条链，任一时刻只有链首可动', () => {
    const team = fixture('pipeline', ['取数', '清洗', '入湖'])
    expect(team.tasks.map(t => t.dependencies)).toEqual([[], ['t1'], ['t2']])
    expect(readyTasks(team).map(t => t.id)).toEqual(['t1'])
  })

  it('deliberation 并行出观点后收敛', () => {
    const team = fixture('deliberation', ['性能', '安全'])
    expect(team.tasks.map(t => t.dependencies)).toEqual([[], [], ['t1', 't2']])
    // 两个观点任务同时可动，收敛任务被两条依赖挡住。
    expect(readyTasks(team).map(t => t.id)).toEqual(['t1', 't2'])
    expect(blockersOf(team, team.tasks[2]!)).toEqual(['t1', 't2'])
  })

  it('拒绝空主题列表', () => {
    expect(() => seedTasks('pipeline', [])).toThrow(TeamError)
  })
})

describe('DAG 校验', () => {
  it('拒绝未知依赖', () => {
    expect(() => assertDependencyGraph([
      { id: 't1', subject: 'x', status: 'pending', dependencies: ['t9'], attempt: 0, createdAt: 0, updatedAt: 0 },
    ])).toThrow(/依赖不存在的任务/)
  })

  it('拒绝自依赖', () => {
    expect(() => assertDependencyGraph([
      { id: 't1', subject: 'x', status: 'pending', dependencies: ['t1'], attempt: 0, createdAt: 0, updatedAt: 0 },
    ])).toThrow(/依赖自身/)
  })

  it('拒绝成环，并在报错里给出环路径', () => {
    const base = { subject: 'x', status: 'pending' as const, attempt: 0, createdAt: 0, updatedAt: 0 }
    expect(() => assertDependencyGraph([
      { ...base, id: 't1', dependencies: ['t2'] },
      { ...base, id: 't2', dependencies: ['t3'] },
      { ...base, id: 't3', dependencies: ['t1'] },
    ])).toThrow(/成环/)
  })

  it('合法菱形图通过', () => {
    const base = { subject: 'x', status: 'pending' as const, attempt: 0, createdAt: 0, updatedAt: 0 }
    expect(() => assertDependencyGraph([
      { ...base, id: 't1', dependencies: [] },
      { ...base, id: 't2', dependencies: ['t1'] },
      { ...base, id: 't3', dependencies: ['t1'] },
      { ...base, id: 't4', dependencies: ['t2', 't3'] },
    ])).not.toThrow()
  })

  it('非法依赖整批不落地（addTasks 是原子的）', () => {
    const team = fixture('pipeline', ['a'])
    expect(() => addTasks(team, [
      { subject: 'ok', dependencies: ['t1'] },
      { subject: 'bad', dependencies: ['nope'] },
    ], NOW)).toThrow(TeamError)
  })
})

describe('认领与推进', () => {
  it('依赖未齐不可认领', () => {
    const team = fixture('planner-worker', ['执行项'])
    expect(() => claimTask(team, 't2', 'alice', NOW)).toThrow(/依赖未完成/)
  })

  it('认领会递增代数并置成员为 working', () => {
    const team = fixture('planner-worker', ['执行项'])
    const claimed = claimTask(team, 't1', 'alice', NOW)
    const task = claimed.tasks[0]!
    expect(task.status).toBe('claimed')
    expect(task.assignee).toBe('alice')
    expect(task.attempt).toBe(1)
    expect(claimed.members.find(m => m.name === 'alice')?.status).toBe('working')
  })

  it('别人已认领的任务不可抢', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)
    expect(() => claimTask(team, 't1', 'bob', NOW)).toThrow(/已被认领/)
  })

  it('claimableBy 只给未指派或指派给自己的任务', () => {
    let team = fixture('deliberation', ['性能', '安全'])
    // 未指派的任务对任何人可认领（自助领取）。
    expect(claimableBy(team, 'alice').map(t => t.id)).toEqual(['t1', 't2'])
    team = reassignTask(team, 't1', 'alice', NOW)
    team = reassignTask(team, 't2', 'bob', NOW)
    expect(claimableBy(team, 'alice').map(t => t.id)).toEqual(['t1'])
    expect(claimableBy(team, 'bob').map(t => t.id)).toEqual(['t2'])
  })

  it('完成后解锁下游', () => {
    let team = fixture('planner-worker', ['执行项'])
    team = claimTask(team, 't1', 'alice', NOW)
    team = startTask(team, 't1', 'alice', NOW)
    expect(readyTasks(team).map(t => t.id)).toEqual([])
    team = completeTask(team, 't1', 'alice', '拆成两步', NOW)
    expect(readyTasks(team).map(t => t.id)).toEqual(['t2'])
    expect(team.tasks[0]!.output).toBe('拆成两步')
    expect(team.members.find(m => m.name === 'alice')?.status).toBe('idle')
  })

  it('只有指派者能推进', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)
    expect(() => startTask(team, 't1', 'bob', NOW)).toThrow(TeamError)
    expect(() => completeTask(team, 't1', 'bob', 'x', NOW)).toThrow(/无权更新/)
  })

  it('代数不符的迟到写回被拒绝', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)   // attempt = 1
    team = reassignTask(team, 't1', 'bob', NOW)  // attempt = 2，alice 的写回作废
    expect(() => completeTask(team, 't1', 'alice', '旧结果', NOW, 1)).toThrow(/无权更新/)
    team = claimTask(team, 't1', 'bob', NOW)     // attempt = 3
    expect(() => completeTask(team, 't1', 'bob', '用旧代数', NOW, 2)).toThrow(/尝试代数已变/)
    const done = completeTask(team, 't1', 'bob', '新结果', NOW, 3)
    expect(done.tasks[0]!.output).toBe('新结果')
  })

  it('已终结的任务不可再认领或取消', () => {
    let team = fixture('pipeline', ['a'])
    team = cancelTask(team, 't1', NOW)
    expect(() => claimTask(team, 't1', 'alice', NOW)).toThrow(/已终结/)
    expect(() => cancelTask(team, 't1', NOW)).toThrow(/已终结/)
  })

  it('失败是终态且记录输出', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)
    team = failTask(team, 't1', 'alice', '上游 500', NOW)
    expect(team.tasks[0]!.status).toBe('failed')
    expect(team.tasks[0]!.output).toBe('上游 500')
  })
})

describe('名册', () => {
  it('拒绝重名成员', () => {
    const team = fixture('pipeline', ['a'], ['alice'])
    expect(() => addMember(team, { name: 'alice', provider: 'spawn' }, NOW)).toThrow(/已有成员/)
  })

  it('移除成员会把其未完成任务退回待认领', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)
    team = removeMember(team, 'alice', NOW)
    expect(team.members.map(m => m.name)).toEqual(['bob'])
    expect(team.tasks[0]!.assignee).toBeUndefined()
    expect(team.tasks[0]!.status).toBe('pending')
    expect(team.tasks[0]!.attempt).toBe(2)
  })

  it('改派不丢成员状态：旧执行者退回 idle', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)
    team = reassignTask(team, 't1', 'bob', NOW)
    expect(team.members.find(m => m.name === 'alice')?.status).toBe('idle')
    expect(team.tasks[0]!.assignee).toBe('bob')
  })
})

describe('进度与收敛', () => {
  it('统计各状态并区分 ready / blocked', () => {
    let team = fixture('planner-worker', ['执行项 A', '执行项 B'])
    team = claimTask(team, 't1', 'alice', NOW)
    const progress = teamProgress(team)
    expect(progress).toMatchObject({ total: 3, pending: 2, active: 1, completed: 0 })
    expect(progress.ready).toEqual([])
    expect(progress.blocked).toEqual(['t2', 't3'])
  })

  it('全部任务到终态才算收敛', () => {
    let team = fixture('pipeline', ['a'])
    expect(isSettled(team)).toBe(false)
    team = cancelTask(team, 't1', NOW)
    expect(isSettled(team)).toBe(true)
  })

  it('空团队视为已收敛（无待办）', () => {
    const team = createTeam({ id: 'x', name: 'x', topology: 'pipeline', captainSessionId: 's', now: NOW })
    expect(isSettled(team)).toBe(true)
  })
})

describe('退回待认领（对账用）', () => {
  it('保留指派者但递增代数，旧执行的写回随即作废', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)
    const attempt = team.tasks[0]!.attempt
    team = requeueTask(team, 't1', NOW)

    expect(team.tasks[0]).toMatchObject({ status: 'pending', assignee: 'alice', attempt: attempt + 1 })
    // 退回后任务不再是执行中，迟到写回先撞状态闸。
    expect(() => completeTask(team, 't1', 'alice', '迟到结果', NOW, attempt)).toThrow(/不在执行中/)

    // 重新认领后状态闸放行，剩下的就纯粹是代数闸 —— 这才是对账要防的那件事。
    const reclaimed = claimTask(team, 't1', 'alice', NOW)
    expect(reclaimed.tasks[0]!.attempt).toBe(attempt + 2)
    expect(() => completeTask(reclaimed, 't1', 'alice', '迟到结果', NOW, attempt))
      .toThrow(/尝试代数已变/)
  })

  it('把执行者放回 idle，任务重新可被它认领', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)
    expect(team.members.find(m => m.name === 'alice')?.status).toBe('working')
    team = requeueTask(team, 't1', NOW)
    expect(team.members.find(m => m.name === 'alice')?.status).toBe('idle')
    expect(claimableBy(team, 'alice').map(t => t.id)).toEqual(['t1'])
  })

  it('未指派的任务也能退回，不因缺 assignee 报错', () => {
    let team = fixture('pipeline', ['a'])
    team = claimTask(team, 't1', 'alice', NOW)
    team = removeMember(team, 'alice', NOW)   // 成员被移除，任务已退回待认领
    team = claimTask(team, 't1', 'bob', NOW)
    team = { ...team, tasks: team.tasks.map(t => (t.id === 't1' ? { ...t, assignee: undefined } : t)) }
    expect(requeueTask(team, 't1', NOW).tasks[0]!.status).toBe('pending')
  })

  it('拒绝退回已终结或本就待认领的任务', () => {
    let team = fixture('pipeline', ['a'])
    expect(() => requeueTask(team, 't1', NOW)).toThrow(/已是待认领/)
    team = claimTask(team, 't1', 'alice', NOW)
    team = completeTask(team, 't1', 'alice', 'done', NOW)
    expect(() => requeueTask(team, 't1', NOW)).toThrow(/已终结/)
  })
})

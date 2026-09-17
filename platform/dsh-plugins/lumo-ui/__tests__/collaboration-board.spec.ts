import { describe, expect, it } from 'vitest'

import {
  boardTaskState,
  layoutTaskBoard,
  type BoardTaskInput,
} from '../src/client/collaboration-board.ts'

const task = (id: string, over: Partial<BoardTaskInput> = {}): BoardTaskInput => ({
  id,
  subject: id,
  status: 'pending',
  ...over,
})

describe('boardTaskState', () => {
  it('把 ready 与 blocked 从 pending 里分出来', () => {
    // 两者都是 pending，区别只在依赖是否已齐——而「现在就能认领」与「卡住了」正是
    // 这张图唯一值得区分的两件事。用状态字面量会把它们画成同一个颜色。
    const pending = task('t1')
    expect(boardTaskState(pending, { ready: ['t1'], blocked: [] })).toBe('ready')
    expect(boardTaskState(pending, { ready: [], blocked: ['t1'] })).toBe('blocked')
    // 两个集合都没提到它：理论上不该出现，但不能因此猜一个。
    expect(boardTaskState(pending, { ready: [], blocked: [] })).toBe('queued')
    expect(boardTaskState(pending, null)).toBe('queued')
  })

  it('终态不走 ready/blocked：已完成的任务不该因为出现在派生集合里就变色', () => {
    const done = task('t1', { status: 'completed' })
    expect(boardTaskState(done, { ready: ['t1'] })).toBe('delivered')
    const failed = task('t1', { status: 'failed' })
    expect(boardTaskState(failed, { blocked: ['t1'] })).toBe('failed')
    expect(boardTaskState(task('t1', { status: 'cancelled' }))).toBe('failed')
  })

  it('在执行中的状态直译', () => {
    expect(boardTaskState(task('t1', { status: 'claimed' }))).toBe('executing')
    expect(boardTaskState(task('t1', { status: 'in_progress' }))).toBe('executing')
  })

  it('词表外不猜', () => {
    expect(boardTaskState(task('t1', { status: 'paused_by_operator' }))).toBe('unknown')
    expect(boardTaskState(task('t1', { status: '' }))).toBe('unknown')
  })
})

describe('layoutTaskBoard', () => {
  const tasks = [
    task('t1', { subject: '拆解' }),
    task('t2', { subject: '方案', dependencies: ['t1'] }),
    task('t3', { subject: '原型', dependencies: ['t2'] }),
  ]

  it('纵深由依赖链决定，边就是 dependencies', () => {
    const { placed, edges, depths } = layoutTaskBoard(tasks)
    const depth = (id: string) => placed.find(node => node.id === id)?.depth
    expect(depth('t1')).toBe(0)
    expect(depth('t2')).toBe(1)
    expect(depth('t3')).toBe(2)
    expect(depths).toBe(3)
    expect(edges).toEqual([{ from: 't1', to: 't2' }, { from: 't2', to: 't3' }])
  })

  it('菱形依赖取最长路径', () => {
    // t4 同时依赖 t2 与 t3，深度该取更深的那个，而不是先遇到的那个。
    const diamond = [
      task('t1'),
      task('t2', { dependencies: ['t1'] }),
      task('t3', { dependencies: ['t2'] }),
      task('t4', { dependencies: ['t2', 't3'] }),
    ]
    const { placed } = layoutTaskBoard(diamond)
    expect(placed.find(node => node.id === 't4')?.depth).toBe(3)
  })

  it('依赖指向集合外的任务时不画边，但任务留下', () => {
    // 父任务可能被分页截掉或已删除。画一条指向空气的线会读成「上游还没开始」，
    // 而删掉这个任务会读成「它不存在」——两者都比少画一条边更坏。
    const orphan = [task('t9', { dependencies: ['absent'] })]
    const { placed, edges } = layoutTaskBoard(orphan)
    expect(placed).toHaveLength(1)
    expect(placed[0]?.depth).toBe(0)
    expect(edges).toEqual([])
  })

  it('同一个任务永远落在同一个位置，与输入顺序无关', () => {
    const shuffled = [tasks[2]!, tasks[0]!, tasks[1]!]
    const position = (board: ReturnType<typeof layoutTaskBoard>, id: string) => {
      const node = board.placed.find(candidate => candidate.id === id)
      return { x: node?.x, y: node?.y, z: node?.z }
    }
    for (const id of ['t1', 't2', 't3']) {
      expect(position(layoutTaskBoard(shuffled), id)).toEqual(position(layoutTaskBoard(tasks), id))
    }
  })

  it('未指派的显示成「待认领」，而不是空白', () => {
    // 空白读起来像数据缺失，而这里是一个明确的状态。
    const { placed } = layoutTaskBoard([task('t1'), task('t2', { assignee: '规划 Agent' })])
    expect(placed.find(node => node.id === 't1')?.assignee).toBe('待认领')
    expect(placed.find(node => node.id === 't2')?.assignee).toBe('规划 Agent')
  })

  it('把 progress 透传到状态上', () => {
    const { placed } = layoutTaskBoard(tasks, { ready: ['t1'], blocked: ['t2'] })
    expect(placed.find(node => node.id === 't1')?.state).toBe('ready')
    expect(placed.find(node => node.id === 't2')?.state).toBe('blocked')
    expect(placed.find(node => node.id === 't3')?.state).toBe('queued')
  })

  it('成环也能终止，且不丢任务', () => {
    const cyclic = [task('a', { dependencies: ['b'] }), task('b', { dependencies: ['a'] })]
    expect(layoutTaskBoard(cyclic).placed).toHaveLength(2)
  })

  it('空任务板给出空图', () => {
    const board = layoutTaskBoard([])
    expect(board.placed).toEqual([])
    expect(board.edges).toEqual([])
    expect(board.depths).toBe(0)
  })
})

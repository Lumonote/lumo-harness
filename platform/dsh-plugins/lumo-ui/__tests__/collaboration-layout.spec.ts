import { describe, expect, it } from 'vitest'

import {
  bindAgents,
  employeeFlowEdges,
  employeeState,
  layoutCollaboration,
  NODE_DEPTH_Z,
  NODE_LIFT_Y,
  type AgentInput,
  type EmployeeInput,
  type FlowTaskInput,
} from '../src/client/collaboration-layout.ts'

const employee = (id: string, over: Partial<EmployeeInput> = {}): EmployeeInput => ({ id, name: id, ...over })

const task = (id: string, over: Partial<FlowTaskInput> = {}): FlowTaskInput => ({
  id,
  title: id,
  assignee_user_id: 'a',
  ...over,
})

const agent = (name: string, over: Partial<AgentInput> = {}): AgentInput => ({
  name,
  teamId: 'team-1',
  teamName: '发布',
  ...over,
})

describe('employeeFlowEdges', () => {
  it('把父子任务折成承担者之间的上下游', () => {
    const tasks = [
      task('t1', { assignee_user_id: 'a' }),
      task('t2', { assignee_user_id: 'b', intent_contract: { parent_task_id: 't1' } }),
    ]
    expect(employeeFlowEdges(tasks, new Set(['a', 'b']))).toEqual([{ from: 'a', to: 'b' }])
  })

  it('丢掉自环、无承担者与指向非员工的边', () => {
    const tasks = [
      // 同一个人既是父又是子：画一条指向自己的线只会让图更乱。
      task('t1', { assignee_user_id: 'a' }),
      task('t2', { assignee_user_id: 'a', intent_contract: { parent_task_id: 't1' } }),
      // 父任务没指派。
      task('t3', { assignee_user_id: 'b', intent_contract: { parent_task_id: 't9' } }),
      // 承担者不是本页的员工（例如只读到了部分用户目录）。
      task('t4', { assignee_user_id: 'ghost', intent_contract: { parent_task_id: 't1' } }),
    ]
    expect(employeeFlowEdges(tasks, new Set(['a', 'b']))).toEqual([])
  })

  it('两人之间多条流转只画一条边', () => {
    // 线的数量不该取决于任务数：那会让「他们之间联系很密」这种不存在的信息
    // 从图里读出来。
    // 两条**同向**的流转（a→b 出现两次），而不是一去一回——后者是两条不同的边，
    // 去重不该把它们合并。
    const tasks = [
      task('t1', { assignee_user_id: 'a' }),
      task('t2', { assignee_user_id: 'b', intent_contract: { parent_task_id: 't1' } }),
      task('t3', { assignee_user_id: 'a' }),
      task('t4', { assignee_user_id: 'b', intent_contract: { parent_task_id: 't3' } }),
    ]
    expect(employeeFlowEdges(tasks, new Set(['a', 'b']))).toEqual([{ from: 'a', to: 'b' }])
  })

  it('一来一回是两条不同的边，不合并', () => {
    const tasks = [
      task('t1', { assignee_user_id: 'a' }),
      task('t2', { assignee_user_id: 'b', intent_contract: { parent_task_id: 't1' } }),
      task('t3', { assignee_user_id: 'a', intent_contract: { parent_task_id: 't2' } }),
    ]
    expect(employeeFlowEdges(tasks, new Set(['a', 'b']))).toEqual([
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ])
  })

  it('没有指派的任务产生不出员工边', () => {
    const tasks = [
      task('t1', { assignee_user_id: undefined }),
      task('t2', { assignee_user_id: 'b', intent_contract: { parent_task_id: 't1' } }),
    ]
    expect(employeeFlowEdges(tasks, new Set(['a', 'b']))).toEqual([])
  })
})

describe('employeeState', () => {
  it('待审核压过一切：被审的是别人交上来的东西，他在不在线不影响你看它', () => {
    const offline = employee('a', { nodes: [{ id: 'n1', status: 'OFFLINE' }] })
    const tasks = [task('t1', { assignee_user_id: 'a', state: 'RUNNING', business_state: 'VERIFYING' })]
    expect(employeeState(offline, tasks)).toBe('awaiting-review')
  })

  it('节点全掉线压过 blocked 与 executing', () => {
    // 节点全掉了而任务还挂在上面，是这张图最该喊出来的一件事。
    const nodes = [{ id: 'n1', status: 'OFFLINE' }, { id: 'n2', status: 'REVOKED' }]
    expect(employeeState(employee('a', { nodes }), [task('t1', { assignee_user_id: 'a', state: 'RUNNING' })])).toBe('offline')
    expect(employeeState(employee('a', { nodes }), [task('t1', { assignee_user_id: 'a', state: 'FAILED' })])).toBe('offline')
  })

  it('只要有一个节点在线就不算离线', () => {
    const nodes = [{ id: 'n1', status: 'OFFLINE' }, { id: 'n2', status: 'ONLINE' }]
    expect(employeeState(employee('a', { nodes }), [task('t1', { assignee_user_id: 'a', state: 'RUNNING' })])).toBe('executing')
  })

  it('按任务状态直译，且不把「没有任务」说成「已完成」', () => {
    expect(employeeState(employee('a'), [])).toBe('unknown')
    expect(employeeState(employee('a'), [task('t1', { state: 'RUNNING' })])).toBe('executing')
    expect(employeeState(employee('a'), [task('t1', { state: 'COMPLETED' })])).toBe('delivered')
    expect(employeeState(employee('a'), [task('t1', { state: 'QUEUED' })])).toBe('queued')
    expect(employeeState(employee('a'), [task('t1', { state: 'FAILED' })])).toBe('blocked')
    // 词表外不猜。
    expect(employeeState(employee('a'), [task('t1', { state: 'PAUSED_BY_OPERATOR' })])).toBe('unknown')
  })

  it('只看自己的任务', () => {
    const tasks = [task('t1', { assignee_user_id: 'b', state: 'FAILED' })]
    expect(employeeState(employee('a'), tasks)).toBe('unknown')
  })
})

describe('bindAgents', () => {
  it('只认 ownerUserId，绝不按名字猜', () => {
    const employees = [employee('a', { name: '林悦' })]
    const agents = [
      agent('规划 Agent', { ownerUserId: 'a' }),
      // 名字与员工同名也不绑定：名字会重名会改，不是键。
      agent('林悦'),
    ]
    const { byEmployee, unbound } = bindAgents(agents, employees)
    expect(byEmployee.get('a')?.map(item => item.name)).toEqual(['规划 Agent'])
    expect(unbound.map(item => item.name)).toEqual(['林悦'])
  })

  it('指向不存在员工的绑定进「未绑定」，而不是挂到一个幽灵员工上', () => {
    // 两种错法的可见度差很多：前者在图上是一块显眼的「未绑定」，
    // 后者是一根指向空气的线。
    const { byEmployee, unbound } = bindAgents([agent('x', { ownerUserId: 'nobody' })], [employee('a')])
    expect(byEmployee.size).toBe(0)
    expect(unbound).toHaveLength(1)
  })

  it('空白串按未绑定处理', () => {
    const { unbound } = bindAgents([agent('x', { ownerUserId: '   ' })], [employee('a')])
    expect(unbound).toHaveLength(1)
  })
})

describe('layoutCollaboration', () => {
  const employees = [employee('a'), employee('b'), employee('c')]
  const tasks = [
    task('t1', { assignee_user_id: 'a' }),
    task('t2', { assignee_user_id: 'b', intent_contract: { parent_task_id: 't1' } }),
    task('t3', { assignee_user_id: 'c', intent_contract: { parent_task_id: 't2' } }),
  ]
  const edges = employeeFlowEdges(tasks, new Set(['a', 'b', 'c']))

  it('深度由员工之间的上下游决定', () => {
    const { placed, depths } = layoutCollaboration(employees, edges, tasks)
    const depth = (id: string) => placed.find(node => node.id === id)?.depth
    expect(depth('a')).toBe(0)
    expect(depth('b')).toBe(1)
    expect(depth('c')).toBe(2)
    expect(depths).toBe(3)
  })

  it('越深越远越高，纵深就是这么来的', () => {
    const { placed } = layoutCollaboration(employees, edges, tasks)
    expect(placed.find(n => n.id === 'b')?.z).toBe(-NODE_DEPTH_Z)
    expect(placed.find(n => n.id === 'b')?.y).toBe(-NODE_LIFT_Y)
    expect(placed.find(n => n.id === 'a')?.y).toBe(0)
    expect(placed.find(n => n.id === 'a')?.z).toBe(0)
  })

  it('同一个员工永远落在同一个位置，与输入顺序无关', () => {
    // 这条性质是这张图能当运维视图用的前提：「右上角那个」必须对两个人是同一个意思。
    const shuffled = [employees[2]!, employees[0]!, employees[1]!]
    const position = (nodes: ReturnType<typeof layoutCollaboration>['placed'], id: string) => {
      const node = nodes.find(candidate => candidate.id === id)
      return { x: node?.x, y: node?.y, z: node?.z }
    }
    const first = layoutCollaboration(employees, edges, tasks).placed
    const second = layoutCollaboration(shuffled, edges, tasks).placed
    for (const id of ['a', 'b', 'c']) expect(position(second, id)).toEqual(position(first, id))
  })

  it('智能体挂在员工身上，未绑定的单独成区且一个都不丢', () => {
    const agents = [
      agent('规划 Agent', { ownerUserId: 'b' }),
      agent('质检 Agent', { ownerUserId: 'b' }),
      agent('野的 Agent'),
    ]
    const { placed, unbound } = layoutCollaboration(employees, edges, tasks, agents)
    expect(placed.find(n => n.id === 'b')?.agents.map(x => x.name)).toEqual(['规划 Agent', '质检 Agent'])
    expect(unbound.map(x => x.name)).toEqual(['野的 Agent'])
    // 总数守恒：挂上的 + 未绑定的 = 输入的。丢一个就等于悄悄藏起了一个智能体。
    expect(placed.reduce((sum, node) => sum + node.agents.length, 0) + unbound.length).toBe(agents.length)
  })

  it('注册节点状态随员工带出', () => {
    const withNodes = [employee('a', { nodes: [{ id: 'n1', status: 'ONLINE' }, { id: 'n2', status: 'OFFLINE' }] })]
    const node = layoutCollaboration(withNodes, [], []).placed[0]
    expect(node?.nodeCount).toBe(2)
    expect(node?.onlineNodes).toBe(1)
  })

  it('成环也能终止，且不丢节点', () => {
    // 理论上不该有环，但数据来自网络；「理论上不该有」不是让渲染挂死的理由。
    const cyclic = [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }]
    const { placed } = layoutCollaboration([employee('a'), employee('b')], cyclic, [])
    expect(placed).toHaveLength(2)
  })

  it('空输入给出空图', () => {
    const { placed, edges: resultEdges, unbound, depths } = layoutCollaboration([], [], [])
    expect(placed).toEqual([])
    expect(resultEdges).toEqual([])
    expect(unbound).toEqual([])
    expect(depths).toBe(0)
  })
})

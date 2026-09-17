/**
 * @lumo/agent-teams 领域模型 —— docs/architecture.md §7.3「协同拓扑
 * （`ctx.agentTeams`：roster + task board(DAG) + mailbox）」的任务板与名册部分。
 *
 * 本模块**只有纯函数与纯数据**：入参 `TeamState`，返回**新的** `TeamState`；
 * 零 IO、零 ctx、零时钟（`now` 由调用方传入）。
 *
 * 为什么这样切：任务语义（依赖解析、状态迁移、防环）与部署形态（单机 / 集群）
 * 是正交的两件事。把前者做成纯函数，后者就只剩两处差异 —— roster 的 provider 探测
 * 与 store 的介质 —— 不渗进任务语义。这是同一份任务板逻辑能在 SQLite 单机与
 * PostgreSQL 集群下都成立的原因，也是它能被完整单测的原因。
 *
 * 与两个现成实现的关系：任务模型取 `@nanmicoder/dsh-agent-teams` 的骨架
 * （id/subject/status/assignee/dependencies/attempt/output），**去掉**它绑定
 * continuable 子代理的字段（handoffId / reassigning / attemptId 等）。
 * 平台集群 wire（shared/seam-contracts/subagent-host.ts）明确只支持 one-shot
 * spawn，continuable 的 seed 传输在范围外；依赖那些字段就等于放弃集群形态。
 *
 * 上游 `@deepseek-ai/dsh-experimental-agent-team` 是同一个结论的另一个样本：
 * 它的任务用 revision CAS 而不是执行代数，成员同样经 `startContinuable` 建立，
 * 且绑定 session log 与 projection —— 单进程内很完整，但跨不了节点。本模块的
 * `attempt` 是「一次派发」的代数，改派/退回都会递增，用来作废迟到写回。
 */

/** 任务生命周期。顺序即推进方向。 */
export type TaskStatus = 'pending' | 'claimed' | 'in_progress' | 'completed' | 'failed' | 'cancelled'

/** 到达这些状态后任务不再可被认领或推进。 */
export const TERMINAL_TASK_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled']

/** 成员生命周期。`removed` 是终态。 */
export type MemberStatus = 'idle' | 'working' | 'removed'

/**
 * 协同拓扑（§7.3 的三行表）。它决定**种子任务图**长什么样，不改变任务语义：
 * 三种拓扑跑的是同一套依赖解析与认领规则。
 */
export type Topology =
  /** 层级 Planner-Worker：一个 planner 拆 DAG，多 worker claim。 */
  | 'planner-worker'
  /** 流水线 Pipeline：subtask 间 `deps[]` 串联。 */
  | 'pipeline'
  /** 议会 Deliberation：多 agent 并行出观点，planner 收敛。 */
  | 'deliberation'

export const TOPOLOGIES: readonly Topology[] = ['planner-worker', 'pipeline', 'deliberation']

/** 一个团队成员：名册条目。成员身份是**名字**，不是会话 id —— 见 `TeamMember` 注释。 */
export interface TeamMember {
  /** 团队内唯一显示名。任务只按名字指派，跨形态稳定。 */
  name: string
  /** 角色描述，例如 `researcher` / `engineer` / `reviewer`。 */
  role?: string
  /** 该成员派发时实际使用的 provider 名（由 roster 探测后写回）。 */
  provider: string
  /** 该成员解析到的模型，缺省表示继承船长路由。 */
  model?: string
  /**
   * 这名成员**为哪个员工工作**（`governance_users.id`）。
   *
   * 加这个字段是因为协作视图要把「智能体」挂到「注册节点的员工」下面，而在此之前
   * **两边没有任何共同的键**：成员只有名字/角色/provider/模型，团队又是由模型通过工具
   * 创建的，平台代码并不参与，所以没有任何地方知道这名成员属于谁。名字不是键——它会重名、
   * 会改；会话 id 也不通用（单机形态是临时子代理，集群形态在别的节点上）。
   *
   * **缺省表示「未绑定」，而不是「猜一个人」**：视图把这名成员放进「未绑定」区。
   * 一个挂错人的智能体比一个没挂的更难发现——它看起来是正常的。
   */
  ownerUserId?: string
  status: MemberStatus
  joinedAt: number
}

/**
 * 一条任务。
 *
 * 注意 `assignee` 是**成员名**而非会话 id：单机形态下子代理是本进程的临时
 * Agent，集群形态下它在别的节点上，两者没有共同的会话标识可写。名字是唯一
 * 在两种形态下都稳定、且可跨进程重启复现的键。
 */
export interface TeamTask {
  /** 团队内稳定 id（`t1`、`t2`…）。 */
  id: string
  subject: string
  description?: string
  status: TaskStatus
  /** 成员名；缺省表示待认领。 */
  assignee?: string
  /** 必须先 `completed` 的任务 id。 */
  dependencies: string[]
  /** 执行者写回的结果，完成或失败时置入。 */
  output?: string
  /** 单调递增的执行代数；重新指派使更早的尝试失效。 */
  attempt: number
  createdAt: number
  updatedAt: number
}

/** 完整团队记录（可持久化单元）。 */
export interface TeamState {
  /** 稳定团队 id（同时是存储键）。 */
  id: string
  name: string
  description?: string
  topology: Topology
  /** 拥有本团队的船长会话 id。 */
  captainSessionId: string
  /** 仅成员；船长是隐式的（即拥有会话本身）。 */
  members: TeamMember[]
  tasks: TeamTask[]
  /** 单调任务 id 计数器。 */
  taskSeq: number
  createdAt: number
}

/** 失败即抛：任务板上的非法操作是调用方 bug，不是可降级情形。 */
export class TeamError extends Error {
  constructor(message: string, readonly code: TeamErrorCode) {
    super(message)
    this.name = 'TeamError'
  }
}

export type TeamErrorCode =
  /** 引用了不存在的任务 / 成员。 */
  | 'NOT_FOUND'
  /** 依赖图有环，或引用了不存在的依赖。 */
  | 'BAD_GRAPH'
  /** 状态不允许该迁移（例如认领已完成的任务）。 */
  | 'BAD_STATE'
  /** 团队成员名重复。 */
  | 'DUPLICATE_MEMBER'
  /** 团队 id 已被占用。 */
  | 'DUPLICATE_TEAM'
  /** 非该任务的指派者试图更新它。 */
  | 'NOT_ASSIGNEE'

/** 建任务的输入。`dependencies` 可引用同一批次里更早出现的 id。 */
export interface NewTaskInput {
  subject: string
  description?: string
  assignee?: string
  dependencies?: readonly string[]
}

/** 查找一条任务，缺失即抛。 */
export function taskById(team: TeamState, taskId: string): TeamTask {
  const task = team.tasks.find(candidate => candidate.id === taskId)
  if (task === undefined) {
    throw new TeamError(`团队 ${team.id} 没有任务 ${taskId}`, 'NOT_FOUND')
  }
  return task
}

/** 查找一名成员，缺失即抛。 */
export function memberByName(team: TeamState, name: string): TeamMember {
  const member = team.members.find(candidate => candidate.name === name)
  if (member === undefined) {
    throw new TeamError(`团队 ${team.id} 没有成员 ${name}`, 'NOT_FOUND')
  }
  return member
}

/** 一条任务当前未满足的依赖（按声明顺序）。空数组即依赖已齐。 */
export function blockersOf(team: TeamState, task: TeamTask): string[] {
  return task.dependencies.filter((depId) => {
    const dep = team.tasks.find(candidate => candidate.id === depId)
    // 依赖缺失按「未满足」处理而不是抛错：读路径不该因为一条脏记录整块失败，
    // 而 `assertDependencyGraph` 会在写入路径把它拦下。
    return dep === undefined || dep.status !== 'completed'
  })
}

/**
 * 依赖已齐、尚未开始的任务。这是 DAG 的「前沿」。
 *
 * 已取消/失败/完成的任务不在其中；`claimed`/`in_progress` 也不在 —— 它们已在
 * 别人的手里，重复出现在前沿会让两个 worker 抢同一条任务。
 */
export function readyTasks(team: TeamState): TeamTask[] {
  return team.tasks.filter(task => task.status === 'pending' && blockersOf(team, task).length === 0)
}

/**
 * 某成员此刻可以认领的任务：依赖已齐、且（未指派或已指派给它）。
 * 已指派给别人的任务**不出现** —— 认领必须显式改派，不能静默抢。
 */
export function claimableBy(team: TeamState, memberName: string): TeamTask[] {
  return readyTasks(team).filter(task => task.assignee === undefined || task.assignee === memberName)
}

/**
 * 校验依赖图：每个依赖 id 必须存在，且不得成环。
 *
 * 建图与写入路径调用它；环会死锁整个 DAG（前沿永远为空，团队静默卡住），
 * 所以宁可在写入时红，也不留一个永远跑不动的团队。
 */
export function assertDependencyGraph(tasks: readonly TeamTask[]): void {
  const ids = new Set(tasks.map(task => task.id))
  for (const task of tasks) {
    for (const dep of task.dependencies) {
      if (!ids.has(dep)) {
        throw new TeamError(`任务 ${task.id} 依赖不存在的任务 ${dep}`, 'BAD_GRAPH')
      }
      if (dep === task.id) {
        throw new TeamError(`任务 ${task.id} 依赖自身`, 'BAD_GRAPH')
      }
    }
  }
  // 三色 DFS：灰 = 在当前递归栈上，命中灰即环。
  const WHITE = 0, GREY = 1, BLACK = 2
  const color = new Map<string, number>(tasks.map(task => [task.id, WHITE]))
  const byId = new Map(tasks.map(task => [task.id, task]))
  const visit = (id: string, path: readonly string[]): void => {
    color.set(id, GREY)
    const task = byId.get(id)
    for (const dep of task?.dependencies ?? []) {
      if (color.get(dep) === GREY) {
        throw new TeamError(`任务依赖成环：${[...path, id, dep].join(' → ')}`, 'BAD_GRAPH')
      }
      if (color.get(dep) === WHITE) visit(dep, [...path, id])
    }
    color.set(id, BLACK)
  }
  for (const task of tasks) {
    if (color.get(task.id) === WHITE) visit(task.id, [])
  }
}

/** 追加一条任务。返回新状态；依赖图非法则抛。 */
export function addTask(team: TeamState, input: NewTaskInput, now: number): { team: TeamState; task: TeamTask } {
  const seq = team.taskSeq + 1
  const task: TeamTask = {
    id: `t${seq}`,
    subject: input.subject,
    ...input.description === undefined ? {} : { description: input.description },
    status: 'pending',
    ...input.assignee === undefined ? {} : { assignee: input.assignee },
    dependencies: [...(input.dependencies ?? [])],
    attempt: 0,
    createdAt: now,
    updatedAt: now,
  }
  if (input.assignee !== undefined) memberByName(team, input.assignee)
  const tasks = [...team.tasks, task]
  assertDependencyGraph(tasks)
  return { team: { ...team, tasks, taskSeq: seq }, task }
}

/** 批量建任务（同一批次内可互相依赖）。任一非法则整批不落地。 */
export function addTasks(team: TeamState, inputs: readonly NewTaskInput[], now: number): { team: TeamState; tasks: TeamTask[] } {
  let current = team
  const created: TeamTask[] = []
  for (const input of inputs) {
    const result = addTask(current, input, now)
    current = result.team
    created.push(result.task)
  }
  return { team: current, tasks: created }
}

/** 加入一名成员。名字重复即抛。 */
export function addMember(
  team: TeamState,
  member: Omit<TeamMember, 'status' | 'joinedAt'> & { status?: MemberStatus },
  now: number,
): TeamState {
  if (team.members.some(candidate => candidate.name === member.name)) {
    throw new TeamError(`团队 ${team.id} 已有成员 ${member.name}`, 'DUPLICATE_MEMBER')
  }
  const entry: TeamMember = {
    ...member,
    status: member.status ?? 'idle',
    joinedAt: now,
  }
  return { ...team, members: [...team.members, entry] }
}

/** 移除一名成员。其名下未完成任务退回待认领，避免任务跟着成员一起消失。 */
export function removeMember(team: TeamState, name: string, now: number): TeamState {
  memberByName(team, name)
  return {
    ...team,
    members: team.members.filter(candidate => candidate.name !== name),
    tasks: team.tasks.map(task => (task.assignee === name && !TERMINAL_TASK_STATUSES.includes(task.status)
      ? { ...task, assignee: undefined, status: 'pending', attempt: task.attempt + 1, updatedAt: now }
      : task)),
  }
}

/** 用 id 替换一条任务。 */
function replaceTask(team: TeamState, next: TeamTask): TeamState {
  return { ...team, tasks: team.tasks.map(task => (task.id === next.id ? next : task)) }
}

/** 置成员状态（认领/完成时联动）。 */
function setMemberStatus(team: TeamState, name: string, status: MemberStatus): TeamState {
  return {
    ...team,
    members: team.members.map(member => (member.name === name ? { ...member, status } : member)),
  }
}

/**
 * 认领一条任务。
 *
 * 三条守卫都在这里：依赖必须已齐（否则 DAG 语义失效）、任务必须处于 `pending`、
 * 且不得已被别人认领。`attempt` 递增使更早的尝试失效 —— 这是重试/改派后
 * 「旧执行者的写回不得覆盖新执行者」的依据。
 */
export function claimTask(team: TeamState, taskId: string, memberName: string, now: number): TeamState {
  const task = taskById(team, taskId)
  memberByName(team, memberName)
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    throw new TeamError(`任务 ${taskId} 已终结（${task.status}），不可认领`, 'BAD_STATE')
  }
  if (task.status !== 'pending') {
    throw new TeamError(`任务 ${taskId} 已被认领（${task.status}）`, 'BAD_STATE')
  }
  if (task.assignee !== undefined && task.assignee !== memberName) {
    throw new TeamError(`任务 ${taskId} 已指派给 ${task.assignee}`, 'BAD_STATE')
  }
  const blockers = blockersOf(team, task)
  if (blockers.length > 0) {
    throw new TeamError(`任务 ${taskId} 的依赖未完成：${blockers.join(', ')}`, 'BAD_STATE')
  }
  const next = setMemberStatus(replaceTask(team, {
    ...task,
    status: 'claimed',
    assignee: memberName,
    attempt: task.attempt + 1,
    updatedAt: now,
  }), memberName, 'working')
  return next
}

/** 把认领的任务标记为执行中。 */
export function startTask(team: TeamState, taskId: string, memberName: string, now: number): TeamState {
  const task = taskById(team, taskId)
  assertAssignee(task, memberName)
  if (task.status !== 'claimed') {
    throw new TeamError(`任务 ${taskId} 不在 claimed（当前 ${task.status}），不可开工`, 'BAD_STATE')
  }
  return replaceTask(team, { ...task, status: 'in_progress', updatedAt: now })
}

/** 认领者校验：只有当前 `assignee` 能推进任务。 */
function assertAssignee(task: TeamTask, memberName: string): void {
  if (task.assignee !== memberName) {
    throw new TeamError(
      `任务 ${task.id} 的指派者是 ${task.assignee ?? '(无)'}，${memberName} 无权更新`,
      'NOT_ASSIGNEE',
    )
  }
}

/**
 * 完成任务并写回结果。
 *
 * `attempt` 可传：执行者带着自己认领时的代数回来，代数不符即拒绝 —— 这正是
 * 防止「已被改派的旧执行者迟到写回」覆盖新结果的那道闸。
 */
export function completeTask(
  team: TeamState,
  taskId: string,
  memberName: string,
  output: string,
  now: number,
  attempt?: number,
): TeamState {
  const task = taskById(team, taskId)
  assertAssignee(task, memberName)
  if (task.status !== 'claimed' && task.status !== 'in_progress') {
    throw new TeamError(`任务 ${taskId} 不在执行中（当前 ${task.status}），不可完成`, 'BAD_STATE')
  }
  if (attempt !== undefined && attempt !== task.attempt) {
    throw new TeamError(
      `任务 ${taskId} 的尝试代数已变为 ${task.attempt}（提交的是 ${attempt}），本次写回作废`,
      'BAD_STATE',
    )
  }
  return setMemberStatus(replaceTask(team, {
    ...task,
    status: 'completed',
    output,
    updatedAt: now,
  }), memberName, 'idle')
}

/** 标记任务失败。同样受指派者与代数守卫。 */
export function failTask(
  team: TeamState,
  taskId: string,
  memberName: string,
  output: string,
  now: number,
  attempt?: number,
): TeamState {
  const task = taskById(team, taskId)
  assertAssignee(task, memberName)
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    throw new TeamError(`任务 ${taskId} 已终结（${task.status}）`, 'BAD_STATE')
  }
  if (attempt !== undefined && attempt !== task.attempt) {
    throw new TeamError(
      `任务 ${taskId} 的尝试代数已变为 ${task.attempt}（提交的是 ${attempt}），本次写回作废`,
      'BAD_STATE',
    )
  }
  return setMemberStatus(replaceTask(team, {
    ...task,
    status: 'failed',
    output,
    updatedAt: now,
  }), memberName, 'idle')
}

/** 取消任务（船长或指派者）。取消是终态，但不影响依赖它的任务被人工改图。 */
export function cancelTask(team: TeamState, taskId: string, now: number): TeamState {
  const task = taskById(team, taskId)
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    throw new TeamError(`任务 ${taskId} 已终结（${task.status}）`, 'BAD_STATE')
  }
  const next = replaceTask(team, { ...task, status: 'cancelled', updatedAt: now })
  return task.assignee === undefined ? next : setMemberStatus(next, task.assignee, 'idle')
}

/** 把任务改派给另一名成员；`attempt` 递增使旧执行者的写回失效。 */
export function reassignTask(team: TeamState, taskId: string, memberName: string, now: number): TeamState {
  const task = taskById(team, taskId)
  memberByName(team, memberName)
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    throw new TeamError(`任务 ${taskId} 已终结（${task.status}），不可改派`, 'BAD_STATE')
  }
  const previous = task.assignee
  const next = replaceTask(team, {
    ...task,
    assignee: memberName,
    status: 'pending',
    attempt: task.attempt + 1,
    updatedAt: now,
  })
  // 旧执行者若还在 working，退回 idle —— 它的写回已被代数闸作废。
  return previous === undefined || previous === memberName ? next : setMemberStatus(next, previous, 'idle')
}

/**
 * 把一条执行中的任务退回待认领（对账用）。
 *
 * 与 `reassignTask` 的区别：**不改指派**（还是原来那位），因为退回的语义是「这次
 * 派发失联了，重来一次」而不是「换个人做」。但同样递增 `attempt` —— 于是那次失联
 * 派发的迟到写回会被代数闸作废，不会覆盖重来的结果。
 *
 * 典型触发：派发者进程重启、承载节点掉线 —— 任务停在 `claimed`/`in_progress`
 * 而通道已死（`AgentTeamsService.reconcile`）。
 */
export function requeueTask(team: TeamState, taskId: string, now: number): TeamState {
  const task = taskById(team, taskId)
  if (TERMINAL_TASK_STATUSES.includes(task.status)) {
    throw new TeamError(`任务 ${taskId} 已终结（${task.status}），不可退回`, 'BAD_STATE')
  }
  if (task.status === 'pending') {
    throw new TeamError(`任务 ${taskId} 已是待认领，无需退回`, 'BAD_STATE')
  }
  const next = replaceTask(team, {
    ...task,
    status: 'pending',
    attempt: task.attempt + 1,
    updatedAt: now,
  })
  return task.assignee === undefined ? next : setMemberStatus(next, task.assignee, 'idle')
}

/** 团队进度概览（给 `status` 工具与运维面用）。 */
export interface TeamProgress {
  total: number
  pending: number
  active: number
  completed: number
  failed: number
  cancelled: number
  /** 依赖已齐、可被立即认领的任务 id。 */
  ready: string[]
  /** 因依赖未齐或无人可派而暂时动不了的任务 id。 */
  blocked: string[]
}

/** 汇总进度。`ready` 是调度器真正要看的那个数。 */
export function teamProgress(team: TeamState): TeamProgress {
  const counts: Record<TaskStatus, number> = {
    pending: 0, claimed: 0, in_progress: 0, completed: 0, failed: 0, cancelled: 0,
  }
  for (const task of team.tasks) counts[task.status] += 1
  const ready = readyTasks(team)
  const readyIds = new Set(ready.map(task => task.id))
  return {
    total: team.tasks.length,
    pending: counts.pending,
    active: counts.claimed + counts.in_progress,
    completed: counts.completed,
    failed: counts.failed,
    cancelled: counts.cancelled,
    ready: ready.map(task => task.id),
    blocked: team.tasks
      .filter(task => task.status === 'pending' && !readyIds.has(task.id))
      .map(task => task.id),
  }
}

/** 判定整个团队是否已收敛：所有任务都到达终态。 */
export function isSettled(team: TeamState): boolean {
  return team.tasks.every(task => TERMINAL_TASK_STATUSES.includes(task.status))
}

/** 创建空团队。 */
export function createTeam(input: {
  id: string
  name: string
  description?: string
  topology: Topology
  captainSessionId: string
  now: number
}): TeamState {
  return {
    id: input.id,
    name: input.name,
    ...input.description === undefined ? {} : { description: input.description },
    topology: input.topology,
    captainSessionId: input.captainSessionId,
    members: [],
    tasks: [],
    taskSeq: 0,
    createdAt: input.now,
  }
}

/**
 * 按拓扑生成种子任务图（§7.3 的三行表）。
 *
 * 三种拓扑共用同一套任务语义，区别只在依赖边的形状：
 * - `planner-worker`：1 条规划任务 → N 条并行执行任务（都依赖规划）。
 * - `pipeline`：链式，每条依赖前一条。
 * - `deliberation`：N 条并行观点任务 → 1 条收敛任务（依赖全部观点）。
 *
 * `subjects` 是用户/船长给出的任务主题列表，含义随拓扑不同（执行项 / 阶段 / 议题）。
 */
export function seedTasks(topology: Topology, subjects: readonly string[]): NewTaskInput[] {
  if (subjects.length === 0) {
    throw new TeamError('种子任务至少需要一个主题', 'BAD_STATE')
  }
  switch (topology) {
    case 'planner-worker': {
      const plan: NewTaskInput = { subject: '规划：拆解目标并确定执行项', dependencies: [] }
      return [plan, ...subjects.map(subject => ({ subject, dependencies: ['t1'] }))]
    }
    case 'pipeline': {
      return subjects.map((subject, index) => ({
        subject,
        dependencies: index === 0 ? [] : [`t${index}`],
      }))
    }
    case 'deliberation': {
      const opinions: NewTaskInput[] = subjects.map(subject => ({ subject: `观点：${subject}`, dependencies: [] }))
      const converge: NewTaskInput = {
        subject: '收敛：汇总观点并给出结论',
        dependencies: opinions.map((_, index) => `t${index + 1}`),
      }
      return [...opinions, converge]
    }
  }
}

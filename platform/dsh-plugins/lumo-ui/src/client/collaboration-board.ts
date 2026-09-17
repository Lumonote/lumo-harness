/**
 * 任务板视图：**节点是任务，边是任务之间的依赖**。
 *
 * 与 `collaboration-layout.ts`（员工视图）的分工：那边回答「谁在等谁」，这边回答
 * 「哪一条卡住了」。两者共用同一套几何常量，所以切换视图时同一件事不会跳到别处。
 *
 * 数据直接来自 `ctx.agentTeams.status()` 的 `team.tasks` 与 `progress`——**依赖是真的**，
 * 不是从别的字段推出来的。这一点值得写在文件头：本仓库曾经因为「只在 governance 里搜」
 * 而把依赖记成「没有数据源」，而它一直都在这里。
 *
 * 纯函数、无 IO、无 React：位置必须只由输入决定，否则「右上角那个」又会失效。
 */
import { NODE_DEPTH_Z, NODE_LIFT_Y, NODE_SPACING_X } from './collaboration-layout.ts'

/** `TeamTask` 里本视图用得上的部分。 */
export interface BoardTaskInput {
  id: string
  subject: string
  status: string
  assignee?: string
  dependencies?: string[]
}

/**
 * `teamProgress()` 的两个派生集合。
 *
 * 用它们而不是自己重算：`ready`/`blocked` 的判据（依赖已齐、且有人可派）是 agent-teams
 * 自己的定义，在这边重算就会有两份会分叉的规则——而分叉的那天，图上会开始说谎。
 */
export interface TeamProgressInput {
  ready?: string[]
  blocked?: string[]
}

export type BoardTaskState =
  /** 依赖已齐、可被立即认领 */
  | 'ready'
  /** 依赖未齐或无人可派 */
  | 'blocked'
  /** 已被认领 / 执行中 */
  | 'executing'
  | 'delivered'
  | 'failed'
  /** pending 但既不在 ready 也不在 blocked —— 理论上不该出现，但数据来自网络 */
  | 'queued'
  | 'unknown'

export interface PlacedTask {
  id: string
  subject: string
  assignee: string
  state: BoardTaskState
  /** 依赖链深度：0 是最上游。 */
  depth: number
  x: number
  y: number
  z: number
}

export interface TaskBoardEdge {
  from: string
  to: string
}

export interface TaskBoard {
  placed: PlacedTask[]
  edges: TaskBoardEdge[]
  depths: number
}

function normalise(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase()
}

function depthOffset(depth: number, per: number): number {
  return depth === 0 ? 0 : -depth * per
}

/**
 * 一条任务该被画成什么状态。
 *
 * **`ready` 与 `blocked` 优先于状态字面量**：两者都是 `pending`，区别只在依赖是否已齐——
 * 而「现在就能认领」与「卡住了」是这张图上唯一值得区分的两件事。用状态字面量会把它们
 * 画成同一个颜色，等于把这张图存在的理由抹掉。
 *
 * 终态（completed/failed/cancelled）不走 ready/blocked：一条已完成的任务不该因为它的 id
 * 出现在某个派生集合里就改变颜色。
 */
export function boardTaskState(task: BoardTaskInput, progress?: TeamProgressInput | null): BoardTaskState {
  const status = normalise(task.status)
  if (status === 'completed') return 'delivered'
  if (status === 'failed' || status === 'cancelled') return 'failed'
  if (status === 'claimed' || status === 'in_progress') return 'executing'
  if (status === 'pending') {
    if (progress?.ready?.includes(task.id) === true) return 'ready'
    if (progress?.blocked?.includes(task.id) === true) return 'blocked'
    return 'queued'
  }
  // 词表外不猜。
  return 'unknown'
}

/**
 * 把任务摆到空间里。
 *
 * 纵深 = 依赖链深度（最长路径松弛，带环终止上界）。同深度按 **id 排序后居中**：
 * 同一批数据换个顺序请求，位置必须不变。
 *
 * 一个刻意的选择：**依赖指向集合外的任务时，那条边不画，但任务留下**。父任务可能是被
 * 分页截掉或已被删除；画一条指向空气的线会读成「上游还没开始」，而删掉这个任务会读成
 * 「它不存在」——两者都比少画一条边更坏。
 */
export function layoutTaskBoard(
  tasks: readonly BoardTaskInput[],
  progress?: TeamProgressInput | null,
): TaskBoard {
  const byId = new Map(tasks.map(task => [task.id, task]))
  const edges: TaskBoardEdge[] = []
  for (const task of tasks) {
    for (const dependency of task.dependencies ?? []) {
      if (byId.has(dependency)) edges.push({ from: dependency, to: task.id })
    }
  }

  const depth = new Map(tasks.map(task => [task.id, 0]))
  for (let round = 0; round < tasks.length; round += 1) {
    let changed = false
    for (const edge of edges) {
      const from = depth.get(edge.from)
      const to = depth.get(edge.to)
      if (from === undefined || to === undefined) continue
      if (to < from + 1) {
        depth.set(edge.to, from + 1)
        changed = true
      }
    }
    if (!changed) break
  }

  const grouped = new Map<number, BoardTaskInput[]>()
  for (const task of tasks) {
    const level = depth.get(task.id) ?? 0
    const bucket = grouped.get(level)
    if (bucket === undefined) grouped.set(level, [task])
    else bucket.push(task)
  }

  const placed: PlacedTask[] = []
  for (const [level, bucket] of grouped) {
    const ordered = [...bucket].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
    const offset = (ordered.length - 1) / 2
    ordered.forEach((task, index) => {
      placed.push({
        id: task.id,
        subject: task.subject,
        // 未指派显示成「待认领」，而不是空白：空白读起来像数据缺失，
        // 而这里是一个明确的状态。
        assignee: task.assignee?.trim() === undefined || task.assignee.trim() === '' ? '待认领' : task.assignee,
        state: boardTaskState(task, progress),
        depth: level,
        x: (index - offset) * NODE_SPACING_X,
        y: depthOffset(level, NODE_LIFT_Y),
        z: depthOffset(level, NODE_DEPTH_Z),
      })
    })
  }

  return { placed, edges, depths: grouped.size }
}

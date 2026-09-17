/**
 * @lumo/agent-teams 的模型工具面 —— `agent_teams_*`。
 *
 * ## 为什么这一面比 agent-teams 少
 *
 * 参考实现（`@nanmicoder/dsh-agent-teams`）有 13 个工具，其中
 * `agent_teams_claim_task` / `agent_teams_update_task` / `agent_teams_send_message`
 * 是**给成员用的** —— 它的成员是 continuable 子代理，能自己认领任务、自己推进状态、
 * 自己给船长发消息。本插件的成员是 **one-shot**（见 `roster.ts` 的理由：平台集群 wire
 * 只覆盖 one-shot spawn），一次派发跑完即收，拿不到工具面、也不会有下一次 turn。
 *
 * 所以那一层工具在这里没有意义，取而代之的是 `agent_teams_run`：船长在一个动作里
 * 完成「认领 → 派发 → 写回」，成员的「汇报」就是它写回任务板的那段结论。
 * `send_message` 也随之不需要 —— 会合面（courier）承载的是**结局**而不是对话。
 *
 * 这一面只对船长开放，与参考实现一致：团队状态属于拥有它的会话。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { TOPOLOGIES, teamProgress, type TeamState, type Topology } from './model.ts'
import type { AgentTeamsService } from './service.ts'

/** 工具面的装配参数。所有上限都是**服务端**的，模型改不了。 */
export interface AgentTeamsToolConfig {
  /** `run` 单轮最多并行派发多少条；缺省不限。 */
  maxParallel?: number
  /** `run` 的轮次上限（防一个跑不收敛的团队把一次工具调用拖死）。 */
  maxRounds?: number
  /** `await_task` 的单次等待上限（模型不能要求「一直等」）。 */
  maxWaitMs?: number
}

/** 默认轮次上限。与 `runToSettle` 的缺省一致。 */
export const DEFAULT_TOOL_MAX_ROUNDS = 16
/** 默认单次等待上限。比会合面 TTL 短，好让模型拿到 expired 后能重试。 */
export const DEFAULT_TOOL_MAX_WAIT_MS = 120_000

/**
 * 把服务注册成模型可见的工具。
 *
 * @returns 注销函数，交给 `ctx.effect` 做清理。
 */
export function defineAgentTeamsTools(
  ctx: Context,
  service: AgentTeamsService,
  config: AgentTeamsToolConfig = {},
): () => void {
  const maxRounds = config.maxRounds ?? DEFAULT_TOOL_MAX_ROUNDS
  const maxWaitMs = config.maxWaitMs ?? DEFAULT_TOOL_MAX_WAIT_MS

  const create: ToolDefinition = {
    name: 'agent_teams_create',
    description:
      '建立一个多智能体团队，并按拓扑一次性铺好种子任务图。'
      + '建完还没有成员，也没有任何任务被执行 —— 接着用 agent_teams_add_member 加成员，'
      + '再用 agent_teams_run 开始推进。'
      + '拓扑含义：planner-worker = 先规划再并行执行；pipeline = 逐段串行；'
      + 'deliberation = 多人并行出观点后收敛。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识，只允许 [A-Za-z0-9_-]，建后不可改' },
        name: { type: 'string', description: '团队显示名' },
        description: { type: 'string', description: '团队目标；会写进每个成员的 prompt' },
        topology: { type: 'string', enum: [...TOPOLOGIES], description: '协同拓扑' },
        subjects: {
          type: 'array',
          items: { type: 'string' },
          description: '任务主题列表，含义随拓扑不同（执行项 / 阶段 / 议题）',
        },
      },
      required: ['teamId', 'name', 'topology', 'subjects'],
      additionalProperties: false,
    },
    output: { schema: TEAM_SCHEMA, render: renderJson },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const a = args as { teamId?: string; name?: string; description?: string; topology?: string; subjects?: unknown }
      const teamId = requireString(a.teamId, 'teamId', 'agent_teams_create')
      const name = requireString(a.name, 'name', 'agent_teams_create')
      const topology = requireTopology(a.topology, 'agent_teams_create')
      const subjects = requireStringArray(a.subjects, 'subjects', 'agent_teams_create')
      const team = await service.create({
        id: teamId,
        name,
        ...a.description === undefined ? {} : { description: a.description },
        topology,
        subjects,
        captainSessionId: captainOf(exec),
      })
      return summarize(team)
    },
  }

  const addMember: ToolDefinition = {
    name: 'agent_teams_add_member',
    description:
      '往团队里加一名成员。成员是**可重复派发的执行者**（不是常驻会话）：'
      + '每次被派发时新建一个子代理跑完即收，所以可以反复用同一个成员做多件事。'
      + '成员名在团队内唯一，任务按名字指派。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识' },
        name: { type: 'string', description: '成员名，团队内唯一' },
        role: { type: 'string', description: '角色描述，如 researcher / engineer / reviewer' },
        model: { type: 'string', description: '该成员使用的模型；缺省继承船长的路由' },
        ownerUserId: {
          type: 'string',
          description: '这名成员为哪个员工工作（`governance_users.id`）。'
            + '给定时，协作视图会把它挂到该员工名下；不给则归入「未绑定」。'
            + '**不要凭名字猜**：猜错会让智能体挂到一个错误的人下面，而那看起来是正常的。',
        },
      },
      required: ['teamId', 'name'],
      additionalProperties: false,
    },
    output: { schema: TEAM_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string; name?: string; role?: string; model?: string; ownerUserId?: string }
      const teamId = requireString(a.teamId, 'teamId', 'agent_teams_add_member')
      const name = requireString(a.name, 'name', 'agent_teams_add_member')
      const team = await service.addMember(teamId, {
        name,
        ...a.role === undefined ? {} : { role: a.role },
        ...a.model === undefined ? {} : { model: a.model },
        ...a.ownerUserId === undefined ? {} : { ownerUserId: a.ownerUserId },
      })
      return summarize(team)
    },
  }

  const removeMember: ToolDefinition = {
    name: 'agent_teams_remove_member',
    description:
      '移除一名成员。它名下未完成的任务会退回待认领（不会跟着成员一起消失），'
      + '需要时用 agent_teams_reassign_task 指派给别人。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识' },
        name: { type: 'string', description: '要移除的成员名' },
      },
      required: ['teamId', 'name'],
      additionalProperties: false,
    },
    output: { schema: TEAM_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string; name?: string }
      const teamId = requireString(a.teamId, 'teamId', 'agent_teams_remove_member')
      const name = requireString(a.name, 'name', 'agent_teams_remove_member')
      return summarize(await service.removeMember(teamId, name))
    },
  }

  const createTask: ToolDefinition = {
    name: 'agent_teams_create_task',
    description:
      '往团队追加任务（可一次多条，构成一张 DAG）。'
      + 'dependencies 填同一批次里更早出现的任务 id（`t1`、`t2`…，也可引用已有任务）。'
      + '依赖成环或不存在的依赖会被整批拒绝。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识' },
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            required: ['subject'],
            properties: {
              subject: { type: 'string', description: '任务标题' },
              description: { type: 'string', description: '任务说明' },
              assignee: { type: 'string', description: '指派给某成员；缺省待认领' },
              dependencies: { type: 'array', items: { type: 'string' }, description: '前置任务 id' },
            },
            additionalProperties: false,
          },
        },
      },
      required: ['teamId', 'tasks'],
      additionalProperties: false,
    },
    output: { schema: TEAM_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string; tasks?: unknown }
      const teamId = requireString(a.teamId, 'teamId', 'agent_teams_create_task')
      if (!Array.isArray(a.tasks) || a.tasks.length === 0) {
        throw new Error('agent_teams_create_task: tasks 必须是非空数组')
      }
      const tasks = a.tasks.map((entry, index) => {
        if (typeof entry !== 'object' || entry === null) {
          throw new Error(`agent_teams_create_task: tasks[${index}] 不是对象`)
        }
        const raw = entry as Record<string, unknown>
        return {
          subject: requireString(raw['subject'], `tasks[${index}].subject`, 'agent_teams_create_task'),
          ...raw['description'] === undefined ? {} : { description: String(raw['description']) },
          ...raw['assignee'] === undefined ? {} : { assignee: String(raw['assignee']) },
          ...raw['dependencies'] === undefined
            ? {}
            : { dependencies: requireStringArray(raw['dependencies'], `tasks[${index}].dependencies`, 'agent_teams_create_task') },
        }
      })
      return summarize(await service.addTasks(teamId, tasks))
    },
  }

  const reassign: ToolDefinition = {
    name: 'agent_teams_reassign_task',
    description:
      '把任务改派给另一名成员。改派会作废**上一次执行的迟到写回**'
      + '（执行代数递增），所以旧执行者即便晚一点返回也不会覆盖新结果。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识' },
        taskId: { type: 'string', description: '任务 id，如 t2' },
        member: { type: 'string', description: '改派给谁' },
      },
      required: ['teamId', 'taskId', 'member'],
      additionalProperties: false,
    },
    output: { schema: TEAM_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string; taskId?: string; member?: string }
      return summarize(await service.reassign(
        requireString(a.teamId, 'teamId', 'agent_teams_reassign_task'),
        requireString(a.taskId, 'taskId', 'agent_teams_reassign_task'),
        requireString(a.member, 'member', 'agent_teams_reassign_task'),
      ))
    },
  }

  const cancelTask: ToolDefinition = {
    name: 'agent_teams_cancel_task',
    description: '取消一条任务（终态）。依赖它的任务会一直缺依赖，需要人工改图或一并取消。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识' },
        taskId: { type: 'string', description: '任务 id' },
      },
      required: ['teamId', 'taskId'],
      additionalProperties: false,
    },
    output: { schema: TEAM_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string; taskId?: string }
      return summarize(await service.cancel(
        requireString(a.teamId, 'teamId', 'agent_teams_cancel_task'),
        requireString(a.taskId, 'taskId', 'agent_teams_cancel_task'),
      ))
    },
  }

  const run: ToolDefinition = {
    name: 'agent_teams_run',
    description:
      '推进团队：反复「认领依赖已齐的任务 → 并行派发给成员 → 把结论写回任务板」，'
      + '直到全部任务到达终态、没有可推进的任务、或达到轮次上限。'
      + '这是唯一真正会消耗子代理的工具 —— 调用前先用 agent_teams_status 确认名册与任务图符合预期。'
      + '返回里每个成员任务的 text 就是它的结论，可直接用来回答用户。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识' },
        maxRounds: { type: 'number', description: `轮次上限（服务端上限 ${maxRounds}）` },
        limit: { type: 'number', description: '单轮最多并行派发多少条；缺省不限' },
      },
      required: ['teamId'],
      additionalProperties: false,
    },
    output: { schema: RUN_SCHEMA, render: renderJson },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const a = args as { teamId?: string; maxRounds?: number; limit?: number }
      const teamId = requireString(a.teamId, 'teamId', 'agent_teams_run')
      if (exec.agent === undefined) {
        throw new Error('agent_teams_run: 本次调用没有产生它的 agent，无法派发子代理')
      }
      const rounds = Math.min(Math.max(Math.trunc(a.maxRounds ?? maxRounds), 1), maxRounds)
      const result = await service.runToSettle({
        teamId,
        parent: exec.agent,
        signal: exec.signal,
        maxRounds: rounds,
        ...a.limit === undefined ? {} : { limit: Math.max(Math.trunc(a.limit), 1) },
      })
      const team = await service.get(teamId)
      return {
        teamId,
        settled: result.settled,
        rounds: result.rounds.map(round => ({
          dispatched: round.dispatched,
          more: round.more,
          settled: round.settled,
        })),
        progress: teamProgress(team),
        tasks: team.tasks.map(taskView),
      }
    },
  }

  const status: ToolDefinition = {
    name: 'agent_teams_status',
    description:
      '查团队状态：名册、任务板（含每条任务的结论）、进度，以及当前形态的能力画像'
      + '（成员在哪个 provider 上执行、团队状态与会合面是否持久）。'
      + '不给 teamId 就列出全部团队。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识；缺省列出全部团队' },
      },
      additionalProperties: false,
    },
    output: { schema: STATUS_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string }
      if (a.teamId === undefined || a.teamId === '') {
        const teams = await service.list()
        return {
          teams: teams.map(team => ({
            teamId: team.id,
            name: team.name,
            topology: team.topology,
            members: team.members.length,
            progress: teamProgress(team),
          })),
        }
      }
      const snapshot = await service.status(a.teamId)
      return {
        ...summarize(snapshot.team),
        settled: snapshot.settled,
        capabilities: snapshot.capabilities,
      }
    },
  }

  const awaitTask: ToolDefinition = {
    name: 'agent_teams_await_task',
    description:
      '等一次派发的结局（走持久会合面，所以「上一轮派发出去、或跑在别的节点上」的执行也能等回来）。'
      + '返回 resolved（含结论）、rejected（成员失败）或 expired。'
      + '**expired 不是「再等等」的信号**：说明那次派发在有效期内没有兑现，'
      + '应当 agent_teams_reconcile 后重跑，不要再进一次等待。',
    parameters: {
      type: 'object',
      properties: {
        teamId: { type: 'string', description: '团队标识' },
        taskId: { type: 'string', description: '任务 id' },
        attempt: { type: 'number', description: '执行代数；缺省用任务当前代数' },
        timeoutMs: { type: 'number', description: `本次等待上限毫秒（服务端上限 ${maxWaitMs}）` },
      },
      required: ['teamId', 'taskId'],
      additionalProperties: false,
    },
    output: { schema: WAIT_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string; taskId?: string; attempt?: number; timeoutMs?: number }
      const outcome = await service.awaitTask({
        teamId: requireString(a.teamId, 'teamId', 'agent_teams_await_task'),
        taskId: requireString(a.taskId, 'taskId', 'agent_teams_await_task'),
        ...a.attempt === undefined ? {} : { attempt: Math.trunc(a.attempt) },
        timeoutMs: Math.min(Math.max(Math.trunc(a.timeoutMs ?? maxWaitMs), 1_000), maxWaitMs),
      })
      return outcome
    },
  }

  const reconcile: ToolDefinition = {
    name: 'agent_teams_reconcile',
    description:
      '对账：把「派发者已经不在了」的任务退回待认领，让它们能被重新派发。'
      + '进程重启、承载节点掉线之后，任务会停在执行中而永远不会写回 —— 用这个把它们救回来。'
      + '仍在跑的任务不受影响。',
    parameters: {
      type: 'object',
      properties: { teamId: { type: 'string', description: '团队标识' } },
      required: ['teamId'],
      additionalProperties: false,
    },
    output: { schema: RECONCILE_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string }
      const teamId = requireString(a.teamId, 'teamId', 'agent_teams_reconcile')
      const result = await service.reconcile(teamId)
      return { teamId, ...result, ...summarize(await service.get(teamId)) }
    },
  }

  const remove: ToolDefinition = {
    name: 'agent_teams_delete',
    description:
      '删除团队及其任务板。只在结果已经交付给用户、且不再需要这个团队时调用 —— '
      + '删除是不可逆的，进行中的执行也会失去落点。',
    parameters: {
      type: 'object',
      properties: { teamId: { type: 'string', description: '团队标识' } },
      required: ['teamId'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        required: ['teamId', 'deleted'],
        properties: { teamId: { type: 'string' }, deleted: { type: 'boolean' } },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown): Promise<unknown> {
      const a = args as { teamId?: string }
      const teamId = requireString(a.teamId, 'teamId', 'agent_teams_delete')
      await service.remove(teamId)
      return { teamId, deleted: true }
    },
  }

  const definitions = [
    create, addMember, removeMember, createTask, reassign, cancelTask,
    run, status, awaitTask, reconcile, remove,
  ]
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

// ─────────────────────────────── 输出投影 ───────────────────────────────

/** 一条任务在模型面前的样子。`output` 就是成员的结论正文。 */
function taskView(task: TeamState['tasks'][number]): Record<string, unknown> {
  return {
    id: task.id,
    subject: task.subject,
    ...task.description === undefined ? {} : { description: task.description },
    status: task.status,
    ...task.assignee === undefined ? {} : { assignee: task.assignee },
    dependencies: task.dependencies,
    attempt: task.attempt,
    ...task.output === undefined ? {} : { output: task.output },
  }
}

/** 团队投影。不含 `captainSessionId` —— 对模型没有用处。 */
function summarize(team: TeamState): Record<string, unknown> {
  return {
    teamId: team.id,
    name: team.name,
    ...team.description === undefined ? {} : { description: team.description },
    topology: team.topology,
    members: team.members.map(member => ({
      name: member.name,
      ...member.role === undefined ? {} : { role: member.role },
      provider: member.provider,
      ...member.model === undefined ? {} : { model: member.model },
      status: member.status,
    })),
    tasks: team.tasks.map(taskView),
    progress: teamProgress(team),
  }
}

// 输出 schema 必须显式标注 `JsonSchemaNode`：`as const` 出的 `readonly` 数组/属性
// 与 dsh 的可变 `Record<string, JsonSchemaNode>` 不兼容，而省略标注又会让
// `type: 'object'` 拓宽成 `string`。标注后共享子 schema 必须提成独立常量 ——
// 从 `TEAM_SCHEMA.properties` 里取会变成 `possibly undefined`。

/** 成员投影。 */
const MEMBER_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['name', 'provider', 'status'],
  properties: {
    name: { type: 'string' },
    role: { type: 'string' },
    provider: { type: 'string' },
    model: { type: 'string' },
    status: { type: 'string' },
  },
  additionalProperties: false,
}

/** 任务投影（团队投影与 `run` 共用）。 */
const TASK_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['id', 'subject', 'status', 'dependencies', 'attempt'],
  properties: {
    id: { type: 'string' },
    subject: { type: 'string' },
    description: { type: 'string' },
    status: { type: 'string' },
    assignee: { type: 'string' },
    dependencies: { type: 'array', items: { type: 'string' } },
    attempt: { type: 'number' },
    output: { type: 'string' },
  },
  additionalProperties: false,
}

const TEAM_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['teamId', 'topology', 'members', 'tasks', 'progress'],
  properties: {
    teamId: { type: 'string' },
    name: { type: 'string' },
    description: { type: 'string' },
    topology: { type: 'string' },
    members: { type: 'array', items: MEMBER_SCHEMA },
    tasks: { type: 'array', items: TASK_SCHEMA },
    progress: { type: 'object' },
  },
  additionalProperties: false,
}

/** 单条派发结果。 */
const DISPATCH_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['taskId', 'member', 'ok', 'text', 'stopReason'],
  properties: {
    taskId: { type: 'string' },
    member: { type: 'string' },
    ok: { type: 'boolean' },
    text: { type: 'string' },
    stopReason: { type: 'string' },
    diagnostic: { type: 'string' },
  },
  additionalProperties: false,
}

const RUN_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['teamId', 'settled', 'rounds', 'progress', 'tasks'],
  properties: {
    teamId: { type: 'string' },
    settled: { type: 'boolean' },
    rounds: {
      type: 'array',
      items: {
        type: 'object',
        required: ['dispatched', 'more', 'settled'],
        properties: {
          dispatched: { type: 'array', items: DISPATCH_SCHEMA },
          more: { type: 'boolean' },
          settled: { type: 'boolean' },
        },
        additionalProperties: false,
      },
    },
    progress: { type: 'object' },
    tasks: { type: 'array', items: TASK_SCHEMA },
  },
  additionalProperties: false,
}

/** `status` 有两种返回形态（列表 / 单个），故 `required` 为空。 */
const STATUS_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    teams: { type: 'array', items: { type: 'object' } },
    teamId: { type: 'string' },
    settled: { type: 'boolean' },
    capabilities: { type: 'object' },
  },
  additionalProperties: false,
}

const WAIT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['state'],
  properties: {
    state: { type: 'string' },
    value: {},
    error: { type: 'string' },
  },
  additionalProperties: false,
}

const RECONCILE_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['teamId', 'requeued', 'running', 'settling'],
  properties: {
    teamId: { type: 'string' },
    requeued: { type: 'array', items: { type: 'string' } },
    running: { type: 'array', items: { type: 'string' } },
    settling: { type: 'array', items: { type: 'string' } },
    progress: { type: 'object' },
  },
  additionalProperties: false,
}

/** 统一的输出渲染：结构化值原样交给模型，不做散文包装。 */
function renderJson(_args: unknown, value: unknown): { type: 'text'; text: string }[] {
  return [{ type: 'text', text: JSON.stringify(value) }]
}

// ─────────────────────────────── 入参校验 ───────────────────────────────

/** 工具入参的必需字符串。空串与缺省都拒 —— 别让 `""` 变成「没有这个字段」。 */
function requireString(value: unknown, field: string, tool: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${tool}: ${field} 必须是非空字符串`)
  }
  return value
}

function requireStringArray(value: unknown, field: string, tool: string): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${tool}: ${field} 必须是非空数组`)
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new Error(`${tool}: ${field}[${index}] 必须是非空字符串`)
    }
    return entry
  })
}

function requireTopology(value: unknown, tool: string): Topology {
  const candidate = requireString(value, 'topology', tool)
  if (!(TOPOLOGIES as readonly string[]).includes(candidate)) {
    throw new Error(`${tool}: topology 必须是 ${TOPOLOGIES.join(' / ')} 之一，收到 ${candidate}`)
  }
  return candidate as Topology
}

/**
 * 船长会话 id。团队归拥有它的会话所有。
 *
 * 结构化读 `agent.id`（dsh `Agent` 的会话身份）而不 import dsh 的 agent 类型：
 * 这一层只需要一个审计字段，不值得为它把工具面耦合到 agent 类型上（与 `roster.ts`
 * 的 `MemberSeam` 同训）。拿不到时给一个**显式**占位，而不是编一个像真的 id。
 */
function captainOf(exec: ToolRunContext): string {
  const id = (exec.agent as { id?: unknown } | undefined)?.id
  return typeof id === 'string' && id !== '' ? id : 'unknown-captain'
}

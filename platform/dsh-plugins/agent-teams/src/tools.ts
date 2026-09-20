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
import { THREAD_STATES, type ThreadRound, type ThreadRow, type ThreadState } from './thread.ts'
import type { ThreadsRuntime } from './threads.ts'

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
              acceptance: {
                type: 'string',
                description:
                  '验收条件：怎样算做完。**派发时写死**，会随任务一起发给成员；'
                  + '缺省则该任务没有任何验收条件（收活时会被判 no-criteria，不会自动通过）。',
              },
              continuesContext: {
                type: 'boolean',
                description:
                  '这条任务是否**延续**当前对话：true 则成员带着父级已完成的轮次开工（不必重新粘贴上下文），'
                  + 'false/缺省 = 正交任务，成员独立上下文。'
                  + '**只在进程内执行时有效**；集群形态下成员被放到承载节点执行，本字段不生效。',
              },
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
          ...raw['acceptance'] === undefined ? {} : { acceptance: String(raw['acceptance']) },
          // 只认真正的布尔 true：模型给 `"true"` 字符串时按缺省（正交）处理，不猜。
          // 猜错的代价是成员悄悄拿到父级上下文，而正交任务最不想要的就是这个。
          ...raw['continuesContext'] === true ? { continuesContext: true } : {},
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

// ─────────────────────── 线程档位的工具面（§24.2 的 agent_threads_*） ───────────────────────

/** 线程工具面的装配参数（上限一律服务端给定，模型改不了）。 */
export interface AgentThreadToolConfig {
  /** `agent_threads_await` 的单次等待上限（模型不能要求「一直等」）。 */
  maxWaitMs?: number
}

/**
 * 把线程档位注册成模型可见的工具 —— `agent_threads_*`（建 / 查 / 推进 / 暂停 / 等 / 重派）。
 *
 * ## 为什么是**另一族**而不是塞进 `agent_teams_*`
 *
 * 两族的对象不同：团队工具操作的是任务板（DAG + 成员），线程工具操作的是**一条稳定会话的
 * 生命周期**（承载节点亲和、唤醒订阅、工作目录）。混成一族会让模型把「派一条任务」与
 * 「推进一条线程」当成同一件事——而它们的方式完全不同：前者一轮跑完即收（one-shot），
 * 后者是同一个会话上的第 N 轮。名字分开，模型才可能在调用前想一下自己要做的是哪一种。
 *
 * ## 为什么这一族少了两个动作
 *
 * - **没有「上报节点丢失」**：那是心跳侧的动作（§24.2.3(4)：谁上报与重不重派是两件事）。
 *   给了模型一个「关掉这条线程」的按钮，它就能把一条好线程标成 failed 并触发重派；
 * - **没有「删除线程」**：线程的生命周期由状态机说话（`stopped` / `done` / `failed` 都是
 *   终态），删除会让「这条线程后来怎么了」这个问题没有答案。
 *
 * @returns 注销函数，交给 `ctx.effect` 做清理。
 */
export function defineAgentThreadTools(
  ctx: Context,
  threads: ThreadsRuntime,
  config: AgentThreadToolConfig = {},
): () => void {
  const maxWaitMs = config.maxWaitMs ?? DEFAULT_TOOL_MAX_WAIT_MS

  const create: ToolDefinition = {
    name: 'agent_threads_create',
    description:
      '建一条**线程**——一个稳定的完整会话（跨多轮 Run），用于「改代码 → 跑测试 → 修 CI → 再跑」'
      + '这类需要接着上一轮现场继续的工作。与成员（one-shot，跑完即收）是两档：'
      + '成员适合一次能说完的子任务，线程适合要连着干几轮的活。'
      + '建完是 idle（还没放上承载节点），用 agent_threads_advance 推进。'
      + '线程**亲和到承载节点、绝不迁移**：节点丢了这条线程就终止，要续跑必须新建一条。',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '线程标识，只允许 [A-Za-z0-9_-]，建后不可改' },
        projectId: { type: 'string', description: '所属项目（线程属于项目工作区）' },
        taskId: { type: 'string', description: '这条线程在做哪个任务；一轮 = 该任务上的一个 Run' },
        sessionRef: { type: 'string', description: '线程的稳定会话引用（dsh 会话层给出）' },
        nodeId: { type: 'string', description: '承载节点（线程的现场就在这台机器上，不可迁移）' },
      },
      required: ['threadId', 'projectId', 'taskId', 'sessionRef', 'nodeId'],
      additionalProperties: false,
    },
    output: { schema: THREAD_SCHEMA, render: renderJson },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const a = args as Record<string, unknown>
      const thread = await threads.createThread({
        id: requireString(a['threadId'], 'threadId', 'agent_threads_create'),
        projectId: requireString(a['projectId'], 'projectId', 'agent_threads_create'),
        taskId: requireString(a['taskId'], 'taskId', 'agent_threads_create'),
        sessionRef: requireString(a['sessionRef'], 'sessionRef', 'agent_threads_create'),
        nodeId: requireString(a['nodeId'], 'nodeId', 'agent_threads_create'),
        // 协调者是**本次调用所在的会话**：让模型自报「谁在协调」，重派时通知就会送到别人手里。
        coordinatorSessionRef: captainOf(exec),
      })
      return threadView(thread)
    },
  }

  const status: ToolDefinition = {
    name: 'agent_threads_status',
    description:
      '查线程：给 threadId 看一条（含它当前状态、承载节点、工作目录），不给就列出本 realm 的线程'
      + '（可按项目与状态过滤）。这是看板之外唯一能看见「这条线程在等什么/停在哪」的地方。',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '线程标识；缺省列出多条' },
        projectId: { type: 'string', description: '按项目过滤（仅列表面有效）' },
        state: { type: 'string', enum: [...THREAD_STATES], description: '按状态过滤（仅列表面有效）' },
        limit: { type: 'number', description: '列表上限' },
      },
      additionalProperties: false,
    },
    output: { schema: THREAD_LIST_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as Record<string, unknown>
      if (a['threadId'] !== undefined && a['threadId'] !== '') {
        const thread = await threads.getThread(String(a['threadId']))
        // 不存在返回 undefined 而不是抛：跨 realm 读在服务端就是「不存在」，与「读不到」
        // 是两件事（前者别再试，后者千万别动）。
        return thread === undefined ? { found: false } : { found: true, thread: threadView(thread) }
      }
      const list = await threads.listThreads({

        ...a['projectId'] === undefined ? {} : { projectId: String(a['projectId']) },
        ...a['state'] === undefined ? {} : { state: requireThreadState(a['state'], 'agent_threads_status') },
        ...a['limit'] === undefined ? {} : { limit: Math.max(Math.trunc(Number(a['limit'])), 1) },
      })
      return { threads: list.map(threadView), capabilities: threads.capabilities() }
    },
  }

  const advance: ToolDefinition = {
    name: 'agent_threads_advance',
    description:
      '推进一条线程。action=suspend：挂起一轮（`running → awaiting`），先在持久会合面上挂好'
      + '带 TTL 的等待项再推状态——顺序反了会出现「事件到了却没有等待项」的窗口，那条线程'
      + '会永远停在等待上。action=wake：兑现等待项并开**新一轮 Run**（`awaiting → running`）。'
      + '两个动作都只允许**承载节点自己**做（跨节点推进会绕过「绝不迁移」）。',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '线程标识' },
        action: { type: 'string', enum: ['suspend', 'wake'], description: '推进动作' },
        attempt: { type: 'number', description: '轮次代数（>= 1；一轮 = 一个 Run）' },
        event: { description: 'action=wake 时把什么交给等待方（缺省给一个空事件）' },
        ttlMs: { type: 'number', description: 'action=suspend 时等待项的有效期毫秒（强制带 TTL）' },
      },
      required: ['threadId', 'action', 'attempt'],
      additionalProperties: false,
    },
    output: { schema: THREAD_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as Record<string, unknown>
      const threadId = requireString(a['threadId'], 'threadId', 'agent_threads_advance')
      const action = requireString(a['action'], 'action', 'agent_threads_advance')
      const ability = requireAttempt(a['attempt'], 'agent_threads_advance')
      // 轮次的任务来自**行本身**（不是模型给的）：`threadActionDecision` 会核对
      // `round.task_id === thread.task_id`，让模型自报任务只会让这条动作变成一次
      // 「归因到别的任务」的机会。
      const round = await roundOf(threads, threadId, ability, 'agent_threads_advance')
      if (action === 'suspend') {
        const armed = await threads.suspend({
          threadId, round,
          ...a['ttlMs'] === undefined ? {} : { ttlMs: Math.trunc(Number(a['ttlMs'])) },
        })
        return { ...threadView(armed.thread), channel: armed.channel, ttlMs: armed.ttlMs }
      }
      if (action === 'wake') {
        const woken = await threads.resume({ threadId, round, event: a['event'] ?? { kind: 'wake' } })
        return { ...threadView(woken.thread), settled: woken.settled.status }
      }
      throw new Error(`agent_threads_advance: action 必须是 suspend / wake 之一，收到 ${action}`)
    },
  }

  const pause: ToolDefinition = {
    name: 'agent_threads_pause',
    description:
      '停下一条线程（`→ stopped`，终态）。**现场还在**（工作目录与会话日志都留在承载节点上），'
      + '处置是等人/等指令——这一点与 `failed`（现场已经没了，必须重派新 Run）恰好相反，'
      + '所以不要用它去「救」一条承载节点已经丢失的线程：那种线程该走 agent_threads_reassign。',
    parameters: {
      type: 'object',
      properties: { threadId: { type: 'string', description: '线程标识' } },
      required: ['threadId'],
      additionalProperties: false,
    },
    output: { schema: THREAD_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as Record<string, unknown>
      return threadView(await threads.transitionThread(
        requireString(a['threadId'], 'threadId', 'agent_threads_pause'), 'stopped',
      ))
    },
  }

  // 变量名带下划线：`await` 是保留字，而工具名（字符串）才是模型看见的那个。
  const waitThread: ToolDefinition = {
    name: 'agent_threads_await',
    description:
      '等一条线程这一轮的结局（走持久会合面，跨节点跨重启都成立）。'
      + '返回 resolved（事件到达）、rejected、expired（TTL 到期，应当对账后重跑），'
      + '或 **node-lost**——后者是一个**独立的一档**：承载节点失联，现场已经没了，'
      + '这一轮不会再来。此时正确的动作是 agent_threads_reassign（新建线程重派），'
      + '而不是再等一次（等一次是对「可重试」的处置，节点丢失不是）。',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '线程标识' },
        attempt: { type: 'number', description: '轮次代数（>= 1）' },
        timeoutMs: { type: 'number', description: `本次等待上限毫秒（服务端上限 ${maxWaitMs}）` },
      },
      required: ['threadId', 'attempt'],
      additionalProperties: false,
    },
    output: { schema: THREAD_WAIT_SCHEMA, render: renderJson },
    async execute(args: unknown): Promise<unknown> {
      const a = args as Record<string, unknown>
      const threadId = requireString(a['threadId'], 'threadId', 'agent_threads_await')
      const round = await roundOf(threads, threadId, requireAttempt(a['attempt'], 'agent_threads_await'), 'agent_threads_await')
      const requested = Math.trunc(Number(a['timeoutMs']))
      const timeoutMs = Number.isSafeInteger(requested) && requested > 0 ? requested : maxWaitMs
      return threads.awaitThreadRound({
        threadId, round,
        timeoutMs: Math.min(Math.max(timeoutMs, 1_000), maxWaitMs),
      })
    },
  }

  const reassign: ToolDefinition = {
    name: 'agent_threads_reassign',
    description:
      '线程的承载节点丢失后**重派**：新建一条线程（新会话、新工作目录、新承载节点）并开**新一轮 Run**。'
      + '只在 agent_threads_await 返回 node-lost（或 agent_threads_status 显示 failed 且确知节点已丢）之后调用。'
      + '**不是**「在原来的线程上重试」——承载节点亲和不迁移，原线程是终态，重试只能靠新建。'
      + 'newNodeId 必须是**另一台**机器（放回刚丢的那台是静默失败）；newSessionRef 必须是新会话'
      + '（旧会话的现场在已失联的节点上）。',
    parameters: {
      type: 'object',
      properties: {
        threadId: { type: 'string', description: '失败的那条线程' },
        previousAttempt: { type: 'number', description: '上一轮的代数（新一轮 = 它 + 1）' },
        newNodeId: { type: 'string', description: '新的承载节点（不能是刚丢的那个）' },
        newSessionRef: { type: 'string', description: '新会话引用（不能复用旧会话）' },
        prompt: { type: 'string', description: '这一轮要做什么' },
      },
      required: ['threadId', 'previousAttempt', 'newNodeId', 'newSessionRef', 'prompt'],
      additionalProperties: false,
    },
    output: { schema: THREAD_REASSIGN_SCHEMA, render: renderJson },
    async execute(args: unknown, exec: ToolRunContext): Promise<unknown> {
      const a = args as Record<string, unknown>
      const threadId = requireString(a['threadId'], 'threadId', 'agent_threads_reassign')
      const previousRound = await roundOf(
        threads, threadId, requireAttempt(a['previousAttempt'], 'agent_threads_reassign'), 'agent_threads_reassign',
      )
      const failed = await threads.getThread(threadId)
      if (failed === undefined) {
        throw new Error(`agent_threads_reassign: 线程 ${threadId} 不存在（或不在本 realm）`)
      }
      const result = await threads.reassignAfterNodeLoss({
        thread: failed,
        previousRound,
        newNodeId: requireString(a['newNodeId'], 'newNodeId', 'agent_threads_reassign'),
        newSessionRef: requireString(a['newSessionRef'], 'newSessionRef', 'agent_threads_reassign'),
        prompt: requireString(a['prompt'], 'prompt', 'agent_threads_reassign'),
        parent: exec.agent,
        signal: exec.signal,
      })
      return {
        threadId: result.thread.id,
        replaced: threadId,
        round: { task_id: result.round.task_id, attempt: result.round.attempt },
        runId: result.runId,
        thread: threadView(result.thread),
      }
    },
  }

  const definitions = [create, status, advance, pause, waitThread, reassign]
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  return () => {
    for (const dispose of disposers) dispose()
  }
}

/** 线程行在模型面前的样子（列名 → 驼峰：这一族是给模型读的，与注册表客户端的逐字投影分工不同）。 */
function threadView(thread: ThreadRow): Record<string, unknown> {
  return {
    threadId: thread.id,
    projectId: thread.project_id,
    taskId: thread.task_id,
    sessionRef: thread.session_ref,
    nodeId: thread.node_id,
    workspace: thread.workspace,
    state: thread.state,
    coordinatorSessionRef: thread.coordinator_session_ref,
    updatedAt: thread.updated_at,
  }
}

/**
 * 轮次代数的入参校验：一轮 = 一个 Run，代数必须 >= 1（0 表示从未派发，不是一轮）。
 *
 * **不截断**（与 `agent_teams_*` 里对数值参数的 `Math.trunc` 不同）：代数是 Run 的身份
 * （`(task_id, attempt)` 唯一约束），把 `1.5` 截成 `1` 会让一次「模型算错了代数」的调用
 * 悄悄落到**另一轮**上——那一轮的现场、成本归因（§14 判据 10）与审计全都指向错的执行。
 * 数值参数（等待上限、并行条数）截断无害，身份参数不行。
 */
function requireAttempt(value: unknown, tool: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${tool}: attempt 必须是 >= 1 的整数（一轮 = 一个 Run），收到 ${JSON.stringify(value)}`)
  }
  return value
}

/**
 * 由**线程行**构造轮次身份（任务来自行，代数来自调用方）。
 *
 * 任务必须取自行而不是取自模型：`threadActionDecision` 会核对 `round.task_id === thread.task_id`，
 * 让模型自报任务只会制造一次「把这一轮归因到别的任务」的机会——而那条拒绝理由
 * （`round-task-mismatch`）是给**跨系统调用**准备的，不是给工具面的。
 */
async function roundOf(
  threads: ThreadsRuntime,
  threadId: string,
  attempt: number,
  tool: string,
): Promise<ThreadRound> {
  const thread = await threads.getThread(threadId)
  if (thread === undefined) {
    throw new Error(`${tool}: 线程 ${threadId} 不存在（或不在本 realm）`)
  }
  return { task_id: thread.task_id, attempt }
}

/** 状态过滤的入参校验（闭集外即拒：空集会让「拼错了」看起来像「确实没有」）。 */
function requireThreadState(value: unknown, tool: string): (typeof THREAD_STATES)[number] {
  const state = requireString(value, 'state', tool)
  if (!(THREAD_STATES as readonly string[]).includes(state)) {
    throw new Error(`${tool}: state 必须是 ${THREAD_STATES.join(' / ')} 之一，收到 ${state}`)
  }
  return state as (typeof THREAD_STATES)[number]
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

/** 线程投影（`agent_threads_*` 一族共用）。 */
const THREAD_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['threadId', 'taskId', 'sessionRef', 'nodeId', 'workspace', 'state'],
  properties: {
    threadId: { type: 'string' },
    projectId: { type: 'string' },
    taskId: { type: 'string' },
    sessionRef: { type: 'string' },
    nodeId: { type: 'string' },
    workspace: { type: 'string' },
    state: { type: 'string' },
    coordinatorSessionRef: { type: 'string' },
    updatedAt: { type: 'string' },
    /** `agent_threads_advance action=suspend` 时带出：等待通道与它的有效期。 */
    channel: { type: 'string' },
    ttlMs: { type: 'number' },
    /** `action=wake` 时带出：兑现是首次还是重复（至少一次投递下必须能分辨）。 */
    settled: { type: 'string' },
  },
  additionalProperties: false,
}

/** `agent_threads_status` 的两种返回形态（单条 / 列表），故 `required` 为空。 */
const THREAD_LIST_SCHEMA: JsonSchemaNode = {
  type: 'object',
  properties: {
    found: { type: 'boolean' },
    thread: THREAD_SCHEMA,
    threads: { type: 'array', items: THREAD_SCHEMA },
    capabilities: { type: 'object' },
  },
  additionalProperties: false,
}

/** `agent_threads_await`：`node-lost` 与其余三档同属闭集。 */
const THREAD_WAIT_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['state'],
  properties: {
    state: { type: 'string' },
    value: {},
    error: { type: 'string' },
    notice: { type: 'object' },
    channel: { type: 'string' },
    ttlMs: { type: 'number' },
  },
  additionalProperties: false,
}

/** `agent_threads_reassign`：新线程 + 新一轮 Run 的身份 + 承载它的子 Run。 */
const THREAD_REASSIGN_SCHEMA: JsonSchemaNode = {
  type: 'object',
  required: ['threadId', 'replaced', 'round', 'runId', 'thread'],
  properties: {
    threadId: { type: 'string' },
    replaced: { type: 'string' },
    round: { type: 'object' },
    runId: { type: 'string' },
    thread: THREAD_SCHEMA,
  },
  additionalProperties: false,
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

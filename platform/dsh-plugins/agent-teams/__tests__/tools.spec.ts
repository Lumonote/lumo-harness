/**
 * `agent_teams_*` 工具面。
 *
 * 走的是**真实服务**（内存存储 + 进程内会合面 + 假 seam），断言的是「模型看到的那
 * 一面」：注册了哪些工具、参数怎么被校验、一次完整协同的返回形状、以及模型能踩到
 * 的坑（空串、缺 agent、越界上限）。服务内部行为由 `service.spec.ts` 覆盖，不重复。
 */
import { describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { channelId, MemoryCourier, type TeamCourier } from '../src/courier.ts'
import type { MemberProviderChoice, MemberRun, MemberSeam, MemberStartRequest } from '../src/roster.ts'
import { AgentTeamsService } from '../src/service.ts'
import { MemoryTeamStore } from '../src/store.ts'
import {
  DEFAULT_TOOL_MAX_ROUNDS,
  DEFAULT_TOOL_MAX_WAIT_MS,
  defineAgentTeamsTools,
} from '../src/tools.ts'

const NOW = 1_700_000_000_000
const SIGNAL = new AbortController().signal
const PROVIDER: MemberProviderChoice = { provider: 'spawn', kind: 'in-process', reason: 'test' }

/** 船长调用的执行上下文。`run` 需要 `agent`（派发子代理的父）与 `signal`。 */
const CAPTAIN = { agent: { id: 'session-1' }, signal: SIGNAL } as unknown as ToolRunContext

/** 记录派发次数，并回一个可预测的结论。 */
function recordingSeam(): { seam: MemberSeam; calls: MemberStartRequest[] } {
  const calls: MemberStartRequest[] = []
  const seam: MemberSeam = {
    list: () => [PROVIDER.provider],
    start: async (_provider: string, request: MemberStartRequest): Promise<MemberRun> => {
      calls.push(request)
      return {
        id: `child-${calls.length}`,
        result: Promise.resolve({
          output: [{ type: 'text', text: `结论:${request.label}` }],
          stopReason: 'completed',
        }),
        dispose: async () => {},
      }
    },
  }
  return { seam, calls }
}

interface Harness {
  /** 已注册的工具，按名字索引。 */
  tools: Map<string, ToolDefinition>
  service: AgentTeamsService
  calls: MemberStartRequest[]
  courier: TeamCourier
  call: (name: string, args: unknown, exec?: ToolRunContext) => Promise<unknown>
  dispose: () => void
}

function harness(config: {
  maxRounds?: number
  maxWaitMs?: number
  courier?: TeamCourier
  now?: () => number
} = {}): Harness {
  const tools = new Map<string, ToolDefinition>()
  const ctx = {
    tools: {
      register: (definition: ToolDefinition) => {
        tools.set(definition.name, definition)
        return () => {
          tools.delete(definition.name)
        }
      },
    },
  } as unknown as Context

  const now = config.now ?? (() => NOW)
  // 存储实例在解析器之外建一次 —— 解析器每次新建 store 会让状态在操作之间蒸发。
  const store = new MemoryTeamStore()
  const courier = config.courier ?? new MemoryCourier(now)
  const { seam, calls } = recordingSeam()
  const service = new AgentTeamsService({
    resolveStore: () => ({ store, durable: false }),
    resolveCourier: () => courier,
    resolveSeam: () => ({ seam, provider: PROVIDER }),
    now,
  })

  const dispose = defineAgentTeamsTools(ctx, service, {
    ...config.maxRounds === undefined ? {} : { maxRounds: config.maxRounds },
    ...config.maxWaitMs === undefined ? {} : { maxWaitMs: config.maxWaitMs },
  })

  const call = async (
    name: string,
    args: unknown,
    exec: ToolRunContext = CAPTAIN,
  ): Promise<unknown> => {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`未注册的工具：${name}`)
    return definition.execute(args, exec)
  }

  return { tools, service, calls, courier, call, dispose }
}

/** 建一个「一个成员、两条串行任务」的最小团队，返回团队 id。 */
async function seed(h: Harness, subjects = ['取数', '清洗']): Promise<string> {
  await h.call('agent_teams_create', { teamId: 'demo', name: '演示', topology: 'pipeline', subjects })
  await h.call('agent_teams_add_member', { teamId: 'demo', name: 'alice' })
  return 'demo'
}

describe('工具面注册', () => {
  it('注册全部 11 个 agent_teams_* 工具，名字无遗漏', () => {
    const h = harness()
    expect([...h.tools.keys()].sort()).toEqual([
      'agent_teams_add_member',
      'agent_teams_await_task',
      'agent_teams_cancel_task',
      'agent_teams_create',
      'agent_teams_create_task',
      'agent_teams_delete',
      'agent_teams_reassign_task',
      'agent_teams_reconcile',
      'agent_teams_remove_member',
      'agent_teams_run',
      'agent_teams_status',
    ])
  })

  it('每个工具都有描述、入参 schema 与输出渲染', () => {
    const h = harness()
    for (const [name, definition] of h.tools) {
      expect(definition.description.length, name).toBeGreaterThan(0)
      expect(definition.parameters, name).toMatchObject({ type: 'object' })
      expect(typeof definition.output.render, name).toBe('function')
      // 渲染必须是纯 JSON —— 模型侧不做散文包装。
      const rendered = definition.output.render({}, { a: 1 })
      expect(rendered).toEqual([{ type: 'text', text: '{"a":1}' }])
    }
  })

  it('注销时清空全部工具', () => {
    const h = harness()
    expect(h.tools.size).toBe(11)
    h.dispose()
    expect(h.tools.size).toBe(0)
  })

  it('服务端上限写进描述，模型看得见自己不能越界', () => {
    const h = harness({ maxRounds: 3, maxWaitMs: 5_000 })
    const param = (tool: string, name: string): string => {
      const parameters = h.tools.get(tool)!.parameters as { properties: Record<string, { description?: string }> }
      return parameters.properties[name]?.description ?? ''
    }
    expect(param('agent_teams_run', 'maxRounds')).toContain('3')
    expect(param('agent_teams_await_task', 'timeoutMs')).toContain('5000')
    expect(DEFAULT_TOOL_MAX_ROUNDS).toBeGreaterThan(0)
    expect(DEFAULT_TOOL_MAX_WAIT_MS).toBeGreaterThan(0)
  })
})

describe('入参校验', () => {
  it('空串与缺省都被拒 —— `""` 不能变成「没有这个字段」', async () => {
    const h = harness()
    await expect(h.call('agent_teams_create', { name: 'x', topology: 'pipeline', subjects: ['a'] }))
      .rejects.toThrow(/teamId 必须是非空字符串/)
    await expect(h.call('agent_teams_create', { teamId: '  ', name: 'x', topology: 'pipeline', subjects: ['a'] }))
      .rejects.toThrow(/teamId 必须是非空字符串/)
    await expect(h.call('agent_teams_create', { teamId: 'demo', name: '', topology: 'pipeline', subjects: ['a'] }))
      .rejects.toThrow(/name 必须是非空字符串/)
    await expect(h.call('agent_teams_create', { teamId: 'demo', name: 'x', topology: 'pipeline', subjects: [] }))
      .rejects.toThrow(/subjects 必须是非空数组/)
    await expect(h.call('agent_teams_create', { teamId: 'demo', name: 'x', topology: 'pipeline', subjects: [''] }))
      .rejects.toThrow(/subjects\[0\] 必须是非空字符串/)
  })

  it('拓扑只接受三个已知取值', async () => {
    const h = harness()
    await expect(h.call('agent_teams_create', { teamId: 'demo', name: 'x', topology: 'swarm', subjects: ['a'] }))
      .rejects.toThrow(/topology 必须是 planner-worker \/ pipeline \/ deliberation 之一/)
  })

  it('create_task 拒绝空数组与非对象条目', async () => {
    const h = harness()
    await seed(h)
    await expect(h.call('agent_teams_create_task', { teamId: 'demo', tasks: [] }))
      .rejects.toThrow(/tasks 必须是非空数组/)
    await expect(h.call('agent_teams_create_task', { teamId: 'demo', tasks: ['nope'] }))
      .rejects.toThrow(/tasks\[0\] 不是对象/)
    await expect(h.call('agent_teams_create_task', { teamId: 'demo', tasks: [{ subject: '' }] }))
      .rejects.toThrow(/tasks\[0\]\.subject 必须是非空字符串/)
  })

  it('run 没有产生它的 agent 时响亮失败，而不是静默不派发', async () => {
    const h = harness()
    await seed(h)
    await expect(h.call('agent_teams_run', { teamId: 'demo' }, {} as ToolRunContext))
      .rejects.toThrow(/没有产生它的 agent/)
  })
})

describe('一次完整协同', () => {
  it('create → add_member → run 闭环，任务结论写回任务板', async () => {
    const h = harness()
    const teamId = await seed(h)

    const run = await h.call('agent_teams_run', { teamId }) as {
      settled: boolean
      rounds: { dispatched: { taskId: string; ok: boolean; text: string }[] }[]
      tasks: { id: string; status: string; output?: string }[]
      progress: Record<string, unknown>
    }

    expect(run.settled).toBe(true)
    expect(run.progress).toEqual({
      total: 2, pending: 0, active: 0, completed: 2, failed: 0, cancelled: 0, ready: [], blocked: [],
    })
    expect(run.tasks.map(task => task.status)).toEqual(['completed', 'completed'])
    expect(run.tasks.map(task => task.output)).toEqual(['结论:演示/t1', '结论:演示/t2'])
    // 两轮：t1 先跑，t2 依赖它。
    expect(run.rounds).toHaveLength(2)
    expect(run.rounds[0]!.dispatched.map(d => d.taskId)).toEqual(['t1'])
    expect(run.rounds[1]!.dispatched.map(d => d.taskId)).toEqual(['t2'])
  })

  it('run 的轮次上限被夹在服务端配置内（模型改不大）', async () => {
    const h = harness({ maxRounds: 1 })
    await seed(h)
    const run = await h.call('agent_teams_run', { teamId: 'demo', maxRounds: 999 }) as {
      settled: boolean
      rounds: unknown[]
    }
    expect(run.rounds).toHaveLength(1)
    expect(run.settled).toBe(false)
    expect(h.calls).toHaveLength(1)
  })

  it('status 不带 teamId 列出全部团队，带 teamId 给出能力画像', async () => {
    const h = harness()
    await seed(h)

    const list = await h.call('agent_teams_status', {}) as { teams: { teamId: string; members: number }[] }
    expect(list.teams).toEqual([{ teamId: 'demo', name: '演示', topology: 'pipeline', members: 1, progress: expect.anything() }])

    const one = await h.call('agent_teams_status', { teamId: 'demo' }) as {
      capabilities: { provider: { provider: string }; durableStore: boolean; durableCourier: boolean }
    }
    expect(one.capabilities.provider.provider).toBe('spawn')
    expect(one.capabilities.durableStore).toBe(false)
    expect(one.capabilities.durableCourier).toBe(false)
  })

  it('delete 后团队不再出现在列表里', async () => {
    const h = harness()
    await seed(h)
    expect(await h.call('agent_teams_delete', { teamId: 'demo' })).toEqual({ teamId: 'demo', deleted: true })
    expect(await h.call('agent_teams_status', {})).toEqual({ teams: [] })
  })
})

describe('任务图与名册的运维动作', () => {
  it('create_task 支持一次多条并带依赖', async () => {
    const h = harness()
    await seed(h)
    const view = await h.call('agent_teams_create_task', {
      teamId: 'demo',
      tasks: [
        { subject: '汇总', assignee: 'alice' },
        { subject: '复核', dependencies: ['t3'] },
      ],
    }) as { tasks: { id: string; subject: string; dependencies: string[]; assignee?: string }[] }
    expect(view.tasks.map(task => [task.id, task.dependencies])).toEqual([
      ['t1', []], ['t2', ['t1']], ['t3', []], ['t4', ['t3']],
    ])
    expect(view.tasks[2]!.assignee).toBe('alice')
  })

  it('remove_member 把名下任务退回待认领', async () => {
    const h = harness()
    await seed(h, ['单个'])
    await h.call('agent_teams_reassign_task', { teamId: 'demo', taskId: 't1', member: 'alice' })
    const view = await h.call('agent_teams_remove_member', { teamId: 'demo', name: 'alice' }) as {
      members: unknown[]
      tasks: { assignee?: string; status: string }[]
    }
    expect(view.members).toEqual([])
    expect(view.tasks[0]!.assignee).toBeUndefined()
    expect(view.tasks[0]!.status).toBe('pending')
  })

  it('cancel_task 把任务推到终态', async () => {
    const h = harness()
    await seed(h, ['单个'])
    const view = await h.call('agent_teams_cancel_task', { teamId: 'demo', taskId: 't1' }) as {
      tasks: { status: string }[]
    }
    expect(view.tasks[0]!.status).toBe('cancelled')
  })
})

describe('会合面与对账', () => {
  it('await_task 能等到已兑现的派发结局', async () => {
    const h = harness()
    await seed(h, ['单个'])
    await h.call('agent_teams_run', { teamId: 'demo' })
    // 通道兑现的是成员结论正文本身（`settleChannel` 送 `outcome.text`）。
    const outcome = await h.call('agent_teams_await_task', { teamId: 'demo', taskId: 't1' })
    expect(outcome).toEqual({ state: 'resolved', value: '结论:演示/t1' })
  })

  it('await_task 对从未派发的任务立刻给出 expired，绝不无限等', async () => {
    const h = harness()
    await seed(h, ['单个'])
    const outcome = await h.call('agent_teams_await_task', { teamId: 'demo', taskId: 't1' }) as { state: string }
    expect(outcome.state).toBe('expired')
  })

  it('reconcile 把「通道已死」的执行中任务退回待认领', async () => {
    let clock = NOW
    const courier = new MemoryCourier(() => clock)
    const h = harness({ courier, now: () => clock })
    await seed(h, ['单个'])

    // 手工摆出「派发者已消失」的形状：任务已认领、通道已开，之后再没人兑现。
    const claimed = await h.service.claim('demo', 't1', 'alice')
    const attempt = claimed.tasks[0]!.attempt
    await courier.open(channelId('demo', 't1', attempt), 1_000)

    clock = NOW + 5_000   // 越过 TTL
    const result = await h.call('agent_teams_reconcile', { teamId: 'demo' }) as {
      teamId: string
      requeued: string[]
      running: string[]
      settling: string[]
      tasks: { id: string; status: string; attempt: number }[]
    }
    expect(result).toMatchObject({ teamId: 'demo', requeued: ['t1'], running: [], settling: [] })
    expect(result.tasks[0]).toMatchObject({ status: 'pending', attempt: attempt + 1 })
  })
})

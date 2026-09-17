/**
 * `@lumo/agent-teams` 的装配。
 *
 * 这里断言的是**装配契约**，不是业务行为（业务行为在其余 5 个 spec 里）：
 *
 * 1. 只有 `tools` 时也能装起来 —— 其余协作者全是显式兜底，工具面照常注册；
 * 2. `subagents` / `storage` / `mailbox` **晚一步**挂上时仍然生效 —— 这是解析器
 *    设计的全部意义。构造时快照会把「晚一步」永久固化成内存兜底：团队看起来
 *    一切正常，重启即丢；
 * 3. 显式配了不可用的 provider 要**响亮失败**并降级到只读，不静默回落。
 *
 * 注意 `ctx.inject` 的收敛是异步的：装配后要 `await flush()` 才能观察依赖注入的
 * 结果（`defineAgentTeamsTools` 本身是同步的，所以工具名当场就能断言）。
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { apply } from '../src/index.ts'
import type { AgentTeamsService } from '../src/service.ts'
import type { KvUnitLike, StorageFacetLike } from '../src/store.ts'

/** 让 cordis 的 fiber 通知跑完（provide → notify 是异步收敛的）。 */
const flush = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 0) })

interface ToolsSpy {
  names: string[]
  /** 仍注册着的工具数（注销后应归零）。 */
  live: () => number
  register: (definition: unknown) => () => void
}

/** 收集工具注册与注销。 */
function toolsSpy(): ToolsSpy {
  const names: string[] = []
  let live = 0
  return {
    names,
    live: () => live,
    register: (definition: unknown) => {
      names.push((definition as { name: string }).name)
      live += 1
      return () => {
        live -= 1
      }
    },
  }
}

/** `ctx.subagents` 的结构等价子集：只给 `list()`，`start` 本用例不派发。 */
function subagentsSpy(providers: string[]): { list: () => string[]; start: () => Promise<never> } {
  return {
    list: () => providers,
    start: () => Promise.reject(new Error('本用例不派发')),
  }
}

/** 内存版 storage hub：够 `StorageHubTeamStore` 跑通读写。 */
function storageSpy(): StorageFacetLike {
  const records = new Map<string, unknown>()
  const unit: KvUnitLike = {
    loadAll: async () => ({ tables: { teams: Object.fromEntries(records) }, global: undefined }),
    putRecord: async (_table, key, value) => {
      records.set(key, value)
    },
    deleteRecord: async (_table, key) => {
      records.delete(key)
    },
    close: async () => {},
  }
  return { kv: { open: async () => unit } }
}

/** `ctx.mailbox` 的结构等价子集（`MailboxSeamLike`）。 */
function mailboxSpy(): Record<string, unknown> {
  return {
    create: async () => undefined,
    resolve: async () => ({ status: 'settled' }),
    reject: async () => ({ status: 'settled' }),
    wait: async () => ({ state: 'expired', error: '未兑现' }),
    poll: async () => undefined,
  }
}

/**
 * 装一个把全部严重级都收下来的日志出口。
 *
 * 必须显式给 `levels: { default: 3 }`（DEBUG）：内置 exporter 的缺省阈值是
 * INFO(1)，而 WARN 的数值是 2 —— 阈值比消息更严重时该消息会被**直接丢掉**
 * （`Logger._method` 的 `targetLevel < level` 分支）。不给阈值就什么都收不到。
 */
function capture(ctx: Context): string[] {
  const lines: string[] = []
  ctx.logger.exporter({
    levels: { default: 3 },
    export: (message) => {
      lines.push(message.args.map(String).join(' '))
    },
  })
  return lines
}

interface Boot {
  ctx: Context
  tools: ToolsSpy
  /** 取服务实例（销毁后 `ctx.get` 会失效，所以每次现取）。 */
  service: () => AgentTeamsService
}

/** 装好 `tools`，可选预置其它服务。 */
function boot(config: Parameters<typeof apply>[1] = {}, preset: { subagents?: string[] } = {}): Boot {
  const ctx = new Context()
  const tools = toolsSpy()
  ctx.provide('tools', tools)
  if (preset.subagents !== undefined) ctx.provide('subagents', subagentsSpy(preset.subagents))
  apply(ctx, config)
  return {
    ctx,
    tools,
    service: () => ctx.get('agentTeams') as AgentTeamsService,
  }
}

describe('装配', () => {
  it('只有 tools 也能装起来：工具面注册齐全，能力画像为「不能派发」', async () => {
    const { ctx, tools, service } = boot()
    expect(tools.names).toHaveLength(11)
    await flush()
    expect(service().capabilitiesOrNull()).toBeNull()
    // 只读用法仍然成立 —— 这才是 capabilitiesOrNull 存在的理由。
    await expect(service().list()).resolves.toEqual([])
    await ctx.fiber.dispose()
  })

  it('subagents 已挂：按优先级探测 provider，而非按部署形态分支', async () => {
    const { ctx, service } = boot({}, { subagents: ['fork', 'spawn'] })
    await flush()
    // `fork` 在列表里但优先级更低 —— 选的是 spawn。
    expect(service().capabilitiesOrNull()?.provider).toMatchObject({ provider: 'spawn', kind: 'in-process' })
    await ctx.fiber.dispose()
  })

  it('集群形态：lumo-remote 压过本进程 provider（成员才会真落到承载节点）', async () => {
    const { ctx, service } = boot({}, { subagents: ['spawn', 'fork', 'lumo-remote'] })
    await flush()
    expect(service().capabilitiesOrNull()?.provider).toMatchObject({ provider: 'lumo-remote', kind: 'remote' })
    await ctx.fiber.dispose()
  })

  it('subagents 晚一步挂上仍然生效（装配顺序无关）', async () => {
    const { ctx, service } = boot()
    await flush()
    expect(service().capabilitiesOrNull()).toBeNull()

    ctx.provide('subagents', subagentsSpy(['spawn']))
    await flush()

    expect(service().capabilitiesOrNull()?.provider).toMatchObject({ provider: 'spawn' })
    await ctx.fiber.dispose()
  })

  it('storage 晚一步挂上时，团队状态从内存兜底升级为持久', async () => {
    const { ctx, service } = boot({}, { subagents: ['spawn'] })
    await flush()
    expect(service().capabilitiesOrNull()?.durableStore).toBe(false)

    ctx.provide('storage', storageSpy())
    await flush()

    expect(service().capabilitiesOrNull()?.durableStore).toBe(true)
    await ctx.fiber.dispose()
  })

  it('mailbox 晚一步挂上时会合面从进程内升级为持久', async () => {
    const { ctx, service } = boot({}, { subagents: ['spawn'] })
    await flush()
    expect(service().capabilitiesOrNull()?.durableCourier).toBe(false)

    ctx.provide('mailbox', mailboxSpy())
    await flush()

    expect(service().capabilitiesOrNull()?.durableCourier).toBe(true)
    await ctx.fiber.dispose()
  })

  it('显式配了不可用的 provider 时响亮失败，且只降级到只读', async () => {
    const ctx = new Context()
    const lines = capture(ctx)
    ctx.provide('tools', toolsSpy())
    ctx.provide('subagents', subagentsSpy(['spawn']))
    // 配置了 lumo-remote 却只有 spawn —— 这是运维错误，不能静默用 spawn 顶替。
    apply(ctx, { memberProvider: 'lumo-remote' })
    await flush()

    expect((ctx.get('agentTeams') as AgentTeamsService).capabilitiesOrNull()).toBeNull()
    expect(lines.some(line => line.includes('探测失败') && line.includes('只能读写团队状态'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('没有任何 provider 时也响亮失败，不静默装配成只读', async () => {
    const ctx = new Context()
    const lines = capture(ctx)
    ctx.provide('tools', toolsSpy())
    ctx.provide('subagents', subagentsSpy([]))
    apply(ctx, {})
    await flush()

    expect((ctx.get('agentTeams') as AgentTeamsService).capabilitiesOrNull()).toBeNull()
    expect(lines.some(line => line.includes('没有任何成员 provider 可用'))).toBe(true)
    await ctx.fiber.dispose()
  })

  it('非正整数配置被拒，不把「0 人」当合法值收下', async () => {
    const ctx = new Context()
    ctx.provide('tools', toolsSpy())
    expect(() => apply(ctx, { maxMembers: 0 })).toThrow(/maxMembers 必须是正整数/)
    await ctx.fiber.dispose()
  })

  it('销毁时注销全部工具', async () => {
    const { ctx, tools, service } = boot({}, { subagents: ['spawn'] })
    await flush()
    await service().create({ id: 'demo', name: '演示', topology: 'pipeline', subjects: ['a'], captainSessionId: 's' })
    expect(tools.live()).toBe(11)

    await ctx.fiber.dispose()

    expect(tools.live()).toBe(0)
  })
})

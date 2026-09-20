/**
 * `agent_threads_*` 工具面（§24.2 的线程档位）。
 *
 * 走**真实运行时**（假注册表 + 进程内会合面 + 假执行面），断言的是模型看到的那一面：
 * 注册了哪些工具、参数怎么被校验、一轮推进的返回形状、以及模型最容易踩的坑——
 * 把不存在的线程当成存在、自报轮次任务、在没有执行面时要求重派。
 */
import { describe, expect, it } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { MemoryCourier } from '../src/courier.ts'
import type { NodeLossNotice, ThreadRow, ThreadState } from '../src/thread.ts'
import type { CreateThreadInput, ThreadRegistryLike } from '../src/thread-registry.ts'
import { ThreadsRuntime, type ThreadRoundRunner } from '../src/threads.ts'
import { defineAgentThreadTools } from '../src/tools.ts'

const SIGNAL = new AbortController().signal
const COORDINATOR = { agent: { id: 'coord-session' }, signal: SIGNAL } as unknown as ToolRunContext
const NODE = 'node-a'

function row(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 't-1',
    realm: 'realm-1',
    project_id: 'proj-1',
    task_id: 'task-7',
    coordinator_session_ref: 'coord-session',
    session_ref: 'sess-1',
    node_id: NODE,
    workspace: 'thread/t-1/',
    state: 'running',
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
    ...overrides,
  }
}

/** 假注册表：echo 请求体（这样断言才验得到运行时真的把参数传下去了）。 */
function registrySpy(initial: ThreadRow, notices: NodeLossNotice[] = []): {
  registry: ThreadRegistryLike
  calls: string[]
  current: () => ThreadRow
} {
  const calls: string[] = []
  let current = initial
  return {
    calls,
    current: () => current,
    registry: {
      create: async (input: CreateThreadInput) => {
        calls.push(`create:${input.id}`)
        current = {
          ...current,
          id: input.id,
          project_id: input.project_id,
          task_id: input.task_id,
          coordinator_session_ref: input.coordinator_session_ref,
          session_ref: input.session_ref,
          node_id: input.node_id,
          workspace: input.workspace ?? `thread/${input.id}/`,
          state: 'idle',
        }
        return current
      },
      get: async (threadId: string) => {
        calls.push(`get:${threadId}`)
        return threadId === current.id ? current : undefined
      },
      list: async () => {
        calls.push('list')
        return [current]
      },
      transition: async (threadId: string, to: ThreadState) => {
        calls.push(`transition:${threadId}:${to}`)
        current = { ...current, state: to }
        return current
      },
      nodeLoss: async (threadId: string, nodeId: string) => {
        calls.push(`nodeLoss:${threadId}:${nodeId}`)
        current = { ...current, state: 'failed' }
        return current
      },
      nodeLossNotices: async () => {
        calls.push('nodeLossNotices')
        return notices
      },
    },
  }
}

interface Harness {
  tools: Map<string, ToolDefinition>
  runtime: ThreadsRuntime
  calls: string[]
  current: () => ThreadRow
  rounds: { threadId: string; attempt: number; prompt: string }[]
  call: (name: string, args: unknown, exec?: ToolRunContext) => Promise<unknown>
  dispose: () => void
}

function harness(initial = row(), notices: NodeLossNotice[] = [], config: { runner?: boolean } = {}): Harness {
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

  const spy = registrySpy(initial, notices)
  const rounds: Harness['rounds'] = []
  const runner: ThreadRoundRunner = {
    start: async input => {
      rounds.push({ threadId: input.thread.id, attempt: input.round.attempt, prompt: input.prompt })
      return { runId: 'child-9' }
    },
  }
  // 会合面在解析器之外建一次：每次现建会让等待项在两次调用之间蒸发（真实装配里它是服务）。
  const courier = new MemoryCourier()
  const runtime = new ThreadsRuntime({
    resolveCourier: () => courier,
    resolveRegistry: () => spy.registry,
    nodeId: NODE,
    workspaceRoot: '/srv/lumo/ws',
    ...config.runner === false ? {} : { resolveRunner: () => runner },
  })
  const dispose = defineAgentThreadTools(ctx, runtime, { maxWaitMs: 5_000 })
  const call = async (name: string, args: unknown, exec: ToolRunContext = COORDINATOR): Promise<unknown> => {
    const definition = tools.get(name)
    if (definition === undefined) throw new Error(`未注册的工具：${name}`)
    return definition.execute(args, exec)
  }
  return { tools, runtime, calls: spy.calls, current: spy.current, rounds, call, dispose }
}

describe('线程工具面注册', () => {
  it('注册全部 6 个 agent_threads_* 工具，名字无遗漏', () => {
    expect([...harness().tools.keys()].sort()).toEqual([
      'agent_threads_advance',
      'agent_threads_await',
      'agent_threads_create',
      'agent_threads_pause',
      'agent_threads_reassign',
      'agent_threads_status',
    ])
  })

  it('每个工具都有描述、入参 schema 与输出渲染；注销后全部消失', () => {
    const h = harness()
    for (const [name, definition] of h.tools) {
      expect(definition.description.length, name).toBeGreaterThan(0)
      expect(definition.parameters, name).toMatchObject({ type: 'object' })
      expect(definition.output.render({}, { a: 1 }), name).toEqual([{ type: 'text', text: '{"a":1}' }])
    }
    h.dispose()
    expect(h.tools.size).toBe(0)
  })

  it('没有「上报节点丢失」这个工具（模型能自己关掉一条好线程就是要防的形状）', () => {
    expect([...harness().tools.keys()].some(name => name.includes('node'))).toBe(false)
  })
})

describe('建 / 查 / 暂停', () => {
  it('create 把协调者记成**本次调用所在的会话**（模型自报会送到别人手里）', async () => {
    const h = harness()
    const created = await h.call('agent_threads_create', {
      threadId: 't-9', projectId: 'proj-2', taskId: 'task-9', sessionRef: 'sess-9', nodeId: 'node-b',
    })
    expect(h.calls).toEqual(['create:t-9'])
    expect(created).toMatchObject({
      threadId: 't-9', projectId: 'proj-2', sessionRef: 'sess-9', nodeId: 'node-b',
      coordinatorSessionRef: 'coord-session',
    })
    // 必填项缺一个就拒（空串 ≠ 没有这个字段）。
    await expect(h.call('agent_threads_create', {
      threadId: 't-9', projectId: 'proj-2', taskId: 'task-9', sessionRef: '  ', nodeId: 'node-b',
    })).rejects.toThrow(/sessionRef 必须是非空字符串/)
  })

  it('status 单条与列表两种形态；不存在的线程返回 found=false 而不是抛', async () => {
    const h = harness()
    await expect(h.call('agent_threads_status', { threadId: 't-1' }))
      .resolves.toMatchObject({ found: true, thread: { threadId: 't-1', state: 'running' } })
    await expect(h.call('agent_threads_status', { threadId: 'nope' })).resolves.toEqual({ found: false })
    const list = await h.call('agent_threads_status', { projectId: 'proj-1', state: 'running' }) as {
      threads: unknown[]; capabilities: { roundRunner: boolean }
    }
    expect(list.threads).toHaveLength(1)
    expect(list.capabilities.roundRunner).toBe(true)
    // 闭集外的 state 直接拒：空集会让「拼错了」看起来像「确实没有」。
    await expect(h.call('agent_threads_status', { state: 'paused' })).rejects.toThrow(/state 必须是/)
  })

  it('pause 走状态转移（终态由服务端判），不自己判合法边', async () => {
    const h = harness()
    await expect(h.call('agent_threads_pause', { threadId: 't-1' }))
      .resolves.toMatchObject({ threadId: 't-1', state: 'stopped' })
    expect(h.calls).toEqual(['transition:t-1:stopped'])
  })
})

describe('推进与等待', () => {
  it('advance=suspend 先 arm 再推状态，并把通道与 TTL 带回来', async () => {
    const h = harness(row({ state: 'running' }))
    const result = await h.call('agent_threads_advance', { threadId: 't-1', action: 'suspend', attempt: 1 })
    expect(result).toMatchObject({ threadId: 't-1', state: 'awaiting', channel: 'thread/t-1/wake/1', ttlMs: 30 * 60_000 })
    expect(h.calls).toEqual(['get:t-1', 'get:t-1', 'transition:t-1:awaiting'])
  })

  it('轮次的任务来自**行本身**：模型自报任务无处可传（归因不会跑到别的任务上）', async () => {
    const h = harness(row({ state: 'running' }))
    // 先挂起（arm 出等待项），再唤醒：唤醒要求「有等待方」，没有等待项的唤醒会被拒绝。
    await h.call('agent_threads_advance', { threadId: 't-1', action: 'suspend', attempt: 1 })
    await expect(h.call('agent_threads_advance', { threadId: 't-1', action: 'wake', attempt: 1, taskId: 'task-99' }))
      .resolves.toMatchObject({ state: 'running', settled: 'settled' })
    // 传了 taskId 也不会被采纳：这一轮的归因键始终是行上的 task-7。
    expect(h.calls.filter(entry => entry.startsWith('transition')))
      .toEqual(['transition:t-1:awaiting', 'transition:t-1:running'])
  })

  it('不存在的线程：动作响亮拒绝（而不是「什么也没发生」）', async () => {
    const h = harness()
    await expect(h.call('agent_threads_advance', { threadId: 'nope', action: 'suspend', attempt: 1 }))
      .rejects.toThrow(/线程 nope 不存在/)
    await expect(h.call('agent_threads_await', { threadId: 'nope', attempt: 1 }))
      .rejects.toThrow(/线程 nope 不存在/)
  })

  it('attempt 必须是 >= 1 的整数（0 表示从未派发，不是一轮）', async () => {
    const h = harness()
    for (const attempt of [0, -1, 1.5, '一']) {
      await expect(h.call('agent_threads_advance', { threadId: 't-1', action: 'suspend', attempt }))
        .rejects.toThrow(/attempt 必须是/)
    }
  })

  it('action 闭集外的值被拒（不猜成 suspend 或 wake）', async () => {
    const h = harness()
    await expect(h.call('agent_threads_advance', { threadId: 't-1', action: 'resume', attempt: 1 }))
      .rejects.toThrow(/action 必须是 suspend \/ wake/)
  })

  it('等待上限被夹到服务端上限：模型不能要求「一直等」', async () => {
    const h = harness(row({ state: 'awaiting' }), [{
      seq: 1, realm: 'realm-1', thread_id: 't-1', node_id: NODE, session_ref: 'sess-1',
      coordinator_session_ref: 'coord-session', reason: '节点没了', created_at: '2026-09-20T10:00:00Z',
    }])
    const outcome = await h.call('agent_threads_await', { threadId: 't-1', attempt: 1, timeoutMs: 10 ** 9 })
    // 通知已落库：立刻返回 node-lost，并把它投进唤醒通道（等待者读到的是同一个事实）。
    expect(outcome).toMatchObject({ state: 'node-lost', channel: 'thread/t-1/wake/1' })
  })
})

describe('重派', () => {
  it('重派走完整链路：读回失败的行 → 建新线程 → 开新一轮（task_id 取自行）', async () => {
    const h = harness(row({ state: 'failed' }))
    const result = await h.call('agent_threads_reassign', {
      threadId: 't-1', previousAttempt: 1, newNodeId: 'node-b', newSessionRef: 'sess-2', prompt: '接着干',
    })
    expect(result).toMatchObject({
      threadId: 't-1-r2', replaced: 't-1', runId: 'child-9',
      round: { task_id: 'task-7', attempt: 2 },
      thread: { nodeId: 'node-b', sessionRef: 'sess-2', workspace: 'thread/t-1-r2/', state: 'idle' },
    })
    expect(h.rounds).toEqual([{ threadId: 't-1-r2', attempt: 2, prompt: '接着干' }])
  })

  it('没有执行面时重派拒绝（能读能唤醒 ≠ 能重派）', async () => {
    const h = harness(row({ state: 'failed' }), [], { runner: false })
    await expect(h.call('agent_threads_reassign', {
      threadId: 't-1', previousAttempt: 1, newNodeId: 'node-b', newSessionRef: 'sess-2', prompt: 'p',
    })).rejects.toThrow(/执行面/)
    expect(h.runtime.capabilities().roundRunner).toBe(false)
  })

  it('放回刚丢的节点被拒（静默失败：行看起来正常，却永远不会被推进）', async () => {
    const h = harness(row({ state: 'failed' }))
    await expect(h.call('agent_threads_reassign', {
      threadId: 't-1', previousAttempt: 1, newNodeId: NODE, newSessionRef: 'sess-2', prompt: 'p',
    })).rejects.toThrow(/node-reused/)
  })

  it('必填项与代数都要过闸', async () => {
    const h = harness(row({ state: 'failed' }))
    await expect(h.call('agent_threads_reassign', {
      threadId: 't-1', previousAttempt: 1, newNodeId: 'node-b', newSessionRef: '', prompt: 'p',
    })).rejects.toThrow(/newSessionRef 必须是非空字符串/)
    await expect(h.call('agent_threads_reassign', {
      threadId: 't-1', previousAttempt: 0, newNodeId: 'node-b', newSessionRef: 'sess-2', prompt: 'p',
    })).rejects.toThrow(/attempt 必须是/)
    // 判据拒绝发生在任何副作用之前：注册表一次都没被写。
    expect(h.calls.filter(entry => entry.startsWith('create'))).toEqual([])
  })
})

/**
 * 线程运行时（§24.2 的装配面）。
 *
 * 注册表用假实现、会合面用 `MemoryCourier`：验的是**顺序与拒绝面**——先 arm 再推状态、
 * 缺装配即抛、跨节点不推进。这两条错在任何一边，症状都是「线程永远不醒」或
 * 「一条线程两个执行者」，而它们在日志上都长得像正常。
 */
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { MemoryCourier } from '../src/courier.ts'
import {
  ThreadWakeRefusedError, ThreadWorkspaceError,
  type NodeLossNotice, type ThreadRow, type ThreadState,
} from '../src/thread.ts'
import type { CreateThreadInput, ThreadRegistryLike } from '../src/thread-registry.ts'
import {
  ThreadReassignConflictError, ThreadReassignRefusedError,
  ThreadsRuntime, ThreadsUnavailableError, type ThreadRoundRunner,
} from '../src/threads.ts'

const NODE = 'node-a'

function row(overrides: Partial<ThreadRow> = {}): ThreadRow {
  return {
    id: 't-1',
    realm: 'realm-1',
    project_id: 'proj-1',
    task_id: 'task-7',
    coordinator_session_ref: 'coord-1',
    session_ref: 'sess-1',
    node_id: NODE,
    workspace: 'thread/t-1/',
    state: 'running',
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-20T10:00:00Z',
    ...overrides,
  }
}

/** 一条节点失联通知（默认给 t-1）。 */
function notice(overrides: Partial<NodeLossNotice> = {}): NodeLossNotice {
  return {
    seq: 1,
    realm: 'realm-1',
    thread_id: 't-1',
    node_id: NODE,
    session_ref: 'sess-1',
    coordinator_session_ref: 'coord-1',
    reason: '承载节点 node-a 丢失',
    created_at: '2026-09-20T10:00:00Z',
    ...overrides,
  }
}

/** 假注册表：记录调用顺序，状态推进按被请求的目标改行。 */
function registrySpy(initial: ThreadRow, options: {
  /** `nodeLossNotices` 的返回（可抛：验「读不到通知不等于没有通知」）。 */
  notices?: NodeLossNotice[] | Error
  /** `create` 的拒绝（缺省返回当前行）。 */
  createError?: Error
} = {}): {
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
        if (options.createError !== undefined) throw options.createError
        // 假注册表照实回声请求体：这样断言才验得到运行时**真的把新节点/新会话传下去了**。
        return {
          ...current,
          id: input.id,
          realm: 'realm-1',
          project_id: input.project_id,
          task_id: input.task_id,
          coordinator_session_ref: input.coordinator_session_ref,
          session_ref: input.session_ref,
          node_id: input.node_id,
          workspace: input.workspace ?? `thread/${input.id}/`,
          state: 'idle',
        }
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
        if (options.notices instanceof Error) throw options.notices
        return options.notices ?? []
      },
    },
  }
}

function runtime(options: {
  registry?: ThreadRegistryLike
  nodeId?: string
  workspaceRoot?: string
  courier?: MemoryCourier
  runner?: ThreadRoundRunner
  warn?: (message: string) => void
} = {}): ThreadsRuntime {
  const courier = options.courier ?? new MemoryCourier()
  return new ThreadsRuntime({
    resolveCourier: () => courier,
    resolveRegistry: () => options.registry,
    nodeId: options.nodeId ?? NODE,
    ...options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot },
    resolveRunner: () => options.runner,
    ...options.warn === undefined ? {} : { warn: options.warn },
  })
}

describe('能力画像与缺装配', () => {
  it('四样能力各自可查（运维一眼看出缺哪一样）', () => {
    const spy = registrySpy(row())
    expect(runtime().capabilities()).toEqual({
      registry: false, durableWake: false, nodeIdentity: true, workspace: false, roundRunner: false,
    })
    expect(runtime({ registry: spy.registry, workspaceRoot: '/srv/ws' }).capabilities()).toEqual({
      registry: true, durableWake: false, nodeIdentity: true, workspace: true, roundRunner: false,
    })
    expect(runtime({ nodeId: '' }).capabilities().nodeIdentity).toBe(false)
  })

  it('缺注册表即抛，而不是静默什么也不做', async () => {
    // 静默返回的后果是现场以为线程挂起来了，其实没有任何等待项。
    const threads = runtime()
    expect(() => threads.getThread('t-1')).toThrow(ThreadsUnavailableError)
    await expect(threads.nodeLost('t-1')).rejects.toThrow(ThreadsUnavailableError)
  })

  it('缺工作区根时解析工作目录即抛（工作目录是节点局部事实，不能靠猜）', () => {
    expect(() => runtime().workspacePath(row())).toThrow(/工作区根/)
    expect(runtime({ workspaceRoot: '/srv/ws' }).workspacePath(row())).toBe('/srv/ws/thread/t-1')
  })
})

describe('挂起：先 arm 再推状态', () => {
  it('顺序是 arm → transition(awaiting)，且等待项真的在会合面上', async () => {
    const spy = registrySpy(row({ state: 'running' }))
    const courier = new MemoryCourier()
    const threads = runtime({ registry: spy.registry, courier })
    const round = { task_id: 'task-7', attempt: 1 }

    const result = await threads.suspend({ threadId: 't-1', round })
    expect(spy.calls).toEqual(['get:t-1', 'transition:t-1:awaiting'])
    expect(result.channel).toBe('thread/t-1/wake/1')
    await expect(courier.state(result.channel)).resolves.toBe('pending')
  })

  it('跨节点挂起被拒：线程的现场在别的节点上', async () => {
    const spy = registrySpy(row({ state: 'running', node_id: 'node-b' }))
    await expect(runtime({ registry: spy.registry }).suspend({ threadId: 't-1', round: { task_id: 'task-7', attempt: 1 } }))
      .rejects.toThrow(ThreadWakeRefusedError)
    expect(spy.calls).toEqual(['get:t-1'])
  })

  it('没跑过的线程不能挂起（等一个从未 arm 的唤醒）', async () => {
    const spy = registrySpy(row({ state: 'idle' }))
    await expect(runtime({ registry: spy.registry }).suspend({ threadId: 't-1', round: { task_id: 'task-7', attempt: 1 } }))
      .rejects.toThrow(/从未被 arm/)
  })

  it('线程不存在时报错，而不是建一个无主的等待项', async () => {
    const spy = registrySpy(row())
    await expect(runtime({ registry: spy.registry }).suspend({ threadId: 't-9', round: { task_id: 'task-7', attempt: 1 } }))
      .rejects.toThrow(/不存在/)
  })

  it('状态推不上去时留痕：等待项已建立（会在 TTL 后进死信）', async () => {
    const warnings: string[] = []
    const spy = registrySpy(row({ state: 'running' }))
    const failing: ThreadRegistryLike = {
      ...spy.registry,
      transition: async () => {
        throw new Error('409 并发状态变更')
      },
    }
    await expect(runtime({ registry: failing, warn: message => warnings.push(message) })
      .suspend({ threadId: 't-1', round: { task_id: 'task-7', attempt: 1 } }))
      .rejects.toThrow(/并发状态变更/)
    expect(warnings.join('\n')).toContain('thread/t-1/wake/1')
    expect(warnings.join('\n')).toContain('死信')
  })
})

describe('唤醒：兑现等待项 → 推新一轮', () => {
  async function suspended(): Promise<{ threads: ThreadsRuntime; spy: ReturnType<typeof registrySpy>; courier: MemoryCourier }> {
    const spy = registrySpy(row({ state: 'running' }))
    const courier = new MemoryCourier()
    const threads = runtime({ registry: spy.registry, courier })
    await threads.suspend({ threadId: 't-1', round: { task_id: 'task-7', attempt: 1 } })
    spy.calls.length = 0
    return { threads, spy, courier }
  }

  it('resume 兑现等待项并把状态推回 running', async () => {
    const { threads, spy } = await suspended()
    const result = await threads.resume({ threadId: 't-1', round: { task_id: 'task-7', attempt: 1 }, event: { reason: 'ci-green' } })
    expect(result.settled).toEqual({ status: 'settled' })
    expect(result.thread.state).toBe('running')
    expect(spy.calls).toEqual(['get:t-1', 'transition:t-1:running'])
  })

  it('等待项不存在即拒绝：不得把「没人等的唤醒」记成一轮续跑', async () => {
    const spy = registrySpy(row({ state: 'awaiting' }))
    await expect(runtime({ registry: spy.registry }).resume({
      threadId: 't-1', round: { task_id: 'task-7', attempt: 1 }, event: 'ghost',
    })).rejects.toThrow(/等待项不存在/)
    // 状态没有被推：只有一次读。
    expect(spy.calls).toEqual(['get:t-1'])
  })

  it('跨节点唤醒被拒：唤醒是唯一能让 awaiting 线程动起来的入口，不能开成迁移后门', async () => {
    const spy = registrySpy(row({ state: 'awaiting', node_id: 'node-b' }))
    await expect(runtime({ registry: spy.registry }).resume({
      threadId: 't-1', round: { task_id: 'task-7', attempt: 1 }, event: 'x',
    })).rejects.toThrow(ThreadWakeRefusedError)
    expect(spy.calls).toEqual(['get:t-1'])
  })

  it('本节点没有身份时不 arm 也不推进（arm 出来没人能兑现）', async () => {
    const spy = registrySpy(row({ state: 'running' }))
    await expect(runtime({ registry: spy.registry, nodeId: '  ' }).suspend({
      threadId: 't-1', round: { task_id: 'task-7', attempt: 1 },
    })).rejects.toThrow(/local-node-unknown|节点身份/)
  })
})

describe('节点丢失与对账', () => {
  it('nodeLost 上报本节点身份，并把行推成 failed（不迁移）', async () => {
    const spy = registrySpy(row({ state: 'running' }))
    const updated = await runtime({ registry: spy.registry }).nodeLost('t-1')
    expect(updated.state).toBe('failed')
    expect(spy.calls).toEqual(['nodeLoss:t-1:node-a'])
  })

  it('本节点没有身份时不猜：拒绝上报', async () => {
    const spy = registrySpy(row())
    await expect(runtime({ registry: spy.registry, nodeId: '' }).nodeLost('t-1')).rejects.toThrow(/没有身份/)
    expect(spy.calls).toEqual([])
  })

  it('reconcile 直通唤醒层（只分桶，不改状态）', async () => {
    const spy = registrySpy(row({ state: 'running' }))
    const threads = runtime({ registry: spy.registry, courier: new MemoryCourier() })
    await threads.suspend({ threadId: 't-1', round: { task_id: 'task-7', attempt: 1 } })
    const result = await threads.reconcile([{
      thread: spy.current(), // suspend 之后是 awaiting
      round: { task_id: 'task-7', attempt: 1 },
    }])
    expect(result).toEqual({ running: ['t-1'], settling: [], stranded: [] })
    // 只读：状态还是 awaiting，没有被对账改写。
    expect(spy.current().state).toBe('awaiting')
  })
})

describe('工作目录物化（§24.3.2）', () => {
  it('建出目录：相对节点工作区根，且绝不进复制日志', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumo-thread-'))
    try {
      const threads = runtime({ registry: registrySpy(row()).registry, workspaceRoot: root })
      const first = await threads.materializeWorkspace(row())
      expect(first.path).toBe(join(root, 'thread/t-1'))
      expect(first.created).toBe(true)
      expect((await stat(first.path)).isDirectory()).toBe(true)
      // 重复物化是正常情况（重试、第二次挂起），不是错误。
      const again = await threads.materializeWorkspace(row())
      expect(again.created).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('符号链接被拒：它会指向根之外（或别的线程的目录），而两边的记录都自洽', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumo-thread-'))
    try {
      await mkdir(join(root, 'thread'), { recursive: true })
      await symlink('/etc', join(root, 'thread/t-1'))
      const threads = runtime({ registry: registrySpy(row()).registry, workspaceRoot: root })
      await expect(threads.materializeWorkspace(row())).rejects.toThrow(ThreadWorkspaceError)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('被普通文件占住时拒（继续用会互相破坏）；绝对路径的 workspace 也照旧拒', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lumo-thread-'))
    try {
      await mkdir(join(root, 'thread'), { recursive: true })
      await writeFile(join(root, 'thread/t-1'), 'x')
      const threads = runtime({ registry: registrySpy(row()).registry, workspaceRoot: root })
      await expect(threads.materializeWorkspace(row())).rejects.toThrow(/不是目录/)

      const absolute = runtime({ registry: registrySpy(row()).registry, workspaceRoot: root })
      await expect(absolute.materializeWorkspace(row({ workspace: '/etc/thread/t-1/' })))
        .rejects.toThrow(/不能是绝对路径/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('节点失联通知的消费与重派（§24.2.3(4)）', () => {
  it('通知先到：返回 node-lost，且它**同时**被投进唤醒通道（后到的等待者读到同一个事实）', async () => {
    const spy = registrySpy(row({ state: 'awaiting' }), { notices: [notice()] })
    const courier = new MemoryCourier()
    const threads = runtime({ registry: spy.registry, courier, nodeId: NODE })
    const round = { task_id: 'task-7', attempt: 1 }

    const outcome = await threads.awaitThreadRound({ threadId: 't-1', round, timeoutMs: 5_000, pollMs: 10 })
    expect(outcome.state).toBe('node-lost')
    if (outcome.state !== 'node-lost') throw new Error('unreachable')
    expect(outcome.notice.node_id).toBe(NODE)
    expect(outcome.channel).toBe('thread/t-1/wake/1')
    // 通知落在通道上（持久化）而不是只回给一个调用方。
    const settled = await courier.await('thread/t-1/wake/1', 10)
    expect(settled.state).toBe('resolved')
    if (settled.state === 'resolved') {
      expect(settled.value).toMatchObject({ kind: 'node-lost', node_id: NODE, reassign_run: true })
    }
  })

  it('事件先到就返回事件结局（通知只是另一条路，不改变正常路径）', async () => {
    const spy = registrySpy(row({ state: 'awaiting' }), { notices: [] })
    const courier = new MemoryCourier()
    const threads = runtime({ registry: spy.registry, courier, nodeId: NODE })
    const round = { task_id: 'task-7', attempt: 1 }
    // 等待项先 arm 好（真实路径上是 suspend 做的），再由事件方（人或别的 agent）兑现。
    await courier.open('thread/t-1/wake/1', 60_000)
    await courier.settle('thread/t-1/wake/1', { kind: 'ci-green' })
    const outcome = await threads.awaitThreadRound({ threadId: 't-1', round, timeoutMs: 2_000, pollMs: 10 })
    expect(outcome).toEqual({ state: 'resolved', value: { kind: 'ci-green' } })
  })

  it('读不到通知 ≠ 没有通知：只告警，继续等（一次协作服务抖动不该变成一次重派）', async () => {
    const spy = registrySpy(row({ state: 'awaiting' }), { notices: new Error('协作服务不可达') })
    const courier = new MemoryCourier()
    const warnings: string[] = []
    const threads = runtime({ registry: spy.registry, courier, nodeId: NODE, warn: message => warnings.push(message) })
    const round = { task_id: 'task-7', attempt: 1 }
    await courier.open('thread/t-1/wake/1', 60_000)
    const pending = threads.awaitThreadRound({ threadId: 't-1', round, timeoutMs: 2_000, pollMs: 10 })
    await new Promise(resolve => setTimeout(resolve, 50))
    await courier.settle('thread/t-1/wake/1', { kind: 'ci-green' })
    await expect(pending).resolves.toEqual({ state: 'resolved', value: { kind: 'ci-green' } })
    expect(warnings.some(line => line.includes('读线程 t-1 的节点失联通知失败'))).toBe(true)
  })

  it('重派：新建线程 + 开新一轮 Run（不是复用旧 Run，也不是复活旧线程）', async () => {
    const spy = registrySpy(row({ state: 'failed' }))
    const rounds: { threadId: string; attempt: number; prompt: string }[] = []
    const runner: ThreadRoundRunner = {
      start: async input => {
        rounds.push({ threadId: input.thread.id, attempt: input.round.attempt, prompt: input.prompt })
        return { runId: 'child-9' }
      },
    }
    const threads = runtime({ registry: spy.registry, runner, nodeId: NODE })
    const result = await threads.reassignAfterNodeLoss({
      thread: row({ state: 'failed' }),
      previousRound: { task_id: 'task-7', attempt: 1 },
      newNodeId: 'node-b',
      newSessionRef: 'sess-2',
      prompt: '接着上一轮继续',
    })
    expect(result.thread.id).toBe('t-1-r2')
    expect(result.thread.node_id).toBe('node-b')
    expect(result.thread.session_ref).toBe('sess-2')
    expect(result.round).toEqual({ task_id: 'task-7', attempt: 2 })
    expect(result.runId).toBe('child-9')
    // 先建行、再开跑：顺序反了会造出一个不可见的执行者（占着机器、烧着配额、没人知道它是谁）。
    expect(spy.calls).toEqual(['create:t-1-r2'])
    expect(rounds).toEqual([{ threadId: 't-1-r2', attempt: 2, prompt: '接着上一轮继续' }])
  })

  it('没失败的线程不许重派；没有执行面就不重派（判据与装配各自响亮）', async () => {
    const spy = registrySpy(row({ state: 'running' }))
    const runner: ThreadRoundRunner = { start: async () => ({ runId: 'x' }) }
    await expect(runtime({ registry: spy.registry, runner }).reassignAfterNodeLoss({
      thread: row({ state: 'running' }),
      previousRound: { task_id: 'task-7', attempt: 1 },
      newNodeId: 'node-b', newSessionRef: 'sess-2', prompt: 'p',
    })).rejects.toThrow(ThreadReassignRefusedError)

    await expect(runtime({ registry: spy.registry }).reassignAfterNodeLoss({
      thread: row({ state: 'failed' }),
      previousRound: { task_id: 'task-7', attempt: 1 },
      newNodeId: 'node-b', newSessionRef: 'sess-2', prompt: 'p',
    })).rejects.toThrow(/执行面/)
    expect(spy.calls).toEqual([])
  })

  it('重复重派撞上注册表冲突时看得见（同一个失败线程会算出同一个新 id）', async () => {
    const conflict = Object.assign(new Error('HTTP 409：该线程 id 已被占用'), { status: 409 })
    const spy = registrySpy(row({ state: 'failed' }), { createError: conflict })
    const runner: ThreadRoundRunner = { start: async () => ({ runId: 'x' }) }
    await expect(runtime({ registry: spy.registry, runner }).reassignAfterNodeLoss({
      thread: row({ state: 'failed' }),
      previousRound: { task_id: 'task-7', attempt: 1 },
      newNodeId: 'node-b', newSessionRef: 'sess-2', prompt: 'p',
    })).rejects.toThrow(ThreadReassignConflictError)
  })
})

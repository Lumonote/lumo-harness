import { describe, expect, it, vi } from 'vitest'
import { collaborationThreads, type RegisteredThread } from '../src/collaboration-threads.ts'

const registered = (overrides: Partial<RegisteredThread> = {}): RegisteredThread => ({
  id: 'th-a', realm: 'a', task_id: 'visible', session_ref: 'session-a', node_id: 'node-1',
  state: 'running', updated_at: '2026-11-06T04:00:00Z', ...overrides,
})

describe('线程看板授权聚合', () => {
  it('损坏的治理游标不能被解释为已到最后一页', async () => {
    for (const next_cursor of [null, 1, {}, 'a'.repeat(4097)]) {
      const listThreads = vi.fn(async () => [])
      await expect(collaborationThreads({ realm: 'a', tasks: { tasks: [], next_cursor }, registry: { listThreads } })).rejects.toThrow('任务游标不合法')
      expect(listThreads).not.toHaveBeenCalled()
    }
  })
  it('使用生产任务响应形状，只关联可见任务与当前租户，不读取越权会话', async () => {
    const controls = vi.fn(async () => ({ realm: 'a', controls: [{
      session_ref: 'session-a', registered: true, state: 'awaiting-approval', updated_at: '2026-11-06T05:00:00Z',
    }] }))
    const result = await collaborationThreads({
      realm: 'a', tasks: { tasks: [{ id: 'visible', title: '可见任务', business_state: 'EXECUTING' }] },
      registry: { listThreads: async () => [registered(), registered({ id: 'secret', task_id: 'hidden', session_ref: 'secret' }), registered({ id: 'foreign', realm: 'b', session_ref: 'foreign' })] },
      controls,
    })
    expect(controls).toHaveBeenCalledExactlyOnceWith(['session-a'])
    expect(result.threads).toEqual([expect.objectContaining({
      id: 'thread:th-a', title: '可见任务 · th-a', task_id: 'visible', node_id: 'node-1',
      control_state: 'awaiting-approval', control_updated_at: '2026-11-06T05:00:00Z',
    })])
    expect(result.capabilities).toEqual({ threadRegistry: true, controlState: true })
  })

  it('每批至多100个会话；一个批次失败仍保留其他批次的真实结果', async () => {
    const controls = vi.fn(async (refs: string[]) => {
      if (refs.includes('s100')) throw new Error('unavailable')
      return { realm: 'a', controls: refs.map(session_ref => ({ session_ref, registered: false, state: null })) }
    })
    const result = await collaborationThreads({
      realm: 'a', tasks: { tasks: [{ id: 'visible' }] },
      registry: { listThreads: async () => Array.from({ length: 101 }, (_, i) => registered({ id: `t${i}`, session_ref: `s${i}` })) },
      controls,
    })
    expect(controls.mock.calls.map(([refs]) => refs.length)).toEqual([100, 1])
    expect(result.threads[0]?.control_state).toBeNull()
    expect(result.threads[100]?.control_state).toBeUndefined()
    expect(result.errors).toContain('部分会话控制态暂时不可读')
  })

  it('无绑定不猜 session，不把未登记会话写成 running', async () => {
    const controls = vi.fn(async () => ({ realm: 'a', controls: [] }))
    const result = await collaborationThreads({ realm: 'a', tasks: [{ id: 'legacy' }], controls })
    expect(controls).not.toHaveBeenCalled()
    expect(result.missingSessionRefs).toBe(1)
    expect(result.threads[0]?.control_state).toBeUndefined()
    expect(result.errors).toContain('线程注册表未装配')
  })

  it('控制态租户错误和不完整批次均不视为已读', async () => {
    for (const controls of [
      async () => ({ realm: 'b', controls: [{ session_ref: 'session-a', registered: true, state: 'paused' }] }),
      async () => ({ realm: 'a', controls: [] }),
    ]) {
      const result = await collaborationThreads({ realm: 'a', tasks: [{ id: 'visible' }], registry: { listThreads: async () => [registered()] }, controls })
      expect(result.threads[0]?.control_state).toBeUndefined()
      expect(result.errors).toContain('部分会话控制态暂时不可读')
    }
  })

  it('同一批次必须完整通过校验，不能留下半批已读结果', async () => {
    const result = await collaborationThreads({
      realm: 'a', tasks: [{ id: 'visible' }],
      registry: { listThreads: async () => [registered(), registered({ id: 'second', session_ref: 'session-b' })] },
      controls: async () => ({ realm: 'a', controls: [{ session_ref: 'session-a', registered: true, state: 'paused' }] }),
    })
    expect(result.threads.every(thread => thread.control_state === undefined)).toBe(true)
    expect(result.errors).toContain('部分会话控制态暂时不可读')
  })

  it('500条线程后继续读相同任务页，任务与线程游标互不覆盖', async () => {
    const rows = Array.from({ length: 501 }, (_, i) => registered({ id: `thread-${String(i).padStart(4, '0')}`, session_ref: `session-${i}` }))
    const listThreads = vi.fn(async (query?: { after?: string }) => rows.filter(row => query?.after === undefined || row.id > query.after).slice(0, 500))
    const options = { realm: 'a', tasks: { tasks: [{ id: 'visible' }], next_cursor: 'next-task-page' }, registry: { listThreads } }
    const first = await collaborationThreads(options)
    expect(first.threads).toHaveLength(500)
    expect(first.pagination).toEqual({ nextTaskCursor: 'next-task-page', nextThreadCursor: 'thread-0499', taskCount: 1 })
    const second = await collaborationThreads({ ...options, threadAfter: first.pagination.nextThreadCursor })
    expect(second.threads.map(thread => thread.id)).toEqual(['thread:thread-0500'])
    expect(second.pagination).toEqual({ nextTaskCursor: 'next-task-page', nextThreadCursor: '', taskCount: 1 })
    expect(listThreads.mock.calls).toEqual([[{ limit: 500, taskIds: ['visible'] }], [{ limit: 500, taskIds: ['visible'], after: 'thread-0499' }]])
  })

  it('空任务页不查注册表；旧治理响应达到200条时显式提示不完整', async () => {
    const listThreads = vi.fn(async () => [])
    const empty = await collaborationThreads({ realm: 'a', tasks: { tasks: [], next_cursor: '' }, registry: { listThreads } })
    expect(listThreads).not.toHaveBeenCalled()
    expect(empty.pagination).toEqual({ nextTaskCursor: '', nextThreadCursor: '', taskCount: 0 })
    for (const tasks of [{ tasks: Array.from({ length: 200 }, (_, i) => ({ id: `task-${i}` })) }, Array.from({ length: 200 }, (_, i) => ({ id: `task-${i}` }))]) {
      const legacy = await collaborationThreads({ realm: 'a', tasks, registry: { listThreads } })
      expect(legacy.errors).toContain('治理服务未返回分页信息，任务列表可能不完整')
    }
  })

  it('注册表读取失败不产生继续游标，保留可见任务并报告缺口', async () => {
    const result = await collaborationThreads({
      realm: 'a', tasks: { tasks: [{ id: 'visible' }], next_cursor: 'next-task' }, threadAfter: 'thread-0499',
      registry: { listThreads: async () => { throw new Error('registry down') } },
    })
    expect(result.threads.map(thread => thread.id)).toEqual(['visible'])
    expect(result.pagination).toEqual({ nextTaskCursor: 'next-task', nextThreadCursor: '', taskCount: 1 })
    expect(result.capabilities.threadRegistry).toBe(false)
    expect(result.errors).toContain('线程注册表暂时不可读')
  })

  it('治理页超过约定上限最多查询200个任务，并明确披露截断', async () => {
    const listThreads = vi.fn(async () => [])
    const result = await collaborationThreads({
      realm: 'a', tasks: { tasks: Array.from({ length: 201 }, (_, i) => ({ id: `task-${i}` })), next_cursor: '' }, registry: { listThreads },
    })
    expect(result.pagination.taskCount).toBe(200)
    expect(result.threads).toHaveLength(200)
    expect(listThreads).toHaveBeenCalledExactlyOnceWith({ limit: 500, taskIds: Array.from({ length: 200 }, (_, i) => `task-${i}`) })
    expect(result.errors).toContain('治理服务超过单页 200 条上限，当前页面不完整')
  })

  it('旧注册表忽略过滤或游标时不宣称可继续完整遍历', async () => {
    const repeated = Array.from({ length: 500 }, (_, i) => registered({ id: `t-${i}` }))
    const stuck = await collaborationThreads({
      realm: 'a', tasks: { tasks: [{ id: 'visible' }], next_cursor: '' }, threadAfter: 't-499',
      registry: { listThreads: async () => repeated },
    })
    expect(stuck.pagination.nextThreadCursor).toBe('')
    expect(stuck.errors).toContain('线程注册表游标未前进，请检查服务版本后重新读取')
    const outOfScope = await collaborationThreads({
      realm: 'a', tasks: { tasks: [{ id: 'visible' }], next_cursor: '' },
      registry: { listThreads: async () => [...repeated.slice(0, 499), registered({ id: 'secret', task_id: 'hidden', session_ref: 'secret-session' })] },
    })
    expect(outOfScope.threads).toHaveLength(499)
    expect(outOfScope.threads.some(row => row.session_ref === 'secret-session')).toBe(false)
    expect(outOfScope.pagination.nextThreadCursor).toBe('')
    expect(outOfScope.errors).toContain('线程注册表返回了授权范围之外的数据，列表可能不完整')
  })
})

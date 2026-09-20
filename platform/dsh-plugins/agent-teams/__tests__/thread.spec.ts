/**
 * 线程档位的判据（§24.2）。这些用例是**这一层唯一的执法面**：
 * 唤醒该不该由本节点做、TTL 有没有上限、工作目录能不能落在地上，全在这里钉住。
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_WAKE_TTL_MS, MAX_WAKE_TTL_MS, THREAD_STATES,
  ThreadRowError, ThreadWorkspaceError,
  nextRoundAfterLoss, nodeLossPayload, parseNodeLossNotice, parseThreadRow, planThreadReplacement,
  replacementThreadId, resolveThreadWorkspacePath, resolveWakeTtlMs, threadActionDecision, threadWakeChannel,
  wakePayload,
  type ThreadRound, type ThreadRow, type WakeDecision, type WakeRefusal,
} from '../src/thread.ts'

const NODE = 'node-a'

/** 取出拒绝理由；本该被拒却放行时直接失败（拒绝面的用例都靠它）。 */
function refusal(decision: WakeDecision): WakeRefusal {
  if (decision.allow) throw new Error('期望被拒绝，却放行了')
  return decision.reason
}

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
    state: 'awaiting',
    created_at: '2026-09-20T10:00:00Z',
    updated_at: '2026-09-20T10:05:00Z',
    ...overrides,
  }
}

const ROUND: ThreadRound = { task_id: 'task-7', attempt: 2 }

describe('线程行的解析（fail-closed）', () => {
  it('合法行原样通过，字段名与 §11 的列名一致', () => {
    const parsed = parseThreadRow(row())
    expect(Object.keys(parsed).sort()).toEqual([
      'coordinator_session_ref', 'created_at', 'id', 'node_id', 'project_id', 'realm',
      'session_ref', 'state', 'task_id', 'updated_at', 'workspace',
    ])
  })

  it('未知状态直接抛，而不是「未知即跳过」', () => {
    // 跳过的症状是一条**永远不醒**的线程：唤醒判据会给 state-not-awaiting，
    // 而库里那一行看起来完全正常。
    const unknown = 'paused' as unknown as ThreadRow['state']
    expect(() => parseThreadRow(row({ state: unknown }))).toThrow(ThreadRowError)
    expect(() => parseThreadRow(row({ state: unknown }))).toThrow(/合法取值/)
  })

  it('缺字段、空字段、脏 id、不可解析时间一律抛', () => {
    expect(() => parseThreadRow(row({ node_id: '' }))).toThrow(/node_id/)
    expect(() => parseThreadRow(row({ id: 't/1' }))).toThrow(/只允许/)
    expect(() => parseThreadRow(row({ created_at: '不是时间' }))).toThrow(/可解析的时间/)
    expect(() => parseThreadRow(row({ workspace: '   ' }))).toThrow(/workspace/)
    expect(() => parseThreadRow('nope')).toThrow(/不是对象/)
    expect(() => parseThreadRow(null)).toThrow(/不是对象/)
  })

  it('给了 threadId 就必须对上：读到的行不能是别人', () => {
    // 分页错位/缓存串号在返回体里长得一模一样，只能在这里拦。
    expect(() => parseThreadRow(row({ id: 't-2' }), 't-1')).toThrow(/请求的是 t-1/)
    expect(parseThreadRow(row(), 't-1').id).toBe('t-1')
  })

  it('六个状态都在闭集里（含 failed —— 节点丢失的落点）', () => {
    for (const state of THREAD_STATES) {
      expect(parseThreadRow(row({ state })).state).toBe(state)
    }
    expect(THREAD_STATES).toContain('failed')
  })
})

describe('推进判据（§24.2.1 的承载节点亲和 + §24.2.2 的一轮 = 一个 Run）', () => {
  const wake = (thread: ThreadRow, nodeId = NODE, round: ThreadRound = ROUND) =>
    threadActionDecision({ thread, nodeId, round, action: 'wake' })
  const suspend = (thread: ThreadRow, nodeId = NODE, round: ThreadRound = ROUND) =>
    threadActionDecision({ thread, nodeId, round, action: 'suspend' })

  it('源状态 + 本节点 + 轮次都对得上 → 允许（挂起要求 running，唤醒要求 awaiting）', () => {
    expect(wake(row())).toEqual({ allow: true })
    expect(suspend(row({ state: 'running' }))).toEqual({ allow: true })
  })

  it('本节点身份未知时拒绝，且排在所有具体判据之前', () => {
    // 这条与其他四条不是一类：那四条是判断结果，这条是**判断不了**。顺序即归因 ——
    // 先报它，现场才会去查装配，而不是去查线程。
    for (const nodeId of ['', '   ']) {
      expect(wake(row({ node_id: 'node-b', state: 'running' }), nodeId))
        .toMatchObject({ allow: false, reason: 'local-node-unknown' })
      expect(suspend(row({ node_id: 'node-b', state: 'idle' }), nodeId))
        .toMatchObject({ allow: false, reason: 'local-node-unknown' })
    }
  })

  it('线程不承载在本节点 → node-mismatch（跨节点推进就是迁移的后门）', () => {
    const decision = wake(row({ node_id: 'node-b' }))
    expect(decision).toMatchObject({ allow: false, reason: 'node-mismatch' })
    if (!decision.allow) expect(decision.detail).toContain('node-b')
  })

  it('唤醒只接受 awaiting：running 已被占用，终态不可复活', () => {
    const busy = wake(row({ state: 'running' }))
    expect(busy).toMatchObject({ allow: false, reason: 'state-not-expected' })
    if (!busy.allow) expect(busy.detail).toContain('两个执行者')

    const never = wake(row({ state: 'idle' }))
    expect(never).toMatchObject({ allow: false, reason: 'state-not-expected' })
    if (!never.allow) expect(never.detail).toContain('awaiting')

    for (const state of ['stopped', 'done', 'failed'] as const) {
      const decision = wake(row({ state }))
      expect(decision).toMatchObject({ allow: false, reason: 'state-not-expected' })
      // 终态的处置与「等会儿再说」不同：要续跑必须新建 Thread。
      if (!decision.allow) expect(decision.detail).toContain('新建 Thread')
    }
  })

  it('挂起只接受 running：没跑过就等 = 等一个从未 arm 的唤醒', () => {
    // 挂起若沿用「必须是 awaiting」的判据，这条路径会**永远被拒** —— 一个静默失效的
    // 挂起入口比一个报错的更贵。所以判据按动作取源状态。
    const idle = suspend(row({ state: 'idle' }))
    expect(idle).toMatchObject({ allow: false, reason: 'state-not-expected' })
    if (!idle.allow) expect(idle.detail).toContain('从未被 arm')

    const already = suspend(row({ state: 'awaiting' }))
    expect(already).toMatchObject({ allow: false, reason: 'state-not-expected' })
    if (!already.allow) expect(already.detail).toContain('已经在等')

    for (const state of ['stopped', 'done', 'failed'] as const) {
      expect(suspend(row({ state }))).toMatchObject({ allow: false, reason: 'state-not-expected' })
    }
  })

  it('轮次引用的任务不是本行的 → round-task-mismatch（归因会记错账）', () => {
    expect(wake(row(), NODE, { task_id: 'task-9', attempt: 2 }))
      .toMatchObject({ allow: false, reason: 'round-task-mismatch' })
  })

  it('轮次形状不合法（0 / 负 / 小数 / NaN）→ round-invalid', () => {
    for (const attempt of [0, -1, 1.5, Number.NaN]) {
      expect(wake(row(), NODE, { task_id: 'task-7', attempt }))
        .toMatchObject({ allow: false, reason: 'round-invalid' })
    }
  })

  it('理由只有闭集里的五种，可被调用方直接聚合', () => {
    const reasons = new Set<WakeRefusal>([
      refusal(wake(row(), '')),
      refusal(wake(row({ node_id: 'other' }))),
      refusal(wake(row({ state: 'running' }))),
      refusal(wake(row(), NODE, { task_id: 'x', attempt: 1 })),
      refusal(wake(row(), NODE, { task_id: 'task-7', attempt: 0 })),
    ])
    expect(reasons).toEqual(new Set<WakeRefusal>([
      'local-node-unknown', 'node-mismatch', 'state-not-expected', 'round-task-mismatch', 'round-invalid',
    ]))
    // 允许时不带理由：调用方只消费输出，不必先判 allow 再取 reason 的两种形状。
    expect(wake(row())).toEqual({ allow: true })
    expect(suspend(row({ state: 'running' }))).toEqual({ allow: true })
  })
})

describe('唤醒有效期：不存在「无限等」这个返回', () => {
  it('缺省与非法值一律取默认（有限值），超过上限收敛到上限', () => {
    expect(resolveWakeTtlMs(undefined)).toBe(DEFAULT_WAKE_TTL_MS)
    expect(resolveWakeTtlMs(0)).toBe(DEFAULT_WAKE_TTL_MS)
    expect(resolveWakeTtlMs(-1)).toBe(DEFAULT_WAKE_TTL_MS)
    expect(resolveWakeTtlMs(Number.NaN)).toBe(DEFAULT_WAKE_TTL_MS)
    expect(resolveWakeTtlMs(Number.POSITIVE_INFINITY)).toBe(DEFAULT_WAKE_TTL_MS)
    expect(resolveWakeTtlMs(1)).toBe(1)
    expect(resolveWakeTtlMs(MAX_WAKE_TTL_MS)).toBe(MAX_WAKE_TTL_MS)
    expect(resolveWakeTtlMs(MAX_WAKE_TTL_MS * 10)).toBe(MAX_WAKE_TTL_MS)
    expect(resolveWakeTtlMs(1234.9)).toBe(1234)
  })

  it('默认值必须在 (0, MAX] 里 —— 默认值本身就是约束', () => {
    expect(DEFAULT_WAKE_TTL_MS).toBeGreaterThan(0)
    expect(DEFAULT_WAKE_TTL_MS).toBeLessThanOrEqual(MAX_WAKE_TTL_MS)
  })
})

describe('唤醒通道 id', () => {
  it('带代数：新一轮拿新通道，旧一轮的迟到兑现满足不了它', () => {
    expect(threadWakeChannel('t-1', { task_id: 'task-7', attempt: 1 })).toBe('thread/t-1/wake/1')
    expect(threadWakeChannel('t-1', { task_id: 'task-7', attempt: 2 })).toBe('thread/t-1/wake/2')
    expect(threadWakeChannel('t-1', ROUND)).not.toBe(threadWakeChannel('t-1', { task_id: 'task-7', attempt: 3 }))
  })

  it('id 或代数不合法即抛：含分隔符的 id 会让两条线程共用一个通道', () => {
    expect(() => threadWakeChannel('t/1', ROUND)).toThrow(ThreadRowError)
    expect(() => threadWakeChannel('t-1', { task_id: 'task-7', attempt: 0 })).toThrow(/代数/)
  })
})

describe('唤醒载荷：只带归因键，不带现场事实（§24.3.2 的落点）', () => {
  it('载荷里没有 workspace / node_id / session_ref', () => {
    // 载荷会进 session 事件（模型可见层），而承载节点与工作目录是节点局部事实 ——
    // 它们进了模型可见层，就等于把只在某个节点成立的路径写进了所有节点都读的日志。
    const payload = wakePayload('t-1', ROUND)
    expect(Object.keys(payload).sort()).toEqual(['round', 'thread_id'])
    const serialized = JSON.stringify(payload)
    for (const leaked of ['workspace', 'node_id', 'session_ref', 'thread/t-1']) {
      expect(serialized).not.toContain(leaked)
    }
    expect(payload.round).toEqual({ task_id: 'task-7', attempt: 2 })
  })
})

describe('工作目录解析（只解析与校验，不物化）', () => {
  it('把相对 workspace 解析到本节点的根下', () => {
    expect(resolveThreadWorkspacePath('/srv/lumo/ws', 'thread/t-1/')).toBe('/srv/lumo/ws/thread/t-1')
    expect(resolveThreadWorkspacePath('/srv/lumo/ws/', 'thread/t-1/')).toBe('/srv/lumo/ws/thread/t-1')
  })

  it('相对的根被拒：它会随进程 cwd 变化，同一个线程落到两个目录里', () => {
    for (const root of ['', '  ', 'ws', './ws']) {
      expect(() => resolveThreadWorkspacePath(root, 'thread/t-1/')).toThrow(ThreadWorkspaceError)
    }
  })

  it('绝对路径的 workspace 被拒：resolve 会整个丢掉根', () => {
    expect(() => resolveThreadWorkspacePath('/srv/lumo/ws', '/etc/passwd')).toThrow(/丢掉/)
    expect(() => resolveThreadWorkspacePath('/srv/lumo/ws', '/srv/other')).toThrow(ThreadWorkspaceError)
  })

  it('越界的 workspace 被拒（最后一道：解析后必须仍在根下）', () => {
    for (const workspace of ['../etc', 'thread/../../etc', 'thread/t-1/../../../root']) {
      expect(() => resolveThreadWorkspacePath('/srv/lumo/ws', workspace)).toThrow(/越出/)
    }
    expect(() => resolveThreadWorkspacePath('/srv/lumo/ws', 'thread/t-1/\0x')).toThrow(/非法字符/)
    expect(() => resolveThreadWorkspacePath('/srv/lumo/ws', 'thread\\t-1\\')).toThrow(/非法字符/)
  })
})

describe('节点失联通知与重派计划（§24.2.3(4)）', () => {
  const NOTICE = {
    seq: 7,
    realm: 'realm-1',
    thread_id: 't-1',
    node_id: 'node-a',
    session_ref: 'sess-1',
    coordinator_session_ref: 'coord-1',
    reason: '承载节点 node-a 丢失',
    created_at: '2026-09-20T10:00:00Z',
  }

  it('通知必须过闸：脏通知进了唤醒路径，症状是「永远不醒」或「唤醒错的线程」', () => {
    expect(parseNodeLossNotice(NOTICE).thread_id).toBe('t-1')
    // 串号的线程 id：唤醒会挂到别人身上。
    expect(() => parseNodeLossNotice(NOTICE, 't-2')).toThrow(/请求的是 t-2/)
    // 线程 id 要当唤醒通道段：含分隔符会让两个线程派生出同一个通道。
    expect(() => parseNodeLossNotice({ ...NOTICE, thread_id: 't/1' })).toThrow(/不能用作唤醒通道/)
    // seq 是消费游标：NaN 会让轮询永远从头开始（重复投递）或永远停住（读不到新通知）。
    for (const seq of [0, -1, 1.5, '7', null]) {
      expect(() => parseNodeLossNotice({ ...NOTICE, seq })).toThrow(/seq 必须是/)
    }
    // 投不出去的通知（缺协调者 ref）在日志里看起来完全正常 —— 必须响亮。
    const { coordinator_session_ref: _dropped, ...withoutCoordinator } = NOTICE
    expect(() => parseNodeLossNotice(withoutCoordinator)).toThrow(/coordinator_session_ref/)
    expect(() => parseNodeLossNotice({ ...NOTICE, created_at: '不是时间' })).toThrow(/可解析的时间/)
    expect(() => parseNodeLossNotice(null)).toThrow(ThreadRowError)
  })

  it('载荷带事实、不带现场：node_id 可以带（全集群共用），工作目录绝不带', () => {
    const payload = nodeLossPayload('t-1', { task_id: 'task-7', attempt: 2 }, NOTICE)
    expect(payload).toEqual({
      kind: 'node-lost',
      thread_id: 't-1',
      node_id: 'node-a',
      reassign_run: true,
      reason: '承载节点 node-a 丢失',
      round: { task_id: 'task-7', attempt: 2 },
    })
    expect(JSON.stringify(payload)).not.toContain('thread/t-1')
    // 投到错的线程上 = 唤醒一条不该醒的线程。
    expect(() => nodeLossPayload('t-2', { task_id: 'task-7', attempt: 2 }, NOTICE)).toThrow(/唤醒错的线程/)
  })

  it('重派 id 由（旧 id, 新代数）派生：重复的重派会算出同一个 id，因而看得见', () => {
    expect(replacementThreadId('t-1', 2)).toBe('t-1-r2')
    expect(replacementThreadId('t-1', 2)).toBe(replacementThreadId('t-1', 2))
    expect(() => replacementThreadId('t/1', 1)).toThrow(ThreadRowError)
    expect(() => replacementThreadId('t-1', 0)).toThrow(/>= 1/)
    expect(() => replacementThreadId('a'.repeat(128), 9)).toThrow(/不合法/)
  })

  it('新一轮 = 上一轮 + 1（(task_id, attempt) 是 Run 的唯一键）', () => {
    expect(nextRoundAfterLoss({ task_id: 'task-7', attempt: 1 })).toEqual({ task_id: 'task-7', attempt: 2 })
    expect(() => nextRoundAfterLoss({ task_id: 'task-7', attempt: 0 })).toThrow(ThreadRowError)
    expect(() => nextRoundAfterLoss({ task_id: 'task-7', attempt: Number.MAX_SAFE_INTEGER })).toThrow(/上限/)
  })

  /** 重派的判据取拒绝理由；本该被拒却放行时直接失败。 */
  function refusalOf(decision: ReturnType<typeof planThreadReplacement>): string {
    if (decision.allow) throw new Error('期望被拒绝，却放行了')
    return decision.reason
  }

  function plan(overrides: Partial<Parameters<typeof planThreadReplacement>[0]> = {}) {
    return planThreadReplacement({
      thread: row({ state: 'failed' }),
      previousRound: { task_id: 'task-7', attempt: 1 },
      newNodeId: 'node-b',
      newSessionRef: 'sess-2',
      ...overrides,
    })
  }

  it('只有 failed 才能重派：running 会造出两个执行者，stopped/done 的现场还在', () => {
    for (const state of ['running', 'idle', 'awaiting', 'stopped', 'done'] as const) {
      const decision = plan({ thread: row({ state }) })
      expect(refusalOf(decision)).toBe('thread-not-failed')
      if (!decision.allow) expect(decision.detail).toContain(state)
    }
  })

  it('放回刚丢的节点是静默失败：注册表会看到一行正常记录，而它永远不会被推进', () => {
    const decision = plan({ newNodeId: 'node-a' })
    expect(refusalOf(decision)).toBe('node-reused')
    if (!decision.allow) expect(decision.detail).toContain('静默失败')
    expect(refusalOf(plan({ newNodeId: '  ' }))).toBe('node-reused')
  })

  it('复用旧会话被拒：旧现场在死节点上，唯一索引也会挡下它', () => {
    const decision = plan({ newSessionRef: 'sess-1' })
    expect(refusalOf(decision)).toBe('session-reused')
    expect(refusalOf(plan({ newSessionRef: '' }))).toBe('session-reused')
  })

  it('在原 id 上重开被拒（承载节点亲和不迁移）', () => {
    expect(refusalOf(plan({ newThreadId: 't-1' }))).toBe('thread-id-reused')
    expect(refusalOf(plan({ newThreadId: 'bad/id' }))).toBe('round-invalid')
    expect(refusalOf(plan({ previousRound: { task_id: 'task-7', attempt: 0 } }))).toBe('round-invalid')
  })

  it('通过时给出完整的计划：新线程 idle + 新会话 + 新节点 + 新工作目录 + 代数 +1', () => {
    const decision = plan()
    if (!decision.allow) throw new Error(`期望放行，却被拒：${decision.reason}（${decision.detail}）`)
    expect(decision.plan.round).toEqual({ task_id: 'task-7', attempt: 2 })
    expect(decision.plan.thread).toEqual({
      id: 't-1-r2',
      realm: 'realm-1',
      project_id: 'proj-1',
      task_id: 'task-7',
      coordinator_session_ref: 'coord-1',
      session_ref: 'sess-2',
      node_id: 'node-b',
      workspace: 'thread/t-1-r2/',
      state: 'idle',
    })
  })
})

/**
 * 生效面（§8.1 的第一个可用切面）：控制面确立的状态**真的**作用到 agent 上。
 *
 * 接线之前状态只作用在一处——`tools/pre-execute` 的工具闸门。于是 `pause` 的实际效果是
 * 「拒掉副作用工具」，而 turn 照跑：agent 继续调模型、继续读文件、继续说话。「挂起」名不
 * 副实——这就是 §8.1 continuation + `agent.inject()` 那条缺口**在操作者眼里**的样子。
 *
 * 这些用例钉四件事：
 *
 *   1. **判据表**：一个状态 → 工具闸门 + turn 级动作，两个投影同源。不同源的症状是
 *      「按了暂停，工具被拒了但 agent 还在说话」。
 *   2. **词表外的方向**：fail-closed（工具全拒 + 停转），且**不**取消——取消不可逆，
 *      而「不认识的值」不构成执行不可逆动作的理由。
 *   3. **拒这一步之前把消息放回去**：上游 `preStep()` 先 `inbox.claim()` 再走钩子，而
 *      claim 是**消费**。直接 reject 会把用户刚发的消息吞掉——那不是暂停，是丢数据。
 *   4. **主动轮询的重复抑制**：1s 一轮，`cancel` 与「唤醒」各自只能发生一次。
 *
 * # 为什么用假 agent 而不是真 dsh
 *
 * 本层自己的判据与顺序是这里唯一有风险的部分；「dsh 会不会按契约把钩子发出来」由 dsh
 * 自己的用例保证（`agent-loop/tests/interception.spec.ts` 等），本仓库的插件测试一向不
 * 重测它。假 agent 的 `prepend` **照抄真 inbox 对重复 id 抛错**的行为（`inbox.ts` 的
 * `inboxProjectionSchema.apply`），免得假对象比真的宽松、把真机上会炸的路径测成绿的。
 *
 * # 数据库那一侧
 *
 * 「库里的状态值 → 判据」这一段在 `control-schema-contract.spec.ts` 里用真 PG 覆盖了。
 * 两个投影出自同一张表项，所以不在这里再证一遍。
 */
import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-session'

import { controlActuation, controlGate } from '../src/gate.ts'
import {
  CONTROL_PLUGIN_ID,
  actuationStep,
  cancelSession,
  claimedTarget,
  hasPendingWork,
  preStepDecision,
  restoreClaimed,
  wakeSession,
  type ControllableAgent,
} from '../src/actuation.ts'

const SESSION = 'sess-1'

/** 造一条真实形状的用户消息（id 由 `createUserMessage` 生成，所以只能从返回值里读）。 */
function message(text: string): UserMessage {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'test' },
  })
}

interface FakeCalls {
  prepend: { target: 'next-turn' | 'next-step'; id: string }[]
  cancel: { kind: string; reason?: string }[]
  steer: UserMessage[]
}

/** 假 agent：记下被调了什么，并按真 inbox 的规矩拒绝重复 id。 */
function fakeAgent(init: {
  status?: 'idle' | 'running'
  nextTurn?: UserMessage[]
  nextStep?: UserMessage[]
} = {}): {
  agent: ControllableAgent
  calls: FakeCalls
  inbox: { nextTurn: UserMessage[]; nextStep: UserMessage[] }
} {
  const inbox = { nextTurn: [...(init.nextTurn ?? [])], nextStep: [...(init.nextStep ?? [])] }
  const calls: FakeCalls = { prepend: [], cancel: [], steer: [] }
  const agent: ControllableAgent = {
    id: SESSION,
    status: init.status ?? 'idle',
    session: { id: SESSION },
    inbox: {
      get nextTurn() { return inbox.nextTurn },
      get nextStep() { return inbox.nextStep },
      prepend(target, pending) {
        calls.prepend.push({ target, id: String(pending.id) })
        // 真 inbox 对「同一 id 同时 pending」是抛错的（会毒掉整份会话日志）。照做。
        if ([...inbox.nextTurn, ...inbox.nextStep].some((m) => m.id === pending.id)) {
          throw new Error(`message "${String(pending.id)}" is already pending`)
        }
        if (target === 'next-turn') inbox.nextTurn.unshift(pending)
        else inbox.nextStep.unshift(pending)
      },
    },
    cancel(cause) { calls.cancel.push(cause) },
    steer(pending) { calls.steer.push(pending) },
  }
  return { agent, calls, inbox }
}

const idsOf = (messages: readonly UserMessage[]): string[] => messages.map((m) => String(m.id))

describe('判据表：一个状态，两个投影', () => {
  it('五态各自的工具闸门与 turn 级动作', () => {
    expect([controlGate('running'), controlActuation('running')]).toEqual(['allow', 'run'])
    expect([controlGate('paused'), controlActuation('paused')]).toEqual(['read-only', 'suspend'])
    expect([controlGate('awaiting-approval'), controlActuation('awaiting-approval')])
      .toEqual(['read-only', 'suspend'])
    expect([controlGate('stopped'), controlActuation('stopped')]).toEqual(['read-only', 'suspend'])
    expect([controlGate('aborted'), controlActuation('aborted')]).toEqual(['deny', 'cancel'])
  })

  it('暂停类的三个状态一律「停转」，不区分它们是否可逆', () => {
    // 「哪个状态能被 resume」是 Go 状态机（internal/state 的显式矩阵）的知识。
    // 在这里复制一份判断，等于给同一个问题留第二份实现。
    for (const state of ['paused', 'awaiting-approval', 'stopped']) {
      expect(controlActuation(state), `状态 ${state}`).toBe('suspend')
    }
  })

  it('词表外的值一律 fail-closed，且**不**取消', () => {
    // 这条曾经真的会漏：用对象字面量查表时 `table['constructor']` 会取到原型上的成员，
    // 于是「命中」了一条 gate === undefined 的记录，挂点里 `gate === 'deny'` 判否之后
    // 落到「只读放行」那条分支 —— 未知值从 fail-closed 变成 fail-open。
    const adversarial = [
      '', 'unknown', 'RUNNING', 'Paused', ' paused', 'paused ', 'stopping',
      'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf',
    ]
    for (const state of adversarial) {
      expect(controlGate(state), `状态 ${JSON.stringify(state)} 必须全拒`).toBe('deny')
      expect(controlActuation(state), `状态 ${JSON.stringify(state)} 必须停转`).toBe('suspend')
    }
  })

  it('反向：词表外绝不能是 run / cancel / allow', () => {
    // 方向说反了比「没有这条规则」更危险：它看起来有判据。
    for (const state of ['', 'unknown', 'constructor', '__proto__']) {
      expect(controlActuation(state)).not.toBe('run')
      expect(controlActuation(state)).not.toBe('cancel')
      expect(controlGate(state)).not.toBe('allow')
    }
  })
})

describe('claimedTarget：被 claim 的那批原来在哪', () => {
  it('step=1 来自 next-turn，之后来自 next-step', () => {
    // 上游 turn() 里 target 初值 'next-turn'、第一次迭代后才变 'next-step'，
    // 而 step 取自 phase.step + 1、每个 turn 归零。这是推断，所以钉在这里。
    expect(claimedTarget(1)).toBe('next-turn')
    expect(claimedTarget(2)).toBe('next-step')
    expect(claimedTarget(7)).toBe('next-step')
  })

  it('step 为 0 或负数时按 next-turn 处理（宁可晚一轮，不要丢）', () => {
    expect(claimedTarget(0)).toBe('next-turn')
    expect(claimedTarget(-1)).toBe('next-turn')
  })
})

describe('停转：拒这一步之前把消息放回去', () => {
  it('paused 时拒绝，并把 claim 掉的消息按原顺序放回 next-turn', () => {
    const claimed = [message('a'), message('b'), message('c')]
    const { agent, calls, inbox } = fakeAgent()

    const decision = preStepDecision('paused', agent, claimed, 1)

    expect(decision).toEqual({ kind: 'reject', restored: 3 })
    expect(idsOf(inbox.nextTurn)).toEqual(idsOf(claimed))
    expect(calls.prepend.every((p) => p.target === 'next-turn')).toBe(true)
  })

  it('放回**不唤醒**：开不开下一个 turn 由状态恢复决定，不由放回决定', () => {
    const { agent, calls } = fakeAgent()
    preStepDecision('paused', agent, [message('a')], 1)
    expect(calls.steer).toEqual([])
    expect(calls.cancel).toEqual([])
  })

  it('step>1 时放回 next-step（那是 steering 排的队）', () => {
    const claimed = [message('a'), message('b')]
    const { agent, inbox } = fakeAgent()
    preStepDecision('stopped', agent, claimed, 3)
    expect(idsOf(inbox.nextStep)).toEqual(idsOf(claimed))
    expect(inbox.nextTurn).toEqual([])
  })

  it('已在 pending 里的 id 不再放回一次', () => {
    // 真 inbox 会为此抛错并毒掉会话日志，所以这条不只是「重复」问题。
    //
    // 这里防的是「这条消息已经在**另一个**列表里」：claim 从哪个列表取走，它就不可能还在
    // 同一个列表里，所以重复只可能来自别的钩子已经放回过一次。
    const claimed = [message('a'), message('b'), message('c')]
    const { agent, inbox } = fakeAgent({ nextStep: [claimed[1]!] })

    const decision = preStepDecision('awaiting-approval', agent, claimed, 1)

    expect(decision).toEqual({ kind: 'reject', restored: 2 })
    expect(idsOf(inbox.nextTurn)).toEqual([String(claimed[0]!.id), String(claimed[2]!.id)])
    expect(idsOf(inbox.nextStep)).toEqual([String(claimed[1]!.id)])
  })

  it('running 时放行，一条消息都不碰', () => {
    const { agent, calls } = fakeAgent()
    expect(preStepDecision('running', agent, [message('a')], 1)).toEqual({ kind: 'pass' })
    expect(calls.prepend).toEqual([])
  })

  it('aborted 时**不**在这里拒（硬取消归轮询），但也不放行', () => {
    // aborted 的 actuation 是 cancel，不是 suspend。挂点这一层放行它，是为了不把
    // 「取消」伪装成「停转」——两件事的处置不同（一个不可逆、一个可继续）。
    const { agent, calls } = fakeAgent()
    expect(preStepDecision('aborted', agent, [message('a')], 1)).toEqual({ kind: 'pass' })
    expect(calls.prepend).toEqual([])
  })
})

describe('硬取消', () => {
  it('cause 用 hook 档并带上状态：审计要能回答「是谁停的」', () => {
    const { agent, calls } = fakeAgent()
    cancelSession(agent, 'aborted')
    expect(calls.cancel).toHaveLength(1)
    expect(calls.cancel[0]!.kind).toBe('hook')
    expect(calls.cancel[0]!.reason).toContain('aborted')
    expect(calls.cancel[0]!.reason).toContain(CONTROL_PLUGIN_ID)
  })
})

describe('唤醒', () => {
  it('注入一条续跑注记并 steer（不是 inject —— inject 不唤醒）', () => {
    const { agent, calls } = fakeAgent()
    wakeSession(agent, 'running')

    expect(calls.steer).toHaveLength(1)
    const note = calls.steer[0]!
    expect(note.source).toEqual({ kind: 'plugin', plugin: CONTROL_PLUGIN_ID })
    expect(JSON.stringify(note.content)).toContain(SESSION)
    expect(JSON.stringify(note.content)).toContain('running')
  })

  it('注记的 id 与 pending 里的都不同（真 inbox 拒重复 id）', () => {
    const pending = message('waiting')
    const { agent, calls } = fakeAgent({ nextTurn: [pending] })
    wakeSession(agent, 'running')
    expect(String(calls.steer[0]!.id)).not.toBe(String(pending.id))
  })

  it('只有「确实有人等着」才算有活可干', () => {
    expect(hasPendingWork(fakeAgent().agent)).toBe(false)
    expect(hasPendingWork(fakeAgent({ nextTurn: [message('a')] }).agent)).toBe(true)
    expect(hasPendingWork(fakeAgent({ nextStep: [message('a')] }).agent)).toBe(true)
  })
})

describe('主动轮询的动作判据（重复抑制）', () => {
  it('cancel：同一状态只发一次，状态变过再变回来才算新的一次', () => {
    expect(actuationStep(undefined, 'cancel', false)).toBe('cancel')
    expect(actuationStep('cancel', 'cancel', false)).toBe('none')
    expect(actuationStep('run', 'cancel', false)).toBe('cancel')
    expect(actuationStep('suspend', 'cancel', false)).toBe('cancel')
  })

  it('suspend：挂起由步边界完成，轮询什么都不做', () => {
    expect(actuationStep(undefined, 'suspend', false)).toBe('none')
    expect(actuationStep('run', 'suspend', true)).toBe('none')
    expect(actuationStep('cancel', 'suspend', true)).toBe('none')
  })

  it('run：只有「上一轮挂着」且「有输入等着」才唤醒', () => {
    expect(actuationStep('suspend', 'run', true)).toBe('wake')
    // 恢复但队列为空 → 不主动开 turn：一次只有注记的 turn 是纯开销。
    expect(actuationStep('suspend', 'run', false)).toBe('none')
    expect(actuationStep('run', 'run', true)).toBe('none')
    expect(actuationStep(undefined, 'run', true)).toBe('none')
  })

  it('cancel 之后回到 running 不唤醒：新输入自己会唤醒 driver（正常路径）', () => {
    // suspend 特殊在「我们把输入放回了队列且不唤醒」——必须有人补那一脚。
    // cancel 没有这个问题：被硬取消之后，能继续的路径本来就是新输入。
    expect(actuationStep('cancel', 'run', true)).toBe('none')
  })
})

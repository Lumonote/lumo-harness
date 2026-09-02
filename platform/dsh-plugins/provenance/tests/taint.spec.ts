import { describe, expect, it } from 'vitest'
import { adjudicateCall, type SessionEventLike } from '../../../shared/seam-contracts/provenance.ts'
import { ProvenanceClassifier } from '../src/classify.ts'
import { computeTaint, currentTurn } from '../src/taint.ts'

const classifier = new ProvenanceClassifier()

/** 构造事件的小工具，让日志字面量读起来像时间线 */
const turnStart = (turn: number): SessionEventLike => ({ type: 'turn/start', data: { turn } })
const turnEnd = (turn: number): SessionEventLike =>
  ({ type: 'turn/end', data: { turn, reason: 'done' } })
const call = (turn: number, name: string): SessionEventLike =>
  ({ type: 'tool/call', data: { turn, step: 1, callId: `c${turn}-${name}`, name, arguments: '{}' } })
const inject = (): SessionEventLike =>
  ({ type: 'user/message', data: { source: 'inject', content: '文件已变更' } })

describe('currentTurn —— 用 dsh 原生 turn 标记', () => {
  it('无 turn/start 时为 0', () => {
    expect(currentTurn([])).toBe(0)
  })

  it('取最后一个 turn/start 的 turn 号', () => {
    expect(currentTurn([turnStart(1), turnEnd(1), turnStart(2)])).toBe(2)
  })

  it('agent.inject() 的合成 user/message 不影响 turn 号', () => {
    // 这正是 recovery 的 countTurns 会算错的场景（见计划前置认定 ②）
    expect(currentTurn([turnStart(1), inject(), inject()])).toBe(1)
  })
})

describe('computeTaint —— 污点是日志的纯函数', () => {
  it('工作区读取置 external 污点，不能把被投毒仓库当平台受控数据', () => {
    const taint = computeTaint([turnStart(1), call(1, 'grep')], classifier)
    expect(taint).toEqual({ turn: 1, level: 'external', sources: ['grep'] })
    expect(adjudicateCall(taint, 'write-external', false).action).toBe('require-confirmation')
  })

  it('场景 2：knowledge_query 置污点，并记下来源', () => {
    const taint = computeTaint([turnStart(1), call(1, 'knowledge_query')], classifier)
    expect(taint.level).toBe('external')
    expect(taint.sources).toEqual(['knowledge_query'])
  })

  it('场景 3：封闭是 turn 级——下一 turn 重新干净', () => {
    const events = [
      turnStart(1), call(1, 'knowledge_query'), turnEnd(1),
      turnStart(2),
    ]
    const taint = computeTaint(events, classifier)
    expect(taint.turn).toBe(2)
    expect(taint.level).toBe('user')
    expect(taint.sources).toEqual([])
  })

  it('场景 8：污点单调——external 之后的工作区调用不降级', () => {
    const events = [turnStart(1), call(1, 'knowledge_query'), call(1, 'grep')]
    expect(computeTaint(events, classifier).level).toBe('external')
  })

  it('来源去重且保序', () => {
    const events = [
      turnStart(1),
      call(1, 'knowledge_query'), call(1, 'web_fetch'), call(1, 'knowledge_query'),
    ]
    expect(computeTaint(events, classifier).sources).toEqual(['knowledge_query', 'web_fetch'])
  })

  it('不问结果成败：tool/result 缺失或报错仍然算污点', () => {
    // tool/result 载荷不含工具名，故只看 tool/call；且失败调用的错误文案
    // 同样会进模型上下文，同样可载注入（见计划前置认定 ③）
    const events = [
      turnStart(1),
      call(1, 'knowledge_query'),
      { type: 'tool/result', data: { turn: 1, step: 1, error: { name: 'E', code: 'x' } } },
    ]
    expect(computeTaint(events, classifier).level).toBe('external')
  })

  it('上一 turn 的外部调用不污染本 turn', () => {
    const events = [
      turnStart(1), call(1, 'knowledge_query'), turnEnd(1),
      turnStart(2),
    ]
    expect(computeTaint(events, classifier).level).toBe('user')
  })
})

describe('场景 4/5：resume 等价性——污点不会被跨节点恢复洗白', () => {
  it('只喂日志重算，结果与在线判决逐字相同', () => {
    const events = [turnStart(1), call(1, 'knowledge_query'), call(1, 'edit')]

    // 「在线」节点：完整日志在手
    const online = computeTaint(events, classifier)

    // 「新」节点：进程内存全空，只有 seed 重放出来的同一份日志。
    // 若污点存在进程内存里，这里会得出 clean —— 攻击者只需逼一次节点迁移
    // 即可解除能力封闭（规格 §2）。
    const resumed = computeTaint(structuredClone(events), new ProvenanceClassifier())

    expect(resumed).toEqual(online)
    expect(resumed.level).toBe('external')
  })
})

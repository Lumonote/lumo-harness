import { describe, expect, it } from 'vitest'
import {
  assertChildResultBody,
  assertStartChildRequest,
  childDepthOf,
  isResultStopReason,
  runKeyOf,
  type ChildParentDescriptor,
  type StartChildFail,
  type StartChildOk,
  type StartChildResponse,
} from '../subagent-host.ts'

const validParent: ChildParentDescriptor = {
  sessionId: 'sess-a',
  cwd: '/home/wudl/proj',
  delegationDepth: 1,
  provider: 'deepseek',
  model: 'deepseek-chat',
  maxTokens: 8192,
  sandboxMode: 'readonly',
  approvalPolicy: 'never',
}

function validRequest(): Record<string, unknown> {
  return {
    childId: 'child-1',
    realm: 'dev',
    label: '写 Q3 报告',
    prompt: [{ type: 'text', text: '写一份 Q3 报告' }],
    descriptor: { kind: 'public', description: '写作子代理' },
    parent: { ...validParent },
    callbackUrl: 'http://agent-1:3080/subagent/result',
  }
}

function childResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    runId: 'run-1',
    ok: true,
    output: [{ type: 'text', text: 'child 答复' }],
    stopReason: 'completed',
    ...overrides,
  }
}

describe('assertStartChildRequest —— 承载侧始建请求的结构校验', () => {
  it('接受完整请求（含全部可选字段）', () => {
    expect(() => assertStartChildRequest(validRequest())).not.toThrow()
  })

  it('接受仅必填字段的最小请求（可选字段可缺省）', () => {
    const req = validRequest()
    delete req.label
    const parent = req.parent as Record<string, unknown>
    delete parent.cwd
    delete parent.provider
    delete parent.model
    delete parent.maxTokens
    delete parent.sandboxMode
    delete parent.approvalPolicy
    expect(() => assertStartChildRequest(req)).not.toThrow()
  })

  it('接受结构等价的额外字段（结构等价不锁最小形状）', () => {
    expect(() => assertStartChildRequest({ ...validRequest(), extra: 'x' })).not.toThrow()
  })

  it('拒绝非对象与空值入参', () => {
    for (const bad of [null, undefined, 'x', 1, [], true]) {
      expect(() => assertStartChildRequest(bad), `入参 ${JSON.stringify(bad)} 必须被拒`).toThrow(/subagent-host/)
    }
  })

  it('拒绝缺必填字段', () => {
    for (const key of ['childId', 'realm', 'prompt', 'descriptor', 'parent', 'callbackUrl']) {
      const req = validRequest()
      delete req[key]
      expect(() => assertStartChildRequest(req), `缺 ${key} 必须被拒`).toThrow(/subagent-host/)
    }
  })

  it('拒绝空字符串与坏类型（顶层字段）', () => {
    const cases: Array<[string, unknown]> = [
      ['childId', ''],
      ['realm', ''],
      ['callbackUrl', ''],
      ['childId', 1],
      ['realm', 1],
      ['label', 123],
      ['prompt', 'not-array'],
      ['prompt', {}],
    ]
    for (const [key, value] of cases) {
      const req = validRequest()
      req[key] = value
      expect(() => assertStartChildRequest(req), `${key}=${JSON.stringify(value)} 必须被拒`).toThrow(/subagent-host/)
    }
  })

  it('拒绝越狱段 realm（与 runKeyOf 同训：绝不让 runKeyOf 在 assert 之后才炸）', () => {
    for (const realm of ['a/b', 'a\\b', 'a::b', '.', '..']) {
      const req = validRequest()
      req.realm = realm
      expect(() => assertStartChildRequest(req), `realm=${JSON.stringify(realm)} 必须被拒`).toThrow(/realm/)
    }
  })

  it('拒绝含运行键分隔符的 childId（与 realm 同训：绝不让 runKeyOf 在 assert 之后才炸）', () => {
    for (const childId of ['a::b', 'b::c']) {
      const req = validRequest()
      req.childId = childId
      expect(() => assertStartChildRequest(req), `childId=${JSON.stringify(childId)} 必须被拒`).toThrow(/childId/)
    }
  })

  it('合法 childId（连字符/下划线/数字/点）与合法 realm 不被误拒（收紧面仅限分隔符）', () => {
    for (const childId of ['child-1', 'child_42', 'b.123.c']) {
      const req = validRequest()
      req.childId = childId
      expect(() => assertStartChildRequest(req), `childId=${JSON.stringify(childId)} 不应被拒`).not.toThrow()
    }
  })

  it('拒绝 parent 坏形状：非对象 / 缺 sessionId / 空 sessionId', () => {
    const notObject = validRequest()
    notObject.parent = 'nope'
    expect(() => assertStartChildRequest(notObject)).toThrow(/parent/)
    const noSession = validRequest()
    delete (noSession.parent as Record<string, unknown>).sessionId
    expect(() => assertStartChildRequest(noSession)).toThrow(/sessionId/)
    const emptySession = validRequest()
    ;(emptySession.parent as Record<string, unknown>).sessionId = ''
    expect(() => assertStartChildRequest(emptySession)).toThrow(/sessionId/)
  })

  it('拒绝 delegationDepth 负数/非整数/超安全整数/非数值', () => {
    const cases: Array<[string, number | string | null]> = [
      ['负数', -1],
      ['非整数', 1.5],
      ['超安全整数', 2 ** 53],
      ['非数值', '1'],
      ['null', null],
    ]
    for (const [label, d] of cases) {
      const req = validRequest()
      ;(req.parent as Record<string, unknown>).delegationDepth = d
      expect(() => assertStartChildRequest(req), `delegationDepth=${String(d)}（${label}）必须被拒`).toThrow(/delegationDepth/)
    }
  })

  it('拒绝 approvalPolicy 词表外取值（仅 never 或缺省）', () => {
    const req = validRequest()
    ;(req.parent as Record<string, unknown>).approvalPolicy = 'always'
    expect(() => assertStartChildRequest(req)).toThrow(/approvalPolicy/)
  })

  it('拒绝 parent 可选路由字段的类型错误', () => {
    for (const key of ['cwd', 'provider', 'model', 'sandboxMode']) {
      const req = validRequest()
      ;(req.parent as Record<string, unknown>)[key] = 123
      expect(() => assertStartChildRequest(req), `parent.${key}=123 必须被拒`).toThrow(new RegExp(key))
    }
    const req = validRequest()
    ;(req.parent as Record<string, unknown>).maxTokens = '8192'
    expect(() => assertStartChildRequest(req)).toThrow(/maxTokens/)
  })
})

describe('childDepthOf —— child 深度 = 父深度 + 1', () => {
  it('0 → 1、2 → 3（逐层递进）', () => {
    expect(childDepthOf({ sessionId: 's', delegationDepth: 0 })).toBe(1)
    expect(childDepthOf({ sessionId: 's', delegationDepth: 2 })).toBe(3)
  })

  it('负数/非整数/超安全整数/NaN/Infinity 抛 invalid', () => {
    const cases: Array<{ d: number; label: string }> = [
      { d: -1, label: '负数' },
      { d: 1.5, label: '非整数' },
      { d: 2 ** 53, label: '超安全整数' },
      { d: NaN, label: 'NaN' },
      { d: Infinity, label: 'Infinity' },
    ]
    for (const { d, label } of cases) {
      expect(() => childDepthOf({ sessionId: 's', delegationDepth: d }), `${label} 必须被拒`).toThrow(/delegationDepth/)
    }
  })
})

describe('runKeyOf —— 承载侧运行表键', () => {
  it('拼为 realm::childId；不同 realm 的相同 childId 键隔离', () => {
    expect(runKeyOf('dev', 'child-1')).toBe('dev::child-1')
    expect(runKeyOf('dev', 'child-1')).not.toBe(runKeyOf('prod', 'child-1'))
  })

  it('拒绝空 realm / 空 childId', () => {
    expect(() => runKeyOf('', 'c')).toThrow(/realm/)
    expect(() => runKeyOf('dev', '')).toThrow(/childId/)
  })

  it('拒绝含保留分隔符的分量（越狱身份重叠）', () => {
    expect(() => runKeyOf('a::b', 'c')).toThrow(/realm/)
    expect(() => runKeyOf('a', 'b::c')).toThrow(/childId/)
  })

  it('realm 与对象存储键同训：拒绝穿越段', () => {
    expect(() => runKeyOf('a/b', 'c')).toThrow(/realm/)
    expect(() => runKeyOf('.', 'c')).toThrow(/realm/)
  })
})

describe('assertChildResultBody —— 结果回执校验', () => {
  it('接受完整回执、缺省可选字段回执、ok:false 基础设施故障回执', () => {
    expect(() => assertChildResultBody(childResult())).not.toThrow()
    expect(() => assertChildResultBody(childResult({ output: undefined, structured: { a: 1 }, diagnostic: 'd' }))).not.toThrow()
    expect(() =>
      assertChildResultBody({ runId: 'r', ok: false, code: 'unavailable', message: '承载节点宕机' }),
    ).not.toThrow()
  })

  it('接受终端词表内全部 stopReason（闭集字面值）', () => {
    for (const s of ['completed', 'aborted', 'error', 'max-tokens', 'refusal']) {
      expect(() => assertChildResultBody(childResult({ stopReason: s })), `stopReason=${s} 必须在词表内`).not.toThrow()
    }
  })

  it('拒绝词表外 stopReason', () => {
    for (const s of ['stopped', 'paused', 'failed', 'completed!', '']) {
      expect(() => assertChildResultBody(childResult({ stopReason: s })), `stopReason=${JSON.stringify(s)} 必须被拒`).toThrow(/stopReason/)
    }
  })

  it('拒绝缺 runId / 缺 ok / ok 非布尔 / output 非数组 / 非对象', () => {
    expect(() => assertChildResultBody({ ok: true })).toThrow(/runId/)
    expect(() => assertChildResultBody({ runId: 'r' })).toThrow(/ok/)
    expect(() => assertChildResultBody({ runId: 'r', ok: 'true' })).toThrow(/ok/)
    expect(() => assertChildResultBody(childResult({ output: 'oops' }))).toThrow(/output/)
    expect(() => assertChildResultBody(null)).toThrow(/subagent-host/)
  })

  it('isResultStopReason 守卫与词表一致', () => {
    expect(isResultStopReason('completed')).toBe(true)
    expect(isResultStopReason('refusal')).toBe(true)
    expect(isResultStopReason('stopped')).toBe(false)
    expect(isResultStopReason('')).toBe(false)
  })
})

describe('StartChildResponse —— ok 判别两臂', () => {
  it('ok:true 臂携带 childId；ok:false 臂携带 code/message', () => {
    const ok: StartChildOk = { ok: true, childId: 'child-9' }
    const fail: StartChildFail = { ok: false, code: 'invalid', message: '坏形状' }
    const responses: StartChildResponse[] = [ok, fail]
    const first = responses[0]!
    const second = responses[1]!
    expect(first.ok).toBe(true)
    if (first.ok) {
      expect(first.childId).toBe('child-9')
    }
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.code).toBe('invalid')
      expect(second.message).toBe('坏形状')
    }
  })
})

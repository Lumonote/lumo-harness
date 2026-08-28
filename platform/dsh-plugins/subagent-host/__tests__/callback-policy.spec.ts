import { describe, expect, it } from 'vitest'

import { assertAllowedCallback, normalizeCallbackOrigins } from '../src/callback-policy.ts'

describe('subagent callback outbound policy', () => {
  const origins = normalizeCallbackOrigins(['http://parent.internal:8092'])

  it('accepts only the configured origin and contract path', () => {
    expect(() => assertAllowedCallback(
      'http://parent.internal:8092/subagent/result/child-1/0123456789abcdef',
      'child-1',
      origins,
    )).not.toThrow()
  })

  it('rejects SSRF origins and child/path substitution', () => {
    expect(() => assertAllowedCallback(
      'http://169.254.169.254/subagent/result/child-1/0123456789abcdef',
      'child-1',
      origins,
    )).toThrow('允许列表')
    expect(() => assertAllowedCallback(
      'http://parent.internal:8092/subagent/result/child-2/0123456789abcdef',
      'child-1',
      origins,
    )).toThrow('childId')
    expect(() => assertAllowedCallback('http://parent.internal:8092/admin', 'child-1', origins)).toThrow('回执路径')
  })

  it('rejects credentials, query parameters, and malformed origin configuration', () => {
    expect(() => assertAllowedCallback(
      'http://user:pass@parent.internal:8092/subagent/result/child-1/0123456789abcdef',
      'child-1',
      origins,
    )).toThrow()
    expect(() => assertAllowedCallback(
      'http://parent.internal:8092/subagent/result/child-1/0123456789abcdef?target=metadata',
      'child-1',
      origins,
    )).toThrow('查询参数')
    expect(() => normalizeCallbackOrigins([])).toThrow('不能为空')
    expect(() => normalizeCallbackOrigins(['http://parent.internal:8092/path'])).toThrow('origin')
  })
})

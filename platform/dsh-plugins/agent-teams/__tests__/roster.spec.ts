import { describe, expect, it, vi } from 'vitest'

import {
  dispatchMember,
  foldMemberOutput,
  foldMemberResult,
  MEMBER_PROVIDER_PREFERENCE,
  MemberProviderError,
  providerKind,
  selectMemberProvider,
  type MemberProviderChoice,
  type MemberRun,
  type MemberSeam,
} from '../src/roster.ts'

describe('provider 形态判定', () => {
  it('认得远程、进程内与外部三类', () => {
    expect(providerKind('lumo-remote')).toBe('remote')
    expect(providerKind('spawn')).toBe('in-process')
    expect(providerKind('fork')).toBe('in-process')
    expect(providerKind('acp')).toBe('external')
    expect(providerKind('codex')).toBe('external')
  })
})

describe('provider 探测', () => {
  it('集群父节点：lumo-remote 存在就选它，而不是退回进程内', () => {
    const choice = selectMemberProvider({ available: ['spawn', 'fork', 'lumo-remote'] })
    expect(choice.provider).toBe('lumo-remote')
    expect(choice.kind).toBe('remote')
  })

  it('单机：没有 lumo-remote 时回落进程内 spawn', () => {
    const choice = selectMemberProvider({ available: ['spawn', 'fork'] })
    expect(choice).toMatchObject({ provider: 'spawn', kind: 'in-process' })
  })

  it('只有 fork 时选 fork', () => {
    expect(selectMemberProvider({ available: ['fork'] }).provider).toBe('fork')
  })

  it('不认识的多余 provider 不影响探测', () => {
    expect(selectMemberProvider({ available: ['acp', 'spawn'] }).provider).toBe('spawn')
  })

  it('优先级顺序即集群优先，可被覆盖', () => {
    expect(MEMBER_PROVIDER_PREFERENCE[0]).toBe('lumo-remote')
    expect(selectMemberProvider({
      available: ['spawn', 'lumo-remote'],
      preference: ['spawn'],
    }).provider).toBe('spawn')
  })

  it('显式配置生效', () => {
    const choice = selectMemberProvider({ available: ['spawn', 'lumo-remote'], configured: 'spawn' })
    expect(choice).toMatchObject({ provider: 'spawn', reason: '显式配置' })
  })

  it('显式配置不可用时 fail-loud，不静默回落', () => {
    expect(() => selectMemberProvider({ available: ['spawn'], configured: 'lumo-remote' }))
      .toThrow(MemberProviderError)
    try {
      selectMemberProvider({ available: ['spawn'], configured: 'lumo-remote' })
    } catch (error) {
      expect((error as MemberProviderError).available).toEqual(['spawn'])
      expect((error as MemberProviderError).message).toContain('lumo-remote')
    }
  })

  it('一个 provider 都没有时给出可诊断的报错', () => {
    expect(() => selectMemberProvider({ available: [] })).toThrow(/没有任何成员 provider 可用/)
  })

  it('空字符串配置视为未配置', () => {
    expect(selectMemberProvider({ available: ['spawn'], configured: '' }).provider).toBe('spawn')
  })
})

describe('结果折叠', () => {
  it('抽取 text 块、非文本块用类型名占位', () => {
    expect(foldMemberOutput([
      { type: 'text', text: '第一段' },
      { type: 'image', source: 'x' },
      { type: 'text', text: '第二段' },
    ])).toBe('第一段\n[image]\n第二段')
  })

  it('裸字符串与其它 JSON 也能折叠', () => {
    expect(foldMemberOutput(['a', 42, { k: 1 }])).toBe('a\n42\n{"k":1}')
  })

  it('只有 stopReason=completed 才算成功', () => {
    expect(foldMemberResult({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }))
      .toMatchObject({ ok: true, text: 'done' })
    expect(foldMemberResult({ output: [], stopReason: 'max-tokens', diagnostic: '超长' }))
      .toMatchObject({ ok: false, diagnostic: '超长', stopReason: 'max-tokens' })
    expect(foldMemberResult({ output: [], stopReason: 'error' }).ok).toBe(false)
  })
})

describe('派发包装', () => {
  const choice: MemberProviderChoice = { provider: 'spawn', kind: 'in-process', reason: 'test' }

  function seamReturning(run: MemberRun): MemberSeam {
    return { list: () => ['spawn'], start: vi.fn(async () => run) }
  }

  const REQUEST = { label: 't1', prompt: [], parent: {}, signal: new AbortController().signal }

  it('成功路径折叠结局并释放 run', async () => {
    const dispose = vi.fn(async () => {})
    const seam = seamReturning({
      id: 'child', dispose,
      result: Promise.resolve({ output: [{ type: 'text', text: '结论' }], stopReason: 'completed' }),
    })
    const outcome = await dispatchMember(seam, choice, REQUEST)
    expect(outcome).toMatchObject({ ok: true, text: '结论' })
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('子代理失败以结局返回而不是抛错，且照样释放 run', async () => {
    const dispose = vi.fn(async () => {})
    const seam = seamReturning({ id: 'child', dispose, result: Promise.resolve({ output: [], stopReason: 'refusal' }) })
    const outcome = await dispatchMember(seam, choice, REQUEST)
    expect(outcome.ok).toBe(false)
    expect(outcome.stopReason).toBe('refusal')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('基础设施故障向上抛，但 run 仍被释放', async () => {
    const dispose = vi.fn(async () => {})
    const seam = seamReturning({ id: 'child', dispose, result: Promise.reject(new Error('承载节点不可达')) })
    await expect(dispatchMember(seam, choice, REQUEST)).rejects.toThrow('承载节点不可达')
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

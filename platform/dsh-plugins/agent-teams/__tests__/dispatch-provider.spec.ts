import { describe, expect, it } from 'vitest'

import { FORK_PROVIDER, selectDispatchProvider, type MemberProviderChoice } from '../src/roster.ts'

/**
 * §24.3.1 的 provider 逐次选择。
 *
 * 这组用例的重心不是「延续性任务选到 fork」——那是最容易写对的一条。重心是**守卫 1**：
 * **换 provider 绝不能改变执行位置**。集群形态下 `base` 是 `lumo-remote`，若判据在这里
 * 「聪明地」换成进程内的 `fork`，成员会从承载节点悄悄退回父进程执行：负载全压在一个
 * 节点上、父节点的资源被吃掉，而**没有任何报错**，日志里只会看到一次成功的派发。
 */

const REMOTE: MemberProviderChoice = { provider: 'lumo-remote', kind: 'remote', reason: '装配期探测' }
const SPAWN: MemberProviderChoice = { provider: 'spawn', kind: 'in-process', reason: '装配期探测' }
const EXTERNAL: MemberProviderChoice = { provider: 'acp', kind: 'external', reason: '装配期探测' }

describe('守卫 1：进程外 provider 一律不动', () => {
  it('集群的 lumo-remote 即使面对延续性任务也不改 —— 改它等于把执行挪回父进程', () => {
    const chosen = selectDispatchProvider({
      base: REMOTE, available: ['lumo-remote', 'spawn', FORK_PROVIDER], continuesContext: true,
    })
    expect(chosen).toBe(REMOTE)
    expect(chosen.provider).toBe('lumo-remote')
    expect(chosen.kind).toBe('remote')
  })

  it('external provider 同理（不认识的后端不猜）', () => {
    const chosen = selectDispatchProvider({
      base: EXTERNAL, available: [FORK_PROVIDER], continuesContext: true,
    })
    expect(chosen).toBe(EXTERNAL)
  })
})

describe('守卫 2：正交任务保持独立上下文', () => {
  it('非延续性任务原样返回，哪怕 fork 就在手边', () => {
    const chosen = selectDispatchProvider({
      base: SPAWN, available: [FORK_PROVIDER], continuesContext: false,
    })
    expect(chosen).toBe(SPAWN)
    expect(chosen.provider).toBe('spawn')
  })

  it('缺省（未声明）按正交处理 —— 不猜想要的上下文', () => {
    // 猜错的代价不对称：正交任务拿到父级历史会污染它的独立性，
    // 而延续性任务没拿到只是多粘贴一次上下文。
    expect(selectDispatchProvider({ base: SPAWN, available: [FORK_PROVIDER], continuesContext: false }))
      .toBe(SPAWN)
  })
})

describe('守卫 3：fork 不可用时回落，不抛', () => {
  it('延续性任务在没挂 fork 的节点上回落 spawn，并在理由里说清楚', () => {
    const chosen = selectDispatchProvider({
      base: SPAWN, available: ['spawn'], continuesContext: true,
    })
    expect(chosen.provider).toBe('spawn')
    expect(chosen.kind).toBe('in-process')
    expect(chosen.reason).toContain('fork')
  })

  it('回落不改变执行位置（进程外仍然不动）', () => {
    const chosen = selectDispatchProvider({
      base: REMOTE, available: ['lumo-remote'], continuesContext: true,
    })
    expect(chosen).toBe(REMOTE)
  })
})

describe('正常路径：进程内 + 延续性 + fork 可用', () => {
  it('选 fork，理由点明是延续性而非「优先级更高」', () => {
    const chosen = selectDispatchProvider({
      base: SPAWN, available: ['spawn', FORK_PROVIDER], continuesContext: true,
    })
    expect(chosen.provider).toBe(FORK_PROVIDER)
    expect(chosen.kind).toBe('in-process')
    expect(chosen.reason).toContain('延续')
  })

  it('base 本来就是 fork 时幂等', () => {
    const forkBase: MemberProviderChoice = { provider: FORK_PROVIDER, kind: 'in-process', reason: '显式配置' }
    const chosen = selectDispatchProvider({
      base: forkBase, available: [FORK_PROVIDER], continuesContext: true,
    })
    expect(chosen.provider).toBe(FORK_PROVIDER)
  })
})

describe('不变量：结论永远是进程内或原样', () => {
  it('穷举 base × available × 延续性，结论的 kind 只可能是 in-process 或 base 的 kind', () => {
    const bases = [REMOTE, SPAWN, EXTERNAL]
    const availables: string[][] = [[], ['spawn'], [FORK_PROVIDER], ['spawn', FORK_PROVIDER], ['lumo-remote']]
    for (const base of bases) {
      for (const available of availables) {
        for (const continuesContext of [true, false]) {
          const chosen = selectDispatchProvider({ base, available, continuesContext })
          const expectedKind = base.kind === 'in-process' ? 'in-process' : base.kind
          expect(chosen.kind).toBe(expectedKind)
          // 进程外 base 必须原样返回（引用相等）；进程内 base 允许换 provider。
          if (base.kind !== 'in-process') expect(chosen).toBe(base)
        }
      }
    }
  })
})

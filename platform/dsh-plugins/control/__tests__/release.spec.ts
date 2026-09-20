import { describe, expect, it, vi } from 'vitest'

import {
  DEFAULT_TOOL_FACTS,
  isSideEffectTool,
  toolRelease,
  type ReleaseClassifier,
} from '../src/release.ts'

/**
 * §24.5 动作放行闸的判据测试。
 *
 * 三组断言，对应文件头三条边界：
 *   1. **默认行为不回归**——没配分类器时与接线前逐字节一致；
 *   2. **只收窄不放宽**——已中止的会话与全拒档，分类器无权翻案；
 *   3. **只读不受分类器影响**。
 */

/** 造一个分类器。`available=false` 时连 `verdict` 都不该被调用。 */
function classifier(
  verdict: 'allow' | 'review',
  available = true,
): ReleaseClassifier & { verdict: ReturnType<typeof vi.fn> } {
  return {
    available: () => available,
    verdict: vi.fn(() => verdict),
  } as ReleaseClassifier & { verdict: ReturnType<typeof vi.fn> }
}

describe('§24.5 toolRelease —— 默认行为不回归', () => {
  it('running 档放行一切，且不调用分类器', async () => {
    const c = classifier('review')
    for (const tool of ['read', 'bash', 'edit', 'connector_github', 'knowledge_publish']) {
      const release = await toolRelease('running', tool, c)
      expect(release).toEqual({ allow: true, band: null, reason: 'state-running' })
    }
    // 不变量 2：不为记录而制造一次判定。
    expect(c.verdict).not.toHaveBeenCalled()
  })

  it('没配分类器时：只读档放行只读工具、拒绝副作用工具（与接线前一致）', async () => {
    const release = await toolRelease('paused', 'read', undefined)
    expect(release.allow).toBe(true)
    expect(release.band).toBeNull()

    const blocked = await toolRelease('paused', 'bash', undefined)
    expect(blocked.allow).toBe(false)
    expect(blocked.band).toBe('REVIEW')
    expect(blocked.reason).toBe('classifier-unavailable')
  })

  it('awaiting-approval / stopped 与 paused 同一分支', async () => {
    for (const state of ['paused', 'awaiting-approval', 'stopped']) {
      expect((await toolRelease(state, 'read', undefined)).allow).toBe(true)
      expect((await toolRelease(state, 'edit', undefined)).allow).toBe(false)
    }
  })
})

describe('§24.5 toolRelease —— 只收窄，不放宽', () => {
  it('aborted 档在分类之前就返回，分类器没有机会发问', async () => {
    const c = classifier('allow')
    for (const tool of ['read', 'bash', 'edit']) {
      const release = await toolRelease('aborted', tool, c)
      expect(release.allow).toBe(false)
      expect(release.band).toBeNull()
      expect(release.reason).toBe('state-aborted')
    }
    expect(c.verdict).not.toHaveBeenCalled()
  })

  it('词表外的状态与 aborted 同档（gate.ts 的 fail-closed 不被本层放宽）', async () => {
    const c = classifier('allow')
    const release = await toolRelease('some-unknown-state', 'bash', c)
    expect(release.allow).toBe(false)
    expect(release.band).toBeNull()
    expect(c.verdict).not.toHaveBeenCalled()
  })

  it('只读工具与分类器可用性无关', async () => {
    const unavailable = await toolRelease('paused', 'read', classifier('review', false))
    const available = await toolRelease('paused', 'read', classifier('review'))
    expect(unavailable).toEqual(available)
    expect(unavailable).toEqual({ allow: true, band: null, reason: 'read-only-tool' })
  })

  it('分类器说 allow 才放行；说 review 仍拒', async () => {
    const allowed = await toolRelease('paused', 'bash', classifier('allow'))
    expect(allowed).toEqual({ allow: true, band: 'AUTO', reason: 'classifier-allow' })

    const reviewed = await toolRelease('paused', 'bash', classifier('review'))
    expect(reviewed.allow).toBe(false)
    expect(reviewed.band).toBe('REVIEW')
  })

  it('分类器抛错按「不可用」处理，不按「判定为危险」处理', async () => {
    // 失败归因必须分族：把「分类器挂了」表现成「工具被判定为危险」，
    // 现场会去查工具而真正的问题在分类器。
    const c: ReleaseClassifier = {
      available: () => true,
      verdict: () => { throw new Error('classifier down') },
    }
    const release = await toolRelease('paused', 'bash', c)
    expect(release.allow).toBe(false)
    expect(release.reason).toBe('classifier-unavailable')
  })

  it('classification 自身抛错同样按不可用处理（装配层也可能坏）', async () => {
    const c: ReleaseClassifier = {
      available: () => { throw new Error('service lookup blew up') },
      verdict: () => 'allow',
    }
    // 这条不是冗余：`available()` 与 `verdict()` 分两次调用，任一次抛错都必须
    // 归到同一个失败族，否则「分类器挂了」会有两种不同的现场表现。
    const release = await toolRelease('paused', 'bash', c)
    expect(release.allow).toBe(false)
    expect(release.reason).toBe('classifier-unavailable')
  })
})

describe('§24.5 toolRelease —— 工具事实只影响严的那一侧', () => {
  it('不可逆的副作用工具即使分类器放行也不放行', async () => {
    const release = await toolRelease('paused', 'bash', classifier('allow'), {
      ...DEFAULT_TOOL_FACTS, reversible: false,
    })
    expect(release.allow).toBe(false)
    expect(release.reason).toBe('irreversible')
  })

  it('跨 realm 与碰凭证的工具同理', async () => {
    const crossRealm = await toolRelease('paused', 'bash', classifier('allow'), {
      ...DEFAULT_TOOL_FACTS, crossRealm: true,
    })
    expect(crossRealm.reason).toBe('cross-realm')

    const credentials = await toolRelease('paused', 'bash', classifier('allow'), {
      ...DEFAULT_TOOL_FACTS, touchesCredentials: true,
    })
    expect(credentials.reason).toBe('credentials')
  })

  it('缺省事实是「普通可逆写」——分类器可放行的那一档', async () => {
    const release = await toolRelease('paused', 'bash', classifier('allow'))
    expect(release.allow).toBe(true)
    expect(release.band).toBe('AUTO')
  })
})

describe('§24.5 isSideEffectTool —— 唯一判据来源', () => {
  it('按前缀匹配，覆盖既有名单', () => {
    for (const tool of ['bash', 'pwsh', 'write', 'edit', 'connector_github', 'knowledge_publish']) {
      expect(isSideEffectTool(tool)).toBe(true)
    }
  })

  it('只读工具与前缀的近似串不被误判', () => {
    for (const tool of ['read', 'grep', 'glob', 'readfile', 'edits', 'bashful', '']) {
      // 注意 'edits' / 'bashful' 是**有意**为真的前缀命中：前缀匹配比精确匹配宽，
      // 宽的那一侧是安全侧（误判成有副作用只多要一次人审，不会漏放）。
      expect(isSideEffectTool(tool)).toBe(tool.startsWith('edit') || tool.startsWith('bash'))
    }
  })
})

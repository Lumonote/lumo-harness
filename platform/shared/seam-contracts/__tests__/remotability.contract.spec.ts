import { describe, expect, it } from 'vitest'

import {
  SEAM_GRADES,
  TURN_NETWORK_BUDGET_MS,
  assertRemotable,
  gradeOf,
  isIdempotent,
  isRemotable,
  type SeamGrade,
} from '../remotability.ts'

/**
 * dsh 上游全部 `seam` 角色服务，**人工抄录**自
 * `deepseek-harness/docs/capability-seams.md`（tag `dsh-v0.1.1-rc.2`）。
 *
 * 抄录而非解析：解析会让平台测试依赖一个只读外部树的文件路径。代价是上游升级
 * 新增 seam 不会让本用例变红——因此 dsh 版本升级的检查表里必须有「重核分级表」。
 */
const UPSTREAM_SEAMS = [
  'ctx.approval', 'ctx.attachments', 'ctx.authorization', 'ctx.codeRuntime',
  'ctx.compaction', 'ctx.credentials', 'ctx.directoryPicker', 'ctx.fileReferences',
  'ctx.fs', 'ctx.jobs', 'ctx.llm', 'ctx.lsp', 'ctx.sandbox', 'ctx.sessionPersistence',
  'ctx.sessionQuery', 'ctx.sessionTelemetry', 'ctx.sessionTitle', 'ctx.settings',
  'ctx.shell', 'ctx.skills', 'ctx.spillStore', 'ctx.storage', 'ctx.subagents',
  'ctx.subprocess', 'ctx.terminals', 'ctx.userQuestions', 'ctx.web',
  'ctx.workflowEngine',
] as const

const entries = (): Array<[string, SeamGrade]> => Object.entries(SEAM_GRADES)

describe('覆盖完整性 —— 上游每个 seam 都必须有定级', () => {
  it('28 个 seam 角色服务逐一在表中', () => {
    const missing = UPSTREAM_SEAMS.filter((s) => gradeOf(s) === undefined)
    expect(missing).toEqual([])
  })

  it('抄录清单本身是 28 条（防止编辑时手滑删行）', () => {
    expect(UPSTREAM_SEAMS.length).toBe(28)
    expect(new Set(UPSTREAM_SEAMS).size).toBe(28)
  })

  it('上游 seam 无一被判 remotable —— 这是结论，不是待补', () => {
    const remotableUpstream = UPSTREAM_SEAMS.filter((s) => isRemotable(s))
    expect(remotableUpstream).toEqual([])
  })
})

describe('理由必填 —— 拒绝的原因必须能从错误信息里读到', () => {
  it('every never / needs-design 条目有非空 why', () => {
    const noWhy = entries()
      .filter(([, g]) => g.class !== 'remotable')
      .filter(([, g]) => !g.why || g.why.trim().length === 0)
      .map(([k]) => k)
    expect(noWhy).toEqual([])
  })

  it('needs-design 必须写明正确归属，否则等于「以后再说」', () => {
    const noOwner = entries()
      .filter(([, g]) => g.class === 'needs-design')
      .filter(([, g]) => !g.belongsTo || g.belongsTo.trim().length === 0)
      .map(([k]) => k)
    expect(noOwner).toEqual([])
  })
})

describe('预算自洽 —— 粗粒度硬规矩的量化形式', () => {
  it('remotable 条目的 调用次数 × 单次预算 不超过 turn 级网络开销上限', () => {
    for (const [name, g] of entries()) {
      if (g.class !== 'remotable') continue
      expect(g.perTurnCallBudget, `${name} 缺 perTurnCallBudget`).toBeGreaterThan(0)
      expect(g.latencyBudgetMs, `${name} 缺 latencyBudgetMs`).toBeGreaterThan(0)
      expect(g.perTurnCallBudget! * g.latencyBudgetMs!,
        `${name} 超出 turn 级网络预算`).toBeLessThanOrEqual(TURN_NETWORK_BUDGET_MS)
    }
  })

  it('非 remotable 条目不得声明方法表或预算 —— 声明了说明定级与实现不一致', () => {
    const leaky = entries()
      .filter(([, g]) => g.class !== 'remotable')
      .filter(([, g]) => g.methods !== undefined
        || g.perTurnCallBudget !== undefined
        || g.latencyBudgetMs !== undefined)
      .map(([k]) => k)
    expect(leaky).toEqual([])
  })

  it('remotable 条目每个方法都声明了幂等性', () => {
    for (const [name, g] of entries()) {
      if (g.class !== 'remotable') continue
      expect(g.methods, `${name} 缺 methods`).toBeDefined()
      expect(Object.keys(g.methods!).length, `${name} 方法表为空`).toBeGreaterThan(0)
      for (const [m, spec] of Object.entries(g.methods!)) {
        expect(typeof spec.idempotent, `${name}.${m}`).toBe('boolean')
      }
    }
  })
})

describe('查询 API', () => {
  it('isRemotable 只对 remotable 类为真', () => {
    expect(isRemotable('knowledge')).toBe(true)
    expect(isRemotable('ctx.terminals')).toBe(false)
    expect(isRemotable('ctx.llm')).toBe(false)
  })

  it('未定级的 seam 一律不可远程（fail closed）', () => {
    expect(gradeOf('made-up-seam')).toBeUndefined()
    expect(isRemotable('made-up-seam')).toBe(false)
  })

  it('assertRemotable 对 remotable 静默通过', () => {
    expect(() => assertRemotable('knowledge')).not.toThrow()
  })

  it('assertRemotable 拒 never 类，且错误信息带类别与理由', () => {
    let msg = ''
    try { assertRemotable('ctx.terminals') } catch (e) { msg = String(e) }
    expect(msg).toContain('ctx.terminals')
    expect(msg).toContain('never')
    expect(msg).toContain(SEAM_GRADES['ctx.terminals']!.why!)
  })

  it('assertRemotable 拒 needs-design 类，且带正确归属', () => {
    let msg = ''
    try { assertRemotable('ctx.llm') } catch (e) { msg = String(e) }
    expect(msg).toContain('needs-design')
    expect(msg).toContain(SEAM_GRADES['ctx.llm']!.belongsTo!)
  })

  it('assertRemotable 拒未定级的 seam，措辞是「未定级」而非「不存在」', () => {
    let msg = ''
    try { assertRemotable('made-up-seam') } catch (e) { msg = String(e) }
    expect(msg).toContain('made-up-seam')
    expect(msg).toContain('未定级')
  })

  it('assertRemotable 抛普通 Error —— 避免与 remote.ts 形成循环依赖', () => {
    expect(() => assertRemotable('ctx.fs')).toThrowError(Error)
  })
})

describe('幂等性单一来源', () => {
  it('分级表里声明幂等的方法为 true', () => {
    expect(isIdempotent('knowledge', 'query')).toBe(true)
    expect(isIdempotent('knowledgeGraph', 'upsertNodes')).toBe(true)
  })

  it('未定级 seam 与未声明方法一律 false —— 不可重试是安全的默认', () => {
    expect(isIdempotent('made-up-seam', 'query')).toBe(false)
    expect(isIdempotent('knowledge', 'constructor')).toBe(false)
    expect(isIdempotent('knowledge', 'toString')).toBe(false)
    expect(isIdempotent('ctx.terminals', 'write')).toBe(false)
  })
})

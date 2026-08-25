import { describe, expect, it } from 'vitest'

import { assertSeamsRemotable } from '../src/gate.ts'

describe('闸 A —— 加载期可远程化校验', () => {
  it('放行分级表里的 remotable seam', () => {
    expect(() => assertSeamsRemotable(['knowledge', 'knowledgeGraph'])).not.toThrow()
  })

  it('不接管任何 seam 是合法的', () => {
    expect(() => assertSeamsRemotable([])).not.toThrow()
  })

  it('拒 never 类，错误信息含类别与理由', () => {
    let msg = ''
    try { assertSeamsRemotable(['ctx.terminals']) } catch (e) { msg = String(e) }
    expect(msg).toContain('ctx.terminals')
    expect(msg).toContain('never')
    expect(msg).toContain('长驻 PTY')
  })

  it('拒 needs-design 类，并指出正确归属', () => {
    let msg = ''
    try { assertSeamsRemotable(['ctx.llm']) } catch (e) { msg = String(e) }
    expect(msg).toContain('needs-design')
    expect(msg).toContain('LLM 网关')
  })

  it('拒未定级的 seam 名，措辞是「未定级」而非「不存在」', () => {
    let msg = ''
    try { assertSeamsRemotable(['made-up-seam']) } catch (e) { msg = String(e) }
    expect(msg).toContain('made-up-seam')
    expect(msg).toContain('未定级')
  })

  it('一列里混了合法与非法时也要拒 —— 不得只装配合法的那部分', () => {
    expect(() => assertSeamsRemotable(['knowledge', 'ctx.subprocess'])).toThrow()
  })

  it('多个非法项一次报全 —— 逐个报会让人改一轮试一轮', () => {
    let msg = ''
    try {
      assertSeamsRemotable(['ctx.terminals', 'ctx.llm', 'made-up-seam'])
    } catch (e) { msg = String(e) }
    expect(msg).toContain('ctx.terminals')
    expect(msg).toContain('ctx.llm')
    expect(msg).toContain('made-up-seam')
  })
})

import { describe, expect, it, vi } from 'vitest'

import { apply, upstream } from '../src/index.ts'

describe('@lumo/archify', () => {
  it('registers the typed and validated diagram skill with upstream provenance', () => {
    const register = vi.fn(() => vi.fn())
    const effect = vi.fn()
    apply({ get: () => ({ register }), effect } as never)

    expect(upstream.repository).toBe('https://github.com/tt-a1i/archify')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'archify',
      provider: 'lumo-archify',
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    }))
    // 前两条锚在上游 SKILL.md 正文,证明 frontmatter 之后的 body 真被拼进来了;
    // 后两条锚在 LUMO_EXTENSION。上游锚点是散文,升级 pin 版本时需要一并复核 ——
    // 'JSON IR' 就是在升到 2.16.0-dev.0 后消失的(改称 typed JSON specification)。
    expect(register.mock.calls[0]?.[0].content).toContain('typed JSON specification')
    expect(register.mock.calls[0]?.[0].content).toContain('showcase')
    expect(register.mock.calls[0]?.[0].content).toContain('infrared-grid')
    expect(register.mock.calls[0]?.[0].content).toContain('data-lumo-theme')
    expect(effect).toHaveBeenCalledOnce()
  })
})

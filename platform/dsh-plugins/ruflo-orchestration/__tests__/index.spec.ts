import { describe, expect, it, vi } from 'vitest'
import { apply, upstream } from '../src/index.ts'

describe('@lumo/ruflo-orchestration', () => {
  it('registers a bounded orchestration skill without replacing Lumo task state', () => {
    const register = vi.fn(() => vi.fn())
    const effect = vi.fn()
    apply({ get: () => ({ register }), effect } as never)
    expect(upstream.package).toBe('ruflo@3.38.20')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'ruflo-orchestration', provider: 'lumo-ruflo', source: 'bundled',
    }))
    const content = register.mock.calls[0]?.[0].content as string
    expect(content).toContain('Lumo owns task identity')
    expect(content).toContain('Do not run `ruflo init`')
    expect(effect).toHaveBeenCalledOnce()
  })
})

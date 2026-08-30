import { describe, expect, it, vi } from 'vitest'

import { apply, upstream } from '../src/index.ts'

describe('@lumo/open-design', () => {
  it('registers the artifact-first skill with upstream provenance', () => {
    const register = vi.fn(() => vi.fn())
    const effect = vi.fn()
    apply({ get: () => ({ register }), effect } as never)

    expect(upstream.repository).toBe('https://github.com/nexu-io/open-design')
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'open-design',
      provider: 'lumo-open-design',
      source: 'bundled',
      invocation: { modelInvocable: true, userInvocable: true },
    }))
    expect(register.mock.calls[0]?.[0].content).toContain('artifact-first')
    expect(register.mock.calls[0]?.[0].content).toContain('obsidian-signal')
    expect(register.mock.calls[0]?.[0].content).toContain('data-lumo-theme')
    expect(effect).toHaveBeenCalledOnce()
  })
})

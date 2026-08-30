import { describe, expect, it, vi } from 'vitest'
import { apply, upstream } from '../src/index.ts'

describe('@lumo/creative-skills', () => {
  it('registers the pinned image and presentation skills in Chinese', () => {
    const register = vi.fn(() => vi.fn())
    const effect = vi.fn()
    apply({ get: () => ({ register }), effect } as never)
    expect(upstream.image.repository).toContain('awesome-gpt-image-2')
    expect(upstream.presentation.repository).toContain('ppt-master')
    expect(register).toHaveBeenCalledTimes(2)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'gpt-image-2-style-library', source: 'bundled' }))
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ name: 'ppt-master', source: 'bundled' }))
    expect(effect).toHaveBeenCalledOnce()
  })
})

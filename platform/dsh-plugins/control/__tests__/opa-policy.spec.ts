import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpaControlPolicy, RbacControlPolicy } from '../src/policy.ts'

const request = { command: 'pause' as const, actor: 'alice', role: 'operator', realm: 'r1', sessionRef: 's1' }
const policy = () => new OpaControlPolicy('http://opa:8181', new RbacControlPolicy())
afterEach(() => vi.unstubAllGlobals())

describe('central session control policy', () => {
  it('requires an explicit central grant and forwards the full authorization context', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ result: true })))
    vi.stubGlobal('fetch', fetch)
    expect(await policy().evaluate(request)).toEqual({ allowed: true })
    expect(JSON.parse(fetch.mock.calls[0]![1].body)).toEqual({ input: request })
  })

  it.each([{}, { result: false }, { result: 'true' }])('denies an absent or invalid decision: %j', async body => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body))))
    expect((await policy().evaluate(request)).allowed).toBe(false)
  })

  it('denies outages and cannot expand local grants', async () => {
    const fetch = vi.fn().mockRejectedValue(new Error('unavailable'))
    vi.stubGlobal('fetch', fetch)
    expect((await policy().evaluate(request)).allowed).toBe(false)
    fetch.mockClear()
    expect((await policy().evaluate({ ...request, role: 'viewer' })).allowed).toBe(false)
    expect(fetch).not.toHaveBeenCalled()
  })
})

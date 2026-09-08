import { describe, expect, it, vi } from 'vitest'

import { apply, Config, DEFAULT_FAKE_IP_CIDRS, FAKE_IP_PROVIDER_ID, FakeIpFetchProvider } from '../src/index.ts'

describe('@lumo/web-fetch-fakeip', () => {
  it('applies schemastery defaults for the allowlist and limits', () => {
    const resolved = Config({}) as Required<typeof Config>
    expect(resolved.fakeIpCidrs).toEqual([...DEFAULT_FAKE_IP_CIDRS])
    expect(resolved.maxResponseBytes).toBe(5_000_000)
    expect(resolved.userAgent).toContain('deepseek-harness')
  })

  it('registers a fetch provider under the pinned id', () => {
    const registerFetchProvider = vi.fn()
    apply({ web: { registerFetchProvider } } as never, Config({}))

    expect(registerFetchProvider).toHaveBeenCalledTimes(1)
    const registered = registerFetchProvider.mock.calls[0][0] as FakeIpFetchProvider
    expect(registered.id).toBe(FAKE_IP_PROVIDER_ID)
    expect(registered.available()).toBe(true)
  })

  it('fails loud on invalid CIDR or out-of-range limit', () => {
    expect(() => apply({ web: { registerFetchProvider: vi.fn() } } as never, Config({ fakeIpCidrs: ['nope'] })))
      .toThrow(/not a valid CIDR/)
    expect(() => apply({ web: { registerFetchProvider: vi.fn() } } as never, Config({ timeoutMs: -1 })))
      .toThrow(/positive finite/)
    expect(() => apply({ web: { registerFetchProvider: vi.fn() } } as never, Config({ maxRedirects: -1 })))
      .toThrow(/non-negative integer/)
  })

  it('delegates fetch and availability to the wrapped official provider', async () => {
    const request = { url: 'https://pi.dev/' }
    const innerFetch = vi.fn(async () => ({ statusCode: 200 }))
    const inner = { available: () => false, fetch: innerFetch }
    const provider = new FakeIpFetchProvider(inner as never)

    expect(provider.available()).toBe(false)
    expect(await provider.fetch(request as never)).toEqual({ statusCode: 200 })
    expect(innerFetch).toHaveBeenCalledWith(request, undefined)
  })
})

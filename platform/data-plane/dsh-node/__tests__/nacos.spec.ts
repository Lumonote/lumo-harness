import { afterEach, describe, expect, it, vi } from 'vitest'
import { startNacosRegistration } from '../src/nacos.ts'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const options = { baseUrl: 'http://nacos', serviceName: 'nodes', groupName: 'g', nodeId: 'N1', realm: 'r', clusterId: 'c', host: 'node-1', port: 8091, capacity: 1, capabilities: ['cpu'], residency: '' }

describe('execution node discovery eligibility', () => {
  it('keeps an unready node disabled and enables it only after readiness succeeds', async () => {
    vi.useFakeTimers()
    let ready = false
    const registrations: URL[] = []
    const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      if (url.pathname === '/readyz') return new Response('{}', { status: ready ? 200 : 503 })
      if (init?.method === 'POST') registrations.push(url)
      return new Response('ok')
    })
    vi.stubGlobal('fetch', fetchMock)
    const registration = startNacosRegistration(options)
    await vi.advanceTimersByTimeAsync(0)
    expect(registrations[0]?.searchParams.get('enabled')).toBe('false')
    ready = true
    await vi.advanceTimersByTimeAsync(5_000)
    expect(registrations[1]?.searchParams.get('enabled')).toBe('true')
    expect(JSON.parse(registrations[1]!.searchParams.get('metadata')!)).toMatchObject({ node_id: 'N1', realm: 'r', cluster_id: 'c' })
    await registration.close()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(registrations).toHaveLength(2)
    expect(fetchMock.mock.calls.at(-1)?.[1]?.method).toBe('DELETE')
  })

  it('waits for an in-flight registration before deleting, preventing reappearance after close', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const methods: string[] = []
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      if (new URL(input).pathname === '/readyz') return new Response('{}')
      methods.push(init?.method ?? 'GET')
      if (init?.method === 'POST') await new Promise<void>(resolve => { release = resolve })
      return new Response('ok')
    })
    const registration = startNacosRegistration(options)
    await vi.advanceTimersByTimeAsync(0)
    const closing = registration.close()
    expect(methods).toEqual(['POST'])
    release()
    await closing
    await vi.advanceTimersByTimeAsync(10_000)
    expect(methods).toEqual(['POST', 'DELETE'])
  })

  it('orders withdrawal after an already sent enabled registration and never refreshes it again', async () => {
    vi.useFakeTimers()
    let release!: () => void
    const methods: string[] = []
    let enabled = false
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input)
      methods.push(init!.method!)
      if (init!.method === 'POST') await new Promise<void>(resolve => { release = resolve })
      enabled = url.searchParams.get('enabled') === 'true'
      return new Response('ok')
    })
    const registration = startNacosRegistration(options, console, async () => true)
    await vi.advanceTimersByTimeAsync(0)
    let withdrawn = false
    const withdrawal = registration.withdraw().then(() => { withdrawn = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(withdrawn).toBe(false)
    expect(methods).toEqual(['POST'])
    release()
    await withdrawal
    expect(enabled).toBe(false)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(methods).toEqual(['POST', 'PUT'])
    await registration.close()
    await registration.close()
    expect(methods).toEqual(['POST', 'PUT', 'DELETE'])
  })

  it('does not send a late registration when withdrawal starts during readiness', async () => {
    vi.useFakeTimers()
    let ready!: (value: boolean) => void
    const methods: string[] = []
    vi.stubGlobal('fetch', async (_input: string | URL, init?: RequestInit) => {
      methods.push(init!.method!)
      return new Response('ok')
    })
    const registration = startNacosRegistration(options, console, () => new Promise(resolve => { ready = resolve }))
    const withdrawal = registration.withdraw()
    const closing = registration.close()
    ready(true)
    await Promise.all([withdrawal, closing])
    expect(methods).toEqual(['PUT', 'DELETE'])
    await vi.advanceTimersByTimeAsync(15_000)
    expect(methods).toEqual(['PUT', 'DELETE'])
  })

  it('keeps refreshes stopped when withdrawal fails and retries the failed disable', async () => {
    vi.useFakeTimers()
    const methods: string[] = []
    let fail = true
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      methods.push(init!.method!)
      return new Response('ok', { status: init!.method === 'PUT' && new URL(input).searchParams.get('enabled') === 'false' && fail ? 503 : 200 })
    })
    const registration = startNacosRegistration(options, console, async () => true)
    await vi.advanceTimersByTimeAsync(0)
    await expect(registration.withdraw()).rejects.toThrow('HTTP 503')
    await vi.advanceTimersByTimeAsync(15_000)
    expect(methods).toEqual(['POST', 'PUT', 'PUT'])
    fail = false
    await registration.withdraw()
    await registration.close()
    expect(methods).toEqual(['POST', 'PUT', 'PUT', 'PUT', 'DELETE'])
  })

  it('overrides persisted drain metadata when a fresh process becomes ready', async () => {
    vi.useFakeTimers()
    let metadataEnabled = false
    let eligible = false
    vi.stubGlobal('fetch', async (input: string | URL, init?: RequestInit) => {
      const enabled = new URL(input).searchParams.get('enabled') === 'true'
      if (init!.method === 'PUT') metadataEnabled = enabled
      if (init!.method === 'DELETE') eligible = false
      else eligible = enabled && metadataEnabled
      return new Response('ok')
    })
    const first = startNacosRegistration(options, console, async () => true)
    await vi.advanceTimersByTimeAsync(0)
    expect(eligible).toBe(true)
    await first.withdraw()
    expect(eligible).toBe(false)
    await first.close()
    const restarted = startNacosRegistration(options, console, async () => true)
    await vi.advanceTimersByTimeAsync(0)
    expect(eligible).toBe(true)
    await restarted.close()
  })
})

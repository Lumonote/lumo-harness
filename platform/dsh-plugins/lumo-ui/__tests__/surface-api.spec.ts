import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, api, apiText, optionalApi } from '../src/client/api.ts'
afterEach(() => vi.unstubAllGlobals())
describe('workbench HTTP contract', () => {
  it('retains Headers authentication and explicit content types during a JSON write', async () => {
    const fetch = vi.fn(async () => Response.json({ revision: 2 })); vi.stubGlobal('fetch', fetch)
    expect(await api('/example', { method: 'POST', headers: new Headers({ 'X-Lumo-Auth-Request': '1', 'Content-Type': 'application/custom+json' }), body: '{}' })).toEqual({ revision: 2 })
    const headers = fetch.mock.calls[0]![1].headers as Headers
    expect(headers.get('X-Lumo-Auth-Request')).toBe('1'); expect(headers.get('Content-Type')).toBe('application/custom+json')
  })
  it('retains a plain-text failure message and exposes HTTP status for retry decisions', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('服务暂时无法读取，请重试。', { status: 503 })))
    await expect(apiText('/example')).rejects.toMatchObject({ name: 'ApiError', status: 503, message: '服务暂时无法读取，请重试。' })
    const result = await optionalApi('/example', [])
    expect(result).toEqual({ data: [], state: 'unavailable', error: '服务暂时无法读取，请重试。' })
  })
  it('does not disguise permissions or unsupported providers as an empty successful list', async () => {
    for (const [status, state] of [[403, 'forbidden'], [501, 'unsupported']] as const) {
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'scope_denied' }, { status })))
      expect(await optionalApi('/example', [])).toEqual({ data: [], state, error: 'scope_denied' })
    }
    expect(new ApiError(502, { message: '重新读取' }, 'fallback').message).toBe('重新读取')
  })
})

/**
 * GatewayWebFetchProvider 的契约测试（窄接口 stub，不依赖真网关）。
 *
 * 真网关行为（闸门链/审计/计量/编码）由 Go 侧 server_test.go/policy_test.go 覆盖；
 * 本文件只锁 dsh seam 侧的映射：非 2xx 是结果、拒绝码 → WebError 码、编码 ↔ 内容、
 * 截断语义、信号透传。
 */
import { describe, expect, it, vi } from 'vitest'

import { GatewayError, type InvokeResult } from '../../connector/src/client.ts'
import { GatewayWebFetchProvider, toFetchResult } from '../src/index.ts'

function stubClient(impl?: (req: { url: string }, signal?: AbortSignal) => Promise<InvokeResult>) {
  const webFetch = vi.fn(impl ?? (async () => blankResult()))
  return { webFetch }
}

function blankResult(overrides: Partial<InvokeResult> = {}): InvokeResult {
  return {
    status: 200,
    durationMs: 5,
    redacted: false,
    ...overrides,
  }
}

describe('toFetchResult —— 网关结果转 seam 基元', () => {
  it('200 text/html 转 html kind', () => {
    const r = toFetchResult(
      blankResult({ body: '<html><body>hi</body></html>', encoding: 'text', contentType: 'text/html; charset=utf-8' }),
      'https://example.com/', 100_000,
    )
    expect(r.statusCode).toBe(200)
    expect(r.url).toBe('https://example.com/')
    expect(r.body.kind).toBe('html')
    expect(r.body.content).toContain('hi')
    expect(r.truncated).toBe(false)
  })

  it('application/xhtml+xml 也是 html kind', () => {
    const r = toFetchResult(blankResult({ body: '<x/>', encoding: 'text', contentType: 'application/xhtml+xml' }), 'https://e/', 100)
    expect(r.body.kind).toBe('html')
  })

  it('text/csv 与未知类型转 text kind', () => {
    for (const ct of ['text/csv; charset=utf-8', 'application/json', '']) {
      const r = toFetchResult(blankResult({ body: 'a,b\n1,2', encoding: 'text', contentType: ct }), 'https://e/', 100)
      expect(r.body.kind).toBe('text')
    }
  })

  it('404 是结果不是错误：statusCode 如实', () => {
    const r = toFetchResult(
      blankResult({ status: 404, body: 'Not Found', encoding: 'text', contentType: 'text/plain' }),
      'https://e/x', 100,
    )
    expect(r.statusCode).toBe(404)
    expect(r.body.content).toBe('Not Found')
  })

  it('encoding=json：对象序列化为 JSON 文本', () => {
    const r = toFetchResult(
      blankResult({ body: { error: 'upstream', code: 1 }, encoding: 'json', contentType: 'application/json' }),
      'https://e/', 1000,
    )
    expect(r.body.content).toBe('{"error":"upstream","code":1}')
  })

  it('encoding=text：原文保真（NUL / unicode / HTML 同时在场）', () => {
    // NUL 与 SOH 用 fromCharCode 构造：源码文件本身不能含裸控制字符（NUL 字节陷阱）
    const content = String.fromCharCode(0, 0, 1) + ' 中文 <tag> 😀</tag>'
    const r = toFetchResult(blankResult({ body: content, encoding: 'text', contentType: 'text/html' }), 'https://e/', 1000)
    expect(r.body.content).toBe(content)
  })

  it('encoding=base64：二进制转 UTF-8 解码', () => {
    const raw = Buffer.from('中文字节内容 ' + String.fromCharCode(0) + 'ok', 'utf8')
    const r = toFetchResult(
      blankResult({ body: raw.toString('base64'), encoding: 'base64', contentType: 'application/octet-stream' }),
      'https://e/', 1000,
    )
    expect(r.body.content).toBe(raw.toString('utf8'))
  })

  it('超过 maxBodyChars 转 truncated 且裁到上限', () => {
    const r = toFetchResult(blankResult({ body: 'abcdefghi', encoding: 'text', contentType: 'text/plain' }), 'https://e/', 5)
    expect(r.truncated).toBe(true)
    expect(r.body.content).toBe('abcde')
  })

  it('恰好等于上限不截断', () => {
    const r = toFetchResult(blankResult({ body: 'abcde', encoding: 'text', contentType: 'text/plain' }), 'https://e/', 5)
    expect(r.truncated).toBe(false)
  })

  it('空 body 转空内容', () => {
    const r = toFetchResult(blankResult({ body: undefined, encoding: undefined, contentType: undefined }), 'https://e/', 10)
    expect(r.body.content).toBe('')
    expect(r.truncated).toBe(false)
  })
})

describe('GatewayWebFetchProvider —— seam 行为', () => {
  it('id=lumo-gateway、available 恒真、构造不发起网络调用', () => {
    const p = new GatewayWebFetchProvider(stubClient())
    expect(p.id).toBe('lumo-gateway')
    expect(p.available()).toBe(true)
  })

  it('fetch 把请求交给 client 并回显 url', async () => {
    const client = stubClient(async () => blankResult({ body: 'ok', encoding: 'text', contentType: 'text/plain' }))
    const p = new GatewayWebFetchProvider(client)
    const r = await p.fetch({ url: 'https://example.com/path' })
    expect(client.webFetch).toHaveBeenCalledWith({ url: 'https://example.com/path' }, undefined)
    expect(r.url).toBe('https://example.com/path')
  })

  it('拒绝码转 WebError 码（映射表逐项）', async () => {
    const cases: Array<[GatewayError['code'], number, string]> = [
      ['egress_denied', 403, 'lumo.egress_denied'],
      ['rate_limited', 429, 'lumo.rate_limited'],
      ['circuit_open', 503, 'lumo.circuit_upstream'],
      ['payload_too_large', 413, 'WEB_FETCH_TOO_LARGE'],
      ['credential_error', 502, 'WEB_PROVIDER_ERROR'],
      ['upstream_error', 502, 'WEB_PROVIDER_ERROR'],
      ['internal_error', 500, 'WEB_PROVIDER_ERROR'],
    ]
    for (const [code, status, expected] of cases) {
      const client = stubClient(async () => { throw new GatewayError(code, status, `拒绝: ${code}`) })
      const p = new GatewayWebFetchProvider(client)
      await expect(p.fetch({ url: 'https://e/' })).rejects.toMatchObject({ code: expected })
    }
  })

  it('WebError 保留原因链', async () => {
    const client = stubClient(async () => { throw new GatewayError('rate_limited', 429, '稍后重试') })
    const p = new GatewayWebFetchProvider(client)
    await p.fetch({ url: 'https://e/' }).catch((e: Error) => {
      expect(e.message).toContain('稍后重试')
      expect(e.cause).toBeInstanceOf(GatewayError)
    })
  })

  it('网络层失败（非 GatewayError）转 WEB_PROVIDER_ERROR', async () => {
    const client = stubClient(async () => { throw new TypeError('fetch failed') })
    const p = new GatewayWebFetchProvider(client)
    await expect(p.fetch({ url: 'https://e/' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('信号透传给 client', async () => {
    const client = stubClient(async (_req, signal) => {
      expect(signal?.aborted).toBe(false)
      return blankResult({ body: 'ok', encoding: 'text' })
    })
    const p = new GatewayWebFetchProvider(client)
    await p.fetch({ url: 'https://e/' }, new AbortController().signal)
    expect(client.webFetch.mock.calls[0]?.[1]).toBeInstanceOf(AbortSignal)
  })
})

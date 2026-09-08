import { describe, expect, it } from 'vitest'
import type { LookupAddress } from 'node:dns'

import {
  assertFakeIpCidrs,
  createFakeIpResolver,
  isPublicIpAddress,
  matchesCidr,
  resolveFakeIpAddresses,
} from '../src/resolver.ts'

/** 构造返回固定答案集、忽略 hostname 的测试解析器。 */
function answers(...addresses: LookupAddress[]): () => Promise<LookupAddress[]> {
  return async () => addresses
}

describe('isPublicIpAddress', () => {
  it('accepts public unicast and rejects private, loopback, link-local, mapped and garbage', () => {
    expect(isPublicIpAddress('8.8.8.8')).toBe(true)
    expect(isPublicIpAddress('2001:4860:4860::8888')).toBe(true)
    expect(isPublicIpAddress('[8.8.8.8]')).toBe(false) // 方括号只是 IPv6 形式,拼进 IPv4 即非法
    expect(isPublicIpAddress('127.0.0.1')).toBe(false)
    expect(isPublicIpAddress('10.0.0.1')).toBe(false)
    expect(isPublicIpAddress('169.254.1.1')).toBe(false)
    expect(isPublicIpAddress('172.16.0.1')).toBe(false)
    expect(isPublicIpAddress('198.18.0.2')).toBe(false) // RFC2544 基准段=fake-ip 池
    expect(isPublicIpAddress('fd00::1')).toBe(false)
    expect(isPublicIpAddress('::ffff:127.0.0.1')).toBe(false) // 按内嵌 IPv4 归类
    expect(isPublicIpAddress('not-an-ip')).toBe(false)
  })
})

describe('matchesCidr', () => {
  it('matches IPv4 prefixes at the boundary and rejects others', () => {
    expect(matchesCidr('198.18.0.2', '198.18.0.0/15')).toBe(true)
    expect(matchesCidr('198.19.255.254', '198.18.0.0/15')).toBe(true)
    expect(matchesCidr('198.20.0.1', '198.18.0.0/15')).toBe(false)
    expect(matchesCidr('8.8.8.8', '198.18.0.0/15')).toBe(false)
    expect(matchesCidr('8.8.8.8', '8.8.8.8/32')).toBe(true)
    expect(matchesCidr('8.8.8.7', '8.8.8.8/32')).toBe(false)
  })

  it('matches IPv6 prefixes and treats unparseable input as non-matching', () => {
    expect(matchesCidr('fd00:6152::1', 'fd00::/8')).toBe(true)
    expect(matchesCidr('fe80::1', 'fd00::/8')).toBe(false)
    expect(matchesCidr('2001:db8::1', '2001:db8::/32')).toBe(true)
    expect(matchesCidr('not-an-ip', '198.18.0.0/15')).toBe(false)
    expect(matchesCidr('8.8.8.8', '::/0')).toBe(false) // 地址与 CIDR 族不匹配
  })
})

describe('assertFakeIpCidrs', () => {
  it('accepts well-formed CIDRs and throws on a typo', () => {
    expect(() => assertFakeIpCidrs(['198.18.0.0/15', 'fd00::/8'])).not.toThrow()
    expect(() => assertFakeIpCidrs(['198.18.0.0/15', 'not-a-cidr'])).toThrow(/not a valid CIDR/)
  })
})

describe('resolveFakeIpAddresses', () => {
  const signal = new AbortController().signal

  it('accepts a pure public answer set unchanged', async () => {
    const result = await resolveFakeIpAddresses('example.com', signal, ['198.18.0.0/15'], answers(
      { address: '93.184.216.34', family: 4 },
    ))
    expect(result).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('accepts fake-ip answers inside the configured allowlist', async () => {
    const result = await resolveFakeIpAddresses('pi.dev', signal, ['198.18.0.0/15'], answers(
      { address: '198.18.0.2', family: 4 },
    ))
    expect(result).toEqual([{ address: '198.18.0.2', family: 4 }])
  })

  it('accepts IPv6 fake-ip ULA answers inside fd00::/8', async () => {
    const result = await resolveFakeIpAddresses('pi.dev', signal, ['fd00::/8'], answers(
      { address: 'fd00:6152::1', family: 6 },
    ))
    expect(result).toEqual([{ address: 'fd00:6152::1', family: 6 }])
  })

  it('rejects a private answer even with an allowlist configured', async () => {
    await expect(resolveFakeIpAddresses('internal.example', signal, ['198.18.0.0/15'], answers(
      { address: '10.0.0.1', family: 4 },
    ))).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })

  it('accepts a mixed public + fake-ip answer set entirely inside the allowance', async () => {
    const result = await resolveFakeIpAddresses('pi.dev', signal, ['198.18.0.0/15'], answers(
      { address: '93.184.216.34', family: 4 },
      { address: '198.18.0.2', family: 4 },
    ))
    expect(result).toHaveLength(2)
  })

  it('rejects the whole set when any answer is neither public nor allowlisted', async () => {
    await expect(resolveFakeIpAddresses('pi.dev', signal, ['198.18.0.0/15'], answers(
      { address: '198.18.0.2', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ))).rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })

  it('accepts a public IP literal and rejects a non-public one even inside the allowlist', async () => {
    expect(await resolveFakeIpAddresses('93.184.216.34', signal, ['198.18.0.0/15'], answers())).toEqual([
      { address: '93.184.216.34', family: 4 },
    ])
    await expect(resolveFakeIpAddresses('198.18.0.2', signal, ['198.18.0.0/15'], answers()))
      .rejects.toMatchObject({ code: 'WEB_BLOCKED_URL' })
  })

  it('rejects an empty answer set and an invalid address family', async () => {
    await expect(resolveFakeIpAddresses('example.com', signal, ['198.18.0.0/15'], answers()))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
    await expect(resolveFakeIpAddresses('example.com', signal, ['198.18.0.0/15'], answers(
      { address: '1000', family: 4 },
    ))).rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR' })
  })

  it('surfaces an already-aborted signal instead of resolving', async () => {
    const aborted = new AbortController()
    aborted.abort()
    await expect(resolveFakeIpAddresses('example.com', aborted.signal, ['198.18.0.0/15'], answers(
      { address: '93.184.216.34', family: 4 },
    ))).rejects.toThrow(/aborted during hostname resolution/)
  })

  it('createFakeIpResolver wires the allowlist through and validates it at construction', async () => {
    const resolver = createFakeIpResolver({
      allowedCidrs: ['198.18.0.0/15'],
      dns: answers({ address: '198.18.0.2', family: 4 }),
    })
    expect(await resolver('pi.dev', signal)).toEqual([{ address: '198.18.0.2', family: 4 }])
    expect(() => createFakeIpResolver({ allowedCidrs: ['bad'], dns: answers() })).toThrow(/not a valid CIDR/)
  })
})

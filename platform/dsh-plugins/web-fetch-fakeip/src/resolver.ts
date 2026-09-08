/**
 * fake-ip 代理下的地址预检替代实现。
 *
 * TCP 级 fake-ip 代理（Surge 增强模式、Clash/mihomo TUN、sing-box）劫持系统 DNS,
 * 把每个域名都应答成保留池地址（如 198.18.0.0/15、fd00::/8）。上游
 * `resolvePublicAddresses` 拒绝任何非公网单播应答,于是这些机器上 web_fetch 全域
 * 失败,尽管代理会把到 fake-ip 的连接映射回原始域名。本模块是官方公开替换点
 * （`HttpFetchProvider` 构造函数第二个参数）的实现:所有被拒地址保持被拒,除非
 * 落入操作者配置的 CIDR 放行集合。
 *
 * 有两处按上游语义收窄,不放宽:
 * - IP 字面量仍严格按公网判定——fake-ip 应答只来自 DNS,字面量地址是声明的,
 *   代理并不会把它映射回某个域名;
 * - NAT64/转译前缀发现未镜像——DNS64 与 fake-ip TUN 组合并非受支持形态,转译后的
 *   内嵌 IPv4 也没有可钉住的传输。
 *
 * @module @lumo/web-fetch-fakeip/resolver
 */

import { lookup as systemLookup } from 'node:dns/promises'
import type { LookupAddress } from 'node:dns'
import { isIP } from 'node:net'

import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** 官方 `AddressResolver` 的同形签名,便于测试注入确定答案。 */
export type DnsLookup = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>

/** 钉住连接用的地址集;与上游 `PublicAddress` 结构一致。 */
export interface ValidatedAddress {
  readonly address: string
  readonly family: 4 | 6
}

/**
 * 一个地址是否为全局可达单播。语义拷贝上游 `web-fetch-http/src/network.ts` 的
 * `isPublicIpAddress`（IPv4-mapped IPv6 按内嵌 IPv4 归类;实现保持同步）。
 *
 * @param input - 文本 IPv4 或 IPv6 地址（可带方括号）。
 * @returns 仅公网单播为 true。
 */
export function isPublicIpAddress(input: string): boolean {
  // 上游同函数不剥离方括号：调用方只传脱壳地址，带括号即解析失败被拒绝。
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(input)
  } catch {
    return false
  }
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'unicast'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'unicast'
  return parsed.range() === 'unicast'
}

/**
 * 一个文本地址是否落在放行 CIDR 内。无法解析的输入一律不匹配（保守拒绝）。
 *
 * @param input - 要判定的地址。
 * @param cidr - `a.b.c.d/len` 或 IPv6 CIDR。
 * @returns 命中为 true,否则 false。
 */
export function matchesCidr(input: string, cidr: string): boolean {
  try {
    const address = ipaddr.parse(stripIpv6Brackets(input))
    const network = ipaddr.parseCIDR(cidr.trim())
    return address.match(network)
  } catch {
    return false
  }
}

/** 配置预校验:每个放行项都必须是合法 CIDR,拼写错误在启动期失败发声。 */
export function assertFakeIpCidrs(cidrs: readonly string[]): void {
  for (const cidr of cidrs) {
    try {
      ipaddr.parseCIDR(cidr.trim())
    } catch {
      throw new Error(`lumo-web-fetch-fakeip: fakeIpCidrs entry "${cidr}" is not a valid CIDR`)
    }
  }
}

/**
 * 构造 fake-ip 感知的地址预检函数,返回给上游 `HttpFetchProvider` 作 resolver。
 *
 * @param options - 放行 CIDR 集合;测试可注入确定 DNS 应答。
 * @returns 每次调用返回验证过的地址集,存在任何非公网且非放行的地址即
 *   `WEB_BLOCKED_URL`,回答为空则 `WEB_PROVIDER_ERROR`。
 */
export function createFakeIpResolver(options: { allowedCidrs: readonly string[]; dns?: DnsLookup }): (
  hostname: string,
  signal: AbortSignal,
) => Promise<ValidatedAddress[]> {
  const dns = options.dns ?? systemLookup
  assertFakeIpCidrs(options.allowedCidrs)
  return (hostname, signal) => resolveFakeIpAddresses(hostname, signal, options.allowedCidrs, dns)
}

/**
 * 一次地址预检的完整流程,供 resolver 使用。
 *
 * 一个回答与上游同判:全部面向外部,ANY 一个地址既非公网单播也不在放行集即整体
 * 拒绝,地址本身按其原始文本钉住连接（代理的 fake-ip 映射按域名,不按地址解析,
 * 故这里不重解析域名）。字面量路径与上游一致,严格公网判定。
 *
 * @param hostname - URL hostname,IPv6 字面量可带方括号。
 * @param signal - 中止等待;一次已开始的 OS 查询可能做完再被丢弃。
 * @param allowedCidrs - 放行的 CIDR 集合（fake-ip 池）。
 * @param dns - 解析实现,测试注入。默认系统查询。
 * @returns 验证且非空的地址集。
 */
export async function resolveFakeIpAddresses(
  hostname: string,
  signal: AbortSignal,
  allowedCidrs: readonly string[],
  dns: DnsLookup = systemLookup,
): Promise<ValidatedAddress[]> {
  const unbracketed = stripIpv6Brackets(hostname)
  const literalFamily = isIP(unbracketed)
  const resolved = literalFamily === 0
    ? await raceWithSignal(dns(unbracketed, { all: true, order: 'verbatim' }), signal)
    : [{ address: unbracketed, family: literalFamily }]

  if (resolved.length === 0) {
    throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }

  const validated: ValidatedAddress[] = []
  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    const publicUnicast = isPublicIpAddress(entry.address)
    const allowlisted = literalFamily === 0 && allowedCidrs.some(cidr => matchesCidr(entry.address, cidr))
    if (!publicUnicast && !allowlisted) {
      throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
    }
    validated.push({ address: entry.address, family: entry.family })
  }
  return validated
}

/** 一次不可取消的 OS 查询与信号竞速,不让等待拖住工具取消。 */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const abortError = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(abortError())
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(abortError()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}

/** WHATWG URL 保留 IPv6 字面量的方括号;IP 解析器不接受。 */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

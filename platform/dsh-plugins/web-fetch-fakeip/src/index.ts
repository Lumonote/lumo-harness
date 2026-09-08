/**
 * @lumo/web-fetch-fakeip —— fake-ip 代理下 web_fetch 的桌面端自动修复。
 *
 * TCP 级 fake-ip 代理（Surge 增强模式/VIF、Clash/mihomo TUN、sing-box）把系统 DNS
 * 应答劫持进保留池（198.18.0.0/15、fd00::/8），上游 web-fetch-http 的 SSRF 公网
 * 预检因此在连接前拒绝一切域名。本插件复用上游公开类 `HttpFetchProvider` —— 其
 * 第二个构造参数就是官方公开的 resolver 扩展点 —— 只替换地址预检：公网单播之外,
 * 允许一个可配置的 CIDR 放行集合（默认覆盖 Surge/Clash 与 sing-box 的 fake-ip 池）。
 *
 * 注册 id `lumo-fetch-fakeip`;dsh-node 在打包桌面（local + web profile）时通过
 * 官方 patch 把官方 `web` 条目的 `fetchProvider` 钉到该 id。全部走官方扩展点
 * （公开 API + cordis.patch.yml overlay）,零 dsh 源码修改,升级自带即生效。
 *
 * 与出站代理机制的关系:本插件只影响要求公网预检的直连路径;若用户按
 * docs/configuration.md 配置了 HTTP(S) 出站代理,上游 proxied 分支仍然优先。
 */

import z from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { DEFAULT_USER_AGENT, HttpFetchProvider } from '@deepseek-ai/dsh-web-fetch-http'
import type { HttpFetchLimits } from '@deepseek-ai/dsh-web-fetch-http'
import { assertFakeIpCidrs, createFakeIpResolver } from './resolver.ts'

/** Cordis 插件名（loader 诊断用）。 */
export const name = 'lumo-web-fetch-fakeip'

/** 向官方 web seam 注册自己的 fetch 提供者。 */
export const inject = ['web']

/** 注册 id;官方 `web` 条目把 fetchProvider 钉到这里。 */
export const FAKE_IP_PROVIDER_ID = 'lumo-fetch-fakeip'

/** 默认放行的 fake-ip 池:198.18.0.0/15 覆盖 Surge/Clash 默认段,fd00::/8 覆盖 sing-box ULA 段。 */
export const DEFAULT_FAKE_IP_CIDRS = ['198.18.0.0/15', 'fd00::/8'] as const

/** 插件配置:放行 CIDR 集合 + 与上游 web-fetch-http 相同的五个传输/限额字段。 */
export interface Config {
  /** 除公网单播外额外放行的 CIDR（编入 fake-ip 池的保留段）。 */
  fakeIpCidrs?: string[]
  /** 最大响应体字节数。 */
  maxResponseBytes?: number
  /** 解码后最大字符数。 */
  maxBodyChars?: number
  /** 默认抓取超时,毫秒。 */
  timeoutMs?: number
  /** 同源重定向最大跳数。 */
  maxRedirects?: number
  /** 每个请求携带的 `User-Agent`。 */
  userAgent?: string
}

export const Config: z<Config> = z.object({
  fakeIpCidrs: z.array(z.string()).default([...DEFAULT_FAKE_IP_CIDRS]),
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
})

/** schemastery 已套默认值后的完整配置。 */
type ResolvedConfig = Required<Config>

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

/**
 * 官方 `HttpFetchProvider` 的薄包装:只换注册 id 与选择权,传输、限额、重定向、
 * 解码与内容分类全部由官方实现完成。保持 seam 的 host 可空性语言（`available()`）
 * 与本提供者一致。
 */
export class FakeIpFetchProvider implements WebFetchProvider {
  readonly id = FAKE_IP_PROVIDER_ID

  constructor(
    private readonly inner: WebFetchProvider,
  ) {}

  available(): boolean {
    return this.inner.available()
  }

  fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    return this.inner.fetch(request, signal)
  }
}

/** 资源限额必为正有限数。 */
function assertPositiveFinite(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`web-fetch-fakeip: ${name} must be a positive finite number`)
  }
}

/** Node 会把超过上限的定时器延迟压成 1 ms,配置期直接拒绝。 */
function assertTimeoutMs(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`web-fetch-fakeip: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** 重定向跳数必须是非负整数（0 表示不跟随）。 */
function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`web-fetch-fakeip: ${name} must be a non-negative integer`)
  }
}

/** 注册 fake-ip 感知的提供者到 `ctx.web`。 */
export function apply(ctx: Context, config: Config): void {
  // 加载器已用 schemastery (Config) 填好每个默认字段。
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeoutMs(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  assertFakeIpCidrs(resolved.fakeIpCidrs)

  const limits: HttpFetchLimits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
  }
  const resolver = createFakeIpResolver({ allowedCidrs: resolved.fakeIpCidrs })
  const provider = new HttpFetchProvider(limits, resolver)
  ctx.web.registerFetchProvider(new FakeIpFetchProvider(provider))
}

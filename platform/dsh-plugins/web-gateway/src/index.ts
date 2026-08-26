/**
 * @lumo/web-gateway —— ctx.web 的网关化 fetch Provider（seam 远程形态 §1 第 8 行）。
 *
 * 出流量默认经连接器网关：PII 脱敏、egress 黑名单、配额、审计、计量（connector.call）
 * 全在网关闸门链完成；本插件只是把它包成一个 dsh WebFetchProvider 注册进 ctx.web。
 *
 * 为什么单机直连不是选项：dsh 自带的 web-fetch-http 从节点直连公网，绕开了网关的
 * 全部治理——「绕开网关」是治理漏洞不是性能选择（§1 第 8 行）。
 *
 * 装配：以 `web.fetchProvider: lumo-gateway`（或 dsh 官方的机制等效值
 * `DSH_WEB_FETCH_PROVIDER=lumo-gateway`）选中本 provider——headless profile 默认
 * 还装着 web-fetch-http，不选会出现多个可用 provider 的歧义。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'

import {
  ConnectorClient,
  GatewayError,
  type InvokeResult,
} from '../../connector/src/client.ts'

export interface WebGatewayConfig {
  /** 连接器网关地址（Local-lite: http://localhost:58082 / compose standalone: :18082） */
  gatewayUrl: string
  /** 本节点身份（装配层固定；模型不可改——同 connector 插件） */
  realm: string
  userId: string
  roles: string[]
  projectId?: string
  /** 计量归因头（缺省由网关补 'unknown' 并告警；装配层应给全——归因不全的账是脏账） */
  deptId?: string
  agentId?: string
  componentId?: string
  feature?: string
  /** 单次取回超时（默认 30s；网关侧还有 30s 响应头超时，取两者较小） */
  timeoutMs?: number
  /** 解码后的字符上限（镜像 dsh web-fetch-http 的 maxBodyChars，默认 100k） */
  maxBodyChars?: number
}

/** Schemastery validation for {@link WebGatewayConfig} */
export const Config: z<WebGatewayConfig> = z.object({
  gatewayUrl: z.string(),
  realm: z.string(),
  userId: z.string(),
  roles: z.array(z.string()),
  projectId: z.string(),
  deptId: z.string(),
  agentId: z.string(),
  componentId: z.string(),
  feature: z.string(),
  timeoutMs: z.number(),
  maxBodyChars: z.number(),
})

/** ctx.web 的 fetch 服务须先挂载（provider 是注册进 seam 的消费者形态）。 */
export const inject = ['web']

export function apply(ctx: Context, config: WebGatewayConfig): void {
  const client = new ConnectorClient({ ...config })
  const provider = new GatewayWebFetchProvider(client, config.maxBodyChars)
  const dispose = ctx.web.registerFetchProvider(provider)
  ctx.effect(() => () => {
    dispose()
  })
}

/** 网关拒绝码 → dsh WebError 码的映射（语义一致者复用 dsh 码，平台特有的给 lumo.*）。 */
function mapGatewayCode(code: GatewayError['code']): string {
  switch (code) {
    case 'egress_denied':
      return 'lumo.egress_denied'
    case 'rate_limited':
      return 'lumo.rate_limited'
    case 'circuit_open':
      return 'lumo.circuit_upstream'
    case 'payload_too_large':
      // 与 dsh web-fetch-http 的「响应体超限」语义相同，复用它的码（消费方按体量限制处理）
      return 'WEB_FETCH_TOO_LARGE'
    default:
      // credential_error（web 无凭证理论上不出现）/upstream_error/internal_error → 通用 provider 故障
      return 'WEB_PROVIDER_ERROR'
  }
}

/**
 * 把网关结果映射成 dsh 的 WebFetchResult。
 *
 * 网关 body 按 encoding 三态交付（request.go encodeBody）：json=原始 JSON 值、
 * text=UTF-8 字符串、base64=base64 字符串。与 dsh 本地 provider 相同边界：
 * 非 2xx 是结果不是错误（状态码属于被取回资源的现状）。
 */
export function toFetchResult(result: InvokeResult, url: string, maxBodyChars: number): WebFetchResult {
  let content = ''
  const body = result.body
  if (body !== undefined && body !== null) {
    switch (result.encoding) {
      case 'base64':
        content = Buffer.from(String(body), 'base64').toString('utf8')
        break
      case 'json':
        // 上游 JSON 原值 → 序列化回模型可见文本（非 2xx 的错误 JSON 同样如此）
        content = typeof body === 'string' ? body : JSON.stringify(body)
        break
      default:
        content = typeof body === 'string' ? body : JSON.stringify(body)
    }
  }
  const truncated = content.length > maxBodyChars
  if (truncated) content = content.slice(0, maxBodyChars)
  const contentType = result.contentType ?? ''
  return {
    url,
    statusCode: result.status,
    body: { kind: /application\/xhtml\+xml|text\/html/i.test(contentType) ? 'html' : 'text', content },
    truncated,
  }
}

/**
 * 一个把出向 fetch 交给连接器网关的 WebFetchProvider。
 *
 * available() 恒真：配置即就绪（gatewayUrl 装配层给定，不在调用时探测——与
 * web-fetch-http 的「注册时必可用」姿态一致，缺网关是装配错误不是运行时降级）。
 */
export class GatewayWebFetchProvider implements WebFetchProvider {
  readonly id = 'lumo-gateway'
  private readonly client: Pick<ConnectorClient, 'webFetch'>
  private readonly maxBodyChars: number

  constructor(client: Pick<ConnectorClient, 'webFetch'>, maxBodyChars?: number) {
    this.client = client
    this.maxBodyChars = maxBodyChars ?? 100_000
  }

  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    let result: InvokeResult
    try {
      result = await this.client.webFetch({ url: request.url }, signal)
    } catch (error) {
      if (error instanceof GatewayError) {
        // 闸门拒绝是「这条路走不通」而非「网页不存在」：抛 WebError，让消费方按
        // 能力错误处理（限速/熔断可重试，策略拒绝不可）。
        throw new WebError(`连接器网关拒绝取回 ${request.url}：${error.message}`, mapGatewayCode(error.code), {
          cause: error,
        })
      }
      // 网络层失败（网关不可达等）：dsh 本地 provider 的 failure 语义
      throw new WebError(`网关取回失败 ${request.url}：${String(error)}`, 'WEB_PROVIDER_ERROR', {
        cause: error,
      })
    }
    return toFetchResult(result, request.url, this.maxBodyChars)
  }
}

export default apply

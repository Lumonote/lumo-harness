/**
 * 浏览器侧的 dsh Web carrier 会话交接。
 *
 * dsh Web 的 carrier（`client-connection` 的 browser-auth）对 `/` 与 `/api/*` 只认两样东西：
 * 进程启动时随机生成的 launch token（`?token=…`，一次性换签名 cookie），或那个签名 cookie
 * 本身。桌面壳拿到的是带 token 的入口 URL（`lumo-ui` 的 desktop-handoff 把
 * `connection.authenticatedUrl()` 写进壳指定的文件），所以桌面形态不需要这一层。
 *
 * 服务端形态没有那个壳：`@lumo/user-auth` 是唯一的对外面（carrier 绑定在 0 号端口、
 * OS 分配的回环端口上），它认证完浏览器之后直接把请求转给 carrier——于是浏览器拿到的是
 * 「dsh web authentication required」：**Lumo 的会话不是 carrier 的会话，而两者之间从来
 * 没有人做交换**。2026-09-20 实测（standalone，登录成功后）：`GET /` 与 `GET /api/config`
 * 是 401，而 `/lumo/api/*`（Lumo 插件自己的路由，认身份断言）200。
 *
 * 做法：进程内调 `connection.authenticatedUrl()` 取到带 token 的回环入口，由代理**服务端**
 * 走一遍它（carrier 回 303 + Set-Cookie），把那个 cookie 缓存下来、附在每个转发给 carrier
 * 的请求上。token 因此不进浏览器、不进 URL 历史；浏览器只跟 `@lumo/user-auth` 打交道。
 *
 * 这个 cookie 是「本进程的浏览器信任票」，不是用户身份：用户身份仍由代理的会话与身份断言
 * 判定，carrier 只认「这个请求来自被信任的浏览器」。所以一份 cookie 对本进程的所有已认证
 * 用户通用——carrier 是一台单租户本地进程，本来也没有「哪个用户」的概念。
 */

import { request as httpRequest } from 'node:http'

/** cookie 少了 Max-Age 时的兜底寿命：够短到能自愈，够长到不每请求都交换一次。 */
const FALLBACK_MAX_AGE_SECONDS = 30 * 60

export interface CarrierSessionOptions {
  /**
   * 带 launch token 的回环入口（`connection.authenticatedUrl()`）。
   * `connection` 服务未装配时返回 undefined——那种形态下没有 carrier 可交接。
   */
  authenticatedUrl: () => string | undefined
  logger: { warn: (format: string, ...args: readonly unknown[]) => void }
}

export class CarrierSession {
  private cookie: string | undefined
  private expiresAt = 0
  private inflight: Promise<string | undefined> | undefined

  constructor(private readonly options: CarrierSessionOptions) {}

  /**
   * 取当前可用的 carrier cookie（`name=value`）。
   *
   * 失败**不缓存**：拿不到就返回 undefined（本次转发不带 cookie，浏览器会看到 carrier 的
   * 401 页面），下一个请求再试一次——把一次瞬时失败钉死成「直到重启都不工作」更糟。
   * @returns carrier 的会话 cookie，或 undefined（尚未就绪/交换失败）。
   */
  async cookieHeader(): Promise<string | undefined> {
    if (this.cookie !== undefined && Date.now() < this.expiresAt) return this.cookie
    // 并发请求共用一次交换，避免每个首屏请求都去换一次 token。
    this.inflight ??= this.exchange().finally(() => { this.inflight = undefined })
    return this.inflight
  }

  /** carrier 回了 401（cookie 过期或被轮换）：丢掉缓存，下一次请求重新交换。 */
  invalidate(): void {
    this.cookie = undefined
    this.expiresAt = 0
  }

  private async exchange(): Promise<string | undefined> {
    let url: string | undefined
    try {
      url = this.options.authenticatedUrl()
    } catch (error: unknown) {
      // 取入口本身失败（服务未就绪等）只该让这一发不带 cookie；让它冒出去会把一条普通的
      // 页面请求变成 503，把「carrier 没交接」误报成「认证服务挂了」。
      this.options.logger.warn('lumo-user-auth: carrier launch URL unavailable: %s', error instanceof Error ? error.message : String(error))
      return undefined
    }
    if (url === undefined) return undefined

    const result = await new Promise<{ setCookie: string[]; status: number } | { error: Error }>((resolve) => {
      const request = httpRequest(url, { method: 'GET' }, (response) => {
        const setCookie = response.headers['set-cookie'] ?? []
        // 303 的正文是空的，但仍要读完才能释放这条连接。
        response.resume()
        response.on('end', () => resolve({ setCookie, status: response.statusCode ?? 0 }))
      })
      request.on('error', (error: Error) => resolve({ error }))
      request.end()
    })

    if ('error' in result) {
      this.options.logger.warn('lumo-user-auth: carrier session exchange failed: %s', result.error.message)
      return undefined
    }
    const raw = result.setCookie[0]
    if (raw === undefined) {
      this.options.logger.warn(
        'lumo-user-auth: carrier returned no session cookie on the launch exchange (status %d); '
        + 'the browser will get the carrier 401 page until this is fixed', result.status,
      )
      return undefined
    }
    const pair = raw.slice(0, raw.indexOf(';')).trim()
    const at = pair.indexOf('=')
    if (at <= 0) {
      this.options.logger.warn('lumo-user-auth: carrier session cookie is malformed: %j', raw)
      return undefined
    }
    this.cookie = pair
    this.expiresAt = Date.now() + maxAgeSeconds(raw) * 1000
    return this.cookie
  }
}

/** 从 Set-Cookie 文本里取 Max-Age；没有就用兜底寿命。 */
function maxAgeSeconds(raw: string): number {
  for (const attribute of raw.split(';').slice(1)) {
    const [name, value] = attribute.split('=', 2).map(part => part.trim())
    if (name?.toLowerCase() !== 'max-age') continue
    const seconds = Number(value)
    if (Number.isSafeInteger(seconds) && seconds > 0) return seconds
  }
  return FALLBACK_MAX_AGE_SECONDS
}

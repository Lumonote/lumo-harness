import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { CarrierSession } from '../src/carrier-session.ts'
import type { GovernanceAuthClient, Principal } from '../src/client.ts'
import { closeAuthProxy, createAuthProxy, listenAuthProxy } from '../src/proxy.ts'

/**
 * 浏览器侧的 carrier 会话交接（2026-09-20）。
 *
 * carrier 的 browser-auth 对 `/` 与 `/api/*` 只认 launch token 换来的签名 cookie；代理认证完
 * 浏览器之后如果不做交换，浏览器看到的就是那句「dsh web authentication required」。这里用一个
 * **假装自己是 carrier** 的回环服务把三件事钉住：没有交接时必须回 401（证明这条用例不是空转）、
 * 交接之后必须带上 cookie 并放行、以及 carrier 拒收缓存 cookie 时代理必须重换而不是一直拿旧的打。
 *
 * 真回环监听在沙箱 CI 上常被拒（bind(2)），所以与 sessions-proxy.spec.ts 同样按需开启：
 * `LUMO_AUTH_PROXY_TEST=1`。
 */
const describeProxy = process.env['LUMO_AUTH_PROXY_TEST'] === '1' ? describe : describe.skip

const LAUNCH_TOKEN = 'launch-token-from-connection'
const COOKIE_NAME = 'dsh-auth-test'
const UNAUTHORIZED_BODY = 'dsh web authentication required; reopen the URL printed by dsh web.\n'

const principal: Principal = {
  realm: 'dev', user_id: 'u1', username: 'palmer', display_name: 'Palmer', roles: ['operator'], session_expires_at: '2026-09-01T00:00:00Z',
}

interface FakeCarrier {
  port: number
  /** 交换次数：每次 `?token=` 命中就 +1，并铸一个新 cookie 值。 */
  exchanges: () => number
  /** carrier 侧实际收到的 cookie 头（只记放行的那些）。 */
  seen: () => string[]
  /** 轮换可接受的 cookie：模拟签名密钥换了一茬（旧 cookie 从此被拒）。 */
  rotate: () => void
}

describeProxy('carrier session handoff', () => {
  const servers: Server[] = []

  afterEach(async () => {
    for (const server of servers.splice(0)) await closeAuthProxy(server)
  })

  function listen(server: Server): Promise<number> {
    servers.push(server)
    return new Promise((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
    })
  }

  async function startCarrier(): Promise<FakeCarrier> {
    let exchanges = 0
    let accepted: string | undefined
    const seen: string[] = []
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.searchParams.get('token') === LAUNCH_TOKEN) {
        exchanges += 1
        accepted = `value-${String(exchanges)}`
        res.writeHead(303, {
          location: '/',
          'set-cookie': `${COOKIE_NAME}=${accepted}; Max-Age=3600; Path=/; HttpOnly; SameSite=Strict`,
        })
        res.end()
        return
      }
      const cookie = req.headers.cookie ?? ''
      if (accepted === undefined || !cookie.includes(`${COOKIE_NAME}=${accepted}`)) {
        res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(UNAUTHORIZED_BODY)
        return
      }
      seen.push(cookie)
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end('<html>dsh web</html>')
    })
    const port = await listen(server)
    return {
      port,
      exchanges: () => exchanges,
      seen: () => seen,
      rotate: () => { accepted = undefined },
    }
  }

  function carrierSessionFor(carrier: FakeCarrier): CarrierSession {
    return new CarrierSession({
      authenticatedUrl: () => `http://127.0.0.1:${String(carrier.port)}/?token=${LAUNCH_TOKEN}`,
      logger: { warn: () => {} },
    })
  }

  async function startProxy(upstreamPort: number, session?: CarrierSession, onRejected?: () => void): Promise<string> {
    const client = { session: vi.fn(async () => principal) } as unknown as GovernanceAuthClient
    const server = createAuthProxy({
      host: '127.0.0.1', port: 0, secureCookie: false, realm: 'dev',
      identityAssertionSecret: 'a'.repeat(32), upstreamPort,
      client,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      ...(session === undefined ? {} : { carrierCookie: () => session.cookieHeader() }),
      ...(onRejected === undefined ? {} : { carrierRejected: onRejected }),
    })
    return `http://127.0.0.1:${String(await listenAuthProxy(server, '127.0.0.1', 0))}`
  }

  const browserHeaders = { cookie: 'lumo_auth_session=token-current' }

  it('没有交接时浏览器看到 carrier 的 401 —— 这正是那条缺口的形状', async () => {
    const carrier = await startCarrier()
    const base = await startProxy(carrier.port)
    const response = await fetch(`${base}/`, { headers: browserHeaders })
    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe(UNAUTHORIZED_BODY)
    expect(carrier.exchanges()).toBe(0)
  })

  it('交接之后转发带上 carrier cookie、index 放行，且 cookie 被复用', async () => {
    const carrier = await startCarrier()
    const session = carrierSessionFor(carrier)
    const base = await startProxy(carrier.port, session)

    const first = await fetch(`${base}/`, { headers: browserHeaders })
    expect(first.status).toBe(200)
    await expect(first.text()).resolves.toContain('dsh web')

    const second = await fetch(`${base}/`, { headers: browserHeaders })
    expect(second.status).toBe(200)

    // cookie 有 Max-Age，所以两次浏览只换一次 token。
    expect(carrier.exchanges()).toBe(1)
    for (const cookie of carrier.seen()) expect(cookie).toContain(`${COOKIE_NAME}=value-1`)
    // 浏览器自己的 Lumo 会话 cookie 不该被转发给 carrier。
    for (const cookie of carrier.seen()) expect(cookie).not.toContain('lumo_auth_session')
  })

  it('取不到 carrier 入口时退化为「不带 cookie 转发」，不是 503', async () => {
    const carrier = await startCarrier()
    const session = new CarrierSession({
      authenticatedUrl: () => { throw new Error('connection 尚未就绪') },
      logger: { warn: () => {} },
    })
    const base = await startProxy(carrier.port, session)

    const response = await fetch(`${base}/`, { headers: browserHeaders })
    // 401 是 carrier 的页面（用户能看到原因）；503 会把一次交接失败误报成认证服务故障。
    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe(UNAUTHORIZED_BODY)
  })

  it('carrier 拒了缓存的 cookie 时：代理收到 401 即失效缓存，下一发重新交换', async () => {
    const carrier = await startCarrier()
    const session = carrierSessionFor(carrier)
    const rejected = vi.fn(() => { session.invalidate() })
    const base = await startProxy(carrier.port, session, rejected)

    expect((await fetch(`${base}/`, { headers: browserHeaders })).status).toBe(200)

    carrier.rotate() // 签名密钥换了一茬：手里那张 cookie 从此不认
    const stale = await fetch(`${base}/`, { headers: browserHeaders })
    expect(stale.status).toBe(401)
    expect(rejected).toHaveBeenCalledTimes(1)

    const recovered = await fetch(`${base}/`, { headers: browserHeaders })
    expect(recovered.status).toBe(200)
    expect(carrier.exchanges()).toBe(2)
    expect(carrier.seen().at(-1)).toContain(`${COOKIE_NAME}=value-2`)
  })
})

import { createHmac, randomBytes } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { GovernanceApiError, GovernanceAuthClient, type Principal } from './client.ts'
import { AUTHENTICATED_APP_HOME } from './app-home.ts'
import { loginPage, loginScript, resolveLoginTheme, type LoginPageOptions } from './html.ts'
import { CONNECTOR_OAUTH_CALLBACK, CONNECTOR_OAUTH_COOKIE, ConnectorOAuthClient, ConnectorOAuthError, connectorIDPattern, openConnectorBridge, sealConnectorBridge, type ConnectorOAuthStart } from './connector-oauth.ts'

const SESSION_COOKIE = 'lumo_auth_session'
export { AUTHENTICATED_APP_HOME } from './app-home.ts'
const CAPTCHA_COOKIE = 'lumo_auth_captcha'
const OIDC_COOKIE = 'lumo_auth_oidc'
const MAX_AUTH_BODY_BYTES = 16 * 1024
const SESSION_RECHECK_MS = 5_000
const SESSION_CACHE_MS = 15_000
const MAX_SESSION_CACHE = 2_048
const upgradedConnections = new WeakMap<Server, Set<Duplex>>()

export interface AuthProxyLogger {
  info(format: string, ...args: unknown[]): void
  warn(format: string, ...args: unknown[]): void
  error(format: string, ...args: unknown[]): void
}

export interface AuthProxyOptions {
  host: string
  port: number
  publicBaseUrl?: string
  secureCookie: boolean
  clusterMode?: boolean
  realm: string
  projectId?: string
  identityAssertionSecret: string
  upstreamPort: number
	client: GovernanceAuthClient
	connectorOAuth?: ConnectorOAuthClient
  logger: AuthProxyLogger
  /**
   * carrier 的浏览器会话 cookie（见 carrier-session.ts）。缺省时不做交接——那种装配下
   * 浏览器会直接看到 carrier 的 401 页面，正是本参数存在的原因。
   */
  carrierCookie?: () => Promise<string | undefined>
  /** carrier 回了 401：让提供者丢掉缓存的 cookie，下一次请求重新交换。 */
  carrierRejected?: () => void
}

function parseCookies(req: IncomingMessage): Map<string, string> {
  const values = new Map<string, string>()
  for (const item of (req.headers.cookie ?? '').split(';')) {
    const at = item.indexOf('=')
    if (at <= 0) continue
    try { values.set(item.slice(0, at).trim(), decodeURIComponent(item.slice(at + 1).trim())) } catch { /* malformed cookie is ignored */ }
  }
  return values
}

function authCookie(name: string, value: string, options: { secure: boolean; maxAge?: number; sameSite?: 'Strict' | 'Lax' }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', `SameSite=${options.sameSite ?? 'Strict'}`]
  if (options.secure) parts.push('Secure')
  if (options.maxAge !== undefined) parts.push(`Max-Age=${String(options.maxAge)}`)
  return parts.join('; ')
}

function stripAuthCookies(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const kept = value.split(';').map(item => item.trim()).filter(item => {
    const at = item.indexOf('=')
    const name = at < 0 ? item : item.slice(0, at)
    return name !== SESSION_COOKIE && name !== CAPTCHA_COOKIE && name !== OIDC_COOKIE && name !== CONNECTOR_OAUTH_COOKIE
  })
  return kept.length === 0 ? undefined : kept.join('; ')
}

function sourceIp(req: IncomingMessage): string {
  const value = req.socket.remoteAddress ?? 'unknown'
  return value.startsWith('::ffff:') ? value.slice(7) : value
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > MAX_AUTH_BODY_BYTES) throw new Error('auth request body exceeds 16 KiB')
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const contentType = (req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/x-www-form-urlencoded')) throw new Error('form content type required')
  return new URLSearchParams((await readBody(req)).toString('utf8'))
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const contentType = (req.headers['content-type'] ?? '').toLowerCase()
  if (!contentType.startsWith('application/json')) throw new Error('JSON content type required')
  const value: unknown = JSON.parse((await readBody(req)).toString('utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('JSON object required')
  return value as Record<string, unknown>
}

function writeHtml(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  res.end(body)
}

function writeJson(res: ServerResponse, status: number, body?: unknown, headers: Record<string, string | string[]> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body)
  res.writeHead(status, {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json; charset=utf-8' }),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(payload)
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', ...headers })
  res.end()
}

class SessionVerifier {
  private readonly pending = new Map<string, Promise<Principal | undefined>>()
  private readonly values = new Map<string, { value: Principal; expiresAt: number }>()

  constructor(private readonly client: GovernanceAuthClient, private readonly realm: string, private readonly cacheMs: number) {}

  async get(token: string | undefined): Promise<Principal | undefined> {
    if (token === undefined || token === '') return undefined
    const cached = this.values.get(token)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value
    const active = this.pending.get(token)
    if (active !== undefined) return active
    // Cluster sessions share only concurrent reads; standalone retains its cache.
    const request = this.client.session(token).then(principal => {
      if (principal.realm !== this.realm) return undefined
      this.set(token, principal)
      return principal
    }).catch((error: unknown) => {
      if (error instanceof GovernanceApiError && error.status === 401) return undefined
      throw error
    }).finally(() => { this.pending.delete(token) })
    this.pending.set(token, request)
    return request
  }

  set(token: string, principal: Principal): void {
    if (this.cacheMs <= 0 || principal.realm !== this.realm) return
    this.values.set(token, { value: principal, expiresAt: Date.now() + this.cacheMs })
    while (this.values.size > MAX_SESSION_CACHE) {
      const oldest = this.values.keys().next().value
      if (oldest === undefined) break
      this.values.delete(oldest)
    }
  }

  delete(token: string | undefined): void {
    if (token !== undefined) this.values.delete(token)
  }

  deleteUser(userID: string): void {
    for (const [token, cached] of this.values) {
      if (cached.value.user_id === userID) this.values.delete(token)
    }
  }
}

function principalIdentity(principal: Principal): string {
  return JSON.stringify([principal.realm, principal.user_id, principal.primary_dept_id ?? '', [...principal.roles].sort()])
}

function assertionHeaders(principal: Principal, options: AuthProxyOptions): Record<string, string> {
  const assertion = {
    aud: 'lumo-ui',
    exp: Math.floor(Date.now() / 1000) + 60,
    userId: principal.user_id,
    realm: principal.realm,
    roles: principal.roles,
    ...(options.projectId === undefined || options.projectId === '' ? {} : { projectId: options.projectId }),
    ...(principal.primary_dept_id === undefined || principal.primary_dept_id === '' ? {} : { deptId: principal.primary_dept_id }),
  }
  const encoded = Buffer.from(JSON.stringify(assertion), 'utf8').toString('base64url')
  const signature = createHmac('sha256', options.identityAssertionSecret).update(encoded, 'ascii').digest('base64url')
  return {
    'x-lumo-identity': encoded,
    'x-lumo-identity-signature': signature,
    'x-lumo-user': principal.user_id,
    'x-lumo-realm': principal.realm,
    'x-lumo-roles': principal.roles.join(','),
    ...(principal.primary_dept_id === undefined ? {} : { 'x-lumo-dept': principal.primary_dept_id }),
    ...(options.projectId === undefined ? {} : { 'x-lumo-project': options.projectId }),
  }
}

const SPOOFABLE_IDENTITY_HEADERS = [
  'x-lumo-identity', 'x-lumo-identity-signature', 'x-lumo-user', 'x-lumo-realm',
  'x-lumo-roles', 'x-lumo-role', 'x-lumo-dept', 'x-lumo-project', 'x-lumo-client-ip',
]

function upstreamHeaders(req: IncomingMessage, principal: Principal, options: AuthProxyOptions, upgrade: boolean, carrierCookie?: string): IncomingHttpHeaders {
  const authority = `127.0.0.1:${String(options.upstreamPort)}`
  const headers: IncomingHttpHeaders = { ...req.headers, host: authority }
  const remainingCookies = stripAuthCookies(req.headers.cookie)
  // 保留浏览器自带的非鉴权 cookie，再附上 carrier 的会话 cookie：carrier 的 browser-auth
  // 只认后者，而它由代理服务端持有（token 不进浏览器，见 carrier-session.ts）。
  const forwarded = [remainingCookies, carrierCookie].filter((value): value is string => value !== undefined && value !== '')
  if (forwarded.length === 0) delete headers.cookie
  else headers.cookie = forwarded.join('; ')
  for (const name of SPOOFABLE_IDENTITY_HEADERS) delete headers[name]
  // The public listener is the trust boundary. Never let a browser-supplied
  // bearer credential reach the loopback DSH listener, where it could be
  // interpreted as an internal control-plane or session credential.
  delete headers.authorization
  delete headers['proxy-authorization']
  delete headers['x-lumo-control-plane-token']
  delete headers['x-lumo-auth-request']
  delete headers['x-forwarded-for']
  delete headers['x-forwarded-host']
  delete headers['x-forwarded-proto']
  if (!upgrade) {
    delete headers.connection
    delete headers.upgrade
    delete headers['keep-alive']
    delete headers['proxy-connection']
  }
  Object.assign(headers, assertionHeaders(principal, options))
  headers['x-forwarded-for'] = sourceIp(req)
  if (headers.origin !== undefined) headers.origin = `http://${authority}`
  return headers
}

async function proxyHttp(req: IncomingMessage, res: ServerResponse, principal: Principal, options: AuthProxyOptions): Promise<void> {
  const carrierCookie = await options.carrierCookie?.()
  const upstream = httpRequest({
    agent: false,
    host: '127.0.0.1',
    port: options.upstreamPort,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, principal, options, false, carrierCookie),
  }, upstreamResponse => {
    // carrier 拒了我们的会话 cookie（过期/被轮换）——丢掉缓存，下一次请求重新交换。
    if (upstreamResponse.statusCode === 401 && carrierCookie !== undefined) options.carrierRejected?.()
    const headers = { ...upstreamResponse.headers }
    const setCookies = headers['set-cookie']
    if (setCookies !== undefined) {
      const filtered = setCookies.filter(cookie => {
        const name = cookie.slice(0, cookie.indexOf('=')).trim()
        return name !== SESSION_COOKIE && name !== CAPTCHA_COOKIE && name !== OIDC_COOKIE
      })
      if (filtered.length === 0) delete headers['set-cookie']
      else headers['set-cookie'] = filtered
    }
    res.writeHead(upstreamResponse.statusCode ?? 502, headers)
    upstreamResponse.pipe(res)
  })
  upstream.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('bad gateway')
  })
  req.pipe(upstream)
}

function rejectUpgrade(socket: Duplex, status = 401, message = 'Unauthorized'): void {
  socket.end(`HTTP/1.1 ${String(status)} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

async function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, principal: Principal, options: AuthProxyOptions, sockets: Set<Duplex>): Promise<void> {
  const carrierCookie = await options.carrierCookie?.()
  const upstream = httpRequest({
    agent: false,
    host: '127.0.0.1',
    port: options.upstreamPort,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, principal, options, true, carrierCookie),
  })
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    sockets.add(upstreamSocket)
    upstreamSocket.once('close', () => sockets.delete(upstreamSocket))
    const lines = [`HTTP/1.1 ${String(response.statusCode ?? 101)} ${response.statusMessage ?? 'Switching Protocols'}`]
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      lines.push(`${response.rawHeaders[index] ?? ''}: ${response.rawHeaders[index + 1] ?? ''}`)
    }
    socket.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head.length > 0) upstreamSocket.write(head)
    if (upstreamHead.length > 0) socket.write(upstreamHead)
    upstreamSocket.on('error', () => socket.destroy())
    socket.on('error', () => upstreamSocket.destroy())
    upstreamSocket.once('close', () => socket.destroy())
    socket.once('close', () => upstreamSocket.destroy())
    upstreamSocket.pipe(socket).pipe(upstreamSocket)
  })
  upstream.on('response', response => { response.resume(); rejectUpgrade(socket, response.statusCode ?? 502, 'Bad Gateway') })
  upstream.on('error', () => rejectUpgrade(socket, 502, 'Bad Gateway'))
  upstream.end()
}

function loginState(url: URL): LoginPageOptions['state'] {
  const state = url.searchParams.get('state')
  return state === 'invalid' || state === 'locked' || state === 'expired' || state === 'unavailable' || state === 'password-changed' || state === 'oidc-failed' ? state : undefined
}

function stringFields(body: Record<string, unknown>, fields: readonly string[]): Record<string, string> | undefined {
  const result: Record<string, string> = {}
  for (const field of fields) {
    if (typeof body[field] !== 'string') return undefined
    result[field] = body[field] as string
  }
  return result
}

function sessionCookie(result: { token: string; expires_at: string }, options: AuthProxyOptions): string {
  return authCookie(SESSION_COOKIE, result.token, {
    secure: options.secureCookie,
    maxAge: Math.max(1, Math.floor((Date.parse(result.expires_at) - Date.now()) / 1000)),
  })
}

function oidcRedirectMatches(redirectUrl: string | undefined, options: AuthProxyOptions, path = '/auth/oidc/callback'): boolean {
  if (!options.clusterMode || !options.publicBaseUrl || !redirectUrl) return false
  try {
    const base = new URL(options.publicBaseUrl)
    if (base.username || base.password || base.search || base.hash || base.pathname !== '/') return false
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname))) return false
    if (base.protocol === 'https:' && !options.secureCookie) return false
    return redirectUrl === new URL(path, base).href
  } catch { return false }
}

export function createAuthProxy(options: AuthProxyOptions): Server {
  const sessions = new SessionVerifier(options.client, options.realm, options.clusterMode ? 0 : SESSION_CACHE_MS)
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://lumo-auth.local')
      const requestCookies = parseCookies(req)
      const sessionToken = requestCookies.get(SESSION_COOKIE)

      if (req.method === 'GET' && url.pathname === '/auth/connector-oauth/complete.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' })
        res.end("location.replace(document.body.dataset.return || '/?lumo=connectors')")
        return
      }
      if (req.method === 'GET' && url.pathname === CONNECTOR_OAUTH_CALLBACK) {
        if (!options.clusterMode || !options.connectorOAuth) { writeJson(res, 404, { error: 'not_found' }); return }
        let connectorId = ''
        let outcome = 'failed'
        try {
          const bridge = openConnectorBridge(requestCookies.get(CONNECTOR_OAUTH_COOKIE) ?? '', options.identityAssertionSecret, options.realm, options.publicBaseUrl ?? '')
          connectorId = bridge.connectorId
          const state = url.searchParams.get('state') ?? ''
          if (!/^[A-Za-z0-9_-]{43}$/u.test(state) || ['state', 'code', 'error'].some(key => url.searchParams.getAll(key).length > 1)) throw new ConnectorOAuthError(400)
          // Always re-read Governance at callback time. Removed roles, revoked
          // sessions, and disabled users cannot complete an outstanding grant.
          const principal = await options.client.session(bridge.sessionToken)
          if (principal.realm !== options.realm || (sessionToken && sessionToken !== bridge.sessionToken)) throw new ConnectorOAuthError(401)
          await options.connectorOAuth.call(principal, bridge.sessionToken, bridge.connectorId, 'callback', {
            browser: bridge.browser, state, code: url.searchParams.get('code') ?? '', error: url.searchParams.get('error') ?? '',
          })
          outcome = 'connected'
        } catch { /* Provider responses and credentials are never reflected or logged. */ }
        res.setHeader('Set-Cookie', authCookie(CONNECTOR_OAUTH_COOKIE, '', { secure: options.secureCookie, maxAge: 0, sameSite: 'Lax' }))
        const destination = `/?lumo=connectors&amp;connector=${encodeURIComponent(connectorId)}&amp;oauth=${outcome}`
        writeHtml(res, 200, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>连接器授权</title><script src="/auth/connector-oauth/complete.js" defer></script></head><body data-return="${destination}"><a href="${destination}">返回连接器</a></body></html>`)
        return
      }

      if (req.method === 'GET' && url.pathname === '/auth/login.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' })
        res.end(loginScript)
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/login') {
        if (await sessions.get(sessionToken) !== undefined) { redirect(res, AUTHENTICATED_APP_HOME); return }
        let oidcEnabled = false
        if (options.clusterMode) {
          try {
            const oidc = await options.client.oidcStatus(options.realm)
            oidcEnabled = oidc.enabled && oidcRedirectMatches(oidc.redirect_url, options)
          } catch { /* Local credentials remain available during provider discovery failures. */ }
        }
        writeHtml(res, 200, loginPage({ ...(loginState(url) === undefined ? {} : { state: loginState(url)! }), theme: resolveLoginTheme(requestCookies.get('lumo-theme')), oidcEnabled }))
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/oidc/complete.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
        res.end(`location.replace(${JSON.stringify(AUTHENTICATED_APP_HOME)})`)
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/oidc/start') {
        if (!options.clusterMode) { writeJson(res, 404, { error: 'not_found' }); return }
        try {
          const browser = randomBytes(32).toString('base64url')
          const result = await options.client.beginOIDCLogin(options.realm, browser)
          if (!oidcRedirectMatches(result.redirect_url, options)) throw new Error('OIDC redirect configuration mismatch')
          redirect(res, result.authorization_url, { 'Set-Cookie': authCookie(OIDC_COOKIE, browser, { secure: options.secureCookie, maxAge: result.expires_in, sameSite: 'Lax' }) })
        } catch {
          redirect(res, '/auth/login?state=unavailable')
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/oidc/callback') {
        if (!options.clusterMode) { writeJson(res, 404, { error: 'not_found' }); return }
        const clearOIDC = authCookie(OIDC_COOKIE, '', { secure: options.secureCookie, maxAge: 0, sameSite: 'Lax' })
        try {
          const browser = requestCookies.get(OIDC_COOKIE) ?? ''
          const state = url.searchParams.get('state') ?? ''
          if (!/^[A-Za-z0-9_-]{43}$/u.test(browser) || !/^[A-Za-z0-9_-]{43}$/u.test(state)
            || ['state', 'code', 'iss', 'error'].some(key => url.searchParams.getAll(key).length > 1)) throw new Error('Invalid OIDC callback')
          const result = await options.client.completeOIDCLogin({
            realm: options.realm, browser, state, code: url.searchParams.get('code') ?? '',
            issuer: url.searchParams.get('iss') ?? '', error: url.searchParams.get('error') ?? '',
          }, sourceIp(req))
          if (result.principal.realm !== options.realm) throw new Error('OIDC realm mismatch')
          sessions.set(result.token, result.principal)
          res.setHeader('Set-Cookie', [sessionCookie(result, options), clearOIDC])
          // Commit a same-origin document before navigating with the Strict session cookie.
          writeHtml(res, 200, `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>登录中</title><script src="/auth/oidc/complete.js" defer></script></head><body><a href="${AUTHENTICATED_APP_HOME}">进入 Lumo</a></body></html>`)
        } catch (error) {
          const state = error instanceof GovernanceApiError && error.status >= 500 ? 'unavailable' : 'oidc-failed'
          redirect(res, `/auth/login?state=${state}`, { 'Set-Cookie': clearOIDC })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/captcha') {
        const challenge = await options.client.captcha()
        writeJson(res, 200, {
          id: challenge.id,
          prompt: challenge.prompt,
          expires_in: challenge.expiresIn,
          image: challenge.imageBase64,
        }, {
          'Set-Cookie': authCookie(CAPTCHA_COOKIE, challenge.id, { secure: options.secureCookie, maxAge: challenge.expiresIn }),
        })
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/login') {
        let form: URLSearchParams
        try {
          form = await readForm(req)
        } catch {
          writeJson(res, 400, { error: 'invalid_login_request', message: '登录请求格式无效' })
          return
        }
        try {
          const result = await options.client.login({
            realm: options.realm,
            username: form.get('username') ?? '',
            password: form.get('password') ?? '',
            captchaId: requestCookies.get(CAPTCHA_COOKIE) ?? '',
            captchaCode: form.get('captcha') ?? '',
            clientIp: sourceIp(req),
			mfaCode: form.get('mfa') ?? '',
          })
          sessions.set(result.token, result.principal)
          redirect(res, AUTHENTICATED_APP_HOME, { 'Set-Cookie': [
            authCookie(SESSION_COOKIE, result.token, { secure: options.secureCookie, maxAge: Math.max(1, Math.floor((Date.parse(result.expires_at) - Date.now()) / 1000)) }),
            authCookie(CAPTCHA_COOKIE, '', { secure: options.secureCookie, maxAge: 0 }),
          ] })
        } catch (error) {
          const state = error instanceof GovernanceApiError && error.status === 429 ? 'locked'
            : error instanceof GovernanceApiError && error.status >= 500 ? 'unavailable' : 'invalid'
          redirect(res, `/auth/login?state=${state}`, {
            ...(error instanceof GovernanceApiError && error.retryAfter > 0 ? { 'Retry-After': String(error.retryAfter) } : {}),
            'Set-Cookie': authCookie(CAPTCHA_COOKIE, '', { secure: options.secureCookie, maxAge: 0 }),
          })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/passkey/login/options') {
        let body: Record<string, unknown>
        try { body = await readJson(req) } catch { writeJson(res, 400, { error: 'invalid_passkey_request' }); return }
        const values = stringFields(body, ['username', 'captcha_code'])
        if (values === undefined) { writeJson(res, 422, { error: 'invalid_passkey_request' }); return }
        try {
          writeJson(res, 200, { public_key: await options.client.beginPasskeyLogin({
            realm: options.realm, username: values['username']!, captchaId: requestCookies.get(CAPTCHA_COOKIE) ?? '', captchaCode: values['captcha_code']!, clientIp: sourceIp(req),
          }) }, { 'Set-Cookie': authCookie(CAPTCHA_COOKIE, '', { secure: options.secureCookie, maxAge: 0 }) })
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message }, {
            ...(error.retryAfter > 0 ? { 'Retry-After': String(error.retryAfter) } : {}),
            'Set-Cookie': authCookie(CAPTCHA_COOKIE, '', { secure: options.secureCookie, maxAge: 0 }),
          })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/passkey/login') {
        let body: Record<string, unknown>
        try { body = await readJson(req) } catch { writeJson(res, 400, { error: 'invalid_passkey_request' }); return }
        const values = stringFields(body, ['challenge', 'id', 'raw_id', 'type', 'client_data_json', 'authenticator_data', 'signature'])
        if (values === undefined) { writeJson(res, 422, { error: 'invalid_passkey_request' }); return }
        try {
          const result = await options.client.completePasskeyLogin(values, sourceIp(req))
          sessions.set(result.token, result.principal)
          writeJson(res, 200, { authenticated: true }, { 'Set-Cookie': sessionCookie(result, options) })
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }

      const principal = await sessions.get(sessionToken)
      if (principal === undefined) {
        if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) redirect(res, '/auth/login?state=expired')
        else writeJson(res, 401, { error: 'authentication_required', message: '请先登录' })
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/connector-oauth/start') {
        if (!options.clusterMode || !options.connectorOAuth) { writeJson(res, 404, { error: 'not_found' }); return }
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        try {
          const body = await readJson(req)
          if (typeof body['connectorId'] !== 'string' || !connectorIDPattern.test(body['connectorId'])) throw new ConnectorOAuthError(400)
          const callback = new URL(CONNECTOR_OAUTH_CALLBACK, options.publicBaseUrl).href
          if (!oidcRedirectMatches(callback, options, CONNECTOR_OAUTH_CALLBACK)) throw new ConnectorOAuthError(503)
          const browser = randomBytes(32).toString('base64url')
          const result = await options.connectorOAuth.call<ConnectorOAuthStart>(principal, sessionToken ?? '', body['connectorId'], 'start', { browser })
          if (!oidcRedirectMatches(result.callbackUrl, options, CONNECTOR_OAUTH_CALLBACK) || result.expiresIn !== 300) throw new ConnectorOAuthError(503)
          const authorization = new URL(result.authorizationUrl)
          if (authorization.protocol !== 'https:' || authorization.username || authorization.password) throw new ConnectorOAuthError(503)
          const bridge = sealConnectorBridge({ connectorId: body['connectorId'], browser, sessionToken: sessionToken ?? '', expiresAt: Date.now() + 300_000 }, options.identityAssertionSecret, options.realm, options.publicBaseUrl ?? '')
          writeJson(res, 200, { authorizationUrl: result.authorizationUrl }, { 'Set-Cookie': authCookie(CONNECTOR_OAUTH_COOKIE, bridge, { secure: options.secureCookie, maxAge: 300, sameSite: 'Lax' }) })
        } catch (error) { writeJson(res, error instanceof ConnectorOAuthError ? error.status : 503, { error: 'connector_oauth_failed', message: '连接器授权暂不可用，请检查配置及管理员权限' }) }
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/account') {
        writeJson(res, 200, {
          mode: 'session', provider: 'lumo-governance', username: principal.username,
          displayName: principal.display_name, userId: principal.user_id, realm: principal.realm,
          roles: principal.roles, department: principal.primary_dept_id ?? '', clientIp: sourceIp(req),
          captchaMode: principal.auth_method === 'oidc' ? 'identity-provider' : 'always',
          authMethod: principal.auth_method ?? 'local', localAuthEnabled: principal.local_auth_enabled !== false,
        })
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/account/sessions') {
        try {
          writeJson(res, 200, { sessions: await options.client.sessions(sessionToken ?? '') })
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/account/security-events') {
        try {
          writeJson(res, 200, { events: await options.client.securityEvents(sessionToken ?? '') })
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/account/mfa') {
        try {
          writeJson(res, 200, await options.client.mfaStatus(sessionToken ?? ''))
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/account/passkeys') {
        try { writeJson(res, 200, await options.client.passkeys(sessionToken ?? '')) } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/account/passkeys/register/options') {
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        try { writeJson(res, 200, { public_key: await options.client.beginPasskeyRegistration(sessionToken ?? '') }) } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/account/passkeys/register') {
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        let body: Record<string, unknown>
        try { body = await readJson(req) } catch { writeJson(res, 400, { error: 'invalid_passkey_request' }); return }
        const values = stringFields(body, ['challenge', 'id', 'raw_id', 'type', 'client_data_json', 'attestation_object', 'label'])
        if (values === undefined) { writeJson(res, 422, { error: 'invalid_passkey_request' }); return }
        try { writeJson(res, 201, await options.client.completePasskeyRegistration(sessionToken ?? '', values)) } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      const passkeyMatch = url.pathname.match(/^\/auth\/account\/passkeys\/([^/]+)$/u)
      if (req.method === 'DELETE' && passkeyMatch !== null) {
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        let credentialID: string
        try { credentialID = decodeURIComponent(passkeyMatch[1]!) } catch { writeJson(res, 400, { error: 'invalid_passkey_id' }); return }
        if (!/^[A-Za-z0-9_-]{16,2048}$/u.test(credentialID)) { writeJson(res, 400, { error: 'invalid_passkey_id' }); return }
        try { await options.client.deletePasskey(sessionToken ?? '', credentialID); writeJson(res, 204) } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/account/mfa/enroll') {
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        try {
          writeJson(res, 201, await options.client.beginTOTPEnrollment(sessionToken ?? ''))
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      if ((req.method === 'POST' && url.pathname === '/auth/account/mfa/confirm') || (req.method === 'DELETE' && url.pathname === '/auth/account/mfa')) {
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        let body: Record<string, unknown>
        try { body = await readJson(req) } catch { writeJson(res, 400, { error: 'invalid_mfa_request' }); return }
        if (typeof body['code'] !== 'string') { writeJson(res, 422, { error: 'invalid_mfa_request' }); return }
        try {
          if (req.method === 'POST') writeJson(res, 200, await options.client.confirmTOTPEnrollment(sessionToken ?? '', body['code']))
          else { await options.client.disableTOTP(sessionToken ?? '', body['code']); writeJson(res, 204) }
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      const sessionMatch = url.pathname.match(/^\/auth\/account\/sessions\/([^/]+)$/u)
      if (req.method === 'DELETE' && sessionMatch !== null) {
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        let sessionID: string
        try { sessionID = decodeURIComponent(sessionMatch[1]!) } catch { writeJson(res, 400, { error: 'invalid_session_id' }); return }
        if (!/^[A-Za-z0-9._-]{1,128}$/u.test(sessionID)) { writeJson(res, 400, { error: 'invalid_session_id' }); return }
        try {
          const current = (await options.client.sessions(sessionToken ?? '')).find(session => session.id === sessionID)?.current ?? false
          await options.client.revokeSession(sessionToken ?? '', sessionID)
          if (current) {
            sessions.delete(sessionToken)
            writeJson(res, 204, undefined, { 'Set-Cookie': authCookie(SESSION_COOKIE, '', { secure: options.secureCookie, maxAge: 0 }) })
            return
          }
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
          return
        }
        writeJson(res, 204)
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/account/sessions/revoke-others') {
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        try {
          writeJson(res, 200, { revoked: await options.client.revokeOtherSessions(sessionToken ?? '') })
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
        }
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/logout') {
        await options.client.logout(sessionToken ?? '')
        sessions.delete(sessionToken)
        const clear = authCookie(SESSION_COOKIE, '', { secure: options.secureCookie, maxAge: 0 })
        if (req.headers['x-lumo-auth-request'] === '1') writeJson(res, 204, undefined, { 'Set-Cookie': clear })
        else redirect(res, '/auth/login', { 'Set-Cookie': clear })
        return
      }
      if (req.method === 'POST' && url.pathname === '/auth/account/password') {
        if (req.headers['x-lumo-auth-request'] !== '1') { writeJson(res, 403, { error: 'auth_request_header_required' }); return }
        let body: Record<string, unknown>
        try {
          body = await readJson(req)
        } catch {
          writeJson(res, 400, { error: 'invalid_password_request' })
          return
        }
        if (typeof body['currentPassword'] !== 'string' || typeof body['newPassword'] !== 'string') {
          writeJson(res, 422, { error: 'invalid_password_request' }); return
        }
        try {
          await options.client.changePassword(sessionToken ?? '', body['currentPassword'], body['newPassword'])
        } catch (error) {
          if (!(error instanceof GovernanceApiError)) throw error
          writeJson(res, error.status, { error: error.code, message: error.message })
          return
        }
        sessions.deleteUser(principal.user_id)
        writeJson(res, 204, undefined, { 'Set-Cookie': authCookie(SESSION_COOKIE, '', { secure: options.secureCookie, maxAge: 0 }) })
        return
      }
      await proxyHttp(req, res, principal, options)
    })().catch((error: unknown) => {
      options.logger.warn('lumo-user-auth: request failed: %s', error)
      if (!res.headersSent) writeJson(res, 503, { error: 'auth_unavailable', message: '认证服务暂时不可用' })
      else res.end()
    })
  })

  const upgradedSockets = new Set<Duplex>()
  upgradedConnections.set(server, upgradedSockets)
  server.on('upgrade', (req, socket, head) => {
    upgradedSockets.add(socket)
    socket.once('close', () => upgradedSockets.delete(socket))
    void (async () => {
      const token = parseCookies(req).get(SESSION_COOKIE)
      const principal = await sessions.get(token)
      if (principal === undefined) { rejectUpgrade(socket); return }
      if (options.clusterMode) {
        const identity = principalIdentity(principal)
        let checking = false
        const timer = setInterval(() => {
          if (checking || socket.destroyed) return
          checking = true
          void sessions.get(token).then(current => {
            if (current === undefined || principalIdentity(current) !== identity) socket.destroy()
          }).catch(() => socket.destroy()).finally(() => { checking = false })
        }, SESSION_RECHECK_MS)
        timer.unref()
        socket.once('close', () => clearInterval(timer))
        if (socket.destroyed) { clearInterval(timer); return }
      }
      await proxyUpgrade(req, socket, head, principal, options, upgradedSockets)
    })().catch(() => rejectUpgrade(socket, 503, 'Service Unavailable'))
  })
  return server
}

export async function listenAuthProxy(server: Server, host: string, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => { server.off('error', reject); resolve() })
  })
  const address = server.address() as AddressInfo
  return address.port
}

export async function closeAuthProxy(server: Server): Promise<void> {
  for (const socket of upgradedConnections.get(server) ?? []) socket.destroy()
  server.closeAllConnections()
  if (!server.listening) return
  await new Promise<void>((resolve, reject) => {
    server.close(error => error === undefined ? resolve() : reject(error))
  })
}

import { createHmac } from 'node:crypto'
import { createServer, request as httpRequest, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { Duplex } from 'node:stream'

import { GovernanceApiError, GovernanceAuthClient, type Principal } from './client.ts'
import { loginPage, loginScript, resolveLoginTheme, type LoginPageOptions } from './html.ts'

const SESSION_COOKIE = 'lumo_auth_session'
const CAPTCHA_COOKIE = 'lumo_auth_captcha'
const MAX_AUTH_BODY_BYTES = 16 * 1024
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
  realm: string
  projectId?: string
  identityAssertionSecret: string
  upstreamPort: number
  client: GovernanceAuthClient
  logger: AuthProxyLogger
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

function authCookie(name: string, value: string, options: { secure: boolean; maxAge?: number }): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict']
  if (options.secure) parts.push('Secure')
  if (options.maxAge !== undefined) parts.push(`Max-Age=${String(options.maxAge)}`)
  return parts.join('; ')
}

function stripAuthCookies(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const kept = value.split(';').map(item => item.trim()).filter(item => {
    const at = item.indexOf('=')
    const name = at < 0 ? item : item.slice(0, at)
    return name !== SESSION_COOKIE && name !== CAPTCHA_COOKIE
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
  res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', ...headers })
  res.end()
}

class SessionCache {
  private readonly values = new Map<string, { value: Principal; expiresAt: number }>()
  private readonly pending = new Map<string, Promise<Principal | undefined>>()

  constructor(private readonly client: GovernanceAuthClient) {}

  async get(token: string | undefined): Promise<Principal | undefined> {
    if (token === undefined || token === '') return undefined
    const cached = this.values.get(token)
    if (cached !== undefined && cached.expiresAt > Date.now()) return cached.value
    const active = this.pending.get(token)
    if (active !== undefined) return active
    const request = this.client.session(token).then(principal => {
      this.values.set(token, { value: principal, expiresAt: Date.now() + SESSION_CACHE_MS })
      while (this.values.size > MAX_SESSION_CACHE) {
        const oldest = this.values.keys().next().value as string | undefined
        if (oldest === undefined) break
        this.values.delete(oldest)
      }
      return principal
    }).catch((error: unknown) => {
      if (error instanceof GovernanceApiError && error.status === 401) return undefined
      throw error
    }).finally(() => { this.pending.delete(token) })
    this.pending.set(token, request)
    return request
  }

  set(token: string, principal: Principal): void {
    this.values.set(token, { value: principal, expiresAt: Date.now() + SESSION_CACHE_MS })
  }

  delete(token: string | undefined): void {
    if (token !== undefined) this.values.delete(token)
  }

  deleteUser(userId: string): void {
    for (const [token, cached] of this.values) {
      if (cached.value.user_id === userId) this.values.delete(token)
    }
  }
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

function upstreamHeaders(req: IncomingMessage, principal: Principal, options: AuthProxyOptions, upgrade: boolean): IncomingHttpHeaders {
  const authority = `127.0.0.1:${String(options.upstreamPort)}`
  const headers: IncomingHttpHeaders = { ...req.headers, host: authority }
  const remainingCookies = stripAuthCookies(req.headers.cookie)
  if (remainingCookies === undefined) delete headers.cookie
  else headers.cookie = remainingCookies
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

function proxyHttp(req: IncomingMessage, res: ServerResponse, principal: Principal, options: AuthProxyOptions): void {
  const upstream = httpRequest({
    agent: false,
    host: '127.0.0.1',
    port: options.upstreamPort,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, principal, options, false),
  }, upstreamResponse => {
    const headers = { ...upstreamResponse.headers }
    const setCookies = headers['set-cookie']
    if (setCookies !== undefined) {
      const filtered = setCookies.filter(cookie => {
        const name = cookie.slice(0, cookie.indexOf('=')).trim()
        return name !== SESSION_COOKIE && name !== CAPTCHA_COOKIE
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

function proxyUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, principal: Principal, options: AuthProxyOptions, sockets: Set<Duplex>): void {
  const upstream = httpRequest({
    agent: false,
    host: '127.0.0.1',
    port: options.upstreamPort,
    method: req.method,
    path: req.url,
    headers: upstreamHeaders(req, principal, options, true),
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
  return state === 'invalid' || state === 'locked' || state === 'expired' || state === 'unavailable' || state === 'password-changed' ? state : undefined
}

export function createAuthProxy(options: AuthProxyOptions): Server {
  const sessions = new SessionCache(options.client)
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://lumo-auth.local')
      const requestCookies = parseCookies(req)
      const sessionToken = requestCookies.get(SESSION_COOKIE)

      if (req.method === 'GET' && url.pathname === '/auth/login.js') {
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'", 'X-Content-Type-Options': 'nosniff' })
        res.end(loginScript)
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/login') {
        if (await sessions.get(sessionToken) !== undefined) { redirect(res, '/'); return }
        writeHtml(res, 200, loginPage({ ...(loginState(url) === undefined ? {} : { state: loginState(url)! }), theme: resolveLoginTheme(requestCookies.get('lumo-theme')) }))
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
          })
          sessions.set(result.token, result.principal)
          redirect(res, '/', { 'Set-Cookie': [
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

      const principal = await sessions.get(sessionToken)
      if (principal === undefined) {
        if (req.method === 'GET' && (req.headers.accept ?? '').includes('text/html')) redirect(res, '/auth/login?state=expired')
        else writeJson(res, 401, { error: 'authentication_required', message: '请先登录' })
        return
      }
      if (req.method === 'GET' && url.pathname === '/auth/account') {
        writeJson(res, 200, {
          mode: 'session', provider: 'lumo-governance', username: principal.username,
          displayName: principal.display_name, userId: principal.user_id, realm: principal.realm,
          roles: principal.roles, department: principal.primary_dept_id ?? '', clientIp: sourceIp(req),
          captchaMode: 'always',
        })
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
      proxyHttp(req, res, principal, options)
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
      proxyUpgrade(req, socket, head, principal, options, upgradedSockets)
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

import type { Server } from 'node:http'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { type AuthSession, type GovernanceAuthClient, type MFAStatus, type Principal, type TOTPEnrollment } from '../src/client.ts'
import { closeAuthProxy, createAuthProxy, listenAuthProxy } from '../src/proxy.ts'

const principal: Principal = {
  realm: 'dev', user_id: 'u1', username: 'palmer', display_name: 'Palmer', roles: ['operator'], session_expires_at: '2026-09-01T00:00:00Z',
}
const current: AuthSession = {
  id: 'session-current', client_ip: '127.0.0.1', created_at: '2026-08-31T00:00:00Z', last_seen_at: '2026-08-31T00:01:00Z', expires_at: '2026-09-01T00:00:00Z', current: true,
}
const other: AuthSession = { ...current, id: 'session-other', current: false }
const mfaStatus: MFAStatus = { configured: true, enabled: false }
const enrollment: TOTPEnrollment = { secret: 'JBSWY3DPEHPK3PXP', expires_at: '2026-09-01T00:10:00Z' }

// This exercises a real loopback HTTP listener. Sandboxed CI environments
// commonly reject bind(2), so it is an opt-in integration test rather than a
// misleading always-red unit test. Run with LUMO_AUTH_PROXY_TEST=1 locally.
const describeProxy = process.env['LUMO_AUTH_PROXY_TEST'] === '1' ? describe : describe.skip

describeProxy('account session proxy', () => {
  let server: Server | undefined

  afterEach(async () => { if (server !== undefined) await closeAuthProxy(server) })

  async function start(client: Partial<GovernanceAuthClient>): Promise<string> {
    const typed = {
      session: vi.fn(async () => principal),
      sessions: vi.fn(async () => [current, other]),
      revokeSession: vi.fn(async () => undefined),
      revokeOtherSessions: vi.fn(async () => 1),
      mfaStatus: vi.fn(async () => mfaStatus),
      beginTOTPEnrollment: vi.fn(async () => enrollment),
      confirmTOTPEnrollment: vi.fn(async () => ({ ...mfaStatus, enabled: true })),
      disableTOTP: vi.fn(async () => undefined),
      ...client,
    } as unknown as GovernanceAuthClient
    server = createAuthProxy({
      host: '127.0.0.1', port: 0, secureCookie: false, realm: 'dev', identityAssertionSecret: 'a'.repeat(32), upstreamPort: 1,
      client: typed, logger: { info: () => {}, warn: () => {}, error: () => {} },
    })
    return `http://127.0.0.1:${await listenAuthProxy(server, '127.0.0.1', 0)}`
  }

  const headers = { cookie: 'lumo_auth_session=token-current', 'X-Lumo-Auth-Request': '1' }

  it('lists safe session projections and revokes another session with an explicit request header', async () => {
    const sessions = vi.fn(async () => [current, other])
    const revokeSession = vi.fn(async () => undefined)
    const base = await start({ sessions, revokeSession })

    const listed = await fetch(`${base}/auth/account/sessions`, { headers })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toEqual({ sessions: [current, other] })

    const forbidden = await fetch(`${base}/auth/account/sessions/session-other`, { method: 'DELETE', headers: { cookie: headers.cookie } })
    expect(forbidden.status).toBe(403)

    const revoked = await fetch(`${base}/auth/account/sessions/session-other`, { method: 'DELETE', headers })
    expect(revoked.status).toBe(204)
    expect(revokeSession).toHaveBeenCalledWith('token-current', 'session-other')
  })

  it('clears the browser session when its current session is revoked', async () => {
    const revokeSession = vi.fn(async () => undefined)
    const base = await start({ revokeSession })

    const currentResult = await fetch(`${base}/auth/account/sessions/session-current`, { method: 'DELETE', headers })
    expect(currentResult.status).toBe(204)
    expect(currentResult.headers.get('set-cookie')).toContain('lumo_auth_session=')
    expect(currentResult.headers.get('set-cookie')).toContain('Max-Age=0')
    expect(revokeSession).toHaveBeenCalledWith('token-current', 'session-current')
  })

  it('revokes all other sessions while retaining the current browser session', async () => {
    const revokeOtherSessions = vi.fn(async () => 1)
    const base = await start({ revokeOtherSessions })

    const othersResult = await fetch(`${base}/auth/account/sessions/revoke-others`, { method: 'POST', headers })
    expect(othersResult.status).toBe(200)
    await expect(othersResult.json()).resolves.toEqual({ revoked: 1 })
    expect(revokeOtherSessions).toHaveBeenCalledWith('token-current')
  })

  it('proxies the TOTP lifecycle and protects mutations with the request header', async () => {
    const status = vi.fn(async () => mfaStatus)
    const begin = vi.fn(async () => enrollment)
    const confirm = vi.fn(async () => ({ ...mfaStatus, enabled: true }))
    const disable = vi.fn(async () => undefined)
    const base = await start({ mfaStatus: status, beginTOTPEnrollment: begin, confirmTOTPEnrollment: confirm, disableTOTP: disable })

    const listed = await fetch(`${base}/auth/account/mfa`, { headers })
    expect(listed.status).toBe(200)
    await expect(listed.json()).resolves.toEqual(mfaStatus)

    const forbidden = await fetch(`${base}/auth/account/mfa/enroll`, { method: 'POST', headers: { cookie: headers.cookie } })
    expect(forbidden.status).toBe(403)

    const started = await fetch(`${base}/auth/account/mfa/enroll`, { method: 'POST', headers })
    expect(started.status).toBe(201)
    await expect(started.json()).resolves.toEqual(enrollment)
    expect(begin).toHaveBeenCalledWith('token-current')

    const confirmed = await fetch(`${base}/auth/account/mfa/confirm`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ code: '123456' }) })
    expect(confirmed.status).toBe(200)
    await expect(confirmed.json()).resolves.toEqual({ ...mfaStatus, enabled: true })
    expect(confirm).toHaveBeenCalledWith('token-current', '123456')

    const disabled = await fetch(`${base}/auth/account/mfa`, { method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ code: '123456' }) })
    expect(disabled.status).toBe(204)
    expect(disable).toHaveBeenCalledWith('token-current', '123456')
  })
})

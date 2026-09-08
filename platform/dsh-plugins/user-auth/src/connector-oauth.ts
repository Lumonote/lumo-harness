import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto'
import type { Principal } from './client.ts'

export const CONNECTOR_OAUTH_COOKIE = 'lumo_connector_oauth'
export const CONNECTOR_OAUTH_CALLBACK = '/auth/connector-oauth/callback'
export const connectorIDPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u

export interface ConnectorOAuthStart { authorizationUrl: string; callbackUrl: string; expiresIn: number }
export interface ConnectorOAuthBridge { connectorId: string; browser: string; sessionToken: string; expiresAt: number }

export class ConnectorOAuthError extends Error {
  constructor(readonly status: number) { super('连接器授权请求失败'); this.name = 'ConnectorOAuthError' }
}

export class ConnectorOAuthClient {
  private readonly base: string
  constructor(baseUrl: string, private readonly controlToken: string) {
    const base = new URL(baseUrl)
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid connector gateway URL')
    this.base = base.href.replace(/\/+$/u, '')
  }

  async call<T>(principal: Principal, sessionToken: string, connectorId: string, action: 'start' | 'callback', body: unknown): Promise<T> {
    if (!connectorIDPattern.test(connectorId)) throw new ConnectorOAuthError(400)
    const response = await fetch(`${this.base}/connectors/${encodeURIComponent(connectorId)}/oauth/${action}`, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(55_000),
      headers: {
        'Content-Type': 'application/json', Authorization: `Bearer ${this.controlToken}`,
        'X-Lumo-User': principal.user_id, 'X-Lumo-Realm': principal.realm, 'X-Lumo-Roles': principal.roles.join(','),
        'X-Lumo-Session': createHash('sha256').update(sessionToken).digest('hex'),
      }, body: JSON.stringify(body),
    })
    if (!response.ok) { await response.body?.cancel(); throw new ConnectorOAuthError(response.status) }
    return await response.json() as T
  }
}

function bridgeKey(secret: string, realm: string, origin: string): Buffer {
  return createHmac('sha256', secret).update(`lumo-connector-oauth-browser-v1\0${realm}\0${origin}`).digest()
}

// The Lax bridge survives the provider redirect without changing the Strict
// session cookie. It is encrypted, short-lived, and bound to this realm/origin.
export function sealConnectorBridge(value: ConnectorOAuthBridge, secret: string, realm: string, origin: string): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', bridgeKey(secret, realm, origin), iv)
  const encoded = Buffer.concat([iv, cipher.update(JSON.stringify(value), 'utf8'), cipher.final(), cipher.getAuthTag()]).toString('base64url')
  if (encoded.length > 3500) throw new ConnectorOAuthError(400)
  return encoded
}

export function openConnectorBridge(raw: string, secret: string, realm: string, origin: string): ConnectorOAuthBridge {
  if (raw.length > 3500 || !/^[A-Za-z0-9_-]+$/u.test(raw)) throw new ConnectorOAuthError(400)
  const packed = Buffer.from(raw, 'base64url')
  if (packed.length < 29) throw new ConnectorOAuthError(400)
  const decipher = createDecipheriv('aes-256-gcm', bridgeKey(secret, realm, origin), packed.subarray(0, 12))
  decipher.setAuthTag(packed.subarray(-16))
  const value = JSON.parse(Buffer.concat([decipher.update(packed.subarray(12, -16)), decipher.final()]).toString('utf8')) as Partial<ConnectorOAuthBridge>
  if (typeof value.connectorId !== 'string' || !connectorIDPattern.test(value.connectorId) || typeof value.browser !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(value.browser)
    || typeof value.sessionToken !== 'string' || !value.sessionToken || typeof value.expiresAt !== 'number' || !Number.isFinite(value.expiresAt)
    || value.expiresAt <= Date.now() || value.expiresAt > Date.now() + 301_000) throw new ConnectorOAuthError(400)
  return value as ConnectorOAuthBridge
}

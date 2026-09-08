export interface Principal {
  realm: string
  user_id: string
  username: string
  display_name: string
  primary_dept_id?: string
  roles: string[]
  session_expires_at: string
  local_auth_enabled?: boolean
  auth_method?: 'local' | 'oidc'
}

export interface CaptchaResponse {
  id: string
  prompt: string
  expiresIn: number
  imageBase64: string
}

export interface LoginResponse {
  token: string
  expires_at: string
  principal: Principal
}

export interface OIDCStatus { enabled: boolean; issuer?: string; redirect_url?: string }
export interface OIDCStart { authorization_url: string; redirect_url: string; expires_in: number }

export interface AuthSession {
  id: string
  client_ip: string
  created_at: string
  last_seen_at: string
  expires_at: string
  current: boolean
}

export interface AuthSecurityEvent {
  id: number
  event: string
  client_ip?: string
  detail: Record<string, unknown>
  created_at: string
}

export interface MFAStatus {
  configured: boolean
  enabled: boolean
  pending_expires_at?: string
  enrolled_at?: string
}

export interface TOTPEnrollment { secret: string; expires_at: string }

export interface PasskeyCredential { id: string; label?: string; created_at: string; last_used_at?: string }
export interface PasskeyStatus { configured: boolean; rp_id?: string; require_user_verification?: boolean; passkeys?: PasskeyCredential[] }
export interface WebAuthnPublicKeyOptions { [key: string]: unknown; challenge: string }

export class GovernanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfter = 0,
  ) {
    super(message)
    this.name = 'GovernanceApiError'
  }
}

export class GovernanceAuthClient {
  private readonly base: string

  constructor(
    governanceUrl: string,
    private readonly controlPlaneToken: string,
    private readonly timeoutMs: number,
  ) {
    this.base = governanceUrl.replace(/\/+$/u, '')
  }

  async captcha(): Promise<CaptchaResponse> {
    const body = await this.json<{ id: string; prompt: string; expires_in: number; image: string }>(
      '/v1/auth/captcha', { method: 'POST' },
    )
    if (body.id === '' || body.image === '') {
      throw new GovernanceApiError(502, 'invalid_captcha_response', '验证码服务返回了无效响应')
    }
    return {
      id: body.id,
      prompt: body.prompt,
      expiresIn: body.expires_in,
      imageBase64: body.image,
    }
  }

  async login(input: {
    realm: string; username: string; password: string; captchaId: string; captchaCode: string; clientIp: string; mfaCode?: string
  }): Promise<LoginResponse> {
    return this.json<LoginResponse>('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lumo-Client-IP': input.clientIp },
      body: JSON.stringify({
        realm: input.realm, username: input.username, password: input.password,
        captcha_id: input.captchaId, captcha_code: input.captchaCode, mfa_code: input.mfaCode ?? '',
      }),
    })
  }

  async beginPasskeyLogin(input: { realm: string; username: string; captchaId: string; captchaCode: string; clientIp: string }): Promise<WebAuthnPublicKeyOptions> {
    const body = await this.json<{ public_key: WebAuthnPublicKeyOptions }>('/v1/auth/passkey/login/options', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lumo-Client-IP': input.clientIp },
      body: JSON.stringify({ realm: input.realm, username: input.username, captcha_id: input.captchaId, captcha_code: input.captchaCode }),
    })
    return body.public_key
  }

  async oidcStatus(realm: string): Promise<OIDCStatus> {
    return this.json<OIDCStatus>(`/v1/auth/oidc?realm=${encodeURIComponent(realm)}`, {})
  }

  async beginOIDCLogin(realm: string, browser: string): Promise<OIDCStart> {
    return this.json<OIDCStart>('/v1/auth/oidc/start', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ realm, browser }),
    }, Math.max(this.timeoutMs, 20_000))
  }

  async completeOIDCLogin(input: { realm: string; state: string; browser: string; code: string; issuer: string; error: string }, clientIp: string): Promise<LoginResponse> {
    return this.json<LoginResponse>('/v1/auth/oidc/callback', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lumo-Client-IP': clientIp }, body: JSON.stringify(input),
    }, Math.max(this.timeoutMs, 35_000))
  }

  async completePasskeyLogin(input: Record<string, string>, clientIp: string): Promise<LoginResponse> {
    return this.json<LoginResponse>('/v1/auth/passkey/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lumo-Client-IP': clientIp }, body: JSON.stringify(input),
    })
  }

  async session(token: string): Promise<Principal> {
    const body = await this.json<{ principal: Principal }>('/v1/auth/session', {
      headers: { 'X-Lumo-Session': token },
    })
    return body.principal
  }

  async logout(token: string): Promise<void> {
    await this.call('/v1/auth/logout', { method: 'POST', headers: { 'X-Lumo-Session': token } })
  }

  async sessions(token: string): Promise<AuthSession[]> {
    const body = await this.json<{ sessions?: AuthSession[] }>('/v1/auth/sessions', { headers: { 'X-Lumo-Session': token } })
    return body.sessions ?? []
  }

  async securityEvents(token: string): Promise<AuthSecurityEvent[]> {
    const body = await this.json<{ events?: AuthSecurityEvent[] }>('/v1/auth/security-events', { headers: { 'X-Lumo-Session': token } })
    return body.events ?? []
  }

  async mfaStatus(token: string): Promise<MFAStatus> {
    return this.json<MFAStatus>('/v1/auth/mfa', { headers: { 'X-Lumo-Session': token } })
  }

  async beginTOTPEnrollment(token: string): Promise<TOTPEnrollment> {
    return this.json<TOTPEnrollment>('/v1/auth/mfa/enroll', { method: 'POST', headers: { 'X-Lumo-Session': token } })
  }

  async confirmTOTPEnrollment(token: string, code: string): Promise<MFAStatus> {
    return this.json<MFAStatus>('/v1/auth/mfa/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lumo-Session': token }, body: JSON.stringify({ code }) })
  }

  async disableTOTP(token: string, code: string): Promise<void> {
    await this.call('/v1/auth/mfa', { method: 'DELETE', headers: { 'Content-Type': 'application/json', 'X-Lumo-Session': token }, body: JSON.stringify({ code }) })
  }

  async passkeys(token: string): Promise<PasskeyStatus> {
    return this.json<PasskeyStatus>('/v1/auth/passkeys', { headers: { 'X-Lumo-Session': token } })
  }

  async beginPasskeyRegistration(token: string): Promise<WebAuthnPublicKeyOptions> {
    const body = await this.json<{ public_key: WebAuthnPublicKeyOptions }>('/v1/auth/passkeys/register/options', { method: 'POST', headers: { 'X-Lumo-Session': token } })
    return body.public_key
  }

  async completePasskeyRegistration(token: string, input: Record<string, string>): Promise<PasskeyCredential> {
    return this.json<PasskeyCredential>('/v1/auth/passkeys/register', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Lumo-Session': token }, body: JSON.stringify(input) })
  }

  async deletePasskey(token: string, credentialID: string): Promise<void> {
    await this.call(`/v1/auth/passkeys/${encodeURIComponent(credentialID)}`, { method: 'DELETE', headers: { 'X-Lumo-Session': token } })
  }

  async revokeSession(token: string, sessionID: string): Promise<void> {
    await this.call(`/v1/auth/sessions/${encodeURIComponent(sessionID)}`, { method: 'DELETE', headers: { 'X-Lumo-Session': token } })
  }

  async revokeOtherSessions(token: string): Promise<number> {
    const body = await this.json<{ revoked?: number }>('/v1/auth/sessions/revoke-others', { method: 'POST', headers: { 'X-Lumo-Session': token } })
    return body.revoked ?? 0
  }

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    await this.call('/v1/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lumo-Session': token },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    })
  }

  private async json<T>(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<T> {
    const response = await this.call(path, init, timeoutMs)
    return await response.json() as T
  }

  private async call(path: string, init: RequestInit, timeoutMs = this.timeoutMs): Promise<Response> {
    let response: Response
    try {
      response = await fetch(this.base + path, {
        ...init,
        headers: { Authorization: `Bearer ${this.controlPlaneToken}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new GovernanceApiError(503, 'auth_unavailable', error instanceof Error ? error.message : '认证服务不可用')
    }
    if (response.ok) return response
    let body: { error?: string; message?: string } = {}
    try { body = await response.json() as typeof body } catch { /* non-JSON upstream failure */ }
    throw new GovernanceApiError(
      response.status,
      body.error ?? 'auth_error',
      body.message ?? `认证请求失败 (${response.status})`,
      Number(response.headers.get('retry-after') ?? 0),
    )
  }
}

export interface Principal {
  realm: string
  user_id: string
  username: string
  display_name: string
  primary_dept_id?: string
  roles: string[]
  session_expires_at: string
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
    realm: string; username: string; password: string; captchaId: string; captchaCode: string; clientIp: string
  }): Promise<LoginResponse> {
    return this.json<LoginResponse>('/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lumo-Client-IP': input.clientIp },
      body: JSON.stringify({
        realm: input.realm, username: input.username, password: input.password,
        captcha_id: input.captchaId, captcha_code: input.captchaCode,
      }),
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

  async changePassword(token: string, currentPassword: string, newPassword: string): Promise<void> {
    await this.call('/v1/auth/password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Lumo-Session': token },
      body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
    })
  }

  private async json<T>(path: string, init: RequestInit): Promise<T> {
    const response = await this.call(path, init)
    return await response.json() as T
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    let response: Response
    try {
      response = await fetch(this.base + path, {
        ...init,
        headers: { Authorization: `Bearer ${this.controlPlaneToken}`, ...(init.headers ?? {}) },
        signal: AbortSignal.timeout(this.timeoutMs),
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

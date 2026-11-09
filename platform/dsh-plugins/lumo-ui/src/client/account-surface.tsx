import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { ApiError, api, errorMessage } from './api.ts'
import { BusyButton, ConfirmButton, Empty, Glyph, Notice, Section, WorkspaceHero, formatSync } from './surface-shell.tsx'
import type { AuthAccount, AuthMFAStatus, AuthPasskey, AuthPasskeyStatus, AuthSecurityEvent, AuthSession, TOTPEnrollment } from './surface-types.ts'

export function localizedSecurityEvent(event: string): string {
  return ({
    login_succeeded: '登录成功', login_failed: '登录失败', login_locked: '登录锁定', logout: '主动登出',
    session_revoked: '会话已撤销', sessions_revoked: '其他会话已撤销', password_changed: '密码已更新',
    user_created: '账户已创建', user_updated: '账户资料已更新', credentials_reset: '管理员重置凭证',
    oidc_login: '企业账号登录', oidc_linked: '企业身份已关联', oidc_unlinked: '企业身份已解除',
    role_assigned: '角色已分配', role_revoked: '角色已撤销', role_created: '角色已创建', department_created: '部门已创建',
    admin_session_revoked: '管理员已注销会话', admin_sessions_revoked: '管理员已注销全部会话',
  } as Record<string, string>)[event] ?? event
}

export function base64URLToBuffer(value: string): ArrayBuffer {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error('Passkey 数据格式无效')
  const normalized = value.replace(/-/gu, '+').replace(/_/gu, '/')
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4))
  const bytes = Uint8Array.from(binary, byte => byte.charCodeAt(0))
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function bufferToBase64URL(value: ArrayBuffer): string {
  const bytes = new Uint8Array(value)
  let binary = ''
  bytes.forEach(byte => { binary += String.fromCharCode(byte) })
  return btoa(binary).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/gu, '')
}

export function requiredPasskeyString(source: Record<string, unknown>, name: string): string {
  const value = source[name]
  if (typeof value !== 'string' || value === '') throw new Error(`Passkey 选项缺少 ${name}`)
  return value
}

export function passkeyCreationOptions(source: Record<string, unknown>): PublicKeyCredentialCreationOptions {
  const rp = source.rp as Record<string, unknown> | undefined
  const user = source.user as Record<string, unknown> | undefined
  const selection = source.authenticator_selection as Record<string, unknown> | undefined
  const parameters = Array.isArray(source.pub_key_cred_params) ? source.pub_key_cred_params : []
  const exclude = Array.isArray(source.exclude_credentials) ? source.exclude_credentials : []
  if (rp === undefined || user === undefined || parameters.length === 0) throw new Error('Passkey 注册选项无效')
  return {
    challenge: base64URLToBuffer(requiredPasskeyString(source, 'challenge')),
    rp: { id: requiredPasskeyString(rp, 'id'), name: requiredPasskeyString(rp, 'name') },
    user: {
      id: base64URLToBuffer(requiredPasskeyString(user, 'id')),
      name: requiredPasskeyString(user, 'name'),
      displayName: requiredPasskeyString(user, 'display_name'),
    },
    pubKeyCredParams: parameters.map(parameter => {
      const value = parameter as Record<string, unknown>
      return { type: requiredPasskeyString(value, 'type') as PublicKeyCredentialType, alg: Number(value.alg) }
    }),
    timeout: typeof source.timeout === 'number' ? source.timeout : 300_000,
    attestation: source.attestation === 'none' ? 'none' : 'none',
    ...(selection === undefined ? {} : { authenticatorSelection: {
      residentKey: selection.resident_key === 'required' || selection.resident_key === 'discouraged' ? selection.resident_key : 'preferred',
      userVerification: selection.user_verification === 'required' || selection.user_verification === 'discouraged' ? selection.user_verification : 'preferred',
    } }),
    excludeCredentials: exclude.map(credential => {
      const value = credential as Record<string, unknown>
      return { type: requiredPasskeyString(value, 'type') as PublicKeyCredentialType, id: base64URLToBuffer(requiredPasskeyString(value, 'id')) }
    }),
  }
}

export function AccountSurface({ onClose }: { onClose: () => void }) {
  const [account, setAccount] = useState<AuthAccount | null>(null)
  const [sessions, setSessions] = useState<AuthSession[]>([])
	const [securityEvents, setSecurityEvents] = useState<AuthSecurityEvent[]>([])
	const [mfa, setMFA] = useState<AuthMFAStatus | null>(null)
	const [totpEnrollment, setTOTPEnrollment] = useState<TOTPEnrollment | null>(null)
	const [mfaCode, setMFACode] = useState('')
  const [passkeyStatus, setPasskeyStatus] = useState<AuthPasskeyStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const authHeaders = { 'X-Lumo-Auth-Request': '1' }
  const load = useCallback(async () => { setLoading(true); try {
    const nextAccount = await api<AuthAccount>('/auth/account', { headers: authHeaders })
    const passkeyResult = nextAccount.localAuthEnabled === false ? Promise.resolve<AuthPasskeyStatus>({ configured: false, passkeys: [] }) : api<AuthPasskeyStatus>('/auth/account/passkeys', { headers: authHeaders }).catch(reason => {
      if (reason instanceof ApiError && reason.status === 503 && errorMessage(reason.body, '') === 'passkey_unavailable') return { configured: false, passkeys: [] }
      throw reason
    })
    const [sessionResult, eventResult, mfaResult, nextPasskeys] = await Promise.all([
      api<{ sessions?: AuthSession[] }>('/auth/account/sessions', { headers: authHeaders }),
      api<{ events?: AuthSecurityEvent[] }>('/auth/account/security-events', { headers: authHeaders }),
      nextAccount.localAuthEnabled === false ? Promise.resolve<AuthMFAStatus>({ configured: false, enabled: false }) : api<AuthMFAStatus>('/auth/account/mfa', { headers: authHeaders }), passkeyResult,
    ])
    setAccount(nextAccount); setSessions(sessionResult.sessions ?? []); setSecurityEvents(eventResult.events ?? []); setMFA(mfaResult); setPasskeyStatus(nextPasskeys); setNotice('')
  } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setLoading(false) } }, [])
  useEffect(() => { void load() }, [load])
  const savePassword = async (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form); const currentPassword = String(fields.get('currentPassword') ?? ''); const newPassword = String(fields.get('newPassword') ?? ''); const confirmation = String(fields.get('confirmation') ?? ''); if (newPassword !== confirmation) { setNotice('两次输入的新密码不一致。'); return } setBusy(true); try { await api('/auth/account/password', { method: 'POST', headers: authHeaders, body: JSON.stringify({ currentPassword, newPassword }) }); location.assign('/auth/login?state=password-changed') } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const logout = async () => { setBusy(true); try { await api('/auth/logout', { method: 'POST', headers: authHeaders }); location.assign('/auth/login') } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)); setBusy(false) } }
  const revoke = async (session: AuthSession) => { setBusy(true); try { await api(`/auth/account/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE', headers: authHeaders }); if (session.current) { location.assign('/auth/login?state=expired'); return }; setNotice('会话已撤销。'); await load() } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const revokeOthers = async () => { setBusy(true); try { const result = await api<{ revoked?: number }>('/auth/account/sessions/revoke-others', { method: 'POST', headers: authHeaders }); setNotice(`已撤销 ${result.revoked ?? 0} 个其他会话。`); await load() } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const beginMFA = async () => { setBusy(true); try { const enrollment = await api<TOTPEnrollment>('/auth/account/mfa/enroll', { method: 'POST', headers: authHeaders }); setTOTPEnrollment(enrollment); setMFACode(''); setNotice('请将密钥添加到验证器，再输入当前 6 位验证码确认。') } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const confirmMFA = async () => { if (!/^\d{6}$/u.test(mfaCode)) { setNotice('请输入 6 位动态验证码。'); return }; setBusy(true); try { setMFA(await api<AuthMFAStatus>('/auth/account/mfa/confirm', { method: 'POST', headers: authHeaders, body: JSON.stringify({ code: mfaCode }) })); setTOTPEnrollment(null); setMFACode(''); setNotice('TOTP MFA 已启用。后续登录需要动态验证码。'); await load() } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const disableMFA = async () => { if (!/^\d{6}$/u.test(mfaCode)) { setNotice('请输入当前 6 位动态验证码以停用 MFA。'); return }; setBusy(true); try { await api('/auth/account/mfa', { method: 'DELETE', headers: authHeaders, body: JSON.stringify({ code: mfaCode }) }); setMFA({ configured: true, enabled: false }); setMFACode(''); setNotice('TOTP MFA 已停用。'); await load() } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) } }
  const enrollPasskey = async () => {
    if (!window.PublicKeyCredential || !navigator.credentials?.create) { setNotice('当前浏览器不支持 Passkey。'); return }
    const label = window.prompt('为此 Passkey 命名（可留空，例如“工作电脑”）')
    if (label === null) return
    setBusy(true)
    try {
      const options = await api<{ public_key: Record<string, unknown> }>('/auth/account/passkeys/register/options', { method: 'POST', headers: authHeaders })
      const credential = await navigator.credentials.create({ publicKey: passkeyCreationOptions(options.public_key) })
      if (credential === null || credential.type !== 'public-key') throw new Error('未获得 Passkey 凭据')
      const passkey = credential as PublicKeyCredential
      const response = passkey.response as AuthenticatorAttestationResponse
      if (typeof response.attestationObject === 'undefined') throw new Error('浏览器未返回 Passkey 注册证明')
      await api<AuthPasskey>('/auth/account/passkeys/register', {
        method: 'POST', headers: authHeaders, body: JSON.stringify({
          challenge: requiredPasskeyString(options.public_key, 'challenge'), id: passkey.id, raw_id: bufferToBase64URL(passkey.rawId), type: passkey.type,
          client_data_json: bufferToBase64URL(response.clientDataJSON), attestation_object: bufferToBase64URL(response.attestationObject), label: label.trim(),
        }),
      })
      setNotice('Passkey 已添加。'); await load()
    } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  const removePasskey = async (passkey: AuthPasskey) => {
    setBusy(true)
    try { await api(`/auth/account/passkeys/${encodeURIComponent(passkey.id)}`, { method: 'DELETE', headers: authHeaders }); setNotice('Passkey 已移除。'); await load() } catch (reason) { setNotice(reason instanceof Error ? reason.message : String(reason)) } finally { setBusy(false) }
  }
  return <div className="lumo-surface lumo-workspace-page lumo-account-surface">
    <WorkspaceHero surface="account" onClose={onClose} statement="当前身份、安全方式与设备，一处看清。" description="检查正在使用的账户，管理登录保护和已授权会话。账户操作会影响当前或其他设备的登录状态。">
      <div className="lumo-account-profile">
        <span className="lumo-account-profile-label">当前登录身份</span>
        <div className="lumo-account-profile-person"><div className="lumo-avatar"><Glyph surface="account" /></div><div><strong>{account?.displayName ?? (loading ? '正在读取身份' : '身份暂不可用')}</strong><small>{account?.username ?? '—'}</small></div></div>
        <div className="lumo-account-profile-facts"><span><small>工作域</small><b>{account?.realm ?? '—'}</b></span><span><small>部门</small><b>{account?.department || '未分配'}</b></span></div>
        <div className="lumo-account-profile-footer"><span><i className="lumo-live-dot" />{account ? '会话受保护' : loading ? '正在检查会话' : '会话状态未知'}</span><BusyButton busy={busy} className="lumo-danger" onClick={() => void logout()}>退出登录</BusyButton></div>
      </div>
    </WorkspaceHero>
    <nav className="lumo-account-nav" aria-label="用户中心分区">
      <button type="button" onClick={() => document.getElementById('lumo-account-security')?.scrollIntoView({ behavior: 'smooth' })}><span>01</span>账户安全</button>
      <button type="button" onClick={() => document.getElementById('lumo-account-activity')?.scrollIntoView({ behavior: 'smooth' })}><span>02</span>设备与活动</button>
      <button type="button" onClick={() => document.getElementById('lumo-account-details')?.scrollIntoView({ behavior: 'smooth' })}><span>03</span>身份资料</button>
    </nav>
    {notice ? <Notice error={account === null && !loading} close={() => setNotice('')}>{notice}</Notice> : null}
    <section className="lumo-account-group" id="lumo-account-security" aria-labelledby="lumo-account-security-title">
      <div className="lumo-account-group-heading"><span>01 / 账户安全</span><h2 id="lumo-account-security-title">保护你的登录方式</h2><p>密码、动态验证与 Passkey 各自独立；只有当前部署支持的方式才可配置。</p></div>
    {account?.authMethod === 'oidc' ? <Section title="企业登录"><div className="lumo-session-facts"><div><span>身份验证</span><b>企业身份提供方</b></div><div><span>角色</span><b>{account.roles.join(' · ') || '未分配'}</b></div></div></Section> : null}
    {account && account.localAuthEnabled !== false ? <>
    <div className="lumo-account-grid"><Section title="登录保护" meta="固定安全基线"><div className="lumo-security-list"><div><i className="ready" /><span><b>交互式验证码</b><small>每次登录必填点选，一张验证码仅验证一次</small></span><em>始终开启</em></div><div><i className="ready" /><span><b>会话凭据</b><small>HttpOnly Cookie，服务端仅存令牌摘要</small></span><em>不可见令牌</em></div><div><i className="ready" /><span><b>权限来源</b><small>{account?.roles.join(' · ') || '读取中'}</small></span><em>角色权限</em></div></div></Section><Section title="修改密码" meta="更新后撤销全部旧会话"><form className="lumo-stacked-form" onSubmit={savePassword}><label><span>当前密码</span><input name="currentPassword" type="password" autoComplete="current-password" required /></label><label><span>新密码</span><input name="newPassword" type="password" autoComplete="new-password" minLength={10} maxLength={256} required /></label><label><span>确认新密码</span><input name="confirmation" type="password" autoComplete="new-password" minLength={10} maxLength={256} required /></label><BusyButton type="submit" busy={busy} className="lumo-primary">更新并重新登录</BusyButton></form></Section></div>
    <div className="lumo-account-method-grid">
    <Section title="双重验证（TOTP）" meta={mfa === null ? '正在读取 MFA 状态' : mfa.configured ? mfa.enabled ? '已启用 · 登录时要求 6 位动态验证码' : '可配置 · 尚未启用' : '当前部署未配置 MFA 加密密钥'}>{mfa?.configured ? <div className="lumo-mfa-panel">{totpEnrollment ? <><p>在验证器中手动添加以下密钥；它仅在本页显示一次。</p><code>{totpEnrollment.secret}</code><small>待确认至 {formatSync(totpEnrollment.expires_at)}；输入验证器当前显示的 6 位代码。</small></> : <p>{mfa.enabled ? `已于 ${mfa.enrolled_at ? formatSync(mfa.enrolled_at) : '此前'} 启用。停用需要当前动态验证码。` : '启用后，密码和交互验证码通过后还必须提供 TOTP 动态验证码。'}</p>}<label><span>动态验证码</span><input value={mfaCode} onChange={event => setMFACode(event.target.value.replace(/\D/gu, '').slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="6 位验证码" /></label><div>{totpEnrollment ? <BusyButton busy={busy} className="lumo-primary" onClick={() => void confirmMFA()}>确认启用</BusyButton> : mfa.enabled ? <BusyButton busy={busy} className="lumo-danger" onClick={() => void disableMFA()}>停用 MFA</BusyButton> : <BusyButton busy={busy} className="lumo-primary" onClick={() => void beginMFA()}>开始绑定验证器</BusyButton>}</div></div> : <div className="lumo-account-unavailable"><b>当前不可用</b><p>此部署尚未启用 TOTP 双重验证。</p><details><summary>管理员配置说明</summary><p>设置 `LUMO_AUTH_MFA_KEY`（base64 编码的 32 字节密钥）后，系统才会保存加密的 TOTP 因子。</p></details></div>}</Section>
    <Section title="Passkey" meta={passkeyStatus === null ? '正在读取配置' : passkeyStatus.configured ? `${passkeyStatus.passkeys?.length ?? 0} 个已绑定 · ${passkeyStatus.rp_id}` : '当前部署未配置可信 RPID/origin'}>{passkeyStatus?.configured ? <div className="lumo-mfa-panel"><p>Passkey 仅接受当前可信域的 ES256 凭据；启用用户验证时，设备必须完成本地生物识别或 PIN 校验。</p>{passkeyStatus.passkeys?.length ? <div className="lumo-table-list">{passkeyStatus.passkeys.map(passkey => <div key={passkey.id}><span><b>{passkey.label || '未命名 Passkey'}</b><small>添加于 {formatSync(passkey.created_at)}{passkey.last_used_at ? ` · 最近使用 ${formatSync(passkey.last_used_at)}` : ''}</small></span><ConfirmButton busy={busy} confirmLabel="确认移除" onConfirm={() => removePasskey(passkey)}>移除</ConfirmButton></div>)}</div> : <Empty>尚未添加 Passkey。</Empty>}<div><BusyButton busy={busy} className="lumo-primary" onClick={() => void enrollPasskey()}>添加 Passkey</BusyButton></div></div> : <div className="lumo-account-unavailable"><b>当前不可用</b><p>此部署尚未配置可信域，无法添加 Passkey。</p><details><summary>管理员配置说明</summary><p>设置 `LUMO_AUTH_WEBAUTHN_RP_ID`、`LUMO_AUTH_WEBAUTHN_RP_NAME` 与精确的 `LUMO_AUTH_WEBAUTHN_ORIGINS`；未完成可信配置时不会降级启用。</p></details></div>}</Section>
    </div>
    </> : null}
    </section>
    <section className="lumo-account-group" id="lumo-account-activity" aria-labelledby="lumo-account-activity-title">
      <div className="lumo-account-group-heading"><span>02 / 设备与活动</span><h2 id="lumo-account-activity-title">知道账户在哪里使用</h2><p>查看正在登录的设备，并核对最近的安全事件。</p></div>
    <Section title="活跃会话" meta={loading ? '正在读取已认证会话' : `${sessions.length} 个未过期会话`} actions={<BusyButton className="lumo-secondary" busy={busy || loading} disabled={!sessions.some(session => !session.current)} onClick={() => void revokeOthers()}>退出其他设备</BusyButton>}>{sessions.length ? <div className="lumo-table-list lumo-session-list">{sessions.map(session => <div key={session.id}><span><b>{session.current ? '当前浏览器' : '已登录设备'}</b><small>{session.client_ip || 'IP 未记录'} · 最近活跃 {formatSync(session.last_seen_at)}</small></span><i>{session.current ? '当前会话' : `到期 ${formatSync(session.expires_at)}`}</i><BusyButton className={session.current ? 'lumo-danger lumo-small' : 'lumo-secondary lumo-small'} busy={busy} onClick={() => void revoke(session)}>{session.current ? '退出此会话' : '撤销'}</BusyButton></div>)}</div> : <Empty>{loading ? '正在读取会话。' : '没有可撤销的活跃会话。'}</Empty>}</Section>
    <Section title="安全事件" meta={loading ? '正在读取账户审计' : `${securityEvents.length} 条最近事件`}><div className="lumo-table-list">{securityEvents.length ? securityEvents.map(event => <div key={event.id}><span><b>{localizedSecurityEvent(event.event)}</b><small>{event.client_ip || '当前会话'}{Object.keys(event.detail).length ? ` · ${Object.entries(event.detail).map(([key, value]) => `${key}=${String(value)}`).join(' · ')}` : ''}</small></span><em>{formatSync(event.created_at)}</em></div>) : <Empty>{loading ? '正在读取安全事件。' : '暂无可显示的账户安全事件。'}</Empty>}</div></Section>
    </section>
    <section className="lumo-account-group" id="lumo-account-details" aria-labelledby="lumo-account-details-title">
      <div className="lumo-account-group-heading"><span>03 / 身份资料</span><h2 id="lumo-account-details-title">服务端确认的身份</h2><p>工作域、部门和用户编号以当前会话的服务端结果为准。</p></div>
    <Section title="会话详情" meta="服务端解析结果"><div className="lumo-session-facts"><div><span>用户 ID</span><b>{account?.userId ?? '读取中'}</b></div><div><span>Realm</span><b>{account?.realm ?? '读取中'}</b></div><div><span>部门</span><b>{account?.department || '未分配'}</b></div><div><span>验证码模式</span><b>{account?.captchaMode ?? '读取中'}</b></div></div></Section>
    </section>
  </div>
}

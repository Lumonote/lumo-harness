import { useCallback, useEffect, useRef, useState } from 'react'
import './user-security-panel.css'
import { authorityDenied, isRecord, isStringList, responseStatus, validActionCatalog, validActionDecisions } from './access-response.ts'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
interface SecurityOverview {
  user_id: string; status: string; organization_admin: boolean
  actions: { action: string; name: string; description: string }[]
  resolution: {
    direct_roles: string[]; effective_roles: string[]
    actions: Record<string, { allowed: boolean; explicit_deny: boolean; matched_policies: string[] }>
  }
}
interface Page { total: number; limit: number; offset: number; has_more: boolean }
interface Session { id: string; client_ip: string; created_at: string; last_seen_at: string; expires_at: string }
interface SecurityEvent { id: number; event: string; client_ip?: string; created_at: string; detail: Record<string, unknown> }
interface SessionPage extends Page { sessions: Session[] }
interface EventPage extends Page { events: SecurityEvent[] }
interface Props { request: Request; userId: string; userName: string; refreshKey?: string | number; disabled?: boolean }

const eventNames: Record<string, string> = {
  user_created: '创建用户', user_updated: '更新用户资料', credentials_reset: '重置登录凭证',
  role_assigned: '分配角色', role_revoked: '撤销角色', role_created: '创建角色', role_updated: '更新角色',
  role_permissions_updated: '更新角色权限', role_parent_updated: '更新角色继承',
  department_created: '创建部门', department_updated: '更新部门',
  login_succeeded: '登录成功', login_failed: '登录失败', login_locked: '登录已锁定', logout: '退出登录',
  session_revoked: '注销登录会话', sessions_revoked: '注销其他会话', admin_session_revoked: '管理员强制下线', admin_sessions_revoked: '管理员注销全部会话',
  password_changed: '修改密码', oidc_linked: '关联企业身份', oidc_unlinked: '解除企业身份', oidc_login: '企业身份登录',
  mfa_enabled: '启用双重验证', mfa_disabled: '停用双重验证', passkey_registered: '注册通行密钥', passkey_removed: '移除通行密钥', passkey_login: '通行密钥登录', passkey_clone_detected: '通行密钥异常',
}
const timestamp = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN') : '未知时间'
const message = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)
function validPage(page: Page, offset: number) {
  return isRecord(page) && Number.isSafeInteger(page.total) && page.total >= 0 && page.limit === 25 && page.offset === offset && typeof page.has_more === 'boolean'
}

export function UserSecurityPanel(props: Props) {
  // Changing the target remounts the state so a previous employee's access facts
  // or a late revocation response cannot appear under the new employee's name.
  return <UserSecurityContent key={props.userId} {...props} />
}

function UserSecurityContent({ request, userId, userName, refreshKey, disabled = false }: Props) {
  const [overview, setOverview] = useState<SecurityOverview | null>(null)
  const [sessions, setSessions] = useState<SessionPage | null>(null)
  const [events, setEvents] = useState<EventPage | null>(null)
  const [tab, setTab] = useState<'access' | 'sessions' | 'events'>('access')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revoke, setRevoke] = useState<{ id: string; label: string } | null>(null)
  const [reason, setReason] = useState('')
  const sequence = useRef(0)
  const pending = useRef(false)
  const base = `/lumo/api/users/${encodeURIComponent(userId)}`

  const load = useCallback(async (sessionOffset = 0, eventOffset = 0) => {
    const version = ++sequence.current
    pending.current = true; setBusy(true); setError('')
    try {
      const readPage = async <T extends Page,>(kind: 'sessions' | 'security-events', offset: number): Promise<T> => {
        let currentOffset = offset
        for (let attempt = 0; ; attempt++) {
          const result = await request<T>(`${base}/${kind}?limit=25&offset=${currentOffset}`)
          if (!validPage(result, currentOffset)) throw new Error('账户安全分页响应无效，请重新读取。')
          if (version !== sequence.current || currentOffset === 0 || currentOffset < result.total) return result
          currentOffset = attempt < 2 ? Math.max(0, Math.floor((result.total - 1) / 25) * 25) : 0
        }
      }
      const [security, devices, history] = await Promise.all([
        request<SecurityOverview>(`${base}/security`), readPage<SessionPage>('sessions', sessionOffset), readPage<EventPage>('security-events', eventOffset),
      ])
      if (version !== sequence.current) return
      if (!isRecord(security) || security.user_id !== userId || typeof security.status !== 'string' || typeof security.organization_admin !== 'boolean'
        || !validActionCatalog(security.actions) || !isStringList(security.resolution?.direct_roles) || !isStringList(security.resolution?.effective_roles) || !validActionDecisions(security.resolution.actions)
        || !Array.isArray(devices.sessions) || devices.sessions.some(session => !isRecord(session) || typeof session.id !== 'string' || !session.id || typeof session.client_ip !== 'string' || typeof session.created_at !== 'string' || typeof session.last_seen_at !== 'string' || typeof session.expires_at !== 'string')
        || !Array.isArray(history.events) || history.events.some(event => !isRecord(event) || !Number.isSafeInteger(event.id) || typeof event.event !== 'string' || typeof event.created_at !== 'string' || !isRecord(event.detail) || (event.client_ip !== undefined && typeof event.client_ip !== 'string'))) throw new Error('账户安全响应无效，请重新读取。')
      setOverview(security); setSessions(devices); setEvents(history)
    } catch (failure) {
      if (version === sequence.current) {
        setOverview(null); setSessions(null); setEvents(null); setRevoke(null)
        setError(message(failure))
      }
    } finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }, [base, request, userId])

  useEffect(() => {
    setOverview(null); setSessions(null); setEvents(null); setNotice(''); setRevoke(null)
    void load()
    return () => { sequence.current++ }
  }, [load, refreshKey])

  const confirmRevocation = async () => {
    if (!revoke || !reason.trim() || pending.current || disabled) return
    const target = revoke; const version = sequence.current
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const result = await request<{ revoked: number }>(`${base}/sessions${target.id ? `/${encodeURIComponent(target.id)}` : ''}`, { method: 'DELETE', body: JSON.stringify({ reason: reason.trim() }) })
      if (version !== sequence.current) return
      if (!Number.isSafeInteger(result.revoked) || result.revoked < 0) throw new Error('注销响应无效，请刷新确认会话状态。')
      setRevoke(null); setReason(''); setNotice(`已注销 ${result.revoked} 个登录会话。`)
      await load()
    } catch (failure) {
      if (version === sequence.current) {
        if (authorityDenied(failure)) { setOverview(null); setSessions(null); setEvents(null); setRevoke(null); setReason('') }
        else if (responseStatus(failure) === undefined || (responseStatus(failure) ?? 0) >= 500) { setRevoke(null); setReason(''); setOverview(null); setSessions(null); setEvents(null) }
        setError(`${message(failure)}${responseStatus(failure) === undefined || (responseStatus(failure) ?? 0) >= 500 ? ' 请刷新账户安全确认结果后再操作。' : ''}`)
      }
    } finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }
  const blocked = busy || disabled
  const pagination = (page: Page, kind: 'sessions' | 'events') => <nav className="lumo-user-security-pagination" aria-label={kind === 'sessions' ? '登录会话分页' : '账户记录分页'}>
    <span>共 {page.total} 条{page.total > page.offset ? ` · ${page.offset + 1}–${Math.min(page.offset + page.limit, page.total)}` : ''}</span>
    <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={blocked || Boolean(revoke) || page.offset === 0} onClick={() => void load(kind === 'sessions' ? Math.max(0, page.offset - page.limit) : sessions!.offset, kind === 'events' ? Math.max(0, page.offset - page.limit) : events!.offset)}>上一页</button>
    <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={blocked || Boolean(revoke) || !page.has_more} onClick={() => void load(kind === 'sessions' ? page.offset + page.limit : sessions!.offset, kind === 'events' ? page.offset + page.limit : events!.offset)}>下一页</button>
  </nav>

  return <section className="lumo-user-security" aria-label={`员工访问与安全 · ${userName}`} aria-busy={busy}>
    <header><div><h3>访问与安全</h3><p>核对员工权限、登录设备与账户变更。</p></div><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={blocked || Boolean(revoke)} onClick={() => { if (!pending.current) { setNotice(''); void load() } }}>刷新账户安全</button></header>
    <div role="tablist" aria-label="账户安全视图" className="lumo-user-security-tabs">{([['access', '权限解释'], ['sessions', `登录会话${sessions ? ` · ${sessions.total}` : ''}`], ['events', '账户记录']] as const).map(([id, label]) => <button key={id} id={`security-tab-${userId}-${id}`} type="button" role="tab" aria-selected={tab === id} aria-controls={`security-panel-${userId}`} disabled={Boolean(revoke)} onClick={() => setTab(id)}>{label}</button>)}</div>
    {error ? <p role="alert" className="lumo-user-security-error">{error}</p> : null}
    {notice ? <p role="status" className="lumo-user-security-notice">{notice}</p> : null}
    <div role="tabpanel" id={`security-panel-${userId}`} aria-labelledby={`security-tab-${userId}-${tab}`}>
      {!overview || !sessions || !events ? !error ? <p className="lumo-muted">正在读取账户安全。</p> : null : <>
        {tab === 'access' ? <>
          {overview.status !== 'active' ? <p className="lumo-user-security-error">账户已暂停或停用，当前不能使用角色权限。</p> : null}
          <dl className="lumo-user-security-facts"><div><dt>直接生效角色</dt><dd>{overview.resolution.direct_roles.join('、') || '无'}</dd></div><div><dt>包含继承的角色</dt><dd>{overview.resolution.effective_roles.join('、') || '无'}</dd></div><div><dt>组织管理</dt><dd>{overview.organization_admin ? '已授权' : '未授权'}</dd></div></dl>
          <div className="lumo-user-security-actions">{overview.actions.map(action => {
            const decision = overview.resolution.actions[action.action]
            return <div key={action.action}><div><b>{action.name}</b><small>{action.description}</small></div><span data-allowed={Boolean(decision?.allowed)}>{decision?.explicit_deny ? '显式拒绝' : decision?.allowed ? '角色允许' : '未授权'}</span>{decision?.matched_policies.length ? <details><summary>授权依据</summary>{decision.matched_policies.map(policy => <code key={policy}>{policy}</code>)}</details> : null}</div>
          })}</div><p className="lumo-user-security-hint">以上反映当前角色规则。实际操作还会校验项目、空间与策略服务；继承管理员角色不会授予组织管理权限。</p>
        </> : null}
        {tab === 'sessions' ? <>
          <div className="lumo-user-security-session-toolbar"><p>注销后需要重新登录。</p><button type="button" className="lumo-button lumo-danger lumo-small" disabled={blocked || !sessions.total || Boolean(revoke)} onClick={() => { setRevoke({ id: '', label: '全部登录会话' }); setReason(''); setNotice('') }}>全部下线</button></div>
          {revoke ? <form className="lumo-user-security-revoke" onSubmit={event => { event.preventDefault(); void confirmRevocation() }}><b>注销 {userName} 的{revoke.label}</b><label><span>下线原因</span><input value={reason} maxLength={500} required autoFocus disabled={blocked} onChange={event => setReason(event.target.value)} placeholder="例如：员工设备遗失" /></label><div><button type="submit" className="lumo-button lumo-danger lumo-small" disabled={blocked || !reason.trim()}>确认下线</button><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={blocked} onClick={() => setRevoke(null)}>取消下线</button></div></form> : null}
          <ul className="lumo-user-security-sessions">{sessions.sessions.map(session => <li key={session.id}><div><b>{session.client_ip || '来源未知'}</b><small>最近活动 {timestamp(session.last_seen_at)}</small><small>登录 {timestamp(session.created_at)} · 到期 {timestamp(session.expires_at)}</small><code title={session.id}>{session.id}</code></div><button type="button" className="lumo-button lumo-secondary lumo-small" aria-label={`注销会话 ${session.id}`} disabled={blocked || Boolean(revoke)} onClick={() => { setRevoke({ id: session.id, label: `登录会话（${session.client_ip || session.id}）` }); setReason(''); setNotice('') }}>下线</button></li>)}</ul>
          {!sessions.sessions.length ? <p className="lumo-muted">当前页没有活跃登录会话。</p> : null}{pagination(sessions, 'sessions')}
        </> : null}
        {tab === 'events' ? <><ol className="lumo-user-security-events">{events.events.map(event => <li key={event.id}><div><b>{eventNames[event.event] ?? event.event}</b><time dateTime={event.created_at}>{timestamp(event.created_at)}</time></div><p>{typeof event.detail.actor === 'string' ? `操作人 ${event.detail.actor}` : '账户安全事件'}{event.client_ip ? ` · ${event.client_ip}` : ''}{typeof event.detail.role_id === 'string' ? ` · 角色 ${event.detail.role_id}` : ''}{typeof event.detail.count === 'number' ? ` · ${event.detail.count} 个会话` : ''}</p>{typeof event.detail.reason === 'string' && event.detail.reason ? <p>{event.detail.reason}</p> : null}</li>)}</ol>{!events.events.length ? <p className="lumo-muted">当前页没有账户记录。</p> : null}{pagination(events, 'events')}</> : null}
      </>}
    </div>
  </section>
}

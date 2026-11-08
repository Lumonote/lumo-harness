import { useCallback, useEffect, useRef, useState } from 'react'
import { authorityDenied, isRecord, isStringList, responseStatus, validActionCatalog, validActionDecisions } from './access-response.ts'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
type Effect = 'allow' | 'deny' | 'inherit'
interface Action { action: string; name: string; description: string }
interface Rule { action: string; effect: Effect }
interface Fact { role_id: string; parent_role_id?: string; status: string; revision: number; permissions: Rule[] }
interface Policy extends Fact {
  resolution: {
    effective_roles: string[]; facts: Fact[]
    actions: Record<string, { allowed: boolean; explicit_deny: boolean; matched_policies: string[] }>
  }
}
export interface RoleOption { id: string; name: string; status: string; parent_role_id?: string }

interface Props { request: Request; role: RoleOption; roles: RoleOption[]; disabled?: boolean; refreshKey?: string | number }
function validRules(value: unknown): boolean {
  return Array.isArray(value) && value.every(rule => isRecord(rule) && typeof rule.action === 'string' && Boolean(rule.action) && ['allow', 'deny', 'inherit'].includes(String(rule.effect)))
    && new Set(value.map(rule => rule.action)).size === value.length
}
function validFact(value: unknown): boolean {
  return isRecord(value) && typeof value.role_id === 'string' && typeof value.status === 'string' && Number.isSafeInteger(value.revision) && Number(value.revision) >= 1
    && (value.parent_role_id === undefined || value.parent_role_id === null || typeof value.parent_role_id === 'string') && validRules(value.permissions)
}
function validPolicy(value: Policy): boolean {
  return validFact(value) && isRecord(value.resolution) && isStringList(value.resolution.effective_roles) && Array.isArray(value.resolution.facts)
    && value.resolution.facts.every(validFact) && validActionDecisions(value.resolution.actions)
}
export function RolePermissionsPanel(props: Props) { return <RolePermissionsContent key={props.role.id} {...props} /> }
function RolePermissionsContent({ request, role, roles, disabled = false, refreshKey }: Props) {
  const [policy, setPolicy] = useState<Policy | null>(null)
  const [actions, setActions] = useState<Action[]>([])
  const [draft, setDraft] = useState<Record<string, Effect>>({})
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)
  const [conflict, setConflict] = useState(false)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmReset, setConfirmReset] = useState(false)
  const sequence = useRef(0)
  const pending = useRef(false)
  const path = `/lumo/api/roles/${encodeURIComponent(role.id)}`
  const hierarchyVersion = JSON.stringify(roles.map(item => [item.id, item.status, item.parent_role_id ?? '']))
  const load = useCallback(async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError('')
    const version = ++sequence.current
    try {
      const [catalog, state] = await Promise.all([
        request<{ actions: Action[] }>('/lumo/api/permission-actions'), request<Policy>(`${path}/permissions`),
      ])
      if (version !== sequence.current) return
      if (!isRecord(catalog) || !validActionCatalog(catalog.actions) || !validPolicy(state) || state.role_id !== role.id) throw new Error('角色权限响应无效，请重试。')
      setActions(catalog.actions); setPolicy(state); setDraft(Object.fromEntries(state.permissions.map(rule => [rule.action, rule.effect])))
      setParent(state.parent_role_id ?? ''); setConflict(false); setUncertain(false); setConfirmReset(false); setNotice('')
    } catch (reason) { if (version === sequence.current) { setPolicy(null); setError(reason instanceof Error ? reason.message : String(reason)) } }
    finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }, [path, request, role.id])
  useEffect(() => { pending.current = false; setPolicy(null); void load(); return () => { sequence.current++ } }, [load, refreshKey, role.status, role.parent_role_id, hierarchyVersion])
  const save = async (kind: 'permissions' | 'parent' | 'reset') => {
    if (!policy || busy || pending.current || conflict || uncertain || disabled) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    const version = sequence.current
    try {
      const body = kind === 'parent' ? { expected_revision: policy.revision, parent_role_id: parent || null }
        : kind === 'reset' ? { expected_revision: policy.revision }
        : { expected_revision: policy.revision, permissions: actions.map(action => ({ action: action.action, effect: draft[action.action] ?? 'inherit' })) }
      const saved = await request<Policy>(`${path}/${kind === 'parent' ? 'parent' : 'permissions'}`, { method: kind === 'reset' ? 'DELETE' : 'PUT', body: JSON.stringify(body) })
      if (version !== sequence.current) return
      if (!validPolicy(saved) || saved.role_id !== role.id || saved.revision <= policy.revision) throw new Error('保存响应无效，请重新读取权限确认结果。')
      setPolicy(saved)
      if (kind === 'parent') setParent(saved.parent_role_id ?? '')
      else setDraft(Object.fromEntries(saved.permissions.map(rule => [rule.action, rule.effect])))
      setConfirmReset(false); setNotice(kind === 'parent' ? '角色继承已保存。' : kind === 'reset' ? '显式规则已清除，已恢复默认。' : '角色动作权限已保存。')
    } catch (reason) { if (version === sequence.current) {
      setError(reason instanceof Error ? reason.message : String(reason))
      if (authorityDenied(reason)) { setPolicy(null); setActions([]); setDraft({}); setParent(''); setConfirmReset(false) }
      else { setConflict(responseStatus(reason) === 409); setUncertain(responseStatus(reason) === undefined || (responseStatus(reason) ?? 0) >= 500) }
    } }
    finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }
  const canParent = (candidate: RoleOption) => {
    if (candidate.id === role.id || candidate.status !== 'active') return false
    const seen = new Set<string>(); let id: string | undefined = candidate.id
    while (id) {
      if (id === role.id || seen.has(id)) return false
      seen.add(id); id = roles.find(value => value.id === id)?.parent_role_id
    }
    return true
  }
  const blocked = busy || conflict || uncertain || disabled
  const changed = policy && actions.some(action => (draft[action.action] ?? 'inherit') !== (policy.permissions.find(rule => rule.action === action.action)?.effect ?? 'inherit'))
  return <section className="lumo-cluster-panel lumo-role-permissions" aria-label={`角色权限 · ${role.name}`} aria-busy={busy}>
    <header className="lumo-section-title"><div><h3>动作权限 · {role.name}</h3><p className="lumo-muted">拒绝优先；默认沿用内置角色规则。任务授权还需满足项目与空间权限。</p></div><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={busy || disabled} onClick={() => void load()}>重新读取角色权限</button></header>
    {error ? <p role="alert" className="lumo-cluster-feedback error">{error}{conflict || uncertain ? '；草稿已保留，请重新读取角色权限后再编辑。' : ''}</p> : null}
    {notice ? <p role="status" className="lumo-cluster-feedback">{notice}</p> : null}
    {policy ? <>
      <form className="lumo-governance-form lumo-role-parent" onSubmit={event => { event.preventDefault(); void save('parent') }}>
        <label><span>继承父角色</span><select aria-label="继承父角色" value={parent} disabled={blocked} onChange={event => setParent(event.target.value)}><option value="">不继承</option>{roles.filter(candidate => canParent(candidate) || candidate.id === policy.parent_role_id).map(candidate => <option key={candidate.id} value={candidate.id} disabled={!canParent(candidate)}>{candidate.name}{candidate.status !== 'active' ? '（已停用）' : ''}</option>)}</select></label>
        <button type="submit" className="lumo-button lumo-secondary lumo-small" disabled={blocked || parent === (policy.parent_role_id ?? '')}>保存继承关系</button>
      </form>
      <form onSubmit={event => { event.preventDefault(); void save('permissions') }}>
        <div className="lumo-role-action-list">{actions.map(action => {
          const decision = policy.resolution.actions[action.action]
          return <div key={action.action}><label><b>{action.name}</b><small>{action.description}</small><select aria-label={`${action.name}策略`} disabled={blocked} value={draft[action.action] ?? 'inherit'} onChange={event => { setDraft(current => ({ ...current, [action.action]: event.target.value as Effect })); setConfirmReset(false) }}><option value="inherit">默认</option><option value="allow">允许</option><option value="deny">拒绝</option></select></label><span className="lumo-role-decision"><b>{decision?.explicit_deny ? '显式拒绝' : decision?.allowed ? '角色允许' : '角色未授权'}</b><small>{decision?.matched_policies.join(' · ') || '没有匹配的授权规则'}</small></span></div>
        })}</div>
        <div className="lumo-form-actions"><button type="submit" className="lumo-button lumo-primary lumo-small" disabled={blocked || !changed}>保存动作权限</button>{confirmReset ? <><button type="button" className="lumo-button lumo-danger lumo-small" disabled={blocked} onClick={() => void save('reset')}>确认恢复默认</button><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={busy} onClick={() => setConfirmReset(false)}>取消恢复</button></> : <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={blocked || !policy.permissions.length} onClick={() => setConfirmReset(true)}>恢复全部默认</button>}</div>
      </form>
      <details className="lumo-role-explanation"><summary>已保存的权限解释 · v{policy.revision}</summary><p className="lumo-muted">{policy.status !== 'active' ? '此角色已停用，权限不生效。' : `生效角色：${policy.resolution.effective_roles.join(' → ') || '无'}。`}父角色停用会截断继承；同一用户任一角色的显式拒绝均优先。继承管理员名称只影响动作与技能，不授予组织管理权限。</p>{policy.resolution.facts.map(fact => <p key={fact.role_id}><b>{roles.find(value => value.id === fact.role_id)?.name ?? fact.role_id}</b> · v{fact.revision}{fact.parent_role_id ? ` · 继承 ${fact.parent_role_id}` : ''}{fact.permissions.length ? ` · ${fact.permissions.map(rule => `${rule.action}: ${rule.effect}`).join('；')}` : ' · 内置兼容默认'}</p>)}</details>
    </> : !error ? <p className="lumo-muted">正在读取角色权限。</p> : null}
  </section>
}

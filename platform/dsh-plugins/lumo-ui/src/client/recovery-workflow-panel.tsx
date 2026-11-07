import { useCallback, useEffect, useRef, useState } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
type Operation = 'restore' | 'key_destroy'
type Status = 'pending' | 'approved' | 'executing' | 'succeeded' | 'failed' | 'uncertain' | 'expired' | 'revoked'
interface Recovery {
  id: string; realm: string; operation: Operation; namespace: string; target_id: string; recovery_point?: string
  reason: string; requested_by: string; approved_by?: string; expires_at: string; status: Status; revision: number
  provider_id: string; request_digest: string; execution_id: string; fencing_token: number; executed_by?: string; lease_until?: string; last_error?: string
  receipt?: { receipt_id: string; outcome: string; completed_at: string }
}
interface Audit { id: number; event: string; actor: string; revision: number; fencing_token: number; created_at: string }
interface Provider { enabled: boolean; id: string; operations: Operation[] | null; scopes: { operation: Operation; realm: string; namespace: string; prefix: string }[] }
interface Listing { requests: Recovery[]; provider: Provider; actor: { user_id: string; realm: string } }
const stateLabels: Record<Status, string> = { pending: '等待审批', approved: '已批准', executing: '执行中', succeeded: '执行完成', failed: '执行服务已拒绝', uncertain: '结果待确认', expired: '已过期', revoked: '已撤销' }
const operationLabels: Record<Operation, string> = { restore: '恢复数据', key_destroy: '销毁租户密钥' }
const eventLabels: Record<string, string> = { requested: '提出请求', approved: '批准请求', claimed: '领取执行', succeeded: '回执确认完成', failed: '执行服务拒绝', uncertain: '结果待确认', expired: '审批窗口到期', revoked: '撤销请求' }

export function RecoveryWorkflowPanel({ request }: { request: Request }) {
  const [listing, setListing] = useState<Listing | null>(null)
  const [selected, setSelected] = useState<Recovery | null>(null)
  const [audit, setAudit] = useState<Audit[]>([])
  const [operation, setOperation] = useState<Operation>('restore')
  const [namespace, setNamespace] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [confirmTarget, setConfirmTarget] = useState('')
  const [conflict, setConflict] = useState(false)
  const pending = useRef(false)
  const sequence = useRef(0)
  const selection = useRef('')
  const apply = (value: Listing) => {
    if (!Array.isArray(value.requests) || !value.provider || !value.actor?.user_id) throw new Error('恢复审批响应无效，请重试。')
    setListing(value)
    setOperation(current => value.provider.operations?.includes(current) ? current : value.provider.operations?.[0] ?? 'restore')
    setNamespace(current => value.provider.scopes.some(scope => scope.namespace === current) ? current : value.provider.scopes[0]?.namespace ?? '')
  }
  const load = useCallback(async () => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); const version = ++sequence.current
    try {
      const value = await request<Listing>('/lumo/api/recovery-requests')
      if (version !== sequence.current) return
      apply(value)
      if (selection.current) {
        const detail = await request<{ request: Recovery; audit: Audit[] }>(`/lumo/api/recovery-requests/${encodeURIComponent(selection.current)}`)
        if (version !== sequence.current) return
        setSelected(detail.request); setAudit(detail.audit)
      }
      setConflict(false); setConfirmation(''); setConfirmTarget('')
    } catch (reason) { if (version === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }, [request])
  useEffect(() => { void load(); return () => { sequence.current++; pending.current = false } }, [load])
  useEffect(() => {
    const scopes = listing?.provider.scopes.filter(scope => scope.operation === operation) ?? []
    setNamespace(current => scopes.some(scope => scope.namespace === current) ? current : scopes[0]?.namespace ?? '')
  }, [listing, operation])
  const choose = async (id: string) => {
    if (pending.current) return
    selection.current = id; setSelected(null); setAudit([]); setConfirmation(''); setConfirmTarget(''); setError(''); setNotice(''); setConflict(false)
    pending.current = true; setBusy(true); const version = ++sequence.current
    try {
      const detail = await request<{ request: Recovery; audit: Audit[] }>(`/lumo/api/recovery-requests/${encodeURIComponent(id)}`)
      if (version === sequence.current) { setSelected(detail.request); setAudit(detail.audit) }
    } catch (reason) { if (version === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }
  const create = async (form: HTMLFormElement) => {
    if (pending.current || !listing?.provider.enabled || !namespace) return
    pending.current = true; setBusy(true); setError(''); setNotice(''); const version = sequence.current
    const values = new FormData(form)
    try {
      const result = await request<Recovery>('/lumo/api/recovery-requests', { method: 'POST', body: JSON.stringify({ operation, namespace, target_id: String(values.get('target_id') ?? ''), ...(operation === 'restore' ? { recovery_point: String(values.get('recovery_point') ?? '') } : {}), reason: String(values.get('reason') ?? ''), expires_at: new Date(Date.now() + Number(values.get('minutes')) * 60_000).toISOString() }) })
      if (version !== sequence.current) return
      selection.current = result.id; setSelected(result); setAudit([]); setListing(current => current ? { ...current, requests: [result, ...current.requests] } : current); form.reset(); setNotice('请求已创建，请另一位管理员核对并审批。')
    } catch (reason) { if (version === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }
  const act = async () => {
    if (!selected || !confirmation || pending.current || conflict || (confirmation === 'execute' && selected.operation === 'key_destroy' && confirmTarget !== selected.target_id)) return
    pending.current = true; setBusy(true); setError(''); setNotice(''); const version = sequence.current
    try {
      const result = await request<Recovery>(`/lumo/api/recovery-requests/${encodeURIComponent(selected.id)}/${confirmation}`, { method: 'POST', body: JSON.stringify({ expected_revision: selected.revision, request_digest: selected.request_digest }) })
      if (version !== sequence.current) return
      setSelected(result); setListing(current => current ? { ...current, requests: current.requests.map(item => item.id === result.id ? result : item) } : current)
      setConfirmation(''); setConfirmTarget(''); setNotice(result.status === 'uncertain' ? '执行结果尚未确认，请核对回执。' : '操作状态已更新。')
      const detail = await request<{ request: Recovery; audit: Audit[] }>(`/lumo/api/recovery-requests/${encodeURIComponent(selected.id)}`)
      if (version === sequence.current) { setSelected(detail.request); setAudit(detail.audit) }
    } catch (reason) { if (version === sequence.current) { setError(reason instanceof Error ? reason.message : String(reason)); setConflict(true) } }
    finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }
  const actor = listing?.actor.user_id
  const expired = selected ? Date.parse(selected.expires_at) <= Date.now() : false
  const leaseActive = selected?.status === 'executing' && Boolean(selected.lease_until && Date.parse(selected.lease_until) > Date.now())
  const executionAllowed = Boolean(listing?.provider.enabled && selected?.approved_by && selected.approved_by !== actor && ['approved', 'failed', 'uncertain', 'executing'].includes(selected.status) && !leaseActive && !expired)
  const receiptAllowed = Boolean(listing?.provider.enabled && selected && selected.fencing_token > 0 && ['failed', 'uncertain', 'executing'].includes(selected.status) && !leaseActive)
  const block = busy || conflict
  return <section className="lumo-cluster-panel lumo-recovery-panel" aria-label="恢复审批管理">
    <header className="lumo-section-title"><div><h2>恢复审批</h2><p className="lumo-muted">另一位管理员审批后执行，目标和请求摘要固定保存。执行失败或超时后使用原请求核对回执。</p></div><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={busy} onClick={() => void load()}>刷新恢复审批</button></header>
    {error ? <p role="alert" className="lumo-cluster-feedback error">{error}{conflict ? '；请刷新恢复审批后再继续，避免重复执行。' : ''}</p> : null}
    {notice ? <p role="status" className="lumo-cluster-feedback">{notice}</p> : null}
    {listing && !listing.provider.enabled ? <p className="lumo-cluster-feedback">执行服务未配置，恢复和密钥销毁暂不可用。历史请求仍可查看。</p> : null}
    <div className="lumo-recovery-grid">
      <div><h3>最近请求</h3><form className="lumo-inline-form" onSubmit={event => { event.preventDefault(); const id = String(new FormData(event.currentTarget).get('request_id') ?? '').trim(); if (id) void choose(id) }}><label><span>查找历史请求</span><input name="request_id" aria-label="恢复请求 ID" required maxLength={128} disabled={busy} /></label><button type="submit" className="lumo-button lumo-secondary lumo-small" disabled={busy}>查找请求</button></form><div className="lumo-compact-list">{listing?.requests.map(item => <button key={item.id} type="button" disabled={busy} aria-pressed={selected?.id === item.id} onClick={() => void choose(item.id)}><span><b>{operationLabels[item.operation]} · {item.target_id}</b><small>{item.namespace} · 申请人 {item.requested_by}</small></span><em>{stateLabels[item.status]}</em></button>)}</div>{listing?.requests.length === 0 ? <p className="lumo-muted">尚无恢复审批请求。</p> : null}<p className="lumo-muted">显示最近 100 条请求。</p>
        {listing?.provider.enabled ? <form className="lumo-governance-form lumo-user-form" onSubmit={event => { event.preventDefault(); void create(event.currentTarget) }} aria-label="创建恢复审批">
          <h3>提出请求</h3><label><span>操作类型</span><select aria-label="恢复操作类型" value={operation} disabled={busy} onChange={event => setOperation(event.target.value as Operation)}>{listing.provider.operations?.map(value => <option key={value} value={value}>{operationLabels[value]}</option>)}</select></label>
          <label><span>目标命名空间</span><select aria-label="恢复目标命名空间" value={namespace} disabled={busy} onChange={event => setNamespace(event.target.value)}>{[...new Set(listing.provider.scopes.filter(scope => scope.operation === operation).map(scope => scope.namespace))].map(value => <option key={value}>{value}</option>)}</select></label>
          <label><span>目标标识</span><input aria-label="目标标识" name="target_id" required maxLength={256} disabled={busy} autoComplete="off" /><small>允许前缀：{listing.provider.scopes.filter(scope => scope.operation === operation && scope.namespace === namespace).map(scope => scope.prefix).join('、')}</small></label>
          {operation === 'restore' ? <label><span>恢复点标识</span><input aria-label="恢复点标识" name="recovery_point" required maxLength={256} disabled={busy} autoComplete="off" /></label> : <p className="lumo-cluster-feedback error">密钥销毁不可恢复。请确认目标属于当前租户，并由另一位管理员审批。</p>}
          <label><span>申请原因</span><textarea name="reason" required maxLength={1000} rows={3} disabled={busy} /></label><label><span>审批有效期（分钟）</span><input name="minutes" type="number" min={2} max={1440} defaultValue={60} required disabled={busy} /></label><button type="submit" className="lumo-button lumo-primary" disabled={busy || !namespace}>创建审批请求</button>
        </form> : null}
      </div>
      <div>{selected ? <>
        <h3>{operationLabels[selected.operation]} · {stateLabels[selected.status]}</h3>
        <dl className="lumo-recovery-facts"><dt>目标</dt><dd>{selected.namespace} / {selected.target_id}</dd>{selected.recovery_point ? <><dt>恢复点</dt><dd>{selected.recovery_point}</dd></> : null}<dt>原因</dt><dd>{selected.reason}</dd><dt>申请人 / 审批人</dt><dd>{selected.requested_by} / {selected.approved_by || '等待审批'}</dd><dt>有效期</dt><dd>{new Date(selected.expires_at).toLocaleString('zh-CN')}</dd><dt>执行服务</dt><dd>{selected.provider_id}</dd><dt>请求摘要</dt><dd><code>{selected.request_digest}</code></dd><dt>版本 / 隔离令牌</dt><dd>v{selected.revision} / {selected.fencing_token}</dd></dl>
        {selected.status === 'uncertain' ? <p className="lumo-cluster-feedback">操作可能已在执行服务完成。结果未确认前不能撤销；到期后只能核对回执。</p> : null}
        {selected.receipt ? <p className="lumo-cluster-feedback">回执 {selected.receipt.receipt_id} · {selected.receipt.outcome === 'succeeded' ? '已确认完成' : selected.receipt.outcome === 'rejected' ? '已确认拒绝' : '尚未确认完成'} · {new Date(selected.receipt.completed_at).toLocaleString('zh-CN')}</p> : null}
        <div className="lumo-form-actions">{selected.status === 'pending' && selected.requested_by !== actor && !expired ? <button type="button" className="lumo-button lumo-primary lumo-small" disabled={block} onClick={() => { setConfirmation('approve'); setConfirmTarget('') }}>审批请求</button> : null}{['pending', 'approved', 'failed'].includes(selected.status) ? <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={block} onClick={() => setConfirmation('revoke')}>撤销请求</button> : null}{executionAllowed ? <button type="button" className={`lumo-button lumo-small ${selected.operation === 'key_destroy' ? 'lumo-danger' : 'lumo-primary'}`} disabled={block} onClick={() => { setConfirmation('execute'); setConfirmTarget('') }}>{selected.fencing_token > 0 ? '使用原请求重试' : '执行已批准请求'}</button> : null}{receiptAllowed ? <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={block} onClick={() => setConfirmation('receipt')}>核对执行回执</button> : null}</div>
        {confirmation ? <div className="lumo-recovery-confirm"><p>请核对目标 <b>{selected.namespace} / {selected.target_id}</b>{selected.recovery_point ? `，恢复点 ${selected.recovery_point}` : ''}。将基于上方已保存的摘要{confirmation === 'approve' ? '批准请求' : confirmation === 'revoke' ? '撤销请求' : confirmation === 'receipt' ? '核对回执' : '执行操作'}。</p>{confirmation === 'execute' && selected.operation === 'key_destroy' ? <label>输入完整目标标识确认销毁<input aria-label="确认销毁目标" value={confirmTarget} onChange={event => setConfirmTarget(event.target.value)} disabled={block} /></label> : null}<div className="lumo-form-actions"><button type="button" className="lumo-button lumo-danger lumo-small" disabled={block || (confirmation === 'execute' && selected.operation === 'key_destroy' && confirmTarget !== selected.target_id)} onClick={() => void act()}>确认{confirmation === 'approve' ? '审批' : confirmation === 'revoke' ? '撤销' : confirmation === 'receipt' ? '核对回执' : '执行'}</button><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={busy} onClick={() => setConfirmation('')}>取消</button></div></div> : null}
        <h3>审批与执行记录</h3>{audit.length >= 500 ? <p className="lumo-muted">显示最近 500 条记录，早期记录保留在审计库中。</p> : null}<div className="lumo-compact-list">{audit.map(event => <div key={event.id}><span><b>{eventLabels[event.event] ?? event.event}</b><small>{event.actor} · v{event.revision} · 隔离令牌 {event.fencing_token}</small></span><em>{new Date(event.created_at).toLocaleString('zh-CN')}</em></div>)}</div>{audit.length === 0 ? <p className="lumo-muted">刷新后可读取完整审批与执行记录。</p> : null}
      </> : <p className="lumo-muted">选择请求，核对目标、审批记录与执行回执。</p>}</div>
    </div>
  </section>
}

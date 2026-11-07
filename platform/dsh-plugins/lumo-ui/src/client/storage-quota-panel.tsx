import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
interface Quota {
  scope: 'realm' | 'project'; project_id: string; limit_bytes: number | null
  used_bytes: number; revision: number; by_kind: Record<string, number>
}
interface Response { quota: Quota; accounting: string; coverage: string[]; excluded: string[]; physical_gc_authorized: false }
const MIB = 1024 * 1024
const kindLabels: Record<string, string> = { 'session-attachment': '会话附件', 'run-file': '受控交付文件', 'task-artifact': '任务附件', 'knowledge-file': '资料库文件' }
const bytes = (value: number) => `${value.toLocaleString()} 字节（${(value / MIB).toLocaleString(undefined, { maximumFractionDigits: 2 })} MiB）`
const errorText = (reason: unknown) => reason instanceof Error ? reason.message : '配额服务暂时不可用，请重试。'
const validBytes = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0

function validateResponse(value: Response, projectID: string): Quota {
  const q = value?.quota
  if (!q || q.scope !== (projectID ? 'project' : 'realm') || q.project_id !== projectID || !validBytes(q.used_bytes)
    || !Number.isSafeInteger(q.revision) || q.revision < 1 || !(q.limit_bytes === null || validBytes(q.limit_bytes))
    || !q.by_kind || typeof q.by_kind !== 'object' || Array.isArray(q.by_kind) || !Object.values(q.by_kind).every(validBytes)
    || value.accounting !== 'retained-logical-reference-bytes' || value.physical_gc_authorized !== false) {
    throw new Error('配额响应与当前范围不符，请重新读取。')
  }
  return q
}

// Remounting the editor on scope changes isolates drafts and request lifetimes.
export function StorageQuotaPanel({ request }: { request: Request }) {
  const [scope, setScope] = useState<'realm' | 'project'>('realm')
  const [projectInput, setProjectInput] = useState('')
  const [projectID, setProjectID] = useState<string | null>(null)
  return <section className="lumo-section lumo-cluster-panel" aria-label="存储配额">
    <div className="lumo-section-title"><div><h3>存储配额</h3><p className="lumo-section-note">按当前保留的逻辑引用计量；同一文件被多个会话引用时分别计费。</p></div></div>
    <form className="lumo-governance-form lumo-cluster-form" aria-label="选择配额范围" onSubmit={event => { event.preventDefault(); if (projectInput.trim()) setProjectID(projectInput.trim()) }}>
      <label>配额范围<select aria-label="配额范围" value={scope} onChange={event => { setScope(event.target.value as 'realm' | 'project'); setProjectID(null) }}><option value="realm">当前租户</option><option value="project">指定项目</option></select></label>
      {scope === 'project' ? <><label>项目 ID<input aria-label="项目 ID" required maxLength={256} value={projectInput} onChange={event => { setProjectInput(event.target.value); setProjectID(null) }} /></label><div className="lumo-form-actions"><button type="submit" className="lumo-secondary" disabled={!projectInput.trim()}>读取项目配额</button></div></> : null}
    </form>
    <p className="lumo-form-hint">计量覆盖会话附件、受控交付文件、任务附件与资料库文件。会话日志、Spill、备份及未登记的历史对象不在此统计内；这里显示的数值不是物理磁盘总占用，也不授权自动删除文件。</p>
    {scope === 'realm' ? <QuotaEditor key="realm" request={request} projectID="" /> : projectID ? <QuotaEditor key={`project:${projectID}`} request={request} projectID={projectID} /> : <p className="lumo-inline-empty">输入项目 ID 后读取该项目的逻辑引用配额。</p>}
  </section>
}

function QuotaEditor({ request, projectID }: { request: Request; projectID: string }) {
  const [quota, setQuota] = useState<Quota | null>(null)
  const [unlimited, setUnlimited] = useState(false)
  const [mib, setMiB] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const pending = useRef(false)
  const sequence = useRef(0)
  const abort = useRef<AbortController | null>(null)
  const path = `/lumo/api/storage/quota${projectID ? `?project_id=${encodeURIComponent(projectID)}` : ''}`
  const draft = (next: Quota) => { setUnlimited(next.limit_bytes === null); setMiB(next.limit_bytes !== null && next.limit_bytes % MIB === 0 ? String(next.limit_bytes / MIB) : '') }
  const load = useCallback(async (preserveDraft = false) => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(''); setNotice('')
    const version = ++sequence.current
    const controller = new AbortController(); abort.current = controller
    try {
      const next = validateResponse(await request<Response>(path, { signal: controller.signal }), projectID)
      if (version !== sequence.current) return
      setQuota(next); setConflict(false)
      if (!preserveDraft) draft(next)
      else setNotice('已读取最新配额，草稿仍保留。请核对后再次保存，或采用已保存的配额。')
    } catch (reason) { if (version === sequence.current) setError(errorText(reason)) }
    finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }, [path, projectID, request])
  useEffect(() => { void load(); return () => { sequence.current++; abort.current?.abort(); pending.current = false } }, [load])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!quota || busy || pending.current || conflict) return
    const number = Number(mib)
    if (!unlimited && (!/^\d+$/u.test(mib) || !validBytes(number) || !validBytes(number * MIB))) { setError('请输入可精确表示的非负整数 MiB。'); return }
    const limit = unlimited ? null : number * MIB
    pending.current = true; setBusy(true); setError(''); setNotice('')
    const version = ++sequence.current
    const controller = new AbortController(); abort.current = controller
    try {
      const next = validateResponse(await request<Response>(path, { method: 'PUT', signal: controller.signal, body: JSON.stringify({ expected_revision: quota.revision, limit_bytes: limit }) }), projectID)
      if (version !== sequence.current) return
      setQuota(next); draft(next); setNotice('配额已保存，已有文件与引用保持保留。')
    } catch (reason) {
      if (version !== sequence.current) return
      const stale = typeof reason === 'object' && reason !== null && 'status' in reason && reason.status === 409
      setConflict(stale); setError(stale ? '保存冲突：配额已更新。草稿已保留，请读取最新配额并核对后再保存。' : errorText(reason))
    } finally { if (version === sequence.current) { pending.current = false; setBusy(false) } }
  }
  return <div>
    <div className="lumo-section-title"><h4>{projectID ? `项目 ${projectID}` : '当前租户'}的配额</h4><button type="button" className="lumo-secondary" disabled={busy} onClick={() => void load(quota !== null)}>读取最新配额（保留草稿）</button></div>
    {error ? <p role="alert" className="lumo-cluster-feedback error">{error}</p> : null}
    {notice ? <p role="status" className="lumo-cluster-feedback">{notice}</p> : null}
    {busy && !quota ? <p role="status" className="lumo-section-note">正在读取配额…</p> : null}
    {quota ? <>
      <div className="lumo-fact-grid"><div><small>已保留的逻辑引用</small><b>{bytes(quota.used_bytes)}</b></div><div><small>当前已保存的上限</small><b>{quota.limit_bytes === null ? '不限额' : bytes(quota.limit_bytes)}</b></div><div><small>容量状态</small><b>{quota.limit_bytes === null ? '未限制新增引用' : quota.used_bytes > quota.limit_bytes ? '已有用量超额，拒绝新增' : quota.used_bytes === quota.limit_bytes ? '已达上限' : '上限内'}</b></div></div>
      <div className="lumo-compact-list" aria-label="逻辑引用分类">{Object.entries(quota.by_kind).map(([kind, size]) => <div key={kind}><span><b>{kindLabels[kind] ?? kind}</b></span><em>{bytes(size)}</em></div>)}{!Object.keys(quota.by_kind).length ? <p className="lumo-inline-empty">当前范围暂无已登记的活动引用。</p> : null}</div>
      <form className="lumo-governance-form lumo-cluster-form" aria-label="配置存储配额" onSubmit={submit}>
        <label className="lumo-cluster-checkbox"><input type="checkbox" checked={unlimited} disabled={busy} onChange={event => { setUnlimited(event.target.checked); setNotice('') }} />不限额</label>
        {!unlimited ? <label>存储上限（MiB）<input aria-label="存储上限（MiB）" type="number" min="0" step="1" required value={mib} disabled={busy} onChange={event => { setMiB(event.target.value); setNotice('') }} /></label> : null}
        <p className="lumo-form-hint">1 MiB = 1,048,576 字节。0 拒绝新增计费引用；降低上限不会删除已有文件。项目写入同时受租户上限约束。</p>
        {quota.limit_bytes !== null && quota.limit_bytes % MIB !== 0 ? <p className="lumo-section-note">当前上限不是整数 MiB。保存新上限前，请输入整数 MiB，或选择不限额。</p> : null}
        <div className="lumo-form-actions"><button type="submit" className="lumo-primary" disabled={busy || conflict}>{busy ? '处理中…' : '保存存储配额'}</button><button type="button" className="lumo-secondary" disabled={busy || conflict} onClick={() => { draft(quota); setNotice('已采用当前保存的配额。'); setError('') }}>采用已保存的配额</button></div>
      </form>
    </> : null}
  </div>
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

interface Budget {
  projectId: string; unit: 'tokens'; remaining: number | null; total: number | null
  softLimit: number | null; overdraft: number; revision: number
  state: 'within' | 'soft' | 'overdraft' | 'hard' | 'unconfigured'
}
type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export function ProjectBudgetPanel({ request, projectID, editable }: { request: Request; projectID: string; editable: boolean }) {
  const [budget, setBudget] = useState<Budget | null>(null)
  const [total, setTotal] = useState('')
  const [soft, setSoft] = useState('')
  const [overdraft, setOverdraft] = useState('0')
  const [mode, setMode] = useState<'adjust' | 'reset'>('adjust')
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [conflict, setConflict] = useState(false)
  const pending = useRef(false)
  const sequence = useRef(0)
  const path = `/lumo/api/projects/${encodeURIComponent(projectID)}/budget`
  const accept = (next: Budget) => {
    setBudget(next); setTotal(String(next.total ?? '')); setSoft(String(next.softLimit ?? '')); setOverdraft(String(next.overdraft))
    setMode(next.total === null ? 'reset' : 'adjust'); setConfirm(false); setConflict(false)
  }
  const load = useCallback(async () => {
    const current = ++sequence.current
    setBusy(true); setError('')
    try { const next = await request<Budget>(path); if (current === sequence.current) accept(next) }
    catch (reason) { if (current === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (current === sequence.current) setBusy(false) }
  }, [request, path])
  useEffect(() => { void load(); return () => { ++sequence.current } }, [load])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!editable || !budget || pending.current || busy || conflict) return
    const numbers = [total, soft, overdraft].map(value => value.trim() === '' ? Number.NaN : Number(value))
    if (!numbers.every(value => Number.isSafeInteger(value) && value >= 0) || numbers[1]! > numbers[0]! || !Number.isSafeInteger(numbers[0]! + numbers[2]!)) { setError('请输入非负整数，软限额不能超过总额。'); return }
    if (mode === 'reset' && !confirm) { setError('重置会重新计算本期可用额度，请先确认。'); return }
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      const next = await request<Budget>(path, { method: 'POST', body: JSON.stringify({ mode, total: numbers[0], softLimit: numbers[1], overdraft: numbers[2], expectedRevision: budget.revision, ...(mode === 'reset' ? { confirmReset: true } : {}) }) })
      accept(next); setNotice(mode === 'adjust' ? '预算已调整，已用额度保持不变。' : '本期预算已重置，历史台账保留。')
    } catch (reason) {
      const stale = typeof reason === 'object' && reason !== null && 'status' in reason && reason.status === 409
      if (stale) setConflict(true)
      setError((stale ? '预算已变化，请重新读取后编辑：' : '') + (reason instanceof Error ? reason.message : String(reason)))
    } finally { pending.current = false; setBusy(false) }
  }
  return <section className="lumo-section lumo-cluster-panel" aria-label="项目预算">
    <div className="lumo-section-title"><div><h4>项目预算</h4><p className="lumo-section-note">额度单位为 tokens；期中调整保留已用额度，重置用于开始新的预算周期。</p></div><button type="button" className="lumo-secondary" disabled={busy} onClick={() => { setNotice(''); void load() }}>重新读取预算</button></div>
    {error ? <p role="alert" className="lumo-cluster-feedback error">{error}</p> : null}
    {notice ? <p role="status" className="lumo-cluster-feedback">{notice}</p> : null}
    {busy && !budget ? <p className="lumo-section-note" role="status">正在读取预算…</p> : null}
    {budget ? <div className="lumo-fact-grid"><div><small>本期总额</small><b>{budget.total?.toLocaleString() ?? '未配置'}</b></div><div><small>当前剩余</small><b>{budget.remaining?.toLocaleString() ?? '未配置'}</b></div><div><small>额度状态</small><b>{({ within: '预算内', soft: '软限额', overdraft: '透支中', hard: '已达硬上限', unconfigured: '尚未配置总额' } as Record<string,string>)[budget.state] ?? budget.state}</b></div></div> : null}
    {editable && budget ? <form className="lumo-governance-form lumo-cluster-form" aria-label="预算配置" onSubmit={submit}>
      <label>预算操作<select aria-label="预算操作" value={mode} disabled={busy || conflict} onChange={event => { setMode(event.target.value as 'adjust' | 'reset'); setConfirm(false) }}><option value="adjust" disabled={budget.total === null}>期中调整</option><option value="reset">重置本期预算</option></select></label>
      <label>总额（tokens）<input aria-label="预算总额" type="number" min="0" step="1" value={total} required disabled={busy || conflict} onChange={event => setTotal(event.target.value)} /></label>
      <label>软限额（tokens）<input aria-label="预算软限额" type="number" min="0" step="1" value={soft} required disabled={busy || conflict} onChange={event => setSoft(event.target.value)} /></label>
      <label>透支额度（tokens）<input aria-label="预算透支额度" type="number" min="0" step="1" value={overdraft} required disabled={busy || conflict} onChange={event => setOverdraft(event.target.value)} /></label>
      {mode === 'reset' ? <label className="lumo-cluster-checkbox"><input type="checkbox" checked={confirm} disabled={busy || conflict} onChange={event => setConfirm(event.target.checked)} />确认重置本期剩余额度</label> : null}
      <div className="lumo-form-actions"><button type="submit" className="lumo-primary" disabled={busy || conflict || mode === 'reset' && !confirm}>{busy ? '处理中…' : '保存预算'}</button></div>
    </form> : null}
  </section>
}

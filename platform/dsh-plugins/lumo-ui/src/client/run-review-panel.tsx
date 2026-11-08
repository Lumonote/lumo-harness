import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export interface ReviewActor { realm: string; userId: string }
export interface ReviewWorker { worker_id: string; worker_kind: 'human' | 'agent'; display_name: string; status: string; eligible: boolean }
interface ReviewTask { id: string; title: string; project_id?: string; assignee_worker_id?: string; business_state?: string }
interface ReviewRun { id: string; task_id: string; worker_id: string; state: string; attempt?: number }
interface ReviewCreated<T> { task: T; run: ReviewRun }
interface ReviewResult { task_id: string; run_id: string; state: string; summary: string }
const runStateLabels: Record<string, string> = { ASSIGNED: '已分派', QUEUED: '排队中', RUNNING: '审核中', CANCELLING: '取消中', COMPLETED: '审核执行完成', FAILED: '审核执行失败', CANCELLED: '已取消', BLOCKED: '审核受阻' }

/** Derive a permanent key for this exact review request. Remounts, refreshed
 * pages and simultaneous tabs all retry the same server receipt. Identity here
 * only separates browser requests; the proxy supplies the trusted caller. */
export async function runReviewRequestKey(actor: ReviewActor, taskID: string, runID: string, workerID: string, epoch = ''): Promise<string> {
  if (!actor.realm || !actor.userId || !taskID || !runID || !/^agent:[A-Za-z0-9._-]{1,128}$/u.test(workerID)) throw new Error('无法确认审核请求的身份与范围。')
  const bytes = new TextEncoder().encode(JSON.stringify(['lumo-run-review-v1', actor.realm, actor.userId, taskID, runID, workerID, epoch]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `ui-review:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`
}

interface RunReviewProps<T extends ReviewTask> {
  request: Request; actor: ReviewActor | null; taskID: string; projectID?: string | undefined
  run: { id: string; worker_id: string; state: string }; workers: ReviewWorker[]; workersError?: string
  onOpen: (task: T) => void
}

export function RunReviewPanel<T extends ReviewTask>(props: RunReviewProps<T>) {
  const scope = JSON.stringify([props.actor?.realm, props.actor?.userId, props.taskID, props.projectID, props.run.id, props.run.worker_id])
  return <ScopedRunReviewPanel key={scope} {...props} />
}

function ScopedRunReviewPanel<T extends ReviewTask>({ request, actor, taskID, projectID, run, workers, workersError = '', onOpen }: RunReviewProps<T>) {
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<ReviewCreated<T> | null>(null)
  const [confirmNewRound, setConfirmNewRound] = useState(false)
  const requestScope = useRef<string | null>(null)
  const mounted = useRef(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshError, setRefreshError] = useState('')
  const [reviewResult, setReviewResult] = useState<ReviewResult | null>(null)
  const refreshingRef = useRef(false)
  const receipt = useRef(created)
  receipt.current = created
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const refreshReview = useCallback(async () => {
    const current = receipt.current
    if (!current || refreshingRef.current) return
    refreshingRef.current = true; setRefreshing(true); setRefreshError('')
    try {
      const [task, runs] = await Promise.all([
        request<T>(`/lumo/api/delegations/${encodeURIComponent(current.task.id)}`),
        request<{ runs: ReviewRun[] }>(`/lumo/api/tasks/${encodeURIComponent(current.task.id)}/runs`),
      ])
      if (!mounted.current || receipt.current?.task.id !== current.task.id) return
      if (task?.id !== current.task.id || task.project_id !== projectID || !Array.isArray(runs?.runs)
        || runs.runs.some(value => !value || value.task_id !== task.id || typeof value.id !== 'string' || typeof value.worker_id !== 'string' || typeof value.state !== 'string' || !Number.isSafeInteger(value.attempt) || value.attempt! < 1)) throw Error('审核状态响应与任务不一致，请重试。')
      const latest = runs.runs.reduce<ReviewRun | undefined>((last, value) => !last || value.attempt! > last.attempt! ? value : last, undefined)
      if (!latest) throw Error('审核执行记录暂不可用，请重试。')
      setCreated({ task, run: latest }); setReviewResult(null)
      if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(latest.state)) {
        const result = await request<ReviewResult>(`/lumo/api/tasks/${encodeURIComponent(task.id)}/runs/${encodeURIComponent(latest.id)}/result`)
        if (!mounted.current || receipt.current?.task.id !== current.task.id) return
        if (result?.task_id !== task.id || result.run_id !== latest.id || result.state !== latest.state || typeof result.summary !== 'string') throw Error('审核回执与当前执行不一致，请打开审核任务核对。')
        setReviewResult(result)
      }
    } catch (reason) { if (mounted.current) { setReviewResult(null); setRefreshError(reason instanceof Error ? reason.message : String(reason)) } }
    finally { refreshingRef.current = false; if (mounted.current) setRefreshing(false) }
  }, [request, projectID])
  useEffect(() => {
    if (!created) return
    const timer = window.setInterval(() => { if (document.visibilityState !== 'hidden') void refreshReview() }, 15000)
    return () => window.clearInterval(timer)
  }, [created?.task.id, refreshReview])
  const reviewers = workers.filter(worker => worker.worker_kind === 'agent' && /^agent:[A-Za-z0-9._-]{1,128}$/u.test(worker.worker_id)
    && worker.worker_id !== run.worker_id && worker.status === 'active')
  const selectedWorker = reviewers.find(worker => worker.worker_id === selected && worker.eligible)
  const canCreate = !!actor && !!projectID && run.state === 'COMPLETED' && !!selectedWorker && !workersError
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!canCreate || !actor || pending.current) return
    pending.current = true; setBusy(true); setError('')
    try {
      const workerID = selected
      const baseKey = await runReviewRequestKey(actor, taskID, run.id, workerID)
      if (!mounted.current) return
      requestScope.current = `lumo:review-epoch:${baseKey}`
      let epoch: string
      try { epoch = localStorage.getItem(requestScope.current) ?? '' }
      catch { throw new Error('无法恢复此前的审核请求，请检查浏览器存储是否可用。') }
      if (epoch && !/^[a-f0-9-]{36}$/u.test(epoch)) throw new Error('此前的审核请求记录无法读取，请联系管理员。')
      const key = epoch ? await runReviewRequestKey(actor, taskID, run.id, workerID, epoch) : baseKey
      if (!mounted.current) return
      const result = await request<ReviewCreated<T>>(`/lumo/api/tasks/${encodeURIComponent(taskID)}/runs/${encodeURIComponent(run.id)}/review-tasks`, {
        method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ reviewer_worker_id: workerID }),
      })
      if (!mounted.current) return
      if (!result?.task?.id || !result.run?.id || result.run.task_id !== result.task.id || result.task.project_id !== projectID
        || result.run.worker_id !== workerID || result.task.assignee_worker_id !== workerID) throw new Error('审核任务响应与本次请求不一致，请重试读取原请求。')
      setCreated(result)
    } catch (reason) { if (mounted.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; if (mounted.current) setBusy(false) }
  }
  function beginNewRound() {
    if (!requestScope.current || !created || busy) return
    try {
      localStorage.setItem(requestScope.current, crypto.randomUUID())
      setCreated(null); receipt.current = null; setReviewResult(null); setRefreshError(''); setConfirmNewRound(false); setError('')
    } catch { setError('无法保存新一轮审核请求，请检查浏览器存储是否可用。') }
  }
  return <section className="lumo-run-review" aria-label="独立审核">
    <header><div><span>交付审核</span><h3>交给另一位 Agent 核对结果</h3></div><small>Run {run.id}</small></header>
    <p className="lumo-form-hint">选择与产出方不同的 Agent 和模型。审核将生成独立任务，原任务会等待审核结论。</p>
    <form className="lumo-inline-form" onSubmit={event => void submit(event)}>
      <label><span>审核 Agent</span><select aria-label="审核 Agent" value={selected} disabled={busy || !!created} onChange={event => { setSelected(event.target.value); setError('') }}>
        <option value="">选择审核 Agent</option>
        {reviewers.map(worker => <option key={worker.worker_id} value={worker.worker_id} disabled={!worker.eligible}>{worker.display_name} · {worker.worker_id}{worker.eligible ? '' : ' · 当前不可分派'}</option>)}
      </select></label>
      <button type="submit" className="lumo-button lumo-secondary" disabled={busy || !canCreate || !!created}>{busy ? '正在创建…' : created ? '审核已安排' : '创建审核任务'}</button>
    </form>
    {!actor ? <p className="lumo-form-hint">正在确认当前登录身份，暂不能创建审核任务。</p> : null}
    {!workersError && reviewers.length === 0 ? <p className="lumo-form-hint">当前没有其他可选 Agent，请先配置并上线独立审核 Agent。</p> : null}
    {workersError ? <div className="lumo-cluster-feedback error" role="alert">{workersError}</div> : null}
    {error ? <div className="lumo-cluster-feedback error" role="alert">{error}</div> : null}
    {created ? <div className="lumo-run-review-receipt" role="status"><b>{['COMPLETED', 'FAILED', 'CANCELLED', 'BLOCKED'].includes(created.run.state) ? runStateLabels[created.run.state] : '审核任务已创建，等待审核 Agent 执行并提交结论。'}</b><span>审核 Run：{created.run.id} · {runStateLabels[created.run.state] ?? created.run.state}</span>{reviewResult ? <p>{reviewResult.summary}</p> : null}{created.run.state === 'COMPLETED' ? <p>审核执行已结束。审核结论与原任务验收分别记录，请打开任务核对证据。</p> : null}<div><button type="button" className="lumo-button lumo-secondary lumo-small" onClick={() => onOpen(created.task)}>打开审核任务 · {created.task.title || created.task.id}</button> <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={refreshing} onClick={() => void refreshReview()}>{refreshing ? '正在读取审核状态…' : '刷新审核状态'}</button> <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={refreshing} onClick={() => setConfirmNewRound(true)}>新建另一轮审核</button></div>{refreshError ? <p role="alert">{refreshError}</p> : null}{confirmNewRound ? <div className="lumo-inline-confirm"><p>这会创建另一项独立审核任务，已安排的审核任务会继续保留。</p><span><button type="button" className="lumo-button lumo-secondary lumo-small" onClick={() => setConfirmNewRound(false)}>返回</button><button type="button" className="lumo-button lumo-secondary lumo-small" disabled={refreshing} onClick={beginNewRound}>确认新建一轮</button></span></div> : null}</div> : null}
  </section>
}

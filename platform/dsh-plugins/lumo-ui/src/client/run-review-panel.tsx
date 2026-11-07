import { useRef, useState, type FormEvent } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export interface ReviewActor { realm: string; userId: string }
export interface ReviewWorker { worker_id: string; worker_kind: 'human' | 'agent'; display_name: string; status: string; eligible: boolean }
interface ReviewTask { id: string; title: string; project_id?: string; assignee_worker_id?: string }
interface ReviewRun { id: string; task_id: string; worker_id: string; state: string }
interface ReviewCreated<T> { task: T; run: ReviewRun }

/** Derive a permanent key for this exact review request. Remounts, refreshed
 * pages and simultaneous tabs all retry the same server receipt. Identity here
 * only separates browser requests; the proxy supplies the trusted caller. */
export async function runReviewRequestKey(actor: ReviewActor, taskID: string, runID: string, workerID: string, epoch = ''): Promise<string> {
  if (!actor.realm || !actor.userId || !taskID || !runID || !/^agent:[A-Za-z0-9._-]{1,128}$/u.test(workerID)) throw new Error('无法确认审核请求的身份与范围。')
  const bytes = new TextEncoder().encode(JSON.stringify(['lumo-run-review-v1', actor.realm, actor.userId, taskID, runID, workerID, epoch]))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return `ui-review:${Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('')}`
}

export function RunReviewPanel<T extends ReviewTask>({ request, actor, taskID, projectID, run, workers, workersError = '', onOpen }: {
  request: Request; actor: ReviewActor | null; taskID: string; projectID?: string | undefined
  run: { id: string; worker_id: string; state: string }; workers: ReviewWorker[]; workersError?: string
  onOpen: (task: T) => void
}) {
  const [selected, setSelected] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState<ReviewCreated<T> | null>(null)
  const [confirmNewRound, setConfirmNewRound] = useState(false)
  const requestScope = useRef<string | null>(null)
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
      requestScope.current = `lumo:review-epoch:${baseKey}`
      let epoch: string
      try { epoch = localStorage.getItem(requestScope.current) ?? '' }
      catch { throw new Error('无法恢复此前的审核请求，请检查浏览器存储是否可用。') }
      if (epoch && !/^[a-f0-9-]{36}$/u.test(epoch)) throw new Error('此前的审核请求记录无法读取，请联系管理员。')
      const key = epoch ? await runReviewRequestKey(actor, taskID, run.id, workerID, epoch) : baseKey
      const result = await request<ReviewCreated<T>>(`/lumo/api/tasks/${encodeURIComponent(taskID)}/runs/${encodeURIComponent(run.id)}/review-tasks`, {
        method: 'POST', headers: { 'Idempotency-Key': key }, body: JSON.stringify({ reviewer_worker_id: workerID }),
      })
      if (!result?.task?.id || !result.run?.id || result.run.task_id !== result.task.id || result.task.project_id !== projectID
        || result.run.worker_id !== workerID || result.task.assignee_worker_id !== workerID) throw new Error('审核任务响应与本次请求不一致，请重试读取原请求。')
      setCreated(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { pending.current = false; setBusy(false) }
  }
  function beginNewRound() {
    if (!requestScope.current || !created || busy) return
    try {
      localStorage.setItem(requestScope.current, crypto.randomUUID())
      setCreated(null); setConfirmNewRound(false); setError('')
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
    {created ? <div className="lumo-run-review-receipt" role="status"><b>审核任务已创建，等待审核 Agent 执行并提交结论。</b><span>审核 Run：{created.run.id} · {created.run.state}</span><div><button type="button" className="lumo-button lumo-secondary lumo-small" onClick={() => onOpen(created.task)}>打开审核任务 · {created.task.title || created.task.id}</button> <button type="button" className="lumo-button lumo-secondary lumo-small" onClick={() => setConfirmNewRound(true)}>新建另一轮审核</button></div>{confirmNewRound ? <div className="lumo-inline-confirm"><p>这会创建另一项独立审核任务，已安排的审核任务会继续保留。</p><span><button type="button" className="lumo-button lumo-secondary lumo-small" onClick={() => setConfirmNewRound(false)}>返回</button><button type="button" className="lumo-button lumo-secondary lumo-small" onClick={beginNewRound}>确认新建一轮</button></span></div> : null}</div> : null}
  </section>
}

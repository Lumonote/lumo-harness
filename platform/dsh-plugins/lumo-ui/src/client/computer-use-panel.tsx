import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { ComputerUseStatus } from '../computer-use-api.ts'
import { getComputerUseServices, subscribeComputerUseServices, type ComputerUseClientServices } from './computer-use-services.ts'
import './computer-use-panel.css'
import { RemoteComputerPanel } from './remote-computer-panel.tsx'

const EMPTY_SESSIONS: ReturnType<ComputerUseClientServices['sessions']['list']['getSnapshot']> = { phase: 'pending', byId: {} }
const PHASES = { disabled: '已关闭', ready: '等待当前对话调用', running: '正在操作电脑', stopping: '正在停止，等待已发出的操作结束' }
const STATES = { started: '开始', succeeded: '完成', failed: '失败', cancelled: '已取消', denied: '已阻止' }
const subscribeServices = (listener: () => void) => subscribeComputerUseServices(window, listener)
const getServices = () => getComputerUseServices(window)

function failure(code: string): string {
  if (code === 'browser_auth_required') return '本机浏览器登录已失效，请重新打开桌面端或使用启动链接登录。'
  if (code === 'computer_use_local_only') return '电脑操作目前仅在本机部署中提供。'
  if (code === 'browser_auth_unavailable') return '浏览器登录服务尚未就绪，请稍后重试。'
  if (code === 'COMPUTER_USE_BUSY') return '另一对话仍在操作电脑，请先停止它。'
  if (code === 'COMPUTER_USE_STOPPING') return '操作还在停止中，请等待结束后再授权。'
  if (code === 'session_required') return '当前对话尚未就绪，请返回对话后重试。'
  if (code === 'same_origin_required') return '页面来源校验失败，请从桌面端重新打开此页面。'
  if (code === 'computer_use_unavailable') return '电脑操作服务尚未就绪，请稍后重试。'
  if (code === 'computer_use_provider_unavailable') return '本机电脑操作驱动尚未就绪，请检查插件状态后重试。'
  if (code === 'computer_use_control_conflict') return '电脑操作授权已更新，请刷新状态后重新授权。'
  if (code === 'computer_use_invalid_status') return '电脑操作状态响应无效，请重新读取后再授权。'
  return '暂时无法同步电脑操作状态，请重试。'
}
function time(at: number): string { return new Date(at).toLocaleTimeString('zh-CN', { hour12: false }) }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function timestamp(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 8.64e15 }
function session(value: unknown): value is string { return typeof value === 'string' && /^[^\s\u0000-\u001f\u007f]{1,256}$/u.test(value) }
function validStatus(value: unknown): value is ComputerUseStatus {
  if (!record(value) || typeof value.enabled !== 'boolean' || typeof value.nativeSupport !== 'boolean'
    || typeof value.platform !== 'string' || !(value.provider === null || typeof value.provider === 'string')
    || typeof value.phase !== 'string' || !['disabled', 'ready', 'running', 'stopping'].includes(value.phase)
    || !(value.authorizedSessionId === null || session(value.authorizedSessionId))
    || !(value.ownerSessionId === null || session(value.ownerSessionId))
    || !(value.startedAt === null || timestamp(value.startedAt)) || !(value.lastActivityAt === null || timestamp(value.lastActivityAt))
    || !Number.isSafeInteger(value.inFlight) || (value.inFlight as number) < 0
    || !Number.isSafeInteger(value.controlRevision) || (value.controlRevision as number) < 0 || !Array.isArray(value.events)) return false
  if (value.enabled !== (value.authorizedSessionId !== null)
    || (value.phase === 'disabled' && value.enabled) || (['ready', 'running'].includes(value.phase) && !value.enabled)) return false
  return value.events.every(event => record(event) && Number.isSafeInteger(event.id) && (event.id as number) >= 0
    && timestamp(event.at) && typeof event.sessionId === 'string' && typeof event.callId === 'string' && typeof event.tool === 'string'
    && (event.method === null || typeof event.method === 'string') && typeof event.state === 'string' && ['started', 'succeeded', 'failed', 'cancelled', 'denied'].includes(event.state)
    && (event.code === undefined || typeof event.code === 'string'))
}

/** Human consent only: this page never invokes computer tools or requests OS permissions. */
export function ComputerUsePanel({ onClose }: { onClose(): void }) {
  const services = useSyncExternalStore(subscribeServices, getServices, () => undefined)
  const sessions = useSyncExternalStore(
    listener => services?.sessions.list.subscribe(listener) ?? (() => {}),
    () => services?.sessions.list.getSnapshot() ?? EMPTY_SESSIONS,
  )
  const selectedId = sessions.phase === 'ready' ? Object.keys(sessions.byId).find(id => (sessions.byId[id]?.retainedBy?.['mainView'] ?? 0) > 0) : undefined
  const selectedTitle = selectedId === undefined ? undefined : sessions.byId[selectedId]?.displayTitle ?? selectedId
  return <ScopedComputerUsePanel key={selectedId ?? ''} services={services} selectedId={selectedId} selectedTitle={selectedTitle} onClose={onClose} />
}

function ScopedComputerUsePanel({ services, selectedId, selectedTitle, onClose }: {
  services: ComputerUseClientServices | undefined; selectedId: string | undefined; selectedTitle: string | undefined; onClose(): void
}) {
  const [loaded, setLoaded] = useState<{ services: ComputerUseClientServices | undefined; value: ComputerUseStatus }>()
  const snapshot = loaded?.services === services ? loaded?.value : undefined
  const [verified, setVerified] = useState(false)
  const [error, setError] = useState('')
  const [pending, setPending] = useState<'status' | 'enable' | 'stop' | null>('status')
  const active = useRef(false)
  const generation = useRef(0)
  const request = useRef<AbortController>()
  const mutation = useRef(false)
  const refresh = useCallback(async (action: 'status' | 'enable' | 'stop' = 'status', sessionId?: string, controlRevision?: number): Promise<void> => {
    if (!active.current || (action === 'status' && (mutation.current || request.current !== undefined)) || (action === 'enable' && mutation.current)) return
    request.current?.abort()
    const controller = new AbortController()
    request.current = controller
    const version = ++generation.current
    mutation.current = action !== 'status'
    setPending(action)
    let timedOut = false
    let authenticationFailed = false
    const deadline = window.setTimeout(() => { timedOut = true; controller.abort() }, 10_000)
    controller.signal.addEventListener('abort', () => window.clearTimeout(deadline), { once: true })
    try {
      const response = await fetch(`/lumo/api/computer-use${action === 'status' ? '' : `/${action}`}`, {
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
        ...(action === 'status' ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(action === 'enable' ? { sessionId, controlRevision } : {}) }),
      })
      authenticationFailed = response.status === 401 || response.status === 403
      const value: unknown = await response.json()
      if (!response.ok) throw Error(record(value) && typeof value.error === 'string' ? value.error : authenticationFailed ? 'browser_auth_required' : '')
      if (!active.current || generation.current !== version) return
      if (!validStatus(value) || (action === 'enable' && (!value.enabled || value.authorizedSessionId !== sessionId || value.controlRevision !== (controlRevision ?? -1) + 1))
        || (action === 'stop' && (value.enabled || value.authorizedSessionId !== null))) throw Error('computer_use_invalid_status')
      setLoaded({ services, value })
      setVerified(true)
      setError('')
    } catch (reason) {
      if (!active.current || generation.current !== version || (controller.signal.aborted && !timedOut)) return
      setVerified(false)
      if (authenticationFailed) setLoaded(undefined)
      setError(timedOut ? '电脑操作状态读取超时，请重试。' : failure(reason instanceof Error ? reason.message : ''))
    } finally {
      window.clearTimeout(deadline)
      if (active.current && generation.current === version) { mutation.current = false; request.current = undefined; setPending(null) }
    }
  }, [services])
  useEffect(() => {
    active.current = true
    setLoaded(undefined); setVerified(false); setError('')
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 2000)
    return () => { active.current = false; generation.current++; request.current?.abort(); request.current = undefined; mutation.current = false; window.clearInterval(timer) }
  }, [refresh])
  const openPlugins = () => {
    try {
      if (services === undefined) throw Error('not_ready')
      services.layout.selectPanel('plugins')
      onClose()
    } catch { setError('插件面板尚未就绪，请稍后重试。') }
  }
  const stopping = snapshot?.phase === 'stopping'
  const busy = pending === 'enable' || pending === 'stop'
  const providerReady = snapshot?.nativeSupport === true && ((snapshot.platform === 'darwin' && snapshot.provider === 'dsh-cua') || (snapshot.platform === 'win32' && snapshot.provider === 'lumo-cua-windows'))
  const canEnable = verified && providerReady && selectedId !== undefined && session(selectedId) && !stopping && !busy
  const alreadyAuthorized = snapshot?.enabled === true && snapshot.authorizedSessionId === selectedId
  const events = snapshot?.events.slice(-50).reverse() ?? []
  return <section className="lumo-computer" aria-labelledby="lumo-computer-title">
    <header className="lumo-computer-heading"><div><h1 id="lumo-computer-title">电脑操作</h1><p>让当前对话通过 Computer Use 操作本机应用。</p></div><button type="button" className="lumo-secondary" onClick={onClose}>返回对话</button></header>
    {error ? <div className="lumo-computer-error" role="alert"><span>{error}{snapshot ? ' 下方保留上次成功读取的状态。' : ''}</span><button type="button" className="lumo-secondary" disabled={busy} onClick={() => { void refresh() }}>重试</button></div> : null}
    <section className="lumo-computer-control" aria-label="本机电脑操作控制">
      <div className="lumo-computer-phase" data-phase={snapshot?.phase ?? 'loading'} role="status" aria-live="polite"><span aria-hidden="true" /><strong>{snapshot ? PHASES[snapshot.phase] : '正在读取本机状态…'}</strong></div>
      <dl className="lumo-computer-facts"><div><dt>当前对话</dt><dd>{selectedTitle ?? '请先打开一个对话'}</dd></div><div><dt>已授权对话</dt><dd>{snapshot?.authorizedSessionId ?? '未授权'}</dd></div><div><dt>占用对话</dt><dd>{snapshot?.ownerSessionId ?? '无'}</dd></div><div><dt>进行中的操作</dt><dd>{snapshot?.inFlight ?? '—'}</dd></div><div><dt>电脑控制</dt><dd>{providerReady ? '已连接' : '尚未启用'}</dd></div></dl>
      <div className="lumo-computer-actions"><button type="button" className="lumo-button" disabled={!canEnable || alreadyAuthorized} onClick={() => { if (canEnable && !alreadyAuthorized) void refresh('enable', selectedId, snapshot?.controlRevision) }}>{pending === 'enable' ? '正在授权…' : alreadyAuthorized ? '当前对话已获授权' : '允许当前对话操作电脑'}</button><button type="button" className="lumo-secondary lumo-computer-stop" disabled={snapshot === undefined || pending === 'stop' || stopping} onClick={() => { void refresh('stop') }}>{stopping || pending === 'stop' ? '正在停止…' : '立即停止'}</button></div>
      <p className="lumo-computer-note">授权仅适用于上方对话；停止后需重新授权。停止会阻止后续调用，并等待已发出的操作退出。</p>
    </section>
    <section className="lumo-computer-setup" aria-labelledby="lumo-computer-setup"><div><h2 id="lumo-computer-setup">启用操作能力</h2><p>{snapshot?.platform === 'win32' ? 'Windows 需要在已登录的交互桌面启用本机驱动，再授权当前对话。目标应用应以普通用户权限运行；UAC 安全桌面和管理员窗口不在授权范围内。驱动清理异常后需重启桌面端。' : snapshot?.nativeSupport === false ? '此系统尚无已验证的电脑操作驱动。macOS 需要 14 及以上版本。' : '需要 macOS 14 及以上。在插件 → 更多 → Computer Use 中启用插件，调用模式选择 PTC。首次使用时按系统提示授予辅助功能和屏幕录制权限。'}</p><p>返回已授权对话描述任务即可。应用的访问范围由 Computer Use 授权界面管理。</p></div><button type="button" className="lumo-secondary" disabled={services === undefined} onClick={openPlugins}>前往插件</button></section>
    <RemoteComputerPanel />
    <section className="lumo-computer-events" aria-labelledby="lumo-computer-events"><header><h2 id="lumo-computer-events">最近操作</h2><span>最多显示 50 条</span></header>{events.length === 0 ? <p className="lumo-computer-empty">暂无电脑操作记录。</p> : <ol>{events.map(event => <li key={event.id} data-state={event.state}><time dateTime={new Date(event.at).toISOString()}>{time(event.at)}</time><div><strong>{event.method ?? event.tool}</strong><span>{event.sessionId}</span>{event.code ? <code>{event.code}</code> : null}</div><span>{STATES[event.state]}</span></li>)}</ol>}</section>
  </section>
}

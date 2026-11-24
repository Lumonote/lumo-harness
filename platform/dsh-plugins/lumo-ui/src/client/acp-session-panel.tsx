/**
 * ACP 引擎会话面板（P1）：选择引擎（Claude Code / Codex / Gemini CLI …）→ 在工作区里开会话 → 流式显示回复与工具调用，
 * 权限请求就地按 P0-1 Ask 的选项作答。独立组件文件，index.tsx 只挂一行。
 *
 * 后端：/lumo/api/acp/*（dsh-plugins/acp-engines/src/routes.ts）。
 * 开关：localStorage `lumo.acpEngines = 'off'`（或 URL `?acp=off`）隐藏本面板；服务端 LUMO_ACP_ENGINES=off 时接口回 501，面板显示说明。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Section } from './surface-shell.tsx'

export const ACP_FLAG = 'lumo.acpEngines'
export const ACP_ENGINE_PREF = 'lumo.acpEngine'
const DESKTOP_PENDING = 'lumo.acpPending'
const DESKTOP_EVENT = 'lumo:acp-open'

export function acpPanelEnabled(): boolean {
  try {
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('acp') === 'off') return false
    if (typeof localStorage !== 'undefined' && localStorage.getItem(ACP_FLAG) === 'off') return false
  } catch { /* 读不到存储用默认 */ }
  return true
}

export interface EngineProbeView { id: string; label: string; protocol: string; available: boolean; reason?: string; authHint?: string }
interface SessionView { id: string; engineId: string; state: string; cwd: string }
interface AskView { id: string; title: string; detail?: string; status: string; options?: Array<{ id: string; label: string }>; source: { session_ref?: string } }
export type TranscriptItem =
  | { kind: 'text'; role: 'agent' | 'user' | 'thought'; text: string }
  | { kind: 'tool'; toolCallId: string; title: string; status: string }
  | { kind: 'notice'; text: string }

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } })
  const body = await res.json().catch(() => ({})) as T & { error?: string }
  if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`)
  return body
}

/** 纯函数：把一条会话事件并入转写（合并相邻同角色文本块、按 toolCallId 更新工具状态）。便于单测。 */
export function reduceTranscript(items: TranscriptItem[], event: Record<string, unknown>): TranscriptItem[] {
  switch (event.type) {
    case 'message.chunk': {
      const role = event.role as 'agent' | 'user' | 'thought'
      const text = String(event.text ?? '')
      const last = items[items.length - 1]
      if (last && last.kind === 'text' && last.role === role && role !== 'user') return [...items.slice(0, -1), { ...last, text: last.text + text }]
      return [...items, { kind: 'text', role, text }]
    }
    case 'tool.call': return [...items, { kind: 'tool', toolCallId: String(event.toolCallId), title: String(event.title ?? event.kind ?? '工具调用'), status: String(event.status ?? 'pending') }]
    case 'tool.update': return items.map(i => i.kind === 'tool' && i.toolCallId === event.toolCallId ? { ...i, status: String(event.status ?? i.status), ...(event.title ? { title: String(event.title) } : {}) } : i)
    case 'turn.ended': return event.stopReason === 'end_turn' ? items : [...items, { kind: 'notice', text: `回合结束：${String(event.stopReason)}${event.error ? `（${String(event.error)}）` : ''}` }]
    case 'session.closed': return [...items, { kind: 'notice', text: '会话已关闭' }]
    default: return items
  }
}

export function AcpEngineSelect({ engines, value, onChange, disabled }: { engines: EngineProbeView[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  return <label className="lumo-acp-engine-select">
    <span>引擎</span>
    <select value={value} disabled={disabled} onChange={e => onChange(e.target.value)} aria-label="选择 Agent 引擎">
      {engines.map(e => <option key={e.id} value={e.id} disabled={!e.available}>{e.label}{e.available ? '（已检测到入口）' : '（不可用）'}</option>)}
    </select>
  </label>
}

export function AcpSessionSection() {
  return acpPanelEnabled() ? <Section title="引擎会话" meta="ACP 编码助手"><AcpSessionPanel /></Section> : null
}

export function AcpSessionPanel({ defaultCwd = '' }: { defaultCwd?: string }) {
  const [engines, setEngines] = useState<EngineProbeView[]>([])
  const [engineId, setEngineId] = useState<string>(() => { try { return localStorage.getItem(ACP_ENGINE_PREF) ?? 'claude-code' } catch { return 'claude-code' } })
  const [cwd, setCwd] = useState(defaultCwd)
  const [session, setSession] = useState<SessionView | undefined>()
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [asks, setAsks] = useState<AskView[]>([])
  const [text, setText] = useState('')
  const [running, setRunning] = useState(false)
  const [error, setError] = useState<string | undefined>()
  const [unavailable, setUnavailable] = useState<string | undefined>()
  const seq = useRef(0)

  useEffect(() => {
    call<{ engines: EngineProbeView[] }>('/lumo/api/acp/engines').then(r => {
      if (!Array.isArray(r?.engines)) throw new Error('引擎列表响应无效')
      setEngines(r.engines)
    }).catch(e => setUnavailable(e instanceof Error ? e.message : String(e)))
  }, [])

  const refreshAsks = useCallback(() => {
    call<{ asks: AskView[] }>('/lumo/api/acp/asks?status=pending').then(r => setAsks(r.asks.filter(a => !session || a.source.session_ref === session.id)), () => undefined)
  }, [session])

  useEffect(() => {
    if (!session) return
    const source = new EventSource(`/lumo/api/acp/sessions/${session.id}/events?after=${seq.current}`)
    source.addEventListener('session', (raw: MessageEvent) => {
      const event = JSON.parse(raw.data) as Record<string, unknown>
      seq.current = Number(raw.lastEventId) || seq.current
      setItems(prev => reduceTranscript(prev, event))
      if (event.type === 'turn.started') setRunning(true)
      if (event.type === 'turn.ended') setRunning(false)
      if (event.type === 'permission.ask' || event.type === 'permission.resolved') refreshAsks()
      if (event.type === 'session.closed') { setRunning(false); setSession(undefined); source.close() }
    })
    source.addEventListener('gone', () => { source.close(); setSession(undefined) })
    return () => source.close()
  }, [session, refreshAsks])

  const choose = (id: string) => { setEngineId(id); try { localStorage.setItem(ACP_ENGINE_PREF, id) } catch { /* 忽略 */ } }

  const start = useCallback(async (engine = engineId, dir = cwd) => {
    setError(undefined)
    try {
      const r = await call<{ session: SessionView }>('/lumo/api/acp/sessions', { method: 'POST', body: JSON.stringify({ engineId: engine, cwd: dir }) })
      seq.current = 0; setItems([]); setSession(r.session)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [engineId, cwd])

  // 桌面端（desktop/src/acp_launch.rs）投递的「新建会话」：挂载时消费 sessionStorage，已挂载时听事件。
  const startRef = useRef(start)
  startRef.current = start
  const sessionRef = useRef(session)
  sessionRef.current = session
  useEffect(() => {
    const take = (detail: unknown) => {
      const d = detail as { engineId?: unknown; cwd?: unknown; at?: unknown } | null
      if (!d || typeof d.engineId !== 'string' || typeof d.cwd !== 'string') return
      if (typeof d.at === 'number' && Date.now() - d.at > 5 * 60_000) return // 过期的投递不再执行
      try { sessionStorage.removeItem(DESKTOP_PENDING) } catch { /* 忽略 */ }
      if (sessionRef.current) { setError('已有进行中的引擎会话，请先结束再从桌面端新建'); return }
      setEngineId(d.engineId); setCwd(d.cwd)
      void startRef.current(d.engineId, d.cwd)
    }
    try { const raw = sessionStorage.getItem(DESKTOP_PENDING); if (raw) take(JSON.parse(raw)) } catch { /* 忽略 */ }
    const onOpen = (e: Event) => take((e as CustomEvent).detail)
    window.addEventListener(DESKTOP_EVENT, onOpen)
    return () => window.removeEventListener(DESKTOP_EVENT, onOpen)
  }, [])

  const send = async () => {
    if (!session || text.trim() === '') return
    setError(undefined)
    try { await call(`/lumo/api/acp/sessions/${session.id}/prompt`, { method: 'POST', body: JSON.stringify({ text }) }); setText('') } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const cancel = async () => { if (session) await call(`/lumo/api/acp/sessions/${session.id}/cancel`, { method: 'POST', body: '{}' }).catch(() => undefined) }
  const close = async () => { if (session) await call(`/lumo/api/acp/sessions/${session.id}/close`, { method: 'POST', body: '{}' }).catch(() => undefined); setSession(undefined) }
  const answer = async (ask: AskView, value: string) => {
    try { await call(`/lumo/api/acp/asks/${encodeURIComponent(ask.id)}/answer`, { method: 'POST', body: JSON.stringify({ value }) }) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
    refreshAsks()
  }

  if (unavailable) return <div className="lumo-workspace-note" role="status">ACP 引擎会话不可用：{unavailable}</div>
  const current = engines.find(e => e.id === engineId)
  return <div className="lumo-acp-panel">
    <div className="lumo-acp-toolbar" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
      <AcpEngineSelect engines={engines} value={engineId} onChange={choose} disabled={session !== undefined} />
      <input value={cwd} onChange={e => setCwd(e.target.value)} placeholder="工作区绝对路径" aria-label="工作区目录" disabled={session !== undefined} style={{ flex: 1, minWidth: 220 }} />
      {session ? <button type="button" onClick={() => void close()}>结束会话</button> : <button type="button" onClick={() => void start()} disabled={!current?.available || cwd.trim() === ''}>开始会话</button>}
    </div>
    {current && !current.available ? <small role="note">{current.reason}{current.authHint ? ` · ${current.authHint}` : ''}</small> : null}
    {!session && current?.id === 'workbuddy' && current.available ? <small role="note">已找到 WorkBuddy 内置 CLI，尚未确认 ACP 连接。它与独立的 CodeBuddy Code 是不同的入口。</small> : null}
    {error ? <div role="alert" className="lumo-acp-error">{error}</div> : null}
    {asks.length > 0 ? <div className="lumo-acp-asks" role="group" aria-label="待确认的权限请求">
      {asks.map(a => <div key={a.id} className="lumo-acp-ask" style={{ border: '1px solid var(--lumo-warning, #d97706)', borderRadius: 6, padding: 8, margin: '6px 0' }}>
        <strong>{a.title}</strong>
        {a.detail ? <pre style={{ maxHeight: 160, overflow: 'auto', whiteSpace: 'pre-wrap' }}>{a.detail}</pre> : null}
        <div style={{ display: 'flex', gap: 6 }}>{(a.options ?? []).map(o => <button key={o.id} type="button" onClick={() => void answer(a, o.id)}>{o.label}</button>)}</div>
      </div>)}
    </div> : null}
    <div className="lumo-acp-transcript" role="log" aria-live="polite" style={{ maxHeight: 420, overflow: 'auto' }}>
      {items.map((item, i) => item.kind === 'text'
        ? <div key={i} className={`lumo-acp-msg lumo-acp-${item.role}`} style={{ whiteSpace: 'pre-wrap', opacity: item.role === 'thought' ? 0.65 : 1, fontWeight: item.role === 'user' ? 600 : 400 }}>{item.text}</div>
        : item.kind === 'tool'
          ? <div key={i} className="lumo-acp-tool" style={{ fontFamily: 'monospace', fontSize: 12 }}>⚙ {item.title} · {item.status}</div>
          : <div key={i} className="lumo-acp-notice" style={{ fontSize: 12, opacity: 0.7 }}>{item.text}</div>)}
    </div>
    {session ? <div className="lumo-acp-compose" style={{ display: 'flex', gap: 8 }}>
      <textarea value={text} onChange={e => setText(e.target.value)} rows={3} style={{ flex: 1 }} aria-label="发送给引擎"
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void send() } }} />
      {running ? <button type="button" onClick={() => void cancel()}>停止</button> : <button type="button" onClick={() => void send()} disabled={text.trim() === ''}>发送</button>}
    </div> : null}
  </div>
}

import { removeConversationDraft, readDraft, useConversationDraft, writeDraft } from './conversation-drafts.ts'
import type { PromptContext } from '../../../acp-engines/src/prompt-context.ts'
import type { ChatAttachment } from '../../../acp-engines/src/chat-attachments.ts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { acpCall, historyNotice, reduceTranscript, scopeKey, type AskView, type SessionIdentity, type SessionView, type TranscriptItem } from './acp-session-state.ts'

const errorText = (e: unknown) => e instanceof Error ? e.message : String(e)
const post = (body: unknown = {}, signal?: AbortSignal): RequestInit => ({ method: 'POST', body: JSON.stringify(body), ...(signal ? { signal } : {}) })

/** 操作、身份和选择使用同一代次；同步 ref 在 React 下一次渲染前拦住重复新建。 */
export function useAcpSession(identityKey: string, onIdentity?: (key: string) => void) {
  const identityChanged = useRef(onIdentity); identityChanged.current = onIdentity
  const [sessions, setSessions] = useState<SessionView[]>([])
  const [session, setSession] = useState<SessionView>()
  const [items, setItems] = useState<TranscriptItem[]>([])
  const [asks, setAsks] = useState<AskView[]>([])
  const draftKey = `${session ? scopeKey(session) : identityKey}:session:${session?.id ?? 'new'}`
  const [text, setText, draftError] = useConversationDraft(draftKey, 'text', '')
  const [hasMore, setHasMore] = useState(false)
  const oldest = useRef<number>()
  const historyEvents = useRef<Array<{seq: number; event: Record<string, unknown>}>>([])
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string>()
  const [connection, setConnection] = useState('')
  const [streamEpoch, setStreamEpoch] = useState(0)
  const selected = useRef<SessionView>()
  const seq = useRef(0)
  const generation = useRef(0)
  const operation = useRef<AbortController>()
  const pendingSessionId = useRef<string>()
  const pendingPrompt = useRef<AbortController>()
  const source = useRef<EventSource>()
  const identity = useRef<string>()
  const alive = useRef(false)
  const listVersion = useRef(0)

  const clear = useCallback(() => {
    ++generation.current; ++listVersion.current
    operation.current?.abort(); operation.current = undefined; pendingPrompt.current = undefined; pendingSessionId.current = undefined
    source.current?.close(); source.current = undefined
    selected.current = undefined; seq.current = 0
    setStreamEpoch(value => value + 1)
    setSession(undefined); setItems([]); setAsks([]); historyEvents.current = []; setHasMore(false); setRunning(false); setBusy(false); setError(undefined); setConnection('')
  }, [])
  const refresh = useCallback(async () => {
    const version = ++listVersion.current
    try {
      const result = await acpCall<{ sessions: SessionView[]; identity: SessionIdentity }>('/lumo/api/acp/sessions')
      if (!alive.current || listVersion.current !== version) return
      if (!Array.isArray(result.sessions) || !result.identity?.realm || !result.identity.userId) throw new Error('会话列表响应无效')
      const key = scopeKey(result.identity)
      if (identity.current !== undefined && identity.current !== key) clear()
      identity.current = key; identityChanged.current?.(key); setSessions(result.sessions.filter(s => scopeKey(s) === key)); setReady(true)
    } catch (e) { if (alive.current && listVersion.current === version) {
      if ([401, 403].includes((e as { status?: number }).status ?? 0)) { clear(); setSessions([]); setReady(false) }
      setError(errorText(e))
    } }
  }, [clear])
  const refreshAsks = useCallback(async (epoch: number, id: string) => {
    try {
      const result = await acpCall<{ asks: AskView[] }>('/lumo/api/acp/asks?status=pending')
      if (alive.current && generation.current === epoch && selected.current?.id === id) setAsks(result.asks.filter(a => a.source.session_ref === id))
    } catch (e) { if (alive.current && generation.current === epoch) setError(errorText(e)) }
  }, [])

  useEffect(() => {
    alive.current = true; identity.current = undefined; clear(); setSessions([]); setReady(false)
    void refresh()
    const timer = setInterval(() => { if (!document.hidden) void refresh() }, 30_000)
    const focus = () => void refresh(); window.addEventListener('focus', focus)
    return () => {
      alive.current = false; ++generation.current; ++listVersion.current
      operation.current?.abort(); operation.current = undefined; pendingPrompt.current = undefined; pendingSessionId.current = undefined; source.current?.close(); source.current = undefined
      clearInterval(timer); window.removeEventListener('focus', focus)
    }
  }, [identityKey, clear, refresh])

  useEffect(() => {
    if (!session) return
    const epoch = generation.current; const id = session.id
    const events = new EventSource(`/lumo/api/acp/sessions/${id}/events?after=${seq.current}`)
    source.current = events
    const current = () => alive.current && generation.current === epoch && selected.current?.id === id
    events.addEventListener('session', (raw: MessageEvent) => {
      if (!current() || !/^\d+$/u.test(raw.lastEventId)) return
      const next = Number(raw.lastEventId)
      if (!Number.isSafeInteger(next) || next <= seq.current) return
      try {
        const event = JSON.parse(raw.data) as Record<string, unknown>
        if (event.sessionId !== id) return
        seq.current = next; historyEvents.current.push({ seq: next, event }); setItems(prev => reduceTranscript(prev, event))
        if (event.type === 'session.models' && event.models && selected.current) {
          const models = event.models as NonNullable<SessionView['models']>
          const next = { ...selected.current, models }
          if (models.currentModelId) next.modelId = models.currentModelId; else delete next.modelId
          selected.current = next; setSession(next)
        }
        if ((event.type === 'session.commands' || event.type === 'session.modes') && selected.current) { const next = { ...selected.current, ...(event.type === 'session.commands' ? { commands: event.commands as SessionView['commands'] } : { modes: event.modes as SessionView['modes'] }) } as SessionView; selected.current = next; setSession(next) }
        if (event.type === 'turn.started') setRunning(true)
        if (event.type === 'turn.ended') setRunning(false)
        if (event.type === 'permission.ask' || event.type === 'permission.resolved') void refreshAsks(epoch, id)
        if (event.type === 'session.closed' && selected.current) { selected.current = { ...selected.current, state: 'closed', historyOnly: true }; setSession(selected.current); setRunning(false); void refresh() }
      } catch { setError('会话事件无法解析，请重新连接') }
    })
    events.addEventListener('reset', (raw: MessageEvent) => {
      if (!current()) return
      try {
        const info = JSON.parse(raw.data) as { session?: SessionView; resetAfter?: number }
        if (info.session?.id !== id || !Number.isSafeInteger(info.resetAfter) || info.resetAfter! < 0) return
        seq.current = info.resetAfter!; historyEvents.current = []
        setItems([{ kind: 'notice', text: '正在从持久化记录补齐断线期间的消息…' }]); setAsks([])
        void acpCall<{events: Array<{seq: number; event: Record<string, unknown>}>; hasMore: boolean; before?: number; seq: number}>(`/lumo/api/acp/sessions/${id}/history?limit=200`).then(history => {
          if (!current() || !Array.isArray(history.events)) return
          const merged = new Map([...history.events, ...historyEvents.current].map(entry => [entry.seq, entry]))
          historyEvents.current = [...merged.values()].sort((a, b) => a.seq - b.seq)
          seq.current = Math.max(seq.current, history.seq); oldest.current = history.before; setHasMore(history.hasMore)
          setItems(historyEvents.current.reduce((all, entry) => reduceTranscript(all, entry.event), [] as TranscriptItem[]))
        }).catch(e => { if (current()) setError(`补齐历史失败：${errorText(e)}。可重新连接后重试。`) })
      } catch { setError('会话恢复信息无法解析') }
    })
    events.addEventListener('hello', (raw: MessageEvent) => {
      if (!current()) return
      try {
        const info = JSON.parse(raw.data) as { session?: SessionView }
        if (info.session?.id !== id || scopeKey(info.session) !== identity.current) { clear(); void refresh(); return }
        // hello 是快照，不推进游标；尾部事件仍由 session 的 id 去重。
        selected.current = { ...info.session, ...(selected.current?.room ? { room: selected.current.room } : {}) }
        setSession(selected.current); setRunning(info.session.state === 'running'); setConnection('');
        if (info.session.historyOnly) events.close(); else void refreshAsks(epoch, id)
      } catch { setError('会话状态无法解析') }
    })
    events.addEventListener('gone', () => { if (current()) { clear(); void refresh() } })
    events.onerror = () => { if (current() && !selected.current?.historyOnly) setConnection('连接中断，正在自动重连') }
    void refreshAsks(epoch, id)
    return () => { events.close(); if (source.current === events) source.current = undefined }
  }, [session?.id, streamEpoch, clear, refresh, refreshAsks])

  const connect = useCallback(async (path: string, payload: unknown = {}, targetId?: string) => {
    clear(); const epoch = generation.current; const controller = new AbortController()
    operation.current = controller; pendingSessionId.current = targetId; setBusy(true)
    try {
      const result = await acpCall<{ session: SessionView }>(path, post(payload, controller.signal))
      if (!alive.current || generation.current !== epoch) return
      if (scopeKey(result.session) !== identity.current) { clear(); void refresh(); return }
      selected.current = result.session; seq.current = 0; setRunning(result.session.state === 'running')
      setItems(result.session.historyIncomplete ? [{ kind: 'notice', text: historyNotice }] : [])
      try {
        const history = await acpCall<{events: Array<{seq: number; event: Record<string, unknown>}>; hasMore: boolean; before?: number; seq: number}>(`/lumo/api/acp/sessions/${result.session.id}/history?limit=200`, { signal: controller.signal })
        if (!alive.current || generation.current !== epoch) return
        if (Array.isArray(history.events)) { historyEvents.current = history.events; seq.current = history.seq; oldest.current = history.before; setHasMore(history.hasMore); setItems(history.events.reduce((all, entry) => reduceTranscript(all, entry.event), result.session.historyIncomplete ? [{ kind: 'notice', text: historyNotice }] as TranscriptItem[] : [] as TranscriptItem[])) }
      } catch (e) { if ((e as {status?: number}).status !== 404 && alive.current && generation.current === epoch) setError(errorText(e)) }
      if (alive.current && generation.current === epoch) setSession(result.session)
      void refresh()
    } catch (e) { if (alive.current && generation.current === epoch) setError(errorText(e)) }
    finally { if (operation.current === controller) { operation.current = undefined; pendingSessionId.current = undefined; if (alive.current) setBusy(false) } }
  }, [clear, refresh])
  const start = useCallback((engineId: string, cwd: string, modelId?: string) => {
    if (!ready || operation.current || selected.current) return
    return connect('/lumo/api/acp/sessions', { engineId, cwd, ...(modelId ? { modelId } : {}) })
  }, [connect, ready])
  const attach = (entry: SessionView) => {
    if (!ready || scopeKey(entry) !== identity.current || selected.current?.id === entry.id) return
    return connect(`/lumo/api/acp/sessions/${entry.id}/attach`, {}, entry.id)
  }
  const action = async (kind: 'prompt' | 'cancel' | 'close' | 'release' | 'delete' | 'resume', entry = selected.current, attachments: ChatAttachment[] = [], context: PromptContext = {}) => {
    if (!entry || entry.room || scopeKey(entry) !== identity.current) return
    if (kind === 'prompt' && (operation.current || selected.current?.id !== entry.id || running || (!text.trim() && !attachments.length && !context.skills?.length && !context.files?.length))) return false
    const signature = JSON.stringify([text, attachments.map(file => file.id), context])
    const prior = readDraft<{signature: string; id: string} | null>(draftKey, 'request', null)
    const request = prior?.signature === signature ? prior : { signature, id: crypto.randomUUID() }
    if (kind === 'prompt') writeDraft(draftKey, 'request', request)
    const epoch = generation.current; setError(undefined)
    const controller = new AbortController()
    if (kind === 'prompt') { operation.current = controller; pendingPrompt.current = controller; setRunning(true) }
    if (kind === 'cancel' && selected.current?.id === entry.id) { pendingPrompt.current?.abort(); pendingPrompt.current = undefined }
    try {
      await acpCall(`/lumo/api/acp/sessions/${entry.id}/${kind}`, post(kind === 'prompt' ? { text, clientMessageId: request.id, ...context, ...(attachments.length ? { attachments } : {}) } : {}, controller.signal))
      if (!alive.current || generation.current !== epoch) return
      if (kind === 'prompt' && controller.signal.aborted) return false
      if (kind === 'cancel') { void refresh() }
      if (kind === 'delete') {
        void removeConversationDraft(`${scopeKey(entry)}:session:${entry.id}`)
        if (selected.current?.id === entry.id || pendingSessionId.current === entry.id) clear()
        void refresh()
      }
      if (kind === 'release' || kind === 'close' || kind === 'resume') {
        if (pendingSessionId.current === entry.id) clear()
        else if (selected.current?.id === entry.id) await connect(`/lumo/api/acp/sessions/${entry.id}/attach`, {}, entry.id)
        void refresh()
      }
      if (kind === 'prompt') { writeDraft(draftKey, 'request', undefined); setText(current => current === text ? '' : current); void refresh() }
      return true
    } catch (e) { if (alive.current && generation.current === epoch) { setError(controller.signal.aborted && kind === 'prompt' ? '发送已取消，草稿已保留；已受理的执行正在停止。' : errorText(e)); if (kind === 'prompt') setRunning(false) } return false }
    finally { if (operation.current === controller) operation.current = undefined; if (pendingPrompt.current === controller) pendingPrompt.current = undefined }
  }
  const setModel = async (modelId: string) => {
    const entry = selected.current
    if (!entry || entry.room || running || operation.current) return
    const epoch = generation.current, controller = new AbortController()
    operation.current = controller; setBusy(true); setError(undefined)
    try {
      const result = await acpCall<{ session: SessionView }>(`/lumo/api/acp/sessions/${entry.id}/model`, post({ modelId }, controller.signal))
      if (!alive.current || generation.current !== epoch || scopeKey(result.session) !== identity.current) return
      selected.current = result.session; setSession(result.session); void refresh()
    } catch (e) { if (alive.current && generation.current === epoch) setError(errorText(e)) }
    finally { if (operation.current === controller) { operation.current = undefined; if (alive.current) setBusy(false) } }
  }
  const answer = async (ask: AskView, value: string) => {
    const epoch = generation.current; const entry = selected.current
    if (!entry || ask.source.session_ref !== entry.id) return
    try { await acpCall(`/lumo/api/acp/asks/${encodeURIComponent(ask.id)}/answer`, post({ value })) }
    catch (e) { if (alive.current && generation.current === epoch) setError(errorText(e)) }
    if (generation.current === epoch) void refreshAsks(epoch, entry.id)
  }
  const loadEarlier = async () => {
    const entry = selected.current, epoch = generation.current
    if (!entry || !hasMore || oldest.current === undefined) return
    try {
      const history = await acpCall<{events: Array<{seq: number; event: Record<string, unknown>}>; hasMore: boolean; before?: number}>(`/lumo/api/acp/sessions/${entry.id}/history?before=${oldest.current}&limit=200`)
      if (!alive.current || generation.current !== epoch) return
      historyEvents.current = [...history.events, ...historyEvents.current].filter((entry, index, entries) => entries.findIndex(candidate => candidate.seq === entry.seq) === index)
      oldest.current = history.before; setHasMore(history.hasMore); setItems(historyEvents.current.reduce((all, entry) => reduceTranscript(all, entry.event), [] as TranscriptItem[]))
    } catch (e) { if (generation.current === epoch) setError(errorText(e)) }
  }
  const continueSession = async (summary: string, engineId: string) => {
    const entry = selected.current; if (!entry || operation.current || running) return
    const signature = JSON.stringify([summary, engineId]), prior = readDraft<{signature: string; id: string} | null>(draftKey, 'continuation', null)
    const request = prior?.signature === signature ? prior : {signature, id: crypto.randomUUID()}
    writeDraft(draftKey, 'continuation', request)
    await connect(`/lumo/api/acp/sessions/${entry.id}/continue`, {summary, engineId, clientRequestId: request.id})
  }
  const metadata = async (value: {title?: string; archived?: boolean; pinned?: boolean}) => {
    const entry = selected.current; if (!entry) return
    try { const result = await acpCall<{session: SessionView}>(`/lumo/api/acp/sessions/${entry.id}/metadata`, post(value)); if (selected.current?.id === entry.id) { selected.current = result.session; setSession(result.session) }; void refresh() } catch (e) { setError(errorText(e)) }
  }
  return { sessions, session, draftKey, draftError, hasMore, loadEarlier, metadata, continueSession, items, asks, text, setText, running, busy, ready, error, setError, connection, refresh, start, attach, clear, action, answer, setModel }
}

import { useEffect, useState, useSyncExternalStore } from 'react'

interface Source<T> { getSnapshot(): T; subscribe(listener: () => void): () => void }
interface Result<T> { ok: boolean; value?: T; error?: { message?: string } }
export interface NativeConversation {
  id: string; displayTitle: string; title?: string; cwd?: string; updatedAt: number; running: boolean; blank?: boolean
  retainedBy?: Readonly<Record<string, number>>
}
export interface ConversationHost {
  sessions: {
    list: Source<{ ids: readonly string[]; byId: Record<string, NativeConversation>; phase: string }>
    refresh(): Promise<void>
    search(query: string, signal: AbortSignal): Promise<Result<{ items: Array<{ sessionId: string }>; hasMore: boolean }>>
    using<T>(id: string, options: { source: string }, operation: (ref: { ready: Promise<{ session: { rename(title: string): Promise<Result<unknown>> } }> }) => Promise<T>): Promise<T>
  }
  workspaces: {
    list: Source<{ items: readonly { workspaceId: string; title?: string; path: string; sessionIds?: readonly string[] }[]; archivedSessionIds: readonly string[]; pinnedSessionIds: readonly string[] }>
    create(input: { path: string }): Promise<{ workspaceId: string }>
  }
  uiWorkspace: {
    openSession(id: string): void; startSession(workspaceId?: string): void
    archiveSession(id: string): Promise<void>; unarchiveSession(id: string): Promise<void>
    pinSession(id: string): Promise<void>; unpinSession(id: string): Promise<void>
    pickDirectory(): Promise<string | null>
  }
  layout: { selectPanel(id: string | null): void; panelInfo?: Source<{ activePanelId: string | null }> }
}
let host: ConversationHost | undefined
const listeners = new Set<() => void>()
const notify = () => listeners.forEach(listener => listener())
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const conversationHost = () => host
export function installConversationHost(value: ConversationHost) {
  host = value; notify()
  return () => { if (host === value) { host = undefined; notify() } }
}
export const useConversationHost = () => useSyncExternalStore(subscribe, conversationHost, () => undefined)
export interface NativeHistoryEntry extends NativeConversation { archived: boolean; pinned: boolean }

/** Metadata remains Host-owned; search results never become a second session database. */
export function useNativeHistory(query: string) {
  const source = useConversationHost()
  const [revision, update] = useState(0)
  const [search, setSearch] = useState<{ source: ConversationHost; query: string; ids?: Set<string>; error?: string; more?: boolean }>()
  useEffect(() => {
    if (!source) return
    const change = () => update(n => n + 1)
    const off = [source.sessions.list.subscribe(change), source.workspaces.list.subscribe(change)]
    if (source.layout.panelInfo) off.push(source.layout.panelInfo.subscribe(change))
    change()
    return () => off.forEach(dispose => dispose())
  }, [source])
  const needle = query.trim()
  useEffect(() => {
    if (!source || !needle) { setSearch(undefined); return }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      void source.sessions.search(needle, controller.signal).then(result => {
        if (controller.signal.aborted) return
        if (!result.ok || !result.value) throw new Error(result.error?.message ?? '原生对话搜索失败')
        setSearch({ source, query: needle, ids: new Set(result.value.items.map(row => row.sessionId)), more: result.value.hasMore })
      }).catch(error => { if (!controller.signal.aborted) setSearch({ source, query: needle, error: String(error) }) })
    }, 200)
    return () => { clearTimeout(timer); controller.abort() }
  }, [source, needle])
  void revision
  const list = source?.sessions.list.getSnapshot(), workspaces = source?.workspaces.list.getSnapshot()
  const activeSearch = search && search.source === source && search.query === needle ? search : undefined
  const entries: NativeHistoryEntry[] = (list?.ids ?? []).flatMap(id => {
    const entry = list?.byId[id]
    if (!entry || entry.blank && !entry.retainedBy?.mainView) return []
    if (needle && !`${entry.displayTitle} ${entry.cwd ?? ''}`.toLowerCase().includes(needle.toLowerCase()) && !activeSearch?.ids?.has(id)) return []
    return [{ ...entry, archived: workspaces?.archivedSessionIds.includes(id) ?? false, pinned: workspaces?.pinnedSessionIds.includes(id) ?? false }]
  })
  return { entries, activePanel: source?.layout.panelInfo?.getSnapshot().activePanelId ?? null, projects: workspaces?.items ?? [], host: source, loading: !!source && !!needle && !activeSearch, error: activeSearch?.error, more: activeSearch?.more }
}

export async function manageNativeConversation(source: ConversationHost, id: string, change: { title?: string; archived?: boolean; pinned?: boolean }) {
  if (source !== host) throw new Error('连接已切换，请重新选择对话')
  if (!source.sessions.list.getSnapshot().byId[id]) throw new Error('对话已不在当前宿主目录中')
  if (change.title !== undefined) await source.sessions.using(id, { source: 'lumoConversationDirectory' }, async ref => {
    const binding = await ref.ready
    if (source !== host) throw new Error('连接已切换，请重新选择对话')
    const result = await binding.session.rename(change.title!.trim())
    if (!result.ok) throw new Error(result.error?.message ?? '重命名失败')
  })
  if (source !== host) throw new Error('连接已切换，请重新选择对话')
  if (change.archived !== undefined) await (change.archived ? source.uiWorkspace.archiveSession(id) : source.uiWorkspace.unarchiveSession(id))
  if (source !== host) throw new Error('连接已切换，请重新选择对话')
  if (change.pinned !== undefined) await (change.pinned ? source.uiWorkspace.pinSession(id) : source.uiWorkspace.unpinSession(id))
}

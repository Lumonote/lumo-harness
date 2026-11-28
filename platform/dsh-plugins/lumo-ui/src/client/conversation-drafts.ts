import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from 'react'

const prefix = 'lumo.conversation.v1:'
const storageKey = (key: string, field: string) => `${prefix}${key}:${field}`
export function readDraft<T>(key: string, field: string, initial: T): T {
  try { const raw = localStorage.getItem(storageKey(key, field)); return raw === null ? initial : JSON.parse(raw) as T } catch { return initial }
}
export function writeDraft(key: string, field: string, value: unknown): boolean {
  try { if (value === undefined) localStorage.removeItem(storageKey(key, field)); else localStorage.setItem(storageKey(key, field), JSON.stringify(value)); return true } catch { return false }
}
/** Identity and conversation are both in the key; selection never carries drafts into another chat. */
export function useConversationDraft<T>(key: string, field: string, initial: T): [T, Dispatch<SetStateAction<T>>, string] {
  const [state, setState] = useState(() => ({ key, value: readDraft(key, field, initial) }))
  const [error, setError] = useState('')
  const current = useRef(state)
  const value = state.key === key ? state.value : readDraft(key, field, initial)
  current.current = { key, value }
  if (state.key !== key) setState({ key, value })
  const set = useCallback<Dispatch<SetStateAction<T>>>(update => {
    const before = current.current.key === key ? current.current.value : readDraft(key, field, initial)
    const next = typeof update === 'function' ? (update as (current: T) => T)(before) : update
    const persisted = writeDraft(key, field, next)
    // An old asynchronous send may clear its own snapshot, never the currently selected draft.
    if (current.current.key !== key) return
    current.current = { key, value: next }; setState(current.current)
    setError(persisted ? '' : '无法保存草稿，请保留当前页面后重试。')
  }, [key, field])
  return [value, set, error]
}

export interface PersistedAttachment { key: string; file: File; uploaded?: import('../../../acp-engines/src/chat-attachments.ts').ChatAttachment }
const attachmentCache = new Map<string, PersistedAttachment[]>()
let database: Promise<IDBDatabase> | undefined
function db() {
  if (typeof indexedDB === 'undefined') return Promise.reject(new Error('浏览器不支持附件草稿持久化'))
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('lumo-conversation-drafts', 1)
    request.onupgradeneeded = () => request.result.createObjectStore('attachments')
    request.onblocked = () => { database = undefined; reject(new Error('附件草稿数据库被其它窗口占用')) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
  })
  return database
}
export function cachedAttachments(key: string) {
  try { if (attachmentCache.has(key) && localStorage.getItem(storageKey(key, 'attachmentKeys')) === null) attachmentCache.delete(key) } catch { /* Memory fallback remains available when storage is unavailable. */ }
  return attachmentCache.get(key)
}
export async function readAttachments(key: string): Promise<PersistedAttachment[]> {
  if (attachmentCache.has(key)) return attachmentCache.get(key)!
  const database = await db()
  return new Promise((resolve, reject) => {
    const request = database.transaction('attachments', 'readonly').objectStore('attachments').get(key)
    request.onsuccess = () => resolve((request.result ?? []) as PersistedAttachment[])
    request.onerror = () => reject(request.error)
  })
}
export async function saveAttachments(key: string, files: PersistedAttachment[]) {
  writeDraft(key, 'attachmentKeys', files.map(file => file.key))
  attachmentCache.set(key, files.map(({ key, file, uploaded }) => ({ key, file, ...(uploaded ? { uploaded } : {}) })))
  const database = await db()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction('attachments', 'readwrite'), store = transaction.objectStore('attachments')
    if (files.length) store.put(attachmentCache.get(key), key); else store.delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

export async function removeConversationDraft(key: string) {
  attachmentCache.delete(key)
  try {
    const beginning = `${prefix}${key}:`
    for (const name of Object.keys(localStorage)) if (name.startsWith(beginning)) localStorage.removeItem(name)
  } catch { /* The server deletion is independent of optional browser persistence. */ }
  try { const database = await db(); database.transaction('attachments', 'readwrite').objectStore('attachments').delete(key) } catch { /* No IndexedDB means the binary draft was memory-only. */ }
}

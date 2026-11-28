import { api, ApiError } from './api.ts'
import { readServerBook, updateServerBook, serverEntry, SERVER_BOOK_KEY, SERVER_BOOK_EVENT, type SavedServer } from './server-book.ts'

export interface SharedServerBook { servers: SavedServer[]; native: boolean }
const endpoint = '/lumo/api/environment/servers'

export async function loadSharedServerBook(desktop: boolean): Promise<SharedServerBook> {
  if (!desktop) return { servers: readServerBook(), native: false }
  let shared: { servers: SavedServer[] }
  try { shared = await api(endpoint) } catch (error) {
    if (error instanceof ApiError && [404, 501].includes(error.status)) return { servers: readServerBook(), native: false }
    throw error
  }
  if (!Array.isArray(shared.servers)) throw Error('本机地址簿响应格式错误，已有记录未被覆盖。')
  shared.servers = shared.servers.map(item => serverEntry(item.name, item.origin))
  const legacy = readServerBook()
  if (legacy.length) {
    shared = await api(endpoint, { method: 'POST', body: JSON.stringify({ merge: legacy }) })
    if (!Array.isArray(shared.servers)) throw Error('本机地址簿迁移响应格式错误，浏览器记录已保留。')
    localStorage.removeItem(SERVER_BOOK_KEY)
  }
  return { servers: shared.servers, native: true }
}

export async function saveSharedServerBook(native: boolean, change: Parameters<typeof updateServerBook>[0]): Promise<SavedServer[]> {
  if (!native) return updateServerBook(change)
  const result = await api<{ servers: SavedServer[] }>(endpoint, { method: 'POST', body: JSON.stringify(change) })
  if (!Array.isArray(result.servers)) throw Error('本机地址簿响应格式错误，请刷新后重试。')
  window.dispatchEvent(new Event(SERVER_BOOK_EVENT))
  return result.servers
}

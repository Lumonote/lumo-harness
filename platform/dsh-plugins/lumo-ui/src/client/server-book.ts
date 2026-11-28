/** Only server addresses are persisted. Authentication belongs to each server's origin. */
export interface SavedServer { name: string; origin: string }
export const SERVER_BOOK_KEY = 'lumo:server-book:v1'
export const SERVER_BOOK_EVENT = 'lumo:server-book-changed'

export function serverOrigin(input: string): string {
  const invalid = () => new Error('请输入 HTTPS 服务器地址；本机 SSH 隧道可使用 HTTP。地址中不能包含账号、路径或登录令牌。')
  if (!input.trim() || input.length > 512 || /[\\\s]/u.test(input.trim())) throw invalid()
  if (input.trim().split('://')[1]?.replace(/\/$/u, '').includes('/')) throw invalid()
  let url: URL
  try { url = new URL(input.trim()) } catch { throw invalid() }
  const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.(?:\d{1,3}\.){2}\d{1,3}$/u.test(url.hostname)
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw invalid()
  return url.origin
}

export function serverEntry(name: string, origin: string): SavedServer {
  if (!name.trim() || name.trim().length > 60) throw Error('服务器名称需为 1–60 个字符。')
  return { name: name.trim(), origin: serverOrigin(origin) }
}

export function readServerBook(storage: Pick<Storage, 'getItem'> = localStorage): SavedServer[] {
  const raw = storage.getItem(SERVER_BOOK_KEY)
  if (raw === null) return []
  try {
    const data: unknown = JSON.parse(raw)
    if (!Array.isArray(data) || data.length > 12) throw Error()
    const entries = data.map(item => serverEntry(item.name, item.origin))
    if (new Set(entries.map(item => item.origin)).size !== entries.length) throw Error()
    return entries
  } catch { throw Error('服务器地址簿无法读取，已有记录未被覆盖。') }
}

export function updateServerBook(change: { save: SavedServer; previous?: string } | { remove: string }, storage: Storage = localStorage): SavedServer[] {
  const entries = readServerBook(storage)
  let next: SavedServer[]
  if ('remove' in change) next = entries.filter(item => item.origin !== change.remove)
  else {
    const entry = serverEntry(change.save.name, change.save.origin)
    if (entries.some(item => item.origin === entry.origin && item.origin !== change.previous)) throw Error('该服务器已在地址簿中。')
    if (change.previous && !entries.some(item => item.origin === change.previous)) throw Error('记录已变化，请刷新后重试。')
    next = change.previous ? entries.map(item => item.origin === change.previous ? entry : item) : [...entries, entry]
    if (next.length > 12) throw Error('最多保存 12 个服务器。')
  }
  storage.setItem(SERVER_BOOK_KEY, JSON.stringify(next))
  window.dispatchEvent(new Event(SERVER_BOOK_EVENT))
  return next
}

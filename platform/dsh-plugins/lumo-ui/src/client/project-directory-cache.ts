import type { ProjectDirectoryResponse } from './project-directory-panel.tsx'

export interface DirectoryActor { realm: string; userId: string }
export interface DirectorySnapshot { path: string; savedAt: number; data: ProjectDirectoryResponse }
const PREFIX = 'lumo.project-directory.v1:'
const MAX_AGE = 24 * 60 * 60 * 1000
const MAX_BYTES = 160_000
const MAX_PAGES = 8

export function directoryCacheKey(actor?: DirectoryActor | null): string | null {
  if (!actor?.realm || !actor.userId) return null
  return PREFIX + JSON.stringify([location.origin, actor.realm, actor.userId])
}

function storage(): Storage | null {
  try { return window.sessionStorage } catch { return null }
}

export function clearDirectoryCache(key: string): void {
  try { storage()?.removeItem(key) } catch { /* Unavailable storage never blocks the live directory. */ }
}

export function readDirectoryCache(key: string, validate: (data: unknown) => data is ProjectDirectoryResponse): DirectorySnapshot[] {
  try {
    const raw = storage()?.getItem(key)
    if (!raw) return []
    if (raw.length > MAX_BYTES) throw Error('oversized')
    const value: unknown = JSON.parse(raw)
    if (!Array.isArray(value) || value.length > MAX_PAGES) throw Error('invalid snapshot')
    const now = Date.now()
    const pages = value.filter((item): item is DirectorySnapshot => item && typeof item.path === 'string'
      && item.path.length < 2048 && Number.isSafeInteger(item.savedAt) && item.savedAt <= now
      && now - item.savedAt < MAX_AGE && validate(item.data) && item.data.projects.length <= 20)
    if (pages.length !== value.length) {
      if (pages.length) storage()?.setItem(key, JSON.stringify(pages))
      else clearDirectoryCache(key)
    }
    return pages
  } catch { clearDirectoryCache(key); return [] }
}

export function saveDirectoryCache(key: string, snapshot: DirectorySnapshot, validate: (data: unknown) => data is ProjectDirectoryResponse): boolean {
  try {
    const store = storage()
    if (!store || !validate(snapshot.data) || snapshot.data.projects.length > 20 || directoryCacheKey(snapshot.data.viewer) !== key || !snapshot.data.viewer) return false
    // Persist only directory fields, never arbitrary fields added to a response.
    const data: ProjectDirectoryResponse = {
      viewer: { realm: snapshot.data.viewer.realm, userId: snapshot.data.viewer.userId },
      projects: snapshot.data.projects.map(({ id, name, status, yourRole, memberCount, createdAt }) => ({ id, name, status, yourRole, memberCount, createdAt })),
      summary: { total: snapshot.data.summary.total, active: snapshot.data.summary.active, archived: snapshot.data.summary.archived },
      total: snapshot.data.total, limit: snapshot.data.limit, offset: snapshot.data.offset, hasMore: snapshot.data.hasMore,
    }
    const clean = { path: snapshot.path, savedAt: snapshot.savedAt, data }
    const pages = [clean, ...readDirectoryCache(key, validate).filter(page => page.path !== snapshot.path)].slice(0, MAX_PAGES)
    while (JSON.stringify(pages).length > MAX_BYTES) pages.pop()
    store.setItem(key, JSON.stringify(pages))
    return pages.includes(clean)
  } catch { return false }
}

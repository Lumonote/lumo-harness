import { useCallback, useEffect, useRef, useState } from 'react'
import { UserDirectoryPagination, userDirectoryURL } from './user-directory.tsx'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
interface DirectoryUser { id: string; display_name: string; status?: string; primary_dept_id?: string }
interface DirectoryPage { users: DirectoryUser[]; total: number; has_more: boolean }

export function DirectoryUserPicker({ request, name = 'manager_user_id', label = '负责人', initialUserId = '', disabled = false }: {
  request: Request; name?: string; label?: string; initialUserId?: string; disabled?: boolean
}) {
  const pageSize = 20
  const [selection, setSelection] = useState<DirectoryUser | null>(() => initialUserId ? { id: initialUserId, display_name: initialUserId } : null)
  const [query, setQuery] = useState('')
  const [search, setSearch] = useState('')
  const [page, setPage] = useState({ users: [] as DirectoryUser[], total: 0, offset: 0, hasMore: false, search: '' })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const root = useRef<HTMLDivElement>(null)
  const searchPending = query.trim() !== search
  const currentPage = page.search === search && !searchPending
  useEffect(() => {
    const timer = window.setTimeout(() => setSearch(query.trim()), 250)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => {
    const form = root.current?.closest('form')
    const reset = () => {
      setSelection(initialUserId ? { id: initialUserId, display_name: initialUserId } : null)
      setQuery(''); setSearch(''); setError('')
    }
    form?.addEventListener('reset', reset)
    return () => form?.removeEventListener('reset', reset)
  }, [initialUserId])
  const load = useCallback(async (offset = 0) => {
    const current = ++sequence.current
    setLoading(true); setError('')
    try {
      const read = (requestedOffset: number) => request<DirectoryPage>(userDirectoryURL({ query: search, status: 'active', limit: pageSize, offset: requestedOffset }))
      let result = await read(offset)
      if (current !== sequence.current) return
      let resolvedOffset = offset
      for (let correction = 0; resolvedOffset > 0 && resolvedOffset >= result.total; correction++) {
        resolvedOffset = correction < 2 ? Math.max(0, Math.floor((result.total - 1) / pageSize) * pageSize) : 0
        result = await read(resolvedOffset)
        if (current !== sequence.current) return
      }
      setPage({ users: result.users ?? [], total: result.total, offset: resolvedOffset, hasMore: result.has_more, search })
      setSelection(selected => selected ? result.users?.find(user => user.id === selected.id) ?? selected : null)
    } catch (reason) { if (current === sequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (current === sequence.current) setLoading(false) }
  }, [request, search])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load])
  const unavailable = disabled || loading || !currentPage
  return <div ref={root} className="lumo-directory-user-picker" role="group" aria-label={`${label}选择`}>
    <input type="hidden" name={name} value={selection?.id ?? ''} />
    <label><span>{label}搜索</span><input value={query} disabled={disabled} maxLength={200} placeholder="搜索姓名或用户 ID" onChange={event => setQuery(event.target.value)} /></label>
    <div className="lumo-user-form-actions"><span className="lumo-section-note">{selection ? `已选择：${selection.display_name} · ${selection.id}` : '未指定负责人'}</span>{selection ? <button type="button" className="lumo-secondary lumo-small" disabled={disabled} onClick={() => setSelection(null)}>清除{label}</button> : null}</div>
    {error ? <div className="lumo-cluster-feedback error" role="alert">{error}<button type="button" className="lumo-secondary lumo-small" disabled={disabled || loading || searchPending} onClick={() => void load(currentPage ? page.offset : 0)}>重试读取{label}</button></div> : null}
    <div className="lumo-organization-users" aria-label={`${label}候选用户`} aria-busy={loading || searchPending}>
      {page.users.map(user => <button type="button" key={user.id} disabled={unavailable || user.status !== 'active'} aria-pressed={selection?.id === user.id} onClick={() => setSelection(user)}><span><b>{user.display_name}</b><small>{user.id}{user.primary_dept_id ? ` · ${user.primary_dept_id}` : ''}</small></span><em>{selection?.id === user.id ? '已选择' : '选择'}</em></button>)}
    </div>
    {!page.users.length && !loading && !error ? <p className="lumo-muted">没有匹配的启用用户。</p> : null}
    <UserDirectoryPagination total={page.total} limit={pageSize} offset={page.offset} hasMore={page.hasMore} loading={unavailable} onOffsetChange={offset => void load(offset)} />
    <p className="lumo-section-note">从当前工作域的启用用户中选择；保留原负责人，直至显式选择或清除。</p>
  </div>
}

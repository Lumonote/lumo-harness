export interface UserDirectoryQuery {
  query?: string
  status?: string
  departmentId?: string
  limit: number
  offset: number
}

export function userDirectoryURL({ query, status, departmentId, limit, offset }: UserDirectoryQuery): string {
  const params = new URLSearchParams({ limit: String(limit), offset: String(offset) })
  if (query?.trim()) params.set('q', query.trim())
  if (status && status !== 'all') params.set('status', status)
  if (departmentId?.trim()) params.set('department_id', departmentId.trim())
  return `/lumo/api/users?${params.toString()}`
}

export interface UserDirectoryPaginationProps {
  total: number
  limit: number
  offset: number
  hasMore: boolean
  loading: boolean
  onOffsetChange: (offset: number) => void
}

export function UserDirectoryPagination({ total, limit, offset, hasMore, loading, onOffsetChange }: UserDirectoryPaginationProps) {
  const range = total > offset ? `第 ${offset + 1}–${Math.min(offset + limit, total)} 位` : '当前页为空'
  return <nav className="lumo-user-form-actions lumo-user-pagination" aria-label="用户列表分页" aria-busy={loading}>
    <span className="lumo-section-note" role="status">共 {total} 位用户 · {range}</span>
    <button type="button" className="lumo-secondary" disabled={loading || offset <= 0} onClick={() => onOffsetChange(Math.max(0, offset - limit))}>上一页</button>
    <button type="button" className="lumo-secondary" disabled={loading || !hasMore} onClick={() => onOffsetChange(offset + limit)}>下一页</button>
  </nav>
}

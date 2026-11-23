import { useEffect, useRef, useState, type FormEvent } from 'react'
import { clearDirectoryCache, directoryCacheKey, readDirectoryCache, saveDirectoryCache, type DirectoryActor } from './project-directory-cache.ts'
import './project-directory-panel.css'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
export interface ProjectDirectoryItem {
  id: string; name: string; status: 'active' | 'archived'; yourRole: 'owner' | 'editor' | 'viewer'
  memberCount: number; createdAt: string
}
export interface ProjectDirectoryResponse {
  viewer?: DirectoryActor
  projects: ProjectDirectoryItem[]
  summary: { total: number; active: number; archived: number }
  total: number; limit: number; offset: number; hasMore: boolean
}
export interface ProjectDirectoryQuery {
  query: string; status: string; role: string; sort: string; limit: number; offset: number
}
export function projectDirectoryURL(query: ProjectDirectoryQuery): string {
  const params = new URLSearchParams({ limit: String(query.limit), offset: String(query.offset), sort: query.sort })
  if (query.query.trim()) params.set('q', query.query.trim())
  if (query.status !== 'all') params.set('status', query.status)
  if (query.role !== 'all') params.set('role', query.role)
  return `/lumo/api/projects/directory?${params}`
}

const roleNames = { owner: '负责人', editor: '编辑成员', viewer: '只读成员' }
const PAGE_SIZE = 20

function isDirectory(value: unknown): value is ProjectDirectoryResponse {
  if (!value || typeof value !== 'object') return false
  const data = value as Partial<ProjectDirectoryResponse>
  const count = (number: unknown) => Number.isSafeInteger(number) && Number(number) >= 0
  return Array.isArray(data.projects) && data.projects.every(project => project && typeof project.id === 'string'
    && typeof project.name === 'string' && ['active', 'archived'].includes(project.status)
    && ['owner', 'editor', 'viewer'].includes(project.yourRole) && count(project.memberCount))
    && Boolean(data.summary && count(data.summary.total) && count(data.summary.active) && count(data.summary.archived))
    && count(data.total) && count(data.offset) && count(data.limit) && Number(data.limit) > 0 && typeof data.hasMore === 'boolean'
}

interface DirectoryProps {
  request: Request; onOpen: (projectID: string) => void; refreshKey?: string | number; openingId?: string; actor?: DirectoryActor | null
}
export function ProjectDirectoryPanel(props: DirectoryProps) {
  const key = directoryCacheKey(props.actor)
  const previous = useRef(key)
  useEffect(() => {
    if (previous.current && previous.current !== key) clearDirectoryCache(previous.current)
    previous.current = key
  }, [key])
  return <ProjectDirectoryContent key={key ?? 'anonymous'} {...props} cacheKey={key} />
}
function ProjectDirectoryContent({ request, onOpen, refreshKey, openingId, actor, cacheKey }: DirectoryProps & { cacheKey: string | null }) {
  const [draftQuery, setDraftQuery] = useState('')
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [role, setRole] = useState('all')
  const [sort, setSort] = useState('recent')
  const [offset, setOffset] = useState(0)
  const [retry, setRetry] = useState(0)
  const [data, setData] = useState<ProjectDirectoryResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [snapshotAt, setSnapshotAt] = useState<number | null>(null)
  const [cacheNotice, setCacheNotice] = useState('')
  const cacheAllowed = useRef(true)
  const path = projectDirectoryURL({ query, status, role, sort, limit: PAGE_SIZE, offset })

  useEffect(() => {
    let current = true
    const controller = new AbortController()
    setLoading(true); setError(''); setData(null); setSnapshotAt(null)
    void request<ProjectDirectoryResponse>(path, { signal: controller.signal }).then(result => {
      if (!current) return
      if (!isDirectory(result)) throw new Error('项目目录响应格式不完整，请重试或检查服务版本。')
      if (actor && result.viewer && (result.viewer.realm !== actor.realm || result.viewer.userId !== actor.userId)) {
        if (cacheKey) clearDirectoryCache(cacheKey)
        cacheAllowed.current = false
        throw new Error('登录身份已变化，请重新打开项目目录。')
      }
      // A project may have been archived/deleted or membership revoked between
      // pages. Move to the last remaining page instead of displaying a dead end.
      if (offset > 0 && offset >= result.total) {
        setOffset(Math.max(0, Math.floor((result.total - 1) / PAGE_SIZE) * PAGE_SIZE))
        return
      }
      setData(result)
      if (cacheKey && cacheAllowed.current && result.viewer?.realm === actor?.realm && result.viewer?.userId === actor?.userId) {
        const saved = saveDirectoryCache(cacheKey, { path, savedAt: Date.now(), data: result }, isDirectory)
        setCacheNotice(saved ? '本次登录的目录快照仅在此标签页保留，最多 24 小时。' : '浏览器未允许保存快照，在线目录仍可使用。')
      }
    }).catch(reason => {
      if (!current) return
      setError(reason instanceof Error ? reason.message : String(reason))
      const status = reason && typeof reason === 'object' && 'status' in reason ? reason.status : undefined
      if (status === 401 || status === 403) {
        if (cacheKey) clearDirectoryCache(cacheKey)
        cacheAllowed.current = false
        setCacheNotice('当前身份无法读取目录，已清除本次登录的快照。')
      } else if (cacheKey && cacheAllowed.current && (reason instanceof TypeError || [502, 503, 504].includes(Number(status)))) {
        const snapshot = readDirectoryCache(cacheKey, isDirectory).find(item => item.path === path
          && item.data.viewer?.realm === actor?.realm && item.data.viewer?.userId === actor?.userId)
        if (snapshot) {
          setData(snapshot.data); setSnapshotAt(snapshot.savedAt)
          setCacheNotice('此快照来自本标签页之前读取的目录，可随时清除。')
        }
      }
    }).finally(() => { if (current) setLoading(false) })
    return () => { current = false; controller.abort() }
  }, [request, path, refreshKey, retry, cacheKey, actor?.realm, actor?.userId])

  useEffect(() => {
    const reconnect = () => setRetry(value => value + 1)
    window.addEventListener('online', reconnect)
    return () => window.removeEventListener('online', reconnect)
  }, [])

  const search = (event: FormEvent) => {
    event.preventDefault(); setOffset(0); setQuery(draftQuery.trim()); setRetry(value => value + 1)
  }
  const reset = () => { setDraftQuery(''); setQuery(''); setStatus('all'); setRole('all'); setOffset(0) }
  const filtered = Boolean(query || status !== 'all' || role !== 'all')
  return <section className="lumo-project-directory" aria-label="项目目录">
    {snapshotAt !== null ? <div className="lumo-cluster-feedback" role="status">正在显示上次读取的目录 · {new Date(snapshotAt).toLocaleString('zh-CN')} · {location.host}。当前权限和项目状态尚未确认，恢复连接后才能打开项目。</div> : null}
    {cacheKey && cacheNotice ? <div className="lumo-project-directory-cache"><small>{cacheNotice}</small><button type="button" className="lumo-button lumo-secondary lumo-small" onClick={() => {
      clearDirectoryCache(cacheKey); cacheAllowed.current = false
      if (snapshotAt !== null) { setData(null); setSnapshotAt(null) }
      setCacheNotice('快照已清除，本次打开目录期间停止保存。')
    }}>清除目录快照</button></div> : null}
    {data ? <div className="lumo-project-directory-summary" aria-label="我的项目统计">
      <span>{snapshotAt !== null ? '上次统计的项目' : '我的项目'} <strong>{data.summary.total}</strong></span><span>进行中 <strong>{data.summary.active}</strong></span><span>已归档 <strong>{data.summary.archived}</strong></span>
    </div> : null}
    <form className="lumo-project-directory-filters" role="search" aria-label="搜索项目" onSubmit={search}>
      <label className="lumo-project-directory-search">项目名称或 ID<input aria-label="搜索项目" value={draftQuery} maxLength={200} placeholder="搜索项目名称或 ID" onChange={event => setDraftQuery(event.target.value)} /></label>
      <label>项目状态<select aria-label="项目状态" value={status} onChange={event => { setStatus(event.target.value); setOffset(0) }}><option value="all">全部状态</option><option value="active">进行中</option><option value="archived">已归档</option></select></label>
      <label>我的角色<select aria-label="我的项目角色" value={role} onChange={event => { setRole(event.target.value); setOffset(0) }}><option value="all">全部角色</option><option value="owner">负责人</option><option value="editor">编辑成员</option><option value="viewer">只读成员</option></select></label>
      <label>排序<select aria-label="项目排序" value={sort} onChange={event => { setSort(event.target.value); setOffset(0) }}><option value="recent">最近创建</option><option value="name">名称顺序</option></select></label>
      <button type="submit" className="lumo-button">搜索</button>
      {filtered ? <button type="button" className="lumo-button lumo-secondary" onClick={reset}>清除筛选</button> : null}
    </form>
    {error ? <div className="lumo-cluster-feedback error" role="alert">项目目录加载失败：{error}<button type="button" className="lumo-button lumo-secondary lumo-small" onClick={() => setRetry(value => value + 1)}>重试</button></div> : null}
    <div className="lumo-project-directory-content" aria-busy={loading}>
      {loading ? <p className="lumo-muted" role="status">正在读取项目…</p> : null}
      {data ? data.projects.length ? <div className="lumo-project-directory-list">{data.projects.map(project => <article key={project.id} className="lumo-project-directory-item">
        <div className="lumo-project-directory-identity"><b>{project.name}</b><small>{project.id}</small></div>
        <div className="lumo-project-directory-meta"><span className="lumo-pill">{project.status === 'archived' ? '已归档' : '进行中'}</span><span>{roleNames[project.yourRole]}</span><span>{project.memberCount} 位成员</span></div>
        <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={snapshotAt !== null || openingId === project.id} aria-label={`打开项目 ${project.name}`} onClick={() => { if (snapshotAt === null) onOpen(project.id) }}>{snapshotAt !== null ? '等待连接' : openingId === project.id ? '正在打开…' : '打开项目'}</button>
      </article>)}</div> : <p className="lumo-empty">{filtered ? '没有符合筛选条件的项目。' : '你还没有加入项目。创建一个项目，或请项目负责人添加你。'}</p> : null}
    </div>
    {data ? <nav className="lumo-project-directory-pagination" aria-label="项目目录分页">
      <span role="status">共 {data.total} 个项目{data.total > 0 ? ` · 第 ${offset + 1}–${offset + data.projects.length} 个` : ''}</span>
      <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={loading || offset <= 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}>上一页</button>
      <button type="button" className="lumo-button lumo-secondary lumo-small" disabled={loading || !data.hasMore} onClick={() => setOffset(offset + PAGE_SIZE)}>下一页</button>
    </nav> : null}
  </section>
}

import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { ExcelDataPreview, PdfDataPreview } from '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/client'
import { KnowledgeLibraryEditor, type LibraryEditorResource } from './knowledge-library-editor.tsx'
import { ApiError, api, apiBytes, apiText, encodeHeaderJSON } from './api.ts'
import { BusyButton, DomainTabs, Empty, Glyph, Notice, Section, SpotlightCard, WorkspaceHero, formatSync } from './surface-shell.tsx'
import type { KnowledgeHit, KnowledgeLibraryFile, KnowledgeLibraryFolder, KnowledgeLibraryGrant, KnowledgeResult, KnowledgeSource, KnowledgeSourceSummary, KnowledgeSources, VaultStatusInfo } from './surface-types.ts'

export function obsidianOpenUri(vaultName: string, filePath: string): string {
  return `obsidian://open?vault=${encodeURIComponent(vaultName)}&file=${encodeURIComponent(filePath)}`
}

export function vaultDisplayName(vaultPath: string): string {
  const trimmed = vaultPath.trim().replace(/\/+$/u, '')
  return trimmed.split('/').pop() ?? ''
}

export function decodeVaultDocId(docId: string): string {
  const binary = atob(docId.replace(/-/gu, '+').replace(/_/gu, '/'))
  const bytes = Uint8Array.from(binary, char => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

export function parseKnowledgeChunks(value: string): Array<{ text: string; metadata: Record<string, unknown> }> {
  let decoded: unknown
  try { decoded = JSON.parse(value) } catch { throw new Error('来源分片必须是合法 JSON 数组。') }
  if (!Array.isArray(decoded) || decoded.length === 0) throw new Error('来源至少需要一个分片。')
  return decoded.map((item, index) => {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) throw new Error(`第 ${index + 1} 个分片必须是对象。`)
    const chunk = item as Record<string, unknown>
    if (typeof chunk.text !== 'string' || chunk.text.trim() === '') throw new Error(`第 ${index + 1} 个分片缺少文本。`)
    if (typeof chunk.metadata !== 'object' || chunk.metadata === null || Array.isArray(chunk.metadata)) throw new Error(`第 ${index + 1} 个分片的 metadata 必须是对象。`)
    return { text: chunk.text, metadata: chunk.metadata as Record<string, unknown> }
  })
}

export function validKnowledgeDoc(value: unknown, docId?: string): value is KnowledgeSource['doc'] {
  if (!value || typeof value !== 'object') return false
  const doc = value as KnowledgeSource['doc']
  return typeof doc.docId === 'string' && doc.docId.length > 0 && (docId === undefined || doc.docId === docId)
    && typeof doc.realm === 'string' && typeof doc.space === 'string' && typeof doc.title === 'string'
    && typeof doc.embeddingModel === 'string' && Number.isSafeInteger(doc.sourceVersion) && doc.sourceVersion >= 1
}

export function validKnowledgeSource(value: unknown, docId: string): value is KnowledgeSource {
  if (!value || typeof value !== 'object') return false
  const source = value as KnowledgeSource
  return validKnowledgeDoc(source.doc, docId) && Array.isArray(source.chunks) && source.chunks.every(chunk =>
    chunk && typeof chunk.text === 'string' && chunk.metadata !== null && typeof chunk.metadata === 'object' && !Array.isArray(chunk.metadata))
}

export function KnowledgeSurface({ onClose }: { onClose: () => void }) {
  const [area, setArea] = useState<'search' | 'sources' | 'operations' | 'files'>('search')
  const [result, setResult] = useState<KnowledgeResult | null>(null)
  const [queryText, setQueryText] = useState('')
  const [topK, setTopK] = useState('8')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [selectedHit, setSelectedHit] = useState<KnowledgeHit | null>(null)
  const [sources, setSources] = useState<KnowledgeSourceSummary[] | null>(null)
  const [sourcesLoading, setSourcesLoading] = useState(true)
  const [sourcesError, setSourcesError] = useState('')
  const [sourceBusy, setSourceBusy] = useState('')
  const [sourceNotice, setSourceNotice] = useState('')
  const [sourceStale, setSourceStale] = useState(false)
  const [sourceRemoval, setSourceRemoval] = useState<KnowledgeSource['doc'] | null>(null)
  const [loadedSource, setLoadedSource] = useState<KnowledgeSource | null>(null)
  const [sourceDocID, setSourceDocID] = useState('')
  const [sourceSpace, setSourceSpace] = useState('general')
  const [sourceTitle, setSourceTitle] = useState('')
  const [sourceChunks, setSourceChunks] = useState('[\n  {\n    "text": "",\n    "metadata": {}\n  }\n]')
  // 单机版 vault 知识源：undefined = 未装配（集群版）；null = 加载中；对象 = 运行态。
  const [vaultStatus, setVaultStatus] = useState<VaultStatusInfo | null | undefined>(null)
  // 空间只能收窄当前身份的检索范围；Provider 在 topK 之前过滤。
  const [activeSpace, setActiveSpace] = useState('')
  // 来源详情抽屉（getSource 全文预览 + 「打开原文」）。
  const [sourceDetail, setSourceDetail] = useState<KnowledgeSource | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [libraryFolders, setLibraryFolders] = useState<KnowledgeLibraryFolder[]>([])
  const [libraryFiles, setLibraryFiles] = useState<KnowledgeLibraryFile[]>([])
  const [libraryLoading, setLibraryLoading] = useState(true)
  const [libraryError, setLibraryError] = useState('')
  const [libraryNotice, setLibraryNotice] = useState('')
  const [libraryFolderId, setLibraryFolderId] = useState<string | null>(null)
  const [libraryFolderName, setLibraryFolderName] = useState('')
  const [libraryEntityTags, setLibraryEntityTags] = useState('')
  const [libraryBusy, setLibraryBusy] = useState(false)
  const [libraryRemoval, setLibraryRemoval] = useState<{ type: 'file'; file: KnowledgeLibraryFile } | { type: 'folder'; folder: KnowledgeLibraryFolder } | null>(null)
  const [libraryEditing, setLibraryEditing] = useState<LibraryEditorResource | null>(null)
  const libraryPending = useRef(false)
  const librarySequence = useRef(0)
  const previewSequence = useRef(0)
  const shareSequence = useRef(0)
  const sourcesSequence = useRef(0)
  const detailSequence = useRef(0)
  const querySequence = useRef(0)
  const sourceEditSequence = useRef(0)
  const sourcePending = useRef(false)
  const queryPending = useRef(false)
  const [previewFile, setPreviewFile] = useState<KnowledgeLibraryFile | null>(null)
  const [previewText, setPreviewText] = useState<string | null>(null)
  const [previewOfficeBytes, setPreviewOfficeBytes] = useState<{ kind: 'pdf' | 'xlsx'; data: Uint8Array<ArrayBuffer> } | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [shareTarget, setShareTarget] = useState<{ type: 'folder' | 'file'; id: string; name: string } | null>(null)
  const [shareGrants, setShareGrants] = useState<KnowledgeLibraryGrant[]>([])
  const [shareType, setShareType] = useState<'user' | 'role'>('role')
  const [shareID, setShareID] = useState('')
  const [shareAccess, setShareAccess] = useState<'viewer' | 'editor'>('viewer')
  const [shareError, setShareError] = useState('')
  const [shareBusy, setShareBusy] = useState(false)
  const [shareLoading, setShareLoading] = useState(false)
  const sharePending = useRef(false)
  const loadSources = useCallback(async () => {
    const sequence = ++sourcesSequence.current
    setSourcesLoading(true); setSourcesError('')
    try {
      const response = await api<KnowledgeSources>('/lumo/api/knowledge/sources')
      if (!Array.isArray(response.sources) || !response.sources.every(source => validKnowledgeDoc(source)
        && Number.isSafeInteger(source.chunkCount) && source.chunkCount >= 0)) throw new Error('来源目录响应无效，请重新读取。')
      if (sequence === sourcesSequence.current) setSources(response.sources)
    }
    catch (reason) { if (sequence === sourcesSequence.current) { setSources(null); setSourcesError(reason instanceof Error ? reason.message : String(reason)) } }
    finally { if (sequence === sourcesSequence.current) setSourcesLoading(false) }
  }, [])
  const loadVaultStatus = useCallback(async () => {
    try { setVaultStatus(await api<VaultStatusInfo>('/lumo/api/knowledge/vault/status')) }
    catch { setVaultStatus(undefined) }
  }, [])
  const loadLibrary = useCallback(async (throwOnError = false) => {
    const sequence = ++librarySequence.current
    ++previewSequence.current; ++shareSequence.current
    setPreviewFile(null); setPreviewText(null); setPreviewOfficeBytes(null); setPreviewLoading(false); setShareTarget(null)
    setLibraryLoading(true); setLibraryError('')
    try {
      const [folderResponse, fileResponse] = await Promise.all([
        api<{ folders: KnowledgeLibraryFolder[] }>('/lumo/api/knowledge/library/folders'),
        api<{ files: KnowledgeLibraryFile[] }>('/lumo/api/knowledge/library/files'),
      ])
      if (sequence !== librarySequence.current) return
      setLibraryFolders(folderResponse.folders); setLibraryFiles(fileResponse.files)
      setLibraryFolderId(current => folderResponse.folders.some(folder => folder.folderId === current) ? current : null)
    } catch (reason) {
      if (sequence !== librarySequence.current) return
      setLibraryError(reason instanceof Error ? reason.message : String(reason))
      setLibraryFolders([]); setLibraryFiles([]); setLibraryRemoval(null)
      ++previewSequence.current; ++shareSequence.current
      setPreviewFile(null); setPreviewText(null); setPreviewOfficeBytes(null); setPreviewLoading(false); setShareTarget(null)
      if (throwOnError) throw reason
    }
    finally { if (sequence === librarySequence.current) setLibraryLoading(false) }
  }, [])
  useEffect(() => {
    void loadSources(); void loadVaultStatus(); void loadLibrary()
    return () => { ++librarySequence.current; ++sourcesSequence.current; ++previewSequence.current; ++shareSequence.current; ++detailSequence.current; ++querySequence.current; ++sourceEditSequence.current; sourcePending.current = false; queryPending.current = false }
  }, [loadSources, loadVaultStatus, loadLibrary])
  const clearKnowledgeQuery = () => {
    ++querySequence.current; ++detailSequence.current; queryPending.current = false
    setResult(null); setSelectedHit(null); setSourceDetail(null); setBusy(false); setDetailLoading(false); setDetailError(''); setError('')
  }
  const selectKnowledgeSpace = (space: string) => {
    if (space === activeSpace) return
    clearKnowledgeQuery(); setActiveSpace(space)
  }
  const selectKnowledgeHit = (hit: KnowledgeHit) => {
    ++detailSequence.current
    setSelectedHit(hit); setSourceDetail(null); setDetailLoading(false); setDetailError('')
  }
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (queryPending.current) return
    const text = queryText.trim()
    if (!text) { setError('先输入要检索的问题。'); return }
    const sequence = ++querySequence.current
    queryPending.current = true; ++detailSequence.current
    setBusy(true); setError(''); setResult(null); setSelectedHit(null); setSourceDetail(null); setDetailLoading(false); setDetailError('')
    try {
      const response = await api<KnowledgeResult>('/lumo/api/knowledge/query', { method: 'POST', body: JSON.stringify({ text, topK: Number(topK), ...(activeSpace ? { spaces: [activeSpace] } : {}) }) })
      if (!response || typeof response.query !== 'string' || response.scope !== 'published' || !Array.isArray(response.hits)
        || !response.hits.every(hit => hit && typeof hit.docId === 'string' && typeof hit.text === 'string'
          && Number.isFinite(hit.score) && Number.isSafeInteger(hit.sourceVersion) && hit.sourceVersion >= 1)) throw new Error('检索响应无效，请重新查询。')
      if (sequence === querySequence.current) setResult(response)
    }
    catch (reason) { if (sequence === querySequence.current) setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (sequence === querySequence.current) { queryPending.current = false; setBusy(false) } }
  }
  const useExample = (text: string) => { setQueryText(text); setError('') }
  const clearSourceDraft = () => {
    setLoadedSource(null); setSourceDocID(''); setSourceSpace('general'); setSourceTitle('')
    setSourceChunks('[\n  {\n    "text": "",\n    "metadata": {}\n  }\n]')
    setSourceNotice(''); setSourcesError(''); setSourceRemoval(null); setSourceStale(false)
  }
  const resetSourceForm = () => {
    if (sourcePending.current) return
    ++sourceEditSequence.current; setSourceBusy(''); clearSourceDraft()
  }
  const editSource = async (summary: KnowledgeSourceSummary) => {
    if (sourcePending.current) return
    const sequence = ++sourceEditSequence.current
    setSourceRemoval(null)
    setSourceBusy(`load-${summary.docId}`); setSourcesError(''); setSourceNotice('')
    try {
      const response = await api<{ source: KnowledgeSource }>(`/lumo/api/knowledge/sources/${encodeURIComponent(summary.docId)}`)
      if (sequence !== sourceEditSequence.current) return
      if (!validKnowledgeSource(response.source, summary.docId)) throw new Error('来源响应无效，请重新读取。')
      const source = response.source
      setSourceStale(false)
      setLoadedSource(source); setSourceDocID(source.doc.docId); setSourceSpace(source.doc.space)
      setSourceTitle(source.doc.title); setSourceChunks(JSON.stringify(source.chunks, null, 2))
    } catch (reason) { if (sequence === sourceEditSequence.current) { setSourceStale(true); setSourcesError(reason instanceof Error ? reason.message : String(reason)) } }
    finally { if (sequence === sourceEditSequence.current) setSourceBusy('') }
  }
  const saveSource = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (sourcePending.current || sourceBusy !== '' || sourceStale) return
    sourcePending.current = true
    const sequence = ++sourceEditSequence.current
    const docId = loadedSource?.doc.docId ?? sourceDocID.trim()
    const previousVersion = loadedSource?.doc.sourceVersion ?? 0
    let requestStarted = false
    setSourceRemoval(null)
    setSourceBusy('save'); setSourcesError(''); setSourceNotice('')
    try {
      const chunks = parseKnowledgeChunks(sourceChunks)
      const existing = loadedSource !== null
      const path = existing ? `/lumo/api/knowledge/sources/${encodeURIComponent(loadedSource.doc.docId)}` : '/lumo/api/knowledge/sources'
      requestStarted = true
      const response = await api<{ source: KnowledgeSourceSummary } | null>(path, {
        method: existing ? 'PUT' : 'POST',
        body: JSON.stringify({
          ...(existing ? {} : { docId: sourceDocID.trim() }), space: sourceSpace.trim(), title: sourceTitle.trim(), chunks,
          ...(existing ? { expectedSourceVersion: loadedSource.doc.sourceVersion } : {}),
        }),
      })
      if (sequence !== sourceEditSequence.current) return
      const summary = response?.source
      if (!validKnowledgeDoc(summary, docId) || summary.sourceVersion <= previousVersion || (loadedSource && summary.realm !== loadedSource.doc.realm)) {
        setSourceStale(true); throw new Error('保存回执无效，结果尚未确认；请重新读取来源后继续。')
      }
      setLoadedSource({ doc: { docId: summary.docId, realm: summary.realm, space: summary.space, title: summary.title, sourceVersion: summary.sourceVersion, embeddingModel: summary.embeddingModel }, chunks })
      setSourceDocID(summary.docId); setSourceSpace(summary.space); setSourceTitle(summary.title)
      setSourceNotice(`已保存 ${summary.docId} 的 v${summary.sourceVersion}；源内容与向量投影已在同一事务中同步。`)
      clearKnowledgeQuery()
      await loadSources()
    } catch (reason) {
      if (sequence === sourceEditSequence.current) {
        if (requestStarted && (!(reason instanceof ApiError) || [401, 403, 409].includes(reason.status) || reason.status >= 500)) setSourceStale(true)
        setSourcesError(reason instanceof ApiError && reason.status === 409 ? '来源已被其他人更新，草稿已保留。请重新读取来源后继续。' : reason instanceof Error ? reason.message : String(reason))
      }
    }
    finally { if (sequence === sourceEditSequence.current) { sourcePending.current = false; setSourceBusy('') } }
  }
  const removeSource = async () => {
    if (sourceRemoval === null || sourcePending.current || sourceBusy !== '' || sourceStale) return
    const target = sourceRemoval
    sourcePending.current = true
    const sequence = ++sourceEditSequence.current
    setSourceBusy('remove'); setSourcesError(''); setSourceNotice('')
    try {
      const response = await api<{ docId: string; state: string } | null>(`/lumo/api/knowledge/sources/${encodeURIComponent(target.docId)}`, { method: 'DELETE', body: JSON.stringify({ expectedSourceVersion: target.sourceVersion }) })
      if (sequence !== sourceEditSequence.current) return
      if (response?.docId !== target.docId || response.state !== 'removed') throw new Error('删除回执无效，结果尚未确认；请重新读取来源后继续。')
      const removedDocID = target.docId
      clearSourceDraft(); setSourceNotice(`已删除 ${removedDocID}；其向量投影和图投影删除意图已同步写入。`)
      clearKnowledgeQuery()
      await loadSources()
    } catch (reason) {
      if (sequence === sourceEditSequence.current) {
        setSourceRemoval(null)
        if (!(reason instanceof ApiError) || [401, 403, 409].includes(reason.status) || reason.status >= 500) setSourceStale(true)
        setSourcesError(reason instanceof Error ? reason.message : String(reason))
      }
    }
    finally { if (sequence === sourceEditSequence.current) { sourcePending.current = false; setSourceBusy('') } }
  }
  const rebuildSources = async () => {
    if (sourcePending.current || sourceBusy !== '') return
    sourcePending.current = true
    const sequence = ++sourceEditSequence.current
    setSourceRemoval(null)
    setSourceBusy('rebuild'); setSourcesError(''); setSourceNotice('')
    try {
      await api('/lumo/api/knowledge/rebuild', { method: 'POST' })
      if (sequence !== sourceEditSequence.current) return
      setSourceNotice('当前 realm 的来源已按保存版本完成安全回放；并发更新的来源不会被旧快照覆盖。')
      clearKnowledgeQuery()
      await loadSources()
    } catch (reason) { if (sequence === sourceEditSequence.current) setSourcesError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (sequence === sourceEditSequence.current) { sourcePending.current = false; setSourceBusy('') } }
  }
  const syncVault = async () => {
    if (sourcePending.current || sourceBusy !== '') return
    sourcePending.current = true
    const sequence = ++sourceEditSequence.current
    setSourceRemoval(null)
    setSourceBusy('vault-sync'); setSourcesError(''); setSourceNotice('')
    try {
      const outcome = await api<{ docs: number }>('/lumo/api/knowledge/vault/sync', { method: 'POST' })
      if (sequence !== sourceEditSequence.current) return
      setSourceNotice(`已同步 ${outcome.docs} 个 vault 文档；关键词索引已重建。`)
      clearKnowledgeQuery()
      await Promise.all([loadSources(), loadVaultStatus()])
    } catch (reason) { if (sequence === sourceEditSequence.current) setSourcesError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (sequence === sourceEditSequence.current) { sourcePending.current = false; setSourceBusy('') } }
  }
  const createLibraryFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (libraryPending.current || !canWriteLibraryFolder) return
    libraryPending.current = true; setLibraryBusy(true); setLibraryError(''); setLibraryNotice('')
    try {
      await api('/lumo/api/knowledge/library/folders', { method: 'POST', body: JSON.stringify({ name: libraryFolderName, parentId: libraryFolderId }) })
      setLibraryFolderName(''); setLibraryNotice('文件夹已创建。'); await loadLibrary()
    } catch (reason) { setLibraryError(reason instanceof Error ? reason.message : String(reason)) }
    finally { libraryPending.current = false; setLibraryBusy(false) }
  }
  const uploadLibraryFile = async (input: HTMLInputElement) => {
    const file = input.files?.[0]
    if (!file || libraryPending.current || !canWriteLibraryFolder) return
    libraryPending.current = true; setLibraryBusy(true); setLibraryError(''); setLibraryNotice('')
    try {
      const query = libraryFolderId === null ? '' : `?folder_id=${encodeURIComponent(libraryFolderId)}`
      const entities = libraryEntityTags.split(/[,，]/u).map(value => value.trim()).filter(Boolean)
      const response = await api<{ file: KnowledgeLibraryFile; indexed: boolean }>(`/lumo/api/knowledge/library/files${query}`, {
        method: 'POST', body: file,
        headers: {
          'Content-Type': 'application/octet-stream', 'X-Lumo-File-Name': encodeURIComponent(file.name),
          ...(entities.length === 0 ? {} : { 'X-Lumo-Library-Entities': encodeHeaderJSON(entities) }),
        },
      })
      setLibraryNotice(response.indexed ? `已上传并加入向量与知识图谱索引：${response.file.filename}${entities.length ? `（${entities.length} 个实体标签）` : ''}` : `已保存 ${response.file.filename}，但当前格式没有生成可检索文本。`)
      await Promise.all([loadLibrary(), loadSources()])
    } catch (reason) { setLibraryError(reason instanceof Error ? reason.message : String(reason)) }
    finally { input.value = ''; libraryPending.current = false; setLibraryBusy(false) }
  }
  const openLibraryPreview = async (file: KnowledgeLibraryFile) => {
    const sequence = ++previewSequence.current
    setPreviewFile(file); setPreviewText(null); setPreviewOfficeBytes(null); setPreviewLoading(true); setLibraryError('')
    try {
      const ext = file.filename.toLowerCase().split('.').pop() ?? ''
      const url = `/lumo/api/knowledge/library/files/${encodeURIComponent(file.docId)}/preview`
      if (ext === 'docx' || ext === 'pptx') {
        const data = await apiBytes(url)
        if (sequence === previewSequence.current) setPreviewOfficeBytes({ kind: 'pdf', data })
      } else if (ext === 'xlsx') {
        const data = await apiBytes(url)
        if (sequence === previewSequence.current) setPreviewOfficeBytes({ kind: 'xlsx', data })
      } else if (!['pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'tif', 'tiff', 'bmp'].includes(ext)) {
        const text = await apiText(url)
        if (sequence === previewSequence.current) setPreviewText(text)
      }
    } catch (reason) { if (sequence === previewSequence.current) { setLibraryError(reason instanceof Error ? reason.message : String(reason)); setPreviewFile(null); setPreviewOfficeBytes(null) } }
    finally { if (sequence === previewSequence.current) setPreviewLoading(false) }
  }
  const closeLibraryPreview = () => { ++previewSequence.current; setPreviewFile(null); setPreviewText(null); setPreviewOfficeBytes(null); setPreviewLoading(false) }
  const openLibraryEditor = (resource: LibraryEditorResource) => {
    closeLibraryPreview(); ++shareSequence.current; setShareTarget(null); setLibraryRemoval(null); setLibraryEditing(resource)
  }
  const removeLibraryItem = async () => {
    if (!libraryRemoval || libraryPending.current) return
    const target = libraryRemoval
    if (!(target.type === 'file' ? target.file.canEdit : target.folder.canEdit)) return
    libraryPending.current = true; setLibraryBusy(true); setLibraryError(''); setLibraryNotice('')
    try {
      if (target.type === 'file') {
        const { docId, sha256, revision } = target.file
        await api(`/lumo/api/knowledge/library/files/${encodeURIComponent(docId)}`, { method: 'DELETE', body: JSON.stringify({ expectedSha256: sha256, ...(revision === undefined ? {} : { expectedRevision: revision }) }) })
        closeLibraryPreview()
        ++querySequence.current; ++detailSequence.current
        queryPending.current = false
        setBusy(false); setDetailLoading(false)
        setLibraryFiles(current => current.filter(file => file.docId !== docId))
        setResult(current => current ? { ...current, hits: current.hits.filter(hit => hit.docId !== docId) } : null)
        setSelectedHit(current => current?.docId === docId ? null : current)
        setSourceDetail(current => current?.doc.docId === docId ? null : current)
        if (loadedSource?.doc.docId === docId) resetSourceForm()
        setLibraryNotice(`已删除「${target.file.filename}」，文件已从资料库和检索中移除。`)
        await loadSources()
      } else {
        const revision = target.folder.revision
        await api(`/lumo/api/knowledge/library/folders/${encodeURIComponent(target.folder.folderId)}`, { method: 'DELETE', ...(revision === undefined ? {} : { body: JSON.stringify({ expectedRevision: revision }) }) })
        setLibraryFolders(current => current.filter(folder => folder.folderId !== target.folder.folderId))
        setLibraryNotice(`已删除空文件夹「${target.folder.name}」。`)
      }
      ++shareSequence.current; setShareTarget(null); setLibraryRemoval(null)
      await loadLibrary()
    } catch (reason) {
      setLibraryError(reason instanceof ApiError && reason.status === 409 ? '内容已变化或目录非空，未执行删除。请刷新后重试。' : reason instanceof Error ? reason.message : String(reason))
      setLibraryRemoval(null)
    } finally { libraryPending.current = false; setLibraryBusy(false) }
  }
  const openLibraryShares = async (target: { type: 'folder' | 'file'; id: string; name: string }) => {
    if (sharePending.current) return
    const sequence = ++shareSequence.current
    setShareTarget(target); setShareError(''); setShareID(''); setShareGrants([]); setShareLoading(true)
    try {
      const response = await api<{ grants: KnowledgeLibraryGrant[] }>(`/lumo/api/knowledge/library/${target.type === 'folder' ? 'folders' : 'files'}/${encodeURIComponent(target.id)}/shares`)
      if (sequence === shareSequence.current) setShareGrants(response.grants)
    }
    catch (reason) { if (sequence === shareSequence.current) { setShareTarget(null); setLibraryError(reason instanceof Error ? reason.message : String(reason)) } }
    finally { if (sequence === shareSequence.current) setShareLoading(false) }
  }
  const addLibraryGrant = () => {
    const id = shareID.trim()
    if (!/^[A-Za-z0-9._:-]{1,128}$/u.test(id)) { setShareError('填写平台内的用户 ID 或角色 ID。'); return }
    if (shareGrants.some(grant => grant.type === shareType && grant.id === id)) { setShareError('该对象已经在分享列表中。'); return }
    setShareGrants(current => [...current, { type: shareType, id, access: shareAccess }]); setShareID(''); setShareError('')
  }
  const saveLibraryGrants = async () => {
    if (!shareTarget || shareLoading || sharePending.current) return
    sharePending.current = true; setShareBusy(true); setShareError('')
    try {
      await api(`/lumo/api/knowledge/library/${shareTarget.type === 'folder' ? 'folders' : 'files'}/${encodeURIComponent(shareTarget.id)}/shares`, { method: 'PUT', body: JSON.stringify({ grants: shareGrants }) })
      setLibraryNotice(`已更新「${shareTarget.name}」的平台内分享。`); setShareTarget(null); await loadLibrary()
    } catch (reason) { setShareError(reason instanceof Error ? reason.message : String(reason)) }
    finally { sharePending.current = false; setShareBusy(false) }
  }
  const openSourceDetail = async (docId: string) => {
    const sequence = ++detailSequence.current
    setDetailLoading(true); setSourceDetail(null); setDetailError('')
    try {
      const response = await api<{ source: KnowledgeSource }>(`/lumo/api/knowledge/sources/${encodeURIComponent(docId)}`)
      if (!validKnowledgeSource(response.source, docId)) throw new Error('来源响应无效，请重新读取。')
      if (sequence === detailSequence.current) setSourceDetail(response.source)
    } catch (reason) { if (sequence === detailSequence.current) setDetailError(reason instanceof Error ? reason.message : String(reason)) }
    finally { if (sequence === detailSequence.current) setDetailLoading(false) }
  }
  const visibleSources = (sources ?? []).filter(source => activeSpace === '' || source.space === activeSpace)
  const sourceWriting = sourceBusy !== '' && !sourceBusy.startsWith('load-')
  const activeLibraryFolder = libraryFolders.find(folder => folder.folderId === libraryFolderId)
  const visibleFolderIDs = new Set(libraryFolders.map(folder => folder.folderId))
  const activeLibraryChildren = libraryFolders.filter(folder => folder.parentId === libraryFolderId || (libraryFolderId === null && folder.parentId !== null && !visibleFolderIDs.has(folder.parentId)))
  const activeLibraryFiles = libraryFiles.filter(file => file.folderId === libraryFolderId || (libraryFolderId === null && file.folderId !== null && !visibleFolderIDs.has(file.folderId)))
  const canWriteLibraryFolder = libraryFolderId === null || activeLibraryFolder?.canEdit === true
  const libraryFolderPath = (() => {
    const path: KnowledgeLibraryFolder[] = []; let folder = activeLibraryFolder
    const seen = new Set<string>()
    while (folder && !seen.has(folder.folderId)) {
      seen.add(folder.folderId)
      path.unshift(folder)
      const parentId = folder.parentId
      folder = parentId === null ? undefined : libraryFolders.find(item => item.folderId === parentId)
    }
    return path
  })()
  return <div className="lumo-surface lumo-knowledge-surface">
    <WorkspaceHero surface="knowledge" onClose={onClose} statement="按领域查找、维护和核对资料。" description="从已发布内容开始检索；来源版本与索引维护在各自的工作区处理。">
      <div className="lumo-workspace-status"><span>当前检索范围</span><b><i aria-hidden="true" />{activeSpace || '全部空间'}</b><dl><div><dt>来源</dt><dd>{sources?.length ?? '—'}</dd></div><div><dt>检索方式</dt><dd className="lumo-knowledge-mode">{vaultStatus?.mode === 'keyword' ? '关键词' : vaultStatus ? '本地嵌入' : sources === null ? '待确认' : '语义'}</dd></div></dl><small>查询只读，结果保留来源 ID 与版本。</small></div>
    </WorkspaceHero>
    <DomainTabs label="资料库领域" value={area} onChange={setArea} items={[
      { id: 'search', title: '查找资料', description: '提问、查看来源与版本' },
    { id: 'sources', title: '来源内容', description: '按空间浏览和维护文档' },
      { id: 'files', title: '文件资料', description: '文件夹、分享、预览与识别' },
      { id: 'operations', title: '索引运营', description: '同步、重建与健康状态' },
    ]} />
    {area === 'operations' ? <>
    {vaultStatus !== undefined && vaultStatus !== null && vaultStatus.vaultPath === '' ? <Notice close={() => setVaultStatus(undefined)}>未配置 vault 知识源：请在 Obsidian 插件「Lumo Vault Source」中填写本机目录（或设环境变量 LUMO_KNOWLEDGE_VAULT_ROOT），随后点击「同步到 Lumo 知识库」。</Notice> : null}
    {vaultStatus !== undefined && vaultStatus !== null && vaultStatus.error ? <Notice error close={() => setVaultStatus({ ...vaultStatus, error: null })}>上次构建失败：{vaultStatus.error}</Notice> : null}
    <div className="lumo-knowledge-health">
      {vaultStatus !== undefined && vaultStatus !== null
        ? <><span>检索档位：{vaultStatus.mode === 'keyword' ? '关键词（FTS5，零依赖）' : '本地嵌入'}</span><span>来源 {vaultStatus.docCount}</span><span>分块 {vaultStatus.chunkCount}</span><span>上次构建 {vaultStatus.lastSyncAt ? new Date(vaultStatus.lastSyncAt).toLocaleTimeString('zh-CN') : '尚未构建'}</span><span className="lumo-context-end">真相源：Obsidian vault</span></>
        : sources === null || sourcesLoading ? <span className="lumo-context-end">索引健康摘要需要管理权限</span> : <><span>引擎：{sources[0]?.embeddingModel ?? '未配置'}</span><span>来源 {sources.length}</span><span>总分块 {sources.reduce((sum, source) => sum + (Number.isFinite(source.chunkCount) ? source.chunkCount : 0), 0)}</span><span className="lumo-context-end">版本化真相源（MinIO/PG 权威）</span></>}
    </div>
    <Section title="索引维护" meta={vaultStatus !== undefined && vaultStatus !== null ? '本机 vault 来源' : '当前 Realm 的来源索引'} actions={<span className="lumo-surface-actions">{vaultStatus !== undefined && vaultStatus !== null ? <BusyButton className="lumo-primary" busy={sourceBusy === 'vault-sync'} disabled={sourceBusy !== ''} onClick={() => void syncVault()}>同步 vault</BusyButton> : <BusyButton className="lumo-primary" busy={sourceBusy === 'rebuild'} disabled={sources === null || sourceBusy !== ''} onClick={() => void rebuildSources()}>重建当前 Realm</BusyButton>}<BusyButton className="lumo-secondary" busy={sourcesLoading} onClick={() => void loadSources()}>刷新来源状态</BusyButton></span>}>
      <p className="lumo-section-note">{vaultStatus !== undefined && vaultStatus !== null ? 'Obsidian vault 是原文来源。同步后更新检索索引；文档内容请在 Obsidian 中维护。' : '重建只从已保存的来源版本回放。当前身份或 Provider 不支持来源管理时，操作不可用。'}</p>
      {sourcesError ? <Notice error>{sourcesError}</Notice> : null}{sourceNotice ? <Notice>{sourceNotice}</Notice> : null}
    </Section>
    </> : null}
    {area === 'search' ? <>
    {sources !== null ? <div className="lumo-space-filter"><button type="button" className={activeSpace === '' ? 'active' : ''} onClick={() => selectKnowledgeSpace('')}>全部空间</button>{Array.from(new Set(sources.map(source => source.space).filter(Boolean))).sort().map(space => <button type="button" key={space} className={activeSpace === space ? 'active' : ''} onClick={() => selectKnowledgeSpace(space)}>{space}</button>)}</div> : null}
    <div className="lumo-context-strip"><span><i className="lumo-live-dot" /> 当前身份可见</span><span>{vaultStatus !== undefined && vaultStatus !== null ? '关键词检索' : '语义召回'}</span><span>来源可追溯</span><span className="lumo-context-end">查询不会改变知识内容</span></div>
    <Section title="向知识空间提问" meta="只读查询 · 最多 20 个来源"><div className="lumo-search-layout"><form className="lumo-search-form" onSubmit={submit}><label><span>问题</span><textarea name="text" aria-label="向知识空间提问" value={queryText} maxLength={2000} rows={4} placeholder="例如：生产环境连接器的审批边界是什么？" onChange={event => setQueryText(event.target.value)} /></label><div className="lumo-search-controls"><label className="lumo-compact-field"><span>召回数</span><select name="topK" value={topK} onChange={event => setTopK(event.target.value)}><option value="5">5</option><option value="8">8</option><option value="12">12</option><option value="20">20</option></select></label><BusyButton type="submit" busy={busy} className="lumo-primary">检索知识</BusyButton></div></form><div className="lumo-example-queries"><span>可以从这些问题开始</span><button type="button" onClick={() => useExample('生产环境连接器的审批边界是什么？')}>连接器审批边界</button><button type="button" onClick={() => useExample('哪些角色可以发布工作流？')}>工作流发布角色</button><button type="button" onClick={() => useExample('如何处理跨 realm 的知识访问？')}>跨 realm 访问</button></div></div></Section>
    {error ? <Notice error>{error}</Notice> : null}
    {detailError ? <Notice error>{detailError}</Notice> : null}
    <Section title="检索结果" meta={result === null ? '等待查询' : `${result.hits.length} 个来源片段`} actions={result ? <span className="lumo-query-summary">“{result.query}”</span> : null}>
      {busy ? <div className="lumo-hit-list">{[0, 1, 2].map(index => <div className="lumo-skeleton-hit" key={index}><span /><b /><i /></div>)}</div> : result === null ? <div className="lumo-hero-empty"><Glyph surface="knowledge" /><b>知识结果会在这里展开</b><p>查询会带入当前会话 realm 与角色，只读已发布知识，并保留 docId、源版本和相关度。</p></div> : result.hits.length === 0 ? <Empty>没有命中可见的已发布知识。可以调整问题表达后重试。</Empty> : <div className="lumo-result-layout"><div className="lumo-hit-list">{result.hits.map((hit, index) => <SpotlightCard className={`lumo-hit ${selectedHit?.docId === hit.docId && selectedHit.sourceVersion === hit.sourceVersion ? 'selected' : ''}`} index={index} key={`${hit.docId}-${hit.sourceVersion}-${index}`} onClick={() => selectKnowledgeHit(hit)}><div className="lumo-hit-meta"><span>{hit.docId} · v{hit.sourceVersion}</span><b>{Math.round(hit.score * 100)}%</b></div><p>{hit.text}</p><footer><span>来源版本 {hit.sourceVersion}</span><button type="button" className="lumo-quiet lumo-open-detail" onClick={event => { event.stopPropagation(); setSelectedHit(hit); void openSourceDetail(hit.docId) }}>查看来源详情 ↗</button></footer></SpotlightCard>)}</div><aside className="lumo-inspector">{sourceDetail !== null || detailLoading ? <><span className="lumo-inspector-label">来源详情</span><h3>{detailLoading ? '加载中…' : sourceDetail?.doc.title ?? ''}</h3>{sourceDetail === null ? <p>正在读取来源全文。</p> : <><p>来源 ID {sourceDetail.doc.docId} · 空间 {sourceDetail.doc.space} · v{sourceDetail.doc.sourceVersion} · {sourceDetail.doc.embeddingModel} · {sourceDetail.chunks.length} 个分片</p><div className="lumo-detail-stack">{vaultStatus !== undefined && vaultStatus !== null ? <a className="lumo-open-original" href={obsidianOpenUri(vaultDisplayName(vaultStatus.vaultPath), decodeVaultDocId(sourceDetail.doc.docId))} onClick={event => { event.preventDefault(); try { window.open(obsidianOpenUri(vaultDisplayName(vaultStatus.vaultPath), decodeVaultDocId(sourceDetail.doc.docId)), '_self') } catch { /* obsidian:// 协议由系统处理 */ } }}>打开原文（Obsidian）↗</a> : <div><span>原文存储</span><b>MinIO / PG 权威副本（整篇预览）</b></div>}</div><div className="lumo-chunk-preview">{sourceDetail.chunks.map((chunk, index) => <div key={index}><b>{String(chunk.metadata['heading'] ?? `分块 ${index + 1}`)}</b><p>{chunk.text}</p></div>)}</div></>}</> : selectedHit ? <><span className="lumo-inspector-label">来源检查</span><h3>{selectedHit.docId}</h3><p>该片段来自已发布知识版本 {selectedHit.sourceVersion}，当前相关度为 {Math.round(selectedHit.score * 100)}%。</p><div className="lumo-detail-stack"><div><span>来源 ID</span><b>{selectedHit.docId}</b></div><div><span>源版本</span><b>v{selectedHit.sourceVersion}</b></div><div><span>相关度</span><b>{Math.round(selectedHit.score * 100)}%</b></div></div></> : <div className="lumo-inspector-empty"><span>选择一个来源片段</span><p>右侧会展示该片段的版本和相关度信息。</p></div>}</aside></div>}
    </Section>
    </> : null}
    {area === 'sources' ? <>
    {sources !== null ? <div className="lumo-space-filter"><button type="button" className={activeSpace === '' ? 'active' : ''} onClick={() => selectKnowledgeSpace('')}>全部空间</button>{Array.from(new Set(sources.map(source => source.space).filter(Boolean))).sort().map(space => <button type="button" key={space} className={activeSpace === space ? 'active' : ''} onClick={() => selectKnowledgeSpace(space)}>{space}</button>)}</div> : null}
    <Section title="来源内容" meta={sources === null ? (sourcesLoading ? '正在确认管理权限与来源存储' : '当前身份或向量 Provider 不支持来源管理') : `${sources.length} 个来源 · ${vaultStatus !== undefined && vaultStatus !== null ? 'vault 只读索引' : '版本化来源'}`} actions={<BusyButton className="lumo-secondary" busy={sourcesLoading} onClick={() => void loadSources()}>刷新来源</BusyButton>}>
      <p className="lumo-section-note">{vaultStatus !== undefined && vaultStatus !== null ? '来源内容属于 Obsidian vault —— 本面板只读；新建/编辑/删除请在 Obsidian 插件「Lumo Vault Source」中操作，再点「同步 vault」。' : '来源内容、版本和向量投影由管理 API 一起写入；重建只从已保存来源回放，不会暴露 embedding 或索引参数。'}</p>
      {sourcesError ? <Notice error close={() => setSourcesError('')}>{sourcesError}</Notice> : null}
      {sourceNotice ? <Notice close={() => setSourceNotice('')}>{sourceNotice}</Notice> : null}
      {sources === null ? <Empty>{sourcesLoading ? '正在读取来源目录。' : '仅 realm_admin、platform_admin 或 admin 可管理 PostgreSQL 来源；Milvus 投影模式会明确显示为不支持。'}</Empty> : <div className="lumo-governed-version-layout"><div className="lumo-table-list">{visibleSources.length ? visibleSources.map(source => <div key={source.docId} className={loadedSource?.doc.docId === source.docId ? 'selected' : ''}><span><b>{source.title}</b><small>{source.docId} · 空间 {source.space} · {source.chunkCount} 个分片 · {source.embeddingModel}</small></span><em>v{source.sourceVersion} · 已同步 · {formatSync(source.updatedAt)}</em><BusyButton className="lumo-small lumo-secondary" busy={sourceBusy === `load-${source.docId}`} disabled={sourceWriting} onClick={() => (vaultStatus !== undefined && vaultStatus !== null ? void openSourceDetail(source.docId) : void editSource(source))}>{vaultStatus !== undefined && vaultStatus !== null ? '查看详情' : '查看 / 编辑'}</BusyButton></div>) : <Empty>还没有来源。新建一条来源后，系统会生成首个不可覆盖版本。</Empty>}</div>{vaultStatus !== undefined && vaultStatus !== null ? <div className="lumo-vault-source-preview"><p className="lumo-section-note">文档内容请在 Obsidian 中维护，修改后同步到资料库。</p>{detailError ? <Notice error>{detailError}</Notice> : null}{detailLoading ? <Empty>正在读取来源全文。</Empty> : sourceDetail ? <section aria-label="来源全文预览"><h3>{sourceDetail.doc.title}</h3><p className="lumo-section-note">{sourceDetail.doc.space} · v{sourceDetail.doc.sourceVersion} · {sourceDetail.chunks.length} 个分片</p><div className="lumo-chunk-preview">{sourceDetail.chunks.map((chunk, index) => <div key={index}><b>{String(chunk.metadata['heading'] ?? `分块 ${index + 1}`)}</b><p>{chunk.text}</p></div>)}</div></section> : <Empty>选择一条来源查看全文。</Empty>}</div> : <form className="lumo-stacked-form lumo-version-form" onSubmit={saveSource}><div className="lumo-form-head"><b>{loadedSource ? `编辑 ${loadedSource.doc.docId} · v${loadedSource.doc.sourceVersion}` : '登记知识来源'}</b><button type="button" className="lumo-quiet" disabled={sourceWriting} onClick={resetSourceForm}>新建来源</button></div><fieldset className="lumo-source-fields" disabled={sourceBusy !== ''}><label><span>来源 ID</span><input aria-label="知识来源 ID" value={sourceDocID} disabled={loadedSource !== null} maxLength={128} required placeholder="例如：connector-policy" onChange={event => setSourceDocID(event.target.value)} /></label><label><span>知识空间</span><input aria-label="知识空间" value={sourceSpace} maxLength={128} required placeholder="例如：operations" onChange={event => setSourceSpace(event.target.value)} /></label><label><span>标题</span><input aria-label="知识来源标题" value={sourceTitle} maxLength={512} required placeholder="例如：生产连接器审批规范" onChange={event => setSourceTitle(event.target.value)} /></label><label><span>来源分片</span><textarea aria-label="来源分片 JSON" value={sourceChunks} rows={9} onChange={event => setSourceChunks(event.target.value)} /></label><small>每个分片包含 text 与 metadata；保存已有来源会创建下一个版本。并发更新会返回冲突，需重新加载后再提交。</small><div className="lumo-form-actions"><BusyButton type="submit" busy={sourceBusy === 'save'} disabled={sourceStale} className="lumo-primary">{loadedSource ? '保存新版本' : '登记来源'}</BusyButton>{loadedSource ? <BusyButton type="button" disabled={sourceStale} className="lumo-danger" onClick={() => setSourceRemoval({ ...loadedSource.doc })}>删除来源</BusyButton> : null}</div></fieldset>{sourceStale ? <p role="status">来源版本尚未确认，请从左侧重新读取来源后继续保存。</p> : null}{sourceRemoval ? <div role="alertdialog" aria-label="确认删除知识来源"><b>删除「{sourceRemoval.title}」的 v{sourceRemoval.sourceVersion}？</b><p>来源内容和检索投影将一并删除。</p><div className="lumo-form-actions"><BusyButton type="button" busy={sourceBusy === 'remove'} disabled={sourceStale} className="lumo-danger" onClick={() => void removeSource()}>确认删除来源</BusyButton><button type="button" className="lumo-secondary" disabled={sourceWriting} onClick={() => setSourceRemoval(null)}>取消</button></div></div> : null}</form>}</div>}
    </Section>
    </> : null}
    {area === 'files' ? <>
      {libraryError ? <Notice error close={() => setLibraryError('')}>{libraryError}</Notice> : null}
      {libraryNotice ? <Notice close={() => setLibraryNotice('')}>{libraryNotice}</Notice> : null}
      {libraryEditing ? <KnowledgeLibraryEditor
        key={`${libraryEditing.type}:${libraryEditing.type === 'file' ? libraryEditing.file.docId : libraryEditing.folder.folderId}`}
        request={api} resource={libraryEditing} folders={libraryFolders} onClose={() => setLibraryEditing(null)}
        onSaved={async () => {
          await loadLibrary(true)
          clearKnowledgeQuery()
          setLibraryNotice('资料名称和位置已更新。')
          await loadSources()
        }}
      /> : null}
      <Section title="文件资料" meta={`${libraryFiles.length} 个当前身份可访问的文件`} actions={<BusyButton className="lumo-secondary" busy={libraryLoading} onClick={() => void loadLibrary()}>刷新</BusyButton>}>
        <p className="lumo-section-note">支持目录继承权限，文件夹或文件可分享给平台内用户和角色。上传的可识别文本会进入现有向量索引；可填写实体标签建立知识图谱关系。扫描 PDF 和图片由同一 DSH API 容器执行中文/英文 OCR。</p>
        <div className="lumo-library-toolbar">
          <div className="lumo-library-breadcrumb"><button type="button" onClick={() => { setLibraryFolderId(null); closeLibraryPreview() }}>资料库根目录</button>{libraryFolderPath.map(folder => <span key={folder.folderId}><i>／</i><button type="button" onClick={() => { setLibraryFolderId(folder.folderId); closeLibraryPreview() }}>{folder.name}</button></span>)}</div>
          {canWriteLibraryFolder ? <>
          <form className="lumo-library-folder-form" onSubmit={createLibraryFolder}><input aria-label="新文件夹名称" value={libraryFolderName} maxLength={240} placeholder="新建文件夹" required disabled={libraryBusy} onChange={event => setLibraryFolderName(event.target.value)} /><BusyButton type="submit" busy={libraryBusy} className="lumo-secondary">创建文件夹</BusyButton></form>
          <input className="lumo-library-entities" aria-label="知识图谱实体标签" value={libraryEntityTags} maxLength={1500} placeholder="图谱实体标签，逗号分隔（可选）" onChange={event => setLibraryEntityTags(event.target.value)} />
          <label className="lumo-button lumo-primary lumo-library-upload">{libraryBusy ? '处理中…' : '上传文件'}<input type="file" accept=".pdf,.png,.jpg,.jpeg,.webp,.gif,.tif,.tiff,.bmp,.txt,.log,.md,.markdown,.csv,.tsv,.json,.html,.htm,.xml,.yaml,.yml,.docx,.xlsx,.pptx" disabled={libraryBusy} onChange={event => void uploadLibraryFile(event.currentTarget)} /></label>
          </> : <span className="lumo-section-note">当前目录为只读分享，可预览和下载文件。</span>}
        </div>
        <div className="lumo-library-layout">
          <div className="lumo-library-list">
            {libraryLoading ? <Empty>正在读取当前身份可以访问的目录和文件。</Empty> : <>
              {activeLibraryFolder?.parentId && visibleFolderIDs.has(activeLibraryFolder.parentId) ? <button type="button" className="lumo-library-folder-row" onClick={() => { setLibraryFolderId(activeLibraryFolder.parentId); closeLibraryPreview() }}><b>↰　上一级</b><small>返回父文件夹</small></button> : null}
              {activeLibraryChildren.map(folder => <div className="lumo-library-folder-row" key={folder.folderId}><button type="button" onClick={() => { setLibraryFolderId(folder.folderId); setLibraryRemoval(null); closeLibraryPreview() }}><b>▰　{folder.name}</b><small>文件夹 · {folder.canEdit ? '可编辑' : '只读'}{folder.parentId && !visibleFolderIDs.has(folder.parentId) ? ' · 共享入口' : ''}</small></button>{folder.canEdit ? <div className="lumo-row-actions">{Number.isSafeInteger(folder.revision) && (folder.revision ?? 0) >= 1 ? <button type="button" className="lumo-quiet" disabled={libraryBusy} onClick={() => openLibraryEditor({ type: 'folder', folder })}>整理</button> : null}<button type="button" className="lumo-quiet" disabled={libraryBusy} onClick={() => void openLibraryShares({ type: 'folder', id: folder.folderId, name: folder.name })}>分享</button><button type="button" className="lumo-quiet lumo-delete-action" disabled={libraryBusy} onClick={() => setLibraryRemoval({ type: 'folder', folder })}>删除</button></div> : null}</div>)}
              {activeLibraryFiles.map(file => <article className={`lumo-library-file ${previewFile?.docId === file.docId ? 'selected' : ''}`} key={file.docId}>
                <div><b>{file.filename}</b><small>{file.mimeType.split(';', 1)[0]} · {(file.byteSize / 1024 / 1024).toFixed(file.byteSize >= 1024 * 1024 ? 1 : 2)} MB · {file.extractionState === 'ready' ? '文本已入索引' : file.ocrState === 'unavailable' ? 'OCR 不可用' : file.extractionState === 'unsupported' ? '暂不支持文本提取' : file.extractionState === 'failed' ? '文本提取失败' : file.extractionState}</small></div>
                <div className="lumo-row-actions"><button type="button" className="lumo-quiet" disabled={libraryBusy} onClick={() => void openLibraryPreview(file)}>预览</button>{file.canEdit ? <>{Number.isSafeInteger(file.revision) && (file.revision ?? 0) >= 1 ? <button type="button" className="lumo-quiet" disabled={libraryBusy} onClick={() => openLibraryEditor({ type: 'file', file })}>整理</button> : null}<button type="button" className="lumo-quiet" disabled={libraryBusy} onClick={() => void openLibraryShares({ type: 'file', id: file.docId, name: file.filename })}>分享</button></> : null}<a className="lumo-quiet" href={`/lumo/api/knowledge/library/files/${encodeURIComponent(file.docId)}/content?download=1`}>下载</a>{file.canEdit && /^[a-f0-9]{64}$/u.test(file.sha256) ? <button type="button" className="lumo-quiet lumo-delete-action" disabled={libraryBusy} onClick={() => setLibraryRemoval({ type: 'file', file })}>删除</button> : null}</div>
              </article>)}
              {activeLibraryChildren.length === 0 && activeLibraryFiles.length === 0 ? <Empty>{libraryError ? '资料库请求未成功，请刷新后重试。' : '此文件夹还没有内容。' + (canWriteLibraryFolder ? '可新建子文件夹或上传文件。' : '')}</Empty> : null}
            </>}
          </div>
          <aside className="lumo-library-preview">
            {libraryRemoval ? <div className="lumo-library-removal" role="alertdialog" aria-label="确认删除资料">
              <b>删除「{libraryRemoval.type === 'file' ? libraryRemoval.file.filename : libraryRemoval.folder.name}」？</b>
              <p>{libraryRemoval.type === 'file' ? '文件将从资料库和知识检索中移除。此操作无法在页面撤销。' : '仅允许删除空文件夹，请先移走或删除其中内容。'}</p>
              <div className="lumo-form-actions"><BusyButton className="lumo-danger" busy={libraryBusy} onClick={() => void removeLibraryItem()}>确认删除</BusyButton><button type="button" className="lumo-secondary" disabled={libraryBusy} onClick={() => setLibraryRemoval(null)}>取消</button></div>
            </div> : null}
            {previewFile === null ? <div className="lumo-inspector-empty"><span>资料预览</span><p>选择一个文件查看内容、来源版本和 OCR 状态。</p></div> : <>
              <div className="lumo-library-preview-head"><div><span className="lumo-inspector-label">文件预览</span><h3>{previewFile.filename}</h3><small>{previewFile.ocrState === 'ready' ? 'OCR 已完成' : previewFile.ocrState === 'failed' ? 'OCR 未识别到文本' : previewFile.ocrState === 'unavailable' ? 'OCR 执行环境不可用' : previewFile.extractionState === 'ready' ? '文本已加入知识索引' : '未生成检索文本'}</small></div><button type="button" className="lumo-quiet" onClick={closeLibraryPreview}>关闭</button></div>
              {previewLoading ? <Empty>正在读取预览。</Empty> : previewOfficeBytes?.kind === 'pdf' ? <div className="lumo-library-native-preview"><PdfDataPreview data={previewOfficeBytes.data} /></div> : previewOfficeBytes?.kind === 'xlsx' ? <div className="lumo-library-native-preview"><ExcelDataPreview filename={previewFile.filename} data={previewOfficeBytes.data} /></div> : ['application/pdf', 'image/'].some(kind => kind === 'application/pdf' ? previewFile.mimeType === kind : previewFile.mimeType.startsWith(kind)) ? previewFile.mimeType.startsWith('image/') ? <img className="lumo-library-image" src={`/lumo/api/knowledge/library/files/${encodeURIComponent(previewFile.docId)}/preview`} alt={previewFile.filename} /> : <iframe className="lumo-library-pdf" title={`${previewFile.filename} 预览`} src={`/lumo/api/knowledge/library/files/${encodeURIComponent(previewFile.docId)}/preview`} /> : previewText !== null ? <pre className="lumo-library-text-preview">{previewText}</pre> : <Empty>此文件没有可用的内嵌预览。</Empty>}
            </>}
          </aside>
        </div>
      </Section>
      {shareTarget ? <Section title={`分享「${shareTarget.name}」`} meta="平台内授权 · 不创建公开链接" actions={<button type="button" className="lumo-quiet" disabled={shareBusy} onClick={() => { ++shareSequence.current; setShareTarget(null) }}>关闭</button>}>
        <p className="lumo-section-note">添加用户 ID 或角色 ID。文件夹授权会继承到下级目录和文件；移除某个授权不会覆盖上级目录授予的权限。</p>
        {shareError ? <Notice error>{shareError}</Notice> : null}
        <div className="lumo-library-grants">{shareLoading ? <Empty>正在读取现有分享权限。</Empty> : shareGrants.length ? shareGrants.map((grant, index) => <div key={`${grant.type}:${grant.id}`}><span><b>{grant.type === 'user' ? '用户' : '角色'}</b>　{grant.id}　·　{grant.access === 'editor' ? '编辑' : '查看'}</span><button type="button" className="lumo-quiet" disabled={shareBusy} onClick={() => setShareGrants(current => current.filter((_, row) => row !== index))}>移除</button></div>) : <Empty>尚未添加直接分享对象。所有者和管理员始终保留管理权限。</Empty>}</div>
        <fieldset className="lumo-library-share-controls" disabled={shareLoading || shareBusy}><select aria-label="分享对象类型" value={shareType} onChange={event => setShareType(event.target.value as 'user' | 'role')}><option value="role">角色</option><option value="user">用户</option></select><input aria-label="用户或角色 ID" value={shareID} maxLength={128} placeholder={shareType === 'role' ? '例如：knowledge_reader' : '平台用户 ID'} onChange={event => setShareID(event.target.value)} /><select aria-label="分享权限" value={shareAccess} onChange={event => setShareAccess(event.target.value as 'viewer' | 'editor')}><option value="viewer">查看</option><option value="editor">编辑与分享</option></select><button type="button" className="lumo-secondary" onClick={addLibraryGrant}>添加</button><BusyButton type="button" busy={shareBusy} className="lumo-primary" onClick={() => void saveLibraryGrants()}>保存分享</BusyButton></fieldset>
      </Section> : null}
    </> : null}
  </div>
}

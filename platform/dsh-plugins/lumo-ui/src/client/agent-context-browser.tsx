import { CodeBlock, Button, Input, PathLabel } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { codeLabels } from './agent-execution-content.tsx'
import { acpCall } from './acp-session-state.ts'
import { AddIcon, BackIcon, CheckIcon, FileTypeIcon, FolderIcon, NextIcon, RefreshIcon, SkillIcon } from './chat-icons.tsx'
import type { AgentSkill, PromptContext } from '../../../acp-engines/src/prompt-context.ts'

interface ProjectFile { name: string; path: string; directory: boolean }
interface Catalog { url: string; files?: ProjectFile[]; skills?: AgentSkill[]; complete?: boolean; error?: string }
export function AgentContextBrowser({ kind, scopePath, cwd, value, onChange, disabled }: {
  kind: 'files' | 'skills'; scopePath: string; cwd: string; value: PromptContext; onChange(value: PromptContext): void; disabled: boolean
}) {
  const [directory, setDirectory] = useState(''), [query, setQuery] = useState(''), [retry, setRetry] = useState(0)
  const [catalog, setCatalog] = useState<Catalog>(), [loading, setLoading] = useState(true), [notice, setNotice] = useState('')
  const [preview, setPreview] = useState<{path: string; name: string; mimeType: string; size: number; text?: string; data?: string; truncated?: boolean; unsupported?: boolean}>(), [previewError, setPreviewError] = useState('')
  const previewVersion = useRef(0)
  useEffect(() => () => { ++previewVersion.current }, [scopePath])
  const showPreview = async (path: string) => { const version = ++previewVersion.current; try { const result = await acpCall<NonNullable<typeof preview>>(`${scopePath}/preview?path=${encodeURIComponent(path)}`); if (version === previewVersion.current) { setPreview(result); setPreviewError('') } } catch (e) { if (version === previewVersion.current) setPreviewError(e instanceof Error ? e.message : String(e)) } }
  const url = `${scopePath}/${kind}${kind === 'files' ? `?query=${encodeURIComponent(directory + query)}` : ''}`
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setCatalog(undefined)
    acpCall<Omit<Catalog, 'url'>>(url, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setCatalog({ ...result, url })
    }).catch(error => { if (!controller.signal.aborted) setCatalog({ url, error: error instanceof Error ? error.message : '加载失败' }) })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [url, retry])
  const data = catalog?.url === url ? catalog : undefined, selected = value[kind] ?? [], limit = kind === 'files' ? 8 : 4
  const toggle = (name: string) => {
    if (disabled) return
    const exists = selected.includes(name)
    if (!exists && selected.length >= limit) { setNotice(`每条消息最多选择 ${limit} 个${kind === 'files' ? '文件' : ' Skill'}`); return }
    onChange({ ...value, [kind]: exists ? selected.filter(item => item !== name) : [...selected, name] })
    setNotice(exists ? `已移除 ${name}` : `已加入当前消息：${name}`)
  }
  const files = data?.files ?? [], skills = (data?.skills ?? []).filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(query.toLowerCase()))
  const navigate = (path: string) => { setDirectory(path); setQuery(''); setNotice('') }
  return <div className="lumo-context-browser lumo-native-content">
    <div className="lumo-dock-project" title={cwd}><FolderIcon size={15} /><span>{cwd.split(/[\\/]/u).filter(Boolean).at(-1) || cwd}</span><small>{selected.length}/{limit}</small></div>
    <div className="lumo-dock-search"><Input aria-label={kind === 'files' ? '筛选项目文件' : '搜索 Skill'} placeholder={kind === 'files' ? '筛选文件或输入相对路径' : '搜索 Skill'} value={query} onChange={e => setQuery(e.target.value)} />
      <Button size="sm" type="button" className="lumo-dock-icon" aria-label="刷新目录" title="刷新" onClick={() => setRetry(n => n + 1)} disabled={loading}><RefreshIcon size={15} /></Button></div>
    {kind === 'files' ? <div className="lumo-dock-breadcrumb"><Button size="sm" type="button" className="lumo-dock-icon" aria-label="返回上级目录" title="返回上级" disabled={!directory} onClick={() => navigate(directory.split('/').filter(Boolean).slice(0, -1).map(part => `${part}/`).join(''))}><BackIcon size={14} /></Button><PathLabel path={directory || '/'} /></div> : <p className="lumo-dock-hint">加入当前消息，发送时加载。</p>}
    {loading || !data ? <p role="status">正在加载…</p> : null}
    {data?.error || data?.complete === false ? <div role="alert">{data.error || 'Skill 目录仍在加载'}<Button size="sm" type="button" onClick={() => setRetry(n => n + 1)}>重试</Button></div> : null}
    <div className="lumo-dock-catalog">
      {kind === 'files' ? files.map(file => <div key={file.path} className="lumo-context-file-row"><Button size="sm" type="button" className="lumo-dock-row" title={file.path}
        aria-label={file.directory ? `打开目录 ${file.path}` : `${selected.includes(file.path) ? '移除文件引用' : '引用文件'} ${file.path}`}
        aria-pressed={file.directory ? undefined : selected.includes(file.path)} disabled={!file.directory && disabled}
        onClick={() => file.directory ? navigate(`${file.path}/`) : toggle(file.path)}>
        {file.directory ? <FolderIcon size={16} /> : <FileTypeIcon path={file.path} size={16} />}<span>{file.name}</span>{file.directory ? <NextIcon size={14} /> : selected.includes(file.path) ? <CheckIcon size={14} /> : <AddIcon size={14} />}
      </Button>{!file.directory ? <Button size="sm" type="button" className="lumo-dock-icon" aria-label={`预览文件 ${file.path}`} title="预览文件" onClick={() => void showPreview(file.path)}>↗</Button> : null}</div>) : skills.map(skill => <Button size="sm" type="button" key={skill.name} className="lumo-dock-row" title={skill.description} aria-label={`${selected.includes(skill.name) ? '移除' : '加载'} Skill ${skill.name}`} aria-pressed={selected.includes(skill.name)} disabled={disabled} onClick={() => toggle(skill.name)}>
        <SkillIcon size={16} /><span><strong>{skill.name}</strong><small>{skill.description}</small>{skill.source || skill.provider ? <small>{[skill.source, skill.provider, skill.version].filter(Boolean).join(' · ')}</small> : null}</span>{selected.includes(skill.name) ? <CheckIcon size={14} /> : <AddIcon size={14} />}
      </Button>)}
    </div>
    {!loading && data && !data.error && !(kind === 'files' ? files : skills).length ? <p className="lumo-dock-hint">{query ? '没有匹配项' : kind === 'files' ? '此目录没有可引用的文件' : '此项目暂无可用 Skill'}</p> : null}
    {kind === 'files' && files.length === 40 ? <p className="lumo-dock-hint">当前显示前 40 项，可筛选文件名。</p> : null}
    {previewError ? <p role="alert">{previewError}</p> : null}
    {preview ? <section className="lumo-file-preview" aria-label="文件预览"><header><PathLabel path={preview.path} /><Button size="sm" type="button" onClick={() => { ++previewVersion.current; setPreview(undefined) }}>关闭</Button></header>{preview.text !== undefined ? <CodeBlock code={preview.text} lang={preview.name.split('.').at(-1)} lineNumbers {...codeLabels} /> : preview.data && preview.mimeType.startsWith('image/') ? <img src={`data:${preview.mimeType};base64,${preview.data}`} alt={preview.name} style={{maxWidth: '100%'}} /> : <p>此文件类型暂不支持预览，可引用文件后交给 Agent 处理。</p>}{preview.truncated ? <small>预览内容已截断。</small> : null}</section> : null}
    {notice ? <p className="lumo-dock-hint" role="status">{notice}</p> : null}
  </div>
}

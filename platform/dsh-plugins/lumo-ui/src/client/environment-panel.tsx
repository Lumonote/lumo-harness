import { useEffect, useRef, useState } from 'react'
import { Button, Input, StateDot, IconGlobeOutlineRegular, IconEditOutlineRegular, IconTrashOutlineRegular, IconLinkOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import { AddIcon, RefreshIcon, SettingsIcon } from './chat-icons.tsx'
import { useEnvironmentConnection } from './environment-connection.ts'
import { SERVER_BOOK_EVENT, SERVER_BOOK_KEY, type SavedServer } from './server-book.ts'
import { loadSharedServerBook, saveSharedServerBook } from './shared-server-book.ts'
import { DesktopDevicePanel } from './desktop-device-panel.tsx'
import { openSurface } from './surface-navigation.ts'
import { queueOperationsTarget, OPERATIONS_TARGET_EVENT, type OperationsArea } from './operations-navigation.ts'
import type { DeploymentState } from './surface-types.ts'
import './environment.css'

export function openEnvironment() {
  queueOperationsTarget({ kind: 'area', area: 'connections' })
  window.dispatchEvent(new Event(OPERATIONS_TARGET_EVENT))
  openSurface('market')
}

export function EnvironmentEntry({ wide = true }: { wide?: boolean }) {
  const { state } = useEnvironmentConnection()
  return <div className="lumo-native-content lumo-environment-entry"><Button size="sm" type="button" aria-label="环境与连接" title="环境与连接" onClick={openEnvironment}>
    <IconGlobeOutlineRegular size={17} />{wide ? <span>环境与连接</span> : null}{state ? <StateDot size={8} state={state === 'connected' ? 'done' : state === 'connecting' ? 'ongoing' : 'error'} /> : null}
  </Button></div>
}

const MODE = { local: '本地单机', standalone: '单实例服务器', cluster: '分布式集群' }
const STATUS = { connected: '已连接', connecting: '连接中', disconnected: '连接中断' }

export function EnvironmentPanel({ deployment, navigate, refresh, loading }: {
  deployment: DeploymentState | null; navigate(area: OperationsArea): void; refresh(): void; loading: boolean
}) {
  const { state, reconnect } = useEnvironmentConnection()
  const [servers, setServers] = useState<SavedServer[]>([]), [error, setError] = useState('')
  const [draft, setDraft] = useState<SavedServer | null>(null), [editing, setEditing] = useState<string>()
  const [nativeBook, setNativeBook] = useState(false), [saving, setSaving] = useState(false)
  const [bookReady, setBookReady] = useState(false)
  const nameInput = useRef<HTMLInputElement>(null), addButton = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    let disposed = false
    const load = async () => { try { const book = await loadSharedServerBook(deployment?.desktop === true); if (!disposed) { setServers(book.servers); setNativeBook(book.native); setBookReady(true); setError('') } } catch (reason) { if (!disposed) { setBookReady(false); setError(reason instanceof Error ? reason.message : '无法读取服务器地址簿。') } } }
    const storage = (event: StorageEvent) => { if (event.key === SERVER_BOOK_KEY || event.key === null) load() }
    load(); window.addEventListener(SERVER_BOOK_EVENT, load); window.addEventListener('storage', storage)
    const focus = () => void load()
    window.addEventListener('focus', focus)
    return () => { disposed = true; window.removeEventListener('focus', focus); window.removeEventListener(SERVER_BOOK_EVENT, load); window.removeEventListener('storage', storage) }
  }, [deployment?.desktop])
  useEffect(() => { if (draft) nameInput.current?.focus() }, [draft === null])
  const cancel = () => { setDraft(null); setEditing(undefined); addButton.current?.focus() }
  const save = async () => {
    if (!draft || saving || !bookReady) return
    setSaving(true)
    try { setServers(await saveSharedServerBook(nativeBook, { save: draft, ...(editing ? { previous: editing } : {}) })); setError(''); cancel() }
    catch (reason) { setError(reason instanceof Error ? reason.message : '保存失败，请检查浏览器存储权限。') }
    finally { setSaving(false) }
  }
  return <div className="lumo-environment lumo-native-content">
    <section className="lumo-environment-current" aria-label="当前环境">
      <header><div><small>当前环境</small><h2>{deployment ? MODE[deployment.mode] : '环境信息不可用'}</h2></div><Button size="sm" type="button" aria-label="刷新环境状态" title="刷新环境状态" disabled={loading} onClick={refresh}><RefreshIcon size={16} /></Button></header>
      <div className="lumo-environment-status">{state ? <StateDot size={9} state={state === 'connected' ? 'done' : state === 'connecting' ? 'ongoing' : 'error'} /> : null}<span>{state ? STATUS[state] : '连接状态由宿主管理'}</span><code>{window.location.origin}</code></div>
      <p>{!deployment ? '可重试当前连接，或从地址簿打开其他服务器。' : deployment.mode === 'local' ? '本机运行引擎，项目与对话保存在本地。' : deployment.mode === 'cluster' ? deployment.clusterReady ? '集群已就绪，按当前账户权限使用协作与管理能力。' : '集群尚未就绪，可在集群与服务中查看状态。' : '当前服务以单实例运行，集群能力取决于服务器装配。'}</p>
      <div className="lumo-environment-actions">
        {reconnect ? <Button size="sm" type="button" disabled={state === 'connecting'} onClick={reconnect}><RefreshIcon size={14} />重新连接</Button> : null}
        {deployment ? <Button size="sm" type="button" onClick={() => navigate(deployment.mode === 'local' ? 'local' : 'operations')}><SettingsIcon size={14} />{deployment.mode === 'local' ? '本机管理' : '集群与服务'}</Button> : null}
        {deployment?.mode === 'local' ? <Button size="sm" type="button" onClick={() => navigate('hosts')}><IconLinkOutlineRegular size={14} />SSH 远端机器</Button> : null}
      </div>
    </section>
    <section className="lumo-server-book" aria-label="服务器地址簿">
      <header><div><h2>服务器</h2><p>在浏览器中打开远端工作台，使用该服务器的账户登录。</p></div><Button ref={addButton} size="sm" type="button" aria-label="添加服务器" title="添加服务器" disabled={!bookReady || saving} onClick={() => { setEditing(undefined); setDraft({ name: '', origin: '' }) }}><AddIcon size={17} /></Button></header>
      {error ? <p role="alert">{error}</p> : null}
      {servers.length ? <ul>{servers.map(server => <li key={server.origin}>
        <IconGlobeOutlineRegular size={18} /><div className="lumo-server-name"><b>{server.name}</b><small>{server.origin}</small></div>
        {server.origin === window.location.origin ? <span className="lumo-server-active">当前</span> : <a href={server.origin} target="_blank" rel="noopener noreferrer" aria-label={`连接 ${server.name}`} title="在浏览器中连接服务器"><IconLinkOutlineRegular size={16} /></a>}
        <Button size="sm" type="button" aria-label={`编辑 ${server.name}`} title="编辑" onClick={() => { setEditing(server.origin); setDraft(server) }}><IconEditOutlineRegular size={15} /></Button>
        <Button size="sm" type="button" aria-label={`移除 ${server.name}`} title="移除地址" disabled={saving || !bookReady} onClick={async () => { setSaving(true); try { setServers(await saveSharedServerBook(nativeBook, { remove: server.origin })); if (editing === server.origin) cancel() } catch (reason) { setError(reason instanceof Error ? reason.message : '移除失败。') } finally { setSaving(false) } }}><IconTrashOutlineRegular size={15} /></Button>
      </li>)}</ul> : <p className="lumo-server-empty">添加已部署的单实例或分布式服务器地址。</p>}
      {draft ? <form className="lumo-server-form" onSubmit={event => { event.preventDefault(); save() }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel() } }}>
        <label>名称<Input ref={nameInput} aria-label="服务器名称" value={draft.name} maxLength={60} required placeholder="团队服务器" onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
        <label>服务器地址<Input aria-label="服务器地址" value={draft.origin} maxLength={512} required placeholder="https://lumo.example.com" onChange={event => setDraft({ ...draft, origin: event.target.value })} /></label>
        <div><Button size="sm" type="submit" disabled={saving || !bookReady}>保存</Button><Button size="sm" type="button" onClick={cancel}>取消</Button></div>
      </form> : null}
      <small className="lumo-server-note">{nativeBook ? '地址簿与桌宠共享。' : '地址保存在当前浏览器。'}SSH 隧道可填写 http://127.0.0.1:端口；连接后在远端工作台管理项目与集群。</small>
    </section>
    {deployment?.desktop ? <DesktopDevicePanel servers={servers} /> : null}
  </div>
}

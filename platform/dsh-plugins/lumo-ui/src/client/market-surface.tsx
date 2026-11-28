import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { api } from './api.ts'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import { BusyButton, Empty, Notice } from './surface-shell.tsx'
import { ManagementHeader } from './management-navigation.tsx'
import { managementEntries, managementGroups, type ManagementAccess, type ManagementEntry } from './management-catalog.ts'
import { RegistryPanel } from './registry-panel.tsx'
import { OPERATIONS_TARGET_EVENT, peekOperationsTarget, takeOperationsTarget, type OperationsArea } from './operations-navigation.ts'
import { EnvironmentPanel } from './environment-panel.tsx'
import type { AuthAccount, DeploymentState, Overview, Surface } from './surface-types.ts'
import './management.css'

export function MarketSurface({ onClose, initialArea, renderOperations, renderSurface }: {
  onClose: () => void
  initialArea?: OperationsArea | undefined
  renderOperations: (area: OperationsArea, select: (area: OperationsArea) => void) => ReactNode
  renderSurface: (surface: Surface) => ReactNode
}) {
  const [access, setAccess] = useState<ManagementAccess | null>(null)
  const [deployment, setDeployment] = useState<DeploymentState | null>(null)
  const [selected, setSelected] = useState<string>(initialArea ?? 'connections')
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const runtime = await api<Overview>('/lumo/api/overview')
      setDeployment(runtime.deployment)
      const local = runtime.deployment.mode === 'local'
      const [account, capabilities] = local ? [null, null] : await Promise.all([
        api<AuthAccount>('/auth/account', { headers: { 'X-Lumo-Auth-Request': '1' } }).catch(() => null),
        api<{ organization: boolean }>('/lumo/api/capabilities').catch(() => null),
      ])
      setAccess({ local, clusterReady: runtime.deployment.clusterReady,
        organization: capabilities?.organization === true && Boolean(account?.roles.some(role => ['admin', 'realm_admin', 'platform_admin'].includes(role))),
        platformAdmin: account?.roles.includes('platform_admin') === true })
    } catch { setAccess(null); setDeployment(null); setError('暂时无法读取管理能力，请重试。') }
    finally { setLoading(false) }
  }, [])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (initialArea && !peekOperationsTarget()) setSelected(initialArea) }, [initialArea])
  useEffect(() => {
    const navigate = () => {
      const target = peekOperationsTarget()
      if (target) {
        setSelected(target.kind === 'area' ? target.area : target.kind === 'task' ? 'delivery' : 'projects')
        if (target.kind === 'area' && target.area === 'connections') takeOperationsTarget()
      }
    }
    navigate()
    window.addEventListener(OPERATIONS_TARGET_EVENT, navigate)
    return () => window.removeEventListener(OPERATIONS_TARGET_EVENT, navigate)
  }, [])
  const entries = access ? managementEntries(access) : []
  const current = entries.find(entry => entry.id === selected)
  const groups = managementGroups.filter(group => entries.some(entry => entry.group === group.id))
  const filtered = entries.filter(entry => `${entry.title} ${entry.description}`.toLowerCase().includes(query.trim().toLowerCase()))
  const select = (entry?: ManagementEntry) => { setSelected(entry?.id ?? ''); setQuery('') }
  useEffect(() => { document.querySelector('.lumo-workbench-main > main')?.scrollTo?.(0, 0) }, [selected])
  return <div className="lumo-surface lumo-workspace-page lumo-management-page">
    <ManagementHeader title="管理工作台" description={current ? `${managementGroups.find(group => group.id === current.group)?.title} · ${current.title}` : '按用途管理项目、运行环境、能力和权限。'} onClose={onClose} />
    {error ? <Notice error>{error}<BusyButton busy={loading} onClick={() => void load()}>重试</BusyButton></Notice> : null}
    {loading ? <Empty>正在读取可用管理功能…</Empty> : null}
    {!access && !loading ? <EnvironmentPanel deployment={null} navigate={setSelected} refresh={() => void load()} loading={loading} /> : null}
    {access ? <div className="lumo-management-layout">
      <select className="lumo-management-mobile" aria-label="选择管理功能" value={current?.id ?? ''} onChange={event => select(entries.find(entry => entry.id === event.target.value))}>
        <option value="">全部管理</option>{groups.map(group => <optgroup key={group.id} label={group.title}>{entries.filter(entry => entry.group === group.id).map(entry => <option key={entry.id} value={entry.id}>{entry.title}</option>)}</optgroup>)}
      </select>
      <aside className="lumo-management-menu lumo-native-content">
        <Input type="search" aria-label="查找管理功能" placeholder="搜索管理功能" value={query} onChange={event => setQuery(event.target.value)} />
        <Button size="sm" type="button" onClick={() => select()}>全部管理</Button>
        <nav aria-label="管理分类">{groups.filter(group => filtered.some(entry => entry.group === group.id)).map(group => <section key={group.id}>
          <button type="button" className="lumo-management-group" onClick={() => select(entries.find(entry => entry.group === group.id))}>{group.title}</button>
          {filtered.filter(entry => entry.group === group.id).map(entry => <Button size="sm" type="button" key={entry.id} aria-current={entry.id === selected ? 'page' : undefined} title={entry.description} onClick={() => select(entry)}>{entry.title}</Button>)}
        </section>)}</nav>
        {!filtered.length ? <small>没有匹配的管理功能</small> : null}
      </aside>
      <div className="lumo-management-body">
    {current ? <>
      <section className="lumo-management-content" aria-label={current.title} key={current.area ? 'operations' : current.id}>
        {current.id === 'connections' && deployment ? <EnvironmentPanel deployment={deployment} navigate={setSelected} refresh={() => void load()} loading={loading} /> : current.area ? renderOperations(current.area, setSelected) : current.id === 'registry' ? <RegistryPanel /> : current.surface ? renderSurface(current.surface) : null}
      </section>
    </> : <>
      <div className="lumo-workspace-directory">
        {groups.filter(group => filtered.some(entry => entry.group === group.id)).map(group => <section key={group.id} className="lumo-directory-domain" aria-label={group.title}>
          <header><h2>{group.title}</h2><span>{group.description}</span></header>
          <div>{filtered.filter(entry => entry.group === group.id).map(entry => <button type="button" className="lumo-directory-entry" key={entry.id} onClick={() => select(entry)}>
            <span><b>{entry.title}</b><small>{entry.description}</small></span><i aria-hidden="true">→</i>
          </button>)}</div>
        </section>)}
        {!filtered.length ? <Empty>没有匹配的管理功能，请尝试其他关键词。</Empty> : null}
      </div>
    </>}
      </div>
    </div> : null}
  </div>
}

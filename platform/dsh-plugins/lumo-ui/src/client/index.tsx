import { useCallback, useEffect, useState, type ButtonHTMLAttributes, type FormEvent, type ReactNode } from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import './lumo.css'

interface ServiceState { ok: boolean; status: number; error?: string }
interface NodeState { node_id?: string; cluster_id?: string; capacity?: number; residency?: string }
interface Operation { name?: string; method?: string; write?: boolean }
interface Row { id?: string; name?: string; status?: string; realm?: string; version?: number; protocol?: string; operations?: Operation[]; projectId?: string; visibility?: string; author?: string }
interface Plugin { id: string; label: string; description: string; surface: Tab; kind: 'runtime' | 'governance' }
interface Overview {
  generatedAt: string
  services: Record<string, ServiceState>
  cluster: { leader?: { holder?: string }; nodes: NodeState[] }
  projects: Row[]
  flows: Row[]
  connectors: Row[]
  plugins: Plugin[]
}
interface Dashboard { project?: Row; yourRole?: string; members?: unknown[]; artifacts?: unknown[]; spaces?: unknown[]; automations?: unknown[]; usage?: unknown[]; budget?: { amount?: number; remaining?: number } }
interface ProbeResult { status?: number; url?: string; durationMs?: number; redacted?: boolean; body?: unknown; contentType?: string }
interface Activity { id: number; text: string; tone: 'ok' | 'warn'; time: string }

type Tab = 'overview' | 'projects' | 'flows' | 'connectors' | 'plugins'
type OverlayProps = PropsRuntime<'shell.overlay'>

const empty: Overview = { generatedAt: '', services: {}, cluster: { nodes: [] }, projects: [], flows: [], connectors: [], plugins: [] }
const tabs: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: '脉冲' }, { id: 'projects', label: '项目' }, { id: 'flows', label: '流程' }, { id: 'connectors', label: '连接器' }, { id: 'plugins', label: '插件' },
]

function time(): string { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) }

function errorMessage(body: unknown, fallback: string): string {
  if (typeof body === 'object' && body !== null) {
    const value = (body as { error?: unknown; message?: unknown }).error ?? (body as { message?: unknown }).message
    if (typeof value === 'string' && value !== '') return value
  }
  return fallback
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(init.headers ?? {}) },
  })
  const text = await response.text()
  let body: unknown = null
  try { body = text === '' ? null : JSON.parse(text) } catch { body = text }
  if (!response.ok) throw new Error(errorMessage(body, `请求失败 (${response.status})`))
  return body as T
}

function countOnline(data: Overview): number { return Object.values(data.services).filter(service => service.ok).length }
function actionLabel(flow: Row): string | undefined { return flow.status === 'draft' ? '提交审核' : ['published', 'targeted'].includes(flow.status ?? '') ? '试运行' : undefined }
function surfaceLabel(surface: Tab): string { return { overview: '脉冲', projects: '项目', flows: '流程', connectors: '连接器', plugins: '插件' }[surface] }

function Section({ title, meta, children, className = '' }: { title: string; meta?: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`lumo-section ${className}`}><div className="lumo-section-title"><b>{title}</b>{meta === undefined ? null : <span>{meta}</span>}</div>{children}</section>
}

function Empty({ children }: { children: ReactNode }) { return <p className="lumo-muted lumo-empty">{children}</p> }
function BusyButton({ busy, children, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { busy?: boolean }) {
  return <button type="button" className={`lumo-button ${className}`} disabled={busy || props.disabled} {...props}>{busy ? <span className="lumo-spinner" /> : null}{children}</button>
}

function ServiceRail({ services }: { services: Record<string, ServiceState> }) {
  const entries = Object.entries(services)
  return <div className="lumo-service-rail">{entries.map(([name, service]) => <div className="lumo-service" key={name}><i className={service.ok ? 'lumo-online' : 'lumo-offline'} /><span><b>{name}</b><small>{service.ok ? 'ready' : service.error || 'unavailable'}</small></span><em>{service.status || '—'}</em></div>)}</div>
}

function DashboardSheet({ data, close }: { data: Dashboard; close: () => void }) {
  const project = data.project ?? {}
  const facts = [
    ['成员', data.members?.length ?? 0], ['知识空间', data.spaces?.length ?? 0], ['制品', data.artifacts?.length ?? 0],
    ['自动化', data.automations?.length ?? 0], ['计量事件', data.usage?.length ?? 0], ['预算', data.budget?.remaining ?? data.budget?.amount ?? '—'],
  ]
  return <aside className="lumo-sheet" aria-label="项目详情"><div className="lumo-sheet-heading"><div><span className="lumo-eyebrow">PROJECT FIELD CARD</span><h3>{project.name ?? project.id}</h3><p>{data.yourRole ?? 'member'} · {project.realm ?? '—'}</p></div><BusyButton aria-label="关闭项目详情" onClick={close} className="lumo-quiet">×</BusyButton></div><div className="lumo-fact-grid">{facts.map(([label, value]) => <div key={String(label)}><small>{label}</small><b>{String(value)}</b></div>)}</div></aside>
}

function Panel({ close }: { close: () => void }) {
  const [tab, setTab] = useState<Tab>('overview')
  const [data, setData] = useState<Overview>(empty)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<Dashboard | null>(null)
  const [activity, setActivity] = useState<Activity[]>([])
  const [probeResult, setProbeResult] = useState<ProbeResult | null>(null)

  const addActivity = useCallback((text: string, tone: Activity['tone'] = 'ok') => {
    setActivity(previous => [{ id: Date.now(), text, tone, time: time() }, ...previous].slice(0, 4))
  }, [])

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setRefreshing(true)
    setError('')
    try {
      const overview = await api<Overview>('/lumo/api/overview')
      setData(overview)
      if (!quiet) addActivity(`控制面同步 · ${countOnline(overview)}/${Object.keys(overview.services).length || 4} ready`)
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setError(message)
      if (!quiet) addActivity(`同步受阻 · ${message}`, 'warn')
    } finally {
      setLoading(false)
      setRefreshing(false)
    }
  }, [addActivity])

  useEffect(() => {
    void load()
    const interval = window.setInterval(() => { void load(true) }, 20_000)
    return () => window.clearInterval(interval)
  }, [load])

  const action = async <T,>(key: string, success: string, operation: () => Promise<T>): Promise<T | undefined> => {
    setBusy(key)
    setNotice('')
    try {
      const result = await operation()
      setNotice(success)
      addActivity(success)
      await load(true)
      return result
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : String(reason)
      setNotice(message)
      addActivity(`${success}未完成 · ${message}`, 'warn')
      return undefined
    } finally { setBusy(null) }
  }

  const createProject = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const name = String(new FormData(form).get('name') ?? '').trim()
    if (!name) { setNotice('请输入项目名称。'); return }
    const result = await action('project-create', `项目「${name}」已创建`, () => api<Row>('/lumo/api/projects', { method: 'POST', body: JSON.stringify({ name }) }))
    if (result !== undefined) form.reset()
  }

  const openDashboard = async (project: Row) => {
    const projectID = project.id
    if (!projectID) return
    const result = await action(`dashboard-${projectID}`, `已读取「${project.name ?? projectID}」项目卡`, () => api<Dashboard>(`/lumo/api/projects/${encodeURIComponent(projectID)}/dashboard`))
    if (result !== undefined) setDashboard(result)
  }

  const createFlow = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const fields = new FormData(form)
    const projectID = String(fields.get('project') ?? '')
    const name = String(fields.get('name') ?? '').trim()
    if (!projectID || !name) { setNotice('选择项目并填写流程名称后再创建。'); return }
    const definition = { nodes: [{ id: 'start', operator: 'identity' }], edges: [] }
    const result = await action('flow-create', `流程「${name}」已创建为草稿`, () => api<Row>(`/lumo/api/projects/${encodeURIComponent(projectID)}/flows`, { method: 'POST', body: JSON.stringify({ name, definition }) }))
    if (result !== undefined) form.reset()
  }

  const triggerFlow = async (flow: Row) => {
    const flowID = flow.id
    if (!flowID) return
    const label = actionLabel(flow)
    if (label === '提交审核') {
      await action(`flow-${flowID}`, `流程「${flow.name ?? flowID}」已提交审核`, () => api<Row>(`/lumo/api/flows/${encodeURIComponent(flowID)}/submit`, { method: 'POST', body: '{}' }))
      return
    }
    if (label === '试运行') {
      const result = await action(`flow-${flowID}`, `流程「${flow.name ?? flowID}」运行完成`, () => api<{ order?: string[] }>(`/lumo/api/flows/${encodeURIComponent(flowID)}/run`, { method: 'POST', body: JSON.stringify({ input: { source: 'lumo-native-ui', at: new Date().toISOString() } }) }))
      if (result?.order?.length) setNotice(`流程运行完成 · ${result.order.join(' → ')}`)
    }
  }

  const disableConnector = async (connector: Row) => {
    const connectorID = connector.id
    if (!connectorID || !window.confirm(`确定停用连接器「${connector.name ?? connectorID}」？运行中的工作流将不能再调用它。`)) return
    await action(`connector-${connectorID}`, `连接器「${connector.name ?? connectorID}」已停用`, () => api<void>(`/lumo/api/connectors/${encodeURIComponent(connectorID)}`, { method: 'DELETE' }))
  }

  const probeWeb = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const url = String(new FormData(event.currentTarget).get('url') ?? '').trim()
    if (!url) { setNotice('请输入需要检查的 URL。'); return }
    const result = await action('web-probe', 'Web 出站策略已返回结果', () => api<ProbeResult>('/lumo/api/web/fetch', { method: 'POST', body: JSON.stringify({ url }) }))
    if (result !== undefined) setProbeResult(result)
  }

  const online = countOnline(data)
  const projectOptions = data.projects.filter(project => project.id)

  return <section className="lumo-panel" aria-label="Lumo 平台运营面" aria-busy={loading || refreshing}>
    <header className="lumo-panel-header">
      <div><span className="lumo-eyebrow">LUMO / NATIVE DSH</span><h2>控制信号室</h2><p>受控同源网关 <i /> 会话身份由服务端绑定</p></div>
      <div className="lumo-header-actions"><span className={online === Object.keys(data.services).length && online > 0 ? 'lumo-health healthy' : 'lumo-health'}>{online}/{Object.keys(data.services).length || 4}</span><BusyButton aria-label="刷新控制面" onClick={() => void load()} busy={refreshing} className="lumo-quiet">↻</BusyButton><BusyButton aria-label="关闭运营面" onClick={close} className="lumo-quiet">×</BusyButton></div>
    </header>

    <nav className="lumo-tabs" aria-label="Lumo 运营导航">{tabs.map(item => <button type="button" key={item.id} className={item.id === tab ? 'lumo-active-tab' : ''} onClick={() => setTab(item.id)}>{item.label}</button>)}</nav>
    {error ? <div className="lumo-alert error">控制面暂不可达：{error}<button type="button" onClick={() => void load()}>重试</button></div> : null}
    {notice ? <div className="lumo-alert notice"><span>{notice}</span><button type="button" onClick={() => setNotice('')} aria-label="关闭提示">×</button></div> : null}
    {loading ? <div className="lumo-loading"><span className="lumo-spinner" /> 正在接入控制面…</div> : null}

    <main className="lumo-content">
      {tab === 'overview' ? <>
        <div className="lumo-metric-grid"><Metric label="控制面" value={`${online}/${Object.keys(data.services).length || 4}`} note={online === Object.keys(data.services).length && online > 0 ? '全链路就绪' : '等待服务'} /><Metric label="执行节点" value={String(data.cluster.nodes.length)} note={data.cluster.leader?.holder ?? '等待 leader'} /><Metric label="已装配能力" value={String(data.plugins.length)} note="DSH patch" /></div>
        <Section title="控制面服务" meta={data.generatedAt ? `同步 ${new Date(data.generatedAt).toLocaleTimeString('zh-CN')}` : '尚未同步'}><ServiceRail services={data.services} /></Section>
        <Section title="调度路由" meta={data.cluster.leader?.holder ?? '无 leader'}>{data.cluster.nodes.length ? <div className="lumo-node-list">{data.cluster.nodes.slice(0, 4).map(node => <div className="lumo-row" key={node.node_id}><i className="lumo-online" /><span><b>{node.node_id}</b><small>{node.cluster_id} · {node.residency || 'residency unset'}</small></span><em>{node.capacity ?? 0} slots</em></div>)}</div> : <Empty>暂无动态执行节点；承载节点注册到 Nacos 后会自动出现在这里。</Empty>}</Section>
        <Section title="运行轨迹" meta="本次会话">{activity.length ? <div className="lumo-activity">{activity.map(item => <div className={`lumo-activity-row ${item.tone}`} key={item.id}><i /><span>{item.text}</span><time>{item.time}</time></div>)}</div> : <Empty>面板会记录本次会话的刷新与操作结果。</Empty>}</Section>
      </> : null}

      {tab === 'projects' ? <>
        <Section title="新建项目" meta="创建后自动成为 owner"><form className="lumo-inline-form" onSubmit={createProject}><input name="name" maxLength={120} placeholder="例如：增长实验室" aria-label="项目名称" /><BusyButton type="submit" busy={busy === 'project-create'} className="lumo-primary">创建</BusyButton></form></Section>
        <Section title="可见项目" meta={`${data.projects.length} 个边界`}>{data.projects.length ? <div className="lumo-card-list">{data.projects.map(project => <button type="button" className="lumo-project-card" key={project.id} onClick={() => void openDashboard(project)} disabled={busy === `dashboard-${project.id}`}><span className="lumo-project-mark">{(project.name ?? project.id ?? '?').slice(0, 1).toUpperCase()}</span><span><b>{project.name ?? project.id}</b><small>{project.realm ?? '当前 realm'} · {project.status ?? 'active'}</small></span><em>查看 ›</em></button>)}</div> : <Empty>当前 realm 没有可见项目。先创建一个项目，后续的流程与计量才有明确归属。</Empty>}</Section>
      </> : null}

      {tab === 'flows' ? <>
        <Section title="创建流程" meta="默认生成可执行 identity DAG"><form className="lumo-flow-form" onSubmit={createFlow}><select name="project" defaultValue="" aria-label="归属项目"><option value="" disabled>选择项目边界…</option>{projectOptions.map(project => <option key={project.id} value={project.id}>{project.name ?? project.id}</option>)}</select><input name="name" maxLength={120} placeholder="流程名称" aria-label="流程名称" /><BusyButton type="submit" busy={busy === 'flow-create'} className="lumo-primary">新建草稿</BusyButton></form></Section>
        <Section title="已发现流程" meta={`${data.flows.length} 条`}>{data.flows.length ? <div className="lumo-flow-list">{data.flows.map(flow => { const label = actionLabel(flow); return <div className="lumo-flow-row" key={flow.id}><i className={`lumo-flow-dot ${flow.status ?? 'unknown'}`} /><span><b>{flow.name ?? flow.id}</b><small>{flow.status ?? 'unknown'} · v{flow.version ?? 1} · {flow.visibility ?? 'private'}</small></span>{label ? <BusyButton busy={busy === `flow-${flow.id}`} onClick={() => void triggerFlow(flow)} className={label === '试运行' ? 'lumo-primary lumo-small' : 'lumo-small'}>{label}</BusyButton> : <em>等待治理动作</em>}</div> })}</div> : <Empty>流程会在项目创建后出现。草稿仅作者可见，提交后进入审核状态机。</Empty>}</Section>
      </> : null}

      {tab === 'connectors' ? <>
        <Section title="已注册连接器" meta={`${data.connectors.length} 个`}>{data.connectors.length ? <div className="lumo-connector-list">{data.connectors.map(connector => <div className="lumo-connector-row" key={connector.id}><span className="lumo-connector-mark">{(connector.name ?? connector.id ?? 'C').slice(0, 1).toUpperCase()}</span><span><b>{connector.name ?? connector.id}</b><small>{connector.protocol ?? 'unknown'} · {connector.operations?.length ?? 0} operations</small><span className="lumo-operation-list">{connector.operations?.slice(0, 3).map(operation => <i key={operation.name}>{operation.method || 'CALL'} {operation.name}</i>)}</span></span><BusyButton busy={busy === `connector-${connector.id}`} className="lumo-danger lumo-small" onClick={() => void disableConnector(connector)}>停用</BusyButton></div>)}</div> : <Empty>连接器清单为空。连接器 manifest 由受管登记流程写入，面板只暴露可安全调用的摘要。</Empty>}</Section>
        <Section title="Web 出站诊断" meta="受同一 SSRF / egress 策略保护"><form className="lumo-inline-form" onSubmit={probeWeb}><input name="url" type="url" placeholder="https://api.example.com/health" aria-label="待检查 URL" /><BusyButton type="submit" busy={busy === 'web-probe'} className="lumo-primary">检查</BusyButton></form>{probeResult ? <div className="lumo-probe-result"><span><b>{probeResult.status ?? '—'}</b> {probeResult.contentType ?? 'response'} · {probeResult.durationMs ?? 0} ms</span><small>{probeResult.redacted ? '响应已按策略脱敏' : probeResult.url ?? '策略已允许该请求'}</small></div> : null}</Section>
      </> : null}

      {tab === 'plugins' ? <Section title="已装配的 Lumo 能力" meta={`${data.plugins.length} 个 capability seam`} className="lumo-plugin-section">{data.plugins.length ? <div className="lumo-plugin-grid">{data.plugins.map(plugin => <button type="button" className="lumo-plugin-card" key={plugin.id} onClick={() => setTab(plugin.surface)}><span className={`lumo-plugin-icon ${plugin.kind}`}>{plugin.label.slice(0, 1)}</span><span><b>{plugin.label}</b><small>{plugin.description}</small></span><em>{surfaceLabel(plugin.surface)} ›</em></button>)}</div> : <Empty>插件清单将随 DSH patch 加载。请等待控制面同步完成。</Empty>}</Section> : null}
    </main>
    <footer className="lumo-panel-footer"><span>{refreshing ? '正在刷新控制面…' : '同源网关 · 现有服务权限仍为唯一执法位'}</span><a href="/lumo/ops">固定入口 ↗</a></footer>
    {dashboard ? <DashboardSheet data={dashboard} close={() => setDashboard(null)} /> : null}
  </section>
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) { return <div className="lumo-metric"><small>{label}</small><strong>{value}</strong><span>{note}</span></div> }

export function LumoOverlay(_props: OverlayProps) {
  const [open, setOpen] = useState(() => new URLSearchParams(location.search).get('lumo') === 'ops')
  return <div className="lumo-root">{open ? <Panel close={() => setOpen(false)} /> : <button type="button" className="lumo-launcher" onClick={() => setOpen(true)}><span className="lumo-launcher-mark">L</span><span><b>Lumo</b><small>运营面</small></span><i /></button>}</div>
}

export const inject = ['slots']
export function apply(ctx: ClientContext): void { ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'lumo-platform', order: 100 }, LumoOverlay)) }

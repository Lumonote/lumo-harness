import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'

type Request = <T>(path: string, init?: RequestInit) => Promise<T>
type Capability = { clusterReady: boolean; organization: boolean }
type Choice = { id: string; name?: string; display_name?: string; status?: string }

function message(error: unknown): string {
  if (error instanceof Error && 'status' in error && error.status === 409) return `${error.message}。数据已被其他操作更新，请重新读取后再提交。`
  return error instanceof Error ? error.message : String(error)
}
function Button({ children, onClick, disabled, danger = false, submit = false }: { children: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; submit?: boolean }) {
  return <button type={submit ? 'submit' : 'button'} className={`lumo-button ${danger ? 'lumo-danger' : 'lumo-secondary'}`} disabled={disabled} onClick={onClick}>{children}</button>
}
function Feedback({ error, notice }: { error: string; notice?: string }) {
  return <>{error ? <div className="lumo-cluster-feedback error" role="alert">{error}</div> : null}{notice ? <div className="lumo-cluster-feedback" role="status">{notice}</div> : null}</>
}
function useAction(refresh: () => Promise<void>) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const pending = useRef(false)
  const run = async (operation: () => Promise<unknown>, text: string) => {
    if (pending.current) return false
    pending.current = true; setBusy(true); setError(''); setNotice('')
    try {
      await operation(); setNotice(text)
      try { await refresh() } catch (reason) { setError(`已保存，刷新失败：${message(reason)}`) }
      return true
    } catch (reason) { setError(message(reason)); return false }
    finally { pending.current = false; setBusy(false) }
  }
  return { busy, error, notice, run, setError }
}
export function useClusterCapabilities(request: Request): Capability | null {
  const [capability, setCapability] = useState<Capability | null>(null)
  useEffect(() => {
    let active = true
    void request<Capability>('/lumo/api/capabilities').then(value => { if (active) setCapability(value) }).catch(() => { if (active) setCapability(null) })
    return () => { active = false }
  }, [request])
  return capability
}

interface DesktopNode {
  id: string; display_name: string; cluster_id: string; owner_user_id: string; os: string; arch: string
  client_version: string; capacity: number; capabilities: string[]; residency?: string; status: string; scheduling_eligible: boolean; last_seen_at: string
}
const nodeStatus: Record<string, string> = { ONLINE: '在线', OFFLINE: '离线', DRAINING: '排空中', REVOKED: '已撤销', PENDING_ACTIVATION: '待激活' }

interface DeviceArtifact { name: string; version: string; digest: string; payload_digest?: string }
interface DevicePolicy {
  root: string; name: string; version: string; client_version: string; artifacts: DeviceArtifact[]; scopes: string[]; shape: Record<string, boolean>
}
interface DeviceConnection {
  realm: string; node_id: string; owner_user_id: string; os: string; arch: string; status: string; revision: number; policy: DevicePolicy
  public_key_hash?: string; certificate_serial?: string; certificate_expires?: string; connection_expires?: string; applied_revision: number
  installed: DeviceArtifact[]; report_error?: string; last_report_at?: string
}
interface DeviceStatusResponse {
  device: DeviceConnection; gateway_url: string; process_runtime: boolean; connected: boolean
  permissions: { manage_policy: boolean; enroll: boolean; command: boolean; start: boolean }
}
interface DeviceCommand {
  id: string; action: string; state: string; revision: number; body?: { name?: string; version?: string }; result?: unknown; expires_at: string; created_at: string
}
interface Enrollment { code: string; expires_in: number; realm: string; node_id: string; gateway_url: string }
const deviceCommandStates: Record<string, string> = { queued: '等待领取', delivered: '已下发', completed: '已完成', failed: '执行失败', interrupted: '已中断', expired: '已过期' }
const deviceCommandActions: Record<string, string> = { reconcile: '立即收敛', start: '启动进程', stop: '停止进程' }
const deviceShapes = [{ id: 'olap', name: 'OLAP' }, { id: 'graph', name: '图计算' }, { id: 'vector', name: '向量检索' }, { id: 'object', name: '对象存储' }, { id: 'gpu', name: 'GPU' }]

export function ClusterNodesPanel({ request }: { request: Request }) {
  const capability = useClusterCapabilities(request)
  const [nodes, setNodes] = useState<DesktopNode[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [status, setStatus] = useState('all')
  const [registering, setRegistering] = useState(false)
  const [confirmation, setConfirmation] = useState('')
  const [selectedNodeID, setSelectedNodeID] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    try { const result = await request<{ nodes: DesktopNode[] }>('/lumo/api/desktop-nodes'); setNodes(result.nodes ?? []); setError('') }
    catch (reason) { setError(message(reason)) }
    finally { setLoading(false) }
  }, [request])
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 30000); return () => window.clearInterval(timer) }, [load])
  const action = useAction(load)
  const visible = nodes.filter(node => (status === 'all' || node.status === status) && `${node.id} ${node.display_name} ${node.cluster_id} ${node.owner_user_id}`.toLowerCase().includes(filter.toLowerCase()))
  const update = async (id: string, state: string) => {
    if (await action.run(() => request(`/lumo/api/desktop-nodes/${encodeURIComponent(id)}/state`, { method: 'PUT', body: JSON.stringify({ status: state }) }), `节点状态已更新为${nodeStatus[state]}。`)) setConfirmation('')
  }
  const register = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form)
    const value = (key: string) => String(fields.get(key) ?? '').trim()
    if (await action.run(() => request('/lumo/api/desktop-nodes', { method: 'POST', body: JSON.stringify({
      id: value('id'), display_name: value('display_name'), cluster_id: value('cluster_id'), os: value('os'), arch: value('arch'), client_version: value('client_version'),
      residency: value('residency'), capacity: Number(fields.get('capacity')), capabilities: value('capabilities').split(',').map(item => item.trim()).filter(Boolean),
    }) }), '设备已登记，当前状态为待激活。')) { form.reset(); setRegistering(false) }
  }
  return <section className="lumo-section lumo-cluster-panel">
    <div className="lumo-section-title"><div><b>受管桌面节点</b><span>{loading ? '正在同步' : `${visible.length} 个节点`}</span></div><div className="lumo-form-actions"><Button disabled={loading} onClick={() => void load()}>刷新</Button><Button disabled={action.busy} onClick={() => setRegistering(value => !value)}>{registering ? '取消登记' : '登记设备'}</Button></div></div>
    <Feedback error={error || action.error} notice={action.notice} />
    <div className="lumo-cluster-toolbar"><label>搜索节点<input value={filter} onChange={event => setFilter(event.target.value)} /></label><label>节点状态<select value={status} onChange={event => setStatus(event.target.value)}><option value="all">全部</option>{Object.entries(nodeStatus).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label></div>
    <div className="lumo-cluster-list">{visible.map(node => <div key={node.id} className={selectedNodeID === node.id ? 'selected' : ''}><span><b>{node.display_name}</b><small>{node.id} · {node.cluster_id} · {node.owner_user_id}</small><small>{node.os}/{node.arch} · {node.client_version} · {node.capacity} 并发 · {node.residency || '未声明驻留'}</small><small>{node.capabilities?.join(' · ') || '无能力声明'} · 最近心跳 {new Date(node.last_seen_at).toLocaleString('zh-CN')}</small></span><span><b>{nodeStatus[node.status] ?? node.status}</b><small>{node.scheduling_eligible ? '可调度' : '不可调度'}</small></span><div className="lumo-form-actions"><Button disabled={action.busy} onClick={() => setSelectedNodeID(current => current === node.id ? '' : node.id)}>{selectedNodeID === node.id ? '收起详情' : '接入详情'}</Button>{capability?.organization && node.status !== 'REVOKED' ? <><Button disabled={action.busy || node.status === 'DRAINING'} onClick={() => void update(node.id, 'DRAINING')}>排空</Button>{node.status === 'DRAINING' ? <Button disabled={action.busy} onClick={() => void update(node.id, 'PENDING_ACTIVATION')}>重新激活</Button> : null}{confirmation === node.id ? <><Button danger disabled={action.busy} onClick={() => void update(node.id, 'REVOKED')}>确认撤销</Button><Button onClick={() => setConfirmation('')}>取消</Button></> : <Button danger disabled={action.busy} onClick={() => setConfirmation(node.id)}>撤销设备</Button>}</> : null}</div></div>)}</div>
    {!visible.length ? <p className="lumo-inline-empty">{loading ? '正在读取节点。' : error ? '节点目录读取失败。' : '没有匹配的设备。'}</p> : null}
    {selectedNodeID ? <DeviceDetailPanel key={selectedNodeID} request={request} node={nodes.find(node => node.id === selectedNodeID)} refreshNodes={load} close={() => setSelectedNodeID('')} /> : null}
    {registering ? <form className="lumo-governance-form lumo-cluster-form" onSubmit={register}>
      <label>设备 ID<input name="id" maxLength={128} /></label><label>设备名称<input name="display_name" required maxLength={160} /></label><label>集群 ID<input name="cluster_id" required maxLength={128} /></label>
      <label>操作系统<select name="os"><option value="windows">Windows</option><option value="macos">macOS</option><option value="linux">Linux</option></select></label><label>架构<select name="arch"><option value="arm64">ARM64</option><option value="amd64">AMD64</option></select></label><label>客户端版本<input name="client_version" required maxLength={64} /></label>
      <label>并发上限<input name="capacity" type="number" min={1} max={1024} step={1} defaultValue={1} required /></label><label>数据驻留<input name="residency" maxLength={128} /></label><label>能力<input name="capabilities" maxLength={1024} /></label><div className="lumo-user-form-actions"><Button submit disabled={action.busy}>登记设备</Button></div>
    </form> : null}
  </section>
}

function DeviceDetailPanel({ request, node, refreshNodes, close }: { request: Request; node: DesktopNode | undefined; refreshNodes: () => Promise<void>; close: () => void }) {
  const nodeID = node?.id ?? ''
  const observedNodeStatus = node?.status ?? ''
  const base = `/lumo/api/desktop-nodes/${encodeURIComponent(nodeID)}/device`
  const [status, setStatus] = useState<DeviceStatusResponse | null>(null)
  const [commands, setCommands] = useState<DeviceCommand[]>([])
  const [enrollment, setEnrollment] = useState<Enrollment | null>(null)
  const [commandAction, setCommandAction] = useState('reconcile')
  const [artifactIndex, setArtifactIndex] = useState('0')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const load = useCallback(async () => {
    if (!nodeID) return
    const current = ++sequence.current
    setLoading(true)
    try {
      const [device, history] = await Promise.all([request<DeviceStatusResponse>(base), request<{ commands: DeviceCommand[] }>(`${base}/commands`)])
      if (current !== sequence.current) return
      setStatus(device); setCommands(history.commands ?? []); setError('')
      setArtifactIndex(index => device.device.policy.artifacts?.[Number(index)] ? index : '0')
    } catch (reason) { if (current === sequence.current) setError(message(reason)) }
    finally { if (current === sequence.current) setLoading(false) }
  }, [request, nodeID, observedNodeStatus, base])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load])
  const refreshAll = useCallback(async () => { await Promise.all([load(), refreshNodes()]) }, [load, refreshNodes])
  const action = useAction(refreshAll)
  if (!node) return null
  const connection = status?.device
  const policy = connection?.policy
  const artifacts = policy?.artifacts ?? []
  const selectedArtifact = artifacts[Number(artifactIndex)]
  const approvedShape = JSON.stringify(Object.fromEntries(Object.entries(policy?.shape ?? {}).filter(([, enabled]) => enabled)))
  const agentCommand = policy?.client_version ? [
    'desktop-agent \\',
    `  -gateway ${status?.gateway_url ?? '<设备网关>'} \\`,
    `  -realm ${connection?.realm ?? '<realm>'} \\`,
    `  -node ${nodeID} \\`,
    '  -state-dir <身份状态绝对路径> \\',
    '  -install-dir <制品安装绝对路径> \\',
    '  -trust-file <发布者信任文件> \\',
    `  -shape '${approvedShape}' \\`,
    `  -client-version ${policy.client_version} \\`,
    '  -enrollment-code-file <激活码文件>',
  ].join('\n') : ''
  const savePolicy = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!connection) return
    const fields = new FormData(event.currentTarget)
    const value = (key: string) => String(fields.get(key) ?? '').trim()
    const shape = Object.fromEntries(deviceShapes.map(item => [item.id, fields.get(item.id) === 'on']))
    await action.run(() => request(`${base}/policy`, { method: 'PUT', body: JSON.stringify({ revision: connection.revision, name: value('name'), version: value('version'), client_version: value('client_version'), shape }) }), '设备策略已验签并保存；设备需重新激活后收敛。')
  }
  const issueEnrollment = async () => {
    await action.run(async () => { setEnrollment(await request<Enrollment>(`${base}/enrollment`, { method: 'POST' })) }, '一次性激活码已签发，有效期 5 分钟。')
  }
  const copyEnrollment = async () => {
    if (!enrollment) return
    try { await navigator.clipboard.writeText(enrollment.code) } catch (reason) { action.setError(`无法写入剪贴板：${message(reason)}`) }
  }
  const queueCommand = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!connection) return
    const artifact = commandAction === 'reconcile' ? undefined : selectedArtifact
    await action.run(() => request(`${base}/commands`, { method: 'POST', body: JSON.stringify({ revision: connection.revision, action: commandAction, name: artifact?.name ?? '', version: artifact?.version ?? '' }) }), `${deviceCommandActions[commandAction]}命令已加入设备队列。`)
  }
  const updateState = (next: string, notice: string) => action.run(() => request(`/lumo/api/desktop-nodes/${encodeURIComponent(nodeID)}/state`, { method: 'PUT', body: JSON.stringify({ status: next }) }), notice)
  const factTime = (value?: string) => value ? new Date(value).toLocaleString('zh-CN') : '—'
  return <aside className="lumo-device-console" aria-label={`${node.display_name} 设备接入详情`} aria-busy={loading}>
    <header><div><span className="lumo-device-kicker">DEVICE CONTROL / {node.cluster_id}</span><h3>{node.display_name}</h3><p>{node.id} · {node.os}/{node.arch} · 所有者 {node.owner_user_id}</p></div><div className="lumo-form-actions"><Button disabled={loading || action.busy} onClick={() => void load()}>刷新遥测</Button><Button disabled={action.busy} onClick={close}>关闭</Button></div></header>
    <Feedback error={error || action.error} notice={action.notice} />
    {status && connection ? <>
      <div className="lumo-device-telemetry">
        <div className={status.connected ? 'live' : ''}><small>连接链路</small><b>{status.connected ? 'LIVE' : 'OFFLINE'}</b><span>{status.gateway_url}</span></div>
        <div className={connection.applied_revision === connection.revision ? 'live' : 'warn'}><small>策略收敛</small><b>{connection.applied_revision} / {connection.revision}</b><span>{connection.report_error || '无上报错误'}</span></div>
        <div><small>客户端证书</small><b>{connection.certificate_serial ? 'ISSUED' : 'NOT ENROLLED'}</b><span>{factTime(connection.certificate_expires)}</span></div>
        <div><small>最后报告</small><b>{connection.status}</b><span>{factTime(connection.last_report_at)}</span></div>
      </div>
      <div className="lumo-device-lanes">
        <section>
          <div className="lumo-device-lane-title"><span>01</span><div><b>签名制品策略</b><small>策略更新会中断现有连接和未完成命令</small></div></div>
          {status.permissions.manage_policy ? <form key={`policy:${connection.revision}`} className="lumo-governance-form lumo-cluster-form lumo-device-policy" onSubmit={savePolicy}>
            <label>制品名称<input name="name" required maxLength={256} defaultValue={policy?.name ?? ''} placeholder="desktop-agent" /></label><label>精确版本<input name="version" required maxLength={128} defaultValue={policy?.version ?? ''} placeholder="1.0.0" /></label><label>客户端版本<input name="client_version" required maxLength={64} defaultValue={policy?.client_version || node.client_version} /></label>
            <fieldset className="wide"><legend>运行能力 Shape</legend>{deviceShapes.map(item => <label key={item.id}><input name={item.id} type="checkbox" defaultChecked={policy?.shape?.[item.id] === true} />{item.name}</label>)}</fieldset>
            <div className="lumo-user-form-actions wide"><Button submit disabled={loading || action.busy}>验证并保存策略 v{connection.revision + 1}</Button></div>
          </form> : <div className="lumo-device-policy-summary"><b>{policy?.root || '尚未配置制品策略'}</b><span>{policy?.scopes?.join(' · ') || '无 scope'}</span></div>}
          {artifacts.length ? <div className="lumo-device-artifacts">{artifacts.map((artifact, index) => <div key={`${artifact.name}:${artifact.version}`}><i>{String(index + 1).padStart(2, '0')}</i><span><b>{artifact.name}@{artifact.version}</b><small>{artifact.digest}</small></span><em>{connection.installed?.some(item => item.digest === artifact.digest) ? '已安装' : '待收敛'}</em></div>)}</div> : <p className="lumo-inline-empty">保存策略后，这里会显示 Registry 验签得到的完整依赖闭包。</p>}
        </section>
        <section>
          <div className="lumo-device-lane-title"><span>02</span><div><b>身份激活</b><small>激活码仅展示本次签发结果，5 分钟后失效</small></div></div>
          <div className="lumo-device-facts"><span><small>设备状态</small><b>{nodeStatus[connection.status] ?? connection.status}</b></span><span><small>连接租约</small><b>{factTime(connection.connection_expires)}</b></span><span><small>已批准网关</small><b>{status.gateway_url}</b></span></div>
          {enrollment ? <div className="lumo-enrollment-ticket"><span>ONE-TIME ACTIVATION</span><code>{enrollment.code}</code><small>{enrollment.realm}/{enrollment.node_id} · {enrollment.expires_in} 秒内有效</small><Button onClick={() => void copyEnrollment()}>复制激活码</Button></div> : null}
          {agentCommand ? <details className="lumo-device-bootstrap"><summary>查看 desktop-agent 启动参数模板</summary><p>先把激活码写入仅当前用户可读的文件；模板不会把密钥放进 URL 或进程参数。</p><code>{agentCommand}</code></details> : null}
          <div className="lumo-form-actions"><Button disabled={loading || action.busy || !status.permissions.enroll} onClick={() => void issueEnrollment()}>{enrollment ? '重新签发激活码' : '签发激活码'}</Button>{status.permissions.manage_policy && connection.status !== 'REVOKED' && connection.status !== 'PENDING_ACTIVATION' ? <Button danger disabled={action.busy} onClick={() => void updateState('PENDING_ACTIVATION', '设备已进入待激活状态；旧连接与命令已失效。')}>重置设备身份</Button> : null}</div>
          {!status.permissions.enroll ? <p className="lumo-device-hint">设备需处于待激活状态且已有有效策略，才可签发激活码。</p> : null}
        </section>
        <section>
          <div className="lumo-device-lane-title"><span>03</span><div><b>受控命令</b><small>命令绑定当前连接与策略 revision，不跨重连自动重放</small></div></div>
          <form className="lumo-device-command" onSubmit={queueCommand}><label>动作<select value={commandAction} onChange={event => setCommandAction(event.target.value)}><option value="reconcile">立即收敛</option><option value="start" disabled={!status.permissions.start || !status.process_runtime}>启动受控进程</option><option value="stop">停止受控进程</option></select></label>{commandAction !== 'reconcile' ? <label>制品<select value={artifactIndex} onChange={event => setArtifactIndex(event.target.value)}>{artifacts.map((artifact, index) => <option key={`${artifact.name}:${artifact.version}`} value={index}>{artifact.name}@{artifact.version}</option>)}</select></label> : null}<Button submit disabled={loading || action.busy || !status.permissions.command || !status.connected || (commandAction !== 'reconcile' && !selectedArtifact)}>下发命令</Button></form>
          {!status.connected ? <p className="lumo-device-hint">设备当前未建立有效连接，暂不能创建命令。</p> : !status.process_runtime ? <p className="lumo-device-hint">服务端未启用进程运行策略；仍可下发收敛和停止命令。</p> : null}
          <div className="lumo-device-command-log">{commands.map(command => <div key={command.id}><time>{new Date(command.created_at).toLocaleString('zh-CN')}</time><span><b>{deviceCommandActions[command.action] ?? command.action}</b><small>{command.body?.name ? `${command.body.name}@${command.body.version}` : `policy v${command.revision}`}</small></span><em className={command.state}>{deviceCommandStates[command.state] ?? command.state}</em>{command.result !== undefined ? <code>{typeof command.result === 'string' ? command.result : JSON.stringify(command.result)}</code> : null}</div>)}</div>
          {!commands.length ? <p className="lumo-inline-empty">尚无设备命令记录。</p> : null}
        </section>
      </div>
    </> : !loading ? <p className="lumo-inline-empty">设备接入详情不可用。</p> : <p className="lumo-inline-empty">正在读取设备策略、身份与命令记录。</p>}
  </aside>
}

interface SkillGrant { id: string; subject_type: string; subject_id: string; version_constraint?: string; include_children: boolean; expires_at?: string }
interface SkillRevocation { id: string; subject_type: string; subject_id: string; reason: string; expires_at?: string }
const subjects: Record<string, string> = { user: '用户', role: '角色', department: '部门', project: '项目', agent: 'Agent' }

export function SkillAccessPanel({ request, skillID, version }: { request: Request; skillID: string; version: string }) {
  const capability = useClusterCapabilities(request)
  const [access, setAccess] = useState<{ grants: SkillGrant[]; revocations: SkillRevocation[] }>({ grants: [], revocations: [] })
  const [choices, setChoices] = useState<Record<string, Choice[]>>({})
  const [subject, setSubject] = useState('user')
  const [subjectID, setSubjectID] = useState('')
  const [mode, setMode] = useState('grant')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    setLoading(true)
    try { setAccess(await request(`/lumo/api/governance/skills/${encodeURIComponent(skillID)}/access`)); setError('') }
    catch (reason) { setError(message(reason)) }
    finally { setLoading(false) }
  }, [request, skillID])
  useEffect(() => {
    if (!capability?.organization) return
    void load()
    let active = true
    void Promise.all([
      request<{ users: Choice[] }>('/lumo/api/users'), request<{ roles: Choice[] }>('/lumo/api/roles'), request<{ departments: Choice[] }>('/lumo/api/departments'),
      request<{ projects: Choice[] }>('/lumo/api/overview'), request<{ agent_presets: Choice[] }>('/lumo/api/agent-presets'),
    ]).then(([users, roles, departments, projects, agents]) => { if (active) setChoices({ user: users.users, role: roles.roles, department: departments.departments, project: projects.projects, agent: agents.agent_presets }) }).catch(reason => { if (active) setError(message(reason)) })
    return () => { active = false }
  }, [capability?.organization, load, request])
  const options = (choices[subject] ?? []).filter(item => !item.status || item.status === 'active')
  useEffect(() => { if (!options.some(item => item.id === subjectID)) setSubjectID(options[0]?.id ?? '') }, [choices, subject, subjectID])
  const action = useAction(load)
  if (!capability?.organization) return null
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form)
    const expiry = String(fields.get('expires_at') ?? '')
    const body = { subject_type: subject, subject_id: subjectID, expires_at: expiry ? new Date(expiry).toISOString() : null,
      ...(mode === 'grant' ? { version_constraint: String(fields.get('version') ?? ''), include_children: subject === 'department' && fields.get('include_children') === 'on' } : { reason: String(fields.get('reason') ?? '') }),
    }
    if (await action.run(() => request(`/lumo/api/governance/skills/${encodeURIComponent(skillID)}/${mode === 'grant' ? 'grants' : 'revocations'}`, { method: 'POST', body: JSON.stringify(body) }), mode === 'grant' ? '技能授权已保存。' : '技能禁用规则已保存。')) form.reset()
  }
  const remove = (resource: string, id: string) => action.run(() => request(`/lumo/api/governance/skills/${encodeURIComponent(skillID)}/${resource}/${encodeURIComponent(id)}`, { method: 'DELETE' }), '规则已移除。')
  const label = (type: string, id: string) => `${subjects[type] ?? type} · ${(choices[type] ?? []).find(item => item.id === id)?.display_name ?? (choices[type] ?? []).find(item => item.id === id)?.name ?? id}`
  return <section className="lumo-section lumo-cluster-panel"><div className="lumo-section-title"><div><b>技能授权</b><span>{loading ? '正在读取' : `${access.grants.length} 条授权 · ${access.revocations.length} 条禁用规则`}</span></div><Button disabled={loading} onClick={() => void load()}>刷新</Button></div><Feedback error={error || action.error} notice={action.notice} />
    <div className="lumo-cluster-list">{access.grants.map(grant => <div key={grant.id}><span><b>{label(grant.subject_type, grant.subject_id)}</b><small>{grant.version_constraint || '当前版本'}{grant.include_children ? ' · 含子部门' : ''} · {grant.expires_at ? new Date(grant.expires_at).toLocaleString('zh-CN') : '长期有效'}</small></span><Button danger disabled={action.busy} onClick={() => void remove('grants', grant.id)}>移除授权</Button></div>)}{access.revocations.map(rule => <div key={rule.id}><span><b>已禁用 · {label(rule.subject_type, rule.subject_id)}</b><small>{rule.reason || '未填写原因'} · {rule.expires_at ? new Date(rule.expires_at).toLocaleString('zh-CN') : '长期有效'}</small></span><Button disabled={action.busy} onClick={() => void remove('revocations', rule.id)}>解除禁用</Button></div>)}</div>
    <form className="lumo-governance-form lumo-cluster-form" onSubmit={save}>
      <label>规则类型<select value={mode} onChange={event => setMode(event.target.value)}><option value="grant">授权</option><option value="revoke">禁用</option></select></label><label>对象类型<select value={subject} onChange={event => setSubject(event.target.value)}>{Object.entries(subjects).map(([key, name]) => <option key={key} value={key}>{name}</option>)}</select></label><label>授权对象<select required value={subjectID} onChange={event => setSubjectID(event.target.value)}><option value="" disabled>选择对象</option>{options.map(item => <option key={item.id} value={item.id}>{item.display_name ?? item.name ?? item.id}</option>)}</select></label>
      <label>到期时间<input name="expires_at" type="datetime-local" /></label>{mode === 'grant' ? <><label>技能版本<input name="version" required defaultValue={version} key={version} maxLength={64} /></label>{subject === 'department' ? <label className="lumo-cluster-checkbox"><input name="include_children" type="checkbox" />包含子部门</label> : null}</> : <label>禁用原因<input name="reason" required maxLength={500} /></label>}
      <div className="lumo-user-form-actions"><Button submit danger={mode === 'revoke'} disabled={action.busy || !subjectID || loading}>保存规则</Button></div>
    </form>
  </section>
}

export interface ProjectMember { userId: string; role: string; addedAt?: string }
const memberRoles = [{ id: 'viewer', name: '只读成员' }, { id: 'editor', name: '编辑成员' }, { id: 'owner', name: '项目所有者' }]

export function ProjectMembersPanel({ request, projectID, members, editable, refresh }: { request: Request; projectID: string; members: ProjectMember[]; editable: boolean; refresh: () => Promise<void> }) {
  const action = useAction(refresh)
  const [confirmation, setConfirmation] = useState('')
  const add = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const form = event.currentTarget; const fields = new FormData(form)
    if (await action.run(() => request(`/lumo/api/projects/${encodeURIComponent(projectID)}/members`, { method: 'POST', body: JSON.stringify({ userId: String(fields.get('userId') ?? '').trim(), role: String(fields.get('role') ?? 'viewer') }) }), '项目成员已添加。')) form.reset()
  }
  const changeRole = (userID: string, role: string) => action.run(() => request(`/lumo/api/projects/${encodeURIComponent(projectID)}/members/${encodeURIComponent(userID)}`, { method: 'PATCH', body: JSON.stringify({ role }) }), '项目角色已更新。')
  const remove = async (userID: string) => { if (await action.run(() => request(`/lumo/api/projects/${encodeURIComponent(projectID)}/members/${encodeURIComponent(userID)}`, { method: 'DELETE' }), '项目成员已移除。')) setConfirmation('') }
  return <div className="lumo-cluster-panel"><h4>项目成员</h4><Feedback error={action.error} notice={action.notice} /><div className="lumo-cluster-list">{members.map(member => <div key={member.userId}><span><b>{member.userId}</b><small>{member.addedAt ? new Date(member.addedAt).toLocaleDateString('zh-CN') : ''}</small></span>{editable ? <><select aria-label={`${member.userId} 的项目角色`} disabled={action.busy} value={member.role} onChange={event => void changeRole(member.userId, event.target.value)}>{memberRoles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select><div className="lumo-form-actions">{confirmation === member.userId ? <><Button danger disabled={action.busy} onClick={() => void remove(member.userId)}>确认移除</Button><Button onClick={() => setConfirmation('')}>取消</Button></> : <Button danger disabled={action.busy} onClick={() => setConfirmation(member.userId)}>移除</Button>}</div></> : <span>{memberRoles.find(role => role.id === member.role)?.name ?? member.role}</span>}</div>)}</div>
    {editable ? <form className="lumo-governance-form lumo-cluster-form" onSubmit={add}><label>用户 ID<input name="userId" required maxLength={128} /></label><label>项目角色<select name="role">{memberRoles.map(role => <option key={role.id} value={role.id}>{role.name}</option>)}</select></label><div className="lumo-user-form-actions"><Button submit disabled={action.busy}>添加成员</Button></div></form> : null}
  </div>
}

export function ConnectorManifestPanel({ request, refresh }: { request: Request; refresh: () => Promise<void> }) {
  const [canManage, setCanManage] = useState(false)
  const [managedOAuth, setManagedOAuth] = useState(false)
  const action = useAction(refresh)
  const [source, setSource] = useState('')
  const [connectorID, setConnectorID] = useState(() => new URLSearchParams(window.location.search).get('connector') ?? '')
  const [loadedID, setLoadedID] = useState(() => new URLSearchParams(window.location.search).get('connector') ?? '')
  const [oauthRevision, setOAuthRevision] = useState(0)
  const sequence = useRef(0)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    let active = true
    void request<{ manage: boolean; managedOAuth: boolean }>('/lumo/api/connectors/capabilities').then(result => { if (active) { setCanManage(result.manage); setManagedOAuth(result.managedOAuth) } }).catch(() => { if (active) setCanManage(false) })
    return () => { active = false }
  }, [request])
  if (!canManage) return null
  const load = async () => {
    if (!connectorID.trim()) return
    const current = ++sequence.current
    const id = connectorID.trim()
    setLoading(true); action.setError('')
    try {
      const manifest = await request(`/lumo/api/connectors/${encodeURIComponent(id)}/manifest`)
      if (current === sequence.current) { setSource(JSON.stringify(manifest, null, 2)); setLoadedID(id); setOAuthRevision(value => value + 1) }
    }
    catch (reason) { if (current === sequence.current) action.setError(message(reason)) }
    finally { if (current === sequence.current) setLoading(false) }
  }
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    let manifest: unknown
    try { manifest = JSON.parse(source); if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw new Error('连接器配置必须为 JSON 对象。') }
    catch (reason) { action.setError(message(reason)); return }
    const id = connectorID.trim()
    if (await action.run(() => request(`/lumo/api/connectors/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(manifest) }), '连接器配置已保存。')) { setLoadedID(id); setOAuthRevision(value => value + 1) }
  }
  return <section className="lumo-section lumo-cluster-panel"><div className="lumo-section-title"><div><b>连接器配置</b></div></div><Feedback error={action.error} notice={action.notice} /><form className="lumo-governance-form lumo-cluster-form" onSubmit={save}><label>连接器 ID<input required disabled={action.busy} value={connectorID} onChange={event => { sequence.current++; setConnectorID(event.target.value); setLoadedID(''); setSource(''); setLoading(false) }} maxLength={128} /></label><div className="lumo-form-actions"><Button disabled={loading || !connectorID || action.busy} onClick={() => void load()}>读取配置</Button></div><label className="wide">能力清单<textarea required rows={12} value={source} onChange={event => setSource(event.target.value)} maxLength={1048576} spellCheck={false} /></label><div className="lumo-user-form-actions"><Button submit disabled={loading || action.busy}>保存连接器</Button></div></form>{loadedID ? <ConnectorOAuthPanel key={`${loadedID}:${oauthRevision}`} request={request} connectorID={loadedID} configured={managedOAuth} /> : null}</section>
}

interface ConnectorOAuthStatus {
  managed: boolean; available: boolean; enabled: boolean; state: string; provider?: string; version: number
  expiresAt?: string; updatedAt?: string; refreshable: boolean; errorCode?: string; scopes?: string[]
  audit?: { action: string; actorId: string; createdAt: string }[]
}
const oauthStates: Record<string, string> = { disconnected: '未连接', authorizing: '等待授权', exchanging: '正在完成授权', refreshing: '正在续期', connected: '已连接', reauthorization_required: '需要重新授权' }
const oauthEvents: Record<string, string> = { authorization_started: '发起授权', exchanging: '完成授权中', refreshing: '令牌续期', connected: '连接成功', disconnected: '断开连接', authorization_denied: '授权取消', exchange_failed: '授权失败', refresh_failed: '续期失败', vault_write_failed: '凭证存储失败', credentials_unavailable: '客户端凭证不可用', invalid_token: '令牌无效', operation_expired: '操作已过期', configuration_changed: '配置已变更' }

function ConnectorOAuthPanel({ request, connectorID, configured }: { request: Request; connectorID: string; configured: boolean }) {
  const [status, setStatus] = useState<ConnectorOAuthStatus | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [confirmation, setConfirmation] = useState(false)
  const base = `/lumo/api/connectors/${encodeURIComponent(connectorID)}/oauth`
  const active = useRef(true)
  const load = useCallback(async () => {
    if (!configured) return
    setLoading(true)
    try { const result = await request<ConnectorOAuthStatus>(base); if (active.current) { setStatus(result); setError('') } }
    catch (reason) { if (active.current) setError(message(reason)) }
    finally { if (active.current) setLoading(false) }
  }, [request, base, configured])
  useEffect(() => { active.current = true; void load(); return () => { active.current = false } }, [load])
  const action = useAction(load)
  const outcome = new URLSearchParams(window.location.search)
  const callbackFailed = outcome.get('connector') === connectorID && outcome.get('oauth') === 'failed'
  const authorize = () => action.run(async () => {
    const result = await request<{ authorizationUrl: string }>('/auth/connector-oauth/start', { method: 'POST', headers: { 'X-Lumo-Auth-Request': '1' }, body: JSON.stringify({ connectorId: connectorID }) })
    window.location.assign(result.authorizationUrl)
  }, '正在前往授权页面。')
  if (!configured) return <p className="lumo-inline-empty">托管 OAuth 未配置。</p>
  const busy = action.busy || loading
  return <div className="lumo-cluster-panel"><div className="lumo-section-title"><div><b>OAuth 授权</b><span>{status ? oauthStates[status.state] ?? status.state : '正在读取'}</span></div><Button disabled={busy} onClick={() => void load()}>刷新状态</Button></div>
    <Feedback error={error || action.error || (callbackFailed ? '授权未完成，请重新授权。' : '')} notice={action.notice} />
    {status?.managed ? <><div className="lumo-cluster-list"><div><span><b>{status.provider}</b><small>Realm 共享授权 · 配置 v{status.version}</small><small>{status.scopes?.join(' · ')}</small></span><span><b>{status.expiresAt ? new Date(status.expiresAt).toLocaleString('zh-CN') : '未提供到期时间'}</b><small>{status.errorCode ? oauthEvents[status.errorCode] ?? status.errorCode : status.refreshable ? '可自动续期' : '无续期凭证'}</small></span></div></div>
      <div className="lumo-form-actions"><Button disabled={busy || !status.available} onClick={() => void authorize()}>{status.state === 'disconnected' ? '授权连接' : '重新授权'}</Button><Button disabled={busy || !status.available || !status.refreshable || status.state !== 'connected'} onClick={() => void action.run(() => request(`${base}/refresh`, { method: 'POST' }), '令牌已续期。')}>立即续期</Button>{confirmation ? <><Button danger disabled={busy} onClick={() => void action.run(() => request(base, { method: 'DELETE' }), '共享授权已断开。').then(ok => { if (ok) setConfirmation(false) })}>确认断开共享授权</Button><Button disabled={busy} onClick={() => setConfirmation(false)}>取消</Button></> : <Button danger disabled={busy || status.state === 'disconnected'} onClick={() => setConfirmation(true)}>断开</Button>}</div>
    </> : status ? <p className="lumo-inline-empty">该连接器未启用托管 OAuth。</p> : null}
    {status?.audit?.length ? <details><summary>授权记录</summary><div className="lumo-cluster-list">{status.audit.map((event, index) => <div key={`${event.createdAt}:${index}`}><span><b>{oauthEvents[event.action] ?? event.action}</b><small>{event.actorId}</small></span><time>{new Date(event.createdAt).toLocaleString('zh-CN')}</time></div>)}</div></details> : null}
  </div>
}

export interface AgentPreset {
  id: string; project_id?: string; name: string; description?: string; owner_user_id: string; status: 'active' | 'disabled'
  version: string; revision: number; provider: string; model_ref: string; system_prompt_ref?: string; connector_ids: string[]; knowledge_space_ids: string[]
  max_concurrency: number; trust_level?: string; residency?: string; max_budget_cents: number; timeout_seconds: number; max_delegation_depth: number
}

interface ManagedFlow {
  id: string; projectId: string; name: string; status: string; version: number; author: string; updatedAt: string
  visibility: string; reviewComment?: string; audience?: { roles?: string[]; depts?: string[]; users?: string[] }
}
interface FlowManagement {
  flow: ManagedFlow; definition: unknown
  change?: { id: string; revision: number; status: string; baseVersion: number; reviewComment?: string } | null
  capabilities: { edit: boolean; submit: boolean; review: boolean; target: boolean; rollback: boolean; createChange: boolean; discardChange: boolean }
}
const flowStatus: Record<string, string> = { draft: '草稿', submitted: '待审核', published: '已发布', targeted: '已分发', deprecated: '已停用' }

export function FlowManagementPanel({ request, projects, refresh }: { request: Request; projects: { id?: string; name?: string }[]; refresh: () => Promise<void> }) {
  const [projectID, setProjectID] = useState('')
  const [flowID, setFlowID] = useState('')
  const [flows, setFlows] = useState<ManagedFlow[]>([])
  const [changes, setChanges] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const sequence = useRef(0)
  const currentProjectID = useRef(projectID)
  currentProjectID.current = projectID
  useEffect(() => { setProjectID(current => projects.some(project => project.id === current) ? current : projects[0]?.id ?? '') }, [projects])
  const load = useCallback(async () => {
    if (projectID !== currentProjectID.current) return
    const current = ++sequence.current
    if (!projectID) { setFlows([]); setChanges({}); setFlowID(''); setLoading(false); return }
    setLoading(true)
    try {
      const result = await request<{ flows: ManagedFlow[]; changes: Record<string, string> }>(`/lumo/api/projects/${encodeURIComponent(projectID)}/flows/management`)
      if (current !== sequence.current) return
      setFlows(result.flows ?? []); setFlowID(id => result.flows?.some(flow => flow.id === id) ? id : result.flows?.[0]?.id ?? ''); setError('')
      setChanges(result.changes ?? {})
    } catch (reason) { if (current === sequence.current) { setError(message(reason)); setFlows([]); setFlowID('') } }
    finally { if (current === sequence.current) setLoading(false) }
  }, [projectID, request])
  useEffect(() => { void load(); return () => { sequence.current++ } }, [load, projects])
  const reload = useCallback(async () => { await load(); await refresh() }, [load, refresh])
  return <section className="lumo-section lumo-cluster-panel">
    <div className="lumo-section-title"><div><b>流程编辑与审核</b><span>{loading ? '正在同步' : `${flows.length} 条项目流程`}</span></div><Button disabled={loading} onClick={() => void load()}>刷新目录</Button></div>
    <Feedback error={error} />
    <div className="lumo-cluster-toolbar"><label>项目<select value={projectID} onChange={event => { setProjectID(event.target.value); setFlowID(''); setFlows([]) }}><option value="">选择项目</option>{projects.filter(project => project.id).map(project => <option key={project.id} value={project.id}>{project.name ?? project.id}</option>)}</select></label><label>流程<select value={flowID} disabled={loading} onChange={event => setFlowID(event.target.value)}><option value="">选择流程</option>{flows.map(flow => <option key={flow.id} value={flow.id}>{flow.name} · {flowStatus[flow.status] ?? flow.status}{changes[flow.id] ? ` · 修订${flowStatus[changes[flow.id]!] ?? changes[flow.id]}` : ''}</option>)}</select></label></div>
    {flowID ? <FlowManagementEditor key={flowID} request={request} flowID={flowID} refresh={reload} /> : <p className="lumo-inline-empty">{loading ? '正在读取项目流程。' : error ? '流程目录读取失败。' : '暂无可管理的项目流程。'}</p>}
  </section>
}

function FlowManagementEditor({ request, flowID, refresh }: { request: Request; flowID: string; refresh: () => Promise<void> }) {
  const [data, setData] = useState<FlowManagement | null>(null)
  const [name, setName] = useState('')
  const [source, setSource] = useState('')
  const [comment, setComment] = useState('')
  const [visibility, setVisibility] = useState('targeted')
  const [version, setVersion] = useState('1')
  const [snapshot, setSnapshot] = useState<{ version: number; reviewer: string; definition: unknown } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const load = useCallback(async () => {
    setLoading(true)
    try {
      const result = await request<FlowManagement>(`/lumo/api/flows/${encodeURIComponent(flowID)}/management`)
      setData(result); setName(result.flow.name); setSource(JSON.stringify(result.definition, null, 2)); setVisibility(result.flow.visibility === 'global' ? 'global' : 'targeted'); setError('')
    } catch (reason) { setError(message(reason)) }
    finally { setLoading(false) }
  }, [request, flowID])
  useEffect(() => { void load() }, [load])
  const action = useAction(async () => { await load(); await refresh() })
  const mutate = (command: string, body: unknown, notice: string) => action.run(() => request(`/lumo/api/flows/${encodeURIComponent(flowID)}/${command}`, { method: 'POST', body: JSON.stringify(body) }), notice)
  const change = (command: string, notice: string, approve = false) => mutate('management/change', { command, changeId: data?.change?.id, revision: data?.change?.revision, approve, comment: comment.trim() }, notice)
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!data) return
    let definition: unknown
    try { definition = JSON.parse(source) } catch { action.setError('流程定义不是有效的 JSON。'); return }
    await action.run(() => request(`/lumo/api/flows/${encodeURIComponent(flowID)}/management`, { method: 'PATCH', body: JSON.stringify({ name: name.trim(), definition, expectedUpdatedAt: data.flow.updatedAt, changeId: data.change?.id, changeRevision: data.change?.revision }) }), '流程草稿已保存。')
  }
  const target = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); const fields = new FormData(event.currentTarget)
    const list = (key: string) => [...new Set(String(fields.get(key) ?? '').split(',').map(item => item.trim()).filter(Boolean))]
    const audience = { roles: list('roles'), depts: list('depts'), users: list('users') }
    if (visibility === 'targeted' && !Object.values(audience).some(items => items.length)) { action.setError('至少选择一类分发对象。'); return }
    await mutate('target', { visibility, audience: visibility === 'global' ? null : audience }, '流程分发范围已更新。')
  }
  const readVersion = async () => {
    if (!/^[1-9]\d*$/u.test(version)) return
    setLoading(true); action.setError(''); setSnapshot(null)
    try { setSnapshot(await request(`/lumo/api/flows/${encodeURIComponent(flowID)}/versions/${version}`)) }
    catch (reason) { action.setError(message(reason)) }
    finally { setLoading(false) }
  }
  const dirty = data !== null && (name !== data.flow.name || source !== JSON.stringify(data.definition, null, 2))
  const baseChanged = Boolean(data?.change && data.change.baseVersion !== data.flow.version)
  return <div>
    <Feedback error={error || action.error} notice={action.notice} />
    {data ? <>
      <div className="lumo-section-title"><div><b>{data.flow.name}</b><span>{flowStatus[data.flow.status] ?? data.flow.status} · v{data.flow.version} · {data.flow.author}{data.change ? ` · 修订${flowStatus[data.change.status] ?? data.change.status} (${data.change.revision})` : ''}</span></div><div className="lumo-form-actions"><Button disabled={loading || action.busy} onClick={() => void load()}>重新读取</Button>{data.capabilities.createChange ? <Button disabled={loading || action.busy} onClick={() => void change('create', '修订草稿已创建，当前发布版本继续生效。')}>创建修订</Button> : null}{data.capabilities.discardChange ? <Button danger disabled={loading || action.busy} onClick={() => void change('discard', '修订草稿已撤回。')}>撤回修订</Button> : null}</div></div>
      {(data.change?.reviewComment || data.flow.reviewComment) ? <div className="lumo-cluster-feedback error">审核意见：{data.change?.reviewComment || data.flow.reviewComment}</div> : null}
      {baseChanged ? <div className="lumo-cluster-feedback error" role="alert">发布版本已变更，此修订基于 v{data.change?.baseVersion}，当前为 v{data.flow.version}。需撤回后基于当前版本重新修订。</div> : null}
      <form className="lumo-governance-form lumo-cluster-form" onSubmit={save}>
        <label className="wide">流程名称<input required maxLength={160} value={name} disabled={loading || action.busy} readOnly={!data.capabilities.edit || Boolean(data.change)} onChange={event => setName(event.target.value)} /></label>
        <label className="wide">流程定义<textarea required rows={12} maxLength={900000} spellCheck={false} value={source} disabled={loading || action.busy} readOnly={!data.capabilities.edit} onChange={event => setSource(event.target.value)} /></label>
        <div className="lumo-user-form-actions">{data.capabilities.edit ? <Button submit disabled={loading || action.busy || !dirty}>保存草稿</Button> : null}{data.capabilities.submit ? <Button disabled={loading || action.busy || dirty || baseChanged} onClick={() => void (data.change ? change('submit', '修订已提交审核。') : mutate('submit', {}, '流程已提交审核。'))}>提交审核</Button> : null}</div>
      </form>
      {data.capabilities.review ? <div className="lumo-governance-form lumo-cluster-form"><label className="wide">审核意见<textarea value={comment} maxLength={1000} rows={3} onChange={event => setComment(event.target.value)} /></label><div className="lumo-user-form-actions"><Button disabled={loading || action.busy || baseChanged} onClick={() => void (data.change ? change('review', '修订已审核发布。', true) : mutate('review', { approve: true, comment: comment.trim() }, '流程已审核发布。'))}>审核通过</Button><Button danger disabled={loading || action.busy || !comment.trim()} onClick={() => void (data.change ? change('review', '修订已退回修改。') : mutate('review', { approve: false, comment: comment.trim() }, '流程已退回草稿。'))}>退回修改</Button></div></div> : null}
      {data.capabilities.target ? <form key={data.flow.updatedAt} className="lumo-governance-form lumo-cluster-form" onSubmit={target}><label>分发范围<select value={visibility} onChange={event => setVisibility(event.target.value)}><option value="targeted">指定对象</option><option value="global">整个 Realm</option></select></label>{visibility === 'targeted' ? <><label>角色 ID<input name="roles" maxLength={5000} defaultValue={data.flow.audience?.roles?.join(', ') ?? ''} /></label><label>部门 ID<input name="depts" maxLength={5000} defaultValue={data.flow.audience?.depts?.join(', ') ?? ''} /></label><label>用户 ID<input name="users" maxLength={5000} defaultValue={data.flow.audience?.users?.join(', ') ?? ''} /></label></> : null}<div className="lumo-user-form-actions"><Button submit disabled={loading || action.busy}>保存分发范围</Button></div></form> : null}
      {data.flow.version > 0 ? <><div className="lumo-cluster-toolbar"><label>历史版本<input type="number" min={1} step={1} value={version} onChange={event => { setVersion(event.target.value); setSnapshot(null) }} /></label><Button disabled={loading || action.busy || !/^[1-9]\d*$/u.test(version)} onClick={() => void readVersion()}>读取版本</Button>{snapshot && data.capabilities.rollback && snapshot.version !== data.flow.version ? <Button danger disabled={loading || action.busy} onClick={() => void mutate('rollback', { version: snapshot.version }, `流程已切换到 v${snapshot.version}。`)}>回滚到 v{snapshot.version}</Button> : null}</div>{snapshot ? <div className="lumo-governance-form lumo-cluster-form"><label className="wide">v{snapshot.version} · 审核人 {snapshot.reviewer}<textarea readOnly rows={10} value={JSON.stringify(snapshot.definition, null, 2)} spellCheck={false} /></label></div> : null}</> : null}
    </> : <p className="lumo-inline-empty">{loading ? '正在读取流程。' : '流程详情读取失败。'}</p>}
  </div>
}

export function AgentPresetEditor({ request, presets, refresh }: { request: Request; presets: AgentPreset[]; refresh: () => Promise<void> }) {
  const capability = useClusterCapabilities(request)
  const [editing, setEditing] = useState<AgentPreset | null>(null)
  const [loading, setLoading] = useState(false)
  const action = useAction(refresh)
  const latest = presets.find(preset => preset.id === editing?.id)
  const reload = async () => {
    if (!editing) return
    setLoading(true); action.setError('')
    try { setEditing(await request<AgentPreset>(`/lumo/api/agent-presets/${encodeURIComponent(editing.id)}`)) }
    catch (reason) { action.setError(message(reason)) }
    finally { setLoading(false) }
  }
  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!editing) return
    const fields = new FormData(event.currentTarget)
    const value = (key: string) => String(fields.get(key) ?? '').trim()
    const references = (key: string) => [...new Set(value(key).split(',').map(item => item.trim()).filter(Boolean))]
    const body = {
      revision: editing.revision, name: value('name'), description: value('description'), status: value('status'), version: value('version'),
      provider: value('provider'), model_ref: value('model_ref'), system_prompt_ref: value('system_prompt_ref'),
      connector_ids: references('connector_ids'), knowledge_space_ids: references('knowledge_space_ids'),
      max_concurrency: Number(fields.get('max_concurrency')), max_budget_cents: Number(fields.get('max_budget_cents')),
      timeout_seconds: Number(fields.get('timeout_seconds')), max_delegation_depth: Number(fields.get('max_delegation_depth')),
      trust_level: value('trust_level'), residency: value('residency'),
      ...(capability?.organization ? { owner_user_id: value('owner_user_id'), project_id: value('project_id') } : {}),
    }
    await action.run(async () => {
      const updated = await request<AgentPreset>(`/lumo/api/agent-presets/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body: JSON.stringify(body) })
      setEditing(updated)
    }, 'Agent 配置已保存。')
  }
  return <section className="lumo-section lumo-cluster-panel">
    <div className="lumo-section-title"><div><b>Agent 配置</b><span>{editing ? `${editing.name} · 修订 ${editing.revision}` : `${presets.length} 个可管理资产`}</span></div>{editing ? <Button disabled={loading || action.busy} onClick={() => void reload()}>重新读取</Button> : null}</div>
    <Feedback error={action.error} notice={action.notice} />
    <div className="lumo-cluster-toolbar"><label>Agent<select value={editing?.id ?? ''} disabled={loading || action.busy} onChange={event => { setEditing(presets.find(preset => preset.id === event.target.value) ?? null); action.setError('') }}><option value="">选择 Agent</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label></div>
    {editing ? <>
      {latest && latest.revision !== editing.revision ? <div className="lumo-cluster-feedback error" role="alert">此配置已有更新，当前编辑基于修订 {editing.revision}。重新读取后可编辑最新配置。</div> : null}
      <form key={`${editing.id}:${editing.revision}`} className="lumo-governance-form lumo-cluster-form" onSubmit={save}>
        <label>名称<input name="name" required maxLength={160} defaultValue={editing.name} /></label>
        <label>版本<input name="version" required maxLength={64} defaultValue={editing.version} /></label>
        <label>状态<select name="status" defaultValue={editing.status}><option value="active">启用</option><option value="disabled">停用</option></select></label>
        <label>Provider<input name="provider" required maxLength={128} defaultValue={editing.provider} /></label>
        <label>模型引用<input name="model_ref" required maxLength={256} defaultValue={editing.model_ref} /></label>
        <label>所有者 ID<input name="owner_user_id" required readOnly={!capability?.organization} maxLength={128} defaultValue={editing.owner_user_id} /></label>
        <label>项目范围<input name="project_id" readOnly={!capability?.organization} maxLength={128} defaultValue={editing.project_id ?? ''} /></label>
        <label>最大并发<input name="max_concurrency" type="number" required min={1} step={1} defaultValue={editing.max_concurrency} /></label>
        <label>预算上限（分）<input name="max_budget_cents" type="number" required min={0} max={Number.MAX_SAFE_INTEGER} step={1} defaultValue={editing.max_budget_cents} /></label>
        <label>超时（秒）<input name="timeout_seconds" type="number" required min={1} max={86400} step={1} defaultValue={editing.timeout_seconds} /></label>
        <label>最大下授深度<input name="max_delegation_depth" type="number" required min={0} max={16} step={1} defaultValue={editing.max_delegation_depth} /></label>
        <label>信任等级<input name="trust_level" maxLength={128} defaultValue={editing.trust_level ?? ''} /></label>
        <label>数据驻留<input name="residency" maxLength={128} defaultValue={editing.residency ?? ''} /></label>
        <label className="wide">说明<textarea name="description" rows={2} maxLength={500} defaultValue={editing.description ?? ''} /></label>
        <label className="wide">系统提示引用<input name="system_prompt_ref" maxLength={256} defaultValue={editing.system_prompt_ref ?? ''} /></label>
        <label className="wide">连接器范围<input name="connector_ids" maxLength={52000} defaultValue={editing.connector_ids.join(', ')} /></label>
        <label className="wide">知识空间范围<input name="knowledge_space_ids" maxLength={52000} defaultValue={editing.knowledge_space_ids.join(', ')} /></label>
        <div className="lumo-user-form-actions"><Button submit disabled={loading || action.busy || Boolean(latest && latest.revision !== editing.revision)}>保存配置</Button><Button disabled={loading || action.busy} onClick={() => setEditing(null)}>取消</Button></div>
      </form>
    </> : <p className="lumo-inline-empty">{presets.length ? '尚未选择 Agent。' : '暂无可管理的 Agent。'}</p>}
  </section>
}

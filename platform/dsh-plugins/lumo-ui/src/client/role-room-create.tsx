import { AgentProjectPicker } from './agent-project-picker.tsx'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import type { EngineProbeView } from './acp-session-panel.tsx'
import type { AgentProfile } from '../../../acp-engines/src/agent-directory.ts'
import type { RoomRole } from '../../../acp-engines/src/role-room-model.ts'
import type { RoomConfig } from '../../../acp-engines/src/role-room-model.ts'
import { RoomAppearanceFields, DEFAULT_APPEARANCE } from './room-appearance.tsx'
import { EngineLogo } from './engine-logo.tsx'
import { ChatButton } from './chat-button.tsx'
import { RefreshIcon } from './chat-icons.tsx'
import { ProjectCapabilities } from './project-workflow-panel.tsx'
import type { ProjectCapability } from '../../../acp-engines/src/project-workflow-model.ts'

const seeds: Array<{ id: string; name: string; instruction: string; capabilities: ProjectCapability[] }> = [
  { id: 'assistant', name: '个人助理', instruction: '澄清目标，整理各角色的结果与分歧，给出有证据的结论和下一步。', capabilities: ['planning', 'documentation'] },
  { id: 'engineer', name: '开发工程师', instruction: '检查工作区，落实实现与验证，报告改动、测试结果和产物路径。', capabilities: ['general', 'testing'] },
  { id: 'reviewer', name: '评审专家', instruction: '独立检查方案或实现的正确性、遗漏和风险，提出有依据的修改建议。', capabilities: ['review', 'testing'] },
]
export const RoleRoomCreate = ({ engines, busy, create, initialAgents, recentProjects = [], refreshEngines, manageTools }: { recentProjects?: string[]; engines: EngineProbeView[]; initialAgents?: AgentProfile[] | undefined; busy: boolean; create(config: RoomConfig): Promise<boolean>; refreshEngines?(): void; manageTools?(): void }) => {
  const available = engines.filter(engine => engine.available)
  const [name, setName] = useState('我的协作团队'), [cwd, setCwd] = useState(''), [roles, setRoles] = useState<RoomRole[]>(() => initialAgents?.length ? initialAgents.map(a => ({ id: a.id, agentId: a.id, name: a.name, engineId: a.engineId, instruction: a.instruction, ...(a.modelId ? { modelId: a.modelId } : {}), ...(a.capabilities ? { capabilities: [...a.capabilities] } : {}) })) : seeds.map((role, index) => ({ ...role, engineId: available[index % available.length]?.id ?? '' }))), [coordinatorId, setCoordinator] = useState(initialAgents?.[0]?.id ?? 'assistant')
  // Detection may arrive after the form mounts. Fill only unselected roles;
  // a refresh must never replace a user's chosen engine or a saved Agent.
  useEffect(() => {
    if (available.length) setRoles(rows => rows.map((role, index) => role.engineId ? role : { ...role, engineId: available[index % available.length]!.id }))
  }, [engines])
  const [appearance, setAppearance] = useState(DEFAULT_APPEARANCE)
  const [error, setError] = useState('')
  const request = useRef<{ signature: string; id: string }>()
  const update = (id: string, key: 'name' | 'engineId' | 'instruction', value: string) => setRoles(rows => rows.map(r => {
    if (r.id !== id) return r
    const next = { ...r, [key]: value }
    if (key === 'engineId') delete next.modelId
    return next
  }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const signature = JSON.stringify({ name, cwd, coordinatorId, roles, appearance })
    if (new Set(roles.map(r => r.name.trim())).size !== roles.length) { setError('请为每个角色设置不同的名称。'); return }
    if (roles.some(r => !engines.some(e => e.id === r.engineId && e.available))) { setError('请为每个角色选择已检测到入口的引擎。'); return }
    if (request.current?.signature !== signature) request.current = { signature, id: crypto.randomUUID() }
    setError(''); await create({ id: request.current.id, name, cwd, coordinatorId, roles, appearance })
  }
  return <form className="lumo-role-create" onSubmit={event => void submit(event)}>
    <h2>新建协作群组</h2>
    <RoomAppearanceFields value={appearance} onChange={setAppearance} engines={roles.map(r => r.engineId)} disabled={busy} />
    <div className="lumo-role-fields"><label>团队名称<input aria-label="团队名称" value={name} required maxLength={80} onChange={e => setName(e.target.value)} /></label>
      <AgentProjectPicker value={cwd} onChange={setCwd} recent={recentProjects} label="协作工作区目录" disabled={busy} /></div>
    <div className="lumo-role-toolbar"><small role="status">{engines.length ? `${available.length} / ${engines.length} 个工具已检测到启动入口` : '正在读取开发工具…'}</small>
      {refreshEngines ? <ChatButton type="button" variant="ghost" disabled={busy} aria-label="重新检测群组工具" title="重新检测工具" onClick={refreshEngines}><RefreshIcon size={15} /></ChatButton> : null}
      {manageTools ? <ChatButton type="button" variant="ghost" onClick={manageTools}>工具与模型</ChatButton> : null}</div>
    <div className="lumo-role-cards">{roles.map((role, index) => <fieldset key={role.id} disabled={busy}>
      <legend><span className="lumo-engine-heading"><EngineLogo engineId={role.engineId} small /><span>角色 {index + 1}</span></span></legend>
      <label>名称<input aria-label={`角色 ${index + 1} 名称`} value={role.name} required maxLength={60} onChange={e => update(role.id, 'name', e.target.value)} /></label>
      <label>执行引擎<select aria-label={`角色 ${index + 1} 引擎`} value={role.engineId} onChange={e => update(role.id, 'engineId', e.target.value)}>
        {!engines.some(e => e.id === role.engineId) ? <option value={role.engineId}>{role.engineId ? `${role.engineId}（未检测到）` : '请选择已就绪的工具'}</option> : null}
        <optgroup label="已检测到入口">{available.map(engine => <option key={engine.id} value={engine.id}>{engine.label}{engine.launchKind === 'on-demand' ? '（按需启动）' : ''}</option>)}</optgroup>
        {engines.some(e => !e.available) ? <optgroup label="未就绪">{engines.filter(e => !e.available).map(engine => <option key={engine.id} value={engine.id} disabled title={engine.reason}>{engine.label} · {engine.reason || '未检测到启动入口'}</option>)}</optgroup> : null}
      </select></label>
      {role.engineId && !available.some(e => e.id === role.engineId) ? <small role="status">{engines.find(e => e.id === role.engineId)?.reason ?? '所选工具未就绪，请在工具与模型中检查。'}</small> : null}
      <small>模型：{role.modelId ?? '工具默认模型'} · 可在连接后调整</small>
      <label>角色职责<textarea aria-label={`角色 ${index + 1} 职责`} rows={3} value={role.instruction} required maxLength={2000} onChange={e => update(role.id, 'instruction', e.target.value)} /></label>
      <ProjectCapabilities label={`角色 ${index + 1} 能力`} value={role.capabilities} disabled={busy} onChange={capabilities => setRoles(rows => rows.map(row => row.id === role.id ? { ...row, capabilities } : row))} />
      <ChatButton type="button" variant="ghost" disabled={roles.length <= 2} onClick={() => { const rest = roles.filter(r => r.id !== role.id); setRoles(rest); if (coordinatorId === role.id) setCoordinator(rest[0]!.id) }}>移除角色 {index + 1}</ChatButton>
    </fieldset>)}</div>
    <div className="lumo-role-toolbar"><ChatButton type="button" disabled={busy || roles.length >= 6} onClick={() => setRoles([...roles, { id: crypto.randomUUID(), name: '', instruction: '', engineId: available[roles.length % available.length]?.id ?? '' }])}>添加角色</ChatButton>
      <label>协调助理<select aria-label="协调助理" value={coordinatorId} onChange={e => setCoordinator(e.target.value)}>{roles.map(r => <option key={r.id} value={r.id}>{r.name || '未命名角色'}</option>)}</select></label>
      <ChatButton type="submit" variant="primary" disabled={busy || !cwd.trim() || roles.some(role => !available.some(e => e.id === role.engineId))}>创建协作房间</ChatButton></div>
    <p className="lumo-muted">创建时保存角色配置。发送消息后启动对应引擎，使用各引擎现有登录与权限确认。可让多个角色使用同一引擎。</p>
    {error ? <p role="alert">{error}</p> : null}
  </form>
}

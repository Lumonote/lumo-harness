import { useEffect, useRef, useState } from 'react'
import type { AgentProfile } from '../../../acp-engines/src/agent-directory.ts'
import type { EngineProbeView } from './acp-session-panel.tsx'
import type { AgentSeed } from './development-tools.tsx'
import { acpCall, scopeKey, type SessionIdentity } from './acp-session-state.ts'
import { EngineModelPicker } from './engine-model-picker.tsx'
import { EngineLogo } from './engine-logo.tsx'
import { ProjectCapabilities, capabilityLabels } from './project-workflow-panel.tsx'

type Draft = Pick<AgentProfile, 'id' | 'name' | 'engineId' | 'instruction' | 'modelId' | 'capabilities'>
export const AgentDirectory = ({ identity, engines, seed, group, tools }: {
  identity: string; engines: EngineProbeView[]; seed?: AgentSeed | undefined; group(agents: AgentProfile[]): void; tools(): void
}) => {
  const [agents, setAgents] = useState<AgentProfile[]>([]), [selected, setSelected] = useState<string[]>([])
  const [draft, setDraft] = useState<Draft | undefined>(() => seed ? { id: crypto.randomUUID(), name: '', instruction: '', ...seed } : undefined)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [loaded, setLoaded] = useState(false), [deleting, setDeleting] = useState('')
  const [modelCwd, setModelCwd] = useState('')
  const [revision, setRevision] = useState(0)
  const alive = useRef(false), writing = useRef(false)
  useEffect(() => {
    alive.current = true; const controller = new AbortController()
    void acpCall<{ agents: AgentProfile[]; identity: SessionIdentity }>('/lumo/api/acp/agents', { signal: controller.signal }).then(r => {
      if (!alive.current || controller.signal.aborted) return
      if (scopeKey(r.identity) !== identity || !Array.isArray(r.agents)) throw new Error('Agent 通讯录身份已变化，请刷新工作台')
      setAgents(r.agents); setLoaded(true)
    }).catch(e => { if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e)) })
    return () => { alive.current = false; controller.abort() }
  }, [identity, revision])
  const save = async (remove?: string) => {
    if (writing.current || !loaded) return
    writing.current = true; setBusy(true); setError('')
    try {
      const result = await acpCall<{ agent?: AgentProfile; identity: SessionIdentity }>(remove ? `/lumo/api/acp/agents/${remove}/delete` : '/lumo/api/acp/agents', { method: 'POST', body: JSON.stringify(remove ? {} : draft) })
      if (!alive.current) return
      if (scopeKey(result.identity) !== identity) { setAgents([]); setSelected([]); setDraft(undefined); setLoaded(false); throw new Error('身份已变化，请刷新工作台') }
      if (remove) { setAgents(list => list.filter(a => a.id !== remove)); setSelected(ids => ids.filter(id => id !== remove)); setDeleting('') }
      else if (result.agent) { const agent = result.agent; setAgents(list => [...list.filter(a => a.id !== agent.id), agent]); setDraft(undefined) }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)) }
    finally { writing.current = false; if (alive.current) setBusy(false) }
  }
  return <section aria-label="Agent 通讯录"><header><h2>Agent 通讯录</h2><p className="lumo-muted">保存角色、开发工具与模型，按任务选择成员组建群组。群组保存创建时的成员配置。</p></header>
    <div className="lumo-role-toolbar"><button type="button" disabled={busy || !loaded} onClick={() => setDraft({ id: crypto.randomUUID(), name: '', engineId: engines.find(e => e.available)?.id ?? 'codex', instruction: '' })}>创建 Agent</button>
      <button type="button" disabled={busy || selected.length < 2 || selected.length > 6} onClick={() => group(selected.flatMap(id => agents.find(a => a.id === id) ?? []))}>组建群组（{selected.length}/6）</button><button type="button" onClick={tools}>管理开发工具与模型</button><button type="button" disabled={busy} onClick={() => { setError(''); setRevision(value => value + 1) }}>刷新通讯录</button></div>
    {error ? <p role="alert">{error}</p> : null}
    {draft ? <form className="lumo-agent-editor" onSubmit={e => { e.preventDefault(); void save() }}><fieldset disabled={busy}><legend><span className="lumo-engine-heading"><EngineLogo engineId={draft.engineId} small /><span>{agents.some(a => a.id === draft.id) ? '编辑 Agent' : '创建 Agent'}</span></span></legend>
      <label>Agent 名称<input aria-label="Agent 名称" required maxLength={60} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} /></label>
      <label>开发工具<select aria-label="Agent 开发工具" value={draft.engineId} onChange={e => { const { modelId: _, ...next } = draft; setDraft({ ...next, engineId: e.target.value }) }}>{!engines.some(e => e.id === draft.engineId) ? <option>{draft.engineId}</option> : null}{engines.map(e => <option key={e.id} value={e.id}>{e.label}{e.available ? '' : '（未就绪）'}</option>)}</select></label>
      <EngineModelPicker key={`${draft.id}:${draft.engineId}`} engineId={draft.engineId} identity={identity} available={engines.some(e => e.id === draft.engineId && e.available)} cwd={modelCwd} setCwd={setModelCwd} modelId={draft.modelId} disabled={busy} setModelId={id => { const next = { ...draft }; if (id) next.modelId = id; else delete next.modelId; setDraft(next) }} />
      <label>职责<textarea aria-label="Agent 职责" required maxLength={2000} rows={4} value={draft.instruction} onChange={e => setDraft({ ...draft, instruction: e.target.value })} /></label>
      <ProjectCapabilities label="Agent 能力" value={draft.capabilities} disabled={busy} onChange={capabilities => setDraft({ ...draft, capabilities })} />
      <div className="lumo-role-toolbar"><button type="submit" disabled={!loaded}>保存 Agent</button><button type="button" onClick={() => setDraft(undefined)}>取消编辑</button></div>
    </fieldset></form> : null}
    <div className="lumo-role-roster">{agents.map(agent => <article key={agent.id}><label className="lumo-agent-check"><input type="checkbox" checked={selected.includes(agent.id)} disabled={!selected.includes(agent.id) && selected.length >= 6} onChange={e => setSelected(ids => e.target.checked ? [...ids, agent.id] : ids.filter(id => id !== agent.id))} /><EngineLogo engineId={agent.engineId} small />{agent.name}</label>
      <span>{engines.find(e => e.id === agent.engineId)?.label ?? agent.engineId} · {agent.modelId ?? '工具默认模型'}</span><small>{agent.instruction}</small>
      {agent.capabilities?.length ? <small>{agent.capabilities.map(value => capabilityLabels[value]).join(' · ')}</small> : null}
      <div className="lumo-role-toolbar"><button type="button" disabled={busy} onClick={() => setDraft(agent)}>编辑</button><button type="button" disabled={busy} onClick={() => setDeleting(agent.id)}>移除</button>
        {deleting === agent.id ? <button type="button" disabled={busy} onClick={() => void save(agent.id)}>确认移出通讯录</button> : null}</div>
    </article>)}</div>{loaded && !agents.length ? <p className="lumo-muted">创建第一个 Agent，再选择两位或更多成员建立协作群组。</p> : null}
  </section>
}

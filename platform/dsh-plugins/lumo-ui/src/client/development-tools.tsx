import { useEffect, useState } from 'react'
import type { EngineProbeView } from './acp-session-panel.tsx'
import { EngineModelPicker } from './engine-model-picker.tsx'
import { EngineLogo } from './engine-logo.tsx'

export type AgentSeed = { engineId: string; modelId?: string }
export const DevelopmentTools = ({ engines, identity, refresh, createAgent, openSession }: {
  engines: EngineProbeView[]; identity: string; refresh(): void; createAgent(seed: AgentSeed): void; openSession(engineId: string, cwd: string, modelId?: string): void
}) => {
  const [query, setQuery] = useState(''), [selected, setSelected] = useState(engines[0]?.id ?? '')
  const [cwd, setCwd] = useState(''), [modelId, setModelId] = useState('')
  const choose = (id: string) => { setSelected(id); setModelId('') }
  useEffect(() => { if (!engines.some(e => e.id === selected)) choose(engines.find(e => e.available)?.id ?? engines[0]?.id ?? '') }, [engines, selected])
  const current = engines.find(e => e.id === selected)
  const shown = engines.filter(e => `${e.label} ${e.id}`.toLowerCase().includes(query.trim().toLowerCase()))
  return <section className="lumo-dev-tools" aria-label="开发工具与模型">
    <header><h2>开发工具与模型</h2><p className="lumo-muted">使用工具已有的登录和订阅。先检查入口，再连接读取它实际支持的模型。</p></header>
    <div className="lumo-role-toolbar"><input aria-label="搜索开发工具" placeholder="搜索 Claude Code、Codex、Gemini…" value={query} onChange={e => setQuery(e.target.value)} /><button type="button" onClick={refresh}>重新检测工具</button></div>
    <div className="lumo-dev-layout"><div className="lumo-dev-catalog" aria-label="开发工具目录">{shown.map(engine => <button type="button" key={engine.id} aria-pressed={engine.id === selected} onClick={() => choose(engine.id)}>
      <span className="lumo-engine-heading"><EngineLogo engineId={engine.id} /><b>{engine.label}</b></span><span>{engine.available ? engine.launchKind === 'on-demand' ? '适配器按需启动' : '已检测到入口' : '未就绪'}</span><small>{engine.available ? '登录与模型需连接确认' : engine.reason}</small>
    </button>)}{!shown.length ? <p>没有匹配的开发工具。</p> : null}</div>
    {current ? <section className="lumo-dev-detail" aria-label={`${current.label} 配置`}><h3 className="lumo-engine-heading"><EngineLogo engineId={current.id} /><span>{current.label}</span></h3>
      <p>{current.authHint || '沿用此工具的本机登录与配置。请先在终端完成该工具的首次登录。'}</p>
      {!current.available ? <p role="status">{current.reason}</p> : null}
      <EngineModelPicker key={current.id} engineId={current.id} identity={identity} available={current.available} cwd={cwd} setCwd={value => { setCwd(value); setModelId('') }} modelId={modelId} setModelId={setModelId} />
      <div className="lumo-role-toolbar"><button type="button" disabled={!current.available} onClick={() => createAgent({ engineId: current.id, ...(modelId ? { modelId } : {}) })}>用此工具创建 Agent</button>
        <button type="button" disabled={!current.available || !cwd.trim()} onClick={() => openSession(current.id, cwd.trim(), modelId || undefined)}>打开独立会话</button></div>
    </section> : <p>正在读取开发工具目录…</p>}</div>
  </section>
}

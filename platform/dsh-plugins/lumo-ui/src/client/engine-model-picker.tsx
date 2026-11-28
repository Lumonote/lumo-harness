import { useEffect, useRef, useState } from 'react'
import type { SessionModels } from '../../../acp-engines/src/session-models.ts'
import { acpCall, scopeKey, type SessionIdentity } from './acp-session-state.ts'
import { AgentModelSelect } from './agent-model-select.tsx'

/** Model catalogs belong to a tool, workspace and trusted identity; they are never global presets. */
export const EngineModelPicker = ({ engineId, identity, available, cwd, setCwd, modelId, setModelId, disabled = false }: {
  engineId: string; identity: string; available: boolean; cwd: string; setCwd(value: string): void
  modelId?: string | undefined; setModelId(value: string): void; disabled?: boolean
}) => {
  const [models, setModels] = useState<SessionModels | null>(), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const request = useRef<AbortController>()
  const reset = () => { request.current?.abort(); request.current = undefined; setModels(undefined); setBusy(false); setError('') }
  useEffect(() => { reset(); return () => { request.current?.abort(); request.current = undefined } }, [engineId, identity, cwd])
  const inspect = async () => {
    if (request.current || !available || !cwd.trim()) return
    const controller = new AbortController(); request.current = controller; setBusy(true); setError('')
    try {
      const result = await acpCall<{ models: SessionModels | null; identity: SessionIdentity }>(`/lumo/api/acp/engines/${encodeURIComponent(engineId)}/models`, {
        method: 'POST', body: JSON.stringify({ cwd: cwd.trim() }), signal: controller.signal,
      })
      if (controller.signal.aborted || request.current !== controller) return
      if (!result.identity || scopeKey(result.identity) !== identity) throw new Error('身份已变化，请刷新 Agent 工作台后重新连接')
      setModels(result.models)
    } catch (e) { if (!controller.signal.aborted && request.current === controller) { setModels(undefined); setError(e instanceof Error ? e.message : String(e)) } }
    finally { if (request.current === controller) { request.current = undefined; setBusy(false) } }
  }
  return <div className="lumo-engine-model-picker">
    <label>工作区目录<input aria-label="工具工作区目录" value={cwd} disabled={disabled} placeholder="本机已有目录的绝对路径" onChange={e => { reset(); setCwd(e.target.value) }} /></label>
    <button type="button" disabled={disabled || busy || !available || !cwd.trim()} onClick={() => void inspect()}>{busy ? '正在连接…' : '连接并读取模型'}</button>
    <small className="lumo-muted">连接临时会话读取模型后关闭，不发送任务。按需启动的适配器首次可能下载。模型目录由工具提供，实际访问权限在执行时确认。</small>
    {models !== undefined ? <p role="status">{models?.availableModels.length ? `连接成功 · ${models.availableModels.length} 个可选模型` : '连接成功；此工具未提供模型列表，请使用工具自身配置。'}</p> : null}
    {error ? <p role="alert">{error}</p> : null}
    <AgentModelSelect models={models} value={modelId ?? ''} disabled={disabled || busy} allowDefault onChange={setModelId} />
    {modelId && models !== undefined && !models?.availableModels.some(m => m.id === modelId) ? <p role="status">已保存的模型未出现在当前列表中，请重新选择或使用默认模型。</p> : null}
  </div>
}

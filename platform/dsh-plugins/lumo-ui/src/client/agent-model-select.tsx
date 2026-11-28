import type { SessionModels } from '../../../acp-engines/src/session-models.ts'

export const AgentModelSelect = ({ models, value, disabled, allowDefault = false, label = '模型', onChange }: {
  models?: SessionModels | null | undefined; value?: string | undefined; disabled?: boolean | undefined; allowDefault?: boolean; label?: string; onChange(id: string): void
}) => {
  const selected = value ?? models?.currentModelId ?? ''
  return <label className="lumo-agent-model"><span>{label}</span>
    <select aria-label={label} value={selected} disabled={disabled || (!models?.availableModels.length && !(allowDefault && selected))} onChange={e => onChange(e.target.value)}>
      {allowDefault || !selected ? <option value="">使用工具默认模型</option> : null}
      {selected && !models?.availableModels.some(m => m.id === selected) ? <option value={selected}>{selected}（当前配置）</option> : null}
      {models?.availableModels.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
    </select>
    {!models?.availableModels.length ? <small>连接后读取工具支持的模型；未提供列表时使用工具自身配置。</small> : null}
  </label>
}

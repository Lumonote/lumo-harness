import type { JsonRpcConnection } from './jsonrpc.ts'

export interface SessionModel { id: string; name: string; description?: string }
export interface SessionModels { currentModelId?: string; availableModels: SessionModel[]; source: 'config' | 'legacy'; configId?: string }
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
export const validModelId = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= 256 && !/[\x00-\x1f]/u.test(v)
const options = (raw: unknown): SessionModel[] => {
  if (!Array.isArray(raw)) return []
  const rows = raw.slice(0, 256).flatMap(item => {
    const r = object(item)
    return Array.isArray(r.options) ? r.options.slice(0, 256) : [r]
  }).slice(0, 256).map(object)
  const unique = new Map<string, SessionModel>()
  for (const r of rows) {
    const id = r.value ?? r.modelId
    if (!validModelId(id)) continue
    unique.set(id, { id, name: typeof r.name === 'string' ? r.name.slice(0, 200) : id,
      ...(typeof r.description === 'string' ? { description: r.description.slice(0, 1000) } : {}) })
  }
  return [...unique.values()]
}
/** ACP configOptions take precedence; legacy models remain supported by older adapters. */
export const readSessionModels = (response: unknown): SessionModels | undefined => {
  const r = object(response)
  if (Array.isArray(r.configOptions)) {
    const config = r.configOptions.map(object).find(o => o.type === 'select' && o.category === 'model')
    if (config && validModelId(config.id)) return { source: 'config', configId: config.id,
      ...(validModelId(config.currentValue) ? { currentModelId: config.currentValue } : {}), availableModels: options(config.options) }
  }
  const models = object(r.models)
  if (!Array.isArray(models.availableModels)) return undefined
  return { source: 'legacy', ...(validModelId(models.currentModelId) ? { currentModelId: models.currentModelId } : {}), availableModels: options(models.availableModels) }
}
export const changeSessionModel = async (rpc: JsonRpcConnection, sessionId: string, models: SessionModels | undefined, modelId: string): Promise<SessionModels> => {
  if (!validModelId(modelId) || !models?.availableModels.some(m => m.id === modelId)) throw new Error('此模型不在当前引擎返回的可用列表中')
  if (models.currentModelId === modelId) return models
  if (models.source === 'config') {
    const response = await rpc.request('session/set_config_option', { sessionId, configId: models.configId, value: modelId })
    const updated = readSessionModels(response)
    if (!updated || updated.currentModelId !== modelId) throw new Error('引擎未确认所选模型，请重新读取会话状态')
    return updated
  }
  await rpc.request('session/set_model', { sessionId, modelId })
  return { ...models, currentModelId: modelId }
}

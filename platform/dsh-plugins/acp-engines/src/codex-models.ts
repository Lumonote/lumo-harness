import { JsonRpcConnection, RpcRemoteError } from './jsonrpc.ts'
import { validModelId } from './session-models.ts'

/** No catalog is hardcoded: models belong to the authenticated app-server instance. */
export class CodexModels {
  private choices: Array<{ modelId: string; name: string; description?: string }> = []
  private selected = new Map<string, string>()
  constructor(private readonly rpc: JsonRpcConnection) {}
  async load(sessionId: string, current?: unknown): Promise<Record<string, unknown>> {
    this.choices = []
    const seen = new Set<string>()
    let cursor: string | undefined
    try {
      do {
        const result = await this.rpc.request<{ data?: Array<{ model?: string; displayName?: string; description?: string }>; nextCursor?: string }>('model/list', { ...(cursor ? { cursor } : {}), limit: 100 }, 15_000)
        for (const row of result?.data ?? []) if (validModelId(row.model) && this.choices.length < 256 && !this.choices.some(m => m.modelId === row.model)) {
          this.choices.push({ modelId: row.model, name: row.displayName ?? row.model, ...(row.description ? { description: row.description } : {}) })
        }
        cursor = result?.nextCursor
        if (!cursor || seen.has(cursor) || this.choices.length >= 256) break
        seen.add(cursor)
      } while (seen.size < 8)
    } catch { this.choices = [] } // Older app-servers can still chat using their own default.
    if (validModelId(current)) this.selected.set(sessionId, current)
    if (!this.choices.length) return {}
    return { models: { currentModelId: this.selected.get(sessionId), availableModels: this.choices } }
  }
  set(sessionId: string, modelId: string): void {
    if (!this.selected.has(sessionId) && !this.choices.length) throw new RpcRemoteError(-32602, '会话模型不可用')
    if (!this.choices.some(m => m.modelId === modelId)) throw new RpcRemoteError(-32602, '模型不在 Codex 返回的列表中')
    this.selected.set(sessionId, modelId)
  }
  params(sessionId: string): { model?: string } { const model = this.selected.get(sessionId); return model ? { model } : {} }
}

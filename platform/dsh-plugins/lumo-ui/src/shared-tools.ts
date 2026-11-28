import type { Context } from '@deepseek-ai/cordis'
import type { KnowledgeQueryTool } from '../../knowledge/src/consumer.ts'
import type { ConnectorTools } from '../../connector/src/tools.ts'
import type { ConnectorClient } from '../../connector/src/client.ts'
import type { ConversationAsks, AcpIdentity } from '../../acp-engines/src/routes.ts'
import { ownsToolAsk, type DualHost, type HandlerContext, type JsonSchemaLike } from '../../dual-plugins/src/index.ts'
import type { Ask } from '../../../shared/seam-contracts/asks.ts'

interface SharedToolConfig { deploymentMode: string; realm: string; userId: string; projectId?: string }

/** Reuse native consumers through public services; only the session-bound MCP channel is added. */
export function installSharedTools(ctx: Context, host: DualHost | undefined, config: SharedToolConfig): ConversationAsks | undefined {
  if (!host?.mcp || config.deploymentMode !== 'local') return undefined
  const { gateway } = host
  const pending = new Map<string, Ask>()
  let connector: ConnectorClient | undefined
  const boundCaller = ({ caller }: HandlerContext) => {
    if (caller.realm !== config.realm || caller.userId !== config.userId || (caller.projectId || undefined) !== (config.projectId || undefined) || !caller.sessionRef) throw new Error('共享工具调用身份与当前宿主不匹配')
    return caller
  }
  ctx.inject(['knowledgeQueryTool'], scope => {
    const tool = (scope as unknown as { get(name: string): unknown }).get('knowledgeQueryTool') as KnowledgeQueryTool | undefined
    if (!tool) return
    scope.effect(() => gateway.register({ manifestVersion: 1, id: 'knowledge-shared', title: '知识检索', pages: [], tools: [{
      name: 'knowledge_query', description: '检索当前宿主知识库的已发布文档，保留会话空间限制与原生重排。', parameters: tool.parameters as JsonSchemaLike,
      action: 'knowledge:query', risk: 'low', approval: 'never', channels: ['acp'],
    }] }, { knowledge_query: (args, context) => {
      const caller = boundCaller(context)
      if (caller.realm !== tool.realm) throw new Error('知识库所属 realm 与会话不匹配')
      return tool.execute(args, { sessionRef: caller.sessionRef!, userId: caller.userId, signal: context.signal })
    } }), 'lumo: shared knowledge consumer')
  })
  ctx.inject(['connectorTools', 'connectors'], scope => {
    const get = (name: string) => (scope as unknown as { get(name: string): unknown }).get(name)
    const tools = get('connectorTools') as ConnectorTools | undefined, client = get('connectors') as ConnectorClient | undefined
    if (!tools || !client) return
    scope.effect(() => {
      connector = client
      const off = gateway.register({ manifestVersion: 1, id: 'connectors-shared', title: '连接器', pages: [], tools: tools.definitions.map(def => ({
        name: def.name, description: def.description, parameters: def.parameters as JsonSchemaLike,
        action: def.name === 'connector_list' ? 'connector:list' : 'connector:invoke', risk: def.name === 'connector_list' ? 'low' : 'medium',
        // The connector gateway owns operation-specific risk, exact approval receipts and replay.
        approval: 'never', channels: ['acp'],
      })) }, Object.fromEntries(tools.definitions.map(def => [def.name, (args: Record<string, unknown>, context: HandlerContext) => {
        const caller = boundCaller(context)
        if (!client.matchesIdentity(caller)) throw new Error('连接器身份与会话不匹配')
        const invocation = { sessionRef: caller.sessionRef!, ...(caller.runId ? { runId: caller.runId } : {}), signal: context.signal,
          onAsk: (ask: Ask) => { if (ownsToolAsk(ask, caller)) pending.set(ask.id, ask) },
          onSettled: (ask: Ask) => { pending.delete(ask.id) },
        }
        return def.name === 'connector_list' ? tools.list(invocation) : tools.invoke(args, invocation)
      }])))
      return () => { off(); pending.clear(); if (connector === client) connector = undefined }
    }, 'lumo: shared connector consumer')
  })
  const list = async (identity: AcpIdentity, status?: string) => {
    const asks = gateway.asks.list(status ? { status } : {}).filter(ask => ownsToolAsk(ask, identity))
    const associated = [...pending.values()].filter(ask => ownsToolAsk(ask, identity))
    if (connector?.matchesIdentity(identity) && associated.length) {
      let fresh: Ask[]
      try { fresh = await connector.listAsks(status) } catch { return { asks, warnings: ['连接器审批暂时不可用，请刷新重试'] } }
      for (const ask of fresh) {
        const binding = associated.find(item => item.id === ask.id)
        if (binding && ownsToolAsk(ask, identity)) asks.push({ ...ask, source: { ...ask.source, ...(binding.source.session_ref ? { session_ref: binding.source.session_ref } : {}) } })
      }
    }
    return { asks }
  }
  return { list, async answer(id, value, identity) {
    if (id.startsWith('run:dual-')) {
      const ask = gateway.asks.get(id)
      return ask && ownsToolAsk(ask, identity) ? gateway.asks.answer(id, value, identity.userId) : { ok: false, error: 'ask 不存在' }
    }
    const ask = (await list(identity, 'pending')).asks.find(item => item.id === id)
    if (!connector?.matchesIdentity(identity) || !ask?.options?.some(option => option.id === value)) return { ok: false, error: 'ask 或选项不可用' }
    await connector.answerAsk(id, value)
    return { ok: true }
  } }
}

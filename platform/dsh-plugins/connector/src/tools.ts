/**
 * 连接器的模型工具面：`connector_list` 与 `connector_invoke`。
 *
 * 为什么是「两个通用工具」而不是「每个 operation 一个工具」：
 * 连接器由管理员在运行时注册/停用，工具面是**动态**的；把它们静态展开会让
 * 工具列表随注册漂移，且插件重载才能生效。让模型先 list 再 invoke，
 * 与 dsh 的 MCP 桥同构。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { GatewayError, type ConnectorClient } from './client.ts'
import { AskRejectedError, askFromGatewayError, invokeWithAsk } from './asks.ts'
import type { ConnectorSessionScope } from '../../../shared/seam-contracts/connector-scope.ts'
import { ASK_RUN_TREE_EVENT, runTreeLinkOf, withAskContext, type Ask } from '../../../shared/seam-contracts/asks.ts'

export interface ConnectorInvocation { sessionRef?: string; runId?: string; signal?: AbortSignal; onAsk?(ask: Ask): void; onSettled?(ask: Ask): void }
export interface ConnectorTools {
  definitions: Array<Pick<ToolDefinition, 'name' | 'description' | 'parameters'>>
  list(context: ConnectorInvocation): Promise<unknown>
  invoke(args: unknown, context: ConnectorInvocation): Promise<unknown>
}

export interface ConnectorToolOptions {
  publish?: (tools: ConnectorTools) => void

  /**
   * 428 approval_required 后在工具内等待人工决议的上限（毫秒）。默认 10 分钟（网关 TTL 15 分钟）。
   * 设为 0 恢复旧行为：立即把 approval_required 交回模型（仍会登记 Ask 到运行树）。
   */
  askWaitMs?: number
  askPollMs?: number
}

/** 执行上下文里的 run id（防御式取值：ToolRunContext 的增强不一定在本插件类型图里）。 */
function runIdOf(exec: ToolRunContext | undefined): string | undefined {
  const e = exec as { runId?: unknown; run?: { id?: unknown }; agent?: { runId?: unknown } } | undefined
  const raw = e?.runId ?? e?.run?.id ?? e?.agent?.runId
  return raw === undefined || raw === null || String(raw) === '' ? undefined : String(raw)
}

/** 把 Ask 关联广播给运行树采集器（lumo-ui 监听 ASK_RUN_TREE_EVENT）；没有监听者时无副作用。 */
function linkAsk(ctx: Context, ask: Ask): void {
  try {
    (ctx as unknown as { emit?: (name: string, ...args: unknown[]) => void }).emit?.(ASK_RUN_TREE_EVENT, runTreeLinkOf(ask))
  } catch { /* 关联失败不影响调用本身 */ }
}

function invocationOf(exec: ToolRunContext | undefined): ConnectorInvocation {
  const agent = (exec as { agent?: { session?: { id?: unknown } } } | undefined)?.agent
  const raw = agent?.session?.id
  if (agent && (raw === undefined || raw === null || String(raw) === '')) throw new Error('connector: agent session identity is unavailable')
  const runId = runIdOf(exec), signal = (exec as { signal?: AbortSignal } | undefined)?.signal
  return { ...(raw == null ? {} : { sessionRef: String(raw) }), ...(runId ? { runId } : {}), ...(signal ? { signal } : {}) }
}

export function defineConnectorTools(ctx: Context, client: ConnectorClient, scope: ConnectorSessionScope, options: ConnectorToolOptions = {}): () => void {
  const askWaitMs = options.askWaitMs ?? 600_000
  const listTool: ToolDefinition = {
    name: 'connector_list',
    description:
      '列出当前 realm 可用的外部连接器及其操作（工具面）。'
      + '调用外部系统前先用它确认 connectorId、operation 与所需参数。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: {
        type: 'object',
        required: ['connectors'],
        properties: {
          connectors: {
            type: 'array',
            items: {
              type: 'object',
              required: ['id', 'name', 'operations'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                protocol: { type: 'string' },
                version: { type: 'number' },
                operations: {
                  type: 'array',
                  items: {
                    type: 'object',
                    required: ['name', 'method'],
                    properties: {
                      name: { type: 'string' },
                      method: { type: 'string' },
                      write: { type: 'boolean' },
                      sensitivity: { type: 'string' },
                      pathParams: { type: 'array', items: { type: 'string' } },
                      allowedQuery: { type: 'array', items: { type: 'string' } },
                    },
                  },
                },
              },
            },
          },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(_args: unknown, exec: ToolRunContext): Promise<unknown> {
      return list(invocationOf(exec))
    },
  }

  const invokeTool: ToolDefinition = {
    name: 'connector_invoke',
    description:
      '经连接器网关调用外部系统的一个已声明操作。'
      + '注意：不能提供完整 URL —— 目标地址由连接器 manifest 决定，'
      + '你只能填已声明的路径参数与白名单 query。',
    parameters: {
      type: 'object',
      properties: {
        connectorId: { type: 'string', description: 'connector_list 返回的连接器 id' },
        operation: { type: 'string', description: '该连接器工具面内的操作名' },
        pathParams: {
          type: 'object',
          description: '路径占位符取值，如 {"id":"1234"}',
          additionalProperties: { type: 'string' },
        },
        query: {
          type: 'object',
          description: 'query 参数（必须在该操作的 allowedQuery 内）',
          additionalProperties: { type: 'string' },
        },
        body: { description: '请求 JSON 载荷（写操作用）' },
        correlationId: { type: 'string', description: '幂等键；重试同一次调用时保持不变' },
      },
      required: ['connectorId', 'operation'],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        required: ['provenance', 'ok'],
        properties: {
          // 让模型与策略层都能识别：以下是第三方系统返回的内容，不是用户指令
          provenance: { type: 'string' },
          ok: { type: 'boolean' },
          status: { type: 'number' },
          body: {},
          encoding: { type: 'string' },
          contentType: { type: 'string' },
          durationMs: { type: 'number' },
          redacted: { type: 'boolean' },
          // 被闸门拒绝时的结构化原因
          error: { type: 'string' },
          code: { type: 'string' },
          retryable: { type: 'boolean' },
          // 统一 Ask（P0-1）：等待人工时的 Ask id 与最终状态
          askId: { type: 'string' },
          askStatus: { type: 'string' },
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute(args: unknown, exec: ToolRunContext) { return invoke(args, invocationOf(exec)) },
  }
  const list: ConnectorTools['list'] = async context => {
    const allowed = context.sessionRef ? scope.allowedFor(context.sessionRef) : undefined
    const connectors = await client.list(context.signal)
    return { connectors: allowed === undefined ? connectors : connectors.filter(connector => allowed.includes(connector.id)) }
  }
  const invoke: ConnectorTools['invoke'] = async (args, context) => {
      const a = args as {
        connectorId?: string; operation?: string
        pathParams?: Record<string, string>; query?: Record<string, string>
        body?: unknown; correlationId?: string
      }
      if (!a.connectorId?.trim()) throw new Error('connector_invoke: connectorId 不能为空')
      if (!a.operation?.trim()) throw new Error('connector_invoke: operation 不能为空')

      context.signal?.throwIfAborted()
      const sessionRef = context.sessionRef
      const allowed = sessionRef ? scope.allowedFor(sessionRef) : undefined
      if (allowed !== undefined && !allowed.includes(a.connectorId)) {
        return {
          provenance: `external:connector/${a.connectorId}`,
          ok: false,
          error: '该连接器不在本次受治理执行的预设许可范围内',
          code: 'connector_scope_denied',
          retryable: false,
        }
      }

      const askContext = { ...(context.runId ? { run_id: context.runId } : {}), ...(sessionRef ? { session_ref: sessionRef } : {}) }
      const request = {
        connectorId: a.connectorId,
        operation: a.operation,
        ...(a.pathParams ? { pathParams: a.pathParams } : {}),
        ...(a.query ? { query: a.query } : {}),
        body: a.body,
        ...(a.correlationId ? { correlationId: a.correlationId } : {}),
        ...(sessionRef ? { sessionRef } : {}),
      }
      try {
        // P0-1：428 时取统一 Ask，挂到运行树节点，等待决议后用 approvalId 重放同一请求。
        const result = askWaitMs > 0
          ? await invokeWithAsk(client, request, {
            fetchAsk: async (id, signal) => (await client.listAsks(undefined, signal)).find(ask => ask.id === id),
            onAsk: ask => { linkAsk(ctx, ask); context.onAsk?.(ask) },
            onSettled: ask => { linkAsk(ctx, ask); context.onSettled?.(ask) },
            context: askContext,
            maxWaitMs: askWaitMs,
            ...(options.askPollMs ? { pollMs: options.askPollMs } : {}),
            ...(context.signal ? { signal: context.signal } : {}),
          })
          : await client.invoke(request, context.signal)
        return {
          provenance: `external:connector/${a.connectorId}`,
          ok: result.status < 400,
          status: result.status,
          body: result.body,
          encoding: result.encoding,
          contentType: result.contentType,
          durationMs: result.durationMs,
          redacted: result.redacted,
        }
      } catch (e) {
        // 闸门拒绝是**正常结果**而非工具故障：把结构化原因交回模型，
        // 让它能自己判断该等待重试（限速/熔断）还是换路（权限/参数）。
        if (e instanceof AskRejectedError) {
          return {
            provenance: `external:connector/${a.connectorId}`,
            ok: false,
            error: e.message,
            code: 'approval_required',
            retryable: false,
            askId: e.ask.id,
            askStatus: e.ask.status,
          }
        }
        if (e instanceof GatewayError) {
          const pending = askFromGatewayError(e)
          if (pending) {
            // askWaitMs=0 的旧路径：仍把 Ask 登记到运行树，模型拿到 askId 可告知用户。
            const ask = withAskContext(pending, askContext)
            linkAsk(ctx, ask)
            context.onAsk?.(ask)
            return {
              provenance: `external:connector/${a.connectorId}`,
              ok: false,
              error: e.message,
              code: e.code,
              retryable: e.retryable,
              askId: ask.id,
              askStatus: ask.status,
            }
          }
          return {
            provenance: `external:connector/${a.connectorId}`,
            ok: false,
            error: e.message,
            code: e.code,
            retryable: e.retryable,
          }
        }
        throw e
      }
  }
  options.publish?.({ definitions: [listTool, invokeTool], list, invoke })

  const disposeList = ctx.tools.register(listTool)
  const disposeInvoke = ctx.tools.register(invokeTool)
  return () => {
    disposeList()
    disposeInvoke()
  }
}

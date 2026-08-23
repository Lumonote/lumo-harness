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

export function defineConnectorTools(ctx: Context, client: ConnectorClient): () => void {
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
    async execute(): Promise<unknown> {
      return { connectors: await client.list() }
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
        },
        additionalProperties: false,
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    async execute(args: unknown, _exec: ToolRunContext): Promise<unknown> {
      const a = args as {
        connectorId?: string; operation?: string
        pathParams?: Record<string, string>; query?: Record<string, string>
        body?: unknown; correlationId?: string
      }
      if (!a.connectorId?.trim()) throw new Error('connector_invoke: connectorId 不能为空')
      if (!a.operation?.trim()) throw new Error('connector_invoke: operation 不能为空')

      try {
        const result = await client.invoke({
          connectorId: a.connectorId,
          operation: a.operation,
          pathParams: a.pathParams,
          query: a.query,
          body: a.body,
          correlationId: a.correlationId,
        })
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
        if (e instanceof GatewayError) {
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
    },
  }

  const disposeList = ctx.tools.register(listTool)
  const disposeInvoke = ctx.tools.register(invokeTool)
  return () => {
    disposeList()
    disposeInvoke()
  }
}

/**
 * @lumo/connector —— 连接器 Consumer（§10.1 的 dsh 侧）。
 *
 * 组件**不直连外部系统**：所有出站调用都经连接器网关（四道闸 + 审计）。
 * 本插件只做两件事：把网关的工具面暴露给模型，把调用结果标注来源后交回。
 *
 * 安全（评审 R5）：外部返回内容带 provenance 标记，与用户指令区分 ——
 * 第三方 API 的响应体里可能藏着注入指令。
 */
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-tools'

import { ConnectorClient } from './client.ts'
import { defineConnectorTools } from './tools.ts'

export interface ConnectorConfig {
  /** 连接器网关地址（Local-lite: http://localhost:58082） */
  gatewayUrl: string
  /** 本节点身份（装配层固定；模型不可改 —— 同知识库 realm 的处理） */
  realm: string
  userId: string
  roles: string[]
  projectId?: string
  /** 单次调用超时（默认 30s；网关侧还有连接器级超时，取两者较小） */
  timeoutMs?: number
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectors: ConnectorClient
  }
}

/** Schemastery validation for {@link ConnectorConfig} */
export const Config: z<ConnectorConfig> = z.object({
  gatewayUrl: z.string(),
  realm: z.string(),
  userId: z.string(),
  roles: z.array(z.string()),
  projectId: z.string(),
  timeoutMs: z.number(),
})

export const inject = ['tools']

export function apply(ctx: Context, config: ConnectorConfig): void {
  const client = new ConnectorClient({
    gatewayUrl: config.gatewayUrl,
    realm: config.realm,
    userId: config.userId,
    roles: config.roles,
    projectId: config.projectId,
    timeoutMs: config.timeoutMs,
  })
  ctx.provide('connectors', client)

  const unregister = defineConnectorTools(ctx, client)
  ctx.effect(() => () => {
    unregister()
  })
}

export default apply
export { ConnectorClient }

/**
 * @lumo/dual-plugins —— 一个插件同时面向人（页面）和 Agent（工具）。
 *
 * 用法（插件作者）：
 *   const manifest: DualPluginManifest = { manifestVersion: 1, id, title, pages: [...], tools: [...] }
 *   const off = registerDualPlugin(ctx.tools, manifest, { tool_a: async (args, c) => ... })
 *   ctx.effect(() => off)
 * 宿主（lumo-ui）：dualGateway().configure({ decider, runTree, defaults })；挂 handleDualRoute；
 * ACP：createAcpEngines({ mcpServers }) 用 McpBridge.serversFor 给每个会话下发 MCP 配置。
 *
 * 开关：LUMO_DUAL_PLUGINS=off 整体关闭（插件回落到各自旧的直接注册）。
 */
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

import { dualGateway } from './global.ts'
import type { ToolHandler } from './gateway.ts'
import { registerDshTools, type CallerResolver } from './dsh-tools.ts'
import type { DualPluginManifest } from './manifest.ts'

export * from './manifest.ts'
export * from './decide.ts'
export * from './asks.ts'
export * from './gateway.ts'
export * from './global.ts'
export * from './dsh-tools.ts'
export * from './mcp.ts'
export * from './routes.ts'
export * from './host.ts'
export { PROJECT_MANIFEST, PROJECT_CONTEXT_OUTPUT } from './project-manifest.ts'
export { ACP_ENGINES_MANIFEST } from './acp-tools-manifest.ts'

/** 注册到共享网关 + 把 platform 通道的工具注册为 dsh 工具。返回总注销函数。 */
export function registerDualPlugin(tools: { register(def: ToolDefinition): () => void } | undefined, manifest: DualPluginManifest, handlers: Record<string, ToolHandler>, resolveCaller?: CallerResolver): () => void {
  const gateway = dualGateway()
  const off = gateway.register(manifest, handlers)
  const offTools = tools ? registerDshTools(tools, gateway, manifest.tools, resolveCaller) : () => {}
  return () => { offTools(); off() }
}

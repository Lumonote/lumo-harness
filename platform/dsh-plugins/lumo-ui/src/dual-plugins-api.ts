/**
 * lumo-ui 侧的双受众插件装配（P1）：独立文件，index.ts 只做两三行接入（index.ts 已超 60KiB 守卫阈值）。
 *   - 配置共享网关（判定器按部署形态选择、运行树、缺省身份）
 *   - 注册示范插件 acp-engines 的清单（acp_engines_list），project 插件在自己的包里注册
 *   - 提供给 ACP 引擎会话的 MCP 下发函数
 */
import type { Context } from '@deepseek-ai/cordis'
import type { SharedToolsFor } from '../../acp-engines/src/conversation-tools.ts'

import { createDualHost, registerDualPlugin, ACP_ENGINES_MANIFEST, type DualHost, type RunTreeSink } from '../../dual-plugins/src/index.ts'

interface EngineLister { probeStatic(): unknown }
interface DualConfig { deploymentMode: 'local' | 'standalone' | 'cluster'; governanceUrl: string; realm: string; userId: string; projectId: string; controlPlaneToken: string }

export function installDualPlugins(ctx: Context, config: DualConfig, runTree: RunTreeSink | undefined, engines: () => EngineLister | undefined): DualHost | undefined {
  const host = createDualHost({
    deploymentMode: config.deploymentMode, governanceUrl: config.governanceUrl,
    ...(config.controlPlaneToken ? { decideHeaders: { authorization: `Bearer ${config.controlPlaneToken}` } } : {}),
    ...(runTree ? { runTree } : {}),
    defaults: { realm: config.realm, userId: config.userId, ...(config.projectId ? { projectId: config.projectId } : {}) },
  })
  if (!host) return undefined
  const tools = (ctx as unknown as { get(name: string): unknown }).get('tools') as { register(def: unknown): () => void } | undefined
  const off = registerDualPlugin(tools as never, ACP_ENGINES_MANIFEST, {
    acp_engines_list: () => {
      const e = engines()
      if (!e) throw new Error('ACP 引擎会话未启用（仅本地单机，或 LUMO_ACP_ENGINES=off）')
      return { engines: e.probeStatic() }
    },
  })
  ctx.effect(() => () => { off(); host.close() }, 'lumo-ui: dual plugins')
  return host
}

/** 给 createAcpEngines 的 MCP 下发选项；没有 MCP 桥时返回空对象。 */
export function acpMcpOptions(host: DualHost | undefined): { mcpServers?: (c: { realm: string; userId: string; projectId?: string; sessionRef: string }) => Promise<unknown[]>; onSessionClosed?: (sessionRef: string) => void } {
  const mcp = host?.mcp
  if (!mcp) return {}
  return { mcpServers: c => mcp.serversFor(c), onSessionClosed: ref => mcp.revokeSession(ref) }
}

export function sharedToolsFor(host: DualHost | undefined): SharedToolsFor {
  return (identity, sessionRef) => {
    if (!host?.mcp) return { supplied: false, reason: '当前连接未启用共享工具', tools: [] }
    if (!host.mcp.hasSession({ ...identity, sessionRef })) return { supplied: false, reason: '启动或恢复此成员会话后加载共享工具', tools: [] }
    const plugins = host.gateway.listPlugins()
    return { supplied: true, tools: host.gateway.listTools('acp').map(({ pluginId, tool }) => ({
      name: tool.name, title: plugins.find(plugin => plugin.id === pluginId)?.title ?? pluginId, description: tool.description, action: tool.action, risk: tool.risk,
      approval: pluginId === 'connectors-shared' ? 'source' : tool.approval ?? 'auto',
    })) }
  }
}

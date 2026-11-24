/**
 * 宿主装配（供 lumo-ui 一行调用，不依赖 Cordis）。
 *
 * 判定器选择（P1-12 定案）：
 *   local                 → LocalDecider（默认放行；保留 L0 硬边界、委派深度与清单声明的审批）
 *   standalone / cluster  → RemoteDecider(LUMO_AUTHZ_DECIDE_URL 或 governanceUrl)；都没有 → FailClosedDecider
 *   任何形态连不上判定服务 → 拒绝（policy_unavailable）
 * 开关：LUMO_DUAL_PLUGINS=off 返回 undefined；LUMO_DUAL_ACP_MCP=off 不给 ACP 会话下发 MCP；
 *       LUMO_DUAL_AUTHZ=enforce|shadow（服务器缺省 shadow）；
 *       LUMO_DUAL_LOCAL_ASK_HIGH=off 单机下 high 风险（approval=auto）也直接放行。
 */
import { dualGateway, dualPluginsEnabled } from './global.ts'
import { FailClosedDecider, LocalDecider, RemoteDecider, type PermissionDecider } from './decide.ts'
import { envMode, type DualPluginGateway, type RunTreeSink } from './gateway.ts'
import { McpBridge } from './mcp.ts'

export interface DualHost { gateway: DualPluginGateway; mcp: McpBridge | undefined; close(): void }

export interface DualHostOptions {
  deploymentMode: 'local' | 'standalone' | 'cluster'
  governanceUrl?: string
  decideHeaders?: Record<string, string>
  runTree?: RunTreeSink
  defaults: { realm: string; userId: string; projectId?: string }
  env?: NodeJS.ProcessEnv
}

const off = (v: string | undefined) => ['off', '0', 'false'].includes((v ?? '').trim().toLowerCase())

export function pickDecider(o: DualHostOptions): PermissionDecider {
  const env = o.env ?? process.env
  if (o.deploymentMode === 'local') return new LocalDecider({ askHigh: !off(env.LUMO_DUAL_LOCAL_ASK_HIGH) })
  const url = (env.LUMO_AUTHZ_DECIDE_URL ?? '').trim() || (o.governanceUrl ?? '').trim()
  return url ? new RemoteDecider(url, o.decideHeaders ?? {}) : new FailClosedDecider()
}

export function createDualHost(o: DualHostOptions): DualHost | undefined {
  const env = o.env ?? process.env
  if (!dualPluginsEnabled(env)) return undefined
  const gateway = dualGateway()
  gateway.configure({ decider: pickDecider(o), mode: envMode({ ...env, LUMO_DEPLOYMENT_MODE: o.deploymentMode }), ...(o.runTree ? { runTree: o.runTree } : {}), defaults: o.deploymentMode === 'local' ? o.defaults : {} })
  const mcp = o.deploymentMode === 'local' && !off(env.LUMO_DUAL_ACP_MCP) ? new McpBridge(gateway) : undefined
  return { gateway, mcp, close: () => mcp?.close() }
}

/**
 * 设备动作 + 远程确认 Ask 在 lumo-ui 里的装配点。index.ts 只需三行：import、apply 里 install、api 里 handle。
 * 仅本地单机形态启用；服务器形态 install 不做任何事，handle 永远返回 false（行为与旧版一致）。
 */
import type { IncomingMessage, ServerResponse } from 'node:http'

import { createDeviceActions, handleDeviceActionsRoute, registerDeviceActionTools, type DeviceActionsClient, type RunTreeSink } from './device-actions.ts'
import { handleRemoteAsksRoute, type RemoteAskService } from './remote-asks-wiring.ts'
import { handleEnvironmentRoute } from './environment-api.ts'

interface LooseCtx {
  get(name: string): unknown
  inject?(deps: string[], cb: (ctx: LooseCtx) => void): unknown
  effect?(factory: () => () => void, label?: string): unknown
  tools?: { register(tool: unknown): () => void }
}

let client: DeviceActionsClient | undefined
let services: LooseCtx | undefined
let runTree: RunTreeSink | undefined

export function installDeviceActions(ctx: unknown, local: boolean, sink?: RunTreeSink, env: NodeJS.ProcessEnv = process.env): void {
  if (!local) { client = undefined; services = undefined; return }
  const c = ctx as LooseCtx
  services = c
  runTree = sink
  client = createDeviceActions({ env, ...(sink ? { runTree: sink } : {}) })
  const created = client
  if (!created || typeof c.inject !== 'function') return
  c.inject(['tools'], toolsCtx => {
    if (!toolsCtx.tools) return
    const tools = toolsCtx.tools
    toolsCtx.effect?.(() => registerDeviceActionTools({ tools }, created), 'lumo-ui: device action tools')
  })
}

export interface DeviceRoutesDeps { connectorUrl: string; headers: Record<string, string>; timeoutMs: number; readBody: (req: IncomingMessage) => Promise<Buffer>; userId: string }

export async function handleDeviceRoutes(req: IncomingMessage, res: ServerResponse, pathname: string, deps: DeviceRoutesDeps): Promise<boolean> {
  if (!services) return false
  if (await handleEnvironmentRoute(req, res, pathname, { ...(client ? { client } : {}), readBody: deps.readBody })) return true
  if (await handleDeviceActionsRoute(req, res, pathname, { client, readBody: deps.readBody, userId: deps.userId })) return true
  const service = services.get('lumoRemoteComputerUse') as RemoteAskService | undefined
  return handleRemoteAsksRoute(req, res, pathname, { service, confirm: client, ...(runTree ? { runTree } : {}), connectorUrl: deps.connectorUrl, headers: deps.headers, timeoutMs: deps.timeoutMs, readBody: deps.readBody })
}

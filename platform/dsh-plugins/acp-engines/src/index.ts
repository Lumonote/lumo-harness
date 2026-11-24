/**
 * @lumo/acp-engines —— 用 ACP（Agent Client Protocol）把 Claude Code / Codex / Gemini CLI 等引擎接进工作台会话（P1）。
 *
 * 两种用法：
 *   1. 嵌入（默认）：lumo-ui 在 apply 里调 createAcpEngines()，把运行树 store 传进来，再用 handleAcpRoute 接路由。
 *      这样 ACP 会话 / 工具调用直接进 P0-3 运行树、权限请求进 P0-1 Ask 形态。
 *   2. 独立 Cordis 插件：apply() 自己挂 /lumo/api/acp（无运行树），供不装 lumo-ui 的形态试用。
 *
 * 开关：
 *   LUMO_ACP_ENGINES=off                     整体关闭（路由回 501，桌面端退回旧的终端启动）
 *   LUMO_ACP_DISABLED_ENGINES=gemini,codex   禁用个别引擎
 *   LUMO_ACP_MAX_SESSIONS=8                  并发会话上限
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

import { ACP_PREFIX, handleAcpRoute } from './routes.ts'

export { EngineHost, type SessionEvent, type SessionSummary } from './engine-host.ts'
export { SessionAskBroker } from './permission-asks.ts'
export { BUILTIN_ENGINES, EngineRegistry, type EngineDefinition, type EngineProbe } from './registry.ts'
export { bridgeCodexToAcp } from './codex-bridge.ts'
export { AcpRunTreeRecorder } from './run-tree-link.ts'
export { ACP_PREFIX, handleAcpRoute, type AcpRouteDeps } from './routes.ts'

export { acpEnginesEnabled, createAcpEngines, type AcpEngines } from './embed.ts'
import { createAcpEngines } from './embed.ts'

export const name = 'lumo-acp-engines'
export const inject = ['webServer']
export interface Config { realm?: string }

/** 独立插件形态：单用户本机，身份固定为 local。 */
export function apply(ctx: Context, config: Config = {}): void {
  const engines = createAcpEngines()
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: ACP_PREFIX,
    handler: (req, res) => {
      const pathname = new URL(req.url ?? '/', 'http://lumo.local').pathname
      void handleAcpRoute(req, res, pathname, { host: engines?.host, asks: engines?.asks, identity: { userId: 'local', realm: config.realm ?? 'local' }, readBody })
    },
  }), 'lumo-acp-engines: session routes')
  ctx.effect(() => () => engines?.host.closeAll(), 'lumo-acp-engines: reap engine processes')
}

async function readBody(req: import('node:http').IncomingMessage, maxBytes = 1 << 20): Promise<Buffer> {
  const chunks: Buffer[] = []; let bytes = 0
  for await (const part of req) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part as string)
    bytes += chunk.length
    if (bytes > maxBytes) throw new RangeError('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

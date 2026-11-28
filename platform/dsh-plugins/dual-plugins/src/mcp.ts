/**
 * ACP 引擎通道：把清单工具以 **MCP** 形式暴露给 ACP 引擎会话（Claude Code / Codex / Gemini …）。
 *
 * 结构（不引入 @modelcontextprotocol/sdk，协议面很小）：
 *   引擎 ──stdio MCP──> mcp-relay.mjs（随会话由引擎拉起，零依赖）──HTTP POST──> 本进程 McpBridge（127.0.0.1 随机端口）
 *   McpBridge 按会话 token 找到调用方身份（realm / user / lumo 会话 id），tools/call → gateway.invoke(channel='acp')
 * 为什么不走工作台同源路由：工作台入口带 webserver 鉴权 token，引擎子进程拿不到也不该拿到；
 * 独立回环端口 + 每会话一次性 token 的权限面更小，会话关闭即作废。
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import type { Caller, DualPluginGateway } from './gateway.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'
export const MCP_SERVER_NAME = 'lumo-plugins'
export const MCP_TOKEN_HEADER = 'x-lumo-mcp-token'
export const RELAY_PATH = fileURLToPath(new URL('./mcp-relay.mjs', import.meta.url))

export interface McpServerStdio { name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }
interface Rpc { jsonrpc?: '2.0'; id?: string | number | null; method?: string; params?: unknown }

/** 纯协议处理：输入一条 JSON-RPC，输出响应（通知返回 undefined）。可脱离 HTTP 单测。 */
export async function handleMcpMessage(gateway: DualPluginGateway, caller: Omit<Caller, 'channel'>, msg: Rpc, signal?: AbortSignal): Promise<object | undefined> {
  const id = msg.id ?? null
  const ok = (result: unknown) => ({ jsonrpc: '2.0', id, result })
  const fail = (code: number, message: string) => ({ jsonrpc: '2.0', id, error: { code, message } })
  if (msg.id === undefined) return undefined // 通知（notifications/initialized 等）
  switch (msg.method) {
    case 'initialize': return ok({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: MCP_SERVER_NAME, version: '0.1.0' } })
    case 'ping': return ok({})
    case 'tools/list': return ok({ tools: gateway.listTools('acp').map(({ tool }) => ({ name: tool.name, description: tool.description, inputSchema: tool.parameters, annotations: { readOnlyHint: tool.risk === 'low', destructiveHint: tool.risk === 'high' } })) })
    case 'tools/call': {
      const p = (msg.params ?? {}) as { name?: unknown; arguments?: unknown }
      if (typeof p.name !== 'string') return fail(-32602, 'tools/call 需要 name')
      const r = await gateway.invoke(p.name, p.arguments ?? {}, { ...caller, channel: 'acp' }, signal)
      if (r.ok) return ok({ content: [{ type: 'text', text: JSON.stringify(r.value) }], structuredContent: typeof r.value === 'object' && r.value !== null && !Array.isArray(r.value) ? r.value : { value: r.value }, isError: false })
      if (r.code === 'unknown_tool' || r.code === 'invalid_args') return fail(-32602, r.error)
      return ok({ content: [{ type: 'text', text: `${r.code}: ${r.error}` }], isError: true })
    }
    default: return fail(-32601, `不支持的方法：${String(msg.method)}`)
  }
}

export class McpBridge {
  private server: Server | undefined
  private starting: Promise<number> | undefined
  private closed = false
  private port = 0
  private readonly sessions = new Map<string, Omit<Caller, 'channel'>>()
  private readonly calls = new Map<string, Set<AbortController>>()
  constructor(private readonly gateway: DualPluginGateway, private readonly nodeBin: string = process.execPath) {}

  private async ensure(): Promise<number> {
    if (this.closed) throw new Error('MCP bridge is closed')
    if (this.starting) return this.starting
    if (this.server) return this.port
    const server = createServer((req, res) => { void this.handle(req, res) })
    this.starting = new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve()) }).then(() => {
      if (this.closed) { server.close(); throw new Error('MCP bridge is closed') }
      server.unref()
      this.server = server
      this.port = (server.address() as { port: number }).port
      return this.port
    }).finally(() => { this.starting = undefined })
    return this.starting
  }

  /** 给一个 ACP 会话签发 MCP 配置；会话结束必须 revoke。 */
  async serversFor(caller: Omit<Caller, 'channel'>): Promise<McpServerStdio[]> {
    if (this.gateway.listTools('acp').length === 0) return []
    const port = await this.ensure()
    if (this.closed) throw new Error('MCP bridge is closed')
    const token = randomBytes(24).toString('base64url')
    this.sessions.set(token, caller)
    return [{ name: MCP_SERVER_NAME, command: this.nodeBin, args: [RELAY_PATH], env: [{ name: 'LUMO_MCP_URL', value: `http://127.0.0.1:${port}/mcp` }, { name: 'LUMO_MCP_TOKEN', value: token }] }]
  }

  /** Report delivery without exposing credentials or another identity's session. */
  hasSession(caller: { realm: string; userId: string; projectId?: string | undefined; sessionRef: string }): boolean {
    return [...this.sessions.values()].some(value => value.sessionRef === caller.sessionRef
      && value.realm === caller.realm && value.userId === caller.userId
      && (value.projectId || undefined) === (caller.projectId || undefined))
  }

  revokeSession(sessionRef: string): void {
    for (const [t, c] of this.sessions) if (c.sessionRef === sessionRef) this.sessions.delete(t)
    for (const call of this.calls.get(sessionRef) ?? []) call.abort(new Error('会话已关闭'))
    this.calls.delete(sessionRef)
    this.gateway.revokeSession(sessionRef)
  }

  close(): void {
    this.closed = true
    for (const caller of this.sessions.values()) if (caller.sessionRef) this.revokeSession(caller.sessionRef)
    for (const calls of this.calls.values()) for (const call of calls) call.abort(new Error('工具桥已关闭'))
    this.calls.clear(); this.server?.close(); this.server = undefined; this.sessions.clear()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body?: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(body === undefined ? '' : JSON.stringify(body)) }
    if (req.method !== 'POST' || req.url !== '/mcp') return send(404, { error: 'not found' })
    const token = req.headers[MCP_TOKEN_HEADER]
    const caller = typeof token === 'string' ? this.sessions.get(token) : undefined
    if (!caller) return send(401, { error: 'invalid token' })
    let raw = ''
    for await (const chunk of req) { raw += chunk; if (raw.length > 4 << 20) return send(413, { error: 'too large' }) }
    let msg: Rpc
    try { msg = JSON.parse(raw) as Rpc } catch { return send(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }) }
    if (typeof token !== 'string' || this.sessions.get(token) !== caller) return send(401, { error: 'session closed' })
    const controller = new AbortController(), key = caller.sessionRef ?? token
    const active = this.calls.get(key) ?? new Set<AbortController>(); active.add(controller); this.calls.set(key, active)
    const disconnect = () => { if (!res.writableEnded) controller.abort(new Error('MCP 客户端已断开')) }
    res.on('close', disconnect)
    try {
      const out = await handleMcpMessage(this.gateway, caller, msg, controller.signal)
      if (res.destroyed) return
      if (out === undefined) { res.writeHead(202); res.end(); return }
      send(200, out)
    } finally { res.off('close', disconnect); active.delete(controller); if (!active.size) this.calls.delete(key) }
  }
}

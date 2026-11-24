#!/usr/bin/env node
// Lumo 插件工具的 MCP stdio 中继：由 ACP 引擎按 session/new 的 mcpServers 拉起。
// 每行一条 JSON-RPC（MCP stdio 帧）→ POST 到 LUMO_MCP_URL（回环地址，带会话 token）→ 响应写回 stdout。
// 零依赖，只用 Node 内置 fetch；不读写任何文件。
import { createInterface } from 'node:readline'

const url = process.env.LUMO_MCP_URL
const token = process.env.LUMO_MCP_TOKEN
if (!url || !token) { process.stderr.write('lumo mcp relay: missing LUMO_MCP_URL / LUMO_MCP_TOKEN\n'); process.exit(2) }

const write = (obj) => process.stdout.write(`${JSON.stringify(obj)}\n`)
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity })
rl.on('line', async (line) => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }); return }
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lumo-mcp-token': token }, body: JSON.stringify(msg) })
    if (res.status === 202) return
    const text = await res.text()
    if (!res.ok && msg.id !== undefined) { write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: `lumo 返回 ${res.status}: ${text.slice(0, 200)}` } }); return }
    if (text) process.stdout.write(`${text}\n`)
  } catch (error) {
    if (msg.id !== undefined) write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: `lumo 不可达：${error?.message ?? error}` } })
  }
})
rl.on('close', () => process.exit(0))

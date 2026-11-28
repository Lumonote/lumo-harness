/**
 * 本机设备动作（P1）在 DSH worker 侧的接入：客户端 + BFF 路由 + Agent 工具 + 运行树登记。
 *
 * 动作的注册表、风险判定、本机原生确认都在 Tauri 桌面进程里（desktop/src/device_*.rs）。
 * 这里只做三件事：
 *  1. `DeviceActionsClient`：读 `LUMO_DEVICE_ACTIONS_FILE`（{url, token}），调用桌面端 127.0.0.1 接口；
 *  2. `handleDeviceActionsRoute`：/lumo/api/device-actions*，供工作台面板与 ACP 会话（带 session_ref）调用；
 *  3. `registerDeviceActionTools`：给平台 Agent 注册 `device_actions_list` / `device_action_invoke` 两个工具。
 *
 * 每次调用都以 subagent.start / subagent.end 登记到 P0-3 运行树（childSessionId = `device:<call_id>`，
 * parentSessionId = 调用方会话），确认中的高风险调用以 ask.pending / ask.resolved 挂到同一会话。
 * Ask 只能在本机确认框作答：工作台只能看到和撤回（cancel），无法代替用户点「允许」。
 *
 * 开关：桌面端 `LUMO_DEVICE_ACTIONS=off` 全部拒绝；worker 侧没有端点文件时路由返回 501、工具不注册。
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'

import type { RunTreeEvent } from '../../../shared/seam-contracts/run-tree.ts'

export interface DeviceEndpoint { url: string; token: string }
export interface DeviceCaller { session_ref?: string; run_id?: string; agent?: string }
export interface DeviceInvokeResult { status: number; body: { call_id?: string; state?: string; result?: unknown; error?: string; decision?: { effect: string; code?: string; reason?: string; settings_url?: string }; confirmed?: boolean } }
export interface RunTreeSink { apply(event: RunTreeEvent): unknown }

export const DEVICE_ACTIONS_PREFIX = '/lumo/api/device-actions'
const REF = /^[A-Za-z0-9._:@/-]{1,200}$/u
const CALL_ID = /^[A-Za-z0-9_-]{1,80}$/u
const ACTION = /^[a-z]+\.[a-z]+$/u
/** 与 Rust 侧 CATALOG 的高风险集合一致（客户端只用于提前登记 Ask，最终以桌面端判定为准）。 */
export const HIGH_RISK_ACTIONS: ReadonlySet<string> = new Set(['clipboard.read', 'screen.capture', 'input.mouse', 'input.keyboard'])

export function readDeviceEndpoint(file: string | undefined): DeviceEndpoint | undefined {
  if (!file) return undefined
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<DeviceEndpoint>
    if (typeof raw.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/u.test(raw.url) || typeof raw.token !== 'string' || raw.token.length < 32) return undefined
    return { url: raw.url, token: raw.token }
  } catch { return undefined }
}

export function sanitizeCaller(raw: unknown): DeviceCaller {
  const r = (raw ?? {}) as Record<string, unknown>
  const out: DeviceCaller = {}
  for (const k of ['session_ref', 'run_id', 'agent'] as const) if (typeof r[k] === 'string' && REF.test(r[k] as string)) out[k] = r[k] as string
  return out
}

export function deviceAskId(callId: string): string { return `device:${callId}` }

export class DeviceActionsClient {
  constructor(private readonly endpoint: DeviceEndpoint, private readonly runTree?: RunTreeSink, private readonly fetchImpl: typeof fetch = fetch) {}

  private async call(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<{ status: number; body: unknown }> {
    const res = await this.fetchImpl(`${this.endpoint.url}${path}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
      headers: { authorization: `Bearer ${this.endpoint.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const text = await res.text()
    let parsed: unknown = {}
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = { error: text.slice(0, 200) } }
    return { status: res.status, body: parsed }
  }

  catalog() { return this.call('GET', '/v1/device-actions') }
  calls() { return this.call('GET', '/v1/device-actions/calls') }
  environment(method: 'GET' | 'POST', path: string, body?: unknown) {
    if (!['/servers', '/device', '/device/activate', '/device/pause', '/device/resume', '/device/leave'].includes(path)) throw Error('unknown_environment_endpoint')
    return this.call(method, `/v1/environment${path}`, body, 135_000)
  }
  cancel(callId: string) { return this.call('POST', `/v1/device-actions/calls/${encodeURIComponent(callId)}/cancel`, {}) }
  requestPermission(name: 'accessibility' | 'screen-recording') { return this.call('POST', `/v1/device-actions/permissions/${name}/request`, {}) }

  /** 通用本机确认（remote-broker 等来源复用）。桌面确认框最长 120 秒。 */
  async confirm(title: string, detail: string): Promise<boolean> {
    const res = await this.call('POST', '/v1/device-actions/confirm', { title, detail }, 130_000)
    return res.status === 200 && (res.body as { approved?: unknown }).approved === true
  }

  async invoke(action: string, args: unknown, caller: DeviceCaller, callId: string = randomUUID()): Promise<DeviceInvokeResult> {
    if (!ACTION.test(action) || !CALL_ID.test(callId)) return { status: 400, body: { error: 'invalid action or call_id' } }
    const parent = caller.session_ref
    const child = `device:${callId}`
    const at = () => new Date().toISOString()
    const emit = (event: RunTreeEvent) => { try { this.runTree?.apply(event) } catch { /* 运行树故障不影响调用 */ } }
    if (parent) emit({ type: 'subagent.start', runId: caller.run_id ?? `device-${callId}`, childSessionId: child, parentSessionId: parent, provider: 'device-actions', name: action, at: at() })
    const high = HIGH_RISK_ACTIONS.has(action)
    if (high) emit({ type: 'ask.pending', askId: deviceAskId(callId), ...(caller.run_id ? { runId: caller.run_id } : {}), ...(parent ? { sessionRef: parent } : {}) })
    let out: DeviceInvokeResult
    try {
      const res = await this.call('POST', '/v1/device-actions/invoke', { call_id: callId, action, args: args ?? {}, caller }, 135_000)
      out = { status: res.status, body: res.body as DeviceInvokeResult['body'] }
    } catch (error) {
      out = { status: 502, body: { call_id: callId, state: 'failed', error: error instanceof Error ? error.message : '桌面端不可达' } }
    }
    if (high) emit({ type: 'ask.resolved', askId: deviceAskId(callId), ...(caller.run_id ? { runId: caller.run_id } : {}), ...(parent ? { sessionRef: parent } : {}) })
    if (parent) {
      const state = out.body.state
      const stopReason = state === 'succeeded' ? 'completed' : state === 'rejected' || state === 'cancelled' || state === 'denied' ? 'aborted' : 'error'
      emit({ type: 'subagent.end', runId: caller.run_id ?? `device-${callId}`, childSessionId: child, parentSessionId: parent, provider: 'device-actions', stopReason, at: at(), summary: `${action} · ${state ?? 'failed'}` })
    }
    return out
  }
}

export function createDeviceActions(options: { env?: NodeJS.ProcessEnv; runTree?: RunTreeSink } = {}): DeviceActionsClient | undefined {
  const endpoint = readDeviceEndpoint((options.env ?? process.env).LUMO_DEVICE_ACTIONS_FILE)
  return endpoint ? new DeviceActionsClient(endpoint, options.runTree) : undefined
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(JSON.stringify(body))
}

export interface DeviceRouteDeps { client: DeviceActionsClient | undefined; readBody: (req: IncomingMessage) => Promise<Buffer>; userId: string }

/**
 *   GET  /lumo/api/device-actions                          注册表 + 判定（含 macOS 权限提示）
 *   GET  /lumo/api/device-actions/calls                    调用账本
 *   POST /lumo/api/device-actions/invoke {action,args,session_ref?,run_id?,agent?}
 *   POST /lumo/api/device-actions/calls/{id}/cancel
 *   POST /lumo/api/device-actions/permissions/{accessibility|screen-recording}/request
 */
export async function handleDeviceActionsRoute(req: IncomingMessage, res: ServerResponse, pathname: string, deps: DeviceRouteDeps): Promise<boolean> {
  if (pathname !== DEVICE_ACTIONS_PREFIX && !pathname.startsWith(`${DEVICE_ACTIONS_PREFIX}/`)) return false
  const client = deps.client
  if (!client) { json(res, 501, { error: '本机设备动作不可用（仅桌面单机版；或桌面端未提供端点）' }); return true }
  const relay = async (p: Promise<{ status: number; body: unknown }>) => {
    try { const r = await p; json(res, r.status, r.body) } catch (error) { json(res, 502, { error: error instanceof Error ? error.message : '桌面端不可达' }) }
  }
  if (req.method === 'GET' && pathname === DEVICE_ACTIONS_PREFIX) { await relay(client.catalog()); return true }
  if (req.method === 'GET' && pathname === `${DEVICE_ACTIONS_PREFIX}/calls`) { await relay(client.calls()); return true }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return true }
  const cancel = /^\/lumo\/api\/device-actions\/calls\/([A-Za-z0-9_-]{1,80})\/cancel$/u.exec(pathname)
  if (cancel) { await relay(client.cancel(cancel[1]!)); return true }
  const perm = /^\/lumo\/api\/device-actions\/permissions\/(accessibility|screen-recording)\/request$/u.exec(pathname)
  if (perm) { await relay(client.requestPermission(perm[1] as 'accessibility' | 'screen-recording')); return true }
  if (pathname === `${DEVICE_ACTIONS_PREFIX}/invoke`) {
    let body: Record<string, unknown>
    try { body = JSON.parse((await deps.readBody(req)).toString('utf8') || '{}') as Record<string, unknown> } catch { json(res, 400, { error: 'invalid_json' }); return true }
    if (typeof body.action !== 'string') { json(res, 400, { error: 'action required' }); return true }
    const caller = sanitizeCaller({ ...body, agent: typeof body.agent === 'string' ? body.agent : `user:${deps.userId}` })
    const out = await client.invoke(body.action, body.args, caller)
    json(res, out.status, out.body)
    return true
  }
  json(res, 404, { error: 'unknown_device_action_endpoint' })
  return true
}

interface ToolsHost { tools: { register(tool: unknown): () => void } }

function execSession(exec: unknown): DeviceCaller {
  const e = exec as { runId?: unknown; run?: { id?: unknown }; agent?: { runId?: unknown; name?: unknown; session?: { id?: unknown } } } | undefined
  return sanitizeCaller({ session_ref: e?.agent?.session?.id, run_id: e?.runId ?? e?.run?.id ?? e?.agent?.runId, agent: e?.agent?.name })
}

/** 平台 Agent 工具面。返回注销函数。 */
export function registerDeviceActionTools(ctx: ToolsHost, client: DeviceActionsClient): () => void {
  const list = ctx.tools.register({
    name: 'device_actions_list',
    description: '列出本机可用的设备动作（打开文件/应用、剪贴板、通知、截图、可选的鼠标键盘），以及每个动作当前是直接放行、需要用户在本机确认，还是被拒绝（含系统权限缺失提示）。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute() { const r = await client.catalog(); return r.body },
  })
  const invoke = ctx.tools.register({
    name: 'device_action_invoke',
    description: '执行一个本机设备动作。高风险动作（读剪贴板、截图、鼠标键盘）会在用户电脑上弹确认框，用户拒绝或 120 秒未操作即失败，请不要重试同一请求来骚扰用户。',
    parameters: {
      type: 'object', required: ['action'], additionalProperties: false,
      properties: { action: { type: 'string', description: '动作 id，先用 device_actions_list 查看' }, args: { type: 'object', description: '动作参数' } },
    },
    async execute(args: { action?: unknown; args?: unknown }, exec: unknown) {
      if (typeof args?.action !== 'string') return { ok: false, error: 'action required' }
      const out = await client.invoke(args.action, args.args, execSession(exec))
      return { ok: out.status === 200, ...out.body }
    },
  })
  return () => { list(); invoke() }
}

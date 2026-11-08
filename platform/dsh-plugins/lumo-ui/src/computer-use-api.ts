/** Local computer control uses the upstream signed browser session, never Lumo identity defaults. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { release as osRelease } from 'node:os'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'

export interface ComputerUseSnapshot {
  enabled: boolean
  phase: 'disabled' | 'ready' | 'running' | 'stopping'
  authorizedSessionId: string | null
  ownerSessionId: string | null
  startedAt: number | null
  lastActivityAt: number | null
  inFlight: number
  events: Array<{ id: number; at: number; sessionId: string; callId: string; tool: string; method: string | null; state: 'started' | 'succeeded' | 'failed' | 'cancelled' | 'denied'; code?: string }>
}
export interface ComputerUseStatus extends ComputerUseSnapshot { provider: string | null; platform: string; nativeSupport: boolean; controlRevision: number }
interface ComputerUseService {
  snapshot(): ComputerUseSnapshot
  enable(sessionId: string): ComputerUseSnapshot
  stop(): ComputerUseSnapshot
}
interface BrowserConnection {
  readonly browserPeer: object
  admit(request: IncomingMessage): { peer: object } | { rejection: number }
}
interface ServiceContext { get(name: string): unknown }
const PREFIX = '/lumo/api/computer-use'

function json(res: ServerResponse, status: number, value: unknown): void {
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.writeHead(status)
  res.end(JSON.stringify(value))
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > 1024) throw Error('body_too_large')
    chunks.push(buffer)
  }
  let value: unknown
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) }
  catch { throw Error('invalid_json') }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw Error('invalid_body')
  return value as Record<string, unknown>
}

/** Separate, more-specific prefix so the general platform API cannot bypass these checks. */
export function computerUseHandler(ctx: ServiceContext, local: boolean, platform = process.platform, systemRelease = osRelease()) {
  // Compare after body transfer: a stop must invalidate an earlier enable even
  // when that enable's request body arrives after the stop has completed.
  let controlRevision = 0
  const nativeSupport = platform === 'darwin' && Number.parseInt(systemRelease.split('.')[0] ?? '', 10) >= 23
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!local) { json(res, 404, { error: 'computer_use_local_only' }); return }
    const connection = ctx.get('connection') as BrowserConnection | undefined
    if (connection === undefined) { json(res, 503, { error: 'browser_auth_unavailable' }); return }
    const admission = connection.admit(req)
    if ('rejection' in admission) { json(res, admission.rejection, { error: 'browser_auth_required' }); return }
    if (admission.peer !== connection.browserPeer) { json(res, 403, { error: 'browser_auth_required' }); return }

    const pathname = new URL(req.url ?? '/', 'http://local.invalid').pathname
    const action = pathname === PREFIX ? 'status' : pathname === `${PREFIX}/enable` ? 'enable' : pathname === `${PREFIX}/stop` ? 'stop' : undefined
    if (action === undefined) { json(res, 404, { error: 'unknown_computer_use_endpoint' }); return }
    if (req.method !== (action === 'status' ? 'GET' : 'POST')) {
      res.setHeader('allow', action === 'status' ? 'GET' : 'POST')
      json(res, 405, { error: 'method_not_allowed' }); return
    }
    const service = ctx.get('lumoComputerUse') as ComputerUseService | undefined
    if (service === undefined) { json(res, 503, { error: 'computer_use_unavailable' }); return }
    let sessionId: string | undefined
    if (action !== 'status') {
      const protocol = (ctx.get('webServer') as { protocol?: string } | undefined)?.protocol
      let expectedOrigin: string | undefined
      try { if (protocol === 'http:' || protocol === 'https:') expectedOrigin = new URL(`${protocol}//${req.headers.host ?? ''}`).origin }
      catch { /* Invalid hosts fail closed, including when authentication is mocked by a host. */ }
      if (expectedOrigin === undefined || req.headers.origin !== expectedOrigin || req.headers['sec-fetch-site'] === 'cross-site') {
        json(res, 403, { error: 'same_origin_required' }); return
      }
      if (!/^application\/json(?:\s*;|\s*$)/iu.test(req.headers['content-type'] ?? '')) { json(res, 415, { error: 'json_required' }); return }
      let input: Record<string, unknown>
      try { input = await body(req) }
      catch (error) { const code = error instanceof Error ? error.message : 'invalid_body'; json(res, code === 'body_too_large' ? 413 : 400, { error: code }); return }
      if (action === 'enable') {
        if (Object.keys(input).length !== 2 || typeof input['sessionId'] !== 'string' || !/^[^\s\u0000-\u001f\u007f]{1,256}$/u.test(input['sessionId'])) {
          json(res, 400, { error: 'session_required' }); return
        }
        if (!Number.isSafeInteger(input['controlRevision']) || (input['controlRevision'] as number) < 0) {
          json(res, 400, { error: 'control_revision_required' }); return
        }
        if (input['controlRevision'] !== controlRevision) { json(res, 409, { error: 'computer_use_control_conflict', controlRevision }); return }
        sessionId = input['sessionId']
      } else if (Object.keys(input).length !== 0) { json(res, 400, { error: 'empty_body_required' }); return }
    }
    // Provider identity is passive metadata. Reading the page never starts the native helper.
    const provider = (ctx.get('computerUse') as { providerName?: string } | undefined)?.providerName ?? null
    if (action === 'enable' && (!nativeSupport || provider !== 'dsh-cua')) {
      json(res, 409, { error: 'computer_use_provider_unavailable' }); return
    }
    try {
      const snapshot = action === 'enable' ? service.enable(sessionId!) : action === 'stop' ? service.stop() : service.snapshot()
      if (action !== 'status') controlRevision++
      json(res, 200, { ...snapshot, provider, platform, nativeSupport, controlRevision } satisfies ComputerUseStatus)
    } catch (error) {
      const code = error instanceof Error ? error.message : ''
      const conflict = code === 'COMPUTER_USE_STOPPING' || code === 'COMPUTER_USE_BUSY'
      json(res, conflict ? 409 : 503, { error: conflict ? code : 'computer_use_unavailable' })
    }
  }
}

export function registerComputerUseRoutes(ctx: Context, local: boolean): void {
  ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: PREFIX, handler: computerUseHandler(ctx, local) }), 'lumo-ui: authenticated local computer controls')
}

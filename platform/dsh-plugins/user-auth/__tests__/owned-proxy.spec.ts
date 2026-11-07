import { createServer, type Server } from 'node:http'
import { connect } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createAuthProxy, listenAuthProxy, closeAuthProxy } from '../src/proxy.ts'
import { GovernanceApiError, type GovernanceAuthClient } from '../src/client.ts'
const group = process.env.LUMO_AUTH_PROXY_TEST === '1' ? describe : describe.skip
const alice = { realm: 'r', user_id: 'alice', roles: ['operator'], username: 'alice', display_name: 'Alice', session_expires_at: '2099-01-01' }
group('owned Session public HTTP transport', () => {
  let server: Server | undefined
  let upstream: Server | undefined
  afterEach(async () => { if (server) await closeAuthProxy(server); if (upstream) await closeAuthProxy(upstream); vi.restoreAllMocks() })
  async function start() {
    const execute = vi.fn(async () => ({ sessionId: 'owned' }))
    const stream = vi.fn(async (_principal: unknown, _action: string, _request: Record<string, unknown>, _signal: AbortSignal) => (async function* () { yield { text: 'first' }; yield { text: 'second' } })())
    const session = vi.fn(async () => alice)
    server = createAuthProxy({ host: '127.0.0.1', port: 0, secureCookie: false, realm: 'r', projectId: 'p', identityAssertionSecret: 'a'.repeat(32), upstreamPort: 1,
      client: { session, authorizeSessionProject: vi.fn(async () => {}) } as unknown as GovernanceAuthClient,
      sessionTransport: { execute, stream }, logger: { info() {}, warn() {}, error() {} } })
    return { base: `http://127.0.0.1:${await listenAuthProxy(server, '127.0.0.1', 0)}`, execute, stream, session }
  }
  const headers = { cookie: 'lumo_auth_session=valid', 'x-lumo-auth-request': '1', 'content-type': 'application/json', 'x-lumo-user': 'attacker' }
  it('binds each request to governance login and strips wire identity from execution', async () => {
    const h = await start()
    const response = await fetch(`${h.base}/lumo/sessions/create`, { method: 'POST', headers, body: '{}' })
    expect(response.status).toBe(200)
    expect(h.execute.mock.calls[0]![0]).toEqual(alice)
    expect(h.execute.mock.calls[0]![1]).toBe('create')
    expect(h.execute.mock.calls[0]![2]).toEqual({})
    const denied = await fetch(`${h.base}/lumo/sessions/create`, { method: 'POST', headers: { cookie: headers.cookie, 'content-type': 'application/json' }, body: '{}' })
    expect(denied.status).toBe(403)
    expect(h.execute).toHaveBeenCalledOnce()
  })
  it('disables shared owner native HTTP and WS endpoints', async () => {
    const h = await start()
    for (const path of ['/api/session/list', '/api', '/', '/files/secret', '/other']) {
      const response = await fetch(h.base + path, { headers })
      expect(response.status).toBe(403)
      expect(await response.text()).toContain('shared_owner_transport_disabled')
    }
    const u = new URL(h.base)
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(u.port), '127.0.0.1')
      let text = ''
      socket.on('connect', () => socket.write(`GET /api/stream HTTP/1.1\r\nHost: ${u.host}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nCookie: ${headers.cookie}\r\n\r\n`))
      socket.on('data', data => { text += String(data) })
      socket.on('end', () => resolve(text)); socket.on('error', reject)
    })
    expect(response).toContain('403 Shared Owner WebSocket Disabled')
    expect(h.execute).not.toHaveBeenCalled()
  })
  it('allows only the trusted runtime team GET, rebuilding identity headers', async () => {
    const seen: Array<Record<string, unknown>> = []
    upstream = createServer((req, res) => { seen.push(req.headers); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"id":"team-1"}') })
    const port = await listenAuthProxy(upstream, '127.0.0.1', 0)
    const session = vi.fn(async () => alice)
    server = createAuthProxy({ host: '127.0.0.1', port: 0, secureCookie: false, realm: 'r', projectId: 'p', identityAssertionSecret: 'a'.repeat(32), upstreamPort: port,
      serverRuntimeToken: 'service-secret', client: { session } as unknown as GovernanceAuthClient, logger: { info() {}, warn() {}, error() {} } })
    const base = `http://127.0.0.1:${await listenAuthProxy(server, '127.0.0.1', 0)}`
    expect((await fetch(base + '/lumo/runtime/teams/team-1', { headers })).status).toBe(401)
    const response = await fetch(base + '/lumo/runtime/teams/team-1', { headers: { authorization: 'Bearer service-secret', 'x-lumo-user': 'attacker', 'x-lumo-realm': 'foreign', 'x-lumo-roles': 'admin', cookie: 'attacker=x' } })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'team-1' })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toEqual(expect.objectContaining({ authorization: 'Bearer service-secret', 'x-lumo-realm': 'r' }))
    for (const name of ['x-lumo-user', 'x-lumo-roles', 'cookie']) expect(seen[0]![name]).toBeUndefined()
    expect(session).not.toHaveBeenCalled()
    expect((await fetch(base + '/lumo/runtime/teams/team-1', { method: 'POST', headers: { authorization: 'Bearer service-secret' } })).status).toBe(405)
  })
  it('delivers NDJSON streams over the authenticated user boundary', async () => {
    const h = await start()
    const response = await fetch(`${h.base}/lumo/sessions/follow`, { method: 'POST', headers, body: '{"address":{"kind":"session","sessionId":"owned"}}' })
    expect(response.headers.get('content-type')).toBe('application/x-ndjson')
    expect(await response.text()).toBe('{"text":"first"}\n{"text":"second"}\n')
    expect(h.stream.mock.calls[0]![0]).toEqual(alice)
  })
  it('reports pending durable input as a stable recoverable refusal', async () => {
    const h = await start()
    h.execute.mockRejectedValueOnce(Object.assign(new Error('pending'), { code: 'session_pending_input' }))
    const response = await fetch(`${h.base}/lumo/sessions/prompt`, { method: 'POST', headers, body: '{}' })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ error: 'session_pending_input' })
  })
  it('closes an active response when the current login is revoked', async () => {
    const checks: Array<() => void> = []
    const original = globalThis.setInterval
    vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void, delay: number) => {
      if (delay === 5000) checks.push(callback)
      return original(callback, delay)
    }) as typeof setInterval)
    const h = await start()
    let streamSignal: AbortSignal | undefined
    h.stream.mockImplementationOnce(async (_principal, _action, _request, signal) => {
      streamSignal = signal
      return (async function* () {
        yield { text: 'first' }
        await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      })()
    })
    const response = await fetch(`${h.base}/lumo/sessions/follow`, { method: 'POST', headers, body: '{}' })
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('{"text":"first"}\n')
    h.session.mockRejectedValueOnce(new Error('revoked'))
    expect(checks).toHaveLength(1)
    checks[0]!()
    await reader.read().then(result => expect(result.done).toBe(true), error => expect(error).toBeInstanceOf(Error))
    expect(streamSignal?.aborted).toBe(true)
    expect(h.session.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
  it('re-authenticates internal credentials and refuses stale routing generations without using caller cookies',async()=>{
    const execute=vi.fn(async()=>({accepted:true}))
    const stream=vi.fn(async()=>async function*(){yield {text:'ok'}}())
    const session=vi.fn(async(token:string)=>{if(token!=='valid-login')throw new GovernanceApiError(401,'invalid_session','invalid');return alice})
    const destination=vi.fn(async(node:{process_id:string;realm:string;project_id:string})=>{if(node.process_id!=='current'||node.realm!=='r'||node.project_id!=='p')throw new Error('stale')})
    const logger={info:vi.fn(),warn:vi.fn(),error:vi.fn()}
    server=createAuthProxy({host:'127.0.0.1',port:0,secureCookie:false,realm:'r',projectId:'p',identityAssertionSecret:'a'.repeat(32),upstreamPort:1,serverRuntimeToken:'service-secret',client:{session,authorizeSessionProject:vi.fn(async()=>{})} as unknown as GovernanceAuthClient,
      sessionTransport:{execute:vi.fn(async()=>{throw new Error('must not recurse')}),stream,internal:{transport:{execute,stream},destination}},logger})
    const base=`http://127.0.0.1:${await listenAuthProxy(server,'127.0.0.1',0)}`
    const request={action:'cancel',request:{sessionId:'owned'},credential:'valid-login',destination:{process_id:'current',realm:'r',project_id:'p'}}
    const call=(body:unknown,service='service-secret')=>fetch(base+'/lumo/runtime/session',{method:'POST',headers:{authorization:`Bearer ${service}`,'content-type':'application/json',cookie:'lumo_auth_session=attacker','x-lumo-user':'attacker','x-lumo-realm':'foreign'},body:JSON.stringify(body)})
    expect((await call(request,'wrong')).status).toBe(401);expect(session).not.toHaveBeenCalled()
    expect((await call({...request,destination:{...request.destination,process_id:'stale'}})).status).toBe(503);expect(session).not.toHaveBeenCalled()
    expect((await call(request)).status).toBe(200)
    expect(execute.mock.calls[0]![0]).toEqual(alice)
    expect(execute.mock.calls[0]![2]).toEqual({sessionId:'owned'})
    expect(session.mock.calls.every(([token])=>token==='valid-login')).toBe(true)
    expect((await call({...request,credential:'revoked'})).status).toBe(401)
    expect(execute).toHaveBeenCalledOnce()
    session.mockRejectedValueOnce(new Error('governance unavailable valid-login'))
    expect((await call(request)).status).toBe(503)
    expect(execute).toHaveBeenCalledOnce()
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('valid-login')
  })
})

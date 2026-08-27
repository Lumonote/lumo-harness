import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'

import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import type { ResolvedSubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { SeamError } from '../../../shared/seam-contracts/errors.ts'
import { assertStartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'
import type { ChildResultBody, StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'
import { assembleRemote } from '../src/provider.ts'
import type { RemoteConfig, RemoteSubagentProvider } from '../src/provider.ts'

/**
 * 三 mock server 全真 HTTP(不 mock fetch):
 * fake scheduler(放置/终态)、fake host(start/stop,承载侧 wire 真校验)、
 * provider 自带的进程内回调 server(回调 server 也经真端口 POST)。
 * parent Agent 用 dsh service.spec 同款轻量假件(provider 只读 4 个字段)。
 */

interface RecordedCall {
  headers: IncomingMessage['headers']
  body: Record<string, unknown>
}

interface Harness {
  provider: RemoteSubagentProvider
  sched: Server
  schedCalls: { placements: RecordedCall[]; results: RecordedCall[] }
  host: Server
  hostCalls: { starts: RecordedCall[]; stops: RecordedCall[] }
  assembly: ReturnType<typeof assembleRemote>
  close(): Promise<void>
}

interface SetupOptions {
  /** 放置应答;缺省 201 { node_id: 'N1' }。 */
  schedule?: () => { status: number; body: Record<string, unknown> }
  /** 承载节点期望的令牌;缺省 't0k'。置于预期之外(hostTokens 覆写)即 403 场景。 */
  hostExpects?: string
  /** provider 的 hostTokens 表;缺省 { N1: 't0k' }。 */
  nodeTokens?: Record<string, string>
}

const all: Array<{ close(): Promise<void> }> = []
afterEach(async () => {
  for (const h of all.splice(0)) {
    await h.close()
  }
})

async function setup(opts: SetupOptions = {}): Promise<Harness> {
  const schedCalls = { placements: [] as RecordedCall[], results: [] as RecordedCall[] }
  const hostCalls = { starts: [] as RecordedCall[], stops: [] as RecordedCall[] }
  const hostExpects = opts.hostExpects ?? 't0k'

  const sched = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://scheduler.invalid')
      if (req.method === 'POST' && url.pathname === '/v1/placements') {
        const body = await readJson(req)
        schedCalls.placements.push({ headers: req.headers, body })
        const reply = opts.schedule?.() ?? { status: 201, body: { node_id: 'N1' } }
        json(res, reply.status, reply.body)
        return
      }
      if (req.method === 'POST' && /^\/v1\/tasks\/[^/]+\/result$/.test(url.pathname)) {
        const body = await readJson(req)
        schedCalls.results.push({ headers: req.headers, body })
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: 'not-found', message: '未知路由' })
    })().catch(() => {
      /* 测试基础设施的兜底;断言自会失败 */
    })
  })
  await listen(sched, 0)

  const host = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://host.invalid')
      if (req.method === 'POST' && (url.pathname === '/subagent/start' || url.pathname === '/subagent/stop')) {
        const body = await readJson(req)
        // 计数先行(含被拒请求 —— 用例 2/3 按「fetch 是否达 host」断言)
        if (url.pathname === '/subagent/start') {
          hostCalls.starts.push({ headers: req.headers, body })
        } else {
          hostCalls.stops.push({ headers: req.headers, body })
        }
        const realm = header(req, 'x-lumo-realm')
        const token = header(req, 'x-lumo-seam-token')
        if (realm !== 'dev' || token !== hostExpects) {
          json(res, 403, { ok: false, code: 'forbidden', message: `realm ${realm} 的 seam 令牌校验失败` })
          return
        }
        if (url.pathname === '/subagent/start') {
          json(res, 200, { ok: true, childId: body.childId })
        } else {
          json(res, 200, { ok: true })
        }
        return
      }
      json(res, 404, { ok: false, code: 'invalid', message: '未知路由' })
    })().catch(() => {
      /* 同上 */
    })
  })
  await listen(host, 0)

  const config: RemoteConfig = {
    schedulerUrl: baseOf(sched),
    nodeUrls: { N1: baseOf(host) },
    hostTokens: opts.nodeTokens ?? { N1: 't0k' },
    realm: 'dev',
    callbackPort: await freePort(),
    callbackHost: '127.0.0.1',
  }
  const assembly = assembleRemote(config)
  await listen(assembly.server, config.callbackPort)
  const provider = assembly.provider

  const h: Harness = {
    provider,
    sched,
    schedCalls,
    host,
    hostCalls,
    assembly,
    async close() {
      await closeServer(assembly.server)
      await closeServer(host)
      await closeServer(sched)
    },
  }
  all.push(h)
  return h
}

/** 从 recorded StartChildRequest 取回调 URL(真 host 行为:deliverCallback 原样 POST)。 */
function callbackUrlOf(h: Harness): string {
  const start = h.hostCalls.starts[0]!
  return (start.body as StartChildRequest).callbackUrl
}

/** 向 provider 的回调 server POST 一枚 ChildResultBody(承载侧 deliverCallback 同款)。 */
async function postCallback(h: Harness, body: ChildResultBody, url = callbackUrlOf(h)): Promise<number> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return res.status
}

/** 150ms 内未结集视为 pending(「run 不 resolve」语义断言共用)。 */
function settleVerdict(result: Promise<unknown>): Promise<string> {
  return Promise.race([
    result.then(() => 'resolved', () => 'rejected'),
    new Promise<string>((resolve) => setTimeout(() => resolve('pending'), 150)),
  ])
}

function waitFor<T>(read: () => T | undefined, label: string, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const tick = () => {
      const value = read()
      if (value !== undefined) return resolve(value)
      if (Date.now() > deadline) return reject(new Error(`等待超时: ${label}`))
      setTimeout(tick, 10)
    }
    tick()
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = createNetServer()
    net.listen(0, '127.0.0.1', () => {
      const { port } = net.address() as AddressInfo
      net.close((err) => (err ? reject(err) : resolve(port)))
    })
    net.on('error', reject)
  })
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
}

function closeServer(server: Server): Promise<void> {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(() => resolve()))
}

function baseOf(server: Server): string {
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name]
  const value = Array.isArray(raw) ? raw[0] : raw
  return value && value.length > 0 ? value : undefined
}

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
      } catch (e) {
        reject(e)
      }
    })
    req.on('error', reject)
  })
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

/** dsh service.spec 同款轻量假 parent:只长 provider 读到的字段(session.header/options/ctx)。 */
function fakeParent(): Agent {
  return {
    id: SessionId('parent-sess'),
    options: { provider: 'mock', model: 'mock', maxTokens: 4096, subagentDepth: 2 },
    session: {
      header: { id: SessionId('parent-sess'), cwd: '/tmp', delegationDepth: 2 },
      events: [],
    },
    ctx: new Context(),
  } as unknown as Agent
}

function startRequest(): ResolvedSubagentStartRequest {
  return {
    label: 'child task',
    prompt: [{ type: 'text', text: 'child 任务' }],
    parent: fakeParent(),
    signal: new AbortController().signal,
    descriptor: { version: 2, mode: 'one-shot', provider: 'lumo-remote', label: 'child task' },
  }
}

describe('subagent-remote —— 父侧跨节点 provider', () => {
  it('happy path:place 201 → host start 200 → 回执结集;父描述真实采集;终态上报 scheduler', async () => {
    const h = await setup()
    const run = await h.provider.start(startRequest())

    // 放置:task_id = 父侧 mint 的 childId,realm 头在
    const placed = h.schedCalls.placements[0]!
    expect(placed.headers['x-lumo-realm']).toBe('dev')
    expect(placed.body).toEqual({ task_id: String(run.id), cluster_id: '', requires: [], priority: 0 })

    // 承载 start:StartChildRequest 契约校验过,父描述是父侧本地真实采集
    const startCall = h.hostCalls.starts[0]!
    assertStartChildRequest(startCall.body)
    const req = startCall.body as StartChildRequest
    expect(startCall.headers['x-lumo-realm']).toBe('dev')
    expect(startCall.headers['x-lumo-seam-token']).toBe('t0k')
    expect(req.childId).toBe(String(run.id))
    expect(req.realm).toBe('dev')
    expect(req.label).toBe('child task')
    expect(req.parent).toEqual({
      sessionId: 'parent-sess',
      cwd: '/tmp',
      delegationDepth: 2,
      provider: 'mock',
      model: 'mock',
      maxTokens: 4096,
    })
    expect(req.prompt).toEqual([{ type: 'text', text: 'child 任务' }])
    expect(req.descriptor).toEqual({ version: 2, mode: 'one-shot', provider: 'lumo-remote', label: 'child task' })
    // callbackUrl 带 per-run secret 能力段(评审 Important:回调面最小鉴权;
    // host 原样 POST,secret 不重写不剥离)
    const cb = new URL(req.callbackUrl)
    expect(cb.origin).toBe(`http://127.0.0.1:${(h.assembly.server.address() as AddressInfo).port}`)
    expect(cb.pathname.split('/').filter(Boolean)).toEqual([
      'subagent',
      'result',
      String(run.id),
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    ])

    // 句柄:远端 run,localAgent undefined
    expect(run.localAgent).toBeUndefined()

    // 回执(模拟承载侧 deliverCallback) → result 结集
    const status = await postCallback(h, {
      runId: String(run.id),
      ok: true,
      output: [{ type: 'text', text: 'child 答复' }],
      stopReason: 'completed',
    })
    expect(status).toBe(200)
    const result = await run.result
    expect(result).toEqual({ output: [{ type: 'text', text: 'child 答复' }], stopReason: 'completed' })

    // 终态上报(scheduler /v1/tasks/{childId}/result)best-effort 必达
    const report = await waitFor(() => h.schedCalls.results[0], 'scheduler 终态上报')
    expect(report.headers['x-lumo-realm']).toBe('dev')
    expect(report.body).toEqual({ state: 'COMPLETED' })
  })

  it('排队 202:start 拒绝 REMOTE_PLACEMENT_QUEUED,host 未被请求', async () => {
    const h = await setup({ schedule: () => ({ status: 202, body: { task_id: 'x', state: 'PENDING' } }) })
    const error = await h.provider.start(startRequest()).then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(SubagentError)
    expect((error as SubagentError).code).toBe('REMOTE_PLACEMENT_QUEUED')
    expect(h.hostCalls.starts).toHaveLength(0)
    expect(h.schedCalls.placements).toHaveLength(1)
  })

  it('令牌错 host 403:reject SeamError,code 透传 forbidden', async () => {
    const h = await setup({ nodeTokens: { N1: 'wrong' } })
    const error = await h.provider.start(startRequest()).then(() => undefined, (e: unknown) => e)
    expect(error).toBeInstanceOf(SeamError)
    expect((error as SeamError).code).toBe('forbidden')
    expect(h.schedCalls.placements).toHaveLength(1)
    expect(h.hostCalls.starts).toHaveLength(1)
  })

  it('dispose → host stop 收到;dispose 幂等(两次调用只一次 fetch);回调 aborted 结集', async () => {
    const h = await setup()
    const run = await h.provider.start(startRequest())
    await run.dispose()
    await run.dispose()
    expect(h.hostCalls.stops).toHaveLength(1)
    expect(h.hostCalls.stops[0]!.body).toEqual({ childId: String(run.id) })

    const status = await postCallback(h, { runId: String(run.id), ok: true, output: [], stopReason: 'aborted' })
    expect(status).toBe(200)
    expect((await run.result).stopReason).toBe('aborted')
  })

  it('伪造 secret:回执 → 404 且 run 不 resolve;注册条目不销毁,真回调照常结集', async () => {
    const h = await setup()
    const run = await h.provider.start(startRequest())
    const forged = new URL(callbackUrlOf(h))
    forged.pathname = forged.pathname.replace(/\/[^/]+$/, '') + '/wrong-secret'
    const status = await postCallback(h, { runId: String(run.id), ok: true, output: [], stopReason: 'completed' }, forged.toString())
    expect(status).toBe(404)
    expect(await settleVerdict(run.result)).toBe('pending')
    // 伪造请求被拒后条目必须仍在(错 secret 不摘表,否则攻击者可 DoS 挂起中的 run)
    const ok = await postCallback(h, { runId: String(run.id), ok: true, output: [{ type: 'text', text: '真回执' }], stopReason: 'completed' })
    expect(ok).toBe(200)
    expect(await run.result).toEqual({ output: [{ type: 'text', text: '真回执' }], stopReason: 'completed' })
  })

  it('plain /subagent/result/{runId} 无 secret 段 → 404,run 不 resolve', async () => {
    const h = await setup()
    const run = await h.provider.start(startRequest())
    const port = (h.assembly.server.address() as AddressInfo).port
    const status = await postCallback(h,
      { runId: String(run.id), ok: true, output: [], stopReason: 'completed' },
      `http://127.0.0.1:${port}/subagent/result/${String(run.id)}`)
    expect(status).toBe(404)
    expect(await settleVerdict(run.result)).toBe('pending')
  })

  it('回执体 runId 未注册 → 404,已注册 run 不被 resolve', async () => {
    const h = await setup()
    const run = await h.provider.start(startRequest())
    const port = (h.assembly.server.address() as AddressInfo).port
    const status = await postCallback(h,
      { runId: 'never-minted', ok: true, output: [], stopReason: 'completed' },
      `http://127.0.0.1:${port}/subagent/result/never-minted/fake-secret`)
    expect(status).toBe(404)
    expect(await settleVerdict(run.result)).toBe('pending')
  })
})

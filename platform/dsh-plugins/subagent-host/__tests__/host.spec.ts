import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import type { AddressInfo } from 'node:net'

import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { LlmAdapter, type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { assertChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'
import type { ChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'
import { createSubagentHost, type SubagentHostOptions } from '../src/server.ts'
import { runChild, type RunRegistry } from '../src/run.ts'

/**
 * 10 行最小 mock:流式指定义本后 finish(等价 dsh MockAdapter 的 textResponse 效果,
 * 零 dsh 内部 import —— 只使用 dsh 公开的 StreamChunk 词表)。
 */
function textOnlyAdapter(text: string): LlmAdapter {
  return new (class extends LlmAdapter {
    override async *stream(): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
}

/** 流出文本后挂在第一个块上,直到请求被 abort —— 用例 3 需要 cancel 时 child 尚在运行。 */
function hangingTextAdapter(text: string): LlmAdapter {
  return new (class extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      yield { type: 'text-delta', index: 0, text }
      if (options.signal?.aborted) throw new Error('adapter aborted')
      await new Promise<void>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(new Error('adapter aborted')), { once: true })
      })
    }
  })()
}

interface Harness {
  ctx: Context
  server: Server
  baseUrl: string
  callback: Server
  callbackBodies: ChildResultBody[]
  runs: RunRegistry
  post(path: string, payload: unknown, headers?: Record<string, string>): Promise<Reply>
  callbackUrlOf(): Promise<string>
}

interface Reply {
  status: number
  body: Record<string, unknown>
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) {
    await h.ctx.fiber.dispose()
    await new Promise<void>((resolve) => h.callback.close(() => resolve()))
    await new Promise<void>((resolve) => h.server.close(() => resolve()))
  }
})

/** 一个当前空闲的端口(先取得再释放 —— 测试期间不应被别的东西占用)。 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const net = createNetServer()
    net.listen(0, '127.0.0.1', () => {
      const { port } = net.address() as AddressInfo
      net.close((err) => err ? reject(err) : resolve(port))
    })
    net.on('error', reject)
  })
}

async function setup(adapter: LlmAdapter): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)

  const callbackBodies: ChildResultBody[] = []
  const callback = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      // 回执契约校验:承载侧寄出的每一枚回执都必须是合法 ChildResultBody
      assertChildResultBody(body)
      callbackBodies.push(body as ChildResultBody)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })
  })
  await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve))
  const callbackPort = (callback.address() as AddressInfo).port

  const runs: RunRegistry = new Map()
  const server = createSubagentHost({
    host: '127.0.0.1',
    port: 0,
    maxBodyBytes: 1 << 20,
    tokens: new Map([['dev', 't0k']]),
    runs,
    // 与 index.ts 同款接线:已发布会话 = 已结集(或他处占用的幂等键)→ 重放闸
    sessionExists: (childId) => ctx.agents.get(SessionId(childId)) !== undefined,
    start: (req) => {
      void runChild(ctx, req, runs).catch((e: unknown) => {
        ctx.logger.error('subagent-host: 子代理运行失败: %s', e)
      })
    },
    logger: { info() {}, warn() {}, error() {} },
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const httpPort = (server.address() as AddressInfo).port

  const h: Harness = {
    ctx,
    server,
    baseUrl: `http://127.0.0.1:${httpPort}`,
    callbackBodies,
    callback,
    runs,
    callbackUrlOf: () => `http://127.0.0.1:${callbackPort}/result`,
    post: async (path, payload, headers = {}) => {
      const res = await fetch(`${h.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-lumo-realm': 'dev',
          'x-lumo-seam-token': 't0k',
          ...headers,
        },
        body: JSON.stringify(payload),
      })
      return { status: res.status, body: await res.json() as Record<string, unknown> }
    },
  }
  harnesses.push(h)
  return h
}

function startRequest(h: Harness, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    childId: 'child-1',
    realm: 'dev',
    label: 'child task',
    prompt: [{ type: 'text', text: 'child 任务' }],
    descriptor: { version: 2, mode: 'one-shot', provider: 'spawn', label: 'child task' },
    parent: {
      sessionId: 'parent-sess',
      cwd: '/tmp',
      delegationDepth: 0,
      provider: 'mock',
      model: 'mock',
    },
    callbackUrl: h.callbackUrlOf(),
    ...overrides,
  }
}

async function waitCallback(h: Harness, count: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (h.callbackBodies.length < count) {
    if (Date.now() > deadline) throw new Error(`回调未到达（第 ${count} 枚）`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

async function waitChild(h: Harness, childId: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (!h.ctx.agents.get(SessionId(childId))) {
    if (Date.now() > deadline) throw new Error(`child ${childId} 未被发布`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('subagent-host —— 承载节点子代理面', () => {
  it('身份与契约:缺/错令牌 403,坏 JSON 400,realm 载荷越身份 403', async () => {
    const h = await setup(textOnlyAdapter('child 答复'))

    const noToken = await h.post('/subagent/start', startRequest(h), {
      'x-lumo-realm': 'dev',
      'x-lumo-seam-token': '',
    })
    expect(noToken.status).toBe(403)
    expect(noToken.body).toMatchObject({ ok: false, code: 'forbidden' })

    const wrongToken = await h.post('/subagent/start', startRequest(h), {
      'x-lumo-realm': 'dev',
      'x-lumo-seam-token': 'wrong',
    })
    expect(wrongToken.status).toBe(403)
    expect(wrongToken.body).toMatchObject({ ok: false, code: 'forbidden' })

    const badJson = await fetch(`${h.baseUrl}/subagent/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lumo-realm': 'dev', 'x-lumo-seam-token': 't0k' },
      body: '{ "oops"',
    })
    expect(badJson.status).toBe(400)
    expect(await badJson.json()).toMatchObject({ ok: false, code: 'invalid' })

    // 载荷 realm 与令牌 realm 不符:身份不越载荷(gate 先例)
    const realmMismatch = await h.post('/subagent/start', startRequest(h, { realm: 'other' }))
    expect(realmMismatch.status).toBe(403)
    expect(realmMismatch.body).toMatchObject({ ok: false, code: 'forbidden' })

    // 全程没有任何 child 被启动
    expect(h.runs.size).toBe(0)
    expect(h.ctx.agents.get(SessionId('child-1'))).toBeUndefined()
  })

  it('承载驱动:start → 200,child 用公开件创建驱动,回执结集,meta/描述可断言', async () => {
    const h = await setup(textOnlyAdapter('child 答复'))
    const reply = await h.post('/subagent/start', startRequest(h))
    expect(reply.status).toBe(200)
    expect(reply.body).toEqual({ ok: true, childId: 'child-1' })

    await waitCallback(h, 1)
    const result = h.callbackBodies[0]!
    expect(result).toMatchObject({ runId: 'child-1', ok: true, stopReason: 'completed' })
    expect(result.output).toEqual([{ type: 'text', text: 'child 答复' }])

    const child = h.ctx.agents.get(SessionId('child-1'))
    expect(child).toBeTruthy()
    const header = child!.session.header
    expect(header.cwd).toBe('/tmp')
    expect(header.parentSession).toBe(SessionId('parent-sess'))
    expect(header.origin).toBe('subagent')
    expect(header.delegationDepth).toBe(1)
    expect(child!.session.events.some((event) => event.type === 'subagent/descriptor')).toBe(true)
    // 运行表结集:完成即从表上摘除
    expect(h.runs.size).toBe(0)
  })

  it('已结集重放拒绝:同 childId 二次 start → 400 invalid,新 childId 不受误伤', async () => {
    const h = await setup(textOnlyAdapter('child 答复'))
    const first = await h.post('/subagent/start', startRequest(h))
    expect(first.status).toBe(200)
    await waitCallback(h, 1)
    expect(h.callbackBodies[0]).toMatchObject({ runId: 'child-1', ok: true, stopReason: 'completed' })

    // 已结集:运行表条目已摘,final 后 child 仍发布在 ctx.agents —— 再 start 必须
    // 显式 invalid(此前 200 放行 → create 撞注册冲突 → 父侧永远等不到回执)
    const replay = await h.post('/subagent/start', startRequest(h))
    expect(replay.status).toBe(400)
    expect(replay.body).toMatchObject({ ok: false, code: 'invalid' })
    expect(String(replay.body.message)).toContain('child-1')

    // 新 childId:同一承载侧继续可用,没被重放检查误伤
    const fresh = await h.post('/subagent/start', startRequest(h, { childId: 'child-2' }))
    expect(fresh.status).toBe(200)
    await waitCallback(h, 2)
    expect(h.callbackBodies[1]).toMatchObject({ runId: 'child-2', ok: true, stopReason: 'completed' })
  })

  it('stop:即刻取消 → 回调 aborted;重复 stop 仍 200 且不产生第二次回调', async () => {
    const h = await setup(hangingTextAdapter('child 部分答复'))
    const reply = await h.post('/subagent/start', startRequest(h))
    expect(reply.status).toBe(200)

    // 本用例的 stop 落在发布后相位(waitChild 后);发布前窗口在毫秒级且为 no-op
    // 设计,不做时序脆弱的复现测试(行 6 接管取消)。
    await waitChild(h, 'child-1')
    const stopped = await h.post('/subagent/stop', { childId: 'child-1' })
    expect(stopped.status).toBe(200)
    expect(stopped.body).toEqual({ ok: true })

    await waitCallback(h, 1)
    expect(h.callbackBodies[0]).toMatchObject({ runId: 'child-1', ok: true, stopReason: 'aborted' })

    // 幂等:未知/已结集 run 的 stop 仍是 200 no-op
    const again = await h.post('/subagent/stop', { childId: 'child-1' })
    expect(again.status).toBe(200)
    expect(again.body).toEqual({ ok: true })
    const unknown = await h.post('/subagent/stop', { childId: 'never-existed' })
    expect(unknown.status).toBe(200)
    expect(unknown.body).toEqual({ ok: true })

    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(h.callbackBodies.length).toBe(1)
    expect(h.runs.size).toBe(0)
  })

  it('回执网络失败:两次尝试后放弃,child 只运行一次,host 保持健康', async () => {
    const h = await setup(textOnlyAdapter('child 答复'))
    const deadPort = await freePort()
    const reply = await h.post('/subagent/start', startRequest(h, {
      callbackUrl: `http://127.0.0.1:${deadPort}/result`,
    }))
    expect(reply.status).toBe(200)

    // child 正常单 turn 结集(不重投 —— 事件流只留一次)
    const deadline = Date.now() + 5000
    const child = () => h.ctx.agents.get(SessionId('child-1'))
    while (!child()?.session.events.some((event) => event.type === 'turn/end')) {
      if (Date.now() > deadline) throw new Error('child 未结集')
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect(child()!.session.events.filter((event) => event.type === 'assistant/message').length).toBe(1)
    expect(h.callbackBodies.length).toBe(0)

    // host 依然可用:第二个 child 用活回调正常走完
    const second = await h.post('/subagent/start', startRequest(h, { childId: 'child-2' }))
    expect(second.status).toBe(200)
    await waitCallback(h, 1)
    expect(h.callbackBodies[0]).toMatchObject({ runId: 'child-2', ok: true, stopReason: 'completed' })
  })
})

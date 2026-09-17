/**
 * Slice B(行 4)· 单截面验证切片:`ctx.sessionTitle` 的辅助 LLM 调用经网关路由。
 *
 * 机制事实(dsh 真件,title 零改动):title providers 注入 ['sessionTitle','llm','sessions']
 * —— 辅助标题调用与主循环共用同一个 ctx.llm runtime。把 first-prompt provider 的可选
 * Config 路由覆盖(provider/model 必须成对)指向网关入口('lumo-gateway'/'gw-model')后,
 * 辅助调用走 RecordingAdapter,主循环走同 runtime 上的独立 'mock' adapter —— 两路路由
 * 不同、截面同一。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionTitleService from '@deepseek-ai/dsh-session-title'
import * as titleProviderPlugin from '@deepseek-ai/dsh-session-title-first-prompt-llm'

/** 单次 generate 的入参指纹(至少 provider/model/messages 尺寸)。 */
interface RecordedCall {
  provider: string
  model: string
  purpose?: 'compaction' | 'session-title'
  messageCount: number
  hasSystem: boolean
  sessionId?: string
}

/** 记录型假网关 adapter:捕获每次 stream 入参,回固定文本 finish(等价 MockAdapter.textResponse 效果)。 */
function recordingAdapter(reply: string, calls: RecordedCall[]): LlmAdapter {
  return new (class extends LlmAdapter {
    override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      calls.push({
        provider: options.provider,
        model: options.model,
        ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
        messageCount: options.messages.length,
        hasSystem: typeof options.system === 'string' && options.system.length > 0,
        ...(options.sessionId === undefined ? {} : { sessionId: String(options.sessionId) }),
      })
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  })()
}

/** session-title 服务包必填 Config(无库默认)。 */
const TITLE_CONFIG = { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 } as const

/** first-prompt provider 包 Config:五个必填策略字段 + 网关路由覆盖(必须成对)。 */
const GATEWAY_CONFIG = {
  targetWords: 5,
  targetCjkCharacters: 10,
  maxInputBytes: 4_000,
  maxOutputTokens: 64,
  timeoutMs: 5_000,
  provider: 'lumo-gateway',
  model: 'gw-model',
} as const

interface Harness {
  ctx: Context
  mainCalls: RecordedCall[]
  gatewayCalls: RecordedCall[]
}

const harnesses: Harness[] = []
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.ctx.fiber.dispose()
})

async function setup(): Promise<Harness> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  const mainCalls: RecordedCall[] = []
  const gatewayCalls: RecordedCall[] = []
  // 两路 adapter 注册在 testkit 挂起的同一个 LlmRuntime 上 —— 这就是「同一截面」的装配事实。
  ctx.llm.registerAdapter(['mock'], recordingAdapter('parent 主答复文本', mainCalls))
  ctx.llm.registerAdapter(['lumo-gateway'], recordingAdapter('GW 网关标题文本', gatewayCalls))
  await ctx.plugin(SessionTitleService, TITLE_CONFIG)
  // 函数插件(provider 包)整体作为插件挂载:name/inject(['sessionTitle','llm','sessions'])/Config/apply。
  await ctx.plugin(titleProviderPlugin, GATEWAY_CONFIG)
  const h: Harness = { ctx, mainCalls, gatewayCalls }
  harnesses.push(h)
  return h
}

/** ≤5s 轮询等待探针命中(标题生成在 whenIdle 之后仍异步推进)。 */
async function waitFor<T>(probe: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + 5000
  for (;;) {
    const value = probe()
    if (value !== undefined) return value
    if (Date.now() > deadline) throw new Error(`等待超时:${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** 日志窄化取数:title 路由预派发记录 / 最新一条 session/title。
 *  同步事件读取于上游 `2026-09-09-deprecate-synchronous-session-event-reads` 从
 *  `session.events` 属性改成 `snapshotEvents()` 等方法；该 Agent Note 允许**测试文件**
 *  调用它们来检查已发出的事件。 */
function titleEventsOf(session: { snapshotEvents(): readonly { type: string; data?: unknown }[] }): {
  llmRequest?: { route: { provider: string; model: string }; titleProvider: unknown }
  latestTitle?: {
    source?: { kind?: string; provider?: string; model?: { provider?: string; model?: string } }
    title?: string
    messageSeqs?: number[]
  }
} {
  let latestTitle: ReturnType<typeof titleEventsOf>['latestTitle']
  let llmRequest: ReturnType<typeof titleEventsOf>['llmRequest']
  for (const event of session.snapshotEvents()) {
    if (event.type === 'session/title-llm-request') llmRequest = event.data as NonNullable<typeof llmRequest>
    if (event.type === 'session/title') latestTitle = event.data as NonNullable<typeof latestTitle>
  }
  return { llmRequest, latestTitle }
}

describe('session-title 经网关路由 · 与主循环同一 ctx.llm 截面(行 4)', () => {
  it('一轮真实 parent turn 后,辅助标题流量走 lumo-gateway 路由,主循环走 mock,两路出同一 runtime', async () => {
    const h = await setup()

    // 触发:真实 parent(followup 一轮 user turn,whenIdle);first-prompt 节奏自动调度标题生成,
    // 它在 turn 结集后仍异步推进,故 whenIdle 之外还要轮询等日志证据。
    // `agentLoop.create` 在上游改为异步（`Promise<Agent>`，见 agent-loop 的
    // `lib/types/index.d.ts`），漏 await 时拿到的是 Promise，下一行即
    // `parent.followup is not a function`。
    const parent = await h.ctx.agentLoop.create(
      SessionId('parent-gw'),
      { provider: 'mock', model: 'mock-model', maxTokens: 4096 },
      { cwd: process.cwd() },
    )
    parent.followup(createUserMessage({
      content: [{ type: 'text', text: '帮我把这个会话起个贴切的中文标题' }],
      source: { kind: 'user' },
    }))
    await parent.whenIdle()

    await waitFor(() => {
      const { llmRequest, latestTitle } = titleEventsOf(parent.session)
      return llmRequest !== undefined && latestTitle?.source?.kind === 'provider'
        ? { llmRequest, latestTitle }
        : undefined
    }, 'session/title-llm-request + provider 来源的 session/title 未出现')

    // 断言①:RecordingAdapter 被调 ≥1 次 —— 标题流量确走了网关路由。
    expect(h.gatewayCalls.length).toBeGreaterThanOrEqual(1)

    // 断言②:预派发事件的路由即 Config 成对覆盖(provider/model)。
    const { llmRequest } = titleEventsOf(parent.session)
    expect(llmRequest).toMatchObject({ route: { provider: 'lumo-gateway', model: 'gw-model' } })
    expect(typeof llmRequest!.titleProvider).toBe('string')

    // 断言③:最新 session/title 由 provider 写入,provenance(provider/model)与路由一致,
    // messageSeqs 指到唯一人类消息,folded 标题非空。
    const { latestTitle } = titleEventsOf(parent.session)
    expect(latestTitle).toMatchObject({
      source: {
        kind: 'provider',
        model: { provider: 'lumo-gateway', model: 'gw-model' },
      },
    })
    expect(typeof latestTitle!.title).toBe('string')
    expect(latestTitle!.title!.length).toBeGreaterThan(0)
    const userMessageSeqs = parent.session.snapshotEvents()
      .filter((event) => event.type === 'user/message')
      .map((event) => event.seq) // seq 在事件信封上(append-only 日志的唯一序号),不在 data 里
    expect(latestTitle!.messageSeqs).toEqual(userMessageSeqs)

    // 断言④:主循环 N 次、title M 次 —— 两路从同一 runtime 出,目的域互不串线。
    expect(h.mainCalls.length).toBeGreaterThanOrEqual(1)
    for (const call of h.mainCalls) {
      expect(call.purpose).toBeUndefined() // 主循环请求不带 purpose
      expect(call.provider).toBe('mock')
      expect(call.sessionId).toBe('parent-gw')
    }
    for (const call of h.gatewayCalls) {
      expect(call.purpose).toBe('session-title')
      expect(call.provider).toBe('lumo-gateway')
      expect(call.model).toBe('gw-model')
      expect(call.messageCount).toBe(1) // aux 请求只带框进 JSON 的一条 user 消息
      expect(call.hasSystem).toBe(true) // aux 请求带共享 system 指令
      expect(call.sessionId).toBe('parent-gw')
    }
    expect(h.gatewayCalls[0]!.sessionId).toBe(h.mainCalls[0]!.sessionId)
  }, 20_000)
})

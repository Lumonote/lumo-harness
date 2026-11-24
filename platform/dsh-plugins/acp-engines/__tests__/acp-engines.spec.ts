import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

import { JsonRpcConnection, LineDecoder, memoryTransportPair, type MessageTransport } from '../src/jsonrpc.ts'
import { ACP_METHODS } from '../src/acp-protocol.ts'
import { bridgeCodexToAcp, CODEX_METHODS } from '../src/codex-bridge.ts'
import { EngineHost, type SessionEvent } from '../src/engine-host.ts'
import { SessionAskBroker, askFromPermission } from '../src/permission-asks.ts'
import { EngineRegistry, engineEnv, findExecutable, BUILTIN_ENGINES } from '../src/registry.ts'
import { AcpRunTreeRecorder } from '../src/run-tree-link.ts'
import { acpEnginesEnabled, createAcpEngines } from '../src/embed.ts'
import { applyRunTreeEvent, emptyRunTree, type RunTreeEvent, type RunTreeState } from '../../../shared/seam-contracts/run-tree.ts'

const tick = () => new Promise(r => setTimeout(r, 5))
async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) { if (Date.now() > end) throw new Error('timeout'); await tick() }
}

class TreeSink { state: RunTreeState = emptyRunTree(); events: RunTreeEvent[] = []; apply(e: RunTreeEvent) { this.events.push(e); this.state = applyRunTreeEvent(this.state, e) } }

/** 假 ACP agent：一轮里发文本 → 工具调用 → 请求权限 → 工具完成 → end_turn */
function fakeAcpAgent(): MessageTransport {
  const [client, agent] = memoryTransportPair()
  const rpc = new JsonRpcConnection(agent, 0)
  let cancelled = false
  rpc.onRequest(ACP_METHODS.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: true } }, agentInfo: { name: 'fake', version: '9.9' } }))
  rpc.onRequest(ACP_METHODS.sessionNew, () => ({ sessionId: 'eng-1' }))
  rpc.onNotification(ACP_METHODS.sessionCancel, () => { cancelled = true })
  rpc.onRequest(ACP_METHODS.sessionPrompt, async (params) => {
    const sessionId = (params as { sessionId: string }).sessionId
    const up = (update: unknown) => rpc.notify(ACP_METHODS.sessionUpdate, { sessionId, update })
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hel' } })
    up({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'lo' } })
    up({ sessionUpdate: 'tool_call', toolCallId: 't1', title: 'rm -rf build', kind: 'execute', status: 'pending' })
    const answer = await rpc.request<{ outcome: { outcome: string; optionId?: string } }>(ACP_METHODS.requestPermission, {
      sessionId, toolCall: { toolCallId: 't1', title: 'rm -rf build', kind: 'execute', rawInput: { command: 'rm -rf build' } },
      options: [{ optionId: 'ok', name: '允许', kind: 'allow_once' }, { optionId: 'no', name: '拒绝', kind: 'reject_once' }],
    }, 0)
    if (cancelled || answer.outcome.outcome === 'cancelled') return { stopReason: 'cancelled' }
    up({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: answer.outcome.optionId === 'ok' ? 'completed' : 'failed' })
    return { stopReason: 'end_turn' }
  })
  return client
}

function host(connect: () => MessageTransport, sink?: TreeSink) {
  const asks = new SessionAskBroker(0)
  const registry = new EngineRegistry([{ id: 'fake', label: 'Fake', protocol: 'acp', provider: 'fake', commands: [{ bin: '/bin/sh', args: [] }] }], new Set(), { isExecutable: () => true })
  return { asks, host: new EngineHost({ registry, asks, ...(sink ? { runTree: sink } : {}), connect }) }
}

describe('jsonrpc', () => {
  it('配对请求响应、未知方法回 -32601、关闭时拒绝挂起请求', async () => {
    const [a, b] = memoryTransportPair()
    const ca = new JsonRpcConnection(a); const cb = new JsonRpcConnection(b)
    cb.onRequest('echo', p => p)
    await expect(ca.request('echo', { x: 1 })).resolves.toEqual({ x: 1 })
    await expect(ca.request('nope')).rejects.toMatchObject({ code: -32601 })
    const pending = ca.request('never', undefined, 0)
    cb.onRequest('never', () => new Promise(() => undefined))
    ca.close()
    await expect(pending).rejects.toThrow(/连接已关闭/u)
  })
  it('LineDecoder 处理半包与 CRLF', () => {
    const lines: string[] = []
    const d = new LineDecoder(l => lines.push(l))
    d.push('{"a":1}\r\n{"b"'); d.push(':2}\n\n')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
  })
})

describe('registry', () => {
  it('distinguishes the WorkBuddy app bundle from standalone CodeBuddy and TRAE', () => {
    const cli = '/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli'
    const executables = new Set(['/opt/homebrew/bin/codebuddy', '/opt/homebrew/bin/traecli', `${cli}/bin/codebuddy`])
    const files = new Set<string>()
    const registry = new EngineRegistry(BUILTIN_ENGINES, new Set(), { isExecutable: path => executables.has(path), isFile: path => files.has(path) })
    expect(registry.resolve('codebuddy')).toMatchObject({ bin: '/opt/homebrew/bin/codebuddy', args: ['--acp'] })
    expect(registry.resolve('trae')).toMatchObject({ bin: '/opt/homebrew/bin/traecli', args: ['--acp'] })
    expect(registry.resolve('workbuddy')).toHaveProperty('error')
    files.add(`${cli}/dist/codebuddy-lite-wb.mjs`)
    expect(registry.resolve('workbuddy')).toMatchObject({ bin: `${cli}/bin/codebuddy`, args: ['--acp'] })
    expect(registry.probeStatic().find(engine => engine.id === 'workbuddy')).not.toHaveProperty('capabilities')
  })
  it('按候选顺序解析、禁用与未知引擎报错', () => {
    const r = new EngineRegistry(BUILTIN_ENGINES, new Set(['gemini']), { isExecutable: f => f === '/opt/homebrew/bin/npx', pathEnv: '', home: '/nonexistent' })
    const claude = r.resolve('claude-code')
    expect('error' in claude ? claude.error : claude.args).toEqual(['-y', '@zed-industries/claude-code-acp'])
    expect(r.resolve('gemini')).toMatchObject({ error: expect.stringContaining('禁用') })
    expect(r.resolve('codex')).toMatchObject({ error: expect.stringContaining('未找到') })
    expect(r.resolve('x')).toMatchObject({ error: expect.stringContaining('未知') })
    expect(r.probeStatic().find(p => p.id === 'claude-code')?.available).toBe(true)
  })
  it('不接受相对路径命令，环境剔除平台凭据', () => {
    expect(findExecutable('../evil', { isExecutable: () => true })).toBeUndefined()
    const env = engineEnv(BUILTIN_ENGINES[0]!, { PATH: '/usr/bin', LUMO_PG_DSN: 'secret', HOME: '/h' }, '/opt/bin')
    expect(env.LUMO_PG_DSN).toBeUndefined()
    expect(env.PATH?.startsWith('/opt/bin')).toBe(true)
  })
  it('开关：LUMO_ACP_ENGINES=off 关闭', () => {
    expect(acpEnginesEnabled({})).toBe(true)
    expect(acpEnginesEnabled({ LUMO_ACP_ENGINES: 'off' })).toBe(false)
    expect(createAcpEngines({ env: { LUMO_ACP_ENGINES: 'legacy' } })).toBeUndefined()
  })
})

describe('permission → Ask', () => {
  it('投影成 choice Ask，source 带会话与 run', () => {
    const ask = askFromPermission({ realm: 'r', userId: 'u', lumoSessionId: 's', runId: 'acp-s', engineId: 'claude-code' }, 'acp-e-1',
      { sessionId: 'e', toolCall: { toolCallId: 't', kind: 'edit', title: '改 a.ts' }, options: [{ optionId: 'y', name: '允许', kind: 'allow_once' }] }, 0, 1000)
    expect(ask).toMatchObject({ id: 'session:acp-e-1', kind: 'choice', status: 'pending', source: { kind: 'session', session_ref: 's', run_id: 'acp-s', operation: 'edit' }, options: [{ id: 'y', label: '允许' }] })
  })
  it('reject_* 记为 rejected；非发起人不能答；终态幂等', async () => {
    const b = new SessionAskBroker(0)
    const { ask, response } = b.request({ realm: 'r', userId: 'u', lumoSessionId: 's', engineId: 'x' }, 'e', { sessionId: 'e', toolCall: { toolCallId: 't' }, options: [{ optionId: 'n', name: '拒绝', kind: 'reject_once' }] })
    expect(b.answer(ask.id, 'n', 'other').ok).toBe(false)
    expect(b.answer(ask.id, 'zzz', 'u').ok).toBe(false)
    expect(b.answer(ask.id, 'n', 'u').ok).toBe(true)
    await expect(response).resolves.toEqual({ outcome: { outcome: 'selected', optionId: 'n' } })
    expect(b.get(ask.id)?.status).toBe('rejected')
    expect(b.answer(ask.id, 'n', 'u').ok).toBe(false)
  })
  it('TTL 过期回 cancelled', async () => {
    const b = new SessionAskBroker(10)
    const { ask, response } = b.request({ realm: 'r', userId: 'u', lumoSessionId: 's', engineId: 'x' }, 'e', { sessionId: 'e', toolCall: { toolCallId: 't' }, options: [] })
    await expect(response).resolves.toEqual({ outcome: { outcome: 'cancelled' } })
    expect(b.get(ask.id)?.status).toBe('expired')
  })
})

describe('EngineHost（假 ACP agent）', () => {
  const cwd = mkdtempSync(`${tmpdir()}/acp-`)

  it('initialize → session/new → prompt 流式 → 权限 Ask → 运行树', async () => {
    const sink = new TreeSink()
    const { host: h, asks } = host(fakeAcpAgent, sink)
    const s = await h.createSession({ engineId: 'fake', cwd, realm: 'r', userId: 'u' })
    expect(s).toMatchObject({ engineSessionId: 'eng-1', state: 'idle' })
    const events: SessionEvent[] = []
    h.subscribe(s.id, 'u', 0, (_seq, e) => events.push(e))
    expect(h.prompt(s.id, 'other', 'hi').ok).toBe(false)
    expect(h.prompt(s.id, 'u', 'hi').ok).toBe(true)
    await until(() => asks.list({ status: 'pending' }).length === 1)
    const pending = asks.list({ status: 'pending' })[0]!
    // run 节点进入 awaiting_ask，工具调用是它的子节点
    const run = sink.state.nodes[`run:acp-${s.id}`]!
    expect(run.status).toBe('awaiting_ask')
    expect(run.askIds).toContain(pending.id)
    const tool = Object.values(sink.state.nodes).find(n => n.kind === 'subagent')!
    expect(tool.parentId).toBe(run.id)
    expect(asks.answer(pending.id, 'ok', 'u').ok).toBe(true)
    await until(() => events.some(e => e.type === 'turn.ended'))
    const text = events.filter(e => e.type === 'message.chunk' && e.role === 'agent').map(e => (e as { text: string }).text).join('')
    expect(text).toBe('hello')
    expect(events.find(e => e.type === 'turn.ended')).toMatchObject({ stopReason: 'end_turn' })
    expect(sink.state.nodes[tool.id]!.status).toBe('succeeded')
    expect(h.close(s.id, 'completed', 'u')).toBe(true)
    expect(sink.state.nodes[run.id]!.status).toBe('succeeded')
    expect(h.list()).toHaveLength(0)
  })

  it('cancel：挂起的权限请求回 cancelled，回合以 cancelled 结束', async () => {
    const sink = new TreeSink()
    const { host: h, asks } = host(fakeAcpAgent, sink)
    const s = await h.createSession({ engineId: 'fake', cwd, realm: 'r', userId: 'u' })
    const events: SessionEvent[] = []
    h.subscribe(s.id, 'u', 0, (_q, e) => events.push(e))
    h.prompt(s.id, 'u', 'go')
    await until(() => asks.list({ status: 'pending' }).length === 1)
    expect(h.cancel(s.id, 'u').ok).toBe(true)
    await until(() => events.some(e => e.type === 'turn.ended'))
    expect(events.find(e => e.type === 'turn.ended')).toMatchObject({ stopReason: 'cancelled' })
    expect(asks.list({ status: 'cancelled' })).toHaveLength(1)
    expect(sink.state.nodes[`run:acp-${s.id}`]!.status).toBe('cancelled')
    h.closeAll()
  })

  it('cwd 必须是已有绝对目录', async () => {
    const { host: h } = host(fakeAcpAgent)
    await expect(h.createSession({ engineId: 'fake', cwd: 'relative', realm: 'r', userId: 'u' })).rejects.toThrow(/绝对路径/u)
  })
})

describe('Codex app-server 桥', () => {
  /** 假 codex app-server */
  function fakeCodex(): MessageTransport {
    const [bridgeSide, server] = memoryTransportPair()
    const rpc = new JsonRpcConnection(server, 0)
    rpc.onRequest(CODEX_METHODS.initialize, () => ({ userAgent: 'codex/test' }))
    rpc.onRequest(CODEX_METHODS.threadStart, () => ({ thread: { id: 'th-1' } }))
    rpc.onRequest(CODEX_METHODS.turnInterrupt, () => ({}))
    rpc.onRequest(CODEX_METHODS.turnStart, (params) => {
      const threadId = (params as { threadId: string }).threadId
      setTimeout(async () => {
        rpc.notify(CODEX_METHODS.agentDelta, { threadId, delta: '好的' })
        rpc.notify(CODEX_METHODS.itemStarted, { threadId, item: { id: 'c1', type: 'commandExecution', command: 'ls' } })
        const r = await rpc.request<{ decision: string }>(CODEX_METHODS.commandApproval, { threadId, itemId: 'c1', command: 'ls' }, 0)
        rpc.notify(CODEX_METHODS.itemCompleted, { threadId, item: { id: 'c1', type: 'commandExecution', status: r.decision === 'accept' ? 'completed' : 'declined', exitCode: 0 } })
        rpc.notify(CODEX_METHODS.turnCompleted, { threadId, turn: { id: 'turn-1', status: 'completed' } })
      }, 1)
      return { turn: { id: 'turn-1' } }
    })
    return bridgeSide
  }

  it('thread/turn/item 映射成 ACP 会话、流式与权限', async () => {
    const sink = new TreeSink()
    const { host: h, asks } = host(() => bridgeCodexToAcp(fakeCodex()), sink)
    const cwd = mkdtempSync(`${tmpdir()}/codex-`)
    const s = await h.createSession({ engineId: 'fake', cwd, realm: 'r', userId: 'u' })
    expect(s.engineSessionId).toBe('th-1')
    const events: SessionEvent[] = []
    h.subscribe(s.id, 'u', 0, (_q, e) => events.push(e))
    h.prompt(s.id, 'u', '列一下目录')
    await until(() => asks.list({ status: 'pending' }).length === 1)
    const ask = asks.list({ status: 'pending' })[0]!
    expect(ask.options?.map(o => o.id)).toEqual(['accept', 'acceptForSession', 'decline'])
    asks.answer(ask.id, 'accept', 'u')
    await until(() => events.some(e => e.type === 'turn.ended'))
    expect(events.some(e => e.type === 'message.chunk' && e.text === '好的')).toBe(true)
    expect(events.some(e => e.type === 'tool.update' && e.status === 'completed')).toBe(true)
    expect(Object.values(sink.state.nodes).filter(n => n.kind === 'subagent').map(n => n.status)).toEqual(['succeeded'])
    h.closeAll()
  })
})

describe('AcpRunTreeRecorder', () => {
  it('回合异常结束时收尾未完成工具；迟到的 update 忽略', () => {
    const sink = new TreeSink()
    const r = new AcpRunTreeRecorder(sink, 's', 'claude-code', { parentRunId: 'task-run-1' })
    r.sessionStarted('e')
    expect(sink.state.nodes['run:acp-s']).toMatchObject({ parentId: 'run:task-run-1', agent: 'claude-code' })
    r.toolStarted('t', 'read', 'read')
    r.turnEnded('cancelled')
    r.toolUpdated('t', 'completed')
    const tool = Object.values(sink.state.nodes).find(n => n.kind === 'subagent')!
    expect(tool.status).toBe('cancelled')
    expect(sink.events.filter(e => e.type === 'subagent.end')).toHaveLength(1)
  })
})

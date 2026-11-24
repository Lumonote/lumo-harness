import { describe, expect, it } from 'vitest'

import { applyRunTreeEvent, emptyRunTree, type RunTreeEvent, type RunTreeState } from '../../../shared/seam-contracts/run-tree.ts'
import { parseAskID } from '../../../shared/seam-contracts/asks.ts'
import {
  ACP_ENGINES_MANIFEST, DualPluginGateway, FailClosedDecider, LocalDecider, MAX_TOOL_DESCRIPTION, OPT_ONCE, OPT_REJECT, OPT_SESSION,
  PROJECT_MANIFEST, RemoteDecider, ToolAskBroker, handleMcpMessage, pickDecider, toDshTool, validateArgs, validateManifest,
  type DualPluginManifest,
} from '../src/index.ts'

class Tree { state: RunTreeState = emptyRunTree(); events: RunTreeEvent[] = []; apply(e: RunTreeEvent) { this.events.push(e); this.state = applyRunTreeEvent(this.state, e) } }
const tick = () => new Promise(r => setTimeout(r, 1))
async function until(f: () => boolean) { for (let i = 0; i < 500 && !f(); i++) await tick(); if (!f()) throw new Error('timeout') }

const demo = (over: Partial<DualPluginManifest['tools'][number]> = {}): DualPluginManifest => ({
  manifestVersion: 1, id: 'demo', title: 'Demo', pages: [{ id: 'main', title: '主页', kind: 'route', route: '/?lumo=demo' }],
  tools: [{ name: 'demo_echo', description: '回显', parameters: { type: 'object', properties: { text: { type: 'string', maxLength: 10 } }, required: ['text'], additionalProperties: false }, action: 'demo:echo', risk: 'low', page: 'main', ...over }],
})
const caller = { realm: 'r', userId: 'u', channel: 'platform' as const }

describe('manifest', () => {
  it('示范清单合法', () => {
    expect(validateManifest(PROJECT_MANIFEST)).toEqual([])
    expect(validateManifest(ACP_ENGINES_MANIFEST)).toEqual([])
  })
  it('限制描述长度、名称、动作、页面引用与高风险 never', () => {
    const m = demo({ description: 'x'.repeat(MAX_TOOL_DESCRIPTION + 1), name: 'Bad-Name', action: 'nope', page: 'ghost', risk: 'high', approval: 'never' })
    const errs = validateManifest(m).join('\n')
    for (const k of ['description 超过', '.name', '.action', '未声明的页面', 'approval=never']) expect(errs).toContain(k)
  })
  it('页面路由必须同源', () => {
    expect(validateManifest({ ...demo(), pages: [{ id: 'x', title: 'x', kind: 'route', route: '//evil' }], tools: [] }).join()).toContain('同源')
  })
  it('参数校验', () => {
    const s = demo().tools[0]!.parameters
    expect(validateArgs(s, { text: 'hi' })).toEqual([])
    expect(validateArgs(s, {}).join()).toContain('必填')
    expect(validateArgs(s, { text: 'x'.repeat(11) }).join()).toContain('最大长度')
    expect(validateArgs(s, { text: 'a', extra: 1 }).join()).toContain('不是允许的参数')
  })
})

describe('decider', () => {
  const base = { realm: 'r', principal: { kind: 'user' as const, id: 'u' }, action: 'a:b', resource: { realm: 'r', kind: 'dual-tool' as const, id: 'x' }, risk: 'low' as const, approval: 'auto' as const }
  it('单机默认放行，high 走 ask，realm 不一致拒绝，深度超限拒绝', async () => {
    const d = new LocalDecider()
    expect((await d.decide(base)).effect).toBe('allow')
    expect((await d.decide({ ...base, risk: 'high' })).effect).toBe('ask')
    expect((await d.decide({ ...base, resource: { ...base.resource, realm: 'x' } })).reason_code).toBe('realm_mismatch')
    expect((await d.decide({ ...base, actor: { kind: 'agent', agent_id: 'a', depth: 4 } })).reason_code).toBe('delegation_too_deep')
    expect((await new LocalDecider({ askHigh: false }).decide({ ...base, risk: 'high' })).effect).toBe('allow')
  })
  it('远端不可用 fail-closed；远端 allow 不能绕过清单审批', async () => {
    const down = new RemoteDecider('http://x', {}, async () => { throw new Error('ECONNREFUSED') })
    expect((await down.decide(base)).reason_code).toBe('policy_unavailable')
    const bad = new RemoteDecider('http://x', {}, async () => ({ ok: false, status: 500, json: async () => ({}) }))
    expect((await bad.decide(base)).effect).toBe('deny')
    const malformed = new RemoteDecider('http://x', {}, async () => ({ ok: true, status: 200, json: async () => ({ effect: 'allow' }) }))
    expect((await malformed.decide(base)).reason_code).toBe('policy_unavailable')
    const allow = new RemoteDecider('http://x/', { authorization: 'Bearer service' }, async (url, init) => {
      expect(url).toBe('http://x/v1/permissions/decide')
      expect(init.headers).toMatchObject({ authorization: 'Bearer service', 'x-lumo-realm': 'r', 'x-lumo-user': 'u' })
      expect(init.redirect).toBe('error')
      return { ok: true, status: 200, json: async () => ({ effect: 'allow', decision_id: 'd1', reason_code: 'authorized', reason: 'ok', matched: [] }) }
    })
    expect((await allow.decide({ ...base, approval: 'always' })).effect).toBe('ask')
    expect((await new FailClosedDecider().decide(base)).effect).toBe('deny')
  })
  it('按部署形态选判定器', () => {
    expect(pickDecider({ deploymentMode: 'local', defaults: { realm: 'r', userId: 'u' }, env: {} }).adapter).toBe('local-default-allow')
    expect(pickDecider({ deploymentMode: 'cluster', defaults: { realm: 'r', userId: 'u' }, env: {} }).adapter).toBe('fail-closed')
    expect(pickDecider({ deploymentMode: 'cluster', governanceUrl: 'http://g', defaults: { realm: 'r', userId: 'u' }, env: {} }).adapter).toBe('governance')
  })
})

describe('gateway', () => {
  it('allow：执行并登记到会话下的运行树', async () => {
    const tree = new Tree()
    tree.apply({ type: 'node.upsert', node: { id: 'run:r1', kind: 'run', sessionId: 's1', status: 'running' } })
    const gw = new DualPluginGateway({ decider: new LocalDecider(), runTree: tree })
    gw.register(demo(), { demo_echo: a => ({ echo: a.text }) })
    const r = await gw.invoke('demo_echo', { text: 'hi' }, { ...caller, sessionRef: 's1' })
    expect(r).toMatchObject({ ok: true, value: { echo: 'hi' } })
    const node = Object.values(tree.state.nodes).find(n => n.kind === 'subagent')!
    expect(node.parentId).toBe('run:r1')
    expect(node.status).toBe('succeeded')
  })
  it('deny 不执行、不伪装成空结果', async () => {
    let ran = false
    const gw = new DualPluginGateway({ decider: new FailClosedDecider(), mode: 'enforce' })
    gw.register(demo(), { demo_echo: () => { ran = true } })
    const r = await gw.invoke('demo_echo', { text: 'a' }, caller)
    expect(r).toMatchObject({ ok: false, code: 'denied' })
    expect(ran).toBe(false)
  })
  it('shadow 模式不能旁路身份边界或权限服务不可用', async () => {
    const gw = new DualPluginGateway({ decider: new FailClosedDecider(), mode: 'shadow' })
    gw.register(demo(), { demo_echo: (_a, c) => c.decision.matched })
    const r = await gw.invoke('demo_echo', { text: 'a' }, caller)
    expect(r).toMatchObject({ ok: false, code: 'denied' })
    expect(await gw.invoke('demo_echo', { text: 'a' }, { ...caller, realm: '' })).toMatchObject({ ok: false, code: 'denied' })
  })
  it('shadow 仅放行显式的观测策略拒绝', async () => {
    const gw = new DualPluginGateway({ mode: 'shadow', decider: { adapter: 'test', decide: async () => ({ effect:'deny', decision_id:'d', reason_code:'advisory_deny', reason:'observation', matched:[] }) } })
    gw.register(demo(), { demo_echo: (_a, c) => c.decision.matched })
    expect(await gw.invoke('demo_echo', { text: 'a' }, caller)).toMatchObject({ ok:true, value:['shadow:deny:advisory_deny'] })
  })
  it('无效参数 / 未开放通道 / 未知工具', async () => {
    const gw = new DualPluginGateway({ decider: new LocalDecider() })
    gw.register(demo({ channels: ['platform'] }), { demo_echo: () => 1 })
    expect((await gw.invoke('demo_echo', {}, caller) as { code: string }).code).toBe('invalid_args')
    expect((await gw.invoke('demo_echo', { text: 'a' }, { ...caller, channel: 'acp' }) as { code: string }).code).toBe('channel_closed')
    expect((await gw.invoke('nope', {}, caller) as { code: string }).code).toBe('unknown_tool')
  })
  it('ask → 统一 Ask → 批准后执行；运行树 awaiting_ask', async () => {
    const tree = new Tree()
    const gw = new DualPluginGateway({ decider: new LocalDecider(), runTree: tree })
    gw.register(demo({ risk: 'high' }), { demo_echo: a => a.text })
    const p = gw.invoke('demo_echo', { text: 'go' }, caller)
    await until(() => gw.asks.list({ status: 'pending' }).length === 1)
    const ask = gw.asks.list({ status: 'pending' })[0]!
    expect(parseAskID(ask.id)?.kind).toBe('run')
    expect(ask.options?.map(o => o.id)).toEqual([OPT_ONCE, OPT_REJECT]) // high 不给本会话允许
    expect(Object.values(tree.state.nodes)[0]!.status).toBe('awaiting_ask')
    expect(gw.asks.answer(ask.id, OPT_ONCE, 'someone-else').ok).toBe(false)
    expect(gw.asks.answer(ask.id, OPT_ONCE, 'u').ok).toBe(true)
    expect(await p).toMatchObject({ ok: true, value: 'go' })
    expect(Object.values(tree.state.nodes)[0]!.status).toBe('succeeded')
  })
  it('拒绝 → rejected；本会话允许 → 同会话再次调用不再询问', async () => {
    const gw = new DualPluginGateway({ decider: new LocalDecider() })
    gw.register(demo({ risk: 'medium', approval: 'always' }), { demo_echo: () => 'ok' })
    const c = { ...caller, sessionRef: 's9' }
    const p1 = gw.invoke('demo_echo', { text: 'a' }, c)
    await until(() => gw.asks.list({ status: 'pending' }).length === 1)
    gw.asks.answer(gw.asks.list({ status: 'pending' })[0]!.id, OPT_REJECT, 'u')
    expect(await p1).toMatchObject({ ok: false, code: 'rejected' })
    const p2 = gw.invoke('demo_echo', { text: 'a' }, c)
    await until(() => gw.asks.list({ status: 'pending' }).length === 1)
    gw.asks.answer(gw.asks.list({ status: 'pending' })[0]!.id, OPT_SESSION, 'u')
    expect((await p2).ok).toBe(true)
    expect((await gw.invoke('demo_echo', { text: 'a' }, c)).ok).toBe(true)
    expect(gw.asks.list({ status: 'pending' })).toHaveLength(0)
    gw.revokeSession('s9')
    const p4 = gw.invoke('demo_echo', { text: 'a' }, c)
    await until(() => gw.asks.list({ status: 'pending' }).length === 1)
    gw.asks.cancelSession('s9')
    expect(await p4).toMatchObject({ ok: false, code: 'ask_expired' })
  })
  it('Ask 过期按拒绝处理', async () => {
    const gw = new DualPluginGateway({ decider: new LocalDecider(), asks: new ToolAskBroker(5) })
    gw.register(demo({ risk: 'high' }), { demo_echo: () => 'x' })
    expect(await gw.invoke('demo_echo', { text: 'a' }, caller)).toMatchObject({ ok: false, code: 'ask_expired' })
  })
  it('handler 抛错 → failed，工具名冲突拒绝注册', async () => {
    const gw = new DualPluginGateway({ decider: new LocalDecider() })
    gw.register(demo(), { demo_echo: () => { throw new Error('boom') } })
    expect(await gw.invoke('demo_echo', { text: 'a' }, caller)).toMatchObject({ ok: false, code: 'failed', error: 'boom' })
    expect(() => gw.register({ ...demo(), id: 'demo2' }, { demo_echo: () => 1 })).toThrow('冲突')
  })
})

describe('channels', () => {
  it('MCP：initialize / tools/list 只列 acp 通道 / tools/call 走网关', async () => {
    const gw = new DualPluginGateway({ decider: new LocalDecider() })
    gw.register(demo(), { demo_echo: a => ({ echo: a.text }) })
    gw.register(ACP_ENGINES_MANIFEST, { acp_engines_list: () => ({ engines: [] }) })
    const c = { realm: 'r', userId: 'u', sessionRef: 's' }
    expect(await handleMcpMessage(gw, c, { id: 1, method: 'initialize' })).toMatchObject({ result: { serverInfo: { name: 'lumo-plugins' } } })
    const list = await handleMcpMessage(gw, c, { id: 2, method: 'tools/list' }) as { result: { tools: Array<{ name: string }> } }
    expect(list.result.tools.map(t => t.name)).toEqual(['demo_echo'])
    expect(await handleMcpMessage(gw, c, { id: 3, method: 'tools/call', params: { name: 'demo_echo', arguments: { text: 'x' } } })).toMatchObject({ result: { isError: false, structuredContent: { echo: 'x' } } })
    expect(await handleMcpMessage(gw, c, { id: 4, method: 'tools/call', params: { name: 'acp_engines_list', arguments: {} } })).toMatchObject({ result: { isError: true } })
    expect(await handleMcpMessage(gw, c, { method: 'notifications/initialized' })).toBeUndefined()
  })
  it('dsh 工具：execute 走网关，deny 抛错', async () => {
    const gw = new DualPluginGateway({ decider: new FailClosedDecider(), mode: 'enforce', defaults: { realm: 'r', userId: 'u' } })
    gw.register(demo(), { demo_echo: () => 1 })
    const def = toDshTool(gw, demo().tools[0]!)
    expect(def.name).toBe('demo_echo')
    await expect(def.execute({ text: 'a' }, { agent: { id: 'a1', session: { id: 's' } } } as never)).rejects.toThrow('denied')
  })
})

import type { AgentSkills } from '../src/prompt-context.ts'
import { AttachmentStore } from '../src/attachment-store.ts'
import type { ContentBlock } from '../src/acp-protocol.ts'
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineHost } from '../src/engine-host.ts'
import { EngineRegistry } from '../src/registry.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'
import { ACP_METHODS } from '../src/acp-protocol.ts'
import { RoleRooms } from '../src/role-rooms.ts'
import { RoleRoomStore } from '../src/role-room-store.ts'
import { ROOM_LIMITS, roomConfig } from '../src/role-room-model.ts'
import { runRoleTurn } from '../src/role-room-turn.ts'

const scope = { realm: 'local', userId: 'me', projectId: 'project' }
const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()) })
const until = async (check: () => boolean) => { for (let i = 0; i < 200; ++i) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) } throw new Error('timeout') }
const config = (cwd: string, id = 'room') => ({ id, name: '我的团队', cwd, coordinatorId: 'assistant', roles: [
  { id: 'assistant', name: '助理', engineId: 'claude-code', instruction: '汇总有证据的结论' },
  { id: 'engineer', name: '工程师', engineId: 'codex', instruction: '实现并测试' },
  { id: 'reviewer', name: '评审', engineId: 'claude-code', instruction: '审查正确性' },
] })
function fixture(options: { skills?: AgentSkills; permission?: boolean; hold?: boolean; fail?: boolean; long?: boolean; store?: (file: string) => RoleRoomStore } = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'lumo-roles-')); cleanups.push(() => rmSync(cwd, { recursive: true, force: true }))
  const asks = new SessionAskBroker(0), prompts: Array<{ engine: string; prompt: string; session: string; blocks: ContentBlock[] }> = []
  let connections = 0
  const registry = new EngineRegistry(['claude-code', 'codex'].map(id => ({ id, label: id, protocol: 'acp', provider: id, commands: [{ bin: '/bin/sh', args: [] }] })), new Set(), { isExecutable: () => true })
  const host = new EngineHost({ registry, asks, recoveryIndexPath: join(cwd, 'sessions.json'), connect: engine => {
    const [client, agent] = memoryTransportPair(), rpc = new JsonRpcConnection(agent, 0), session = `engine-${++connections}`
    rpc.onRequest(ACP_METHODS.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
    rpc.onRequest(ACP_METHODS.sessionNew, () => ({ sessionId: session })); rpc.onRequest(ACP_METHODS.sessionLoad, () => ({}))
    let release: (() => void) | undefined
    rpc.onNotification(ACP_METHODS.sessionCancel, () => release?.())
    rpc.onRequest(ACP_METHODS.sessionPrompt, async raw => {
      const p = raw as { sessionId: string; prompt: Array<{ text: string }> }
      prompts.push({ engine: engine.definition.id, prompt: p.prompt[0]!.text, session: p.sessionId, blocks: p.prompt as ContentBlock[] })
      const update = (sessionUpdate: string, text: string) => rpc.notify(ACP_METHODS.sessionUpdate, { sessionId: p.sessionId, update: { sessionUpdate, content: { type: 'text', text } } })
      update('agent_thought_chunk', 'private-thought-must-not-leak')
      update('agent_message_chunk', options.long ? 'a'.repeat(ROOM_LIMITS.output + 100) : `answer-${engine.definition.id}-${prompts.length}`)
      if (options.permission) await rpc.request(ACP_METHODS.requestPermission, { sessionId: p.sessionId, toolCall: { toolCallId: 't', title: '编辑文件' }, options: [{ optionId: 'yes', name: '允许一次', kind: 'allow_once' }] }, 0)
      if (options.hold) { await new Promise<void>(r => { release = r }); return { stopReason: 'cancelled' } }
      if (options.fail) throw new Error('engine failed')
      return { stopReason: 'end_turn' }
    })
    return client
  } })
  const attachments = new AttachmentStore(join(cwd, 'attachments'))
  const file = join(cwd, 'rooms.json'), store = options.store?.(file) ?? new RoleRoomStore(file), rooms = new RoleRooms(host, store, attachments, options.skills)
  cleanups.push(() => { rooms.dispose(); host.closeAll() })
  rooms.create(config(cwd), scope)
  return { cwd, host, rooms, store, file, prompts, asks, attachments }
}

describe('roles coordinate existing engine sessions', () => {
  it('loads selected skills once in the room project and forwards their bodies and file references to every role', async () => {
    const load = vi.fn(async () => '<skill_content>real instructions</skill_content>')
    const { rooms, prompts, cwd, file } = fixture({ skills: { load, list: vi.fn() } })
    writeFileSync(join(cwd, 'README.md'), 'project doc')
    rooms.send('room', { id: 'context', text: 'review', mode: 'relay', skills: ['code-review'], files: ['README.md'] }, scope)
    await until(() => !rooms.view('room', scope).busy)
    expect(load).toHaveBeenCalledExactlyOnceWith(['code-review'], rooms.view('room', scope).cwd, expect.any(AbortSignal))
    expect(prompts).toHaveLength(3)
    expect(prompts.every(p => JSON.stringify(p.blocks).includes('real instructions') && JSON.stringify(p.blocks).includes('README.md'))).toBe(true)
    expect(new RoleRoomStore(file).get('room')?.turns[0]).toMatchObject({ skills: ['code-review'], files: ['README.md'] })
    expect(readFileSync(file, 'utf8')).not.toContain('real instructions')
  })
  it('fails skill loading visibly before launching any engine', async () => {
    const { rooms, host } = fixture({ skills: { load: vi.fn(async () => { throw new Error('Skill missing') }), list: vi.fn() } })
    rooms.send('room', { id: 'context', text: '', mode: 'relay', skills: ['missing'] }, scope)
    await until(() => !rooms.view('room', scope).busy)
    expect(host.list(scope)).toHaveLength(0)
    expect(rooms.view('room', scope).turns[0]).toMatchObject({ state: 'failed', error: 'Skill missing' })
  })

  it('delivers actual attachment contents to each role, persists references and deduplicates retries', async () => {
    const { rooms, prompts, attachments, file, host } = fixture()
    const attachment = attachments.upload({ name: 'spec.md', mimeType: 'text/markdown', data: Buffer.from('unique attachment contents').toString('base64') }, scope)
    expect(() => rooms.send('room', { id: 'foreign', text: '', mode: 'relay', attachments: [{ ...attachment, id: 'f'.repeat(64) }] }, scope)).toThrow('附件')
    expect(host.list(scope)).toHaveLength(0)
    const input = { id: 'files', text: '', mode: 'relay', attachments: [attachment] }
    rooms.send('room', input, scope)
    await until(() => !rooms.view('room', scope).busy)
    expect(prompts).toHaveLength(3)
    expect(prompts.every(p => JSON.stringify(p.blocks).includes('unique attachment contents'))).toBe(true)
    expect(new RoleRoomStore(file).get('room')?.turns[0]?.attachments).toEqual([attachment])
    expect(readFileSync(file, 'utf8')).not.toContain('unique attachment contents')
    rooms.send('room', input, scope); expect(prompts).toHaveLength(3)
    expect(() => rooms.send('room', { ...input, attachments: [] }, scope)).toThrow()
  })

  it('runs experts in sequence, passes actual answers, then asks the coordinator to summarize', async () => {
    const { rooms, prompts, host, file } = fixture()
    rooms.send('room', { id: 'turn', text: '完成任务', mode: 'discuss' }, scope)
    await until(() => !rooms.view('room', scope).busy)
    const room = rooms.view('room', scope)
    expect(prompts.map(p => p.engine)).toEqual(['codex', 'claude-code', 'claude-code'])
    expect(prompts[1]!.prompt).toContain('answer-codex-1'); expect(prompts[2]!.prompt).toContain('协调助理汇总')
    expect(prompts.every(p => !p.prompt.includes('private-thought'))).toBe(true)
    expect(room.turns[0]!.steps.map(s => s.state)).toEqual(['completed', 'completed', 'completed'])
    expect(host.list(scope)).toHaveLength(3); expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(readFileSync(file, 'utf8')).not.toContain('private-thought')
    rooms.send('room', { id: 'followup', text: '继续细化', mode: 'direct', targetRoleId: 'engineer' }, scope)
    await until(() => !rooms.view('room', scope).busy)
    expect(host.list(scope)).toHaveLength(3); expect(prompts[3]!.session).toBe(prompts[0]!.session)
    expect(prompts[3]!.prompt).toContain('answer-claude-code-3')
    expect(rooms.view('room', scope).turns[1]!.steps[0]!.text).toBe('answer-codex-4')
  })
  it('persists group appearance and summaries without allocating a session; rejects foreign scope and invalid values', () => {
    const { rooms, file, host } = fixture()
    expect(rooms.view('room', scope).appearance).toBeUndefined()
    const appearance = { logo: 'engine:codex', color: '#A055DD' }
    expect(rooms.setAppearance('room', appearance, scope).appearance).toEqual({ ...appearance, color: '#a055dd' })
    expect(new RoleRoomStore(file).get('room')?.appearance).toEqual({ ...appearance, color: '#a055dd' })
    expect(rooms.list(scope)[0]).toMatchObject({ appearance: { ...appearance, color: '#a055dd' }, engineIds: ['claude-code', 'codex', 'claude-code'] })
    expect(() => rooms.setAppearance('room', appearance, { ...scope, userId: 'someone' })).toThrow('不存在')
    expect(() => rooms.setAppearance('room', { logo: 'https://remote/logo.svg', color: '#aabbcc' }, scope)).toThrow('无效')
    expect(() => rooms.setAppearance('room', { logo: 'bolt', color: 'red;display:none' }, scope)).toThrow('无效')
    expect(host.list(scope)).toEqual([])
  })
  it('keeps saved appearance after a write failure and blocks edits during a turn', async () => {
    const { rooms, store, prompts } = fixture({ hold: true })
    rooms.setAppearance('room', { logo: 'team', color: '#123456' }, scope)
    const put = vi.spyOn(store, 'put').mockImplementationOnce(() => { throw new Error('disk unavailable') })
    expect(() => rooms.setAppearance('room', { logo: 'bolt', color: '#abcdef' }, scope)).toThrow('disk unavailable')
    expect(rooms.view('room', scope).appearance?.logo).toBe('team')
    put.mockRestore()
    rooms.send('room', { id: 'busy', mode: 'direct', targetRoleId: 'engineer', text: '先检查' }, scope)
    await until(() => prompts.length === 1)
    expect(() => rooms.setAppearance('room', { logo: 'bolt', color: '#abcdef' }, scope)).toThrow('正在协作')
    rooms.stop('room', scope); await until(() => !rooms.view('room', scope).busy)
  })
  it('hands public context across direct messages to different roles and tools in one history', async () => {
    const { rooms, prompts } = fixture()
    rooms.send('room', { id: 'assistant-first', text: '分析问题', mode: 'direct', targetRoleId: 'assistant' }, scope)
    await until(() => !rooms.view('room', scope).busy)
    rooms.send('room', { id: 'engineer-next', text: '根据助理的分析继续实现', mode: 'direct', targetRoleId: 'engineer' }, scope)
    await until(() => !rooms.view('room', scope).busy)
    expect(prompts.map(p => p.engine)).toEqual(['claude-code', 'codex'])
    expect(prompts[1]!.prompt).toContain('answer-claude-code-1')
    expect(prompts[1]!.prompt).toContain('分析问题')
    expect(prompts[1]!.prompt).not.toContain('private-thought')
    expect(rooms.view('room', scope).turns.map(t => t.targetRoleId)).toEqual(['assistant', 'engineer'])
    expect(rooms.list(scope)[0]?.preview).toBe('根据助理的分析继续实现')
  })
  it('reuses message receipts while running and after completion; conflicting retries never dispatch', async () => {
    const { rooms, prompts } = fixture(); const input = { id: 'same', text: '先检查', mode: 'relay' }
    rooms.send('room', input, scope); rooms.send('room', input, scope)
    expect(() => rooms.send('room', { ...input, text: '不同任务' }, scope)).toThrow('不同内容')
    expect(() => rooms.send('room', { ...input, id: 'new' }, scope)).toThrow('正在协作')
    await until(() => !rooms.view('room', scope).busy)
    rooms.send('room', input, scope); expect(prompts).toHaveLength(3)
  })
  it('holds permissions in the existing Ask broker and does not auto-approve', async () => {
    const { rooms, asks, prompts } = fixture({ permission: true })
    rooms.send('room', { id: 'permission', text: '修复', mode: 'direct', targetRoleId: 'engineer' }, scope)
    await until(() => asks.list(scope, { status: 'pending' }).length === 1)
    expect(rooms.view('room', scope).busy).toBe(true); expect(prompts).toHaveLength(1)
    const ask = asks.list(scope, { status: 'pending' })[0]!
    expect(asks.answer(ask.id, 'yes', { ...scope, userId: 'other' }).ok).toBe(false)
    expect(asks.answer(ask.id, 'yes', scope).ok).toBe(true)
    await until(() => !rooms.view('room', scope).busy)
    expect(rooms.view('room', scope).turns[0]!.state).toBe('completed')
  })
  it('stops an active engine and never starts later roles or the summary', async () => {
    const { rooms, prompts } = fixture({ hold: true })
    rooms.send('room', { id: 'stop', text: '执行', mode: 'discuss' }, scope)
    await until(() => prompts.length === 1)
    rooms.stop('room', scope); await until(() => !rooms.view('room', scope).busy)
    expect(prompts).toHaveLength(1)
    expect(rooms.view('room', scope).turns[0]!.steps.map(s => s.state)).toEqual(['cancelled', 'cancelled', 'cancelled'])
  })
  it('stops the chain on engine errors and preserves failed output separately from success', async () => {
    const { rooms, prompts } = fixture({ fail: true })
    rooms.send('room', { id: 'failure', text: '执行', mode: 'relay' }, scope)
    await until(() => !rooms.view('room', scope).busy)
    expect(prompts).toHaveLength(1)
    expect(rooms.view('room', scope).turns[0]).toMatchObject({ state: 'failed', error: 'engine failed', steps: [{ state: 'failed' }, { state: 'cancelled' }, { state: 'cancelled' }] })
  })
  it.each([{ ...scope, userId: 'other' }, { ...scope, realm: 'other' }, { ...scope, projectId: undefined }])('isolates rooms by complete trusted scope', other => {
    const { rooms } = fixture()
    expect(rooms.list(other)).toEqual([])
    expect(() => rooms.view('room', other)).toThrow('不存在')
    expect(() => rooms.stop('room', other)).toThrow('不存在')
    expect(() => rooms.release('room', other, true)).toThrow('不存在')
  })
  it('normalizes workspace aliases and blocks simultaneous rooms on the same directory', async () => {
    const { rooms, cwd, prompts } = fixture({ hold: true })
    const alias = `${cwd}-alias`; symlinkSync(cwd, alias); cleanups.push(() => rmSync(alias))
    rooms.create(config(alias, 'other'), scope)
    rooms.send('room', { id: 'one', text: '执行', mode: 'relay' }, scope)
    await until(() => prompts.length === 1)
    expect(() => rooms.send('other', { id: 'two', text: '执行', mode: 'relay' }, scope)).toThrow('工作区已有')
  })
  it('restores persisted roles and public messages without replaying unfinished turns', async () => {
    const { rooms, prompts, file } = fixture({ hold: true })
    rooms.send('room', { id: 'lost', text: '执行', mode: 'relay' }, scope)
    await until(() => prompts.length === 1)
    const recovered = new RoleRoomStore(file).get('room')!
    expect(recovered.turns[0]!.state).toBe('interrupted'); expect(prompts).toHaveLength(1)
    expect(recovered.roles[0]!.sessionId).toBeTruthy()
  })
  it('marks bounded outputs explicitly and excludes private thoughts from shared history', async () => {
    const { rooms } = fixture({ long: true })
    rooms.send('room', { id: 'long', text: '执行', mode: 'direct', targetRoleId: 'engineer' }, scope)
    await until(() => !rooms.view('room', scope).busy)
    const step = rooms.view('room', scope).turns[0]!.steps[0]!
    expect(step.text).toHaveLength(ROOM_LIMITS.output); expect(step.truncated).toBe(true)
  })
  it('keeps the transcript when releasing processes and deletes it only on explicit room removal', async () => {
    const { rooms, host, file } = fixture()
    rooms.send('room', { id: 'one', text: '执行', mode: 'direct', targetRoleId: 'assistant' }, scope)
    await until(() => !rooms.view('room', scope).busy)
    rooms.release('room', scope); expect(host.list(scope)).toEqual([expect.objectContaining({ state: 'detached' })]); expect(rooms.view('room', scope).turns).toHaveLength(1)
    rooms.release('room', scope, true); expect(new RoleRoomStore(file).list()).toEqual([])
  })
  it('validates role configurations before allocating any engine', () => {
    const { rooms, cwd, host } = fixture()
    expect(() => roomConfig({ ...config(cwd), roles: [config(cwd).roles[0]] })).toThrow('2–6')
    expect(() => rooms.create({ ...config(cwd, 'bad'), roles: [config(cwd).roles[0], config(cwd).roles[0]] }, scope)).toThrow('唯一')
    expect(() => rooms.send('room', { id: 'bad', text: 'go', mode: 'direct', targetRoleId: 'missing' }, scope)).toThrow('不存在')
    expect(host.list(scope)).toEqual([])
  })
  it('retains the public receipt when the final write fails and does not redispatch a retry', async () => {
    const { rooms, store, prompts } = fixture()
    const put = store.put.bind(store)
    let fail = true
    vi.spyOn(store, 'put').mockImplementation(room => {
      if (fail && room.turns.some(turn => turn.state === 'completed')) throw new Error('disk full')
      put(room)
    })
    const input = { id: 'receipt', text: '执行', mode: 'direct', targetRoleId: 'engineer' }
    rooms.send('room', input, scope)
    await until(() => !rooms.view('room', scope).busy)
    expect(rooms.view('room', scope).turns[0]).toMatchObject({ state: 'interrupted', error: expect.stringContaining('写入失败') })
    rooms.send('room', input, scope); expect(prompts).toHaveLength(1)
    fail = false
    rooms.release('room', scope)
    expect(store.get('room')!.turns[0]!.steps[0]!.text).toContain('answer-codex')
    expect(prompts).toHaveLength(1)
  })
  it('preserves session handles and history when closing fails, then allows explicit retry', async () => {
    const { rooms, host } = fixture()
    rooms.send('room', { id: 'one', text: '执行', mode: 'direct', targetRoleId: 'engineer' }, scope)
    await until(() => !rooms.view('room', scope).busy)
    const session = rooms.view('room', scope).roles.find(role => role.id === 'engineer')!.sessionId
    const close = vi.spyOn(host, 'release').mockImplementationOnce(() => { throw new Error('index write failed') })
    expect(() => rooms.release('room', scope)).toThrow('index write failed')
    expect(rooms.view('room', scope).roles.find(role => role.id === 'engineer')!.sessionId).toBe(session)
    close.mockRestore(); rooms.release('room', scope)
    expect(host.list(scope)).toEqual([expect.objectContaining({ state: 'detached' })])
    expect(rooms.view('room', scope).turns[0]!.state).toBe('completed')
  })
  it('times out a role and detaches the event subscriber even when cancellation throws', async () => {
    const cancel = vi.fn(() => { throw new Error('gone') }), unsubscribe = vi.fn()
    const host = { get: () => ({ state: 'idle' }), subscribe: () => unsubscribe, prompt: () => ({ ok: true }), cancel }
    await expect(runRoleTurn(host as never, 'id', scope, 'work', new AbortController().signal, vi.fn(), 5)).rejects.toThrow('超时')
    expect(cancel).toHaveBeenCalledOnce(); expect(unsubscribe).toHaveBeenCalledOnce()
  })
})

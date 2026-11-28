import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineHost } from '../src/engine-host.ts'
import { EngineRegistry } from '../src/registry.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'
import { JsonRpcConnection, memoryTransportPair } from '../src/jsonrpc.ts'
import { ACP_METHODS } from '../src/acp-protocol.ts'
import { RoleRooms } from '../src/role-rooms.ts'
import { RoleRoomStore } from '../src/role-room-store.ts'
import type { ProjectTaskInput, ProjectWorkflowInput } from '../src/project-workflow-model.ts'

const scope = { realm: 'local', userId: 'developer', projectId: 'project' }
const cleanup: Array<() => void> = []
afterEach(() => cleanup.splice(0).reverse().forEach(fn => fn()))
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const wait = async (predicate: () => boolean) => { const end = Date.now() + 25_000; while (!predicate()) { if (Date.now() > end) throw new Error('workflow timeout'); await new Promise(r => setTimeout(r, 10)) } }
const tasks: ProjectTaskInput[] = [
  { id: 'alpha', title: 'Alpha', instruction: 'IMPLEMENT_ALPHA', dependsOn: [], capabilities: ['frontend'], acceptanceCriteria: ['alpha.txt exists'] },
  { id: 'beta', title: 'Beta', instruction: 'IMPLEMENT_BETA', dependsOn: [], capabilities: ['backend'], acceptanceCriteria: ['beta.txt exists'] },
]
function fixture(options: { review?: string; failCheck?: boolean; suggest?: ProjectTaskInput[]; permission?: boolean; hold?: boolean; dependency?: boolean; conflict?: boolean; initialMode?: 'auto' | 'plan' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'lumo-project-flow-')), cwd = join(root, 'project')
  mkdirSync(cwd)
  git(cwd, 'init', '-b', 'main'); git(cwd, 'config', 'user.name', 'Workflow Test'); git(cwd, 'config', 'user.email', 'workflow@example.invalid')
  writeFileSync(join(cwd, 'AGENTS.md'), 'Use the exact shared rule: PROJECT_RULE_2026.')
  writeFileSync(join(cwd, 'README.md'), 'initial\n'); git(cwd, 'add', '.'); git(cwd, 'commit', '-m', 'initial')
  const base = git(cwd, 'rev-parse', 'HEAD'), prompts: Array<{ cwd: string; text: string; engine: string }> = []
  const asks = new SessionAskBroker(0), active = new Set<string>(), modeChanges: string[] = []; let peak = 0
  const registry = new EngineRegistry(['tool-a', 'tool-b', 'tool-c'].map(id => ({ id, label: id, protocol: 'acp' as const, provider: id, commands: [{ bin: '/bin/sh', args: [] }] })), new Set(), { isExecutable: () => true })
  const host = new EngineHost({ registry, asks, recoveryIndexPath: join(root, 'sessions.json'), connect: engine => {
    const [client, peer] = memoryTransportPair(), rpc = new JsonRpcConnection(peer, 0), id = randomUUID()
    let currentCwd = '', currentMode: string = options.initialMode ?? 'default', unblock: (() => void) | undefined
    rpc.onRequest(ACP_METHODS.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true } }))
    rpc.onRequest(ACP_METHODS.sessionNew, value => { currentCwd = (value as { cwd: string }).cwd; return { sessionId: id, ...(options.initialMode ? { modes: { currentModeId: currentMode, availableModes: [{ id: 'auto', name: 'Auto' }, { id: 'default', name: 'Default' }, { id: 'plan', name: 'Plan' }] } } : {}) } })
    rpc.onRequest('session/set_mode', value => { currentMode = (value as { modeId: string }).modeId; modeChanges.push(currentMode); return {} })
    rpc.onNotification(ACP_METHODS.sessionCancel, () => unblock?.())
    rpc.onRequest(ACP_METHODS.sessionPrompt, async value => {
      const text = (value as { prompt: Array<{ text: string }> }).prompt.map(b => b.text ?? '').join('\n')
      prompts.push({ cwd: currentCwd, text, engine: engine.definition.id })
      expect(currentMode).toBe(options.initialMode === 'plan' ? 'plan' : 'default')
      let reply: string
      if (text.includes('独立评审成员')) reply = options.review ?? JSON.stringify({ verdict: 'approved', summary: 'Checked actual files and command evidence', findings: [] })
      else if (text.includes('规划') && !text.includes('本任务：')) reply = JSON.stringify({ tasks: options.suggest ?? tasks })
      else {
        active.add(id); peak = Math.max(peak, active.size)
        if (options.permission) {
          const permission = await rpc.request<{ outcome: { outcome: string } }>(ACP_METHODS.requestPermission, { sessionId: id, toolCall: { toolCallId: id, title: '实现项目任务' }, options: [{ optionId: 'yes', name: '允许一次', kind: 'allow_once' }] }, 0)
          if (permission.outcome.outcome === 'cancelled') { active.delete(id); return { stopReason: 'cancelled' } }
        }
        if (options.hold) { await new Promise<void>(r => { unblock = r }); active.delete(id); return { stopReason: 'cancelled' } }
        await new Promise(r => setTimeout(r, 40))
        const alpha = text.includes('本任务：Alpha')
        if (options.dependency && !alpha) expect(readFileSync(join(currentCwd, 'alpha.txt'), 'utf8')).toBe('alpha\n')
        writeFileSync(join(currentCwd, options.conflict ? 'README.md' : alpha ? 'alpha.txt' : 'beta.txt'), alpha ? 'alpha\n' : 'beta\n')
        reply = 'Actual implementation finished. Claimed tests passed (not evidence).'; active.delete(id)
      }
      rpc.notify(ACP_METHODS.sessionUpdate, { sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: reply } } })
      return { stopReason: 'end_turn' }
    })
    return client
  } })
  const file = join(root, 'rooms.json'), store = new RoleRoomStore(file), rooms = new RoleRooms(host, store)
  rooms.create({ id: 'room', name: 'Project Team', cwd, coordinatorId: 'reviewer', roles: [
    { id: 'front', name: 'Frontend', engineId: 'tool-a', instruction: 'Implement frontend', capabilities: ['frontend'] },
    { id: 'back', name: 'Backend', engineId: 'tool-b', instruction: 'Implement backend', capabilities: ['backend'] },
    { id: 'reviewer', name: 'Reviewer', engineId: 'tool-c', instruction: 'Plan and review', capabilities: ['planning', 'review'] },
  ] }, scope)
  const input: ProjectWorkflowInput & { action: string } = { action: 'prepare', id: randomUUID(), goal: 'Implement two independently verifiable files', tasks: structuredClone(tasks), reviewerId: 'reviewer', maxParallel: 2,
    checks: [{ id: 'files', command: process.execPath, args: ['-e', options.failCheck ? `process.exit(require('node:fs').existsSync(${JSON.stringify(join(root, 'allow-validation'))})?0:7)` : "const fs=require('node:fs');for(const n of ['alpha','beta'])if(fs.readFileSync(n+'.txt','utf8')!==n+'\\n')process.exit(2)"] }] }
  if (options.dependency) input.tasks![1]!.dependsOn = ['alpha']
  cleanup.push(() => { rooms.dispose(); host.closeAll(); rmSync(root, { recursive: true, force: true }) })
  const current = () => rooms.view('room', scope).workflows!.at(-1)!
  const prepare = () => rooms.workflow('room', input, scope)
  const action = (action: string) => rooms.workflow('room', { action, runId: input.id }, scope)
  const finish = async () => { await wait(() => !rooms.view('room', scope).busy); return current() }
  return { root, cwd, base, rooms, host, asks, store, file, prompts, modeChanges, input, current, prepare, action, finish, peak: () => peak }
}

describe('project practice in real isolated repositories (model transport fixture)', () => {
  it('selects the advertised native manual approval mode before any workflow prompt', async () => {
    const f = fixture({ initialMode: 'auto', permission: true }); await f.prepare(); await f.action('run')
    await wait(() => f.asks.list(scope, { status: 'pending' }).length === 2)
    f.asks.list(scope, { status: 'pending' }).forEach(ask => f.asks.answer(ask.id, 'yes', scope))
    expect((await f.finish()).state).toBe('ready')
    expect(f.prompts).toHaveLength(3)
    expect(f.modeChanges).toEqual(['default', 'default', 'default'])
  }, 30_000)
  it('preserves the native planning mode without enabling write permissions', async () => {
    const f = fixture({ initialMode: 'plan' }); await f.prepare(); await f.action('suggest')
    expect((await f.finish()).state).toBe('draft')
    expect(f.current().error).toBeUndefined()
    expect(f.prompts).toHaveLength(1)
    expect(f.modeChanges).toEqual([])
    expect(git(f.cwd, 'status', '--porcelain')).toBe('')
  }, 30_000)
  it('keeps the original draft runnable when an AI plan is invalid', async () => {
    const f = fixture({ suggest: [] }); await f.prepare(); await f.action('suggest')
    const draft = await f.finish()
    expect(draft.state).toBe('draft'); expect(draft.error).toBeTruthy()
    expect(draft.tasks.every(task => task.state === 'pending')).toBe(true)
    await f.action('run'); expect((await f.finish()).state).toBe('ready')
  }, 30_000)
  it('retains a recoverable record if saving the successful merge receipt fails', async () => {
    const f = fixture(); await f.prepare(); await f.action('run'); const run = await f.finish()
    const originalPut = f.store.put.bind(f.store)
    let rejected = false
    const save = vi.spyOn(f.store, 'put').mockImplementation(room => {
      if (!rejected && room.workflows?.at(-1)?.state === 'merged') { rejected = true; throw new Error('fixture storage unavailable') }
      originalPut(room)
    })
    await f.action('merge'); const interrupted = await f.finish()
    expect(interrupted.state).toBe('failed'); expect(interrupted.mergedAt).toBeUndefined()
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(run.commit)
    expect(new RoleRoomStore(f.file).get('room')?.workflows?.[0]?.state).toBe('failed')
    save.mockRestore()
    const prompts = f.prompts.length
    await f.action('reconcile'); expect((await f.finish()).state).toBe('merged')
    expect(f.prompts).toHaveLength(prompts)
  }, 30_000)
  it('runs independent tasks, real checks and separate review; only explicit merge changes the source checkout', async () => {
    const f = fixture(); await f.prepare(); await f.action('run'); const run = await f.finish()
    expect(run.error).toBeUndefined(); expect(run.state).toBe('ready'); expect(f.peak()).toBe(2)
    expect(run.tasks.map(t => t.roleId)).toEqual(['front', 'back'])
    expect(run.tasks.every(t => t.changes?.files.length === 1 && t.changes.head !== f.base)).toBe(true)
    expect(run.results).toMatchObject([{ state: 'passed', exitCode: 0, commit: run.commit }]); expect(run.review?.commit).toBe(run.commit)
    expect(f.prompts.every(p => p.cwd !== f.cwd && p.text.includes('PROJECT_RULE_2026'))).toBe(true)
    for (const task of run.tasks) expect(f.rooms.sessionOwner(task.sessionId!, scope)?.id).toBe('room')
    expect(new RoleRoomStore(f.file).get('room')?.workflows?.[0]?.review).toEqual(run.review)
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.base); expect(git(f.cwd, 'status', '--porcelain')).toBe('')
    await f.action('merge'); expect((await f.finish()).state).toBe('merged')
    expect(readFileSync(join(f.cwd, 'alpha.txt'), 'utf8')).toBe('alpha\n'); expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(run.commit)
    await f.action('merge'); expect(f.current().state).toBe('merged')
  }, 30_000)
  it('passes actual dependency commits to downstream workspaces', async () => {
    const f = fixture({ dependency: true }); await f.prepare(); await f.action('run'); const run = await f.finish()
    expect(run.error).toBeUndefined(); expect(run.state).toBe('ready'); expect(f.peak()).toBe(1)
    expect(readFileSync(join(run.tasks[1]!.workspace!.path, 'alpha.txt'), 'utf8')).toBe('alpha\n')
  }, 30_000)
  it('does not accept a model claim when the real validation command fails', async () => {
    const f = fixture({ failCheck: true }); await f.prepare(); await f.action('run'); const run = await f.finish()
    expect(run.state).toBe('failed'); expect(run.results[0]).toMatchObject({ state: 'failed', exitCode: 7 })
    expect(run.review).toBeUndefined(); await expect(f.action('merge')).rejects.toThrow('通过')
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.base)
  }, 30_000)
  it('keeps conflicting task changes and never touches the original checkout', async () => {
    const f = fixture({ conflict: true }); await f.prepare(); await f.action('run'); const run = await f.finish()
    expect(run.state).toBe('failed'); expect(run.conflicts).toContain('README.md'); expect(run.integration?.path).toBeTruthy()
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.base); expect(readFileSync(join(f.cwd, 'README.md'), 'utf8')).toBe('initial\n')
  }, 30_000)
  it('refuses stale rule snapshots before invoking engines and preserves unrelated local edits', async () => {
    const f = fixture(); await f.prepare(); writeFileSync(join(f.cwd, 'AGENTS.md'), 'changed rules')
    await f.action('run'); expect((await f.finish()).state).toBe('failed'); expect(f.prompts).toHaveLength(0)
    expect(readFileSync(join(f.cwd, 'AGENTS.md'), 'utf8')).toBe('changed rules')
  })
  it('keeps the prepared request idempotent and scopes every operation to its owner', async () => {
    const f = fixture(); await f.prepare(); await f.prepare(); expect(f.rooms.view('room', scope).workflows).toHaveLength(1)
    await expect(f.rooms.workflow('room', { ...f.input, goal: 'different' }, scope)).rejects.toThrow('不同配置')
    await expect(f.rooms.workflow('room', { action: 'run', runId: f.input.id }, { ...scope, userId: 'other' })).rejects.toThrow('不存在')
    await f.action('run'); await f.finish(); const count = f.prompts.length; await f.action('run'); expect(f.prompts).toHaveLength(count)
  }, 30_000)
  it('records a negative independent review and blocks integration', async () => {
    const f = fixture({ review: JSON.stringify({ verdict: 'changes_requested', summary: 'Missing requirement', findings: ['Add coverage'] }) })
    await f.prepare(); await f.action('run'); const run = await f.finish()
    expect(run.state).toBe('failed'); expect(run.review?.findings).toEqual(['Add coverage']); await expect(f.action('merge')).rejects.toThrow('通过')
  }, 30_000)
  it('reruns validation on retained changes without replaying implementation and retains earlier evidence', async () => {
    const f = fixture({ failCheck: true }); await f.prepare(); await f.action('run'); const failed = await f.finish()
    writeFileSync(join(f.root, 'allow-validation'), 'ready')
    const implementationCalls = f.prompts.filter(p => p.text.includes('本任务：')).length
    await f.action('validate'); const run = await f.finish()
    expect(run.error).toBeUndefined(); expect(run.state).toBe('ready')
    expect(run.previousEvidence?.[0]?.results[0]?.exitCode).toBe(7)
    expect(run.results[0]).toMatchObject({ exitCode: 0, state: 'passed', commit: failed.commit })
    expect(f.prompts.filter(p => p.text.includes('本任务：'))).toHaveLength(implementationCalls)
  }, 30_000)
  it('reconciles a persisted merge interruption without sending any new engine request', async () => {
    const f = fixture(); await f.prepare(); await f.action('run'); await f.finish(); await f.action('merge'); await f.finish()
    const stored = f.store.get('room')!, count = f.prompts.length
    stored.workflows![0]!.state = 'merging'; delete stored.workflows![0]!.mergedAt; f.store.put(stored)
    const rooms = new RoleRooms(f.host, new RoleRoomStore(f.file))
    expect(rooms.view('room', scope).workflows![0]!.state).toBe('interrupted')
    await rooms.workflow('room', { action: 'reconcile', runId: f.input.id }, scope)
    await wait(() => !rooms.view('room', scope).busy)
    expect(rooms.view('room', scope).workflows![0]!.error).toBeUndefined()
    expect(rooms.view('room', scope).workflows![0]!.state).toBe('merged'); expect(f.prompts).toHaveLength(count)
    rooms.dispose()
  }, 30_000)
  it('keeps retired planning sessions owned by their group', async () => {
    const f = fixture(); await f.prepare(); await f.action('suggest'); const first = (await f.finish()).plannerSessionId!
    await f.action('suggest'); const run = await f.finish()
    expect(run.plannerSessionId).not.toBe(first); expect(run.sessionHistory).toContain(first)
    expect(f.rooms.sessionOwner(first, scope)?.id).toBe('room')
  }, 30_000)
  it('uses a real coordinator session for suggestions then returns an editable draft', async () => {
    const f = fixture(); delete f.input.tasks; await f.prepare(); expect(f.current().tasks).toHaveLength(1)
    await f.action('suggest'); const run = await f.finish()
    expect(run.error).toBeUndefined(); expect(run.state).toBe('draft'); expect(run.tasks).toHaveLength(2); expect(run.plannerSessionId).toBeTruthy()
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.base)
  }, 30_000)
  it('persists interrupted work without replay and attributes native approval to the workflow session', async () => {
    const f = fixture({ permission: true }); await f.prepare(); await f.action('run')
    await wait(() => f.asks.list(scope, { status: 'pending' }).length > 0)
    const ask = f.asks.list(scope, { status: 'pending' })[0]!
    expect(f.rooms.sessionOwner(ask.source.session_ref!, scope)?.id).toBe('room')
    const restored = new RoleRoomStore(f.file).get('room')!.workflows![0]!
    expect(restored.state).toBe('interrupted'); expect(restored.tasks.some(t => t.state === 'interrupted')).toBe(true)
    f.rooms.stop('room', scope); expect((await f.finish()).state).toBe('cancelled')
    expect(git(f.cwd, 'rev-parse', 'HEAD')).toBe(f.base)
  }, 30_000)
})

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AttachmentStore } from '../src/attachment-store.ts'
import { RoleRooms } from '../src/role-rooms.ts'
import { RoleRoomStore } from '../src/role-room-store.ts'
import type { RoomEvent } from '../src/role-room-events.ts'
import { ROOM_LIMITS } from '../src/role-room-model.ts'
import type { AgentSkills } from '../src/prompt-context.ts'
import { modelEngine, modelScope as scope } from './fixtures/model-engine.ts'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(f => f()); vi.restoreAllMocks() })
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(r => setTimeout(r, 5)) } throw new Error('timeout') }
function fixture(skills?: AgentSkills) {
  const f = modelEngine(), file = join(f.dir, 'rooms.json'), store = new RoleRoomStore(file), attachments = new AttachmentStore(join(f.dir, 'attachments'))
  const rooms = new RoleRooms(f.host, store, attachments, skills)
  const config = { id: 'team', name: 'Topic', cwd: f.dir, coordinatorId: 'helper', roles: [
    { id: 'helper', name: 'Helper', engineId: 'test', instruction: 'Investigate' },
    { id: 'reviewer', name: 'Reviewer', engineId: 'test', instruction: 'Review' },
  ] }
  rooms.create(config, scope); cleanups.push(f.cleanup, () => rooms.dispose())
  return { ...f, file, store, rooms, attachments, config }
}
describe('persistent topics, incremental updates and execution capacity', () => {
  it('continues beyond the topic budget with a visible idempotent summary and searchable archived history', async () => {
    const f = fixture()
    for (let n = 0; n < ROOM_LIMITS.turns; n++) {
      f.rooms.send('team', { id: `turn-${n}`, text: `evidence-${n}`, mode: 'direct', targetRoleId: 'helper' }, scope)
      await until(() => !f.rooms.view('team', scope).busy)
    }
    expect(() => f.rooms.send('team', { id: 'extra', text: 'more', mode: 'relay' }, scope)).toThrow('继续新话题')
    const input = { id: 'next', name: 'Next topic', summary: 'Evidence: README.md; completed review. Continue implementation.' }
    const next = f.rooms.continueTopic('team', input, scope)
    expect(next).toMatchObject({ id: 'next', turns: [], handoff: { roomId: 'team', summary: input.summary } })
    expect(next.roles.every(r => !r.sessionId)).toBe(true)
    expect(f.rooms.continueTopic('team', input, scope).id).toBe('next')
    expect(f.rooms.list(scope).map(r => r.id)).toEqual(['next'])
    expect(f.rooms.list(scope, { includeArchived: true, q: 'evidence-0' }).map(r => r.id)).toEqual(['team'])
    expect(f.rooms.view('team', scope).turns).toHaveLength(24)
    expect(f.host.list(scope).every(s => s.state === 'detached')).toBe(true)
    const loaded = new RoleRoomStore(f.file)
    expect(loaded.get('next')?.handoff?.summary).toBe(input.summary)
    expect(() => f.rooms.continueTopic('team', { ...input, summary: 'Different' }, scope)).toThrow('冲突')
    const dispatch = vi.spyOn(f.host, 'prompt')
    f.rooms.send('next', { id: 'continued', text: 'Continue', mode: 'relay' }, scope)
    await until(() => !f.rooms.view('next', scope).busy)
    expect(f.rooms.view('next', scope).turns[0]?.state).toBe('completed')
    expect(String(dispatch.mock.calls[0]?.[2])).toContain(input.summary)
  })
  it('uses a summary index without loading other bodies, pages history, and archives without consuming the active-topic cap', async () => {
    const f = fixture()
    for (let i = 0; i < 3; i++) { f.rooms.send('team', { id: `t${i}`, text: `task ${i}`, mode: 'relay' }, scope); await until(() => !f.rooms.view('team', scope).busy) }
    const read = vi.spyOn(f.store, 'get'); f.rooms.list(scope); expect(read).not.toHaveBeenCalled(); read.mockRestore()
    expect(f.rooms.history('team', scope, undefined, 2)).toMatchObject({ turns: [{ id: 't1' }, { id: 't2' }], nextCursor: 't1' })
    expect(f.rooms.history('team', scope, 't1', 2).turns.map(t => t.id)).toEqual(['t0'])
    expect(() => f.rooms.history('team', scope, 'missing', 2)).toThrow('游标')
    for (let i = 0; i < ROOM_LIMITS.rooms + 2; i++) { const id = `archive${i}`; f.rooms.create({ ...f.config, id }, scope); f.rooms.metadata(id, { archived: true }, scope) }
    expect(f.rooms.list(scope)).toHaveLength(1)
    expect(f.rooms.list(scope, { includeArchived: true })).toHaveLength(ROOM_LIMITS.rooms + 3)
    const manifest = JSON.parse(readFileSync(f.file, 'utf8'))
    expect(manifest.version).toBe(2); expect(manifest.rooms[0]).not.toHaveProperty('turns')
    expect(readdirSync(`${f.file}.rooms`)).toHaveLength(ROOM_LIMITS.rooms + 3)
  })
  it('migrates v1 only after a successful write and retains the old public transcript', () => {
    const f = fixture(), old = f.store.list(), legacy = join(f.dir, 'legacy.json')
    writeFileSync(legacy, JSON.stringify({ version: 1, rooms: old, agents: [] }))
    const migrated = new RoleRoomStore(legacy)
    expect(JSON.parse(readFileSync(legacy, 'utf8')).version).toBe(1)
    migrated.put({ ...migrated.get('team')!, pinned: true })
    expect(JSON.parse(readFileSync(legacy, 'utf8')).version).toBe(2)
    expect(new RoleRoomStore(legacy).get('team')).toMatchObject({ ...old[0], pinned: true })
  })
  it('rejects insufficient capacity before accepting or dispatching any role and releases its workspace lease', () => {
    const f = fixture(); vi.spyOn(f.host, 'ensureCapacity').mockImplementationOnce(() => { throw new Error('capacity exhausted') })
    expect(() => f.rooms.send('team', { id: 'capacity', text: 'work', mode: 'relay' }, scope)).toThrow('capacity exhausted')
    expect(f.rooms.view('team', scope).turns).toEqual([]); expect(f.prompts).toEqual([])
    expect(f.host.workspaceBusy(f.dir)).toBe(false)
  })
  it('connects every planned role before dispatch and reports setup failures without a partial relay', async () => {
    const f = fixture(), create = f.host.createSession.bind(f.host)
    vi.spyOn(f.host, 'createSession').mockImplementationOnce(create).mockRejectedValueOnce(new Error('second engine unavailable'))
    f.rooms.send('team', { id: 'setup', text: 'work', mode: 'relay' }, scope)
    await until(() => !f.rooms.view('team', scope).busy)
    expect(f.prompts).toEqual([])
    expect(f.rooms.view('team', scope).turns[0]).toMatchObject({ state: 'failed', error: 'second engine unavailable' })
    expect(f.host.workspaceBusy(f.dir)).toBe(false)
  })
  it('holds the shared workspace lease while awaiting Skill loading and releases it after completion', async () => {
    let finish!: (text: string) => void
    const f = fixture({ list: vi.fn(), load: () => new Promise(resolve => { finish = resolve }) })
    const solo = await f.host.createSession({ ...scope, engineId: 'test', cwd: f.dir })
    f.rooms.send('team', { id: 'skills', text: 'work', mode: 'relay', skills: ['review'] }, scope)
    expect(f.host.prompt(solo.id, scope, 'conflicting work')).toMatchObject({ ok: false })
    expect(f.host.workspaceBusy(f.dir)).toBe(true)
    finish('Skill body'); await until(() => !f.rooms.view('team', scope).busy)
    expect(f.host.workspaceBusy(f.dir)).toBe(false)
    expect(f.rooms.view('team', scope).turns[0]?.state).toBe('completed')
  })
  it('sends revision deltas, replays missed updates, and falls back to a snapshot after restart', () => {
    const f = fixture(), events: RoomEvent[] = [], detach = f.rooms.subscribe('team', scope, undefined, e => events.push(e))
    expect(events[0]?.type).toBe('room.snapshot')
    const revision = f.rooms.view('team', scope).revision!
    f.rooms.metadata('team', { name: 'Renamed', pinned: true }, scope)
    expect(events.at(-1)).toMatchObject({ type: 'room.changed', change: { name: 'Renamed', pinned: true, refresh: true } })
    detach(); const replay: RoomEvent[] = []; f.rooms.subscribe('team', scope, revision, e => replay.push(e))()
    expect(replay).toHaveLength(1); expect(replay[0]?.type).toBe('room.changed')
    const restored = new RoleRooms(f.host, new RoleRoomStore(f.file)), snapshots: RoomEvent[] = []
    restored.subscribe('team', scope, revision, e => snapshots.push(e))()
    expect(snapshots[0]?.type).toBe('room.snapshot')
  })
  it('publishes immutable role-session references as each relay member connects', async () => {
    const f = fixture(), events: RoomEvent[] = []
    const detach = f.rooms.subscribe('team', scope, f.rooms.view('team', scope).revision, event => events.push(event))
    f.rooms.send('team', { id: 'members', text: 'work', mode: 'relay' }, scope)
    await until(() => !f.rooms.view('team', scope).busy)
    const roles = f.rooms.view('team', scope).roles
    expect(events).toContainEqual(expect.objectContaining({ type: 'room.changed', change: expect.objectContaining({
      roleSessions: { helper: roles[0]!.sessionId, reviewer: null },
    }) }))
    expect(events.at(-1)).toMatchObject({ type: 'room.changed', change: { roleSessions: { helper: roles[0]!.sessionId, reviewer: roles[1]!.sessionId } } })
    detach()
  })
  it('keeps attachment references through archive and release and frees them only when history is deleted', async () => {
    const f = fixture(), ref = f.attachments.upload({ name: 'context.txt', mimeType: 'text/plain', data: Buffer.from('evidence').toString('base64') }, scope)
    f.rooms.send('team', { id: 'files', text: 'read', mode: 'relay', attachments: [ref] }, scope)
    await until(() => !f.rooms.view('team', scope).busy)
    f.rooms.metadata('team', { archived: true }, scope)
    expect(f.attachments.collect(scope, { graceMs: 0 }).removedFiles).toBe(0)
    f.rooms.release('team', scope, true)
    expect(f.attachments.collect(scope, { graceMs: 0 })).toMatchObject({ removedFiles: 1, freedBytes: ref.size })
  })
})

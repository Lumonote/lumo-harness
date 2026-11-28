import { readFileSync, statSync, symlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RoleRoomStore } from '../src/role-room-store.ts'
import { RoleRooms } from '../src/role-rooms.ts'
import { modelEngine, modelScope as scope } from './fixtures/model-engine.ts'

const cleanups: Array<() => void> = []
afterEach(() => { cleanups.splice(0).reverse().forEach(fn => fn()); vi.restoreAllMocks() })
const fixture = () => {
  const f = modelEngine(), file = join(f.dir, 'rooms.json'), store = new RoleRoomStore(file), rooms = new RoleRooms(f.host, store)
  cleanups.push(f.cleanup, () => rooms.dispose())
  const agent = rooms.saveAgent({ id: 'helper', name: 'a'.repeat(60), engineId: 'test', instruction: '检查工作区', modelId: 'large', userId: 'spoofed', sessionId: 'foreign' }, scope)
  const config = { id: 'team', name: 'Team', cwd: f.dir, coordinatorId: agent.id, roles: [
    { ...agent, agentId: agent.id }, { id: 'reviewer', name: 'Reviewer', engineId: 'test', instruction: '复核' },
  ] }
  rooms.create(config, scope)
  return { ...f, file, store, rooms, agent, config }
}

describe('reusable agents and model-aware groups', () => {
  it('persists only profile configuration under trusted identity, while groups keep their own snapshots', () => {
    const f = fixture()
    expect(f.agent).toMatchObject({ ...scope, name: 'a'.repeat(60), modelId: 'large' }); expect(f.agent).not.toHaveProperty('sessionId')
    expect(statSync(f.file).mode & 0o777).toBe(0o600)
    expect(new RoleRoomStore(f.file).listAgents(scope)).toEqual([f.agent])
    f.rooms.saveAgent({ ...f.agent, name: 'Changed', modelId: 'small' }, scope)
    expect(f.rooms.view('team', scope).roles[0]).toMatchObject({ name: f.agent.name, modelId: 'large', agentId: 'helper' })
    f.rooms.removeAgent(f.agent.id, scope)
    expect(f.rooms.listAgents(scope)).toEqual([]); expect(f.rooms.view('team', scope).roles).toHaveLength(2)
    expect(readFileSync(f.file, 'utf8')).not.toContain('spoofed')
  })
  it.each([{ ...scope, userId: 'other' }, { ...scope, realm: 'other' }, { ...scope, projectId: 'other' }])('isolates profile reads and edits from %j', other => {
    const f = fixture()
    expect(f.rooms.listAgents(other)).toEqual([])
    expect(() => f.rooms.saveAgent(f.agent, other)).toThrow('冲突')
    expect(() => f.rooms.removeAgent(f.agent.id, other)).toThrow('不存在')
    expect(f.rooms.listAgents(scope)).toEqual([f.agent])
  })
  it('connects without a prompt, switches the real session, and reuses the choice after release', async () => {
    const f = fixture()
    const connected = await f.rooms.connectRole('team', 'helper', scope), id = connected.roles[0]!.sessionId!
    expect(connected.sessionModels?.helper?.currentModelId).toBe('large'); expect(f.prompts).toEqual([])
    await f.rooms.setModel('team', 'helper', 'small', scope)
    expect(f.host.get(id, scope)?.modelId).toBe('small')
    expect(new RoleRoomStore(f.file).get('team')!.roles[0]!.modelId).toBe('small')
    expect(f.rooms.sessionOwner(id, scope)?.id).toBe('team')
    f.rooms.release('team', scope)
    expect(f.rooms.sessionOwner(id, scope)?.id).toBe('team')
    const next = await f.rooms.connectRole('team', 'helper', scope)
    expect(next.roles[0]!.sessionId).toBe(id); expect(next.sessionModels?.helper?.currentModelId).toBe('small')
  })
  it('keeps the live session owned and visible if the first group-handle write fails', async () => {
    const f = fixture(), write = vi.spyOn(f.store, 'put').mockImplementation(() => { throw new Error('disk unavailable') })
    await expect(f.rooms.connectRole('team', 'helper', scope)).rejects.toThrow('disk unavailable')
    const room = f.rooms.view('team', scope), id = room.roles[0]!.sessionId!
    expect(room.busy).toBe(false); expect(room.error).toContain('保存失败')
    expect(f.host.get(id, scope)).toBeDefined(); expect(f.rooms.sessionOwner(id, scope)?.id).toBe('team')
    write.mockRestore()
    const retried = await f.rooms.connectRole('team', 'helper', scope)
    expect(retried.roles[0]!.sessionId).toBe(id); expect(f.host.list(scope)).toHaveLength(1)
    expect(retried.error).toBeUndefined(); expect(f.prompts).toEqual([])
  })
  it('retains the actual selected model when persisting a group model fails and retries the write', async () => {
    const f = fixture(); await f.rooms.connectRole('team', 'helper', scope)
    const write = vi.spyOn(f.store, 'put').mockImplementation(() => { throw new Error('read-only disk') })
    await expect(f.rooms.setModel('team', 'helper', 'small', scope)).rejects.toThrow('read-only disk')
    expect(f.rooms.view('team', scope)).toMatchObject({ busy: false, error: expect.stringContaining('保存失败'), roles: [expect.objectContaining({ modelId: 'small' }), expect.anything()] })
    write.mockRestore(); f.rooms.release('team', scope)
    expect(new RoleRoomStore(f.file).get('team')!.roles[0]!.modelId).toBe('small')
  })
  it('treats a running independent session reached through a symlink as the same workspace', async () => {
    const f = fixture(), alias = `${f.dir}-alias`
    symlinkSync(f.dir, alias); cleanups.push(() => rmSync(alias))
    const s = await f.host.createSession({ ...scope, engineId: 'test', cwd: alias })
    f.peers[0]!.onRequest('session/prompt', () => new Promise(() => {}))
    expect(f.host.prompt(s.id, scope, 'working').ok).toBe(true)
    expect(() => f.rooms.send('team', { id: 'turn', text: 'work', mode: 'relay' }, scope)).toThrow('仍有引擎在执行')
  })
})

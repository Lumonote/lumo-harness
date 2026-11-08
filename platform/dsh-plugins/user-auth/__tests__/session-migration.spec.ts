import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, link, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import AgentLoop from '../../../../deepseek-harness/packages/core/agent-loop/lib/index.js'
import { MockAdapter, textResponse } from '../../../../deepseek-harness/packages/core/agent-loop/tests/mock-adapter.ts'
import { createUserMessage } from '../../../../deepseek-harness/packages/llm/llm/lib/index.js'
import { SessionId } from '../../../../deepseek-harness/packages/core/session/lib/index.js'
import * as JsonlPersistence from '../../../../deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'
import { mountAgentLoopTestDependencies } from '../../../../deepseek-harness/packages/test-support/agent-loop-testkit/lib/index.js'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import type { ObjectStoreSeam } from '../../../shared/seam-contracts/object-store.ts'
import { SessionExecutionClient, SessionExecutionRuntime } from '../../../shared/session-execution.ts'
import { OwnedSessionMigration, SessionMigrationClient, type MigrationReceipt } from '../src/session-migration.ts'
import { captureWorkspace, MIGRATION_FILE_MAX_BYTES, parseMigrationSnapshot, restoreMigrationSnapshot, snapshotHash, type MigrationSnapshot } from '../src/session-migration-snapshot.ts'
import type { SessionTransportConfig } from '../src/session-transport.ts'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const close of closers.splice(0).reverse()) await close() })
const signal = new AbortController().signal
const ref = `session-${'a'.repeat(32)}`
const alice = { realm: 'r', user_id: 'alice', username: 'alice', display_name: 'Alice', roles: ['operator'], session_expires_at: '2099-01-01' }
const authority = Object.assign(async () => alice, { credential: 'login-secret' })

it('treats a malformed successful mutation receipt as unknown until independently queried', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ migration: { state: 'activated' } })))
  const client = new SessionMigrationClient('https://authority.example', 'service', fetcher)
  await expect(client.call(ref, '/checkpoint', { frozen: true }, signal)).rejects.toMatchObject({ code: 'session_migration_unknown' })
  await expect(client.call(ref, '/mig_fixture/activate', { imported: true }, signal)).rejects.toMatchObject({ code: 'session_migration_unknown' })
  await expect(client.get('r', ref, undefined, signal)).rejects.toMatchObject({ code: 'session_migration_unavailable' })
})

async function fixture() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'lumo-session-migration-')))
  closers.push(() => rm(temp, { recursive: true, force: true }))
  const workspaceRoot = join(temp, 'workspaces'); await mkdir(workspaceRoot); await mkdir(join(workspaceRoot, ref))
  const objects = new Map<string, Buffer>()
  const store: ObjectStoreSeam = {
    put: async (realm, key, body) => { objects.set(`${realm}/${key}`, Buffer.from(body)) },
    get: async (realm, key) => { const body = objects.get(`${realm}/${key}`); return body ? { body } : undefined },
    stat: async (realm, key) => { const body = objects.get(`${realm}/${key}`); return body ? { bytes: body.length } : undefined },
    delete: async () => { throw Error('checkpoint deletion is not part of migration') }, putContent: async () => { throw Error('wrong namespace') },
  }
  const owner = { session_ref: ref, realm: 'r', owner_user_id: 'alice', project_id: 'p', node_id: 'a', parent_session_ref: 'session-parent', state: 'active', created_at: '2026-11-08' }
  let receipt: MigrationReceipt | undefined, unknownActivation = false, checkpoints = 0
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    if (path.startsWith('/v1/session-owners/')) return new Response(JSON.stringify({ owner }))
    if (!init?.body) return receipt ? new Response(JSON.stringify({ migration: receipt })) : new Response('{}', { status: 404 })
    const body = JSON.parse(String(init.body))
    if (path.endsWith('/checkpoint')) {
      checkpoints++
      receipt = { ...body, session_ref: ref, realm: 'r', project_id: 'p', source_node_id: 'a', source_process_id: 'process-a', source_node_fence: 1, source_fencing_token: 1, state: 'checkpointed', created_at: '2026-11-08' }
    } else if (path.endsWith('/activate')) {
      owner.node_id = 'b'; receipt!.state = 'activated'
      if (unknownActivation) { unknownActivation = false; throw Error('connection lost after commit') }
    } else throw Error('unexpected authority route')
    return new Response(JSON.stringify({ migration: receipt }))
  })
  async function node(id: 'a' | 'b') {
    const ctx = new Context(); closers.push(() => ctx.fiber.dispose())
    await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
    await ctx.plugin(JsonlPersistence, { root: join(temp, `home-${id}`), compression: 'none' })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter([textResponse('original reply'), textResponse('explicit followup reply')]); ctx.llm.registerAdapter(['mock'], adapter)
    ctx.provide('objectStore', store)
    ctx.provide('sessionLogReplication', { flush: () => ctx.sessionPersistence.flush(), health: () => ({ ready: true, pending: 0 }) })
    ctx.provide('sessionLog', { read: async () => ctx.agents.get(SessionId(ref))!.session.snapshotEvents().map(event => ({ seq: event.seq, payload: event })) } as never)
    const orphans = vi.fn(async () => [] as unknown[]); ctx.provide('recovery', { orphans } as never)
    let handle: AgentHandle | undefined
    const retired = vi.fn(async () => {})
    const runtime = { signal: new AbortController().signal, check: async () => {}, ensure: vi.fn(async () => {}), proof: async () => ({ realm: 'r', node_id: id, project_id: 'p', process_id: 'process-' + id, endpoint: 'https://' + id + '.example', token: 's'.repeat(64), writer_holder: 'writer-' + id, fencing_token: 1 }), retire: retired, nodeProof: async () => ({ node_id: id }), } as unknown as SessionExecutionRuntime
    const config: SessionTransportConfig = { authorityUrl: 'https://authority.example', nodeId: id, projectId: 'p', workspaceRoot, provider: 'mock', model: 'mock', routing: { routes: { a: 'https://a.example', b: 'https://b.example' }, transportSecurity: 'tls' }, migration: { enabled: true } }
    const resume = vi.fn(async () => { handle = await ctx.agents.resume({ resumeSessionId: SessionId(ref), agentOptions: { provider: 'mock', model: 'mock' } }) })
    const host = {
      async quiesce<T>(_ref: string, _signal: AbortSignal, run: () => Promise<T>) {
        const agent = ctx.agents.get(SessionId(ref))!
        if (agent.status !== 'idle' || agent.inbox.nextTurn.length || agent.inbox.nextStep.length) throw Error('busy')
        return agent.runMaintenance(() => run())
      },
      async close() { await handle?.dispose() }, resume,
    }
    const project = vi.fn(async () => {})
    const migration = new OwnedSessionMigration(ctx, config, 'service', runtime, ctx.sessionPersistence, host, project, fetcher)
    const create = async () => { handle = await ctx.agents.create({ sessionId: SessionId(ref), meta: { cwd: join(workspaceRoot, ref), parentSession: SessionId('session-parent'), delegationDepth: 2 }, agentOptions: { provider: 'mock', model: 'mock' } }); return handle.agent }
    return { ctx, adapter, migration, create, retired, resume, project, config, runtime, host, orphans }
  }
  return { temp, workspaceRoot, objects, owner, node, receipt: () => receipt!, checkpoints: () => checkpoints, loseActivation: () => { unknownActivation = true } }
}

it('moves an exact native checkpoint between independent node homes, preserves lineage/files, and never replays old input', async () => {
  const f = await fixture(), source = await f.node('a'), agent = await source.create()
  await mkdir(join(f.workspaceRoot, ref, 'notes')); await writeFile(join(f.workspaceRoot, ref, 'notes', 'proof.txt'), Buffer.from([0, 1, 2, 255]))
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'original prompt' }], source: { kind: 'user' } })); await agent.whenIdle(); await source.ctx.sessionPersistence.flush()
  const original = await source.ctx.sessionPersistence.open(SessionId(ref), 'read')
  const before = { header: original.header, inherited: original.inheritedEventCount, events: (await original.read()).events }; await original.close()
  const pending = await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority) as { migration: MigrationReceipt }
  expect(pending.migration.state).toBe('checkpointed'); expect(source.retired).toHaveBeenCalledWith(ref)
  expect(() => source.migration.enter(ref)).toThrow('session_migration_frozen')
  expect(JSON.stringify(pending)).not.toContain('login-secret'); expect(JSON.stringify(pending)).not.toContain('writer-a')
  // Distinct hosts use the same deployment path on independent filesystems.
  // Move the source directory away to model that isolation on this one host.
  await rename(join(f.workspaceRoot, ref), join(f.temp, 'source-workspace-archive'))
  const target = await f.node('b')
  const result = await target.migration.execute(alice, 'recover', { sessionId: ref, migrationId: pending.migration.id }, signal, authority) as { ready: boolean }
  expect(result.ready).toBe(true); expect(f.owner.node_id).toBe('b'); expect(target.adapter.requests).toHaveLength(0)
  expect(await readFile(join(f.workspaceRoot, ref, 'notes', 'proof.txt'))).toEqual(Buffer.from([0, 1, 2, 255]))
  const imported = await target.ctx.sessionPersistence.open(SessionId(ref), 'read')
  expect(imported.header).toEqual(before.header); expect(imported.inheritedEventCount).toBe(before.inherited)
  expect((await imported.read()).events.slice(0, before.events.length)).toEqual(before.events); await imported.close()
  target.ctx.agents.get(SessionId(ref))!.followup(createUserMessage({ content: [{ type: 'text', text: 'new explicit input' }], source: { kind: 'user' } })); await target.ctx.agents.get(SessionId(ref))!.whenIdle()
  expect(target.adapter.requests).toHaveLength(1)
})

it('queries a committed activation after a lost reply and resumes without importing or replaying twice', async () => {
  const f = await fixture(), source = await f.node('a'); await source.create()
  await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)
  await rename(join(f.workspaceRoot, ref), join(f.temp, 'source-workspace-archive'))
  const target = await f.node('b'); f.loseActivation()
  await expect(target.migration.execute(alice, 'recover', { sessionId: ref, migrationId: f.receipt().id }, signal, authority)).rejects.toMatchObject({ code: 'session_migration_unknown' })
  expect(target.resume).not.toHaveBeenCalled()
  await expect(target.migration.execute(alice, 'migrationStatus', { sessionId: ref }, signal, authority)).resolves.toMatchObject({ migration: { state: 'activated' } })
  await expect(target.migration.execute(alice, 'recover', { sessionId: ref, migrationId: f.receipt().id }, signal, authority)).resolves.toMatchObject({ ready: true })
  expect(target.resume).toHaveBeenCalledOnce(); expect(target.adapter.requests).toHaveLength(0); expect(f.checkpoints()).toBe(1)
})

it('rejects revoked owners, projects, active operations and orphan external effects before freezing', async () => {
  const f = await fixture(), source = await f.node('a'); await source.create()
  await expect(source.migration.execute({ ...alice, user_id: 'bob' }, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)).rejects.toThrow()
  source.project.mockRejectedValueOnce(Error('project revoked'))
  await expect(source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)).rejects.toThrow('project revoked')
  const release = source.migration.enter(ref)
  await expect(source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)).rejects.toMatchObject({ code: 'session_migration_busy' }); release()
  source.orphans.mockResolvedValueOnce([{}])
  await expect(source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)).rejects.toMatchObject({ code: 'session_migration_busy' })
  expect(source.retired).not.toHaveBeenCalled(); expect(f.checkpoints()).toBe(0); expect(() => source.migration.enter(ref)()).not.toThrow()
})

it('refuses altered snapshot bytes and mismatched model policy before owner activation or execution', async () => {
  const f = await fixture(), source = await f.node('a'); await source.create()
  await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)
  const target = await f.node('b'), key = 'r/' + f.receipt().snapshot_key, blob = f.objects.get(key)!
  f.objects.set(key, Buffer.from(blob).fill(32))
  await expect(target.migration.execute(alice, 'recover', { sessionId: ref, migrationId: f.receipt().id }, signal, authority)).rejects.toMatchObject({ code: 'session_migration_invalid' })
  expect(f.owner.node_id).toBe('a'); expect(target.resume).not.toHaveBeenCalled()
  f.objects.set(key, blob)
  const alternate = new OwnedSessionMigration(target.ctx, { ...target.config, model: 'withdrawn' }, 'service', target.runtime, target.ctx.sessionPersistence, target.host, target.project, async () => new Response(JSON.stringify({ migration: f.receipt(), owner: f.owner })))
  await expect(alternate.execute(alice, 'recover', { sessionId: ref, migrationId: f.receipt().id }, signal, authority)).rejects.toMatchObject({ code: 'session_migration_invalid' })
  expect(target.adapter.requests).toHaveLength(0)
})

it('continues a torn staged file and a flushed native log prefix after a target restart', async () => {
  const f = await fixture(), source = await f.node('a'), agent = await source.create()
  await writeFile(join(f.workspaceRoot, ref, 'result.bin'), Buffer.from([1, 2, 3, 4]))
  await writeFile(join(f.workspaceRoot, ref, 'run.sh'), 'exit 0'); await chmod(join(f.workspaceRoot, ref, 'run.sh'), 0o700)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } })); await agent.whenIdle()
  await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)
  const receipt = f.receipt(), snapshot = JSON.parse(f.objects.get('r/' + receipt.snapshot_key)!.toString()) as MigrationSnapshot
  await rename(join(f.workspaceRoot, ref), join(f.temp, 'source-workspace-archive'))
  const staging = await f.node('b')
  await mkdir(join(f.workspaceRoot, '.lumo-migrations'))
  await writeFile(join(f.workspaceRoot, '.lumo-migrations', receipt.id), JSON.stringify({ digest: receipt.snapshot_sha256, sessionRef: ref, phase: 'workspace' }))
  await mkdir(join(f.workspaceRoot, ref)); await writeFile(join(f.workspaceRoot, ref, 'result.bin'), Buffer.from([1]))
  await writeFile(join(f.workspaceRoot, ref, 'run.sh'), 'exit 0', { mode: 0o600 })
  const partial = await staging.ctx.sessionPersistence.create(snapshot.header)
  await partial.append(snapshot.events.slice(0, 3)); await partial.flush(); await partial.close(); await staging.ctx.fiber.dispose()
  const restarted = await f.node('b')
  await expect(restarted.migration.execute(alice, 'recover', { sessionId: ref, migrationId: receipt.id }, signal, authority)).resolves.toMatchObject({ ready: true })
  expect(await readFile(join(f.workspaceRoot, ref, 'result.bin'))).toEqual(Buffer.from([1, 2, 3, 4]))
  expect((await stat(join(f.workspaceRoot, ref, 'run.sh'))).mode & 0o777).toBe(0o700)
  const stored = await restarted.ctx.sessionPersistence.open(SessionId(ref), 'read')
  expect((await stored.read()).events.slice(0, snapshot.events.length)).toEqual(snapshot.events); await stored.close()
  expect(restarted.adapter.requests).toHaveLength(0)
})

it('refuses to adopt an existing target workspace even on a repeated recovery request', async () => {
  const f = await fixture(), source = await f.node('a'); await source.create()
  await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)
  const target = await f.node('b')
  await expect(target.migration.execute(alice, 'recover', { sessionId: ref, migrationId: f.receipt().id }, signal, authority)).rejects.toThrow()
  expect(f.owner.node_id).toBe('a'); expect(target.resume).not.toHaveBeenCalled()
  // The prepared marker has no durable directory-ownership fact. Repeating
  // the request must keep rejecting that pre-existing source directory.
  await expect(target.migration.execute(alice, 'recover', { sessionId: ref, migrationId: f.receipt().id }, signal, authority)).rejects.toThrow()
  expect(f.receipt().state).toBe('checkpointed')
})

it('refuses an unrelated native Session before adopting or modifying its target workspace', async () => {
  const f = await fixture(), source = await f.node('a'); await source.create()
  await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)
  await rename(join(f.workspaceRoot, ref), join(f.temp, 'source-workspace-archive'))
  const target = await f.node('b'); await target.create()
  const original = await target.ctx.sessionPersistence.open(SessionId(ref), 'read')
  const header = original.header; await original.close()
  await expect(target.migration.execute(alice, 'recover', { sessionId: ref, migrationId: f.receipt().id }, signal, authority)).rejects.toThrow()
  const after = await target.ctx.sessionPersistence.open(SessionId(ref), 'read')
  expect(after.header).toEqual(header); await after.close()
  expect(f.receipt().state).toBe('checkpointed'); expect(target.resume).not.toHaveBeenCalled()
})

it('serializes independent target persistence instances before claiming a workspace or advancing its marker', async () => {
  const f = await fixture(), source = await f.node('a'); await source.create()
  await writeFile(join(f.workspaceRoot, ref, 'proof.txt'), 'checkpoint')
  await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)
  const receipt = f.receipt(), snapshot = JSON.parse(f.objects.get('r/' + receipt.snapshot_key)!.toString()) as MigrationSnapshot
  await rename(join(f.workspaceRoot, ref), join(f.temp, 'source-workspace-archive'))
  const first = await f.node('b'), second = await f.node('b')
  await Promise.all([first, second].map(target => restoreMigrationSnapshot(target.ctx.sessionPersistence, f.workspaceRoot, receipt.id, receipt.snapshot_sha256, snapshot, signal)))
  expect(await readFile(join(f.workspaceRoot, ref, 'proof.txt'), 'utf8')).toBe('checkpoint')
  const markers = join(f.workspaceRoot, '.lumo-migrations')
  expect(JSON.parse(await readFile(join(markers, receipt.id), 'utf8'))).toEqual({ digest: receipt.snapshot_sha256, sessionRef: ref, phase: 'workspace' })
  expect(await readdir(markers)).toEqual([receipt.id])
  expect(f.receipt().state).toBe('checkpointed')
})

it('honors a live separate-process import lock and resumes from a complete prepared marker', async () => {
  const f = await fixture(), source = await f.node('a'); await source.create()
  await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)
  const receipt = f.receipt(), snapshot = JSON.parse(f.objects.get('r/' + receipt.snapshot_key)!.toString()) as MigrationSnapshot
  await rename(join(f.workspaceRoot, ref), join(f.temp, 'source-workspace-archive'))
  const target = await f.node('b'), markers = join(f.workspaceRoot, '.lumo-migrations'); await mkdir(markers)
  const marker = join(markers, receipt.id), lock = join(markers, ref)
  const prepared = { digest: receipt.snapshot_sha256, sessionRef: ref, phase: 'prepared' }
  await writeFile(marker, JSON.stringify(prepared))
  // A crash before an atomic rename may leave a temp sibling, but cannot tear
  // the complete old marker or grant ownership over an existing workspace.
  await writeFile(marker + '.orphan.tmp', '{incomplete')
  const module = new URL('../../../../deepseek-harness/packages/util/atomic-write/lib/index.js', import.meta.url).href
  const code = `import { withFileLock } from ${JSON.stringify(module)}; await withFileLock(process.argv[1], async () => { process.stdout.write('locked\\n'); await new Promise(resolve => process.stdin.once('data', resolve)); process.stdin.pause(); });`
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, lock], { stdio: ['pipe', 'pipe', 'pipe'] })
  let error = ''; child.stderr.on('data', chunk => { error += chunk })
  try {
    const [chunk] = await Promise.race([once(child.stdout, 'data'), once(child, 'exit').then(() => { throw Error(error || 'lock holder exited') })])
    expect(String(chunk)).toContain('locked')
    const cancel = new AbortController(), timer = setTimeout(() => cancel.abort(new Error('lock wait cancelled')), 60)
    try { await expect(restoreMigrationSnapshot(target.ctx.sessionPersistence, f.workspaceRoot, receipt.id, receipt.snapshot_sha256, snapshot, cancel.signal)).rejects.toMatchObject({ name: 'AbortError' }) } finally { clearTimeout(timer) }
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual(prepared)
    expect(await readdir(f.workspaceRoot)).toEqual(['.lumo-migrations'])
    const exited = once(child, 'exit'); child.stdin.write('release'); await exited
    await restoreMigrationSnapshot(target.ctx.sessionPersistence, f.workspaceRoot, receipt.id, receipt.snapshot_sha256, snapshot, signal)
    expect(JSON.parse(await readFile(marker, 'utf8')).phase).toBe('workspace')
    expect(f.receipt().state).toBe('checkpointed')
  } finally {
    child.stdin.end()
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited }
  }
})

it('refuses traversal, duplicate files, changed digests and unbalanced turns in a snapshot', async () => {
  const f = await fixture(), source = await f.node('a'); await source.create()
  await source.migration.execute(alice, 'checkpoint', { sessionId: ref, targetNodeId: 'b' }, signal, authority)
  const original = JSON.parse(f.objects.get('r/' + f.receipt().snapshot_key)!.toString()) as MigrationSnapshot
  const expected = { realm: 'r', ownerUserID: 'alice', projectID: 'p', sessionRef: ref, cwd: join(f.workspaceRoot, ref), eventCount: original.events.length, modelPolicySHA: original.modelPolicySHA }
  expect(parseMigrationSnapshot(Buffer.from(JSON.stringify(original)), expected).header).toEqual(original.header)
  for (const path of ['../escape', '/absolute', 'x\\file', 'x/../file', 'x//file', 'x:ads', 'x.']) {
    const value = structuredClone(original); value.workspace = [{ path, kind: 'file', mode: 0o600, bytes: 0, base64: '', sha256: snapshotHash('') }]
    expect(() => parseMigrationSnapshot(Buffer.from(JSON.stringify(value)), expected)).toThrow()
  }
  const open = structuredClone(original); open.events.push({ type: 'turn/start', seq: open.events.length, time: Date.now(), data: { turn: 1 } } as never)
  expect(() => parseMigrationSnapshot(Buffer.from(JSON.stringify(open)), { ...expected, eventCount: open.events.length })).toThrow()
})

it('refuses symlinks, hardlinks and oversized files without reading outside the workspace', async () => {
  const f = await fixture(), directory = join(f.workspaceRoot, ref)
  await writeFile(join(f.temp, 'outside'), 'outside')
  await symlink(join(f.temp, 'outside'), join(directory, 'alias'))
  await expect(captureWorkspace(directory, signal)).rejects.toThrow(); await rm(join(directory, 'alias'))
  await link(join(f.temp, 'outside'), join(directory, 'hard'))
  await expect(captureWorkspace(directory, signal)).rejects.toThrow(); await rm(join(directory, 'hard'))
  await writeFile(join(directory, 'large'), Buffer.alloc(MIGRATION_FILE_MAX_BYTES + 1))
  await expect(captureWorkspace(directory, signal)).rejects.toThrow()
  expect(await readFile(join(f.temp, 'outside'), 'utf8')).toBe('outside')
})

it('retires one execution identity without stopping another Session or allowing a stale renewal', async () => {
  let finish!: (value: Response) => void, delayed = false
  const fetcher = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname, body = JSON.parse(String(init?.body))
    const res = new Response(JSON.stringify(path.includes('/nodes/') ? { node: { ...body, fence: 1 } } : { lease: { ...body, session_ref: path.split('/')[4], node_fence: 1, fencing_token: 1 } }))
    if (delayed && path.includes('/sessions/retired/renew')) return new Promise<Response>(resolve => { finish = resolve })
    return res
  })
  const stop = vi.fn(), runtime = new SessionExecutionRuntime(new SessionExecutionClient('https://authority', 'service', fetcher), 'r', 'a', 'p', 'https://a', 'writer', stop)
  closers.push(() => runtime.dispose()); await runtime.ensure('retired'); delayed = true
  const pending = runtime.ensure('retired'); await vi.waitFor(() => expect(finish).toBeDefined())
  const retirement = runtime.retire('retired'); finish(new Response('{}', { status: 409 }))
  await expect(pending).rejects.toThrow(); await retirement
  await runtime.ensure('other'); await expect(runtime.ensure('retired')).rejects.toThrow()
  expect(runtime.signal.aborted).toBe(false); expect(stop).not.toHaveBeenCalled()
})

import { describe, expect, it, vi } from 'vitest'
import { createThreadControl } from '../src/thread-control.ts'
import { threadRoundRunId, type ThreadRoundAdmissionRequest } from '../src/thread-runner.ts'
import type { ThreadRegistryLike } from '../src/thread-registry.ts'
import type { ThreadRow } from '../src/thread.ts'

const thread: ThreadRow = { id: 'thread-1', realm: 'r1', project_id: 'p1', task_id: 'task-1', node_id: 'n1',
  session_ref: 'stable-1', coordinator_session_ref: 'captain-1', workspace: 'thread/thread-1/', state: 'idle',
  created_at: '2026-11-06T00:00:00Z', updated_at: '2026-11-06T00:00:00Z' }
const binding = { governanceUrl: 'http://governance', projectId: 'p1', agentId: 'a1', presetRevision: 1, provider: 'mock', model: 'mock' }
const request: ThreadRoundAdmissionRequest = { thread, round: { task_id: 'task-1', attempt: 1 },
  runId: threadRoundRunId(thread.id, { task_id: 'task-1', attempt: 1 }, thread.realm), requestHash: 'a'.repeat(64),
  ownerUserId: 'u1', agentId: 'a1', presetRevision: 1, maxConcurrency: 1, provider: 'mock', model: 'mock' }
const input = { thread, round: request.round, prompt: 'Work', parent: { id: 'captain-1' }, signal: new AbortController().signal }
function wireReceipt(extra: Record<string, unknown> = {}) {
  return { realm: 'r1', thread_id: thread.id, task_id: thread.task_id, node_id: thread.node_id,
    coordinator_session_ref: thread.coordinator_session_ref, attempt: 1, request_hash: request.requestHash, run_id: request.runId,
    owner_user_id: 'u1', agent_id: 'a1', preset_revision: 1, max_concurrency: 1, provider: 'mock', model: 'mock', state: 'running', summary: '', session_mode: 'create', ...extra }
}
function authorization(extra: Record<string, unknown> = {}) {
  return { realm: 'r1', user_id: 'u1', project_id: 'p1', task_id: 'task-1', preset: { id: 'a1', realm: 'r1', owner_user_id: 'u1',
    project_id: 'p1', revision: 1, provider: 'mock', model_ref: 'mock', status: 'active', connector_ids: [], knowledge_space_ids: [],
    max_budget_cents: 0, timeout_seconds: 600, max_concurrency: 1, ...extra } }
}
function fixture(response: () => Response = () => Response.json(authorization())) {
  const fetcher = vi.fn(async () => response())
  let current: ThreadRow | undefined = structuredClone(thread)
  const registry = { get: async () => current } as unknown as ThreadRegistryLike
  const control = createThreadControl({ baseUrl: 'http://collaborator', token: 'service-token', userId: 'u1', realm: 'r1',
    binding, registry, fetch: fetcher as typeof fetch })
  return { ...control, fetcher, setCurrent: (value: ThreadRow | undefined) => { current = value } }
}

describe('Thread control-plane boundary', () => {
  it('sends only the configured identity and validates current registry, coordinator and governance profile', async () => {
    const f = fixture()
    await expect(f.authorize(input)).resolves.toEqual({ userId: 'u1', projectId: 'p1', agentId: 'a1', presetRevision: 1, maxConcurrency: 1, provider: 'mock', model: 'mock' })
    const [url, init] = f.fetcher.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('http://governance/v1/runtime/tasks/task-1/thread-authorization')
    expect(init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer service-token', 'x-lumo-realm': 'r1', 'x-lumo-user': 'u1' } })
    expect(JSON.parse(init.body as string)).toEqual({ owner_user_id: 'u1', project_id: 'p1', agent_id: 'a1', preset_revision: 1, provider: 'mock', model: 'mock' })
    for (const row of [undefined, { ...thread, state: 'failed' as const }, { ...thread, session_ref: 'other' }]) {
      f.setCurrent(row)
      await expect(f.authorize(input)).rejects.toThrow()
    }
    f.setCurrent(thread)
    await expect(f.authorize({ ...input, parent: { id: 'another-captain' } })).rejects.toThrow('coordinating')
    expect(f.fetcher).toHaveBeenCalledTimes(1)
  })

  it.each([{ owner_user_id: 'other' }, { project_id: '' }, { revision: 2 }, { provider: 'other' }, { model_ref: 'other' },
    { status: 'disabled' }, { connector_ids: ['secret'] }, { knowledge_space_ids: ['space'] }, { system_prompt_ref: 'ref' },
    { max_budget_cents: 1 }, { timeout_seconds: 1 }, { max_concurrency: 0 }, { max_concurrency: 1.5 }])('rejects unsupported or changed execution authority: %j', async extra => {
    await expect(fixture(() => Response.json(authorization(extra))).authorize(input)).rejects.toThrow('supported')
  })

  it('accepts exactly one explicit admission and maps an unfinished replay to uncertain', async () => {
    let admitted = true
    const f = fixture(() => Response.json({ admitted, ...(admitted ? { token: 'b'.repeat(64) } : {}), receipt: wireReceipt() }, { status: admitted ? 201 : 200 }))
    await expect(f.store.admit(request)).resolves.toEqual({ kind: 'admitted', token: 'b'.repeat(64), sessionMode: 'create' })
    admitted = false
    await expect(f.store.admit(request)).resolves.toEqual({ kind: 'replay', receipt: { runId: request.runId, state: 'uncertain', summary: '' } })
    await expect(f.store.admit({ ...request, ownerUserId: 'other' })).rejects.toThrow('fixed node identity')
    await expect(f.store.admit({ ...request, provider: 'other' })).rejects.toThrow('fixed node identity')
    await expect(f.store.admit({ ...request, model: 'other' })).rejects.toThrow('fixed node identity')
    expect(f.fetcher).toHaveBeenCalledTimes(2)
  })

  it.each(['realm', 'thread_id', 'task_id', 'node_id', 'coordinator_session_ref', 'attempt', 'request_hash', 'run_id', 'owner_user_id', 'agent_id', 'preset_revision', 'max_concurrency', 'provider', 'model'])(
    'refuses a replay whose %s differs', async key => {
      const f = fixture(() => Response.json({ admitted: false, receipt: wireReceipt({ [key]: 'forged' }) }))
      await expect(f.store.admit(request)).rejects.toThrow('mismatched')
    })

  it('keeps teardown uncertainty running and verifies immutable finish receipts', async () => {
    const f = fixture(() => Response.json(wireReceipt({ state: 'completed', summary: 'done' })))
    await f.store.finish(request, 'b'.repeat(64), { runId: request.runId, state: 'uncertain', summary: 'teardown failed' })
    expect(f.fetcher).not.toHaveBeenCalled()
    await f.store.finish(request, 'b'.repeat(64), { runId: request.runId, state: 'completed', summary: 'done' })
    expect(f.fetcher).toHaveBeenCalledTimes(1)
    await expect(f.store.finish(request, 'b'.repeat(64), { runId: request.runId, state: 'failed', summary: 'different' })).rejects.toThrow('differs')
  })

  it('refuses token leakage on replay, malformed admissions, redirects and oversized replies', async () => {
    for (const body of [
      { admitted: false, token: 'b'.repeat(64), receipt: wireReceipt() },
      { admitted: true, token: '', receipt: wireReceipt() },
    ]) await expect(fixture(() => Response.json(body)).store.admit(request)).rejects.toThrow('admission')
    await expect(fixture(() => new Response('', { status: 307, headers: { location: 'http://other' } })).store.admit(request)).rejects.toThrow('307')
    await expect(fixture(() => Response.json({ padding: 'x'.repeat(130 * 1024) })).authorize(input)).rejects.toThrow('bound')
  })
})

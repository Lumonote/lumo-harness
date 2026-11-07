import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CallbackInbox, CallbackRegistration } from '../../../shared/subagent-receipts.ts'
import type { PendingEntry } from '../src/callback.ts'
import { RemoteSubagentProvider, type RemoteConfig } from '../src/provider.ts'

const config: RemoteConfig = { schedulerUrl: 'http://scheduler.invalid', realm: 'realm', ownerUserId: 'owner',
  nodeUrls: {}, hostTokens: {}, callbackPort: 8092 }
const registration: CallbackRegistration = { secretHash: 'secret-hash', attempt: 4, nodeId: 'node',
  parentSessionId: 'parent', ownerUserId: 'owner' }
const parent = { session: { header: { id: 'parent' } } } as Agent
function setup(receipt: CallbackRegistration | undefined = registration, overrides: Partial<RemoteConfig> = {}) {
  const pending = new Map<string, PendingEntry>()
  const inbox: CallbackInbox = { get: vi.fn(async (realm: string) => realm === 'realm' ? receipt : undefined), register: vi.fn(), put: vi.fn() }
  const provider = new RemoteSubagentProvider({ ...config, ...overrides }, pending, 'remote', inbox)
  return { provider, pending, inbox }
}
afterEach(() => vi.unstubAllGlobals())

describe('explicit parent recovery', () => {
  it.each([
    { parentSessionId: 'other' }, { ownerUserId: 'other' }, { ownerUserId: undefined },
    { parentSessionId: undefined }, { nodeId: undefined }, { attempt: undefined },
  ])('rejects missing or mismatched durable ownership: %j', async patch => {
    const { provider, pending } = setup({ ...registration, ...patch })
    await expect(provider.recover('child', parent)).rejects.toMatchObject({ code: 'REMOTE_RUN_NOT_RECOVERABLE' })
    expect(pending.size).toBe(0)
  })

  it('isolates recovery to the configured realm and requires a fixed runtime owner', async () => {
    for (const overrides of [{ realm: 'other' }, { ownerUserId: undefined }]) {
      await expect(setup(registration, overrides).provider.recover('child', parent))
        .rejects.toMatchObject({ code: 'REMOTE_RUN_NOT_RECOVERABLE' })
    }
  })

  it('reattaches an in-flight result using its stored capability hash without starting a child', async () => {
    const fetch = vi.fn(async () => Response.json({ state: 'CANCELLING' }))
    vi.stubGlobal('fetch', fetch)
    const { provider, pending } = setup()
    const run = await provider.recover('child', parent)
    expect(fetch).not.toHaveBeenCalled()
    expect(pending.get('child')).toMatchObject({ secretHash: registration.secretHash, attempt: 4, nodeId: 'node' })
    await expect(provider.recover('child', parent)).rejects.toMatchObject({ code: 'REMOTE_RUN_ALREADY_ATTACHED' })
    pending.get('child')!.settler({ runId: 'child', ok: true, stopReason: 'completed', output: [] })
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose(); await run.dispose()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[0]).toContain('/v1/tasks/child/cancel')
  })

  it('observes a recovered failure while the original receipt report is still in flight', async () => {
    const { provider, pending } = setup({ ...registration,
      body: { runId: 'child', ok: false, code: 'HOST_PROCESS_LOST', message: 'previous boot stopped' } })
    vi.stubGlobal('fetch', vi.fn(async () => {
      pending.get('child')!.settler({ runId: 'child', ok: false, code: 'HOST_PROCESS_LOST' })
      await new Promise<void>(resolve => setTimeout(resolve, 20))
      return new Response(null, { status: 204 })
    }))
    const run = await provider.recover('child', parent)
    await expect(run.result).rejects.toMatchObject({ code: 'HOST_PROCESS_LOST' })
  })

  it('settles an already committed receipt after reporting the original execution identity', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetch)
    const { provider, pending } = setup({ ...registration,
      body: { runId: 'child', ok: true, stopReason: 'completed', structured: { answer: 42 } } })
    const run = await provider.recover('child', parent)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed', structured: { answer: 42 } })
    expect(pending.size).toBe(0)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(String(fetch.mock.calls[0]?.[0])).toContain('/v1/tasks/child/result')
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ state: 'COMPLETED', attempt: 4, node_id: 'node' })
  })
})

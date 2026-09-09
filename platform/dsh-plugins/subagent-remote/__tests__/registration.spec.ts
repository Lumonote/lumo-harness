import { createHash } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { afterEach, expect, it, vi } from 'vitest'
import { RemoteSubagentProvider, type RemoteConfig } from '../src/provider.ts'
import type { CallbackInbox } from '../../../shared/subagent-receipts.ts'
import type { StartChildRequest } from '../../../shared/seam-contracts/subagent-host.ts'

afterEach(() => vi.restoreAllMocks())

const config: RemoteConfig = { schedulerUrl: 'http://scheduler.invalid', realm: 'realm',
  nodeUrls: { node: 'http://node.invalid' }, hostTokens: { node: 'token' }, callbackPort: 8092 }

it.each([false, true])('persists callback registration before starting the child (database failure: %s)', async fail => {
  let registered = false
  const receipts: CallbackInbox = {
    get: vi.fn(), put: vi.fn(), register: vi.fn(async () => {
      if (fail) throw new Error('registration unavailable')
      registered = true
    }),
  }
  let start: StartChildRequest | undefined
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    if (String(url).endsWith('/v1/placements')) return Response.json({ node_id: 'node', attempt: 6 }, { status: 201 })
    if (String(url).endsWith('/subagent/start')) {
      expect(registered).toBe(true)
      start = JSON.parse(String(init?.body)) as StartChildRequest
    }
    return Response.json({ ok: true })
  })
  const ctx = new Context()
  try {
    const provider = new RemoteSubagentProvider(config, new Map(), 'test', receipts)
    const promise = provider.start({
      prompt: [{ type: 'text', text: 'task' }],
      signal: new AbortController().signal,
      descriptor: { version: 2, mode: 'one-shot', provider: 'test', label: 'task' },
      parent: { id: SessionId('parent'), options: {}, session: { header: { id: SessionId('parent') }, events: [] }, ctx } as unknown as Agent,
    })
    if (fail) {
      await expect(promise).rejects.toThrow('registration unavailable')
      expect(start).toBeUndefined()
    } else {
      const run = await promise
      const secret = new URL(start!.callbackUrl).pathname.split('/').at(-1)!
      expect(receipts.register).toHaveBeenCalledExactlyOnceWith('realm', String(run.id), {
        secretHash: createHash('sha256').update(secret).digest('hex'), attempt: 6,
      })
    }
  } finally { await ctx.fiber.dispose() }
})

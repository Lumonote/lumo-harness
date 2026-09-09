import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { assertAllowedCallback } from './callback-policy.ts'
import { assertChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'
import { ReceiptConflictError, type CallbackOutboxStore } from '../../../shared/subagent-receipts.ts'
import type { ChildResultBody } from '../../../shared/seam-contracts/subagent-host.ts'

export async function persistCallback(store: CallbackOutboxStore, realm: string, url: string, body: ChildResultBody,
  signal: AbortSignal, onError: (error: unknown) => void,
): Promise<void> {
  for (;;) {
    try {
      // Shutdown still attempts one final write for a child just cancelled by
      // the host. Only retry delays are interrupted by the lifecycle signal.
      await store.enqueue(realm, url, body)
      return
    } catch (error) {
      if (error instanceof ReceiptConflictError) throw error
      signal.throwIfAborted()
      onError(new Error(`subagent callback persistence deferred: ${body.runId}`))
      await delay(1_000, undefined, { signal })
    }
  }
}

export function startCallbackDelivery(
  store: CallbackOutboxStore,
  realms: readonly string[],
  origins: ReadonlySet<string>,
  onError: (error: unknown) => void,
) {
  const controller = new AbortController()
  let running: Promise<void> | undefined
  const flush = (): Promise<void> => {
    if (controller.signal.aborted) return Promise.resolve()
    if (running) return running
    running = (async () => {
      const pending = await store.claim([...realms], [...origins], randomUUID())
      // Eight concurrent requests, each bounded to two seconds, fit comfortably
      // within the database's thirty-second delivery lease.
      const results = await Promise.allSettled(pending.map(async item => {
        try {
          assertChildResultBody(item.body)
          assertAllowedCallback(item.url, item.runId, origins)
          if (!realms.includes(item.realm) || item.body.runId !== item.runId) throw new Error('invalid callback receipt identity')
          const response = await fetch(item.url, {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(item.body), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2_000)]),
          })
          await response.body?.cancel()
          if (!response.ok) throw new Error(`callback rejected with HTTP ${response.status}`)
          await store.acknowledge(item)
        } catch {
          // URLs contain per-run capabilities. Never include fetch errors or URLs
          // in logs; a failed or uncertain acknowledgment remains retryable.
          if (!controller.signal.aborted) onError(new Error(`subagent callback deferred: ${item.runId}`))
          await store.defer(item)
        }
      }))
      const failed = results.filter(result => result.status === 'rejected')
      if (failed.length) throw new Error(`failed to defer ${failed.length} callback receipts`)
    })().finally(() => { running = undefined })
    return running
  }
  const wake = () => { void flush().catch(onError) }
  const timer = setInterval(wake, 1_000)
  timer.unref()
  wake()
  return {
    wake, flush,
    async close() {
      clearInterval(timer)
      controller.abort()
      await running?.catch(onError)
    },
  }
}

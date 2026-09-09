import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistCallback, startCallbackDelivery } from '../src/callback-outbox.ts'
import { ReceiptConflictError, type CallbackOutboxStore, type PendingCallback } from '../../../shared/subagent-receipts.ts'

const origin = 'http://parent.invalid'
const item: PendingCallback = { realm: 'realm', runId: 'child', claimToken: 'claim',
  url: `${origin}/subagent/result/child/0123456789abcdef`, body: { runId: 'child', ok: true, stopReason: 'completed' } }
const workers: ReturnType<typeof startCallbackDelivery>[] = []

afterEach(async () => {
  for (const worker of workers.splice(0)) await worker.close()
  vi.restoreAllMocks()
})

function storeWithPending(): CallbackOutboxStore {
  let delivered = false
  return {
    enqueue: vi.fn().mockResolvedValue(undefined),
    claim: vi.fn(async (_realms, _origins, token) => delivered ? [] : [{ ...item, claimToken: token }]),
    acknowledge: vi.fn(async () => { delivered = true }),
    defer: vi.fn().mockResolvedValue(undefined),
  }
}

function start(store: CallbackOutboxStore) {
  const onError = vi.fn()
  const worker = startCallbackDelivery(store, ['realm'], new Set([origin]), onError)
  workers.push(worker)
  return { worker, onError }
}

describe('callback outbox delivery', () => {
  it('retries the same receipt after delivery failure and worker restart', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValue(new Response('{}', { status: 200 }))
    const store = storeWithPending()
    const first = start(store)
    await first.worker.flush()
    expect(store.acknowledge).not.toHaveBeenCalled()
    expect(store.defer).toHaveBeenCalledTimes(1)
    await first.worker.close()
    const second = start(store)
    await second.worker.flush()
    expect(store.acknowledge).toHaveBeenCalledTimes(1)
    expect(fetch.mock.calls[0]?.[1]?.body).toBe(fetch.mock.calls[1]?.[1]?.body)
    expect(fetch.mock.calls[1]?.[1]?.redirect).toBe('error')
    expect(store.claim).toHaveBeenLastCalledWith(['realm'], [origin], expect.any(String))
    expect(String(first.onError.mock.calls[0]?.[0])).not.toContain('0123456789abcdef')
  })

  it('retains uncertain database acknowledgments for idempotent replay', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}'))
    const store = storeWithPending()
    vi.mocked(store.acknowledge).mockRejectedValueOnce(new Error('commit response lost'))
    const { worker } = start(store)
    await worker.flush()
    expect(store.defer).toHaveBeenCalledTimes(1)
    await worker.flush()
    expect(store.acknowledge).toHaveBeenCalledTimes(2)
  })

  it.each([
    { ...item, realm: 'other' },
    { ...item, url: 'http://other.invalid/subagent/result/child/0123456789abcdef' },
    { ...item, body: { ...item.body, runId: 'other-child' } },
  ])('revalidates persisted callback identity and destination', async invalid => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const store = storeWithPending()
    vi.mocked(store.claim).mockResolvedValue([invalid])
    const { worker } = start(store)
    await worker.flush()
    expect(fetch).not.toHaveBeenCalled()
    expect(store.acknowledge).not.toHaveBeenCalled()
    expect(store.defer).toHaveBeenCalledTimes(1)
  })

  it('aborts a hanging callback when the worker closes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, options) => new Promise((_resolve, reject) => {
      options!.signal!.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    const store = storeWithPending()
    const { worker } = start(store)
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1))
    await worker.close()
    expect(store.acknowledge).not.toHaveBeenCalled()
    expect(store.defer).toHaveBeenCalledTimes(1)
  })

  it('retries persistence without changing the successful result', async () => {
    const store = storeWithPending()
    vi.mocked(store.enqueue).mockRejectedValueOnce(new Error('database offline'))
    await persistCallback(store, item.realm, item.url, item.body, new AbortController().signal, vi.fn())
    expect(store.enqueue).toHaveBeenCalledTimes(2)
    expect(vi.mocked(store.enqueue).mock.calls[0]).toEqual(vi.mocked(store.enqueue).mock.calls[1])
  })

  it('does not retry conflicting receipts and allows persistence shutdown', async () => {
    const store = storeWithPending()
    vi.mocked(store.enqueue).mockRejectedValueOnce(new ReceiptConflictError())
    await expect(persistCallback(store, item.realm, item.url, item.body, new AbortController().signal, vi.fn())).rejects.toBeInstanceOf(ReceiptConflictError)
    const controller = new AbortController()
    controller.abort(new Error('shutdown'))
    vi.mocked(store.enqueue).mockRejectedValueOnce(new Error('offline'))
    await expect(persistCallback(store, item.realm, item.url, item.body, controller.signal, vi.fn())).rejects.toThrow('shutdown')
    expect(store.enqueue).toHaveBeenCalledTimes(2)
    await expect(persistCallback(store, item.realm, item.url, item.body, controller.signal, vi.fn())).resolves.toBeUndefined()
  })
})

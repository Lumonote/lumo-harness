/** Retry idempotent provider initialization before publishing any capability. */
export async function initializeProviders(initializers: (() => Promise<void>)[], signal: AbortSignal, retry: (error: unknown) => void): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    signal.throwIfAborted()
    // Wait for all initializers before retrying so two attempts cannot overlap.
    const results = await abortable(Promise.allSettled(initializers.map(init => Promise.resolve().then(init))), signal)
    const failed = results.find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (!failed) return
    if (attempt === 3) throw failed.reason
    retry(failed.reason)
    await new Promise<void>((resolve, reject) => {
      const cancel = () => { clearTimeout(timer); reject(signal.reason) }
      const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, 250 * 2 ** attempt)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) { signal.removeEventListener('abort', cancel); cancel() }
    })
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cancel = () => { signal.removeEventListener('abort', cancel); reject(signal.reason) }
    signal.addEventListener('abort', cancel, { once: true })
    if (signal.aborted) { signal.removeEventListener('abort', cancel); reject(signal.reason) }
    pending.then(value => { signal.removeEventListener('abort', cancel); resolve(value) }, error => { signal.removeEventListener('abort', cancel); reject(error) })
  })
}

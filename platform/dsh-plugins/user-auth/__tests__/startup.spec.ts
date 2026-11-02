import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../src/proxy.ts', () => ({
  createAuthProxy: vi.fn(() => ({})),
  listenAuthProxy: vi.fn(async () => 3080),
  closeAuthProxy: vi.fn(async () => {}),
}))

import { apply, type Config } from '../src/index.ts'
import { createAuthProxy, listenAuthProxy } from '../src/proxy.ts'

const config: Config = {
  host: '127.0.0.1', port: 3080, governanceUrl: 'http://localhost:58081',
  controlPlaneToken: 'control', realm: 'dev', identityAssertionSecret: 'x'.repeat(32),
}

describe('authentication proxy startup', () => {
  beforeEach(() => vi.clearAllMocks())

  it('rejects an unbound upstream before opening the public listener', async () => {
    const ctx = { webServer: { host: '127.0.0.1', port: undefined } }
    await expect(apply(ctx as never, config)).rejects.toThrow(/has not bound a listening port/)
    expect(createAuthProxy).not.toHaveBeenCalled()
    expect(listenAuthProxy).not.toHaveBeenCalled()
  })

  it('forwards to the actual bound port', async () => {
    const ctx = { webServer: { host: '127.0.0.1', port: 48765 }, logger: {}, effect: vi.fn() }
    await apply(ctx as never, config)
    expect(createAuthProxy).toHaveBeenCalledWith(expect.objectContaining({ upstreamPort: 48765 }))
    expect(listenAuthProxy).toHaveBeenCalledExactlyOnceWith({}, '127.0.0.1', 3080)
  })
})

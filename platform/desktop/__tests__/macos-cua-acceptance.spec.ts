import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { exerciseOwnedCaptureCancellation, exerciseOwnedFixture, isAcceptanceDiagnostic, passiveCatalog } from '../../tools/macos-cua-acceptance.mjs'

// These are protocol contract fixtures, never native desktop acceptance evidence.
function scenario() {
  const nonce = '0123456789abcdef'
  const bundleId = `test.lumo.cua.acceptance.${nonce}`
  let clicks = 0, text = '', snapshot = 0
  const calls: { method: string, params: Record<string, unknown> }[] = []
  const images: { name: string, png: Buffer }[] = []
  const fixture = {
    pid: 321, windowId: 123, nonce, bundleId, title: `Lumo CUA acceptance ${nonce}`,
    executable: realpathSync(process.execPath),
    state: async () => ({ pid: 321, windowId: 123, nonce, bundleId, title: `Lumo CUA acceptance ${nonce}`, clicks, text }),
    waitFor: async (predicate: (value: unknown) => boolean) => { expect(predicate(await fixture.state())).toBe(true) },
  }
  const owner = { appHandle: 'owned-app', windowId: 123 }
  const window = { pid: 321, windowId: 123, title: fixture.title }
  const respond = async (method: string, params: Record<string, unknown>): Promise<any> => {
    calls.push({ method, params })
    if (method === 'getApp') return { pid: 321, bundleId, appHandle: 'owned-app', authorization: {
      executablePath: process.execPath, id: createHash('sha256').update(`macos:bundle-id:${bundleId}`).digest('hex'),
    } }
    if (method === 'listWindows') return [window]
    if (method === 'getState') return { ...owner, pid: 321, snapshotId: `fresh-${++snapshot}`, tree: text,
      elements: [{ role: 'AXButton', title: 'Prepare input', index: 7 }] }
    if (method === 'screenshot') {
      expect(params).toEqual(owner)
      const png = Buffer.alloc(120, text ? 2 : 1)
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png)
      png.writeUInt32BE(600, 16); png.writeUInt32BE(320, 20)
      return { windowId: 123, mimeType: 'image/png', data: png.toString('base64'), pixelWidth: 600, pixelHeight: 320 }
    }
    if (method === 'click') {
      expect(params).toEqual({ appHandle: 'owned-app', snapshotId: 'fresh-1', elementIndex: 7 }); clicks++
      return { dispatched: true, verified: false }
    }
    if (method === 'typeText') {
      expect(params.appHandle).toBe('owned-app'); text = params.text as string
      return { dispatched: true, verified: false }
    }
    throw Error(`Unexpected method: ${method}`)
  }
  const client = { call: respond }
  const save = async (name: string, png: Buffer) => { images.push({ name, png }) }
  return { fixture, client, calls, images, save, respond }
}

describe('macOS owned native acceptance contract', () => {
  it('accepts official screenshot diagnostics before or after a reply without treating them as operation evidence', () => {
    const issued = new Set(['acceptance-1'])
    expect(isAcceptanceDiagnostic({ type: 'diagnostic', requestId: 'acceptance-1', stage: 'response.write.end', elapsedMs: 2 }, issued)).toBe(true)
    expect(isAcceptanceDiagnostic({ id: 'acceptance-1', result: {} }, issued)).toBe(false)
    expect(() => isAcceptanceDiagnostic({ type: 'diagnostic', requestId: 'foreign', stage: 'capture.begin', elapsedMs: 0 }, issued)).toThrow(/unissued/)
    expect(() => isAcceptanceDiagnostic({ type: 'diagnostic', requestId: 'acceptance-1', stage: 'capture.begin', elapsedMs: -1 }, issued)).toThrow()
  })
  it('requires a native cancellation acknowledgement and a fresh successful capture without replaying inputs', async () => {
    const f = scenario(); let cancelled = false
    const client = { call: async (method: string, params: Record<string, unknown>, options?: { cancelAfterMs?: number }) => {
      if (options?.cancelAfterMs !== undefined) { expect(method).toBe('screenshot'); cancelled = true; throw Object.assign(Error('Cancelled'), { code: 'NATIVE_CANCELLED' }) }
      return f.respond(method, params)
    } }
    expect(await exerciseOwnedCaptureCancellation(client, f.fixture)).toMatchObject({ captureCancellationValidated: true, freshCaptureAfterCancellation: true })
    expect(cancelled).toBe(true)
    expect(f.calls.some(call => ['click', 'typeText'].includes(call.method))).toBe(false)
    await expect(exerciseOwnedCaptureCancellation(f.client, f.fixture)).rejects.toThrow(/finished before cancellation/)
    await expect(exerciseOwnedCaptureCancellation({ call: async () => { throw Object.assign(Error('Native broke'), { code: 'NATIVE_UNRESPONSIVE' }) } }, f.fixture)).rejects.toThrow('Native broke')
  })
  it('only passively checks capabilities and permissions; never requests grants or lists user applications', async () => {
    const calls: string[] = []
    const result = await passiveCatalog({ pid: 111, call: async (method: string, params: unknown) => {
      calls.push(method); expect(params).toEqual({})
      return method === 'getCapabilities'
        ? { platform: 'macos', permissions: { accessibility: false, screenRecording: false }, methods: ['getApp'] }
        : { accessibility: false, screenRecording: false, helper: { pid: 111 }, launchApplication: { name: 'DSH Computer Use.app' } }
    } })
    expect(calls).toEqual(['getCapabilities', 'permissionStatus'])
    expect(result.permissions.accessibility).toBe(false)
  })

  it('verifies the exact owned target, fresh button, independently received input and changing screenshots', async () => {
    const f = scenario()
    const report = await exerciseOwnedFixture(f.client, f.fixture, f.save)
    expect(f.calls[0]).toEqual({ method: 'getApp', params: { selector: '321' } })
    expect(f.calls.filter(call => call.method === 'click')).toHaveLength(1)
    expect(f.calls.filter(call => call.method === 'typeText')).toHaveLength(1)
    expect(f.images.map(image => image.name)).toEqual(['before.png', 'after.png'])
    expect(report).toMatchObject({ nativeDesktopValidated: true, clickAndTextVerified: true,
      modelVisionValidated: false, applicationConsentUiValidated: false, captureCancellationValidated: false, osPermissionPrompted: false })
  })

  it.each(['pid', 'windowId', 'nonce', 'bundleId', 'title'])('refuses a changed fixture %s before native selection', async (field) => {
    const f = scenario(); const state = await f.fixture.state()
    f.fixture.state = async () => ({ ...state, [field]: field === 'pid' || field === 'windowId' ? 999 : 'foreign' })
    await expect(exerciseOwnedFixture(f.client, f.fixture, f.save)).rejects.toThrow()
    expect(f.calls).toEqual([])
  })

  it.each(['pid', 'windowId', 'title', 'executable', 'authorization'])('refuses mismatched native %s before any input', async (field) => {
    const f = scenario()
    f.client.call = async (method, params) => {
      const result = await f.respond(method, params)
      if (method === 'getApp' && field === 'pid') result.pid = 999
      if (method === 'getApp' && field === 'executable') result.authorization.executablePath = '/nonexistent/executable'
      if (method === 'getApp' && field === 'authorization') result.authorization.id = 'foreign'
      if (method === 'listWindows' && field === 'windowId') result[0].windowId = 999
      if (method === 'listWindows' && field === 'title') result[0].title = 'User document'
      return result
    }
    await expect(exerciseOwnedFixture(f.client, f.fixture, f.save)).rejects.toThrow()
    expect(f.calls.some(call => ['click', 'typeText'].includes(call.method))).toBe(false)
    expect(f.images).toEqual([])
  })

  it('does not replay failed or uncertain input, and does not publish success images', async () => {
    const f = scenario()
    f.client.call = async (method, params) => {
      const result = await f.respond(method, params)
      if (method === 'typeText') throw Error('Native completion unknown')
      return result
    }
    await expect(exerciseOwnedFixture(f.client, f.fixture, f.save)).rejects.toThrow('Native completion unknown')
    expect(f.calls.filter(call => call.method === 'typeText')).toHaveLength(1)
    expect(f.images).toEqual([])
  })

  it('rejects a valid dispatch without independent application evidence', async () => {
    const f = scenario()
    f.fixture.waitFor = async () => { throw Error('No independent click received') }
    await expect(exerciseOwnedFixture(f.client, f.fixture, f.save)).rejects.toThrow('No independent click received')
    expect(f.calls.some(call => call.method === 'typeText')).toBe(false)
    expect(f.images).toEqual([])
  })
})

/** Native contract acceptance, restricted to an application created and owned by this process. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verifyCuaHelper } from '../desktop/cua-helper.mjs'

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const register = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister'
// This client cannot request grants, launch arbitrary apps, use the clipboard or send global input.
const methods = new Set(['getCapabilities', 'permissionStatus', 'getApp', 'listWindows', 'getState', 'screenshot', 'click', 'typeText'])
const baseReport = () => ({ nativeDesktopValidated: false, clickAndTextVerified: false,
  modelVisionValidated: false, applicationConsentUiValidated: false, captureCancellationValidated: false,
  osPermissionPrompted: false, at: new Date().toISOString() })

function checked(command, args, timeout = 60_000) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 })
  if (result.error || result.status !== 0) throw Error(`${command} failed: ${result.stderr?.trim() || result.error?.message || result.status}`)
  return result.stdout
}

async function waitUntil(predicate, description, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const value = await predicate()
    if (value) return value
    await delay(25)
  }
  throw Error(`Timed out: ${description}`)
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === 'ESRCH') return false; throw error }
}

export function isAcceptanceDiagnostic(frame, issued) {
  if (frame?.type !== 'diagnostic') return false
  assert.ok(issued.has(frame.requestId), 'Native diagnostic belongs to an unissued request')
  assert.ok(typeof frame.stage === 'string' && frame.stage.length > 0 && frame.stage.length <= 128)
  assert.ok(typeof frame.elapsedMs === 'number' && Number.isFinite(frame.elapsedMs) && frame.elapsedMs >= 0)
  assert.ok(Object.keys(frame).every(key => ['type', 'requestId', 'stage', 'elapsedMs', 'errorCode'].includes(key)))
  if (frame.errorCode !== undefined) assert.ok(typeof frame.errorCode === 'string' && frame.errorCode.length <= 128)
  return true
}

/** The private runtime directory makes the official launcher create an independent helper process. */
export async function connectNativeHelper(executable, directory, signal) {
  signal?.throwIfAborted()
  const runtimeKey = sha256(readFileSync(executable))
  const ready = JSON.parse(checked(executable, ['--ensure-shared', '--runtime-key', runtimeKey,
    '--runtime-directory', directory, '--startup-timeout-ms', '15000'], 25_000))
  assert.equal(ready.type, 'ready')
  assert.equal(ready.runtimeKey, runtimeKey)
  assert.ok(Number.isInteger(ready.pid) && ready.pid > 0)
  const socket = createConnection(join(directory, `${runtimeKey}.sock`))
  let buffer = Buffer.alloc(0)
  let waiting
  let failed
  const issued = new Set()
  const finish = (error, value) => {
    if (!waiting) { failed = error ?? Error('Unsolicited native response'); socket.destroy(); return }
    const pending = waiting; waiting = undefined; clearTimeout(pending.timer)
    if (error) pending.reject(error); else pending.resolve(value)
  }
  socket.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 33_554_432) { finish(Error('Native response exceeds byte limit')); socket.destroy(); return }
    for (let end; (end = buffer.indexOf(10)) !== -1;) {
      const line = buffer.subarray(0, end); buffer = buffer.subarray(end + 1)
      try {
        const frame = JSON.parse(line.toString('utf8'))
        // Official screenshot traces share this socket and may follow the reply.
        // They are metadata, never a completed capture or cancellation receipt.
        if (isAcceptanceDiagnostic(frame, issued)) continue
        finish(undefined, frame)
      } catch (error) { finish(error); socket.destroy(); break }
    }
  })
  socket.on('error', error => { failed = error; if (waiting) finish(error) })
  socket.on('close', () => { if (waiting) finish(Error('Native connection closed during request')) })
  const exchange = value => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    if (failed) return reject(failed)
    if (waiting) return reject(Error('Parallel native requests are forbidden'))
    const timer = setTimeout(() => { finish(Error('Native request deadline exceeded')); socket.destroy() }, 35_000)
    waiting = { resolve, reject, timer }
    socket.write(`${JSON.stringify(value)}\n`)
  })
  const abort = () => { failed = signal.reason; if (waiting) finish(failed); socket.destroy() }
  signal?.addEventListener('abort', abort, { once: true })
  const dispose = async () => {
    signal?.removeEventListener('abort', abort)
    socket.end()
    await waitUntil(() => socket.closed, 'native connection cleanup')
    await waitUntil(() => !alive(ready.pid), 'dedicated helper exit')
  }
  try {
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) })
    const admitted = await exchange({ type: 'hello', protocol: 1, runtimeKey, config: {
      maxRequestBytes: 1_048_576, maxResponseBytes: 33_554_432, axTimeoutMs: 3000,
      textEventIntervalMs: 0.25, maxClickHoldMs: 5000, screenshotTimeoutMs: 5000,
      timeoutMs: 30_000, graceMs: 5000,
    } })
    assert.equal(admitted.type, 'ready'); assert.equal(admitted.pid, ready.pid)
  } catch (error) { await dispose(); throw error }
  let nextId = 0
  return {
    pid: ready.pid,
    async call(method, params, { cancelAfterMs } = {}) {
      assert.ok(methods.has(method), `Acceptance method not permitted: ${method}`)
      if (cancelAfterMs !== undefined) assert.ok(method === 'screenshot' && Number.isInteger(cancelAfterMs) && cancelAfterMs >= 0,
        'Only read-only fixture captures may be cancelled by acceptance')
      const id = `acceptance-${++nextId}`
      issued.add(id)
      let timer
      const responsePromise = exchange({ id, method, params })
      if (cancelAfterMs !== undefined) timer = setTimeout(() => {
        if (waiting && !signal?.aborted) socket.write(`${JSON.stringify({ type: 'cancel', id })}\n`)
      }, cancelAfterMs)
      let response
      try { response = await responsePromise } finally { clearTimeout(timer) }
      assert.equal(response.id, id)
      if (response.error) throw Object.assign(Error(response.error.message), { code: response.error.code })
      assert.ok(Object.hasOwn(response, 'result'), 'Native result is missing')
      return response.result
    },
    dispose,
  }
}

/** Verify native acknowledgement and a fresh capture after cancellation; no inputs. */
export async function exerciseOwnedCaptureCancellation(client, fixture, { cancelAfterMs = 1 } = {}) {
  checkFixtureState(fixture, await fixture.state())
  const app = await client.call('getApp', { selector: String(fixture.pid) })
  assert.equal(app.pid, fixture.pid); assert.equal(app.bundleId, fixture.bundleId)
  assert.equal(realpathSync(app.authorization?.executablePath), fixture.executable)
  const owner = { appHandle: app.appHandle, windowId: fixture.windowId }
  let acknowledged = false
  try { await client.call('screenshot', owner, { cancelAfterMs }) } catch (error) {
    if (error.code !== 'NATIVE_CANCELLED') throw error
    acknowledged = true
  }
  assert.equal(acknowledged, true, 'Capture finished before cancellation; rerun to observe the native cancellation acknowledgement')
  checkFixtureState(fixture, await fixture.state())
  nativePng(await client.call('screenshot', owner), fixture.windowId)
  return { captureCancellationValidated: true, captureCancellationAcknowledged: true, freshCaptureAfterCancellation: true }
}

export async function passiveCatalog(client) {
  const capabilities = await client.call('getCapabilities', {})
  const permissions = await client.call('permissionStatus', {})
  assert.equal(capabilities.platform, 'macos')
  assert.equal(typeof permissions.accessibility, 'boolean')
  assert.equal(typeof permissions.screenRecording, 'boolean')
  assert.deepEqual(capabilities.permissions, { accessibility: permissions.accessibility, screenRecording: permissions.screenRecording },
    'Permissions changed between passive checks; rerun without sending input')
  assert.equal(permissions.launchApplication?.name, 'DSH Computer Use.app')
  if (client.pid !== undefined) assert.equal(permissions.helper?.pid, client.pid, 'Permissions must describe this dedicated helper')
  return { capabilities, permissions }
}

function checkFixtureState(fixture, state) {
  assert.equal(state.pid, fixture.pid, 'Fixture PID changed')
  assert.equal(state.windowId, fixture.windowId, 'Fixture window changed')
  assert.equal(state.nonce, fixture.nonce, 'Fixture nonce changed')
  assert.equal(state.bundleId, fixture.bundleId, 'Fixture bundle identity changed')
  assert.equal(state.title, fixture.title, 'Fixture title changed')
  return state
}

function nativePng(result, windowId) {
  assert.equal(result.windowId, windowId, 'Screenshot must belong to the owned fixture window')
  assert.equal(result.mimeType, 'image/png')
  const png = Buffer.from(result.data, 'base64')
  assert.equal(png.toString('base64'), result.data)
  assert.ok(png.length > 100 && png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
  assert.ok(png.readUInt32BE(16) > 1 && png.readUInt32BE(20) > 1, 'One-pixel images cannot prove native acceptance')
  assert.equal(png.readUInt32BE(16), result.pixelWidth)
  assert.equal(png.readUInt32BE(20), result.pixelHeight)
  return png
}

/** Called only with the descriptor from createFixture; external target plans are never accepted. */
export async function exerciseOwnedFixture(client, fixture, saveImage) {
  assert.match(fixture.bundleId, /^test\.lumo\.cua\.acceptance\.[a-f0-9]{16}$/u)
  assert.ok(Number.isInteger(fixture.pid) && fixture.pid > 0)
  assert.ok(Number.isInteger(fixture.windowId) && fixture.windowId > 0)
  checkFixtureState(fixture, await fixture.state())
  const app = await client.call('getApp', { selector: String(fixture.pid) })
  assert.equal(app.pid, fixture.pid)
  assert.equal(app.bundleId, fixture.bundleId)
  assert.equal(realpathSync(app.authorization?.executablePath), fixture.executable, 'Native identity must point to the owned executable')
  assert.equal(app.authorization?.id, sha256(`macos:bundle-id:${fixture.bundleId}`))
  const owner = { appHandle: app.appHandle, windowId: fixture.windowId }
  async function observe() {
    checkFixtureState(fixture, await fixture.state())
    const windows = await client.call('listWindows', { appHandle: app.appHandle })
    assert.equal(windows.length, 1, 'Only the one owned fixture window may exist')
    assert.equal(windows[0].pid, fixture.pid)
    assert.equal(windows[0].windowId, fixture.windowId)
    assert.equal(windows[0].title, fixture.title)
    const state = await client.call('getState', { ...owner, details: true, maxElements: 2000, maxDepth: 25 })
    assert.equal(state.pid, fixture.pid); assert.equal(state.windowId, fixture.windowId)
    assert.equal(state.appHandle, app.appHandle)
    assert.ok(typeof state.snapshotId === 'string' && state.snapshotId.length > 0)
    return state
  }
  const before = await observe()
  const buttons = before.elements?.filter(element => element.role === 'AXButton' && element.title === 'Prepare input') ?? []
  assert.equal(buttons.length, 1, 'A unique fresh fixture button is required')
  assert.ok(Number.isInteger(buttons[0].index) && buttons[0].index >= 0)
  const initial = checkFixtureState(fixture, await fixture.state())
  assert.equal(initial.clicks, 0); assert.equal(initial.text, '')
  const beforeImage = nativePng(await client.call('screenshot', owner), fixture.windowId)
  const click = await client.call('click', { appHandle: app.appHandle, snapshotId: before.snapshotId, elementIndex: buttons[0].index })
  assert.equal(click.dispatched, true)
  await fixture.waitFor(state => { checkFixtureState(fixture, state); return state.clicks === 1 && state.text === '' })
  await observe()
  const expectedText = `Lumo✓${fixture.nonce.slice(0, 8)}`
  const typed = await client.call('typeText', { appHandle: app.appHandle, text: expectedText })
  assert.equal(typed.dispatched, true)
  await fixture.waitFor(state => { checkFixtureState(fixture, state); return state.clicks === 1 && state.text === expectedText })
  const after = await observe()
  assert.ok(after.tree.includes(expectedText), 'Fresh accessibility state must contain the independently received text')
  const afterImage = nativePng(await client.call('screenshot', owner), fixture.windowId)
  const beforeSha256 = sha256(beforeImage), afterSha256 = sha256(afterImage)
  assert.notEqual(beforeSha256, afterSha256, 'The screenshot must reflect changed fixture text')
  await saveImage('before.png', beforeImage); await saveImage('after.png', afterImage)
  return { ...baseReport(), nativeDesktopValidated: true, clickAndTextVerified: true,
    target: { pid: fixture.pid, windowId: fixture.windowId, bundleId: fixture.bundleId },
    beforeSha256, afterSha256, inputReplayAttempted: false, targetKind: 'disposable-owned-fixture' }
}

async function createFixture(directory, signal) {
  signal?.throwIfAborted()
  const nonce = randomBytes(8).toString('hex')
  const bundleId = `test.lumo.cua.acceptance.${nonce}`
  const title = `Lumo CUA acceptance ${nonce}`
  const application = join(directory, 'Lumo CUA Acceptance.app')
  const macos = join(application, 'Contents', 'MacOS')
  mkdirSync(macos, { recursive: true, mode: 0o700 })
  const executable = join(macos, 'fixture')
  writeFileSync(join(application, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>${bundleId}</string>
<key>CFBundleName</key><string>Lumo CUA Acceptance</string><key>CFBundleExecutable</key><string>fixture</string>
<key>CFBundlePackageType</key><string>APPL</string></dict></plist>\n`)
  checked('/usr/bin/xcrun', ['swiftc', '-module-cache-path', join(directory, 'module-cache'),
    join(dirname(fileURLToPath(import.meta.url)), 'macos-cua-fixture.swift'), '-o', executable])
  checked('/usr/bin/codesign', ['--force', '--sign', '-', application])
  signal?.throwIfAborted()
  const statePath = join(directory, 'fixture-state.json')
  const child = spawn(executable, [statePath, nonce], { stdio: 'ignore' })
  const abort = () => { child.kill('SIGTERM') }
  signal?.addEventListener('abort', abort, { once: true })
  const exited = new Promise(resolve => { child.once('error', resolve); child.once('exit', resolve) })
  const state = () => { signal?.throwIfAborted(); try { return JSON.parse(readFileSync(statePath, 'utf8')) } catch (error) { if (error.code === 'ENOENT') return undefined; throw error } }
  const dispose = async () => {
    signal?.removeEventListener('abort', abort)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    let timer
    try {
      await Promise.race([exited, new Promise((_, reject) => { timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); reject(Error('Fixture did not exit normally')) }
      }, 5000) })])
    } finally { clearTimeout(timer) }
    checked(register, ['-u', application], 10_000)
  }
  try {
    const initial = await waitUntil(() => state(), 'fixture window')
    assert.equal(initial.pid, child.pid)
    const fixture = { pid: child.pid, windowId: initial.windowId, nonce, bundleId, title,
      executable: realpathSync(executable), state, dispose,
      waitFor: predicate => waitUntil(() => { const value = state(); return value && predicate(value) ? value : undefined }, 'independent fixture input', 15_000) }
    checkFixtureState(fixture, initial)
    return fixture
  } catch (error) { await dispose(); throw error }
}

export async function main(argv = process.argv.slice(2)) {
  const [mode, packagePath, outputPath] = argv
  assert.ok(['--catalog', '--desktop'].includes(mode) && packagePath && argv.length <= 3,
    'Usage: node macos-cua-acceptance.mjs --catalog|--desktop <provider-package-root> [new-evidence-directory]')
  assert.equal(process.platform, 'darwin', 'Run on macOS with a verified official helper')
  if (mode === '--desktop') assert.equal(process.env.LUMO_MACOS_CUA_E2E, '1', 'Explicit fixture input requires LUMO_MACOS_CUA_E2E=1')
  const output = outputPath ? resolve(outputPath) : mkdtempSync(join(tmpdir(), 'lumo-cua-evidence-'))
  if (outputPath) mkdirSync(output, { mode: 0o700 }) // Existing evidence is never reused or overwritten.
  chmodSync(output, 0o700)
  const directory = mkdtempSync('/tmp/lumo-cua-') // Keep the Unix socket path below macOS's 104-byte limit.
  chmodSync(directory, 0o700)
  const cancellation = new AbortController()
  const interrupt = signal => cancellation.abort(Error(`Acceptance interrupted by ${signal}`))
  const interrupted = () => interrupt('SIGINT'), terminated = () => interrupt('SIGTERM')
  process.on('SIGINT', interrupted); process.on('SIGTERM', terminated)
  let client, fixture
  let report = { ...baseReport(), status: 'failed', evidenceDirectory: output }
  try {
    const verified = verifyCuaHelper({ packageRoot: realpathSync(packagePath), targetArch: process.arch })
    // Preserve the product helper's TCC identity. Its launcher creates a new
    // application instance for this previously unused private runtime directory.
    // Never unregister or delete the caller's verified helper application.
    client = await connectNativeHelper(verified.executable, directory, cancellation.signal)
    const catalog = await passiveCatalog(client)
    writeFileSync(join(output, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 })
    report = { ...report, nativeCatalogValidated: true, helperDigest: verified.digest, permissions: catalog.capabilities.permissions }
    if (mode === '--catalog') report.status = 'passed'
    else if (!catalog.capabilities.permissions.accessibility || !catalog.capabilities.permissions.screenRecording || catalog.capabilities.sessionLocked !== false) {
      report.status = 'blocked'; report.reason = 'Existing Accessibility and Screen Recording grants and an unlocked session are required; no fixture input was sent'
    } else {
      fixture = await createFixture(directory, cancellation.signal)
      report = { ...report, ...await exerciseOwnedFixture(client, fixture,
        (name, image) => writeFileSync(join(output, name), image, { mode: 0o600 })), status: 'passed' }
      report = { ...report, ...await exerciseOwnedCaptureCancellation(client, fixture) }
    }
  } catch (error) { report.status = 'failed'; report.error = { code: error.code ?? 'ACCEPTANCE_FAILED', message: error.message } }
  finally {
    const errors = []
    if (fixture) { try { await fixture.dispose() } catch (error) { errors.push(error.message) } }
    if (client) { try { await client.dispose(); report.helperCleanupConfirmed = true } catch (error) { errors.push(error.message) } }
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', terminated)
    if (errors.length) { report.status = 'failed'; report.cleanupErrors = errors } else rmSync(directory, { recursive: true, force: true })
    writeFileSync(join(output, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
  }
  console.log(JSON.stringify(report, null, 2))
  return report.status === 'passed' ? 0 : report.status === 'blocked' ? 2 : 1
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main().then(code => { process.exitCode = code }).catch(error => { console.error(error.message); process.exitCode = 1 })
}

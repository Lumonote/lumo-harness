/** Explicit native desktop acceptance. Supply exact installed-catalog arguments for a disposable target. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { WindowsCuaRuntime } from '../dsh-plugins/computer-use/src/windows-runtime.ts'

if (process.platform !== 'win32' || process.env.LUMO_WINDOWS_CUA_E2E !== '1') throw Error('Run explicitly on a disposable logged-in Windows desktop with LUMO_WINDOWS_CUA_E2E=1')
const runtime = new WindowsCuaRuntime()
const signal = AbortSignal.timeout(60_000)
try {
  const catalog = await runtime.catalog()
  const permissions = await runtime.call('check_permissions', { prompt: false }, signal, 'acceptance')
  assert.equal(permissions?.isError ?? false, false, 'Passive OS permission check must succeed')
  if (process.argv[2] === '--catalog') {
    console.log(JSON.stringify({ catalog, permissions }, null, 2))
  } else {
    const plan = JSON.parse(readFileSync(resolve(process.argv[2] ?? ''), 'utf8'))
    assert.equal(plan.version, 1)
    assert.ok(Number.isInteger(plan.pid) && plan.pid > 0)
    assert.ok((Number.isSafeInteger(plan.windowId) && plan.windowId > 0)
      || (typeof plan.windowId === 'string' && /^[1-9][0-9]*$/u.test(plan.windowId)), 'Keep the exact catalog window ID; never coerce a 64-bit ID to a JavaScript number')
    assert.ok(typeof plan.expectedText === 'string' && plan.expectedText.length > 0)
    assert.ok(Array.isArray(plan.actions) && plan.actions.some(action => action.name === 'click') && plan.actions.some(action => action.name === 'type_text'))
    const target = args => {
      const selected = args?.target ?? args
      assert.equal(selected?.pid, plan.pid, 'Every operation must target the dedicated fixture process')
      assert.equal(selected?.window_id, plan.windowId, 'Every operation must target the dedicated fixture window')
    }
    target(plan.observe)
    for (const action of plan.actions) { assert.ok(['click', 'type_text'].includes(action.name)); target(action.args) }
    const output = resolve(process.argv[3] ?? 'windows-cua-evidence')
    mkdirSync(output, { recursive: true })
    function screenshot(result, name) {
      assert.equal(result?.isError ?? false, false, 'Native operation must report success')
      const image = result.content?.find(block => block.type === 'image' && block.mimeType === 'image/png')
      assert.ok(image && typeof image.data === 'string', 'A real native PNG screenshot is required')
      const png = Buffer.from(image.data, 'base64')
      assert.ok(png.length > 100 && png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])))
      assert.ok(png.readUInt32BE(16) > 1 && png.readUInt32BE(20) > 1, 'One-pixel fixture images are not native acceptance')
      writeFileSync(join(output, name), png)
      return createHash('sha256').update(png).digest('hex')
    }
    const before = await runtime.call('get_window_state', plan.observe, signal, 'acceptance')
    const beforeSha256 = screenshot(before, 'before.png')
    for (const action of plan.actions) {
      const result = await runtime.call(action.name, action.args, signal, 'acceptance')
      assert.equal(result?.isError ?? false, false, `${action.name} must be accepted by the actual driver`)
    }
    const after = await runtime.call('get_window_state', plan.observe, signal, 'acceptance')
    const afterSha256 = screenshot(after, 'after.png')
    const text = after.content?.filter(block => block.type === 'text').map(block => block.text).join('\n') ?? ''
    assert.ok((text + JSON.stringify(after.structuredContent ?? {})).includes(plan.expectedText), 'Fresh native state must contain the expected input text')
    assert.notEqual(beforeSha256, afterSha256, 'Native screenshot must reflect the changed fixture')
    const cancelling = new AbortController()
    const capture = runtime.call('get_window_state', plan.observe, cancelling.signal, 'acceptance')
    const timer = setTimeout(() => cancelling.abort(), 1)
    let cancelled = false
    try { await capture } catch { cancelled = cancelling.signal.aborted }
    finally { clearTimeout(timer) }
    assert.equal(cancelled, true, 'Capture must be observed in flight; rerun if it finished before cancellation')
    assert.equal(runtime.quarantined, false, 'Cancelled job must receive its empty-job acknowledgement and exit')
    const fresh = await runtime.call('check_permissions', { prompt: false }, signal, 'acceptance')
    assert.equal(fresh?.isError ?? false, false, 'A fresh driver generation must initialize after confirmed cleanup')
    const report = { nativeDesktopValidated: true, osPermissionPrompted: false, clickAndTextVerified: true, captureCancellationJoined: true, modelVisionValidated: false, beforeSha256, afterSha256, at: new Date().toISOString() }
    writeFileSync(join(output, 'acceptance.json'), `${JSON.stringify(report, null, 2)}\n`)
    console.log(JSON.stringify(report))
  }
} finally { await runtime.dispose() }

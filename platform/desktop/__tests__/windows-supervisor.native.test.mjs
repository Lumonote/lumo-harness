/** Real Windows Job Objects and Node fixtures. No SDK, screenshots or system input. */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'

const source = fileURLToPath(new URL('../../dsh-plugins/computer-use/native/windows-supervisor.rs', import.meta.url))
const windows = process.platform === 'win32'
function exited(child) { return new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal }))) }
function alive(pid) { try { process.kill(pid, 0); return true } catch { return false } }
async function gone(pid) { for (let n = 0; n < 100 && alive(pid); n++) await delay(50); assert.equal(alive(pid), false, `PID ${pid} must exit`) }
function build(root) {
  const binary = join(root, 'supervisor with spaces.exe')
  const result = spawnSync('rustc', ['--edition=2021', '-C', 'target-feature=+crt-static', source, '-o', binary], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return binary
}
function worker(root) {
  const path = join(root, 'worker with spaces.mjs')
  writeFileSync(path, `import {spawn} from 'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});child.unref();console.log(JSON.stringify({kind:'fixture',pid:process.pid,descendant:child.pid}));process.stdin.resume();setInterval(()=>{},1000)`)
  return path
}
function firstMessage(child) {
  const input = createInterface({ input: child.stdout }); const messages = []
  const first = new Promise((resolve, reject) => { input.on('line', line => { try { const message = JSON.parse(line); messages.push(message); resolve(message) } catch (error) { reject(error) } }); child.once('error', reject) })
  return { first, messages }
}
test('Windows supervisor terminates and joins the whole job before its quiet acknowledgement', { skip: !windows, timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo windows job (&) '))
  let child
  try {
    child = spawn(build(root), [String(process.pid), process.execPath, worker(root)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    const closed = exited(child); const { first, messages } = firstMessage(child)
    const ready = await first
    assert.equal(ready.kind, 'fixture'); assert.ok(alive(ready.pid)); assert.ok(alive(ready.descendant))
    child.stdin.write('{"supervisor":"stop"}\n')
    assert.equal((await closed).code, 0)
    assert.deepEqual(messages.at(-1), { supervisor: 'quiet' })
    await gone(ready.pid); await gone(ready.descendant)
  } finally { child?.stdin.end(); rmSync(root, { recursive: true, force: true }) }
})
test('Windows supervisor closes the job when its Host process dies', { skip: !windows, timeout: 30_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'lumo windows host death '))
  let parent
  try {
    const binary = build(root); const fixture = worker(root)
    const script = join(root, 'host.mjs')
    writeFileSync(script, `import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';const child=spawn(${JSON.stringify(binary)},[String(process.pid),process.execPath,${JSON.stringify(fixture)}],{stdio:['pipe','pipe','pipe'],windowsHide:true});createInterface({input:child.stdout}).on('line',line=>console.log(JSON.stringify({...JSON.parse(line),supervisorPid:child.pid})));process.stdin.resume();setInterval(()=>{},1000)`)
    parent = spawn(process.execPath, [script], { stdio: ['pipe', 'pipe', 'pipe'] })
    const { first } = firstMessage(parent); const ready = await first
    parent.kill(); await gone(parent.pid)
    await gone(ready.pid); await gone(ready.descendant); await gone(ready.supervisorPid)
  } finally { parent?.kill(); rmSync(root, { recursive: true, force: true }) }
})

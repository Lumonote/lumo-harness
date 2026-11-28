/** Opt-in real-model acceptance. Run with Node --experimental-transform-types. */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { EngineHost } from '../src/engine-host.ts'
import { EngineRegistry, findExecutable } from '../src/registry.ts'
import { SessionAskBroker } from '../src/permission-asks.ts'

if (process.env.LUMO_REAL_CLAUDE_SMOKE !== '1') throw new Error('Set LUMO_REAL_CLAUDE_SMOKE=1 to authorize real local Claude calls')
const adapter = process.env.LUMO_CLAUDE_ACP_BIN ?? findExecutable('claude-agent-acp')
const executable = process.env.CLAUDE_CODE_EXECUTABLE ?? findExecutable('claude')
assert(adapter && executable, 'Install claude-agent-acp and log in to the local claude CLI first')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo-claude-smoke-')))
const token = `FIXTURE_${randomUUID()}`
writeFileSync(join(root, 'sample.txt'), token + '\n')
const scope = { realm: 'local-smoke', userId: 'local-smoke', projectId: 'fixture' }
const asks = new SessionAskBroker(30_000)
const report = { root, executable, adapter, startedAt: new Date().toISOString(), checks: [], approvals: [] }
const log = (phase, value = '') => console.log(JSON.stringify({ phase, value }))
const registry = new EngineRegistry([{ id: 'claude-code', label: 'Claude Code', protocol: 'acp', provider: 'claude-code', commands: [{ bin: adapter, args: [] }], env: { CLAUDE_CODE_EXECUTABLE: executable, CLAUDE_AGENT_ACP_PROTOCOL: 'v1' } }])
const options = { registry, asks, recoveryIndexPath: join(root, 'recovery.json'), initTimeoutMs: 90_000 }
let host = new EngineHost(options)
const stop = () => { host.closeAll(); process.exitCode = 130 }
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
let rejectedPermissions = 0
asks.subscribe(({ type, ask }) => {
  if (type !== 'ask.created') return
  let input
  try { input = JSON.parse(ask.detail ?? '{}') } catch { input = {} }
  let file = ''
  try { const path = resolve(root, input.file_path); file = join(realpathSync(dirname(path)), basename(path)) } catch { /* Unknown paths remain unapproved. */ }
  const allowed = file === join(root, 'sample.txt') && ask.source.operation === 'read'
    || file === join(root, 'receipt.txt') && input.content === 'CLAUDE_LOCAL_OK\n' && ask.source.operation === 'edit'
  const option = allowed && ask.options?.find(o => ['allow-once', 'allow_once'].includes(o.id))
  report.approvals.push({ operation: ask.source.operation, allowed: !!option })
  if (option) asks.answer(ask.id, option.id, scope)
  else {
    asks.cancel(ask.id)
    if (++rejectedPermissions >= 2) host.cancel(ask.source.session_ref, scope)
  }
  log('permission', { operation: ask.source.operation, allowed: !!option })
})
async function waitIdle(id, timeout = 180_000) {
  const start = Date.now()
  let progressAt = start
  while (host.get(id, scope)?.state === 'running') {
    if (Date.now() - start > timeout) { host.cancel(id, scope); throw new Error('Real Claude turn timed out') }
    if (Date.now() - progressAt > 10_000) { log('waiting', { seconds: Math.round((Date.now() - start) / 1000) }); progressAt = Date.now() }
    await new Promise(r => setTimeout(r, 50))
  }
  const events = host.history(id, scope, undefined, 1000)?.events ?? []
  const terminal = events.findLast(e => e.event.type === 'turn.ended')?.event
  assert(terminal && terminal.stopReason !== 'error', terminal?.error ?? 'Missing terminal event')
  return events
}
function text(events) { return events.filter(e => e.event.type === 'message.chunk' && e.event.role === 'agent').map(e => e.event.text).join('') }
try {
  log('fixture', root)
  const session = await host.createSession({ ...scope, engineId: 'claude-code', cwd: root, title: 'Local Claude acceptance' })
  report.capabilities = session.capabilities
  report.models = session.models
  report.modes = session.modes
  report.commands = session.commands?.map(c => c.name)
  if (session.modes?.availableModes.some(mode => mode.id === 'default')) await host.setMode(session.id, scope, 'default')
  report.checks.push('initialize/session-new')
  log('connected', { resume: session.capabilities?.loadSession, models: session.models?.availableModels?.length, commands: session.commands?.length })
  const prompt = `Use the Read tool to read the exact absolute path ${join(root, 'sample.txt')}. Use the Write tool to write the exact absolute path ${join(root, 'receipt.txt')} containing exactly CLAUDE_LOCAL_OK followed by one newline. These are the only approved paths; do not abbreviate them to /tmp. Do not run shell commands or touch other files. Reply with the exact token read from sample.txt.`
  assert.equal(host.prompt(session.id, scope, prompt, undefined, { clientMessageId: 'fixture-write' }).ok, true)
  let events = await waitIdle(session.id)
  assert.equal(readFileSync(join(root, 'receipt.txt'), 'utf8'), 'CLAUDE_LOCAL_OK\n')
  assert(text(events).includes(token), 'Real response did not contain the fixture token')
  assert(events.some(e => e.event.type === 'tool.call'), 'Missing native tool events')
  assert.equal(host.prompt(session.id, scope, prompt, undefined, { clientMessageId: 'fixture-write' }).duplicate, true)
  report.checks.push('real-read-write/permission/tool-output', 'prompt-idempotency')
  log('fixture-passed')
  host.release(session.id, scope)
  host.closeAll()
  host = new EngineHost(options)
  assert(text(host.history(session.id, scope, undefined, 1000).events).includes(token), 'Journal lost transcript after restart')
  await host.resume(session.id, scope)
  if (session.modes?.availableModes.some(mode => mode.id === 'default')) await host.setMode(session.id, scope, 'default')
  const before = host.history(session.id, scope, undefined, 1000).seq
  assert.equal(host.prompt(session.id, scope, 'Without using tools, repeat only the exact FIXTURE_ token read in our previous turn.', undefined, { clientMessageId: 'resume-check' }).ok, true)
  events = await waitIdle(session.id)
  assert(text(events.filter(e => e.seq > before)).includes(token), 'Resumed engine did not remember the preceding turn')
  report.checks.push('release/restart/durable-history/native-resume')
  log('resume-passed')
  assert.equal(host.prompt(session.id, scope, 'Explain the differences between breadth-first and depth-first search in detail. Do not use tools.', undefined, { clientMessageId: 'cancel-check' }).ok, true)
  assert.equal(host.cancel(session.id, scope).ok, true)
  events = await waitIdle(session.id, 30_000)
  report.cancelStopReason = events.findLast(e => e.event.type === 'turn.ended')?.event.stopReason
  assert.equal(report.cancelStopReason, 'cancelled')
  report.checks.push('native-cancel')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'
  report.error = error instanceof Error ? error.message : String(error)
  process.exitCode = 1
} finally {
  host.closeAll()
  report.finishedAt = new Date().toISOString()
  writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  log('result', report)
}

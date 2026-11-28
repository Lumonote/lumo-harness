#!/usr/bin/env node
/** Real local smoke: never substitutes fake engine output or reports Codex as tested.
 * LUMO_PROJECT_SMOKE=1 node platform/tools/project-collaboration-smoke.mjs prepare
 * LUMO_PROJECT_SMOKE=1 node platform/tools/project-collaboration-smoke.mjs plan --state=/private/tmp/.../state.json
 * Repeat with run, then merge (merge is always a separate explicit invocation).
 * --approvals=manual leaves safe approvals for the UI; unsafe approvals are rejected.
 * --self-test performs only local policy assertions, without HTTP or engine calls.
 */
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const ORIGIN = 'http://127.0.0.1:4200', PREFIX = '/lumo/api/acp'
const HANDOFF = '/private/tmp/lumo-native-integration-smoke/handoff'
const engineId = 'claude-code', hash = value => createHash('sha256').update(value).digest('hex')
const argv = process.argv.slice(2), option = (key, fallback) => argv.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) ?? fallback
const mode = argv.find(arg => !arg.startsWith('--')) ?? 'prepare'
const manual = option('approvals', 'auto') === 'manual'
const roles = [
  { id: 'left-author', name: '左文件实现者', engineId, capabilities: ['backend'], instruction: '负责 left.txt 的独立实现。只使用 Read/Write/Edit 文件工具，不执行 shell、MCP、Git 或网络。只编辑自己的 left.txt；规则来自当前项目 AGENTS.md。' },
  { id: 'right-author', name: '右文件实现者', engineId, capabilities: ['frontend'], instruction: '负责 right.txt 的独立实现。只使用 Read/Write/Edit 文件工具，不执行 shell、MCP、Git 或网络。只编辑自己的 right.txt；规则来自当前项目 AGENTS.md。' },
  { id: 'independent-reviewer', name: '独立规划与评审者', engineId, capabilities: ['planning', 'review'], instruction: '独立负责规划与只读评审，不承担实现。只使用 Read 文件工具读取当前工作区；禁止写入、shell、MCP、Git 或网络。评审必须实际读取两个交付文件。' },
]
const goal = '完成一个严格隔离的项目协作验收：AI 必须拆为恰好两个无依赖任务，任务 id 分别为 left 和 right。left 仅创建根目录 left.txt，分配 left-author，能力 backend；right 仅创建根目录 right.txt，分配 right-author，能力 frontend。两个文件的精确内容必须遵循 AGENTS.md 的 RULE_TOKEN 规则，不能猜 token。规划时把真实 RULE_TOKEN 放入每项验收条件以证明读取项目规则。禁止任何 shell、MCP、Git 或网络工具。实现时仅用 Read/Write/Edit，不修改 AGENTS.md 或 verify.mjs。平台随后执行 node verify.mjs，再由 independent-reviewer 读取两个文件做只读审查；评审 summary 必须包含实际 RULE_TOKEN。任何测试都由平台执行，实现者无需运行命令。'
let state, stateFile, cookie = ''
const evidence = []
const anonymous = value => {
  let text = String(value)
  if (state?.token) text = text.replaceAll(state.token, '<RULE_TOKEN>')
  if (state?.root) text = text.replaceAll(state.root, '<FIXTURE>')
  return text.replace(/\/Users\/[^/\s]+/gu, '/Users/<user>').replace(/(token|cookie|authorization)=\S+/giu, '$1=<redacted>')
}
function record(type, detail = {}) {
  evidence.push({ at: new Date().toISOString(), type, ...detail })
  if (stateFile) writeFileSync(join(dirname(stateFile), 'evidence.json'), JSON.stringify({ engine: engineId, codexTested: false, events: evidence }, null, 2) + '\n', { mode: 0o600 })
}
function git(args, cwd = state.root) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
}
function save() { const pending = `${stateFile}.tmp`; writeFileSync(pending, JSON.stringify(state, null, 2) + '\n', { mode: 0o600 }); renameSync(pending, stateFile) }
function originalUnchanged() {
  assert.equal(git(['rev-parse', 'HEAD']), state.base, 'Original HEAD changed before explicit merge')
  assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '', 'Original checkout changed before explicit merge')
}
function isolatedWorkspace(path) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const area = join(state.root, '.git', 'lumo-workflows'), rel = relative(area, path)
  return !!rel && !rel.startsWith('..') && !isAbsolute(rel) && realpathSync(path) === path
}
function fileTarget(raw, workspace, allowed) {
  if (typeof raw !== 'string' || /[\x00-\x1f]/u.test(raw)) return undefined
  const file = resolve(workspace, raw), rel = relative(workspace, file)
  if (!allowed.includes(rel) || realpathSync(dirname(file)) !== workspace) return undefined
  try { const info = lstatSync(file); if (info.isSymbolicLink() || !info.isFile()) return undefined } catch (error) { if (error.code !== 'ENOENT') return undefined }
  return rel
}
/** Fail closed: do not approve truncated inputs, shell-like aliases, or broad grants. */
function approvalDecision(ask, session) {
  const deny = reason => ({ allowed: false, reason })
  if (ask.source?.kind !== 'session' || !session || !isolatedWorkspace(session.workspace)) return deny('unowned-session')
  let input
  try { input = JSON.parse(ask.detail) } catch { return deny('missing-complete-input') }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return deny('invalid-input')
  if (input.file_path !== undefined && input.path !== undefined) return deny('ambiguous-path')
  const operation = ask.source.operation, title = String(ask.title ?? '').replace(/^claude-code 请求权限：/u, '')
  if (/(?:bash|shell|terminal|execute|mcp|web|fetch|command|network)/iu.test(`${operation} ${title}`)) return deny('forbidden-tool')
  const read = operation === 'read' || /^Read(?:\s|$)/u.test(title)
  const write = operation === 'edit' || /^(?:Write|Edit)(?:\s|$)/u.test(title)
  if (!read && !write) return deny('unknown-tool')
  const allowed = read ? ['AGENTS.md', '.gitignore', 'verify.mjs', 'left.txt', 'right.txt'] : session.file ? [session.file] : []
  const file = fileTarget(input.file_path ?? input.path, session.workspace, allowed)
  if (!file) return deny('path-outside-fixed-fixture')
  const keys = read ? ['file_path', 'path', 'offset', 'limit'] : ['file_path', 'path', 'content', 'old_string', 'new_string', 'replace_all']
  if (Object.keys(input).some(key => !keys.includes(key))) return deny('unexpected-input-fields')
  if (read && ['offset', 'limit'].some(key => input[key] !== undefined && (!Number.isSafeInteger(input[key]) || input[key] < 1))) return deny('invalid-read-range')
  if (input.replace_all !== undefined && typeof input.replace_all !== 'boolean') return deny('invalid-edit-mode')
  if (read) return { allowed: true, reason: 'fixture-read', file }
  if (session.kind !== 'implementation') return deny('read-only-member')
  const expected = `${file === 'left.txt' ? 'left' : 'right'}:${state.token}\n`
  if (input.content !== undefined) {
    if (input.content !== expected || input.old_string !== undefined || input.new_string !== undefined) return deny('unexpected-file-content')
  } else {
    if (typeof input.old_string !== 'string' || typeof input.new_string !== 'string') return deny('invalid-edit')
    let current
    try { current = readFileSync(join(session.workspace, file), 'utf8') } catch { return deny('missing-edit-target') }
    if (!input.old_string || !current.includes(input.old_string) || (input.replace_all ? current.replaceAll(input.old_string, input.new_string) : current.replace(input.old_string, input.new_string)) !== expected) return deny('unexpected-edit-result')
  }
  return { allowed: true, reason: 'fixture-write', file }
}
async function authenticate() {
  let launch
  try { launch = new URL(readFileSync(HANDOFF, 'utf8').trim()) } catch { throw new Error('Cannot read the local host handoff URL') }
  assert.equal(launch.origin, ORIGIN, 'Handoff must point to the fixed loopback BFF')
  let response
  try { response = await fetch(launch, { redirect: 'manual', signal: AbortSignal.timeout(10_000) }) } catch { throw new Error('Local host authentication exchange failed') }
  cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
  assert(cookie && [200, 302, 303, 307].includes(response.status), 'Launch exchange did not return a browser cookie')
}
async function api(path, value) {
  const response = await fetch(`${ORIGIN}${PREFIX}${path}`, { method: value === undefined ? 'GET' : 'POST', headers: { cookie, origin: ORIGIN, 'content-type': 'application/json' }, ...(value === undefined ? {} : { body: JSON.stringify(value) }), redirect: 'error', signal: AbortSignal.timeout(60_000) })
  if (!response.ok) throw new Error(`BFF ${value === undefined ? 'GET' : 'POST'} ${path.split('?')[0]} returned ${response.status}`)
  return response.json()
}
const roomPath = () => `/rooms/${state.roomId}`
const workflow = room => { const run = room.workflows?.find(value => value.id === state.runId); assert(run, 'Prepared workflow is missing'); return run }
const diagnostics = run => ({ state: run.state, ...(run.error ? { error: anonymous(run.error) } : {}),
  tasks: run.tasks.map(task => ({ id: task.id, state: task.state, files: task.changes?.files ?? [], ...(task.error ? { error: anonymous(task.error) } : {}), ...(task.reply ? { reply: anonymous(task.reply) } : {}) })),
  checks: run.results.map(result => ({ id: result.id, state: result.state, exitCode: result.exitCode, output: anonymous(result.output) })),
})
async function action(action) { return (await api(`${roomPath()}/workflow`, { action, runId: state.runId })).room }
function sessions(run) {
  return new Map([
    ...(run.plannerSessionId ? [[run.plannerSessionId, { kind: 'planning', workspace: run.plannerWorkspace.path }]] : []),
    ...run.tasks.filter(task => task.sessionId).map(task => [task.sessionId, { kind: 'implementation', workspace: task.workspace.path, file: task.id === 'left' ? 'left.txt' : 'right.txt' }]),
    ...(run.reviewSessionId ? [[run.reviewSessionId, { kind: 'review', workspace: run.reviewWorkspace.path }]] : []),
  ])
}
const seenAsks = new Set(), notifiedAsks = new Set()
async function approvals(run) {
  const owned = sessions(run), asks = (await api('/asks?status=pending')).asks ?? []
  for (const ask of asks) {
    const session = owned.get(ask.source?.session_ref)
    if (!session || seenAsks.has(ask.id)) continue
    const decision = approvalDecision(ask, session)
    if (decision.allowed && manual) {
      if (!notifiedAsks.has(ask.id)) { notifiedAsks.add(ask.id); console.log(`Permission pending in UI: ${decision.reason}, ${decision.file}`); record('permission-pending-ui', { member: session.kind, reason: decision.reason, file: decision.file }) }
      continue
    }
    const choice = ask.options?.find(value => value.permissionKind === (decision.allowed ? 'allow_once' : 'reject_once'))
    if (!choice) throw new Error('No safe one-time approval/rejection choice; inspect the pending request in the UI')
    await api(`/asks/${encodeURIComponent(ask.id)}/answer`, { value: choice.id })
    seenAsks.add(ask.id)
    record('permission', { member: session.kind, decision: decision.allowed ? 'allowed-once' : 'rejected-once', reason: decision.reason, ...(decision.file ? { file: decision.file } : {}) })
    console.log(`Permission: ${decision.allowed ? 'allowed once' : 'rejected once'} (${decision.reason}${decision.file ? `, ${decision.file}` : ''})`)
  }
}
async function waitFor(expected, allowMerged = false) {
  const deadline = Date.now() + 15 * 60_000; let previous = ''
  while (Date.now() < deadline) {
    const room = (await api(roomPath())).room, run = workflow(room)
    if (!allowMerged) originalUnchanged()
    if (run.state !== previous) { console.log(`Workflow: ${run.state}`); record('state', { state: run.state, originalUnchanged: !allowMerged }); previous = run.state }
    await approvals(run)
    if (run.error && !room.busy) { record('diagnostics', diagnostics(run)); throw new Error(anonymous(run.error)) }
    if (!room.busy && run.state === expected) return run
    if (!room.busy && ['failed', 'cancelled', 'interrupted'].includes(run.state)) throw new Error(`Workflow stopped: ${run.state}`)
    await sleep(1500)
  }
  await api(`${roomPath()}/stop`, {}).catch(() => {})
  throw new Error('Timed out; requested normal stop. Worktrees and history were retained for inspection.')
}
function verifyPlan(run) {
  assert.equal(run.tasks.length, 2, 'AI must return exactly two independent tasks')
  for (const file of ['left', 'right']) {
    const task = run.tasks.find(task => task.id === file)
    assert(task && task.roleId === `${file}-author` && task.dependsOn.length === 0, 'AI must respect independent implementation ownership')
    assert(task.acceptanceCriteria.some(value => value.includes(state.token)), 'Planner did not demonstrate project rule propagation')
  }
  assert.equal(run.reviewerId, 'independent-reviewer')
}
async function prepare() {
  const directory = mkdtempSync('/private/tmp/lumo-project-smoke-'), root = join(directory, 'project')
  mkdirSync(root); stateFile = join(directory, 'state.json')
  const suffix = randomBytes(5).toString('hex')
  state = { version: 1, root, token: randomBytes(12).toString('hex'), roomId: `project-smoke-${suffix}`, runId: `workflow-${suffix}`, name: `项目协作真实验收 ${suffix}` }
  writeFileSync(join(root, 'AGENTS.md'), `# Isolated collaboration acceptance\nRULE_TOKEN=${state.token}\n\nCreate only left.txt or right.txt assigned to your task. left.txt must contain exactly left:<RULE_TOKEN> followed by one LF. right.txt must contain exactly right:<RULE_TOKEN> followed by one LF. Substitute the actual RULE_TOKEN above. Do not change this file or verify.mjs. Use only native Read/Write/Edit file tools within this worktree. No shell, MCP, Git, network or external paths. The platform runs verification. The planner must include the actual RULE_TOKEN in both task acceptance criteria. The independent reviewer must use Read to inspect AGENTS.md, left.txt and right.txt, remain read-only, and include the actual RULE_TOKEN in the JSON summary.\n`)
  writeFileSync(join(root, '.gitignore'), '# Local OMC hook runtime metadata, declared before any model execution.\n.omc/\n')
  writeFileSync(join(root, 'verify.mjs'), "import assert from 'node:assert/strict';\nimport {readFileSync,readdirSync} from 'node:fs';\nconst token=/^RULE_TOKEN=([a-f0-9]+)$/m.exec(readFileSync('AGENTS.md','utf8'))?.[1];\nassert(token);\nfor(const name of ['left','right']) assert.equal(readFileSync(name+'.txt','utf8'),name+':'+token+'\\n');\nassert.deepEqual(readdirSync('.').filter(name=>!['.git','.omc'].includes(name)).sort(),['.gitignore','AGENTS.md','left.txt','right.txt','verify.mjs']);\nconsole.log('PASS: two independent files obey project rules');\n")
  git(['init', '--template=', '-b', 'smoke'], root)
  for (const [key, value] of [['user.name', 'Lumo Smoke'], ['user.email', 'smoke@invalid.local'], ['commit.gpgsign', 'false'], ['core.hooksPath', '/dev/null']]) git(['config', key, value], root)
  git(['add', '.gitignore', 'AGENTS.md', 'verify.mjs'], root); git(['commit', '-m', 'Initialize isolated project collaboration fixture'], root)
  state.base = git(['rev-parse', 'HEAD']); save()
  const probes = (await api('/engines')).engines
  assert(probes.some(engine => engine.id === engineId && engine.available), 'Local Claude Code is unavailable')
  for (const role of roles) await api('/agents', { ...role, id: `${state.roomId}-${role.id}` })
  await api('/rooms', { id: state.roomId, name: state.name, cwd: root, coordinatorId: 'independent-reviewer', appearance: { logo: 'team', color: '#a66a45' }, roles: roles.map(role => ({ ...role, agentId: `${state.roomId}-${role.id}` })) })
  const room = (await api(`${roomPath()}/workflow`, { action: 'prepare', id: state.runId, goal, reviewerId: 'independent-reviewer', maxParallel: 2, checks: [{ id: 'fixture-files', command: process.execPath, args: ['verify.mjs'], timeoutMs: 10_000 }] })).room
  const run = workflow(room)
  assert.equal(run.state, 'draft'); assert(run.rules.files.some(file => file.path === 'AGENTS.md' && file.content.includes(state.token)))
  originalUnchanged(); record('prepared', { members: 3, distinctEngines: [engineId], rulesDigest: run.rules.digest, originalUnchanged: true })
  console.log(`Prepared room: ${state.name}\nRoom id: ${state.roomId}\nState: ${stateFile}`)
}
async function inspectEvidence(run) {
  verifyPlan(run)
  assert(run.tasks.every(task => task.state === 'completed' && task.changes.files.length === 1 && task.changes.files[0] === `${task.id}.txt`))
  assert.equal(new Set(run.tasks.map(task => task.workspace.path)).size, 2)
  assert(run.results.length === 1 && run.results[0].state === 'passed' && run.results[0].exitCode === 0 && run.results[0].commit === run.commit)
  assert(run.review?.verdict === 'approved' && run.review.findings.length === 0 && run.review.roleId === 'independent-reviewer' && run.review.commit === run.commit)
  assert(run.review.summary.includes(state.token), 'Reviewer did not demonstrate project rule propagation')
  const history = await api(`/sessions/${run.reviewSessionId}/history?limit=1000`)
  const reads = history.events.filter(entry => ['tool.call', 'tool.update'].includes(entry.event.type) && (entry.event.kind === 'read' || /^Read(?:\s|$)/u.test(entry.event.title ?? ''))).map(entry => entry.event)
  for (const file of ['left.txt', 'right.txt']) assert(reads.some(event => `${event.input ?? ''} ${JSON.stringify(event.locations ?? [])}`.includes(file)), `Reviewer did not read ${file} through a native file tool`)
  const owned = sessions(run), answered = (await api('/asks?status=answered')).asks ?? []
  for (const ask of answered) {
    const session = owned.get(ask.source?.session_ref)
    if (!session) continue
    const choice = ask.options?.find(option => option.id === ask.answer?.value), decision = approvalDecision(ask, session)
    assert(decision.allowed && choice?.permissionKind === 'allow_once', 'A native approval exceeded the exact fixture or one-time permission policy')
    const fingerprint = hash(ask.id).slice(0, 16)
    if (!evidence.some(event => event.type === 'native-approval-observed' && event.fingerprint === fingerprint)) record('native-approval-observed', { fingerprint, member: session.kind, permissionKind: 'allow_once', file: decision.file })
  }
  record('verified', { tasks: run.tasks.map(task => ({ id: task.id, role: task.roleId, files: task.changes.files, commit: task.changes.head })), checks: run.results.map(result => ({ id: result.id, exitCode: result.exitCode, state: result.state, commit: result.commit })), review: { verdict: run.review.verdict, role: run.review.roleId, commit: run.review.commit, actualFileReads: ['left.txt', 'right.txt'] }, rulesPropagatedTo: 3, originalUnchanged: true })
}
function selfTest() {
  const directory = mkdtempSync('/private/tmp/lumo-project-policy-'), workspace = join(directory, '.git', 'lumo-workflows', 'run', 'task-left')
  mkdirSync(workspace, { recursive: true }); state = { root: directory, token: 'abc' }
  const session = { kind: 'implementation', workspace, file: 'left.txt' }
  const ask = (input, operation = 'edit', title = 'Write left.txt') => ({ source: { kind: 'session', operation }, title, detail: JSON.stringify(input) })
  assert(approvalDecision(ask({ file_path: join(workspace, 'left.txt'), content: 'left:abc\n' }), session).allowed)
  assert(!approvalDecision(ask({ file_path: join(workspace, 'right.txt'), content: 'right:abc\n' }), session).allowed)
  assert(!approvalDecision(ask({ file_path: '/tmp/external.txt', content: 'left:abc\n' }), session).allowed)
  assert(!approvalDecision(ask({ file_path: join(workspace, 'left.txt'), content: 'wrong' }), session).allowed)
  assert(!approvalDecision(ask({ command: 'touch left.txt' }, 'execute', 'Bash'), session).allowed)
  assert(!approvalDecision(ask({ file_path: join(workspace, 'left.txt'), content: 'left:abc\n' }), { ...session, kind: 'review', file: undefined }).allowed)
  assert(!approvalDecision(ask({ file_path: join(workspace, 'left.txt'), content: 'left:abc\n', command: 'bad' }), session).allowed)
  assert(approvalDecision(ask({ file_path: join(workspace, 'AGENTS.md') }, 'read', 'Read AGENTS.md'), { ...session, kind: 'review' }).allowed)
  assert(!approvalDecision(ask({ file_path: join(workspace, 'AGENTS.md'), offset: -1 }, 'read', 'Read AGENTS.md'), session).allowed)
  assert(!approvalDecision(ask({ file_path: join(workspace, 'AGENTS.md'), path: '/tmp/external' }, 'read', 'Read AGENTS.md'), session).allowed)
  assert(!approvalDecision(ask({ file_path: join(workspace, 'AGENTS.md') }, 'read', 'mcp__filesystem__Read'), session).allowed)
  assert(!approvalDecision({ ...ask({}), detail: '{"file_path":' }, session).allowed)
  assert(!approvalDecision(ask({ file_path: join(workspace, 'left.txt'), old_string: 'x', new_string: 'left:abc\n' }), session).allowed)
  console.log('PASS: approval policy self-test; no network or engine calls')
}
async function main() {
  if (argv.includes('--self-test')) return selfTest()
  assert.equal(process.env.LUMO_PROJECT_SMOKE, '1', 'Set LUMO_PROJECT_SMOKE=1 to opt into real local Claude Code calls and isolated fixture changes')
  assert(['prepare', 'plan', 'run', 'merge', 'status'].includes(mode), 'Use prepare, plan, run, merge, or status')
  if (mode !== 'prepare') {
    stateFile = option('state'); assert(stateFile, '--state is required after prepare')
    assert(/^\/private\/tmp\/lumo-project-smoke-[^/]+\/state\.json$/u.test(stateFile), 'State must belong to an isolated smoke directory')
    state = JSON.parse(readFileSync(stateFile, 'utf8'))
    assert.equal(state.root, join(dirname(stateFile), 'project')); assert.equal(realpathSync(state.root), state.root)
    try { evidence.push(...JSON.parse(readFileSync(join(dirname(stateFile), 'evidence.json'), 'utf8')).events) } catch {}
  }
  await authenticate()
  if (mode === 'prepare') return prepare()
  let run = workflow((await api(roomPath())).room)
  if (mode === 'status') { record('snapshot', diagnostics(run)); console.log(`Room: ${state.name}\n${JSON.stringify(diagnostics(run), null, 2)}`); return }
  originalUnchanged()
  if (mode === 'plan') {
    assert.equal(run.state, 'draft'); await action('suggest'); run = await waitFor('draft'); verifyPlan(run)
    state.planned = true; save(); record('planned', { tasks: 2, independent: true, projectRulesObserved: true }); console.log('PASS: AI produced two independent tasks using project rules'); return
  }
  assert(state.planned, 'Run plan first; no handcrafted replacement of AI planning is accepted')
  if (mode === 'run') {
    verifyPlan(run); assert.equal(run.state, 'draft'); await action('run'); run = await waitFor('ready'); await inspectEvidence(run)
    console.log(`PASS: ready for explicit merge; original checkout unchanged\nEvidence: ${join(dirname(stateFile), 'evidence.json')}`); return
  }
  assert.equal(run.state, 'ready'); await inspectEvidence(run); await action('merge'); run = await waitFor('merged', true)
  assert.equal(git(['rev-parse', 'HEAD']), run.commit); assert.equal(git(['status', '--porcelain', '--untracked-files=all']), '')
  execFileSync(process.execPath, ['verify.mjs'], { cwd: state.root, stdio: ['ignore', 'pipe', 'pipe'] })
  record('explicit-merge', { state: run.state, commit: run.commit, originalChangedOnlyAfterMerge: true, finalFileAssertionsPassed: true })
  console.log(`PASS: explicit merge and final file assertions\nEvidence: ${join(dirname(stateFile), 'evidence.json')}`)
}
main().catch(error => { const message = anonymous(error.message ?? error); record('failure', { stage: mode, message }); console.error(message); process.exitCode = 1 })

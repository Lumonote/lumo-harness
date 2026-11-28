import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertProjectWorkflowBudget, decodeProjectWorkflow, parseProjectChecks, parseProjectTasks, PROJECT_WORKFLOW_LIMITS, workflowSessions, type ProjectWorkflow } from '../src/project-workflow-model.ts'
import { RoleRoomStore } from '../src/role-room-store.ts'
import type { RoleRoom } from '../src/role-room-model.ts'

const sha = 'a'.repeat(40), merged = 'b'.repeat(40), digest = 'c'.repeat(64), runKey = 'd'.repeat(24)
const session1 = '11111111-1111-1111-1111-111111111111', session2 = '22222222-2222-2222-2222-222222222222'
const date = '2026-11-28T11:00:00.000Z'
const workspace = (taskId: string, baseCommit = sha) => ({ runId: runKey, taskId, path: `/repo/.git/lumo-workflows/${runKey}/${taskId}`, branch: `codex/lumo-${runKey}-${taskId}`, baseCommit })
function draft(): ProjectWorkflow {
  return { id: 'flow', goal: 'Implement a feature', state: 'draft', createdAt: date, updatedAt: date, requestDigest: digest,
    repository: { root: '/repo', commonDir: '/repo/.git', branch: 'main', baseCommit: sha }, rules: { digest, files: [{ path: 'AGENTS.md', content: 'Run actual tests', digest }], warnings: [] },
    tasks: [{ id: 'implementation', title: 'Implement', instruction: 'Build the requested feature', dependsOn: [], capabilities: ['backend'], acceptanceCriteria: ['Pass real checks'], roleId: 'engineer', routingReason: 'Backend capability', assignment: 'auto', state: 'pending' }],
    reviewerId: 'reviewer', maxParallel: 2, checks: [{ id: 'tests', command: 'node', args: ['test.js'] }], results: [] }
}
function ready(): ProjectWorkflow {
  const value = draft()
  value.state = 'ready'; value.commit = merged; value.contextDigest = digest
  value.tasks[0] = { ...value.tasks[0]!, state: 'completed', sessionId: session1, workspace: workspace('task-implementation'), reply: 'Implemented feature',
    changes: { head: merged, commit: merged, status: '', stat: 'feature.ts | 1 +', diff: '+feature', files: ['feature.ts'], truncated: false } }
  value.integration = workspace('integration'); value.reviewWorkspace = workspace('review-abc', merged); value.reviewSessionId = session2
  value.results = [{ ...value.checks[0]!, state: 'passed', exitCode: 0, output: '1 test passed', truncated: false, commit: merged, startedAt: date, finishedAt: date }]
  value.review = { verdict: 'approved', summary: 'Actual implementation meets criteria', findings: [], commit: merged, roleId: 'reviewer' }
  value.reviewReply = '{"verdict":"approved"}'; value.sessionHistory = [session1, session2]
  return value
}
const reject = (mutate: (value: any) => void, source: () => ProjectWorkflow = ready) => { const value = source(); mutate(value); expect(() => decodeProjectWorkflow(value)).toThrow() }

describe('persisted project workflow validation', () => {
  it('round-trips draft and full ready evidence without retaining mutable references', () => {
    expect(decodeProjectWorkflow(draft())).toEqual(draft())
    const value = ready(), decoded = decodeProjectWorkflow(value)
    expect(decoded).toEqual(value)
    decoded.tasks[0]!.reply = 'changed'; decoded.results[0]!.output = 'changed'; decoded.rules.files[0]!.content = 'changed'
    expect(value.tasks[0]!.reply).toBe('Implemented feature'); expect(value.results[0]!.output).toBe('1 test passed'); expect(value.rules.files[0]!.content).toBe('Run actual tests')
  })
  it('accepts partial failed evidence and preserves interrupted status without claiming success', () => {
    const value = draft(); value.state = 'interrupted'; value.tasks[0]!.state = 'interrupted'; value.tasks[0]!.workspace = workspace('task-implementation'); value.tasks[0]!.sessionId = session1
    expect(decodeProjectWorkflow(value).state).toBe('interrupted')
    value.state = 'failed'; value.error = 'dependency merge conflict'; value.tasks[0]!.state = 'failed'; value.tasks[0]!.workspace = workspace('deps-implementation'); delete value.tasks[0]!.sessionId
    expect(decodeProjectWorkflow(value).tasks[0]!.workspace?.taskId).toBe('deps-implementation')
    const negative = ready(); negative.state = 'failed'; negative.review!.verdict = 'changes_requested'; negative.review!.findings = ['Missing test']; negative.error = 'Review failed'
    expect(decodeProjectWorkflow(negative).review?.findings).toEqual(['Missing test'])
  })
  it('rejects traversal, repository option injection and invalid commit hashes', () => {
    for (const [key, value] of [['root', 'relative'], ['commonDir', '/repo/../other'], ['branch', '--upload-pack=evil'], ['branch', 'a..b'], ['baseCommit', 'HEAD']]) reject(v => { v.repository[key] = value })
    reject(v => { v.integration.path = '/other/path' })
    reject(v => { v.integration.runId = '../escape' })
    reject(v => { v.integration.branch = 'main' })
    reject(v => { v.tasks[0].workspace.taskId = 'task-other' })
    reject(v => { v.tasks[0].workspace.baseCommit = 'HEAD' })
    reject(v => { v.integration = workspace('integration'); v.integration.runId = 'other' })
  })
  it('validates all rule sources, order, hashes, content and byte limits', () => {
    reject(v => { v.rules.digest = 'bad' }); reject(v => { v.rules.files[0].digest = 'bad' })
    reject(v => { v.rules.files[0].path = '../../secret' }); reject(v => { v.rules.files.push({ ...v.rules.files[0] }) })
    reject(v => { v.rules.files = [{ ...v.rules.files[0], path: 'CLAUDE.md' }, v.rules.files[0]] })
    reject(v => { v.rules.files[0].content = '好'.repeat(22000) })
    reject(v => { v.rules.files = ['AGENTS.md', 'CLAUDE.md', '.lumo/project.md'].map(path => ({ path, digest, content: 'x'.repeat(50000) })) })
    reject(v => { v.rules.warnings = ['x'.repeat(2001)] }); reject(v => { v.rules.files[0].content = 7 })
  })
  it('requires the actual check identity, arguments, status and tested commit', () => {
    reject(v => { v.results[0].command = 'other' }); reject(v => { v.results[0].args = ['other.js'] })
    reject(v => { v.results[0].timeoutMs = 1000 }); reject(v => { v.results[0].id = 'unknown' })
    reject(v => { v.results[0].commit = sha }); reject(v => { v.results[0].exitCode = 1 })
    reject(v => { v.results[0].exitCode = '0' }); reject(v => { v.results[0].truncated = 'false' })
    reject(v => { v.results[0].output = '好'.repeat(6000) }); reject(v => { v.results[0].finishedAt = '2025-01-01T00:00:00Z' })
    reject(v => { v.results.push(v.results[0]) }); reject(v => { v.checks[0].shell = true })
    const zeroFailed = ready(); zeroFailed.state = 'failed'; zeroFailed.results[0]!.state = 'failed'; zeroFailed.error = 'left a background process'
    expect(decodeProjectWorkflow(zeroFailed).results[0]?.exitCode).toBe(0)
  })
  it('rejects broken task evidence and oversized replies, diffs and paths', () => {
    reject(v => { delete v.tasks[0].changes }); reject(v => { delete v.tasks[0].workspace })
    reject(v => { v.tasks[0].changes.status = ' M feature.ts' }); reject(v => { v.tasks[0].changes.commit = sha })
    reject(v => { v.tasks[0].changes.diff = 'x'.repeat(65537) }); reject(v => { v.tasks[0].changes.files = ['../secret'] })
    reject(v => { v.tasks[0].reply = 'x'.repeat(8193) }); reject(v => { v.tasks[0].error = 'x'.repeat(2001) })
    reject(v => { v.tasks[0].sessionId = 'not-a-session' }); reject(v => { v.tasks[0].assignment = 'random' })
    reject(v => { v.tasks[0].execute = 'shell command' })
    expect(() => parseProjectTasks([{ ...draft().tasks[0], id: 'x'.repeat(49) }])).toThrow()
  })
  it('requires complete matching approval and test evidence for ready, merging and merged states', () => {
    for (const state of ['ready', 'merging', 'merged'] as const) {
      const valid = ready(); valid.state = state; if (state === 'merged') valid.mergedAt = date
      expect(decodeProjectWorkflow(valid).state).toBe(state)
      const source = () => structuredClone(valid)
      reject(v => { v.results = [] }, source); reject(v => { v.checks = []; v.results = [] }, source)
      reject(v => { v.review.verdict = 'changes_requested' }, source); reject(v => { v.review.findings = ['issue'] }, source)
      reject(v => { v.review.commit = sha }, source); reject(v => { v.review.roleId = 'engineer' }, source)
      reject(v => { v.reviewerId = 'engineer'; v.review.roleId = 'engineer' }, source)
      reject(v => { v.tasks[0].state = 'running' }, source); reject(v => { v.conflicts = ['feature.ts'] }, source)
      reject(v => { v.error = 'failed' }, source); reject(v => { delete v.integration }, source)
    }
    reject(v => { v.state = 'merged' }); reject(v => { v.mergedAt = date })
  })
  it('retains bounded historical failures and unions old sessions with current sessions', () => {
    const value = ready(), old = { ...value.results[0]!, state: 'failed' as const, exitCode: 3, commit: sha }
    value.previousEvidence = [{ commit: sha, results: [old], savedAt: date, reviewReply: 'incomplete', error: 'Failed check' }]
    value.sessionHistory = ['33333333-3333-3333-3333-333333333333', session1]
    expect(decodeProjectWorkflow(value).previousEvidence?.[0]?.results[0]?.exitCode).toBe(3)
    expect(workflowSessions(value)).toEqual(['33333333-3333-3333-3333-333333333333', session1, session2])
    reject(v => { v.previousEvidence = [{ commit: sha, results: [v.results[0]], savedAt: date }] })
    reject(v => { v.previousEvidence = Array.from({ length: 9 }, () => ({ commit: sha, results: [], savedAt: date })) })
    reject(v => { v.previousEvidence = [{ results: [], savedAt: 'bad' }] })
    reject(v => { v.sessionHistory = [session1, session1] }); reject(v => { v.sessionHistory = ['bad'] })
  })
  it('validates optional digests, context lists and schema without accessing disk', () => {
    reject(v => { v.requestDigest = 'HEAD' }); reject(v => { v.contextDigest = '' }); reject(v => { v.reviewReply = 'x'.repeat(8193) })
    reject(v => { v.files = ['../../secret'] }); reject(v => { v.skills = ['../bad'] }); reject(v => { v.files = ['same', 'same'] })
    reject(v => { v.environment = { FORCE: 'yes' } }); reject(v => { v.plannerSessionId = 'bad' }); reject(v => { v.results[0].state = 'completed' })
    const windows = draft(); windows.repository.root = 'C:\\project'; windows.repository.commonDir = 'C:\\project\\.git'
    expect(decodeProjectWorkflow(windows).repository.root).toBe('C:\\project')
    const revalidating = ready(); revalidating.state = 'validating'; revalidating.commit = sha; revalidating.results = []; delete revalidating.review
    expect(decodeProjectWorkflow(revalidating).state).toBe('validating')
  })

  it('bounds accepted command configurations before repeated evidence could exceed the snapshot budget', () => {
    const commands = [{ id: 'big', command: 'node', args: Array.from({ length: 9 }, () => 'x'.repeat(4096)) }]
    expect(() => parseProjectChecks(commands)).toThrow('32 KiB')
    expect(() => assertProjectWorkflowBudget({ output: 'x'.repeat(PROJECT_WORKFLOW_LIMITS.jsonBytes - PROJECT_WORKFLOW_LIMITS.reserveBytes) })).toThrow('容量上限')
    const source = { output: 'kept' }; assertProjectWorkflowBudget(source); expect(source.output).toBe('kept')
  })

  it('reserves enough snapshot space to persist a capacity failure without deleting prior evidence', () => {
    const value = ready(), file = 'x'.repeat(3990)
    value.tasks[0]!.changes!.files = Array.from({ length: 495 }, (_, n) => `${n}-${file}`)
    const encoded = Buffer.byteLength(JSON.stringify(value))
    expect(encoded).toBeGreaterThan(PROJECT_WORKFLOW_LIMITS.jsonBytes - PROJECT_WORKFLOW_LIMITS.reserveBytes)
    expect(encoded).toBeLessThan(PROJECT_WORKFLOW_LIMITS.jsonBytes)
    expect(() => assertProjectWorkflowBudget(value)).toThrow('容量上限')
    value.state = 'failed'; value.error = 'Capacity reached; existing evidence retained.'
    expect(decodeProjectWorkflow(value).tasks[0]?.changes?.files).toHaveLength(495)
  })

  it('round-trips valid normalized references, unusual Git filenames and bounded native replies', () => {
    const value = ready(); value.files = ['./README.md', 'src/../README.md', 'src//file.ts', ' ']
    value.tasks[0]!.changes!.files = ['line\nbreak.txt', 'literal\\name.txt', ' ', 'C:literal.txt']
    value.tasks[0]!.reply = 'x'.repeat(8000) + '\n[回复已截断，详见成员会话]'
    expect(decodeProjectWorkflow(value)).toEqual(value)
    reject(v => { v.files = ['src/../../secret'] })
  })

  it('rejects unreadable writes atomically and preserves the last restorable snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'lumo-model-store-'))
    try {
      const path = join(directory, 'rooms.json'), store = new RoleRoomStore(path)
      const room: RoleRoom = { id: 'room', name: 'Team', cwd: '/repo', realm: 'local', userId: 'owner', coordinatorId: 'reviewer', createdAt: date, turns: [],
        roles: [{ id: 'engineer', name: 'Engineer', engineId: 'tool-a', instruction: 'Implement' }, { id: 'reviewer', name: 'Reviewer', engineId: 'tool-b', instruction: 'Review' }], workflows: [ready()] }
      store.put(room)
      expect(new RoleRoomStore(path).get('room')?.workflows?.[0]?.state).toBe('ready')
      const malformed = structuredClone(room); malformed.workflows![0]!.sessionHistory = Array.from({ length: 129 }, (_, n) => `${n.toString(16).padStart(8, '0')}-1111-1111-1111-111111111111`)
      expect(() => store.put(malformed)).toThrow('历史会话')
      expect(new RoleRoomStore(path).get('room')?.workflows?.[0]).toEqual(room.workflows![0])
      const active = structuredClone(room); active.workflows![0]!.state = 'reviewing'; delete active.workflows![0]!.review; delete active.workflows![0]!.reviewReply
      store.put(active)
      expect(new RoleRoomStore(path).get('room')?.workflows?.[0]?.state).toBe('interrupted')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})

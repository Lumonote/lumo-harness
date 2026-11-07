import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ArchiveError, manifestDigest, parseArgs, stripReplaySecrets, validateDataset, verifyArchive, writeArchive } from './archive-governance-results.mjs'

const sha = body => createHash('sha256').update(body).digest('hex')
const realm = 'archive-test'
const scope = { realm, cutoff: '2026-11-07T00:00:00.000Z', limit: 2 }
const snapshot = { id: '123:126:124', started_at: '2026-11-07T00:00:00+00:00' }

function bundle({ dependency = true, fileText = '\uFEFFhello <world> & 审计\n' } = {}) {
  const task = { id: 'producer-task', realm, business_state: 'DONE', updated_at: '2026-11-01T00:00:00Z' }
  const producerRun = { id: 'producer-run', realm, task_id: task.id, attempt: 1 }
  const text = '<deliverable> & separator \u2028\u2029'
  const body = Buffer.from(fileText)
  const file = { id: 'file-0001', name: 'report.md', media_type: 'text/markdown; charset=utf-8', bytes: body.length, sha256: sha(body) }
  const manifest = { scope: 'platform-closed-text-files-v1', task_id: task.id, run_id: producerRun.id, summary: '审计 & <完成>', entries: [{ id: 'output-0001', sha256: sha(text), text }], files: [file] }
  const manifestRow = { realm, run_id: producerRun.id, task_id: task.id, digest: manifestDigest(manifest), manifest }
  const producerResult = { realm, run_id: producerRun.id, task_id: task.id, payload: { task_id: task.id, run_id: producerRun.id, state: 'COMPLETED', summary: manifest.summary, output: [{ type: 'text', text }], files: [{ name: file.name, media_type: file.media_type, text: fileText }] } }
  const data = {
    tasks: [task], dependency_tasks: [], runs: [producerRun], results: [producerResult],
    snapshots: [{ realm, task_id: task.id, run_id: producerRun.id, snapshot: { realm, task_id: task.id, run_id: producerRun.id, output_profile: manifest.scope } }],
    output_manifests: [manifestRow], reviews: [], review_file_reads: [],
    file_blobs: [{ realm, run_id: producerRun.id, entry_id: file.id, name: file.name, media_type: file.media_type, bytes: file.bytes, sha256: file.sha256, body_path: 'blobs/00000001.bin' }],
  }
  if (dependency) {
    data.dependency_tasks.push({ id: 'review-task', realm, business_state: 'EXECUTING', project_id: 'project' })
    data.runs.push({ id: 'review-run', realm, task_id: 'review-task', attempt: 1 })
    data.results.push({ realm, run_id: 'review-run', task_id: 'review-task', payload: { task_id: 'review-task', run_id: 'review-run', state: 'COMPLETED', summary: 'Reviewed' } })
    data.reviews.push({ realm, review_run_id: 'review-run', producer_task_id: task.id, producer_run_id: producerRun.id, manifest_digest: manifestRow.digest })
    data.review_file_reads.push({ realm, review_run_id: 'review-run', producer_run_id: producerRun.id, entry_id: file.id, manifest_digest: manifestRow.digest, result_receipt_matches: true })
  }
  const bodies = new Map([['blobs/00000001.bin', body]])
  return { data, bodies, scope: { ...scope }, snapshot, counts: validateDataset(data, scope, bodies) }
}

async function archive(t, value = bundle()) {
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'lumo-archive-test-'))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const output = join(parent, 'archive')
  const result = await writeArchive(output, value)
  return { output, result }
}

async function rewriteManifest(output, update) {
  const path = join(output, 'manifest.json'), manifest = JSON.parse(await readFile(path, 'utf8'))
  await update(manifest)
  await writeFile(path, JSON.stringify(manifest), { mode: 0o600 })
}

test('CLI defaults to a bounded preview and normalizes precise UTC', () => {
  const auditPath = join(tmpdir(), 'audit')
  assert.deepEqual(parseArgs(['--realm', realm, '--cutoff', '2026-11-07T00:00:00.1Z']), { mode: 'dry-run', realm, cutoff: '2026-11-07T00:00:00.100Z', limit: 100 })
  assert.equal(parseArgs(['--realm', realm, '--cutoff', scope.cutoff, '--limit', '1', '--execute', '--output', join(tmpdir(), 'new-audit')]).mode, 'execute')
  assert.deepEqual(parseArgs(['--verify', auditPath]), { mode: 'verify', output: auditPath })
  for (const args of [[], ['--help', '--execute'], ['--verify', 'relative'], ['--verify', auditPath, '--execute'], ['--realm', realm, '--cutoff', '2026-02-30T00:00:00Z'], ['--realm', realm, '--cutoff', scope.cutoff, '--limit', '101'], ['--realm', realm, '--cutoff', scope.cutoff, '--execute', '--dry-run'], ['--realm', realm, '--realm', realm, '--cutoff', scope.cutoff], ['--realm', realm, '--cutoff', scope.cutoff, '--output', auditPath], ['--realm', realm, '--cutoff', scope.cutoff, '--execute', '--output', 'relative']]) assert.throws(() => parseArgs(args), ArchiveError)
})

test('structured receipt replay secrets are recursively removed without content replacement', () => {
  assert.deepEqual(stripReplaySecrets({ receipt: 'secret', payload: { review_file_receipts: [{ id: 'file-0001', receipt: 'secret' }], output: [{ text: 'Keep business content.' }], nested: [{ reviewFileReceipts: [], useful: true }] } }), { payload: { output: [{ text: 'Keep business content.' }], nested: [{ useful: true }] } })
})

test('Go digest fixture covers field order, HTML, separators and omitted files', () => {
  // Generated independently with Go encoding/json and the production typed struct layout.
  const text = '<deliverable> & separator \u2028\u2029'
  const manifest = { entries: [{ text, sha256: sha(text), id: 'output-0001' }], summary: '审计 & <完成>', run_id: 'producer-run', task_id: 'producer-task', scope: 'platform-closed-text-v1' }
  assert.equal(manifestDigest(manifest), 'a4cccebb275fd1bf12f59cd2ea0ef676bcd6e7b0bc0679291c472ee7d0a3d958')
  assert.equal(manifestDigest({ ...manifest, files: [] }), manifestDigest(manifest))
  assert.throws(() => manifestDigest({ ...manifest, arbitrary: true }), ArchiveError)
})

test('dataset enforces complete controlled bytes and receipt evidence', () => {
  const good = bundle()
  assert.equal(good.counts.controlled_files, 1)
  for (const mutate of [
    value => { value.data.file_blobs = [] },
    value => { value.bodies.set('blobs/00000001.bin', Buffer.from('damaged')) },
    value => { value.bodies.set('blobs/00000002.bin', Buffer.from('extra')) },
    value => { value.data.file_blobs.push({ ...value.data.file_blobs[0], entry_id: 'orphan' }) },
    value => { value.data.output_manifests[0].digest = '0'.repeat(64) },
    value => { value.data.results[0].payload.files[0].text += 'mismatch' },
    value => { value.data.results[0].payload.review_file_receipts = [{ id: 'file-0001', receipt: 'secret' }] },
    value => { value.data.review_file_reads[0].result_receipt_matches = false },
    value => { value.data.review_file_reads = [] },
    value => { value.data.tasks[0].business_state = 'VERIFYING' },
    value => { value.data.tasks[0].updated_at = '2026-11-08T00:00:00Z' },
    value => { value.data.runs[0].realm = 'other' },
    value => { value.data.runs.push({ id: 'unrelated', task_id: 'review-task', realm }) },
  ]) {
    const value = bundle(); mutate(value)
    assert.throws(() => validateDataset(value.data, value.scope, value.bodies), ArchiveError)
  }
})

test('text-only manifests allow zero blobs and failed unsealed results remain unproven', () => {
  const value = bundle({ dependency: false }), row = value.data.output_manifests[0]
  row.manifest.scope = 'platform-closed-text-v1'; delete row.manifest.files; row.digest = manifestDigest(row.manifest); value.data.snapshots[0].snapshot.output_profile = row.manifest.scope
  delete value.data.results[0].payload.files; value.data.file_blobs = []; value.bodies.clear()
  assert.equal(validateDataset(value.data, value.scope, value.bodies).controlled_files, 0)
  value.data.output_manifests = []; value.data.snapshots = []; value.data.results[0].payload.state = 'FAILED'; value.data.results[0].payload.files = [{ name: 'failed.md', media_type: 'text/markdown; charset=utf-8', text: 'unsealed' }]
  assert.equal(validateDataset(value.data, value.scope, value.bodies).runs, 1)
})

test('archive round-trip preserves UTF-8 BOM bytes in private files and never overwrites', async t => {
  const { output, result } = await archive(t)
  assert.equal(result.mode, 'exported')
  assert.equal(result.database_modified, false)
  assert.equal(result.storage_reclaimed_bytes, 0)
  assert.equal((await verifyArchive(output)).mode, 'verified')
  assert.equal((await lstat(output)).mode & 0o777, 0o700)
  assert.equal((await lstat(join(output, 'manifest.json'))).mode & 0o777, 0o600)
  await assert.rejects(writeArchive(output, bundle()))
})

test('verifier rejects changed payload bytes', async t => {
  const { output } = await archive(t)
  await writeFile(join(output, 'blobs/00000001.bin'), 'corrupt')
  await assert.rejects(verifyArchive(output), ArchiveError)
})

test('verifier rejects path traversal even when a payload descriptor has plausible hash', async t => {
  const { output } = await archive(t)
  await rewriteManifest(output, manifest => { manifest.files.at(-1).path = '../escape.bin' })
  await assert.rejects(verifyArchive(output), /Unsafe/u)
})

test('verifier rejects symlink and non-private files', async t => {
  const first = await archive(t)
  await rm(join(first.output, 'blobs/00000001.bin'))
  await symlink(join(first.output, 'tables/tasks.jsonl'), join(first.output, 'blobs/00000001.bin'))
  await assert.rejects(verifyArchive(first.output), /symlink/u)
  const second = await archive(t)
  await chmod(join(second.output, 'tables/tasks.jsonl'), 0o644)
  await assert.rejects(verifyArchive(second.output), /non-private/u)
})

test('verifier rejects undeclared payloads and incomplete archives', async t => {
  const first = await archive(t)
  await writeFile(join(first.output, 'undeclared.txt'), 'extra', { mode: 0o600 })
  await assert.rejects(verifyArchive(first.output), /undeclared/u)
  const second = await archive(t)
  await rm(join(second.output, 'tables/results.jsonl'))
  await assert.rejects(verifyArchive(second.output), /missing/u)
  const third = await archive(t)
  await rm(join(third.output, 'manifest.json'))
  await assert.rejects(verifyArchive(third.output))
})

test('verifier checks logical complete-set integrity beyond rehashed local payloads', async t => {
  const { output } = await archive(t)
  const path = join(output, 'tables/file_blobs.jsonl')
  await writeFile(path, '', { mode: 0o600 })
  await rewriteManifest(output, manifest => {
    const descriptor = manifest.files.find(file => file.table === 'file_blobs')
    manifest.payload_bytes -= descriptor.bytes
    descriptor.bytes = 0; descriptor.rows = 0; descriptor.sha256 = sha('')
  })
  await assert.rejects(verifyArchive(output), /incomplete|unregistered/u)
})

test('verifier rejects unsupported or falsified evidence declarations', async t => {
  const { output } = await archive(t)
  await rewriteManifest(output, manifest => { manifest.evidence.purpose = 'restoration-source' })
  await assert.rejects(verifyArchive(output), /manifest/u)
})

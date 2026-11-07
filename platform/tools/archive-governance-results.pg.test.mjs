// Optional isolated acceptance. The exporter stays SELECT-only; this test creates
// and cleans up one uniquely named schema on an explicitly supplied test database.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, readdir, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestDigest, readDatabase, verifyArchive, writeArchive } from './archive-governance-results.mjs'

const dsn = process.env.LUMO_TEST_PG_DSN
const sha = value => createHash('sha256').update(value).digest('hex')
const tables = ['governance_delegation_tasks', 'governance_task_runs', 'governance_task_results', 'governance_run_execution_snapshots', 'governance_run_output_manifests', 'governance_run_reviews', 'governance_run_file_blobs', 'governance_review_file_reads']
const realm = 'archive-live'
const cutoff = '2026-11-07T00:00:00.000Z'
const options = { mode: 'execute', realm, cutoff, limit: 100 }

test('PostgreSQL: isolated readonly audit snapshot exports and verifies exact evidence without source mutation', { skip: !dsn, timeout: 120_000 }, async t => {
  const require = createRequire(new URL('../dsh-plugins/session-log/package.json', import.meta.url))
  const { Client } = require('pg')
  const schema = 'archive_accept_' + randomBytes(12).toString('hex')
  // Only internally generated [a-z0-9_] identifiers become SQL identifiers.
  const url = new URL(dsn)
  url.searchParams.set('options', `-c search_path=${schema}`)
  const scopedDSN = url.toString()
  const env = { LUMO_GOVERNANCE_ARCHIVE_DSN: scopedDSN }
  const client = new Client({ connectionString: scopedDSN, connectionTimeoutMillis: 5_000 })
  const parent = await mkdtemp(join(await realpath(tmpdir()), 'lumo-audit-pg-'))
  let created = false
  t.after(async () => {
    try { if (created) await client.query(`DROP SCHEMA "${schema}" CASCADE`) }
    finally { await client.end().catch(() => {}); await rm(parent, { recursive: true, force: true }) }
  })
  await client.connect()
  await client.query(`CREATE SCHEMA "${schema}"`); created = true
  const source = async path => readFile(new URL(path, import.meta.url), 'utf8')
  const storeSource = await source('../control-plane/governance/internal/store/store.go')
  const start = storeSource.indexOf('CREATE TABLE IF NOT EXISTS governance_delegation_tasks (')
  const end = storeSource.indexOf('CREATE TABLE IF NOT EXISTS governance_skill_proficiency (', start)
  assert.ok(start > 0 && end > start)
  await client.query(storeSource.slice(start, end))
  const extract = async (path, name) => {
    const value = (await source(path)).match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`'))?.[1]
    assert.ok(value, 'current Go DDL must exist')
    return value
  }
  const resultsDDL = await extract('../control-plane/governance/internal/store/task_results.go', 'taskResultsDDL')
  await client.query(resultsDDL.split('CREATE TABLE IF NOT EXISTS governance_task_collaborators (')[0])
  await client.query(await extract('../control-plane/governance/internal/store/run_review.go', 'runReviewDDL'))
  await client.query(await extract('../control-plane/governance/internal/store/run_files.go', 'runFilesDDL'))

  const insertTask = (id, businessState, updatedAt = '2020-01-01T00:00:00Z', taskRealm = realm) => client.query(`INSERT INTO governance_delegation_tasks(id,realm,title,intent,requester_user_id,assignee_user_id,state,business_state,updated_at) VALUES($1,$2,'audit fixture','audit-only','requester','owner','COMPLETED',$3,$4)`, [id, taskRealm, businessState, updatedAt])
  await insertTask('task-producer', 'DONE', '2020-01-01T00:00:00Z')
  await insertTask('task-rejected', 'REJECTED', '2020-01-02T00:00:00Z')
  await insertTask('task-archived', 'ARCHIVED', '2020-01-03T00:00:00Z')
  await insertTask('task-review', 'EXECUTING')
  await insertTask('task-active', 'VERIFYING')
  await insertTask('task-legacy', null)
  await insertTask('task-new', 'DONE', '2030-01-01T00:00:00Z')
  await insertTask('task-other-realm', 'DONE', '2020-01-01T00:00:00Z', 'archive-other')
  const insertRun = (id, task, state = 'COMPLETED') => client.query(`INSERT INTO governance_task_runs(id,realm,task_id,attempt,worker_id,session_ref,assigned_node_id,state) VALUES($1,$2,$3,1,$4,$5,$6,$7)`, [id, realm, task, 'agent:' + id, 'session-' + id, 'node-' + id, state])
  await insertRun('run-producer', 'task-producer')
  await insertRun('run-review', 'task-review')
  await insertRun('run-rejected', 'task-rejected', 'FAILED')

  const fileBodies = [Buffer.from('\uFEFF# 审计 <file> & \u2028\u2029\n'), Buffer.from('{"complete":true,"name":"审计"}\n')]
  const fileNames = ['report.md', 'record.json']
  const media = ['text/markdown; charset=utf-8', 'application/json']
  const text = '完整交付 <&> \u2028\u2029'
  const producerManifest = { scope: 'platform-closed-text-files-v1', task_id: 'task-producer', run_id: 'run-producer', summary: '生产受控文件', entries: [{ id: 'output-0001', sha256: sha(text), text }], files: fileBodies.map((body, i) => ({ id: `file-${String(i + 1).padStart(4, '0')}`, name: fileNames[i], media_type: media[i], bytes: body.length, sha256: sha(body) })) }
  const producerDigest = manifestDigest(producerManifest)
  const verdict = JSON.stringify({ verdict: 'approve', manifest_digest: producerDigest })
  const reviewManifest = { scope: 'platform-closed-text-v1', task_id: 'task-review', run_id: 'run-review', summary: '审核通过', entries: [{ id: 'output-0001', sha256: sha(verdict), text: verdict }] }
  const receipts = [randomBytes(32).toString('hex'), randomBytes(32).toString('hex')]
  const producerResult = { task_id: 'task-producer', run_id: 'run-producer', state: 'COMPLETED', session_ref: 'session-run-producer', node_id: 'node-run-producer', summary: producerManifest.summary, output: [{ type: 'text', text }], files: fileBodies.map((body, i) => ({ name: fileNames[i], media_type: media[i], text: body.toString('utf8') })) }
  const reviewResult = { task_id: 'task-review', run_id: 'run-review', state: 'COMPLETED', session_ref: 'session-run-review', node_id: 'node-run-review', summary: reviewManifest.summary, output: [{ type: 'text', text: verdict }], review_file_receipts: receipts.map((receipt, i) => ({ id: producerManifest.files[i].id, receipt })) }
  for (const [manifest, payload] of [[producerManifest, producerResult], [reviewManifest, reviewResult]]) {
    const snapshot = { realm, task_id: manifest.task_id, run_id: manifest.run_id, output_profile: manifest.scope }
    await client.query('INSERT INTO governance_run_execution_snapshots(run_id,realm,task_id,snapshot) VALUES($1,$2,$3,$4)', [manifest.run_id, realm, manifest.task_id, snapshot])
    await client.query('INSERT INTO governance_run_output_manifests(run_id,realm,task_id,digest,manifest) VALUES($1,$2,$3,$4,$5)', [manifest.run_id, realm, manifest.task_id, manifestDigest(manifest), manifest])
    await client.query('INSERT INTO governance_task_results(run_id,realm,task_id,payload) VALUES($1,$2,$3,$4)', [manifest.run_id, realm, manifest.task_id, payload])
  }
  await client.query('INSERT INTO governance_task_results(run_id,realm,task_id,payload) VALUES($1,$2,$3,$4)', ['run-rejected', realm, 'task-rejected', { task_id: 'task-rejected', run_id: 'run-rejected', state: 'FAILED', summary: 'unsealed failure' }])
  await client.query('INSERT INTO governance_run_reviews(review_run_id,realm,producer_task_id,producer_run_id,manifest_digest,created_by) VALUES($1,$2,$3,$4,$5,$6)', ['run-review', realm, 'task-producer', 'run-producer', producerDigest, 'requester'])
  for (let i = 0; i < fileBodies.length; i++) {
    const file = producerManifest.files[i]
    await client.query('INSERT INTO governance_run_file_blobs(realm,run_id,entry_id,name,media_type,bytes,sha256,body) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [realm, producerManifest.run_id, file.id, file.name, file.media_type, file.bytes, file.sha256, fileBodies[i]])
    await client.query('INSERT INTO governance_review_file_reads(realm,review_run_id,producer_run_id,entry_id,manifest_digest,receipt,node_id,session_ref) VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [realm, 'run-review', producerManifest.run_id, file.id, producerDigest, receipts[i], 'node-run-review', 'session-run-review'])
  }
  const fingerprint = async () => {
    const parts = []
    for (const table of tables) parts.push((await client.query(`SELECT coalesce(string_agg(body,E'\\n' ORDER BY body),'') AS body FROM (SELECT to_jsonb(t)::text AS body FROM ${table} t) q`)).rows[0].body)
    return sha(parts.join('\n'))
  }
  const baseline = await fingerprint()
  const preview = await readDatabase({ ...options, mode: 'dry-run' }, env)
  assert.equal(preview.selected_tasks, 3)
  assert.equal(preview.tables.dependency_tasks.rows, 1)
  assert.equal(preview.tables.runs.rows, 3)
  assert.equal(preview.tables.file_blobs.rows, 2)
  assert.equal(preview.controlled_file_body_bytes, fileBodies.reduce((total, body) => total + body.length, 0))
  assert.equal(preview.storage_reclaimed_bytes, 0)
  assert.equal(preview.database_modified, false)
  assert.equal(JSON.stringify(preview).includes('完整交付'), false)

  const value = await readDatabase(options, env)
  assert.equal(value.counts.selected_tasks, 3)
  assert.equal(value.counts.dependency_tasks, 1)
  assert.equal(value.counts.results, 3)
  assert.equal(value.counts.sealed_manifests, 2)
  assert.equal(value.counts.unsealed_results, 1)
  assert.deepEqual(value.data.tasks.map(task => task.id), ['task-producer', 'task-rejected', 'task-archived'])
  assert.equal(value.data.review_file_reads.every(read => read.result_receipt_matches === true), true)
  const output = join(parent, 'valid')
  await writeArchive(output, value)
  assert.equal((await verifyArchive(output)).controlled_files, 2)
  const payloads = []
  async function collect(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) if (entry.isDirectory()) await collect(join(directory, entry.name)); else payloads.push(await readFile(join(directory, entry.name)))
  }
  await collect(output)
  for (const receipt of receipts) for (const body of payloads) assert.equal(body.includes(receipt), false, 'original replay receipt must never enter local archive')
  assert.equal(await fingerprint(), baseline, 'preview/export/verify must not mutate any source row')

  const emptyOptions = { ...options, realm: 'archive-empty' }
  const empty = await readDatabase(emptyOptions, env)
  assert.equal(empty.counts.selected_tasks, 0)
  await writeArchive(join(parent, 'empty'), empty)
  assert.equal((await verifyArchive(join(parent, 'empty'))).payload_bytes, 0)
  const limited = await readDatabase({ ...options, limit: 1 }, env)
  assert.deepEqual(limited.data.tasks.map(task => task.id), ['task-producer'])
  assert.equal(limited.counts.dependency_tasks, 1)
  const otherRealm = await readDatabase({ ...options, realm: 'archive-other' }, env)
  assert.deepEqual(otherRealm.data.tasks.map(task => task.id), ['task-other-realm'])
  assert.equal(otherRealm.counts.runs, 0)

  // Concurrent commit after the first scope query must remain outside every
  // subsequent preview/detail query in that same exported RR snapshot.
  const originalQuery = Client.prototype.query
  let injected = false
  Client.prototype.query = async function (...args) {
    const result = await originalQuery.apply(this, args)
    if (this !== client && !injected && typeof args[0] === 'string' && args[0].startsWith('WITH selected_tasks AS') && args[0].includes('count(*)::text')) {
      injected = true
      await insertTask('task-concurrent', 'DONE', '2020-01-04T00:00:00Z')
    }
    return result
  }
  try {
    const concurrent = await readDatabase(options, env)
    assert.equal(injected, true)
    assert.equal(concurrent.counts.selected_tasks, 3)
    assert.equal(concurrent.data.tasks.some(task => task.id === 'task-concurrent'), false)
  } finally { Client.prototype.query = originalQuery }
  assert.equal((await readDatabase({ ...options, mode: 'dry-run' }, env)).selected_tasks, 4)
  await client.query('DELETE FROM governance_delegation_tasks WHERE id=$1', ['task-concurrent'])
  assert.equal(await fingerprint(), baseline)

  // Change only current-instance fixtures. Every export must fail closed, then
  // restoration must leave the original database fingerprint unchanged.
  const first = producerManifest.files[0]
  await client.query('UPDATE governance_run_file_blobs SET sha256=$1 WHERE run_id=$2 AND entry_id=$3', ['0'.repeat(64), 'run-producer', first.id])
  await assert.rejects(readDatabase(options, env), /mismatch/u)
  await client.query('UPDATE governance_run_file_blobs SET sha256=$1 WHERE run_id=$2 AND entry_id=$3', [first.sha256, 'run-producer', first.id])
  await client.query('UPDATE governance_run_output_manifests SET digest=$1 WHERE run_id=$2', ['0'.repeat(64), 'run-producer'])
  await assert.rejects(readDatabase(options, env), /mismatch/u)
  await client.query('UPDATE governance_run_output_manifests SET digest=$1 WHERE run_id=$2', [producerDigest, 'run-producer'])
  await client.query('UPDATE governance_review_file_reads SET receipt=$1 WHERE review_run_id=$2 AND entry_id=$3', ['f'.repeat(64), 'run-review', first.id])
  await assert.rejects(readDatabase(options, env), /matching read evidence/u)
  await client.query('UPDATE governance_review_file_reads SET receipt=$1 WHERE review_run_id=$2 AND entry_id=$3', [receipts[0], 'run-review', first.id])
  assert.equal(await fingerprint(), baseline)
  t.diagnostic('Verified isolated PostgreSQL current-DDL export: 3 terminal tasks + 1 review dependency, 3 results (2 sealed / 1 unsealed), 2 complete file bodies, 2 receipt-match booleans; empty/limit/realm/cutoff and concurrent RR snapshot passed; corrupted SHA/manifest/receipt rejected; source fingerprint unchanged.')
})

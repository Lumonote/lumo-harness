#!/usr/bin/env node
// Audit export only. No deletion, restoration, storage reclamation or receipt replay.
import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, readdir, rename } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

const FORMAT = 'lumo-governance-audit-v1'
const MAX_BYTES = 512 * 1024 * 1024
const MAX_ROWS = 1_000_000
const TERMINAL = new Set(['DONE', 'REJECTED', 'ARCHIVED'])
const HASH = /^[a-f0-9]{64}$/u
const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const SECRET_KEYS = new Set(['receipt', 'review_file_receipts', 'reviewFileReceipts'])
const TABLES = ['tasks', 'dependency_tasks', 'runs', 'results', 'snapshots', 'output_manifests', 'reviews', 'review_file_reads', 'file_blobs']
const EVIDENCE = Object.freeze({
  purpose: 'audit-only-not-a-restoration-source',
  selection: 'terminal-tasks-and-direct-review-run-dependencies',
  consistency: 'postgresql-repeatable-read-read-only-snapshot',
  file_integrity: 'complete-manifest-set-metadata-utf8-bytes-and-sha256',
  manifest_integrity: 'go-encoding-json-typed-manifest-sha256',
  replay_secrets: 'excluded-structured-receipts; database-computed-match-booleans-only',
  content_privacy: 'business-content-preserved-not-a-general-secret-scanner',
  authenticity: 'local-consistency-only-not-signed-or-independent-attestation',
  exclusions: ['uploaded-task-artifacts', 'external-side-effects', 'external-object-bodies', 'full-review-dependency-task-history', 'receipt-replay', 'database-restoration', 'storage-reclamation'],
})

export class ArchiveError extends Error {}
const fail = message => { throw new ArchiveError(message) }
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const textID = value => typeof value === 'string' && value.length > 0 && value.length <= 512
const integer = value => Number.isSafeInteger(value) && value >= 0
const keyOf = (run, entry) => JSON.stringify([run, entry])
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const safeKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key))
const HELP = `Usage:
  node platform/tools/archive-governance-results.mjs --realm REALM --cutoff UTC [--limit 100] [--dry-run]
  node platform/tools/archive-governance-results.mjs --realm REALM --cutoff UTC [--limit 100] --execute --output /absolute/new-directory
  node platform/tools/archive-governance-results.mjs --verify /absolute/archive-directory
PostgreSQL DSN: LUMO_GOVERNANCE_ARCHIVE_DSN (environment only).
Default is read-only counts/bytes preview. UTC must use YYYY-MM-DDTHH:mm:ss[.sss]Z.
Selection: business_state DONE/REJECTED/ARCHIVED, updated_at <= cutoff, oldest first.
Limit is 1..100 tasks. Exports include direct review run dependencies in the same realm.
This private audit export does not delete data, reclaim storage or support restoration.
No body, task ID, DSN or raw database error is printed.`

function utc(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) fail('Invalid UTC timestamp; use --help.')
  const date = new Date(value)
  if (!Number.isFinite(date.valueOf()) || date.toISOString().replace(/\.000Z$/u, 'Z') !== value.replace(/(?:\.(\d{1,3}))?Z$/u, (_, fraction) => fraction && Number(fraction) !== 0 ? `.${fraction.padEnd(3, '0')}Z` : 'Z')) fail('Invalid UTC timestamp; use --help.')
  return date.toISOString()
}

export function parseArgs(args) {
  if (args.length === 1 && args[0] === '--help') return { mode: 'help' }
  const values = new Map()
  const flags = new Set(['--execute', '--dry-run'])
  const allowed = new Set(['--realm', '--cutoff', '--limit', '--output', '--verify', ...flags])
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]
    if (!allowed.has(flag) || values.has(flag)) fail('Invalid or repeated arguments; use --help.')
    if (flags.has(flag)) values.set(flag, true)
    else {
      const value = args[++i]
      if (!value || value.startsWith('--')) fail('Missing argument value; use --help.')
      values.set(flag, value)
    }
  }
  if (values.has('--verify')) {
    if (values.size !== 1 || !isAbsolute(values.get('--verify'))) fail('--verify requires only an absolute archive directory.')
    return { mode: 'verify', output: values.get('--verify') }
  }
  const realm = values.get('--realm')
  if (typeof realm !== 'string' || realm.length < 1 || realm.length > 128 || /[\s\x00-\x1f\x7f]/u.test(realm)) fail('--realm requires a nonempty realm identifier.')
  const cutoff = utc(values.get('--cutoff'))
  const limitText = values.get('--limit') ?? '100'
  if (!/^[1-9]\d{0,2}$/u.test(limitText) || Number(limitText) > 100) fail('--limit must be 1..100.')
  if (values.has('--execute') && values.has('--dry-run')) fail('Select --execute or --dry-run.')
  const output = values.get('--output')
  if (values.has('--execute') ? !output || !isAbsolute(output) : output !== undefined) fail('--execute requires an absolute new --output directory; preview does not accept --output.')
  return { mode: values.has('--execute') ? 'execute' : 'dry-run', realm, cutoff, limit: Number(limitText), ...(output ? { output } : {}) }
}

export function stripReplaySecrets(value) {
  if (Array.isArray(value)) return value.map(stripReplaySecrets)
  if (!object(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => !SECRET_KEYS.has(key)).map(([key, item]) => [key, stripReplaySecrets(item)]))
}

function noReplaySecrets(value) {
  if (Array.isArray(value)) return value.every(noReplaySecrets)
  return !object(value) || Object.entries(value).every(([key, item]) => !SECRET_KEYS.has(key) && noReplaySecrets(item))
}

// PostgreSQL JSONB changes key order. Rebuild exactly the supported Go structs
// before encoding, including encoding/json's default HTML and separator escaping.
export function manifestDigest(manifest) {
  if (!safeKeys(manifest, ['scope', 'task_id', 'run_id', 'summary', 'entries', 'files']) || !['platform-closed-text-v1', 'platform-closed-text-files-v1'].includes(manifest.scope) || !textID(manifest.task_id) || !textID(manifest.run_id) || typeof manifest.summary !== 'string' || !Array.isArray(manifest.entries) || manifest.entries.length < 1 || manifest.entries.length > 256) fail('Unsupported or invalid output manifest.')
  const entries = manifest.entries.map((entry, i) => {
    if (!safeKeys(entry, ['id', 'sha256', 'text']) || entry.id !== `output-${String(i + 1).padStart(4, '0')}` || typeof entry.text !== 'string' || entry.text.trim() === '' || !HASH.test(entry.sha256) || sha(Buffer.from(entry.text)) !== entry.sha256 || !validUnicode(entry.text)) fail('Output text manifest integrity mismatch.')
    return { id: entry.id, sha256: entry.sha256, text: entry.text }
  })
  const files = manifest.files ?? []
  if (!Array.isArray(files) || files.length > 16 || (manifest.scope === 'platform-closed-text-files-v1') !== (files.length > 0)) fail('Output file manifest scope mismatch.')
  let total = 0
  const names = new Set()
  const typedFiles = files.map((file, i) => {
    if (!safeKeys(file, ['id', 'name', 'media_type', 'bytes', 'sha256']) || file.id !== `file-${String(i + 1).padStart(4, '0')}` || !validFileMetadata(file) || names.has(file.name.toLowerCase())) fail('Invalid output file manifest metadata.')
    names.add(file.name.toLowerCase()); total += file.bytes
    return { id: file.id, name: file.name, media_type: file.media_type, bytes: file.bytes, sha256: file.sha256 }
  })
  if (total > 256 * 1024) fail('Controlled file manifest exceeds its supported size.')
  const typed = { scope: manifest.scope, task_id: manifest.task_id, run_id: manifest.run_id, summary: manifest.summary, entries, ...(typedFiles.length ? { files: typedFiles } : {}) }
  if (!validUnicode(manifest.summary)) fail('Invalid output manifest Unicode.')
  const raw = JSON.stringify(typed).replace(/[<>&\u2028\u2029]/gu, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return sha(Buffer.from(raw))
}

function validUnicode(text) {
  // Go JSON decoding normalizes unpaired surrogates; reject ambiguous JS strings.
  return typeof text === 'string' && Buffer.from(text).toString('utf8') === text
}

function validFileMetadata(file) {
  if (typeof file.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,115}\.(txt|md|csv|json)$/u.test(file.name) || file.name.includes('..') || !Number.isInteger(file.bytes) || file.bytes < 1 || file.bytes > 32768 || !HASH.test(file.sha256)) return false
  const media = { txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json' }
  return media[file.name.slice(file.name.lastIndexOf('.') + 1)] === file.media_type
}

function unique(rows, field) {
  const out = new Map()
  for (const row of rows) {
    if (!textID(row[field]) || out.has(row[field])) fail('Duplicate or invalid audit record identity.')
    out.set(row[field], row)
  }
  return out
}

export function validateDataset(data, scope, bodies) {
  if (!object(data) || !same(Object.keys(data).sort(), [...TABLES].sort()) || !object(scope) || typeof scope.realm !== 'string' || !Number.isInteger(scope.limit) || scope.limit < 1 || scope.limit > 100) fail('Invalid audit dataset scope.')
  const cutoff = utc(scope.cutoff)
  for (const table of TABLES) {
    if (!Array.isArray(data[table]) || data[table].length > MAX_ROWS || data[table].some(row => !object(row) || row.realm !== scope.realm || !noReplaySecrets(row))) fail('Audit record realm or replay-secret violation.')
  }
  const tasks = unique(data.tasks, 'id')
  if (tasks.size > scope.limit || [...tasks.values()].some(task => !TERMINAL.has(task.business_state) || !Number.isFinite(Date.parse(task.updated_at)) || Date.parse(task.updated_at) > Date.parse(cutoff))) fail('Audit contains an ineligible task.')
  const dependencies = unique(data.dependency_tasks, 'id')
  if ([...dependencies.keys()].some(id => tasks.has(id))) fail('Duplicate task scope.')
  const runs = unique(data.runs, 'id')
  const selectedRuns = new Set()
  const expectedDependencies = new Set()
  for (const run of runs.values()) {
    if (!tasks.has(run.task_id) && !dependencies.has(run.task_id)) fail('Run task is outside the audit scope.')
    if (tasks.has(run.task_id)) selectedRuns.add(run.id)
    else expectedDependencies.add(run.task_id)
  }
  if (!same([...dependencies.keys()].sort(), [...expectedDependencies].sort())) fail('Unrelated dependency task metadata.')
  const reviews = unique(data.reviews, 'review_run_id')
  const expectedRuns = new Set(selectedRuns)
  for (const review of reviews.values()) {
    if (!runs.has(review.review_run_id) || !runs.has(review.producer_run_id) || review.review_run_id === review.producer_run_id || runs.get(review.producer_run_id).task_id !== review.producer_task_id || !HASH.test(review.manifest_digest) || (!selectedRuns.has(review.review_run_id) && !selectedRuns.has(review.producer_run_id))) fail('Review binding is outside the direct audit scope.')
    expectedRuns.add(review.review_run_id); expectedRuns.add(review.producer_run_id)
  }
  if (!same([...runs.keys()].sort(), [...expectedRuns].sort())) fail('Unrelated audit dependency run.')
  const byRun = table => {
    const rows = unique(data[table], 'run_id')
    for (const row of rows.values()) if (!runs.has(row.run_id) || row.task_id !== runs.get(row.run_id).task_id) fail('Run evidence is outside the audit scope.')
    return rows
  }
  const results = byRun('results'), snapshots = byRun('snapshots'), manifests = byRun('output_manifests')
  for (const row of results.values()) if (!object(row.payload) || row.payload.run_id !== row.run_id || row.payload.task_id !== row.task_id) fail('Result execution identity mismatch.')
  for (const row of snapshots.values()) if (!object(row.snapshot) || row.snapshot.realm !== scope.realm || row.snapshot.run_id !== row.run_id || row.snapshot.task_id !== row.task_id) fail('Snapshot execution identity mismatch.')
  const expectedBlobs = new Map()
  for (const row of manifests.values()) {
    if (row.manifest?.run_id !== row.run_id || row.manifest?.task_id !== row.task_id || manifestDigest(row.manifest) !== row.digest || !results.has(row.run_id) || !snapshots.has(row.run_id) || snapshots.get(row.run_id).snapshot.output_profile !== row.manifest.scope || results.get(row.run_id).payload.state !== 'COMPLETED') fail('Stored output manifest digest or evidence mismatch.')
    const payload = results.get(row.run_id).payload
    if (payload.summary !== row.manifest.summary || !Array.isArray(payload.output) || payload.output.length !== row.manifest.entries.length || payload.output.some((block, i) => !safeKeys(block, ['type', 'text']) || block.type !== 'text' || block.text !== row.manifest.entries[i].text)) fail('Result text does not match its output manifest.')
    const files = row.manifest.files ?? []
    if (!Array.isArray(payload.files ?? []) || (payload.files ?? []).length !== files.length) fail('Result file set does not match its output manifest.')
    files.forEach((file, i) => expectedBlobs.set(keyOf(row.run_id, file.id), { ...file, run_id: row.run_id, result: payload.files[i] }))
  }
  const actualBlobs = new Set(), paths = new Set()
  for (const blob of data.file_blobs) {
    const key = keyOf(blob.run_id, blob.entry_id), expected = expectedBlobs.get(key)
    const body = bodies.get(blob.body_path)
    if (!expected || actualBlobs.has(key) || paths.has(blob.body_path) || !/^blobs\/\d{8}\.bin$/u.test(blob.body_path) || !Buffer.isBuffer(body) || !validFileMetadata(blob) || blob.name !== expected.name || blob.media_type !== expected.media_type || blob.bytes !== expected.bytes || blob.sha256 !== expected.sha256 || body.length !== expected.bytes || sha(body) !== expected.sha256) fail('Controlled file body, metadata or complete-set mismatch.')
    let text
    try { text = UTF8.decode(body) } catch { fail('Controlled file body is not valid UTF-8.') }
    if (text.includes('\0') || !safeKeys(expected.result, ['name', 'media_type', 'text']) || expected.result.name !== blob.name || expected.result.media_type !== blob.media_type || expected.result.text !== text) fail('Result file does not match its controlled body.')
    if (blob.media_type === 'application/json') { try { JSON.parse(text) } catch { fail('Controlled JSON body is invalid.') } }
    actualBlobs.add(key); paths.add(blob.body_path)
  }
  if (actualBlobs.size !== expectedBlobs.size || bodies.size !== paths.size) fail('Controlled file set is incomplete or contains unregistered bodies.')
  const reads = new Map()
  for (const read of data.review_file_reads) {
    const key = keyOf(read.review_run_id, read.entry_id), binding = reviews.get(read.review_run_id)
    if (reads.has(key) || !binding || read.producer_run_id !== binding.producer_run_id || read.manifest_digest !== binding.manifest_digest || !expectedBlobs.has(keyOf(read.producer_run_id, read.entry_id)) || typeof read.result_receipt_matches !== 'boolean') fail('Review file-read evidence binding mismatch.')
    reads.set(key, read)
  }
  for (const review of reviews.values()) {
    const manifest = manifests.get(review.producer_run_id)
    if (!manifest || manifest.digest !== review.manifest_digest) fail('Review producer manifest evidence is missing.')
    if (results.get(review.review_run_id)?.payload.state === 'COMPLETED') for (const file of manifest.manifest.files ?? []) {
      const read = reads.get(keyOf(review.review_run_id, file.id))
      if (!read?.result_receipt_matches) fail('Completed file reviewer lacks matching read evidence.')
    }
  }
  return { selected_tasks: tasks.size, dependency_tasks: dependencies.size, runs: runs.size, results: results.size, sealed_manifests: manifests.size, unsealed_results: [...results.keys()].filter(id => !manifests.has(id)).length, controlled_files: actualBlobs.size, controlled_file_body_bytes: [...bodies.values()].reduce((sum, body) => sum + body.length, 0), review_reads: reads.size }
}

// All query inputs remain parameters. No temporary tables, DDL, deletes or locks.
const SCOPE_SQL = `WITH selected_tasks AS (
 SELECT * FROM governance_delegation_tasks WHERE realm=$1 AND business_state IN ('DONE','REJECTED','ARCHIVED') AND updated_at <= $2::timestamptz ORDER BY updated_at,id LIMIT $3
), selected_runs AS (
 SELECT r.* FROM governance_task_runs r JOIN selected_tasks t ON t.id=r.task_id AND t.realm=r.realm
), selected_reviews AS (
 SELECT v.* FROM governance_run_reviews v WHERE v.realm=$1 AND (v.producer_run_id IN (SELECT id FROM selected_runs) OR v.review_run_id IN (SELECT id FROM selected_runs))
), scoped_runs AS (
 SELECT r.* FROM governance_task_runs r WHERE r.realm=$1 AND (r.id IN (SELECT id FROM selected_runs) OR r.id IN (SELECT producer_run_id FROM selected_reviews) OR r.id IN (SELECT review_run_id FROM selected_reviews))
) `

const QUERIES = {
  tasks: `SELECT to_jsonb(t) AS record FROM selected_tasks t ORDER BY t.updated_at,t.id`,
  dependency_tasks: `SELECT jsonb_build_object('id',t.id,'realm',t.realm,'project_id',t.project_id,'business_state',t.business_state) AS record FROM governance_delegation_tasks t WHERE t.realm=$1 AND t.id IN (SELECT task_id FROM scoped_runs) AND t.id NOT IN (SELECT id FROM selected_tasks) ORDER BY t.id`,
  runs: `SELECT to_jsonb(r) AS record FROM scoped_runs r ORDER BY r.task_id,r.attempt,r.id`,
  results: `SELECT to_jsonb(e)-'payload' || jsonb_build_object('payload',e.payload-'review_file_receipts') AS record FROM governance_task_results e JOIN scoped_runs r ON r.id=e.run_id AND r.realm=e.realm WHERE e.realm=$1 ORDER BY e.run_id`,
  snapshots: `SELECT to_jsonb(s) AS record FROM governance_run_execution_snapshots s JOIN scoped_runs r ON r.id=s.run_id AND r.realm=s.realm WHERE s.realm=$1 ORDER BY s.run_id`,
  output_manifests: `SELECT to_jsonb(m) AS record FROM governance_run_output_manifests m JOIN scoped_runs r ON r.id=m.run_id AND r.realm=m.realm WHERE m.realm=$1 ORDER BY m.run_id`,
  reviews: `SELECT to_jsonb(v) AS record FROM selected_reviews v ORDER BY v.review_run_id`,
  review_file_reads: `SELECT to_jsonb(f)-'receipt' || jsonb_build_object('result_receipt_matches',EXISTS (
    SELECT 1 FROM governance_task_results e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.payload->'review_file_receipts')='array' THEN e.payload->'review_file_receipts' ELSE '[]'::jsonb END) token
    WHERE e.realm=f.realm AND e.run_id=f.review_run_id AND token->>'id'=f.entry_id AND token->>'receipt'=f.receipt AND e.payload->>'node_id'=f.node_id AND e.payload->>'session_ref'=f.session_ref
  )) AS record FROM governance_review_file_reads f JOIN selected_reviews v ON v.review_run_id=f.review_run_id AND v.realm=f.realm WHERE f.realm=$1 ORDER BY f.review_run_id,f.entry_id`,
  file_blobs: `SELECT to_jsonb(b)-'body' AS record FROM governance_run_file_blobs b JOIN scoped_runs r ON r.id=b.run_id AND r.realm=b.realm WHERE b.realm=$1 ORDER BY b.run_id,b.entry_id`,
}

async function dbPreview(client, parameters) {
  const tables = {}
  let jsonBytes = 0, rows = 0
  for (const table of TABLES) {
    const result = await client.query(SCOPE_SQL + `SELECT count(*)::text AS rows,coalesce(sum(octet_length(record::text)),0)::text AS bytes FROM (${QUERIES[table]}) q`, parameters)
    const count = Number(result.rows[0].rows), bytes = Number(result.rows[0].bytes)
    if (!integer(count) || !integer(bytes)) fail('Archive estimate exceeds supported numeric limits.')
    tables[table] = { rows: count, database_json_text_bytes: bytes }; jsonBytes += bytes; rows += count
  }
  const blobs = await client.query(SCOPE_SQL + `SELECT coalesce(sum(octet_length(b.body)),0)::text AS bytes FROM governance_run_file_blobs b JOIN scoped_runs r ON r.id=b.run_id AND r.realm=b.realm WHERE b.realm=$1`, parameters)
  const bodyBytes = Number(blobs.rows[0].bytes)
  if (!integer(bodyBytes)) fail('Archive body estimate exceeds supported numeric limits.')
  return { tables, database_json_text_bytes: jsonBytes, controlled_file_body_bytes: bodyBytes, total_rows: rows, within_export_budget: rows <= MAX_ROWS && jsonBytes + bodyBytes <= MAX_BYTES }
}

export async function readDatabase(options, env = process.env) {
  const dsn = env.LUMO_GOVERNANCE_ARCHIVE_DSN
  if (!dsn) fail('LUMO_GOVERNANCE_ARCHIVE_DSN is required; do not pass a DSN on the command line.')
  const require = createRequire(new URL('../dsh-plugins/session-log/package.json', import.meta.url))
  const { Client } = require('pg')
  const client = new Client({ connectionString: dsn, application_name: 'lumo-governance-audit', connectionTimeoutMillis: 10_000, query_timeout: 35_000 })
  client.on('error', () => {}) // Pending queries fail safely; never emit raw idle driver errors.
  let transaction = false
  try {
    await client.connect()
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); transaction = true
    await client.query("SET LOCAL statement_timeout='30s'")
    await client.query("SET LOCAL lock_timeout='2s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='60s'")
    const snapshot = (await client.query("SELECT txid_current_snapshot()::text AS id,transaction_timestamp()::text AS started_at,current_setting('transaction_read_only') AS read_only,current_setting('transaction_isolation') AS isolation")).rows[0]
    if (snapshot.read_only !== 'on' || snapshot.isolation !== 'repeatable read') fail('Read-only snapshot isolation was not established.')
    const parameters = [options.realm, options.cutoff, options.limit]
    const preview = await dbPreview(client, parameters)
    if (options.mode === 'dry-run') {
      await client.query('COMMIT'); transaction = false
      return { mode: 'dry-run', selected_tasks: preview.tables.tasks.rows, ...preview, database_modified: false, storage_reclaimed_bytes: 0 }
    }
    if (!preview.within_export_budget) fail('Archive exceeds the 512 MiB or 1000000 row export budget; use a smaller task limit.')
    const data = {}
    for (const table of TABLES) data[table] = (await client.query(SCOPE_SQL + QUERIES[table], parameters)).rows.map(row => stripReplaySecrets(row.record))
    const bodies = new Map()
    const blobRows = (await client.query(SCOPE_SQL + `SELECT b.run_id,b.entry_id,b.body FROM governance_run_file_blobs b JOIN scoped_runs r ON r.id=b.run_id AND r.realm=b.realm WHERE b.realm=$1 ORDER BY b.run_id,b.entry_id`, parameters)).rows
    const blobMap = new Map(blobRows.map(row => [keyOf(row.run_id, row.entry_id), row.body]))
    data.file_blobs.forEach((blob, i) => {
      blob.body_path = `blobs/${String(i + 1).padStart(8, '0')}.bin`
      bodies.set(blob.body_path, blobMap.get(keyOf(blob.run_id, blob.entry_id)))
    })
    if (blobRows.length !== data.file_blobs.length) fail('File export snapshot count mismatch.')
    const scope = { realm: options.realm, cutoff: options.cutoff, limit: options.limit }
    const counts = validateDataset(data, scope, bodies)
    for (const table of TABLES) if (data[table].length !== preview.tables[table].rows) fail('Export snapshot row count mismatch.')
    await client.query('COMMIT'); transaction = false
    return { data, bodies, scope, snapshot: { id: snapshot.id, started_at: snapshot.started_at }, counts }
  } finally {
    if (transaction) { try { await client.query('ROLLBACK') } catch { /* Preserve safe caller error. */ } }
    await client.end().catch(() => {})
  }
}

async function checkedDirectory(path, mustBePrivate = false) {
  if (!isAbsolute(path) || resolve(path) !== path || path === parse(path).root) fail('Archive requires a normalized absolute directory path.')
  let current = parse(path).root
  for (const part of path.slice(current.length).split('/')) {
    current = join(current, part)
    const stat = await lstat(current)
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail('Archive directory path contains a symlink or a non-directory.')
    if (current === path && mustBePrivate && (stat.mode & 0o077) !== 0) fail('Archive directory must be private (0700).')
  }
}

async function privateFile(path, bytes) {
  const file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
  try { await file.writeFile(bytes); await file.sync() } finally { await file.close() }
}

async function readPrivateFile(path, maximum = MAX_BYTES) {
  const before = await lstat(path)
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || (before.mode & 0o077) !== 0 || before.size > maximum) fail('Archive file is linked, non-private, invalid or too large.')
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = await file.stat()
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size !== before.size) fail('Archive file changed during verification.')
    const body = await file.readFile()
    if (body.length !== stat.size || body.length > maximum) fail('Archive file changed or exceeded its size budget.')
    return body
  } finally { await file.close() }
}

function json(body) { try { return JSON.parse(UTF8.decode(body)) } catch { fail('Invalid UTF-8 JSON archive payload.') } }

export async function writeArchive(output, bundle) {
  // Validate before creating any output directory. There is deliberately no overwrite.
  const counts = validateDataset(bundle.data, bundle.scope, bundle.bodies)
  if (same(counts, bundle.counts) === false) fail('Archive bundle count mismatch.')
  if (!isAbsolute(output) || resolve(output) !== output) fail('Output requires a normalized absolute path.')
  await checkedDirectory(dirname(output))
  await mkdir(output, { mode: 0o700 })
  await checkedDirectory(output, true)
  await mkdir(join(output, 'tables'), { mode: 0o700 })
  await mkdir(join(output, 'blobs'), { mode: 0o700 })
  const files = []
  let total = 0
  for (const table of TABLES) {
    const body = Buffer.from(bundle.data[table].map(row => JSON.stringify(row) + '\n').join(''))
    total += body.length
    if (total > MAX_BYTES) fail('Archive payload exceeds the export size budget.')
    const path = `tables/${table}.jsonl`
    await privateFile(join(output, path), body)
    files.push({ path, kind: 'jsonl', table, rows: bundle.data[table].length, bytes: body.length, sha256: sha(body) })
  }
  for (const blob of bundle.data.file_blobs) {
    const body = bundle.bodies.get(blob.body_path)
    total += body.length
    if (total > MAX_BYTES) fail('Archive payload exceeds the export size budget.')
    await privateFile(join(output, blob.body_path), body)
    files.push({ path: blob.body_path, kind: 'blob', run_id: blob.run_id, entry_id: blob.entry_id, bytes: body.length, sha256: sha(body) })
  }
  const manifest = { format: FORMAT, archive_id: randomUUID(), created_at: new Date().toISOString(), scope: bundle.scope, snapshot: bundle.snapshot, evidence: EVIDENCE, counts, payload_bytes: total, files }
  await privateFile(join(output, 'manifest.partial.json'), Buffer.from(JSON.stringify(manifest, null, 2) + '\n'))
  await verifyArchive(output, { pending: true })
  await rename(join(output, 'manifest.partial.json'), join(output, 'manifest.json'))
  return { mode: 'exported', ...counts, payload_bytes: total, database_modified: false, storage_reclaimed_bytes: 0 }
}

export async function verifyArchive(output, { pending = false } = {}) {
  await checkedDirectory(output, true)
  const manifestName = pending ? 'manifest.partial.json' : 'manifest.json'
  const manifest = json(await readPrivateFile(join(output, manifestName), 4 * 1024 * 1024))
  if (!safeKeys(manifest, ['format', 'archive_id', 'created_at', 'scope', 'snapshot', 'evidence', 'counts', 'payload_bytes', 'files']) || manifest.format !== FORMAT || !/^[a-f0-9-]{36}$/u.test(manifest.archive_id) || !Number.isFinite(Date.parse(manifest.created_at)) || !same(manifest.evidence, EVIDENCE) || !safeKeys(manifest.scope, ['realm', 'cutoff', 'limit']) || !object(manifest.snapshot) || !textID(manifest.snapshot.id) || !Number.isFinite(Date.parse(manifest.snapshot.started_at)) || !integer(manifest.payload_bytes) || manifest.payload_bytes > MAX_BYTES || !Array.isArray(manifest.files) || manifest.files.length > MAX_ROWS) fail('Invalid or unsupported audit manifest.')
  const data = {}, bodies = new Map(), expectedPaths = new Set([manifestName]), tables = new Set(), blobDescriptors = new Map()
  let total = 0, rows = 0
  for (const descriptor of manifest.files) {
    if (!object(descriptor) || typeof descriptor.path !== 'string' || expectedPaths.has(descriptor.path) || !integer(descriptor.bytes) || !HASH.test(descriptor.sha256) || !['jsonl', 'blob'].includes(descriptor.kind)) fail('Invalid or duplicate archive payload descriptor.')
    if (descriptor.kind === 'jsonl') {
      if (!safeKeys(descriptor, ['path', 'kind', 'table', 'rows', 'bytes', 'sha256']) || !TABLES.includes(descriptor.table) || tables.has(descriptor.table) || descriptor.path !== `tables/${descriptor.table}.jsonl` || !integer(descriptor.rows)) fail('Unsafe or invalid JSONL archive descriptor.')
      tables.add(descriptor.table); rows += descriptor.rows
    } else if (!safeKeys(descriptor, ['path', 'kind', 'run_id', 'entry_id', 'bytes', 'sha256']) || !/^blobs\/\d{8}\.bin$/u.test(descriptor.path) || !textID(descriptor.run_id) || !textID(descriptor.entry_id) || descriptor.bytes < 1 || descriptor.bytes > 32768) fail('Unsafe or invalid file body descriptor.')
    total += descriptor.bytes
    if (total > MAX_BYTES || rows > MAX_ROWS) fail('Archive exceeds its verification budget.')
    expectedPaths.add(descriptor.path)
  }
  if (tables.size !== TABLES.length || total !== manifest.payload_bytes) fail('Archive table set or payload byte count mismatch.')
  const actualPaths = new Set()
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = prefix + entry.name, absolute = join(directory, entry.name)
      const stat = await lstat(absolute)
      if (stat.isSymbolicLink()) fail('Archive contains a symlink.')
      if (stat.isDirectory()) {
        if (prefix !== '' || !['tables', 'blobs'].includes(entry.name) || (stat.mode & 0o077) !== 0) fail('Archive contains an unexpected or non-private directory.')
        await inspect(absolute, path + '/')
      } else {
        if (!expectedPaths.has(path)) fail('Archive contains an undeclared payload.')
        actualPaths.add(path)
      }
    }
  }
  await inspect(output)
  if (!same([...actualPaths].sort(), [...expectedPaths].sort())) fail('Archive is missing a declared payload.')
  for (const descriptor of manifest.files) {
    const body = await readPrivateFile(join(output, descriptor.path), descriptor.bytes)
    if (body.length !== descriptor.bytes || sha(body) !== descriptor.sha256) fail('Archive payload SHA-256 or byte count mismatch.')
    if (descriptor.kind === 'blob') { bodies.set(descriptor.path, body); blobDescriptors.set(descriptor.path, descriptor) }
    else {
      let text
      try { text = UTF8.decode(body) } catch { fail('Invalid UTF-8 JSONL archive payload.') }
      if (text && !text.endsWith('\n')) fail('Truncated JSONL archive payload.')
      const records = text === '' ? [] : text.slice(0, -1).split('\n').map(line => json(Buffer.from(line)))
      if (records.length !== descriptor.rows) fail('JSONL record count mismatch.')
      data[descriptor.table] = records
    }
  }
  for (const blob of data.file_blobs) {
    const descriptor = blobDescriptors.get(blob.body_path)
    if (!descriptor || descriptor.run_id !== blob.run_id || descriptor.entry_id !== blob.entry_id || descriptor.bytes !== blob.bytes || descriptor.sha256 !== blob.sha256) fail('File metadata does not match its archive descriptor.')
  }
  const counts = validateDataset(data, manifest.scope, bodies)
  if (!same(counts, manifest.counts)) fail('Archive evidence count mismatch.')
  return { mode: 'verified', ...counts, payload_bytes: total, authenticity: 'local-consistency-only', restore_supported: false }
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args)
  if (options.mode === 'help') { console.log(HELP); return }
  const result = options.mode === 'verify' ? await verifyArchive(options.output)
    : options.mode === 'dry-run' ? await readDatabase(options)
      : await writeArchive(options.output, await readDatabase(options))
  console.log(JSON.stringify(result, null, 2))
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => {
  // Only our fixed messages are safe to print; PG/filesystem errors can contain credentials or bodies.
  console.error(error instanceof ArchiveError ? error.message : 'Governance audit archive failed; check configuration, database availability and the private output directory.')
  process.exitCode = 1
})

/** Positive evidence only: absence from this report never authorizes deletion. */
export function validateRealm(realm) {
  if (typeof realm !== 'string' || realm === '' || realm === '.' || realm === '..' || /[\\/\u0000-\u001f\u007f]/u.test(realm)) throw new Error('invalid realm')
  return realm
}

export function contentObjectKey(value, realm, allowRelative = false) {
  if (typeof value !== 'string') return undefined
  const relative = /^content\/[0-9a-f]{64}$/u
  if (allowRelative && relative.test(value)) return `${realm}/${value}`
  if (!value.startsWith(`${realm}/`)) return undefined
  return relative.test(value.slice(realm.length + 1)) ? value : undefined
}

/** Session logs have no realm column. Only self-contained, exact full keys count. */
export function sessionContentReferences(payload, realm, maxNodes = 100_000) {
  let root
  try { root = typeof payload === 'string' ? JSON.parse(payload) : payload }
  catch { return { keys: [], malformed: true, truncated: false } }
  const keys = new Set()
  const pending = [root]
  let visited = 0
  while (pending.length && visited < maxNodes) {
    const value = pending.pop()
    visited++
    if (typeof value === 'string') {
      const key = contentObjectKey(value, realm)
      if (key !== undefined) keys.add(key)
    } else if (Array.isArray(value)) {
      // Bound the work queue as well as the number of visited values.
      if (value.length > maxNodes - pending.length - visited) return { keys: [...keys], malformed: false, truncated: true }
      pending.push(...value)
    } else if (value !== null && typeof value === 'object') {
      const values = Object.values(value)
      if (values.length > maxNodes - pending.length - visited) return { keys: [...keys], malformed: false, truncated: true }
      pending.push(...values)
    }
  }
  return { keys: [...keys], malformed: false, truncated: pending.length > 0 }
}

const SOURCE_QUERIES = {
  knowledge: {
    first: `SELECT doc_id, object_key FROM knowledge_library_files WHERE realm=$1 ORDER BY doc_id LIMIT $2`,
    next: `SELECT doc_id, object_key FROM knowledge_library_files WHERE realm=$1 AND doc_id>$2 ORDER BY doc_id LIMIT $3`,
    cursor: row => [row.doc_id],
    reference: (row, realm) => ({ keys: [contentObjectKey(row.object_key, realm, true)].filter(Boolean), id: row.doc_id }),
  },
  governance: {
    first: `SELECT id, storage_key FROM governance_task_artifacts WHERE realm=$1 AND storage_key<>'' ORDER BY id LIMIT $2`,
    next: `SELECT id, storage_key FROM governance_task_artifacts WHERE realm=$1 AND storage_key<>'' AND id>$2 ORDER BY id LIMIT $3`,
    cursor: row => [row.id],
    reference: (row, realm) => ({ keys: [contentObjectKey(row.storage_key, realm, true)].filter(Boolean), id: row.id }),
  },
  sessionLog: {
    // payload is TEXT, not JSONB. A corrupt or oversized event protects objects;
    // it must not crash the audit or be interpreted as an empty reference set.
    first: `SELECT session_ref,seq::text AS seq,CASE WHEN octet_length(payload)<=8388608 THEN payload END AS payload FROM session_log ORDER BY session_ref,session_log.seq LIMIT $1`,
    next: `SELECT session_ref,seq::text AS seq,CASE WHEN octet_length(payload)<=8388608 THEN payload END AS payload FROM session_log WHERE (session_ref,session_log.seq)>($1::text,$2::bigint) ORDER BY session_ref,session_log.seq LIMIT $3`,
    cursor: row => [row.session_ref, row.seq],
    reference: (row, realm) => row.payload === null
      ? { keys: [], id: `${row.session_ref}:${row.seq}`, oversized: true }
      : { ...sessionContentReferences(row.payload, realm), id: `${row.session_ref}:${row.seq}` },
  },
}

function safeFailure(error) {
  // Never include driver messages: they may contain a DSN, SQL or payload.
  return ['42P01', '42703', '42501', '57014', 'ECONNREFUSED', 'ENOTFOUND', 'ETIMEDOUT'].includes(error?.code) ? error.code : 'unavailable'
}

async function scanSource(client, source, realm, { pageSize, maxRows }, observe) {
  if (client === undefined) return { status: 'not_configured', scannedRows: 0 }
  const summary = { status: 'scanned', scannedRows: 0, malformedPayloads: 0, oversizedPayloads: 0, truncatedPayloads: 0 }
  const spec = SOURCE_QUERIES[source]
  let cursor
  let transaction = false
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    transaction = true
    while (true) {
      const limit = Math.min(pageSize, maxRows - summary.scannedRows + 1)
      const prefix = source === 'sessionLog' ? [] : [realm]
      const { rows } = await client.query(cursor === undefined ? spec.first : spec.next, [...prefix, ...(cursor ?? []), limit])
      if (!rows.length) break
      for (const row of rows) {
        if (summary.scannedRows === maxRows) { summary.status = 'truncated'; break }
        const ref = spec.reference(row, realm)
        summary.scannedRows++
        if (ref.malformed) summary.malformedPayloads++
        if (ref.oversized) summary.oversizedPayloads++
        if (ref.truncated) summary.truncatedPayloads++
        // One event can contain the same attachment more than once.
        for (const key of new Set(ref.keys)) observe(key, { source, id: ref.id })
        cursor = spec.cursor(row)
      }
      if (summary.status === 'truncated' || rows.length < limit) break
    }
    await client.query('COMMIT')
    transaction = false
    if (summary.status === 'scanned' && (summary.malformedPayloads || summary.oversizedPayloads || summary.truncatedPayloads)) summary.status = 'partial'
  } catch (error) {
    summary.status = 'failed'
    summary.error = safeFailure(error)
  } finally {
    if (transaction) await client.query('ROLLBACK').catch(() => {})
  }
  return summary
}

/** All clients are borrowed; this function only runs SELECTs in READ ONLY transactions. */
export async function auditContentReferences({ realm, clients = {}, inventory, inventorySource = 'not_configured', pageSize = 500, maxRows = 100_000, maxObjects = 100_000, maxReferenceSamples = 20 }) {
  validateRealm(realm)
  for (const [name, value] of Object.entries({ pageSize, maxRows, maxObjects, maxReferenceSamples })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`)
  }
  const objects = new Map()
  let omittedObjectObservations = 0
  const itemFor = key => {
    let item = objects.get(key)
    if (item === undefined && objects.size < maxObjects) {
      item = { key, inventorySeen: false, knownReferences: 0, references: [], state: 'protected', reason: 'reference-history-incomplete', deletionAllowed: false }
      objects.set(key, item)
    }
    if (item === undefined) omittedObjectObservations++
    return item
  }
  const observe = (key, reference) => {
    const item = itemFor(key)
    if (item === undefined) return
    item.knownReferences++
    item.state = 'referenced'
    item.reason = 'positive-reference'
    if (item.references.length < maxReferenceSamples) item.references.push(reference)
  }
  const sources = {}
  // Independent databases cannot share a consistent snapshot. Positive evidence
  // remains useful; deletion eligibility cannot be inferred from these scans.
  for (const name of Object.keys(SOURCE_QUERIES)) sources[name] = await scanSource(clients[name], name, realm, { pageSize, maxRows }, observe)
  const inventorySummary = { source: inventorySource, status: inventory === undefined ? 'not_configured' : 'scanned', scannedObjects: 0, ignoredObjects: 0 }
  if (inventory !== undefined) {
    try {
      for await (const entry of inventory) {
        if (inventorySummary.scannedObjects === maxObjects) { inventorySummary.status = 'truncated'; break }
        inventorySummary.scannedObjects++
        const key = typeof entry === 'string' ? entry : entry?.key
        if (typeof key !== 'string' || !key.startsWith(`${realm}/content/`)) { inventorySummary.ignoredObjects++; continue }
        const item = itemFor(key)
        if (item === undefined) continue
        item.inventorySeen = true
        if (Number.isSafeInteger(entry?.size) && entry.size >= 0) item.bytes = entry.size
      }
    } catch (error) { inventorySummary.status = 'failed'; inventorySummary.error = safeFailure(error) }
  }
  const entries = [...objects.values()].sort((a, b) => a.key.localeCompare(b.key))
  return {
    version: 1, mode: 'read-only', realm, generatedAt: new Date().toISOString(),
    deletionAllowed: false, historyCoverage: 'partial',
    limitations: [
      'Only positive references from the selected PostgreSQL tables are recognized.',
      'Cold archives, local/legacy logs, other databases, backups and in-flight writes are not covered.',
      'Session payloads recognize exact full realm/content/SHA-256 strings; ambiguous legacy references remain unproven.',
      'Independent scans are not a global snapshot. Zero known references never means safe to delete.',
      'Shared legacy content objects have no complete pin/release lifecycle; all objects remain protected from deletion.',
    ],
    sources, inventory: inventorySummary,
    summary: { reportedObjects: entries.length, referencedObjects: entries.filter(item => item.state === 'referenced').length,
      protectedObjects: entries.filter(item => item.state === 'protected').length, omittedObjectObservations },
    objects: entries,
  }
}

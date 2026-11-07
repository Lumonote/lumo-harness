import type { ContentTransaction } from './managed-content.ts'

export const STORAGE_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS platform_storage_limits (
 realm TEXT NOT NULL,scope TEXT NOT NULL CHECK(scope IN ('realm','project')),scope_id TEXT NOT NULL,
 limit_bytes BIGINT CHECK(limit_bytes>=0),revision BIGINT NOT NULL DEFAULT 1 CHECK(revision>0),
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),PRIMARY KEY(realm,scope,scope_id),
 CHECK((scope='realm' AND scope_id='') OR (scope='project' AND scope_id<>''))
);
CREATE TABLE IF NOT EXISTS platform_storage_charges (
 realm TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('session-attachment','run-file','task-artifact','knowledge-file')),
 reference_id TEXT NOT NULL,project_id TEXT NOT NULL,bytes BIGINT NOT NULL CHECK(bytes>=0),
 object_key TEXT NOT NULL DEFAULT '',released_at TIMESTAMPTZ,created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(realm,kind,reference_id)
);
CREATE INDEX IF NOT EXISTS platform_storage_charges_project ON platform_storage_charges(realm,project_id);
CREATE TABLE IF NOT EXISTS platform_storage_coverage (
 producer TEXT PRIMARY KEY CHECK(producer IN ('session-attachment','run-file','task-artifact','knowledge-file')),
 completed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
`

export class StorageQuotaError extends Error {
  readonly code = 'storage_quota_exceeded'
  readonly status = 507
  constructor() { super('Storage quota exceeded') }
}

/** Same transaction as the library metadata; content deletion is independent. */
export async function registerKnowledgeStorage(tx: ContentTransaction, realm: string, referenceId: string, bytes: number, objectKey: string, historical = false): Promise<void> {
  if (!realm || !referenceId || !Number.isSafeInteger(bytes) || bytes < 0) throw new Error('Invalid storage charge')
  await tx.query(`INSERT INTO platform_storage_limits(realm,scope,scope_id) VALUES($1,'realm','') ON CONFLICT DO NOTHING`, [realm])
  await tx.query(`SELECT revision FROM platform_storage_limits WHERE realm=$1 AND scope='realm' AND scope_id='' FOR UPDATE`, [realm])
  const existing = (await tx.query(`SELECT project_id,bytes,object_key,released_at FROM platform_storage_charges WHERE realm=$1 AND kind='knowledge-file' AND reference_id=$2`, [realm, referenceId])).rows[0]
  if (existing) {
    if (existing.project_id !== '' || Number(existing.bytes) !== bytes || existing.object_key !== objectKey || existing.released_at !== null) throw new Error('Storage reference is immutable')
    return
  }
  if (!historical) {
    const ready = (await tx.query(`SELECT NOT EXISTS(SELECT 1 FROM platform_storage_limits WHERE realm=$1 AND scope='realm' AND limit_bytes IS NOT NULL) OR NOT EXISTS(SELECT 1 FROM (VALUES ('session-attachment','session_attachment_receipts'),('run-file','governance_run_file_blobs'),('task-artifact','governance_task_artifacts'),('knowledge-file','knowledge_library_files')) AS sources(producer,source_table) WHERE to_regclass(source_table) IS NOT NULL AND NOT EXISTS(SELECT 1 FROM platform_storage_coverage c WHERE c.producer=sources.producer)) AS ready`, [realm])).rows[0]
    if (ready?.ready !== true) throw Object.assign(new Error('Storage accounting is awaiting producer backfill'), {code:'storage_accounting_pending', status:503})
  }
  const limit = (await tx.query(`SELECT limit_bytes,COALESCE((SELECT sum(bytes) FROM platform_storage_charges WHERE realm=$1 AND released_at IS NULL),0)::text AS used FROM platform_storage_limits WHERE realm=$1 AND scope='realm' AND scope_id=''`, [realm])).rows[0]!
  if (!historical && limit.limit_bytes !== null && BigInt(bytes) > BigInt(String(limit.limit_bytes)) - BigInt(String(limit.used))) throw new StorageQuotaError()
  await tx.query(`INSERT INTO platform_storage_charges(realm,project_id,kind,reference_id,bytes,object_key) VALUES($1,'','knowledge-file',$2,$3,$4)`, [realm,referenceId,bytes,objectKey])
}

export async function releaseKnowledgeStorage(tx: ContentTransaction, realm: string, referenceId: string): Promise<void> {
  await tx.query(`SELECT revision FROM platform_storage_limits WHERE realm=$1 AND scope='realm' AND scope_id='' FOR UPDATE`, [realm])
  await tx.query(`UPDATE platform_storage_charges SET released_at=COALESCE(released_at,clock_timestamp()) WHERE realm=$1 AND kind='knowledge-file' AND reference_id=$2`, [realm,referenceId])
}

export async function backfillKnowledgeStorage(tx: ContentTransaction): Promise<void> {
  for (;;) {
    const rows = (await tx.query(`SELECT f.realm,f.doc_id,f.byte_size,f.object_key FROM knowledge_library_files f WHERE NOT EXISTS(SELECT 1 FROM platform_storage_charges c WHERE c.realm=f.realm AND c.kind='knowledge-file' AND c.reference_id=f.doc_id) ORDER BY f.realm,f.doc_id LIMIT 1000`)).rows
    if (!rows.length) { await tx.query(`INSERT INTO platform_storage_coverage(producer) VALUES('knowledge-file') ON CONFLICT DO NOTHING`); return }
    for (const row of rows) await registerKnowledgeStorage(tx,String(row.realm),String(row.doc_id),Number(row.byte_size),String(row.object_key),true)
  }
}

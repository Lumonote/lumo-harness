/** Object-store-owned truth. Producers may only call these pin/release helpers
 * inside their existing authoritative PG transaction, never as a second commit. */
import { parseManagedContentKey, isManagedContentKey } from './seam-contracts/managed-content.ts'

export const MANAGED_CONTENT_DDL = `
CREATE TABLE IF NOT EXISTS managed_content_objects (
  realm TEXT NOT NULL,
  object_id UUID NOT NULL,
  storage_id TEXT NOT NULL,
  object_key TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size BIGINT NOT NULL CHECK (byte_size >= 0),
  reservation_kind TEXT NOT NULL CHECK (reservation_kind='knowledge-file'),
  reservation_id TEXT NOT NULL,
  reservation_active BOOLEAN NOT NULL DEFAULT true,
  state TEXT NOT NULL DEFAULT 'uploading' CHECK (state IN ('uploading','ready','deleting','deleted')),
  revision BIGINT NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  retain_until TIMESTAMPTZ NOT NULL,
  grace_ms BIGINT NOT NULL CHECK (grace_ms >= 0),
  unreferenced_at TIMESTAMPTZ,
  collect_after TIMESTAMPTZ,
  delete_token UUID,
  delete_lease_until TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,
  PRIMARY KEY (realm,object_id),
  UNIQUE (realm,object_key),
  UNIQUE (realm,reservation_kind,reservation_id)
);
CREATE TABLE IF NOT EXISTS managed_content_references (
  realm TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind='knowledge-file'),
  reference_id TEXT NOT NULL,
  object_id UUID NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_at TIMESTAMPTZ,
  PRIMARY KEY (realm,kind,reference_id),
  FOREIGN KEY (realm,object_id) REFERENCES managed_content_objects(realm,object_id)
);
CREATE INDEX IF NOT EXISTS managed_content_live_references ON managed_content_references(realm,object_id) WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS managed_content_gc ON managed_content_objects(realm,state,collect_after) WHERE reservation_active=false;
`

export interface ContentTransaction {
  query(sql: string, parameters?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>
}
interface Reference { realm: string; kind: 'knowledge-file'; referenceId: string; objectKey: string; sha256: string; byteSize: number }
export async function pinManagedContent(tx: ContentTransaction, ref: Reference): Promise<void> {
  if (!isManagedContentKey(ref.objectKey)) return
  const key = parseManagedContentKey(ref.realm, ref.objectKey)
  if (!key || key.sha256 !== ref.sha256 || !Number.isSafeInteger(ref.byteSize) || ref.byteSize < 0) throw new Error('Managed content identity does not match the authoritative file')
  const object = (await tx.query(`SELECT state,sha256,byte_size,object_key FROM managed_content_objects WHERE realm=$1 AND object_id=$2::uuid FOR UPDATE`, [ref.realm,key.objectId])).rows[0]
  if (!object || object.state !== 'ready' || object.sha256 !== ref.sha256 || Number(object.byte_size) !== ref.byteSize || object.object_key !== ref.objectKey) throw new Error('Managed content is not ready for a durable reference')
  const existing = (await tx.query(`SELECT object_id::text,released_at FROM managed_content_references WHERE realm=$1 AND kind=$2 AND reference_id=$3`, [ref.realm,ref.kind,ref.referenceId])).rows[0]
  if (existing && (existing.object_id !== key.objectId || existing.released_at !== null)) throw new Error('Managed content reference identity cannot be reused or revived')
  if (!existing) await tx.query(`INSERT INTO managed_content_references(realm,kind,reference_id,object_id)VALUES($1,$2,$3,$4::uuid)`, [ref.realm,ref.kind,ref.referenceId,key.objectId])
  await tx.query(`UPDATE managed_content_objects SET reservation_active=CASE WHEN reservation_kind=$3 AND reservation_id=$4 THEN false ELSE reservation_active END,
    unreferenced_at=NULL,collect_after=NULL,revision=revision+1 WHERE realm=$1 AND object_id=$2::uuid`, [ref.realm,key.objectId,ref.kind,ref.referenceId])
}
export async function releaseManagedContent(tx: ContentTransaction, ref: Pick<Reference,'realm'|'kind'|'referenceId'|'objectKey'>): Promise<void> {
  if (!isManagedContentKey(ref.objectKey)) return
  const key = parseManagedContentKey(ref.realm, ref.objectKey)
  if (!key) throw new Error('Invalid managed content release identity')
  const object = (await tx.query(`SELECT state FROM managed_content_objects WHERE realm=$1 AND object_id=$2::uuid FOR UPDATE`, [ref.realm,key.objectId])).rows[0]
  if (!object) throw new Error('Managed content authority is missing')
  const reference = (await tx.query(`SELECT object_id::text FROM managed_content_references WHERE realm=$1 AND kind=$2 AND reference_id=$3`, [ref.realm,ref.kind,ref.referenceId])).rows[0]
  if (!reference || reference.object_id !== key.objectId) throw new Error('Managed content reference is missing or belongs to another object')
  await tx.query(`UPDATE managed_content_references SET released_at=COALESCE(released_at,now()) WHERE realm=$1 AND kind=$2 AND reference_id=$3`, [ref.realm,ref.kind,ref.referenceId])
  await tx.query(`UPDATE managed_content_objects o SET unreferenced_at=COALESCE(unreferenced_at,now()),
    collect_after=COALESCE(collect_after,GREATEST(retain_until,now()+grace_ms*interval '1 millisecond')),revision=revision+1
    WHERE realm=$1 AND object_id=$2::uuid AND NOT EXISTS(SELECT 1 FROM managed_content_references r WHERE r.realm=o.realm AND r.object_id=o.object_id AND r.released_at IS NULL)`, [ref.realm,key.objectId])
}

import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { MANAGED_CONTENT_DDL } from '../../../shared/managed-content.ts'
import { contentDigest, managedContentKey, parseManagedContentKey, type ManagedContentCandidate, type ManagedContentCollection,
  type ManagedContentReceipt, type ManagedContentReference, type ManagedContentSeam } from '../../../shared/seam-contracts/managed-content.ts'
import { validRealmKey } from '../../../shared/seam-contracts/object-store.ts'

export interface ManagedContentConfig {
  connectionString: string
  /** Stable backing-store identity; prevents one bucket collecting another. */
  storageId: string
  /** Minimum age and post-release grace; defaults are seven days / one day. */
  retentionMs?: number
  graceMs?: number
  /** Explicit operator opt-in. False keeps collect() a dry run. */
  deleteEnabled?: boolean
  ioTimeoutMs?: number
  gcIntervalMs?: number
}
export interface ManagedContentBackend {
  put(realm: string, relativeKey: string, body: Buffer, contentType?: string): Promise<void>
  delete(realm: string, relativeKey: string): Promise<void>
}
function validateReference(ref: ManagedContentReference): void {
  if (!validRealmKey(ref.realm) || ref.kind !== 'knowledge-file' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/u.test(ref.referenceId)) throw new TypeError('Invalid managed content reservation')
}
function duration(value: number | undefined, fallback: number, maximum: number): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 0 || result > maximum) throw new TypeError('Invalid managed content retention/timeout configuration')
  return result
}
async function deadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([work,new Promise<never>((_resolve,reject) => { timer=setTimeout(() => reject(new Error('Managed content storage operation timed out')),ms); timer.unref() })]) }
  finally { if (timer) clearTimeout(timer) }
}
interface ObjectRow {
  realm: string; object_id: string; storage_id:string; object_key: string; sha256: string; byte_size: string; state: string
  reservation_active: boolean; reservation_kind: 'knowledge-file'; reservation_id: string; revision: string
}

/** PG is the only lifecycle truth. MinIO deletion starts only AFTER a durable
 * deleting commit, so a successful delete with an ambiguous final commit can
 * never make a later pin succeed against an absent object. */
export class PgManagedContentStore implements ManagedContentSeam {
  private readonly pool: pg.Pool
  private readonly ready: Promise<void>
  private readonly retentionMs: number
  private readonly graceMs: number
  private readonly ioTimeoutMs: number
  private readonly enabled: boolean
  private readonly storageId:string
  constructor(config: ManagedContentConfig, private readonly backend: ManagedContentBackend) {
    if (!config.connectionString?.trim() || !config.storageId?.trim() || config.storageId.length>256 || config.deleteEnabled !== undefined && typeof config.deleteEnabled !== 'boolean') throw new TypeError('Managed content requires PostgreSQL, backing-store identity and an explicit boolean GC switch')
    this.storageId=config.storageId
    this.retentionMs=duration(config.retentionMs,7*86400_000,3650*86400_000)
    this.graceMs=duration(config.graceMs,86400_000,3650*86400_000)
    this.ioTimeoutMs=duration(config.ioTimeoutMs,30_000,120_000)
    if (this.ioTimeoutMs < 100) throw new TypeError('Managed content storage timeout must be at least 100ms')
    this.enabled=config.deleteEnabled === true
    this.pool=new pg.Pool({ connectionString: config.connectionString, max: 4, connectionTimeoutMillis: 5000, query_timeout: 15_000 })
    this.ready=this.initialize()
    // Callers await the same rejected initialization; do not create an unhandled
    // rejection while Cordis is still mounting the consuming plugin.
    void this.ready.catch(() => {})
  }
  private async initialize(): Promise<void> {
    const tx=await this.pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query('SELECT pg_advisory_xact_lock(823055)')
      await tx.query(MANAGED_CONTENT_DDL)
      await tx.query('COMMIT')
    } catch(error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  async init(): Promise<void> { await this.ready }
  async close(): Promise<void> { await this.ready.catch(() => {}); await this.pool.end() }
  async put(ref: ManagedContentReference, body: Buffer | string, contentType?: string): Promise<ManagedContentReceipt> {
    validateReference(ref); await this.ready
    const bytes=typeof body==='string'?Buffer.from(body):Buffer.from(body)
    const sha256=contentDigest(bytes), id=randomUUID(), key=managedContentKey(ref.realm,id,sha256)
    // The committed reservation protects external writes and unknown outcomes.
    const reservation=await this.pool.query(`INSERT INTO managed_content_objects(realm,object_id,object_key,sha256,byte_size,reservation_kind,reservation_id,retain_until,grace_ms,storage_id)
      VALUES($1,$2::uuid,$3,$4,$5,$6,$7,now()+$8*interval '1 millisecond',$9,$10)
      ON CONFLICT(realm,reservation_kind,reservation_id)DO NOTHING RETURNING object_id`, [ref.realm,id,key,sha256,bytes.length,ref.kind,ref.referenceId,this.retentionMs,this.graceMs,this.storageId])
    const tx=await this.pool.connect()
    try {
      await tx.query('BEGIN')
      await tx.query("SET LOCAL lock_timeout='5s'")
      const row=(await tx.query<ObjectRow>(`SELECT * FROM managed_content_objects WHERE realm=$1 AND reservation_kind=$2 AND reservation_id=$3 FOR UPDATE`,[ref.realm,ref.kind,ref.referenceId])).rows[0]!
      if(row.storage_id!==this.storageId)throw new Error('Managed upload identity belongs to a different backing store')
      if (row.sha256!==sha256 || Number(row.byte_size)!==bytes.length) throw new Error('Managed content upload identity already represents different bytes')
      const parsed=parseManagedContentKey(ref.realm,row.object_key)
      if (!parsed || parsed.objectId!==row.object_id || parsed.sha256!==sha256) throw new Error('Managed content authority contains an invalid object key')
      if (!['uploading','ready'].includes(row.state)) throw new Error('Managed content identity is sealed for deletion; allocate a new upload identity')
      if (row.state==='uploading') {
        // A timeout does not cancel a MinIO request. Never issue another write
        // to an uncertain reservation: a late first write could recreate an
        // object after a successful retry was pinned, released and collected.
        if (!reservation.rowCount) throw new Error('Managed content upload is pending; review its storage outcome or allocate a new upload identity')
        await deadline(this.backend.put(ref.realm,parsed.relativeKey,bytes,contentType),this.ioTimeoutMs)
        await tx.query(`UPDATE managed_content_objects SET state='ready',revision=revision+1 WHERE realm=$1 AND object_id=$2::uuid`,[ref.realm,row.object_id])
      }
      await tx.query('COMMIT')
      return { ...ref,objectId: row.object_id,objectKey:row.object_key,sha256,byteSize:bytes.length }
    } catch(error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  async abandon(ref: ManagedContentReference): Promise<boolean> {
    validateReference(ref); await this.ready
    const tx=await this.pool.connect()
    try {
      await tx.query('BEGIN')
      const row=(await tx.query<ObjectRow>(`SELECT * FROM managed_content_objects WHERE realm=$1 AND reservation_kind=$2 AND reservation_id=$3 FOR UPDATE`,[ref.realm,ref.kind,ref.referenceId])).rows[0]
      if(row && row.storage_id!==this.storageId)throw new Error('Managed reservation belongs to a different backing store')
      if (!row || row.state!=='ready') { await tx.query('COMMIT'); return false }
      // An uncertain metadata commit must retain its committed pin.
      const live=await tx.query(`SELECT 1 FROM managed_content_references WHERE realm=$1 AND object_id=$2::uuid AND released_at IS NULL LIMIT 1`,[ref.realm,row.object_id])
      if (live.rowCount) { await tx.query('COMMIT'); return false }
      await tx.query(`UPDATE managed_content_objects SET reservation_active=false,unreferenced_at=COALESCE(unreferenced_at,now()),
        collect_after=COALESCE(collect_after,GREATEST(retain_until,now()+grace_ms*interval '1 millisecond')),revision=revision+1
        WHERE realm=$1 AND object_id=$2::uuid`,[ref.realm,row.object_id])
      await tx.query('COMMIT'); return true
    } catch(error) { await tx.query('ROLLBACK'); throw error }
    finally { tx.release() }
  }
  private limit(value: number): number {
    if (!Number.isSafeInteger(value) || value<1 || value>1000) throw new TypeError('Managed content GC limit must be 1–1000')
    return value
  }
  async candidates(realm: string,limit=100): Promise<ManagedContentCandidate[]> {
    if (!validRealmKey(realm)) throw new TypeError('Invalid managed content realm')
    await this.ready
    const rows=await this.pool.query(`SELECT object_id::text,object_key,state,revision,byte_size,unreferenced_at::text,collect_after::text
      FROM managed_content_objects o WHERE realm=$1 AND storage_id=$3 AND reservation_active=false AND state IN ('ready','deleting')
        AND unreferenced_at IS NOT NULL AND collect_after<=now() AND retain_until<=now()
        AND NOT EXISTS(SELECT 1 FROM managed_content_references r WHERE r.realm=o.realm AND r.object_id=o.object_id AND r.released_at IS NULL)
      ORDER BY collect_after,object_id LIMIT $2`,[realm,this.limit(limit),this.storageId])
    return rows.rows.map(row => ({ objectId:row.object_id,objectKey:row.object_key,state:row.state,revision:Number(row.revision),
      byteSize:Number(row.byte_size),unreferencedAt:row.unreferenced_at,collectAfter:row.collect_after }))
  }
  async collect(realm: string,limit=100): Promise<ManagedContentCollection> {
    const candidates=await this.candidates(realm,limit)
    const result:ManagedContentCollection={ deletionEnabled:this.enabled,candidates:candidates.length,deleted:0,failed:0 }
    if (!this.enabled) return result
    for (const candidate of candidates) {
      const parsed=parseManagedContentKey(realm,candidate.objectKey)
      if (!parsed || parsed.objectId!==candidate.objectId) { result.failed++; continue }
      const token=randomUUID(), tx=await this.pool.connect()
      let claimed=false
      try {
        await tx.query('BEGIN')
        const row=await tx.query(`SELECT 1 FROM managed_content_objects o WHERE realm=$1 AND object_id=$2::uuid AND revision=$3 AND storage_id=$4 AND object_key=$5
          AND reservation_active=false AND state IN ('ready','deleting') AND collect_after<=now() AND retain_until<=now()
          AND (delete_lease_until IS NULL OR delete_lease_until<now())
          AND NOT EXISTS(SELECT 1 FROM managed_content_references r WHERE r.realm=o.realm AND r.object_id=o.object_id AND r.released_at IS NULL)
          FOR UPDATE SKIP LOCKED`,[realm,candidate.objectId,candidate.revision,this.storageId,candidate.objectKey])
        if (row.rowCount) {
          await tx.query(`UPDATE managed_content_objects SET state='deleting',delete_token=$3::uuid,
            delete_lease_until=now()+$4*interval '1 millisecond',revision=revision+1 WHERE realm=$1 AND object_id=$2::uuid`,[realm,candidate.objectId,token,this.ioTimeoutMs+5000])
          claimed=true
        }
        await tx.query('COMMIT')
      } catch(error) { await tx.query('ROLLBACK'); throw error }
      finally { tx.release() }
      if (!claimed) continue
      try {
        await deadline(this.backend.delete(realm,parsed.relativeKey),this.ioTimeoutMs)
        await this.pool.query(`UPDATE managed_content_objects SET state='deleted',deleted_at=now(),delete_lease_until=NULL,revision=revision+1
          WHERE realm=$1 AND object_id=$2::uuid AND state='deleting' AND delete_token=$3::uuid`,[realm,candidate.objectId,token])
        result.deleted++
      } catch {
        // Keep the durable deleting fence even when MinIO may have succeeded.
        // A later run retries the same immutable key; no pin can revive it.
        result.failed++
        await this.pool.query(`UPDATE managed_content_objects SET delete_lease_until=NULL WHERE realm=$1 AND object_id=$2::uuid AND delete_token=$3::uuid`,[realm,candidate.objectId,token]).catch(() => {})
      }
    }
    return result
  }
}

import type { Pool } from 'pg'
import { randomUUID } from 'node:crypto'
import { cancelPlacement, type PlacementIdentity, type PlacementResult } from './client.ts'

export interface PlacementRecovery {
  begin(childId: string, timeoutMs: number): Promise<void>
  finish(childId: string): Promise<void>
  cancel(childId: string, placement?: PlacementResult): Promise<void>
}

export const PLACEMENT_RECOVERY_DDL = `CREATE TABLE IF NOT EXISTS subagent_placement_cleanup (
  realm TEXT NOT NULL, child_id TEXT NOT NULL, attempt INTEGER, node_id TEXT,
  expires_at TIMESTAMPTZ NOT NULL, cancellation_needed BOOLEAN NOT NULL DEFAULT false,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), claim_token TEXT,
  PRIMARY KEY(realm,child_id)
)`

/** Records intent before placement so ambiguous POSTs are cancelled after a parent crash. */
export class PgPlacementRecovery implements PlacementRecovery {
  constructor(private readonly pool: Pool, private readonly identity: Omit<PlacementIdentity, 'childId'>) {}
  async init(): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query('SELECT pg_advisory_xact_lock(671839417)')
      await client.query(PLACEMENT_RECOVERY_DDL)
      await client.query('COMMIT')
    } catch (error) { await client.query('ROLLBACK'); throw error } finally { client.release() }
  }

  async begin(childId: string, timeoutMs: number): Promise<void> {
    await this.pool.query(`INSERT INTO subagent_placement_cleanup(realm,child_id,expires_at)
      VALUES($1,$2,now()+$3 * interval '1 millisecond')`, [this.identity.realm, childId, timeoutMs])
  }
  async finish(childId: string): Promise<void> {
    await this.pool.query('DELETE FROM subagent_placement_cleanup WHERE realm=$1 AND child_id=$2', [this.identity.realm, childId])
  }
  async cancel(childId: string, placement?: PlacementResult): Promise<void> {
    await this.pool.query(`UPDATE subagent_placement_cleanup SET cancellation_needed=true,attempt=$3,node_id=$4
      WHERE realm=$1 AND child_id=$2`, [this.identity.realm, childId, placement?.attempt ?? null, placement?.nodeId ?? null])
    if (await cancelPlacement({ ...this.identity, childId, ...placement })) await this.finish(childId)
  }
  async sweep(): Promise<void> {
    const token = randomUUID()
    const claimed = await this.pool.query<{ child_id: string; attempt: number | null; node_id: string | null }>(`WITH picked AS (
      SELECT realm,child_id FROM subagent_placement_cleanup WHERE realm=$1
        AND (cancellation_needed OR expires_at<=now()) AND next_attempt_at<=now()
      ORDER BY next_attempt_at LIMIT 8 FOR UPDATE SKIP LOCKED
    ) UPDATE subagent_placement_cleanup c SET cancellation_needed=true,claim_token=$2,next_attempt_at=now()+interval '30 seconds'
      FROM picked p WHERE c.realm=p.realm AND c.child_id=p.child_id RETURNING c.child_id,c.attempt,c.node_id`, [this.identity.realm, token])
    for (const item of claimed.rows) {
      try {
        const done = await cancelPlacement({ ...this.identity, childId: item.child_id,
          ...(item.attempt && item.node_id ? { attempt: item.attempt, nodeId: item.node_id } : {}) })
        if (done) await this.pool.query('DELETE FROM subagent_placement_cleanup WHERE realm=$1 AND child_id=$2 AND claim_token=$3', [this.identity.realm, item.child_id, token])
      } finally {
        await this.pool.query(`UPDATE subagent_placement_cleanup SET claim_token=NULL,next_attempt_at=now()+interval '5 seconds'
          WHERE realm=$1 AND child_id=$2 AND claim_token=$3`, [this.identity.realm, item.child_id, token])
      }
    }
  }
}

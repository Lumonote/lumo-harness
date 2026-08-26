/**
 * PG storage backend for the storage hub: one PostgreSQL database hosts every
 * routed unit, document-per-row (`key TEXT` / `value TEXT` JSON). Registers as
 * backend `pg`; the disposer unregisters first, then closes the medium.
 * Mirrors storage-sqlite's `index.ts`: same interface, same contract clauses,
 * with the sync `DatabaseSync` swapped for an async `pg.Pool`.
 * @module @lumo/storage
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import pg from 'pg'
import { StorageError, UNIT_NAME_RE, storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import type { KvFacet, KvUnit, KvUnitDescriptor, StorageBackend } from '@deepseek-ai/dsh-storage'
import { ensureSchema, recordTableName } from './schema.ts'
import { PgKvUnit } from './unit.ts'

export { STORAGE_PG_SCHEMA_VERSION } from './schema.ts'

/** Cordis plugin name. */
export const name = 'storage-pg'
/** The backend registers on the storage hub. */
export const inject = ['storage']

/** Plugin configuration. */
export interface PgStorageConfig {
  /** PostgreSQL connection string for the database that hosts routed units. */
  connectionString: string
}

/** Schemastery validator for {@link PgStorageConfig}. */
export const Config: z<PgStorageConfig> = z.object({
  connectionString: z.string(),
})

/**
 * The PG {@link StorageBackend}. Owns one `pg.Pool` and the open-unit table;
 * `kv.open` validates names, enforces the per-unit version stamp in `units`,
 * and ensures the unit's record tables.
 */
export class PgStorageBackend implements StorageBackend {
  /** The key-value facet; the only shape this backend serves. */
  readonly kv: KvFacet = { open: descriptor => this.openUnit(descriptor) }

  /** The connection pool owns the medium's lifecycle. */
  private readonly pool: pg.Pool
  private readonly ready: Promise<void>
  /** Open (or still-opening) units by name; presence is the double-open guard. */
  private readonly units = new Map<string, Promise<PgKvUnit>>()
  private closing: Promise<void> | undefined

  /**
   * @param config - The connection string, or validated plugin configuration.
   */
  constructor(connectionString: string) {
    this.pool = new pg.Pool({ connectionString, max: 10 })
    this.ready = ensureSchema(this.pool)
    // Mark the rejection handled: every primitive re-awaits `ready`, so an
    // open failure still surfaces to each caller; this guard only prevents an
    // unhandled-rejection crash when the failure precedes the first use.
    this.ready.catch(() => {})
  }

  private openUnit(descriptor: KvUnitDescriptor): Promise<KvUnit> {
    if (this.closing !== undefined) {
      return Promise.reject(new StorageError('closed', 'pg storage backend is closed'))
    }
    if (!UNIT_NAME_RE.test(descriptor.name)) {
      return Promise.reject(new Error(`kv unit name '${descriptor.name}' violates ${UNIT_NAME_RE}`))
    }
    for (const table of descriptor.tables) {
      if (!UNIT_NAME_RE.test(table)) {
        return Promise.reject(new Error(`kv table name '${table}' in unit '${descriptor.name}' violates ${UNIT_NAME_RE}`))
      }
    }
    if (this.units.has(descriptor.name)) {
      return Promise.reject(new Error(`kv unit '${descriptor.name}' is already open (double-open is a caller bug)`))
    }
    // Reserve the name synchronously so a concurrent second open of the same
    // name rejects instead of racing past the guard during the awaits below.
    const pending = this.materializeUnit(descriptor)
    this.units.set(descriptor.name, pending)
    pending.catch(() => this.units.delete(descriptor.name))
    return pending
  }

  private async materializeUnit(descriptor: KvUnitDescriptor): Promise<PgKvUnit> {
    await this.ready
    const { rows } = await this.pool.query('SELECT version FROM units WHERE name = $1', [descriptor.name])
    const row = rows[0] as { version: number } | undefined
    if (row === undefined) {
      await this.pool.query('INSERT INTO units (name, version) VALUES ($1, $2)', [descriptor.name, descriptor.version])
    } else if (row.version !== descriptor.version) {
      throw new StorageError(
        'version-mismatch',
        `kv unit '${descriptor.name}' is stamped version ${row.version} on the medium, incompatible with descriptor version ${descriptor.version}`,
      )
    }
    for (const table of descriptor.tables) {
      // Both segments passed UNIT_NAME_RE, so the identifier is safe in DDL.
      await this.pool.query(`
        CREATE TABLE IF NOT EXISTS "${recordTableName(descriptor.name, table)}" (
          key   TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `)
    }
    return new PgKvUnit(this.pool, descriptor, () => {
      this.units.delete(descriptor.name)
    })
  }

  /**
   * Close every open unit and release the database. Idempotent; concurrent
   * and repeated calls resolve once teardown finishes.
   * @returns resolution after the medium is released.
   */
  close(): Promise<void> {
    this.closing ??= this.doClose()
    return this.closing
  }

  private async doClose(): Promise<void> {
    try {
      await this.ready
    } catch {
      // The medium never opened; that failure already rejected the opener and
      // every unit call, so there is nothing left to release here.
      return
    }
    for (const pending of [...this.units.values()]) {
      const unit = await pending.catch(() => undefined)
      await unit?.close()
    }
    await this.pool.end()
  }
}

/**
 * Register the PG backend as `pg` on the storage hub. The disposer unregisters
 * the name first, then closes the backend.
 * @param ctx - Plugin context (must inject `storage`).
 * @param config - Validated plugin configuration.
 */
export function apply(ctx: Context, config: PgStorageConfig) {
  const backend = new PgStorageBackend(config.connectionString)
  ctx.effect(() => {
    const dispose = ctx.storage.backend.register('pg', backend)
    return async () => {
      dispose()
      await backend.close()
    }
  }, 'storage-pg.registerBackend')
  ctx.provide(storageBackendServiceKey('pg'), backend)
}

export default apply
export type { KvFacet } from '@deepseek-ai/dsh-storage'
export { PgKvUnit } from './unit.ts'
export { ensureSchema, recordTableName } from './schema.ts'
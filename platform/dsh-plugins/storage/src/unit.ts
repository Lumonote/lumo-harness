/**
 * One opened PG KV unit: parameterized per-table queries over the
 * `u_<unit>_<table>` record tables plus this unit's row in the shared
 * `unit_globals` table. Each primitive is a single statement in its own
 * autocommitted transaction, so atomicity and durability come from PG itself
 * — no explicit transaction wrapper, and no write queue (write ordering is
 * the caller's responsibility per the KV contract). Mirrors storage-sqlite's
 * `unit.ts` clause-for-clause, with the sync DatabaseSync swapped for an async
 * `pg.Pool`.
 * @module @lumo/storage/unit
 */

import type pg from 'pg'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { recordTableName } from './schema.ts'

/**
 * The PG {@link KvUnit}. Constructed by the backend AFTER the unit's record
 * tables exist; each primitive runs a parameterized statement reused across
 * calls (prepared-once by the pool). Values are stored as JSON text in the
 * `value` column.
 */
export class PgKvUnit implements KvUnit {
  private readonly tables: readonly string[]
  private readonly globalStatement: string | undefined
  private closed = false

  /**
   * @param pool - Connection pool owned by the backend (never closed here).
   * @param descriptor - Validated descriptor whose record tables already exist.
   * @param onClose - Backend callback releasing this unit's open-name slot.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
  ) {
    this.tables = descriptor.tables
    this.globalStatement = descriptor.hasGlobal
      ? 'INSERT INTO unit_globals (unit, value) VALUES ($1, $2) ON CONFLICT (unit) DO UPDATE SET value = EXCLUDED.value'
      : undefined
  }

  loadAll(): Promise<{ tables: Record<string, Record<string, unknown>>; global: unknown }> {
    return this.settle(async () => {
      this.ensureOpen()
      const tables: Record<string, Record<string, unknown>> = {}
      for (const table of this.tables) {
        // Record keys are arbitrary strings, so '__proto__' must land as an
        // own property instead of mutating the prototype (same as sqlite).
        const records: Record<string, unknown> = Object.create(null) as Record<string, unknown>
        const { rows } = await this.pool.query(
          `SELECT key, value FROM "${recordTableName(this.descriptor.name, table)}"`,
        )
        for (const row of rows as Array<{ key: string; value: string }>) {
          records[row.key] = this.parseValue(row.value, `table '${table}' key '${row.key}'`)
        }
        tables[table] = records
      }
      let global: unknown = null
      if (this.globalStatement !== undefined) {
        const { rows } = await this.pool.query(
          'SELECT value FROM unit_globals WHERE unit = $1',
          [this.descriptor.name],
        )
        if (rows.length > 0) global = this.parseValue((rows[0] as { value: string }).value, 'global slot')
      }
      return { tables, global }
    })
  }

  /** Parse one stored value column, mapping bad JSON to `malformed-medium`. */
  private parseValue(text: string, slot: string): unknown {
    try {
      return JSON.parse(text)
    } catch (error) {
      throw new StorageError(
        'malformed-medium',
        `kv unit '${this.descriptor.name}' holds unparsable JSON at ${slot}`,
        { cause: error },
      )
    }
  }

  putRecord(table: string, key: string, value: unknown): Promise<void> {
    return this.settle(async () => {
      this.ensureOpen()
      await this.pool.query(
        `INSERT INTO "${this.physicalFor(table)}" (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      )
    })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.settle(async () => {
      this.ensureOpen()
      await this.pool.query(`DELETE FROM "${this.physicalFor(table)}" WHERE key = $1`, [key])
    })
  }

  setGlobal(value: unknown): Promise<void> {
    return this.settle(async () => {
      this.ensureOpen()
      if (this.globalStatement === undefined) {
        throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`)
      }
      await this.pool.query(this.globalStatement, [this.descriptor.name, JSON.stringify(value)])
    })
  }

  close(): Promise<void> {
    if (!this.closed) {
      this.closed = true
      this.onClose()
    }
    return Promise.resolve()
  }

  /**
   * Map a table name to its physical identifier, rejecting names the unit was
   * not declared with. Both segments are already validated against
   * `UNIT_NAME_RE` by the backend, so the identifier is safe to interpolate.
   */
  private physicalFor(table: string): string {
    if (!this.tables.includes(table)) {
      throw new Error(`kv unit '${this.descriptor.name}' declared no table '${table}'`)
    }
    return recordTableName(this.descriptor.name, table)
  }

  private ensureOpen(): void {
    if (this.closed) {
      throw new StorageError('closed', `kv unit '${this.descriptor.name}' is closed`)
    }
  }

  /**
   * Guard a primitive's rejection so it never surfaces a non-Error value.
   * `operation` is async, so `ensureOpen`'s sync throw becomes a rejection;
   * a value's own `toJSON` throw can also reject with a non-Error via
   * `JSON.stringify` propagating it. Wrap those, preserve every real Error so
   * `StorageError` codes flow through unchanged.
   */
  private settle<T>(operation: () => Promise<T>): Promise<T> {
    // An async operation can still reject synchronously-invoked code in the
    // same tick only as a rejection, so both paths funnel through the map.
    const promise = operation()
    return promise.catch((error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error))
    })
  }
}
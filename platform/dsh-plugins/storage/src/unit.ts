/**
 * One opened PG KV unit: parameterized per-table queries over the
 * `u_<unit>_<table>` record tables plus this unit's row in the shared
 * `unit_globals` table. Writes use a transaction to check the unit version,
 * apply the mutation, and stamp an accepted older version on its first change.
 * The optional record CAS provides cross-replica conditional writes; general
 * write ordering remains the caller's responsibility per the KV contract.
 * @module @lumo/storage/unit
 */

import type pg from 'pg'
import { StorageError } from '@deepseek-ai/dsh-storage'
import type { KvUnit, KvUnitDescriptor } from '@deepseek-ai/dsh-storage'
import { recordTableName } from './schema.ts'

/**
 * The PG {@link KvUnit}. Constructed by the backend AFTER the unit's record
 * tables exist. Queries use parameters for keys and values. Values are stored
 * as JSON text in the `value` column; CAS compares them as JSONB.
 */
export class PgKvUnit implements KvUnit {
  private readonly tables: readonly string[]
  private readonly globalStatement: string | undefined
  private closed = false
  private needsVersionStamp: boolean

  /**
   * @param pool - Connection pool owned by the backend (never closed here).
   * @param descriptor - Validated descriptor whose record tables already exist.
   * @param onClose - Backend callback releasing this unit's open-name slot.
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly descriptor: KvUnitDescriptor,
    private readonly onClose: () => void,
    storedVersion = descriptor.version,
  ) {
    this.needsVersionStamp = storedVersion !== descriptor.version
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
      await this.write(
        `INSERT INTO "${this.physicalFor(table)}" (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      )
    })
  }

  /** Optional platform extension; undefined expected means insert-only, undefined next means delete. */
  compareAndSetRecord(table: string, key: string, expected: unknown, next: unknown): Promise<boolean> {
    return this.settle(async () => {
      this.ensureOpen()
      const physical = this.physicalFor(table)
      if (expected === undefined) {
        if (next === undefined) throw new Error('compareAndSetRecord requires an expected or next value')
        const result = await this.write(
          `INSERT INTO "${physical}" (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING RETURNING key`,
          [key, JSON.stringify(next)],
        )
        return result.rows.length === 1
      }
      const result = next === undefined
        ? await this.write(`DELETE FROM "${physical}" WHERE key = $1 AND value::jsonb = $2::jsonb RETURNING key`,
          [key, JSON.stringify(expected)])
        : await this.write(`UPDATE "${physical}" SET value = $3 WHERE key = $1 AND value::jsonb = $2::jsonb RETURNING key`,
          [key, JSON.stringify(expected), JSON.stringify(next)])
      return result.rows.length === 1
    })
  }

  /** Atomically move an unchanged record to an unused key and replace its source with a marker. */
  moveRecordIfUnchanged(table: string, sourceKey: string, targetKey: string, expected: unknown, sourceNext: unknown, targetNext: unknown): Promise<boolean> {
    return this.settle(async () => {
      this.ensureOpen()
      if (sourceKey === targetKey || expected === undefined || sourceNext === undefined || targetNext === undefined) {
        throw new Error('record move requires distinct keys and defined values')
      }
      const physical = this.physicalFor(table)
      const result = await this.write(`WITH original AS MATERIALIZED (
          SELECT key FROM "${physical}" WHERE key=$1 AND value::jsonb=$2::jsonb FOR UPDATE
        ), inserted AS (
          INSERT INTO "${physical}" (key,value) SELECT $3,$4 FROM original
          ON CONFLICT (key) DO NOTHING RETURNING key
        ) UPDATE "${physical}" SET value=$5 WHERE key=$1 AND EXISTS (SELECT 1 FROM inserted) RETURNING key`,
      [sourceKey, JSON.stringify(expected), targetKey, JSON.stringify(targetNext), JSON.stringify(sourceNext)])
      return result.rows.length === 1
    })
  }

  /** Optional point-read extension; avoids loading every tenant's records for one key. */
  getRecord(table: string, key: string): Promise<unknown> {
    return this.settle(async () => {
      this.ensureOpen()
      const { rows } = await this.pool.query(`SELECT value FROM "${this.physicalFor(table)}" WHERE key = $1`, [key])
      return rows.length === 0 ? undefined : this.parseValue(rows[0].value as string, `table '${table}' key '${key}'`)
    })
  }

  deleteRecord(table: string, key: string): Promise<void> {
    return this.settle(async () => {
      this.ensureOpen()
      await this.write(`DELETE FROM "${this.physicalFor(table)}" WHERE key = $1`, [key])
    })
  }

  deleteRecords(table: string, keys: readonly string[]): Promise<void> {
    return this.settle(async () => {
      this.ensureOpen()
      const physical = this.physicalFor(table)
      if (keys.length === 0) return
      // A single statement makes the whole batch atomic, including duplicates
      // and absent keys. Keep caller-supplied keys out of the SQL text.
      await this.write(`DELETE FROM "${physical}" WHERE key = ANY($1::text[])`, [[...keys]])
    })
  }

  setGlobal(value: unknown): Promise<void> {
    return this.settle(async () => {
      this.ensureOpen()
      if (this.globalStatement === undefined) {
        throw new Error(`kv unit '${this.descriptor.name}' declared no global slot`)
      }
      await this.write(this.globalStatement, [this.descriptor.name, JSON.stringify(value)])
    })
  }

  /** Data and version stamp commit together; the row lock also fences older replicas after upgrade. */
  private async write(statement: string, values: unknown[]): Promise<pg.QueryResult> {
    const client = await this.pool.connect()
    let discard = false
    try {
      await client.query('BEGIN')
      // Current-version writers share the lock; only first-write upgrades need exclusivity.
      const lock = this.needsVersionStamp ? 'UPDATE' : 'SHARE'
      const { rows } = await client.query(`SELECT version FROM units WHERE name = $1 FOR ${lock}`, [this.descriptor.name])
      const version = rows[0]?.version as number | undefined
      if (version !== this.descriptor.version && (version === undefined || !this.descriptor.compatibleVersions?.includes(version))) {
        throw new StorageError('version-mismatch', `kv unit '${this.descriptor.name}' changed to incompatible version ${String(version)}`)
      }
      const result = await client.query(statement, values)
      if ((result.rowCount ?? 0) > 0 && version !== this.descriptor.version) {
        await client.query('UPDATE units SET version = $2 WHERE name = $1', [this.descriptor.name, this.descriptor.version])
      }
      await client.query('COMMIT')
      if ((result.rowCount ?? 0) > 0) this.needsVersionStamp = false
      return result
    } catch (error) {
      try { await client.query('ROLLBACK') } catch (rollbackError) {
        discard = true
        throw new StorageError('unknown-state', 'PG write and rollback failed; the connection was discarded', {
          cause: new AggregateError([error, rollbackError], 'write and rollback failed'),
        })
      }
      throw error
    } finally {
      client.release(discard)
    }
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

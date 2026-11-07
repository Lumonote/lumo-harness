import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PgKvUnit } from '../src/unit.ts'

function fixture() {
  const query = vi.fn(async (sql: string, _values?: unknown[]) => ({
    rows: sql.startsWith('SELECT version') ? [{ version: 1 }] : [], rowCount: sql.startsWith('DELETE') ? 1 : 0,
  }))
  const release = vi.fn()
  const connect = vi.fn(async () => ({ query, release }))
  const unit = new PgKvUnit({ query, connect } as unknown as pg.Pool, {
    name: 'batch', version: 1, tables: ['records'], hasGlobal: false,
  }, () => {})
  return { query, unit, release }
}

describe('PG batch deletion', () => {
  it('deletes the batch atomically with keys passed as one array parameter', async () => {
    const { query, unit } = fixture()
    const keys = ['duplicate', 'duplicate', "quote'; --", 'missing']
    await unit.deleteRecords('records', keys)
    expect(query).toHaveBeenCalledWith(
      'DELETE FROM "u_batch_records" WHERE key = ANY($1::text[])', [keys],
    )
    expect(keys).toHaveLength(4)
    expect(query.mock.calls[0]).toEqual(['BEGIN'])
    expect(query.mock.calls.at(-1)).toEqual(['COMMIT'])
  })

  it('makes an empty batch a no-op while validating the unit and table', async () => {
    const { query, unit } = fixture()
    await unit.deleteRecords('records', [])
    expect(query).not.toHaveBeenCalled()
    await expect(unit.deleteRecords('unknown', [])).rejects.toThrow(/declared no table/)
    await unit.close()
    await expect(unit.deleteRecords('records', [])).rejects.toMatchObject({ code: 'closed' })
  })

  it('rejects a failed statement without starting additional writes', async () => {
    const { query, unit } = fixture()
    query.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(unit.deleteRecords('records', ['a', 'b'])).rejects.toThrow('database unavailable')
    expect(query.mock.calls.map(call => call[0])).toEqual(['BEGIN', 'ROLLBACK'])
  })

  it('discards a connection whose rollback failed', async () => {
    const { query, unit, release } = fixture()
    query.mockRejectedValueOnce(new Error('write failed')).mockRejectedValueOnce(new Error('rollback failed'))
    await expect(unit.deleteRecords('records', ['a'])).rejects.toMatchObject({ code: 'unknown-state' })
    expect(release).toHaveBeenCalledWith(true)
  })
})

import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { PgKvUnit } from '../src/unit.ts'

function fixture() {
  const query = vi.fn(async () => ({ rows: [] }))
  const unit = new PgKvUnit({ query } as unknown as pg.Pool, {
    name: 'batch', version: 1, tables: ['records'], hasGlobal: false,
  }, () => {})
  return { query, unit }
}

describe('PG batch deletion', () => {
  it('deletes the batch atomically with keys passed as one array parameter', async () => {
    const { query, unit } = fixture()
    const keys = ['duplicate', 'duplicate', "quote'; --", 'missing']
    await unit.deleteRecords('records', keys)
    expect(query).toHaveBeenCalledExactlyOnceWith(
      'DELETE FROM "u_batch_records" WHERE key = ANY($1::text[])', [keys],
    )
    expect(keys).toHaveLength(4)
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
    expect(query).toHaveBeenCalledTimes(1)
  })
})

import type pg from 'pg'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ensureSchema } from '../src/schema.ts'
import { PgStorageBackend } from '../src/index.ts'

const fixture = vi.hoisted(() => ({
  connect: vi.fn(), end: vi.fn(async () => {}),
}))
vi.mock('pg', () => ({ default: { Pool: class {
  connect = fixture.connect
  end = fixture.end
} } }))

beforeEach(() => vi.clearAllMocks())

function brokenClient() {
  const query = vi.fn(async (sql: string) => {
    if (sql === 'BEGIN') throw new Error('begin failed')
    if (sql === 'ROLLBACK') throw new Error('rollback failed')
    return { rows: [] }
  })
  return { query, release: vi.fn() }
}

describe('PG initialization connection recovery', () => {
  it('discards schema initialization connections when rollback fails', async () => {
    const client = brokenClient()
    await expect(ensureSchema({ connect: async () => client } as unknown as pg.Pool))
      .rejects.toMatchObject({ code: 'unknown-state' })
    expect(client.release).toHaveBeenCalledExactlyOnceWith(true)
  })

  it('discards failed unit initialization connections and still closes the pool', async () => {
    const schemaClient = { query: vi.fn(async () => ({ rows: [] })), release: vi.fn() }
    const unitClient = brokenClient()
    fixture.connect.mockResolvedValueOnce(schemaClient).mockResolvedValueOnce(unitClient)
    const backend = new PgStorageBackend('unused')
    try {
      await expect(backend.kv.open({ name: 'fixture', version: 1, tables: ['records'], hasGlobal: false }))
        .rejects.toMatchObject({ code: 'unknown-state' })
      expect(schemaClient.release).toHaveBeenCalledExactlyOnceWith(false)
      expect(unitClient.release).toHaveBeenCalledExactlyOnceWith(true)
    } finally {
      await backend.close()
    }
    expect(fixture.end).toHaveBeenCalledOnce()
  })
})

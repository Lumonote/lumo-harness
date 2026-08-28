import { describe, expect, it, vi } from 'vitest'

import type { GraphSeam } from '../../../shared/seam-contracts/graph.ts'
import {
  GraphProjector,
  collectProjection,
  expandUpsert,
  type DocProjection,
} from '../src/graph-projector.ts'

interface OutboxRow {
  seq: string
  doc_id: string
  realm: string
  op: string
  payload: DocProjection
}

interface FakeClient {
  query: ReturnType<typeof vi.fn>
  release: ReturnType<typeof vi.fn>
}

function projection(overrides: Partial<DocProjection> = {}): DocProjection {
  return {
    title: '经营报告',
    space: 'finance',
    sourceVersion: 3,
    references: [],
    entities: [],
    derivedFrom: [],
    ...overrides,
  }
}

function graphSeam(): GraphSeam {
  return {
    upsertNodes: vi.fn(async () => undefined),
    upsertEdges: vi.fn(async () => undefined),
    neighborhood: vi.fn(async () => ({
      origin: '',
      nodes: [],
      edges: [],
      depth: 0,
      truncated: false,
    })),
    removeNode: vi.fn(async () => undefined),
  }
}

function installPool(projector: GraphProjector, client: FakeClient): ReturnType<typeof vi.fn> {
  const end = vi.fn(async () => undefined)
  ;(projector as unknown as {
    pool: { connect(): Promise<FakeClient>; end(): Promise<void> }
  }).pool = {
    connect: async () => client,
    end,
  }
  return end
}

function transactionClient(rows: OutboxRow[]): FakeClient {
  return {
    query: vi.fn(async (sql: string) => ({
      rows: sql.includes('SELECT seq, doc_id, realm, op, payload') ? rows : [],
    })),
    release: vi.fn(),
  }
}

describe('knowledge graph projector', () => {
  it('collects trimmed unique projection metadata and ignores invalid values', () => {
    expect(collectProjection(
      { title: '经营报告', space: 'finance', sourceVersion: 3 },
      [
        { metadata: {
          references: [' doc-2 ', 'doc-2', 7],
          entities: ' 客户 ',
          derivedFrom: null,
        } },
        { metadata: {
          references: 'doc-3',
          entities: ['', '产品', false],
          derivedFrom: ['sales_fact', ' sales_fact '],
        } },
      ],
    )).toEqual({
      title: '经营报告',
      space: 'finance',
      sourceVersion: 3,
      references: ['doc-2', 'doc-3'],
      entities: ['客户', '产品'],
      derivedFrom: ['sales_fact'],
    })
  })

  it('expands documents, entities, datasets and relationship edges within one realm', () => {
    expect(expandUpsert('doc-1', 'realm-a', projection({
      references: ['doc-2'],
      entities: ['客户'],
      derivedFrom: ['sales_fact'],
    }))).toEqual({
      nodes: [
        {
          id: 'doc-1',
          kind: 'document',
          realm: 'realm-a',
          label: '经营报告',
          properties: { space: 'finance', sourceVersion: 3 },
        },
        { id: 'sales_fact', kind: 'dataset', realm: 'realm-a', label: 'sales_fact' },
        { id: 'entity:客户', kind: 'entity', realm: 'realm-a', label: '客户' },
      ],
      edges: [
        { from: 'doc-1', to: 'doc-2', kind: 'references', realm: 'realm-a' },
        { from: 'doc-1', to: 'sales_fact', kind: 'derived_from', realm: 'realm-a' },
        { from: 'doc-1', to: 'entity:客户', kind: 'mentions', realm: 'realm-a' },
      ],
    })

    expect(expandUpsert('doc-without-title', 'realm-a', projection({ title: '' })).nodes[0]?.label)
      .toBe('doc-without-title')
  })

  it('projects rows in order and marks the batch only after graph writes succeed', async () => {
    const rows: OutboxRow[] = [
      { seq: '41', doc_id: 'doc-1', realm: 'realm-a', op: 'remove', payload: projection() },
      {
        seq: '42',
        doc_id: 'doc-1',
        realm: 'realm-a',
        op: 'upsert',
        payload: projection({ entities: ['客户'] }),
      },
    ]
    const client = transactionClient(rows)
    const graph = graphSeam()
    const projector = new GraphProjector({ connectionString: 'postgres://unused', batchSize: 2 }, graph)
    const end = installPool(projector, client)

    await expect(projector.drain()).resolves.toBe(2)

    expect(client.query.mock.calls.map(([sql]) => String(sql).trim().split(/\s+/)[0])).toEqual([
      'BEGIN',
      'SELECT',
      'UPDATE',
      'COMMIT',
    ])
    expect(client.query.mock.calls[1]?.[1]).toEqual([2])
    expect(client.query.mock.calls[2]?.[1]).toEqual([['41', '42']])
    expect(graph.removeNode).toHaveBeenCalledWith('doc-1', 'realm-a')
    expect(graph.upsertNodes).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ id: 'doc-1', realm: 'realm-a' }),
      expect.objectContaining({ id: 'entity:客户', realm: 'realm-a' }),
    ]))
    expect(client.release).toHaveBeenCalledOnce()

    await projector.close()
    expect(end).toHaveBeenCalledOnce()
  })

  it('rolls back failures, releases the client and admits the next drain', async () => {
    const rows: OutboxRow[] = [{
      seq: '9',
      doc_id: 'doc-9',
      realm: 'realm-a',
      op: 'upsert',
      payload: projection(),
    }]
    const client = transactionClient(rows)
    const graph = graphSeam()
    const upsertNodes = vi.mocked(graph.upsertNodes)
    upsertNodes.mockRejectedValueOnce(new Error('graph unavailable'))
    const projector = new GraphProjector({ connectionString: 'postgres://unused' }, graph)
    installPool(projector, client)

    await expect(projector.drain()).rejects.toThrow('graph unavailable')
    expect(client.query.mock.calls.map(([sql]) => String(sql).trim())).toContain('ROLLBACK')
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('UPDATE knowledge_graph_outbox'))).toBe(false)
    expect(client.release).toHaveBeenCalledOnce()

    await expect(projector.drain()).resolves.toBe(1)
    expect(client.release).toHaveBeenCalledTimes(2)
  })
})

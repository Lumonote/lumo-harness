/**
 * GraphSeam 的 PostgreSQL 实现（Local-lite 形态）。
 *
 * 形态说明（铁律 21）：Local-lite 允许轻量替代（不承诺迁移）。
 * Standalone+ 用 Nebula Provider 实现同一契约；组件只声明 consumes，不感知引擎。
 *
 * 遍历用递归 CTE + 深度/节点数双上限：LLM 生成的图查询不得失控（§5.3.4）。
 */
import pg from 'pg'
import type {
  GraphEdge,
  GraphNode,
  GraphSeam,
  Neighborhood,
  NeighborhoodQuery,
} from '../../../shared/seam-contracts/graph.ts'
import { forbidden } from '../../../shared/seam-contracts/errors.ts'

export const GRAPH_DDL = `
CREATE TABLE IF NOT EXISTS graph_nodes (
  id         TEXT NOT NULL,
  realm      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  label      TEXT NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, realm)
);

CREATE INDEX IF NOT EXISTS idx_graph_nodes_realm_kind ON graph_nodes (realm, kind);

CREATE TABLE IF NOT EXISTS graph_edges (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL,
  realm      TEXT NOT NULL,
  properties JSONB NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (from_id, to_id, kind, realm)
);

CREATE INDEX IF NOT EXISTS idx_graph_edges_from ON graph_edges (realm, from_id);
CREATE INDEX IF NOT EXISTS idx_graph_edges_to ON graph_edges (realm, to_id);
`

/** 遍历深度硬上限：超过 3 跳收益急剧下降而代价失控 */
const MAX_DEPTH = 3

export interface PgGraphConfig {
  connectionString: string
  /** 允许图检索的角色（OPA 下沉；不在名单内 → 拒绝） */
  allowedRoles: string[]
}

export class PgGraphProvider implements GraphSeam {
  private pool: pg.Pool
  private readonly allowedRoles: ReadonlySet<string>

  constructor(config: PgGraphConfig) {
    this.pool = new pg.Pool({ connectionString: config.connectionString })
    this.allowedRoles = new Set(config.allowedRoles)
  }

  async init(): Promise<void> {
    await this.pool.query(GRAPH_DDL)
  }

  async upsertNodes(nodes: GraphNode[]): Promise<void> {
    if (nodes.length === 0) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const n of nodes) {
        await client.query(
          `INSERT INTO graph_nodes (id, realm, kind, label, properties, updated_at)
           VALUES ($1,$2,$3,$4,$5, now())
           ON CONFLICT (id, realm) DO UPDATE SET
             kind = EXCLUDED.kind, label = EXCLUDED.label,
             properties = EXCLUDED.properties, updated_at = now()`,
          [n.id, n.realm, n.kind, n.label, JSON.stringify(n.properties ?? {})],
        )
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async upsertEdges(edges: GraphEdge[]): Promise<void> {
    if (edges.length === 0) return
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const e of edges) {
        await client.query(
          `INSERT INTO graph_edges (from_id, to_id, kind, realm, properties)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (from_id, to_id, kind, realm) DO UPDATE SET
             properties = EXCLUDED.properties`,
          [e.from, e.to, e.kind, e.realm, JSON.stringify(e.properties ?? {})],
        )
      }
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }

  async neighborhood(query: NeighborhoodQuery): Promise<Neighborhood> {
    // 角色越权 → 显式拒绝（不静默返回空）
    if (!query.roles.some((r) => this.allowedRoles.has(r))) {
      throw forbidden(`PgGraphProvider: 角色 ${query.roles.join(',')} 无图检索权限`)
    }
    const depth = Math.min(Math.max(query.depth, 1), MAX_DEPTH)
    const maxNodes = Math.max(query.maxNodes, 1)
    const edgeKinds = query.edgeKinds ?? []

    // 递归 CTE：realm 在每一层强制过滤（realm 由 Provider 注入，非 Consumer 传参）
    // 多取 1 条用于判断是否截断 —— 截断必须显式标记，不静默丢弃
    const rows = await this.pool.query<{
      id: string; realm: string; kind: string; label: string
      properties: Record<string, string | number | boolean>; hop: number
    }>(
      `WITH RECURSIVE reachable(id, hop) AS (
         SELECT unnest($1::text[]) AS id, 0 AS hop
         UNION
         SELECT e.to_id, r.hop + 1
         FROM reachable r
         JOIN graph_edges e ON e.from_id = r.id AND e.realm = $2
         WHERE r.hop < $3
           AND ($4::text[] = '{}' OR e.kind = ANY($4::text[]))
       )
       SELECT n.id, n.realm, n.kind, n.label, n.properties, MIN(r.hop) AS hop
       FROM reachable r
       JOIN graph_nodes n ON n.id = r.id AND n.realm = $2
       GROUP BY n.id, n.realm, n.kind, n.label, n.properties
       ORDER BY hop, n.id
       LIMIT $5`,
      [query.origins, query.realm, depth, edgeKinds, maxNodes + 1],
    )

    const truncated = rows.rows.length > maxNodes
    const kept = truncated ? rows.rows.slice(0, maxNodes) : rows.rows
    const keptIds = kept.map((r) => r.id)

    const edges = keptIds.length === 0 ? { rows: [] as Array<{
      from_id: string; to_id: string; kind: string; realm: string
      properties: Record<string, string | number | boolean>
    }> } : await this.pool.query<{
      from_id: string; to_id: string; kind: string; realm: string
      properties: Record<string, string | number | boolean>
    }>(
      `SELECT from_id, to_id, kind, realm, properties FROM graph_edges
       WHERE realm = $1 AND from_id = ANY($2::text[]) AND to_id = ANY($2::text[])
         AND ($3::text[] = '{}' OR kind = ANY($3::text[]))`,
      [query.realm, keptIds, edgeKinds],
    )

    return {
      origin: query.origins[0] ?? '',
      nodes: kept.map((r) => ({
        id: r.id, kind: r.kind, realm: r.realm, label: r.label, properties: r.properties,
      })),
      edges: edges.rows.map((e) => ({
        from: e.from_id, to: e.to_id, kind: e.kind, realm: e.realm, properties: e.properties,
      })),
      depth: kept.reduce((m, r) => Math.max(m, Number(r.hop)), 0),
      truncated,
    }
  }

  async removeNode(id: string, realm: string): Promise<void> {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(
        'DELETE FROM graph_edges WHERE realm = $1 AND (from_id = $2 OR to_id = $2)',
        [realm, id],
      )
      await client.query('DELETE FROM graph_nodes WHERE id = $1 AND realm = $2', [id, realm])
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

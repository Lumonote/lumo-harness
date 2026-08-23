/**
 * 知识库 → 知识图谱的 **outbox 投影**（graph.ts 契约头部规定的写入模式）。
 *
 * 为什么是 outbox 而不是双写：向量索引与图分属两套存储（Local-lite 同库、
 * Standalone+ 分别是 pgvector/Milvus 与 Nebula），**跨存储无事务保证**。
 * 因此 ingest 只在自己的事务里写「投影意图」到 PG outbox（与 chunk 写入原子），
 * 再由本投影器异步搬运到 GraphSeam —— 最终一致 + 幂等重放，而非分布式事务。
 *
 * 投影器只依赖 GraphSeam 接口，不感知底层是 PG 递归 CTE 还是 Nebula（铁律 21）。
 */
import pg from 'pg'
import type { GraphEdge, GraphNode, GraphSeam } from '../../../shared/seam-contracts/graph.ts'

export const OUTBOX_DDL = `
CREATE TABLE IF NOT EXISTS knowledge_graph_outbox (
  seq          BIGSERIAL PRIMARY KEY,
  doc_id       TEXT NOT NULL,
  realm        TEXT NOT NULL,
  op           TEXT NOT NULL,                    -- upsert | remove
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  projected_at TIMESTAMPTZ
);

-- 部分索引：只扫未投影的尾巴，已投影历史不拖慢轮询
CREATE INDEX IF NOT EXISTS idx_knowledge_outbox_pending
  ON knowledge_graph_outbox (seq) WHERE projected_at IS NULL;
`

/**
 * 文档投影载荷：由 ingest 从 chunk.metadata 归集。
 * 这是「知识库 → 图」的关系抽取契约 —— 上游写入方按此填 metadata 即可获得图关系，
 * 不需要理解图引擎。
 */
export interface DocProjection {
  title: string
  space: string
  sourceVersion: number
  /** 引用的其它文档 docId → references 边 */
  references: string[]
  /** 提及的实体名 → entity 节点 + mentions 边 */
  entities: string[]
  /** 派生自的数据集/上游资产 id → derived_from 边（血缘） */
  derivedFrom: string[]
}

/** 从 chunk metadata 归集投影载荷；非法/缺省字段一律降级为空数组，不抛错阻断 ingest */
export function collectProjection(
  doc: { title: string; space: string; sourceVersion: number },
  chunks: Array<{ metadata: Record<string, unknown> }>,
): DocProjection {
  const bag = { references: new Set<string>(), entities: new Set<string>(), derivedFrom: new Set<string>() }
  const take = (raw: unknown, into: Set<string>) => {
    if (typeof raw === 'string') { if (raw.trim()) into.add(raw.trim()); return }
    if (!Array.isArray(raw)) return
    for (const v of raw) if (typeof v === 'string' && v.trim()) into.add(v.trim())
  }
  for (const chunk of chunks) {
    take(chunk.metadata?.references, bag.references)
    take(chunk.metadata?.entities, bag.entities)
    take(chunk.metadata?.derivedFrom, bag.derivedFrom)
  }
  return {
    title: doc.title,
    space: doc.space,
    sourceVersion: doc.sourceVersion,
    references: [...bag.references],
    entities: [...bag.entities],
    derivedFrom: [...bag.derivedFrom],
  }
}

/** 实体名 → 稳定节点 id（同名实体在同 realm 内合一，这是图消歧的最小实现） */
export function entityNodeId(name: string): string {
  return `entity:${name}`
}

/** 把一条 outbox 记录展开成图写入（纯函数，便于契约测试与换引擎复用） */
export function expandUpsert(
  docId: string,
  realm: string,
  p: DocProjection,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = [{
    id: docId,
    kind: 'document',
    realm,
    label: p.title || docId,
    properties: { space: p.space, sourceVersion: p.sourceVersion },
  }]
  const edges: GraphEdge[] = []

  for (const target of p.references) edges.push({ from: docId, to: target, kind: 'references', realm })
  for (const dataset of p.derivedFrom) {
    nodes.push({ id: dataset, kind: 'dataset', realm, label: dataset })
    edges.push({ from: docId, to: dataset, kind: 'derived_from', realm })
  }
  for (const name of p.entities) {
    nodes.push({ id: entityNodeId(name), kind: 'entity', realm, label: name })
    edges.push({ from: docId, to: entityNodeId(name), kind: 'mentions', realm })
  }
  // 注意：references 的目标文档节点不在此创建 —— 目标文档自身 ingest 时才有权威 title。
  // 边先落、节点后到是可接受的（邻域查询按 JOIN graph_nodes 过滤，悬空边不会返回幻影节点）。
  return { nodes, edges }
}

export interface ProjectorConfig {
  connectionString: string
  /** 单轮搬运条数上限（防止一次投影阻塞过久） */
  batchSize?: number
}

export class GraphProjector {
  private pool: pg.Pool
  private readonly graph: GraphSeam
  private readonly batchSize: number
  private running = false

  constructor(config: ProjectorConfig, graph: GraphSeam) {
    this.pool = new pg.Pool({ connectionString: config.connectionString })
    this.graph = graph
    this.batchSize = Math.max(config.batchSize ?? 100, 1)
  }

  // 注意：outbox 建表归 KnowledgeSeam 的 DDL（它是写入方，OUTBOX_DDL 由 pg-provider 拼进去）。
  // 投影器不重复建表 —— 并发 CREATE TABLE IF NOT EXISTS 在 PG 上会撞 pg_type 唯一键。

  /**
   * 搬运一批未投影记录，返回实际投影条数。
   *
   * `FOR UPDATE SKIP LOCKED`：多个节点实例并发投影时互不阻塞也不重复搬运。
   * 投影动作本身幂等（upsertNodes/upsertEdges 是 last-wins，removeNode 是删除），
   * 因此「投影成功但标记失败」的崩溃窗口只会导致重放，不会导致图数据错误。
   */
  async drain(): Promise<number> {
    if (this.running) return 0        // 单实例内不并发重入（定时器压车）
    this.running = true
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const pending = await client.query<{
        seq: string; doc_id: string; realm: string; op: string; payload: DocProjection
      }>(
        `SELECT seq, doc_id, realm, op, payload FROM knowledge_graph_outbox
         WHERE projected_at IS NULL
         ORDER BY seq
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      )
      if (pending.rows.length === 0) {
        await client.query('COMMIT')
        return 0
      }

      // 同 doc 的多条记录按 seq 顺序执行 —— remove 之后的 upsert 必须真的重新建节点
      for (const row of pending.rows) {
        if (row.op === 'remove') {
          await this.graph.removeNode(row.doc_id, row.realm)
          continue
        }
        const { nodes, edges } = expandUpsert(row.doc_id, row.realm, row.payload)
        await this.graph.upsertNodes(nodes)
        await this.graph.upsertEdges(edges)
      }

      await client.query(
        'UPDATE knowledge_graph_outbox SET projected_at = now() WHERE seq = ANY($1::bigint[])',
        [pending.rows.map((r) => r.seq)],
      )
      await client.query('COMMIT')
      return pending.rows.length
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    } finally {
      client.release()
      this.running = false
    }
  }

  async close(): Promise<void> {
    await this.pool.end()
  }
}

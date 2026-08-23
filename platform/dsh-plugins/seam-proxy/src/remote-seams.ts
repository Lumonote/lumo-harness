/**
 * 远程 seam 适配器：实现与本地 Provider **完全相同**的 TS 接口。
 *
 * 这就是 §4.1「Consumer 代码零改动」的落点 —— Consumer 拿到的是
 * `KnowledgeSeam` / `GraphSeam`，它无从判断背后是本地 pgvector 还是三跳外的节点。
 * 因此这里禁止出现任何「远程专有」的方法或参数：一旦泄漏，抽象就破了。
 */
import type {
  KnowledgeHit,
  KnowledgeIngest,
  KnowledgeQuery,
  KnowledgeSeam,
} from '../../../shared/seam-contracts/knowledge.ts'
import type {
  GraphEdge,
  GraphNode,
  GraphSeam,
  Neighborhood,
  NeighborhoodQuery,
} from '../../../shared/seam-contracts/graph.ts'
import type { SeamProxyClient } from './client.ts'

export function createRemoteKnowledge(client: SeamProxyClient): KnowledgeSeam {
  return {
    ingest(entry: KnowledgeIngest): Promise<void> {
      return client.call('knowledge', 'ingest', [entry]) as Promise<void>
    },
    query(request: KnowledgeQuery): Promise<KnowledgeHit[]> {
      return client.call('knowledge', 'query', [request]) as Promise<KnowledgeHit[]>
    },
    remove(docId: string, realm: string): Promise<void> {
      return client.call('knowledge', 'remove', [docId, realm]) as Promise<void>
    },
    rebuild(realm: string): Promise<void> {
      return client.call('knowledge', 'rebuild', [realm]) as Promise<void>
    },
  }
}

export function createRemoteGraph(client: SeamProxyClient): GraphSeam {
  return {
    upsertNodes(nodes: GraphNode[]): Promise<void> {
      return client.call('knowledgeGraph', 'upsertNodes', [nodes]) as Promise<void>
    },
    upsertEdges(edges: GraphEdge[]): Promise<void> {
      return client.call('knowledgeGraph', 'upsertEdges', [edges]) as Promise<void>
    },
    neighborhood(query: NeighborhoodQuery): Promise<Neighborhood> {
      return client.call('knowledgeGraph', 'neighborhood', [query]) as Promise<Neighborhood>
    },
    removeNode(id: string, realm: string): Promise<void> {
      return client.call('knowledgeGraph', 'removeNode', [id, realm]) as Promise<void>
    },
  }
}

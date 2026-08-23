/**
 * 知识图谱 seam 契约（§5.4.5 GraphRAG 的图侧）。
 *
 * 与向量 seam（knowledge.ts）并列：向量做语义召回，图做关系扩展与消歧；
 * 二者由 Consumer 编排（向量召回候选 → 图邻域扩展 → 组装上下文）。
 *
 * 一致性（§5.1 修订）：Nebula **分区内线性一致，跨分区无事务保证**。
 * 任何需与数据写入原子的血缘写入，采用 outbox 模式（意图先写 PG，异步投影到图）。
 */

/** 实体节点：知识库文档、业务对象、数据资产的统一抽象 */
export interface GraphNode {
  /** 全局唯一标识（doc_id / 业务主键 / 数据集名） */
  id: string
  /** 节点类型：document / entity / dataset / agent / component */
  kind: string
  realm: string
  /** 展示名 */
  label: string
  properties?: Record<string, string | number | boolean>
}

/** 有向边：关系与血缘 */
export interface GraphEdge {
  from: string
  to: string
  /** 关系类型：references / derived_from / owns / mentions / produced_by */
  kind: string
  realm: string
  properties?: Record<string, string | number | boolean>
}

/** 邻域扩展结果（GraphRAG 的图侧输出） */
export interface Neighborhood {
  origin: string
  nodes: GraphNode[]
  edges: GraphEdge[]
  /** 实际遍历深度（可能因 maxNodes 截断而小于请求深度） */
  depth: number
  /** 是否因上限截断 —— 截断必须显式告知，不静默丢弃 */
  truncated: boolean
}

export interface NeighborhoodQuery {
  realm: string
  roles: string[]
  /** 起点节点 id（通常来自向量召回的 docId） */
  origins: string[]
  /** 遍历深度（1–3；超过 3 跳的收益急剧下降且代价失控） */
  depth: number
  /** 关系类型过滤；空 = 全部 */
  edgeKinds?: string[]
  /** 结果节点上限（防失控遍历，与 §5.3.4 查询安全同源） */
  maxNodes: number
}

export interface GraphSeam {
  /** 幂等写入节点（属性 last-wins） */
  upsertNodes(nodes: GraphNode[]): Promise<void>
  /** 幂等写入边 */
  upsertEdges(edges: GraphEdge[]): Promise<void>
  /**
   * 邻域扩展：realm 过滤由 Provider 强制注入（同 §5.4.1 向量侧硬规矩）；
   * 角色越权直接拒绝，不静默返回空。
   */
  neighborhood(query: NeighborhoodQuery): Promise<Neighborhood>
  /** 删除节点及其关联边（源删除的图侧同步 —— 与向量 tombstone 对齐） */
  removeNode(id: string, realm: string): Promise<void>
}

/**
 * 契约断言：任何真实 Provider（Nebula / PG 递归 CTE）都必须通过。
 */
export async function assertGraphContract(
  seam: GraphSeam,
  assert: (cond: boolean, msg: string) => void,
) {
  const realm = 'realm-a'
  await seam.upsertNodes([
    { id: 'doc-1', kind: 'document', realm, label: '经营分析报告' },
    { id: 'doc-2', kind: 'document', realm, label: '销售数据字典' },
    { id: 'ds-1', kind: 'dataset', realm, label: 'sales_fact' },
    { id: 'doc-x', kind: 'document', realm: 'realm-b', label: '他租户文档' },
  ])
  await seam.upsertEdges([
    { from: 'doc-1', to: 'doc-2', kind: 'references', realm },
    { from: 'doc-2', to: 'ds-1', kind: 'derived_from', realm },
  ])

  // 1 跳：只到直接邻居
  const one = await seam.neighborhood({
    realm, roles: ['viewer'], origins: ['doc-1'], depth: 1, maxNodes: 50,
  })
  assert(one.nodes.some((n) => n.id === 'doc-2'), '1 跳必须包含直接邻居')
  assert(!one.nodes.some((n) => n.id === 'ds-1'), '1 跳不得包含 2 跳节点')

  // 2 跳：传递可达
  const two = await seam.neighborhood({
    realm, roles: ['viewer'], origins: ['doc-1'], depth: 2, maxNodes: 50,
  })
  assert(two.nodes.some((n) => n.id === 'ds-1'), '2 跳必须包含传递可达节点')

  // realm 隔离：不得跨 realm 泄漏
  assert(!two.nodes.some((n) => n.realm !== realm), 'cross-realm 节点必须被过滤')

  // 截断必须显式标记
  const capped = await seam.neighborhood({
    realm, roles: ['viewer'], origins: ['doc-1'], depth: 2, maxNodes: 1,
  })
  assert(capped.truncated, '超出 maxNodes 必须标记 truncated')

  // 删除同步
  await seam.removeNode('doc-2', realm)
  const after = await seam.neighborhood({
    realm, roles: ['viewer'], origins: ['doc-1'], depth: 2, maxNodes: 50,
  })
  assert(!after.nodes.some((n) => n.id === 'doc-2'), '删除后不得再出现在邻域')
}

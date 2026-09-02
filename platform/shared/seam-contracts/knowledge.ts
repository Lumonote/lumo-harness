/**
 * 知识库 seam 契约（接口 + 行为断言）。
 * 任何 Provider（Local-lite 的 pgvector、Standalone/Cluster 的 Milvus+Nebula）
 * 与 Consumer 都经由本契约接口交互；契约测试必须在该 Provider 上双向通过
 * （architecture §13.2.4 —— 这是允许 Local-lite 换引擎的唯一依据）。
 */

/** 文档元数据（权威在 PG/MinIO；向量索引只存派生投影） */
export interface KnowledgeDoc {
  docId: string
  realm: string
  space: string
  title: string
  /** 发布/源写入时的内容版本，用于向量–源一致校验（§5.4.3） */
  sourceVersion: number
  /** 向量嵌入所用模型标识——换模型即向量空间失效（§5.4.4） */
  embeddingModel: string
}

export interface KnowledgeIngest {
  doc: KnowledgeDoc
  chunks: Array<{ text: string; metadata: Record<string, unknown> }>
}

export interface KnowledgeQuery {
  realm: string
  /** 检索者角色（Provider 层据此注入强制过滤，不接受上游传参的 realm） */
  roles: string[]
  text: string
  topK: number
  scope: 'published' | 'draft'
}

export interface KnowledgeHit {
  docId: string
  sourceVersion: number
  score: number
  text: string
}

/**
 * 管理面展示的源文档摘要。它不是 KnowledgeSeam 的一部分：检索/写入
 * consumer 仍只能看到四个 seam 操作，来源管理必须经由受身份保护的宿主 API。
 */
export interface KnowledgeSourceSummary {
  docId: string
  realm: string
  space: string
  title: string
  sourceVersion: number
  embeddingModel: string
  chunkCount: number
  updatedAt: string
}

/** 管理面写入的源内容。更新时必须携带此前读取到的版本，避免静默覆盖。 */
export interface KnowledgeSourceWrite {
  docId: string
  realm: string
  space: string
  title: string
  chunks: KnowledgeIngest['chunks']
  /** 新建时省略；更新时必须等于当前 sourceVersion。 */
  expectedSourceVersion?: number
}

/**
 * 可选的来源管理能力。
 *
 * PG provider 同时保存 source-of-truth，因而实现此接口；纯 Milvus 投影
 * provider 不实现。调用方必须在运行时检测，而不能把它扩散进 KnowledgeSeam。
 */
export interface KnowledgeSourceManager {
  listSources(realm: string): Promise<KnowledgeSourceSummary[]>
  getSource(docId: string, realm: string): Promise<KnowledgeIngest | undefined>
  upsertSource(entry: KnowledgeSourceWrite): Promise<KnowledgeSourceSummary>
  removeSource(docId: string, realm: string, expectedSourceVersion: number): Promise<void>
}

export interface KnowledgeSeam {
  ingest(entry: KnowledgeIngest): Promise<void>
  /** realm 过滤由 Provider 强制注入；传入的 realm 与注入不符必须拒绝（§5.4.1） */
  query(request: KnowledgeQuery): Promise<KnowledgeHit[]>
  remove(docId: string, realm: string): Promise<void>
  /** 从源全量重建（一等交付物，§5.4.3） */
  rebuild(realm: string): Promise<void>
}

/**
 * 契约断言：任何真实 Provider 实现都必须通过。
 * 由各 Provider 的契约测试 `seam.contract.spec.ts` 调用。不可修改断言语义。
 */
export async function assertKnowledgeContract(seam: KnowledgeSeam, assert: (cond: boolean, msg: string) => void) {
  await seam.rebuild('realm-a')

  // ingest → query 召回（同模型）
  await seam.ingest({
    doc: { docId: 'd1', realm: 'realm-a', space: 's1', title: 't', sourceVersion: 3, embeddingModel: 'm1' },
    chunks: [{ text: '分布式智能体平台的知识库文档', metadata: {} }],
  })
  const hits = await seam.query({ realm: 'realm-a', roles: ['viewer'], text: '知识库文档', topK: 3, scope: 'published' })
  assert(hits.length >= 1, 'ingest 的文档必须可被 query 召回')
  assert(hits[0]!.docId === 'd1', '召回记录必须带原始 docId')
  assert(hits[0]!.sourceVersion === 3, '召回必须带 source_version（供一致性校验）')

  // realm 隔离：realm-b 检索者不得命中 realm-a 的文档
  const cross = await seam.query({ realm: 'realm-b', roles: ['viewer'], text: '知识库文档', topK: 3, scope: 'published' })
  assert(cross.length === 0, 'cross-realm 检索必须被强制过滤')

  // 删除同步：抽除后不得再召回（§5.4.3 —— 数据泄漏路径）
  await seam.remove('d1', 'realm-a')
  const after = await seam.query({ realm: 'realm-a', roles: ['viewer'], text: '知识库文档', topK: 3, scope: 'published' })
  assert(after.length === 0, 'remove 后不得召回')

  // 源版本不一致必须不返回（宁可少召回不召回陈旧，§5.4.3）
  await seam.ingest({
    doc: { docId: 'd2', realm: 'realm-a', space: 's1', title: 't', sourceVersion: 5, embeddingModel: 'm1' },
    chunks: [{ text: '不一致版本的内容', metadata: {} }],
  })
  const stale = await seam.query({ realm: 'realm-a', roles: ['viewer'], text: '不一致版本', topK: 3, scope: 'published' })
  assert(stale.every((h) => h.sourceVersion >= 5), '不得召回低于当前源版本的投影')
}

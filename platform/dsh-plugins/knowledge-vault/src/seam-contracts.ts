/**
 * 知识库 seam 契约（类型子集，单机 vault 内嵌副本）。
 *
 * 来源：platform/shared/seam-contracts/knowledge.ts（权威定义）。
 * 为什么内嵌：打包进桌面的 @lumo/knowledge-vault 是自包含单包（运行时没有
 * platform/shared 与 @lumo/knowledge），tsdown 的 resolver root 又不允许相对
 * 引用逃出包目录。vault 与集群知识插件永不共存，类型一致由下述注释 + 契约
 * 测试在各自树上分别保障。修改权威定义时请同步本文件（只抄类型，不抄行为断言）。
 */
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

export interface KnowledgeSeam {
  ingest(entry: KnowledgeIngest): Promise<void>
  /** realm 过滤由 Provider 强制注入；传入的 realm 与注入不符必须拒绝（§5.4.1） */
  query(request: KnowledgeQuery): Promise<KnowledgeHit[]>
  remove(docId: string, realm: string): Promise<void>
  /** 从源全量重建（一等交付物，§5.4.3） */
  rebuild(realm: string): Promise<void>
}

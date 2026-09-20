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
  /**
   * 限定只在**这些空间**里检索。省略 = 不按空间收窄（与 `realm` 不同：realm 是安全边界，
   * 空间是组织维度）。
   *
   * # 为什么是「省略即不收窄」而不是「省略即全拒」
   *
   * 这个字段的语义与治理面对 `knowledge_space_ids` 的既有语义**必须一致**：那一侧
   * `knowledge_space_ids.length === 0` 表示「该预设不限制空间」（`assertExecutionPreset`
   * 正是按 length 判的）。两处取不同的默认值，会让「没配空间」的预设在一侧不受限、在另一侧
   * 什么都查不到——而两边看起来都对。
   *
   * **它是收窄，不是授权**：授权在 `realm` + `roles` 上（Provider 强制注入，见 §5.4.1）。
   * 传一个调用方本无权访问的空间名不会因此拿到内容——那一步在 realm 过滤时就已经被挡掉了。
   * 把这条写下来是因为「多了一个过滤字段」很容易被读成「多了一道安全边界」。
   *
   * # 空数组
   *
   * `[]` 与省略**不等价**：省略是「不按空间收窄」，`[]` 是「一个空间都不许」——它必然
   * 召回零条。区分两者是刻意的：把一个「过滤条件算出来是空集」误当成「没有过滤条件」，
   * 会让一次本该返回空的结果变成返回全部。
   */
  spaces?: readonly string[]
}

/**
 * 会话级的知识空间收窄：**按会话**回答「这次执行允许落在哪些空间」。
 *
 * 它住在契约里而不是知识插件内部，是因为**设它的那一方不是知识插件**——受治理执行按预设设、
 * 两个知识工具按会话读，三方跨两个包。让设置方去 import 知识插件的内部模块，等于让它依赖
 * 一个包的内部结构；而这份契约是三方都已经依赖的东西。
 *
 * 语义：**没设过 = 不收窄**（与 `KnowledgeQuery.spaces` 的省略一致），**`[]` = 一个都不许**。
 * 两者必须分开——合并会让一次本该返回零条的检索返回全部。
 */
export interface KnowledgeSessionScope {
  set(sessionRef: string, spaces: readonly string[]): void
  clear(sessionRef: string): void
  spacesFor(sessionRef: string): readonly string[] | undefined
}

/**
 * 知识工具的名字。**跨插件常量**：名字由 `@lumo/knowledge` 注册，而 `@lumo/subagent-host`
 * 在执行前用 `tools.restrict({ allow })` 按它放行。两边各写一份字面量的失败形态是
 * 「白名单里的名字不存在」——而 `restrict` 对不认识的名字**抛错**，所以那会表现为
 * 「受治理执行一开跑就崩」，而不是「少了点东西」。
 *
 * 写成常量而不是让 subagent-host 直接 import 知识插件的内部模块：那是依赖一个包的内部结构，
 * 而这份契约是双方都已经依赖的东西。
 */
export const KNOWLEDGE_TOOL_QUERY = 'knowledge_query'
export const KNOWLEDGE_TOOL_GRAPH = 'knowledge_graph_query'
/** 白名单用的名单。**注册方要引用上面两个单名**，这样名单与真实注册名不可能漂移。 */
export const KNOWLEDGE_TOOL_NAMES: readonly string[] = [KNOWLEDGE_TOOL_QUERY, KNOWLEDGE_TOOL_GRAPH]

/**
 * `KnowledgeQuery.spaces` 的判据，**单点**：省略 = 不按空间收窄，`[]` = 一个都不许。
 *
 * 抽成函数而不是在各 Provider 里各写一遍 `if (spaces?.length)`：那个写法把 `[]` 与省略
 * 合并成同一支（`[].length === 0` 为假），于是「过滤条件算出来是空集」会退化成「没有过滤
 * 条件」——一次本该返回零条的结果变成返回全部，而且没有任何报错。
 */
export function spaceAllowed(space: string, spaces: readonly string[] | undefined): boolean {
  return spaces === undefined ? true : spaces.includes(space)
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

  // —— spaces 收窄（2026-09-19）——
  //
  // 三态各断言一次，因为它们产出三种**不同**的结果：省略 = 不收窄、非空 = 只召回列出的
  // 空间、空数组 = 一个都不许（零条）。最容易写错的是最后一态——`if (spaces?.length)`
  // 把 `[]` 与省略合并成同一支，于是「过滤条件算出来是空集」会退化成「没有过滤条件」：
  // 一次本该返回零条的结果变成返回全部，且没有任何报错。
  //
  // 这条断言是**强制机制**：任何真实 Provider 必须通过同一套契约，所以「新字段加了但某家
  // 没实现」会在它自己的契约测试上红，而不是在很久以后表现为一次跨空间召回。
  await seam.ingest({
    doc: { docId: 'd-space-a', realm: 'realm-a', space: 'space-a', title: 't', sourceVersion: 1, embeddingModel: 'm1' },
    chunks: [{ text: '空间收窄的样例内容', metadata: {} }],
  })
  await seam.ingest({
    doc: { docId: 'd-space-b', realm: 'realm-a', space: 'space-b', title: 't', sourceVersion: 1, embeddingModel: 'm1' },
    chunks: [{ text: '空间收窄的样例内容', metadata: {} }],
  })
  const allSpaces = await seam.query({ realm: 'realm-a', roles: ['viewer'], text: '空间收窄的样例内容', topK: 10, scope: 'published' })
  assert(allSpaces.length === 2, '省略 spaces 不得按空间收窄')

  const onlyA = await seam.query({ realm: 'realm-a', roles: ['viewer'], text: '空间收窄的样例内容', topK: 10, scope: 'published', spaces: ['space-a'] })
  assert(onlyA.length === 1 && onlyA[0]!.docId === 'd-space-a', 'spaces 必须只召回列出的空间')

  const noSpaces = await seam.query({ realm: 'realm-a', roles: ['viewer'], text: '空间收窄的样例内容', topK: 10, scope: 'published', spaces: [] })
  assert(noSpaces.length === 0, 'spaces 为空数组必须召回零条——它不是「不过滤」')
}

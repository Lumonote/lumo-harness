import { describe, expect, it } from 'vitest'

import { PgKnowledgeProvider } from '../src/pg-provider.ts'
import { schemaDsn } from './pg-schema.ts'

/**
 * `KnowledgeQuery.spaces` 在**真实 Provider** 上的收窄（对真 PG）。
 *
 * 为什么不能只靠契约套件：那套断言跑的是一个内存 stub（`shared/seam-contracts/__tests__/
 * knowledge.contract.spec.ts`），它证明的是**契约本身自洽**，不是 PG provider 实现了它。
 * 本文件补的是后者——真正的执法点在这里。
 *
 * 三态各一条，因为空数组那条是最容易写错、也最危险的：`if (spaces?.length)` 把 `[]` 与
 * 省略合并成同一支，于是「过滤条件算出来是空集」退化成「没有过滤条件」——一次本该返回
 * 零条的结果变成返回**全部**，且没有任何报错。
 */
const DSN = process.env['KNOWLEDGE_TEST_DSN'] ?? process.env['LUMO_TEST_PG_DSN']

const DIMENSION = 3
/** 定长假向量：本文件测的是过滤，不是召回质量——所有行等距，命中集合完全由 WHERE 决定。 */
const embedding = {
  dimension: DIMENSION,
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map(() => [0.1, 0.2, 0.3])
  },
}

async function freshProvider(): Promise<{ provider: PgKnowledgeProvider; realm: string; docA: string; docB: string }> {
  const provider = new PgKnowledgeProvider({
    connectionString: await schemaDsn(DSN!, 'knowledge_space_scope_test'),
    allowedRoles: ['viewer'],
    embedding,
    embeddingModel: 'm1',
  })
  await provider.init()
  // schema 是固定命名复用的（pg-schema.ts 刻意不 DROP），所以上一轮的行还在。**不 truncate**：
  // provider 没有 raw 出口，而清库要靠它。改用「每次运行一个独立 realm」——本文件所有断言
  // 都在这个 realm 里，残留行属于别的 realm，天然互不干扰，而且不必为了测试给生产类开一个
  // 只给测试用的后门。
  const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const realm = `realm-${run}`
  // docId 也必须每次唯一：它**跨 realm 全局唯一**（主键就是 doc_id），复用同一个 id 换个
  // realm 重新 ingest 会被 `assertOwner` 拒为「属于另一个 realm」——那既是正确行为，也是
  // 上一版测试失败的原因（它以为换 realm 就够隔离了，而主键根本不是 (realm, doc_id)）。
  const docA = `doc-a-${run}`
  const docB = `doc-b-${run}`
  for (const [docId, space] of [[docA, 'space-a'], [docB, 'space-b']] as const) {
    await provider.ingest({
      doc: { docId, realm, space, title: 't', sourceVersion: 1, embeddingModel: 'm1' },
      chunks: [{ text: '空间收窄的样例内容', metadata: {} }],
    })
  }
  return { provider, realm, docA, docB }
}

describe('知识空间收窄 —— 对真 PG', () => {
  const t = DSN ? it : it.skip
  const title = (s: string) => s + (DSN ? '' : '（需 LUMO_TEST_PG_DSN → 跳过，非通过）')

  t(title('省略 spaces 时两个空间都召回'), async () => {
    const { provider, realm, docA, docB } = await freshProvider()
    try {
      const hits = await provider.query({ realm, roles: ['viewer'], text: '空间收窄的样例内容', topK: 10, scope: 'published' })
      expect(hits.map(h => h.docId).sort()).toEqual([docA, docB].sort())
    } finally { await provider.close() }
  })

  t(title('给定 spaces 时只召回列出的空间'), async () => {
    const { provider, realm, docA, docB } = await freshProvider()
    try {
      const hits = await provider.query({ realm, roles: ['viewer'], text: '空间收窄的样例内容', topK: 10, scope: 'published', spaces: ['space-a'] })
      expect(hits.map(h => h.docId)).toEqual([docA])
    } finally { await provider.close() }
  })

  t(title('spaces 为空数组时召回零条 —— 它不是「不过滤」'), async () => {
    const { provider, realm, docA, docB } = await freshProvider()
    try {
      // 这是本组里唯一一条防「静默放大」的断言：把空数组当成不过滤，会让一次本该返回零条的
      // 检索返回全部内容，而调用方无从察觉——它只看到「有结果」，并以为那是过滤后的结果。
      const hits = await provider.query({ realm, roles: ['viewer'], text: '空间收窄的样例内容', topK: 10, scope: 'published', spaces: [] })
      expect(hits).toEqual([])
    } finally { await provider.close() }
  })

  t(title('空间收窄不能越过 realm 边界'), async () => {
    const { provider, realm, docA, docB } = await freshProvider()
    try {
      // 这是把边界写清楚的一条：spaces 是**收窄**，不是授权。传一个别的 realm 的空间名
      // 不会因此拿到内容——realm 过滤在先，它才是安全边界（§5.4.1）。
      const hits = await provider.query({ realm: 'other-realm', roles: ['viewer'], text: '空间收窄的样例内容', topK: 10, scope: 'published', spaces: ['space-a'] })
      expect(hits).toEqual([])
    } finally { await provider.close() }
  })
})

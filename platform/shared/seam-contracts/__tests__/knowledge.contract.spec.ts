import { describe, expect, it } from 'vitest'
import {
  assertKnowledgeContract,
  type KnowledgeDoc,
  type KnowledgeSeam,
} from '../knowledge.ts'

/** 内存实现：契约测试专用的最小 stub —— 真实 Provider（pgvector/Milvus+Nebula）须通过同一断言 */
class MemoryKnowledgeSeam implements KnowledgeSeam {
  docs = new Map<string, { doc: KnowledgeDoc; text: string }>()
  rebuiltRealms = new Set<string>()

  async rebuild(realm: string): Promise<void> {
    this.rebuiltRealms.add(realm)
  }

  async ingest(entry: Parameters<KnowledgeSeam['ingest']>[0]): Promise<void> {
    this.docs.set(entry.doc.docId, { doc: entry.doc, text: entry.chunks.map((c) => c.text).join(' ') })
  }

  async query(req: Parameters<KnowledgeSeam['query']>[0]): Promise<Array<import('../knowledge.ts').KnowledgeHit>> {
    const { realm, text } = req
    const hits = [...this.docs.entries()]
      .filter(([, v]) => v.doc.realm === realm) // realm 过滤：Provider 层强制
      .filter(([, v]) => v.text.includes(text))
      .sort(([, a], [, b]) => (a.text === b.text ? 0 : b.text.length - a.text.length))
      .slice(0, req.topK)
      .map(([, v]) => ({ docId: v.doc.docId, sourceVersion: v.doc.sourceVersion, score: 1, text: v.text }))
    return hits
  }

  async remove(docId: string, realm: string): Promise<void> {
    const cur = this.docs.get(docId)
    if (cur && cur.doc.realm === realm) this.docs.delete(docId)
  }

  async rebuildCheck(): Promise<boolean> {
    return this.rebuiltRealms.has('realm-a')
  }
}

describe('knowledge seam contract', () => {
  it('passes on the memory stub', async () => {
    const seam = new MemoryKnowledgeSeam()
    const assert = (cond: boolean, msg: string) => expect(cond, msg).toBe(true)
    await assertKnowledgeContract(seam, assert)
    await expect(seam.rebuildCheck()).resolves.toBe(true)
  })
})

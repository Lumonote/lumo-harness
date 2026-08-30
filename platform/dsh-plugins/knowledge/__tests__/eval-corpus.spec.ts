import { describe, expect, it } from 'vitest'

import { chunkByHeading } from '../eval/corpus.ts'

const DOC = `导语，出现在任何标题之前。

# 架构

## 5.4 向量检索与知识库设计

定调：知识库 = 图 + 向量双 seam。

#### 5.4.4 Embedding 版本化与模型切换

换 embedding 模型 = 换向量空间，原地覆盖会导致召回质量整体崩塌。

## 术语字典

realm 与 project 不是一回事。
`

describe('chunkByHeading', () => {
  it('derives the doc id from the section number in the heading', () => {
    const chunks = chunkByHeading(DOC, 'architecture')

    expect(chunks.map((c) => c.docId)).toContain('architecture#5.4.4')
  })

  it('keeps the heading text together with its body', () => {
    const chunks = chunkByHeading(DOC, 'architecture')
    const target = chunks.find((c) => c.docId === 'architecture#5.4.4')!

    expect(target.title).toBe('5.4.4 Embedding 版本化与模型切换')
    expect(target.text).toContain('换向量空间')
  })

  it('starts a new chunk at every heading regardless of level', () => {
    const chunks = chunkByHeading(DOC, 'architecture')
    const target = chunks.find((c) => c.docId === 'architecture#5.4')!

    // 5.4 的正文不得把下级 5.4.4 的正文吞进来，否则一条 chunk 命中即算命中两节。
    expect(target.text).not.toContain('换向量空间')
  })

  it('falls back to a slug when the heading carries no section number', () => {
    const chunks = chunkByHeading(DOC, 'architecture')

    expect(chunks.map((c) => c.docId)).toContain('architecture#术语字典')
  })

  it('drops the preamble that belongs to no section', () => {
    const chunks = chunkByHeading(DOC, 'architecture')

    // 导语没有小节归属，留着会制造无法标注的 docId。
    expect(chunks.every((c) => !c.text.includes('导语'))).toBe(true)
  })
})

describe('golden.zh.json', () => {
  it('only references section ids that exist in the real corpus', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const here = fileURLToPath(new URL('.', import.meta.url))

    const cases = JSON.parse(readFileSync(`${here}../eval/golden.zh.json`, 'utf8')) as Array<{
      id: string; expectedDocIds: string[]; note: string
    }>
    const corpus = new Set(
      chunkByHeading(readFileSync(`${here}../../../../docs/architecture.md`, 'utf8'), 'architecture')
        .map((c) => c.docId),
    )

    // 标注引用了不存在的小节 = 该用例恒定计 0 分，会把指标压低却查不出原因。
    const dangling = cases.flatMap((c) =>
      c.expectedDocIds.filter((id) => !corpus.has(id)).map((id) => `${c.id} -> ${id}`),
    )
    expect(dangling).toEqual([])
  })

  it('gives every case a distractor note', async () => {
    const { readFileSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const cases = JSON.parse(
      readFileSync(fileURLToPath(new URL('../eval/golden.zh.json', import.meta.url)), 'utf8'),
    ) as Array<{ id: string; note: string }>

    // 没有干扰项的 query 检验不出重排价值（spec §5.1）。
    expect(cases.filter((c) => !c.note?.trim()).map((c) => c.id)).toEqual([])
  })
})

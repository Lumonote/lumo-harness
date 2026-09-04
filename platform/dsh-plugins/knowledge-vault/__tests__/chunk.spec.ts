import { describe, expect, it } from 'vitest'
import { splitMarkdownChunks } from '../src/chunk.ts'

describe('markdown chunking', () => {
  it('turns a body without headings into a single chunk', () => {
    const chunks = splitMarkdownChunks('只有一段文字，没有标题。')
    expect(chunks).toEqual([{ text: '只有一段文字，没有标题。', metadata: { heading: '正文' } }])
  })

  it('splits on ## headings, keeping the heading text in the chunk', () => {
    const body = '# 概述\n\n一句话。\n\n## 边界\n\n这里是边界。\n\n## 设计\n\n这里是设计。'
    const chunks = splitMarkdownChunks(body)
    expect(chunks.map(c => c.metadata.heading)).toEqual(['概述', '边界', '设计'])
    expect(chunks[1]!.text).toContain('## 边界')
    expect(chunks[1]!.text).toContain('这里是边界。')
  })

  it('collapses a preamble before the first heading into the first chunk', () => {
    const chunks = splitMarkdownChunks('前言文字。\n\n## 一节\n\n内容。')
    expect(chunks[0]!.metadata.heading).toBe('正文')
    expect(chunks[0]!.text).toContain('前言文字。')
    expect(chunks[1]!.metadata.heading).toBe('一节')
  })

  it('drops empty sections and whitespace-only chunks', () => {
    const chunks = splitMarkdownChunks('# 空章节\n\n## 有内容\n\n文字。\n## 空\n')
    expect(chunks.map(c => c.metadata.heading)).toEqual(['有内容'])
  })
})

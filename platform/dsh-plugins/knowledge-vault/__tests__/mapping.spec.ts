import { describe, expect, it } from 'vitest'
import { decodeDocId, encodeDocId, parseFrontmatter, sourcePathToKey } from '../src/mapping.ts'

describe('vault doc id mapping', () => {
  it('round-trips a nested relative path through base64url docId', () => {
    const path = 'notes/plans/2026.md'
    const docId = encodeDocId(path)
    expect(docId).not.toContain('/')
    expect(docId).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(decodeDocId(docId)).toBe(path)
  })

  it('maps the first path segment to space and root files to general', () => {
    expect(sourcePathToKey('notes/plans/2026.md').space).toBe('notes')
    expect(sourcePathToKey('README.md').space).toBe('general')
  })

  it('overrides space with frontmatter space: field', () => {
    const key = sourcePathToKey('notes/plans/2026.md', '---\nspace: legal\ntitle: 计划\n---\n正文')
    expect(key.space).toBe('legal')
  })

  it('uses frontmatter title or the file basename', () => {
    expect(sourcePathToKey('notes/a.md', '---\ntitle: 我的标题\n---\n').title).toBe('我的标题')
    expect(sourcePathToKey('notes/a.md').title).toBe('a')
  })

  it('derives sourceVersion from mtime in seconds', () => {
    const key = sourcePathToKey('a.md', '', 1_752_000_000_123)
    expect(key.sourceVersion).toBe(1_752_000_000)
  })
})

describe('frontmatter parsing', () => {
  it('treats a file without frontmatter as empty metadata', () => {
    const parsed = parseFrontmatter('# 正文')
    expect(parsed.meta).toEqual({})
    expect(parsed.body).toBe('# 正文')
  })

  it('parses simple key: value frontmatter and removes it from the body', () => {
    const parsed = parseFrontmatter('---\nspace: legal\ntitle: 计划\n---\n# 正文')
    expect(parsed.meta).toEqual({ space: 'legal', title: '计划' })
    expect(parsed.body).toBe('# 正文')
  })
})

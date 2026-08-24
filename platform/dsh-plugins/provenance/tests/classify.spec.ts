import { describe, expect, it } from 'vitest'
import { ProvenanceClassifier } from '../src/classify.ts'

describe('ProvenanceClassifier —— 来源档位', () => {
  it('知识库检索是 external：正文由业务用户撰写且不经审核', () => {
    expect(new ProvenanceClassifier().provenanceOf('knowledge_query')).toBe('external')
  })

  it('工作区文件读取是 internal（有意的取舍，见 classify.ts 注释）', () => {
    expect(new ProvenanceClassifier().provenanceOf('read')).toBe('internal')
  })

  it('未声明的工具按 external 处理（fail closed）', () => {
    expect(new ProvenanceClassifier().provenanceOf('some_new_tool')).toBe('external')
  })

  it('装配层覆盖优先于默认表', () => {
    const c = new ProvenanceClassifier({ overrides: { knowledge_query: 'internal' } })
    expect(c.provenanceOf('knowledge_query')).toBe('internal')
  })

  it('前缀规则批量声明连接器工具', () => {
    const c = new ProvenanceClassifier({
      prefixes: [{ prefix: 'connector_', provenance: 'external', effect: 'write-external' }],
    })
    expect(c.provenanceOf('connector_jira_create')).toBe('external')
    expect(c.effectOf('connector_jira_create')).toBe('write-external')
  })
})

describe('ProvenanceClassifier —— 副作用等级', () => {
  it('只读工具', () => {
    const c = new ProvenanceClassifier()
    expect(c.effectOf('grep')).toBe('read')
    expect(c.effectOf('knowledge_query')).toBe('read')
  })

  it('平台内写', () => {
    expect(new ProvenanceClassifier().effectOf('edit')).toBe('write-local')
  })

  it('bash 按出平台写处理：可发起任意网络请求，无法静态判断', () => {
    expect(new ProvenanceClassifier().effectOf('bash')).toBe('write-external')
  })

  it('未声明的工具按出平台写处理（fail closed）', () => {
    expect(new ProvenanceClassifier().effectOf('some_new_tool')).toBe('write-external')
  })
})

describe('warnOnce —— 未声明工具只告警一次', () => {
  it('首次返回文案，重复返回 undefined', () => {
    const c = new ProvenanceClassifier()
    const first = c.warnOnce('some_new_tool')
    expect(first).toContain('some_new_tool')
    expect(c.warnOnce('some_new_tool')).toBeUndefined()
  })

  it('已声明的工具不告警', () => {
    expect(new ProvenanceClassifier().warnOnce('grep')).toBeUndefined()
  })
})

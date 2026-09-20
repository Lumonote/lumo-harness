import { describe, expect, it, vi } from 'vitest'

import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'

import { defineKnowledgeTool } from '../src/consumer.ts'
import { defineGraphRagTool } from '../src/graph-rag.ts'
import { createSessionScope } from '../src/session-scope.ts'
import type { KnowledgeQuery, KnowledgeSeam } from '../../../shared/seam-contracts/knowledge.ts'

/**
 * 会话级的**知识空间收窄**：受治理执行按预设设、工具按会话读。
 *
 * 两条最要紧的性质：
 *
 * 1. **没设过 ≠ 空数组**。前者是「不按空间收窄」，后者是「一个都不许」（必然召回零条）。
 *    合并它们会让一次本该返回零条的检索返回**全部**，而调用方只看到「有结果」。
 * 2. **图检索必须与向量检索受同一个收窄**。两个工具读同一份数据，只有一个受约束就是洞
 *    ——模型改调另一个即可绕过。这是这类收窄最典型的漏法，所以单独有一条。
 */
const BASE = { realm: 'realm-a', roles: ['viewer'], defaultTopK: 5 }

function seamReturning() {
  const query = vi.fn(async (_request: KnowledgeQuery) => [])
  const seam = {
    ingest: vi.fn(async () => undefined),
    query,
    remove: vi.fn(async () => undefined),
    rebuild: vi.fn(async () => undefined),
  } satisfies KnowledgeSeam
  return { seam, query }
}

function captureTools() {
  const definitions: ToolDefinition[] = []
  const ctx = {
    tools: { register(d: ToolDefinition) { definitions.push(d); return () => {} } },
    logger: { warn: vi.fn() },
  } as unknown as Context
  return { ctx, definitions }
}

/** 只带会话 id 的最小 exec：工具只从这里认会话。 */
function execFor(sessionRef: string | undefined): ToolRunContext {
  return { name: 'x', arguments: {}, agent: sessionRef === undefined ? undefined : { session: { id: sessionRef } } } as unknown as ToolRunContext
}

describe('KnowledgeSessionScope', () => {
  it('没设过的会话返回 undefined —— 不是 []', () => {
    const scope = createSessionScope()
    // 这两个值在 Provider 侧走**不同分支**：undefined = 不收窄，[] = 召回零条。
    expect(scope.spacesFor('s1')).toBeUndefined()
    scope.set('s1', [])
    expect(scope.spacesFor('s1')).toEqual([])
  })

  it('set 会拷一份：调用方事后改数组不影响已设的值', () => {
    const scope = createSessionScope()
    const spaces = ['space-a']
    scope.set('s1', spaces)
    spaces.push('space-b')
    // 不拷贝的话，一个复用的数组会在下一次 set 之前悄悄改变另一个会话的收窄条件——
    // 而「收窄条件变了」在检索结果上看不出来，只会表现为「有时候查得到、有时候查不到」。
    expect(scope.spacesFor('s1')).toEqual(['space-a'])
  })

  it('clear 之后回到「不按空间收窄」', () => {
    const scope = createSessionScope()
    scope.set('s1', ['space-a'])
    scope.clear('s1')
    expect(scope.spacesFor('s1')).toBeUndefined()
  })

  it('会话之间互不影响', () => {
    const scope = createSessionScope()
    scope.set('s1', ['space-a'])
    scope.set('s2', ['space-b'])
    expect(scope.spacesFor('s1')).toEqual(['space-a'])
    expect(scope.spacesFor('s2')).toEqual(['space-b'])
    expect(scope.spacesFor('s3')).toBeUndefined()
  })

  it('空 sessionRef 当场拒绝', () => {
    expect(() => createSessionScope().set('', ['a'])).toThrow()
  })
})

describe('工具按会话传收窄条件', () => {
  it('向量工具把会话的收窄条件传给 seam', async () => {
    const { ctx, definitions } = captureTools()
    const { seam, query } = seamReturning()
    const scope = createSessionScope()
    scope.set('sess-1', ['space-a'])
    defineKnowledgeTool(ctx, seam, { ...BASE }, scope)
    await definitions[0]!.execute({ question: 'q' }, execFor('sess-1'))
    expect((query.mock.calls[0]![0] as KnowledgeQuery).spaces).toEqual(['space-a'])
  })

  it('没设过的会话传 undefined（不按空间收窄），而不是空数组', async () => {
    const { ctx, definitions } = captureTools()
    const { seam, query } = seamReturning()
    defineKnowledgeTool(ctx, seam, { ...BASE }, createSessionScope())
    await definitions[0]!.execute({ question: 'q' }, execFor('sess-unset'))
    expect((query.mock.calls[0]![0] as KnowledgeQuery).spaces).toBeUndefined()
  })

  it('别的会话的收窄条件不会串到这一次调用上', async () => {
    const { ctx, definitions } = captureTools()
    const { seam, query } = seamReturning()
    const scope = createSessionScope()
    scope.set('sess-other', ['space-x'])
    defineKnowledgeTool(ctx, seam, { ...BASE }, scope)
    await definitions[0]!.execute({ question: 'q' }, execFor('sess-mine'))
    expect((query.mock.calls[0]![0] as KnowledgeQuery).spaces).toBeUndefined()
  })

  // 这一条是本组的重点：两个工具读同一份数据，只有一个受收窄就是洞。
  it('图工具受**同一个**收窄 —— 否则它就是一个绕过口', async () => {
    const { ctx, definitions } = captureTools()
    const { seam, query } = seamReturning()
    const graph = {
      neighborhood: vi.fn(async () => ({ nodes: [], edges: [] })),
      upsertNodes: vi.fn(async () => undefined),
      deleteNodes: vi.fn(async () => undefined),
    }
    const scope = createSessionScope()
    scope.set('sess-1', ['space-a'])
    defineGraphRagTool(ctx, seam, graph as never, { ...BASE, graphDepth: 1, graphMaxNodes: 10 }, scope)
    await definitions[0]!.execute({ question: 'q' }, execFor('sess-1'))
    expect((query.mock.calls[0]![0] as KnowledgeQuery).spaces).toEqual(['space-a'])
  })
})

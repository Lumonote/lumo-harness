/**
 * Seam 方法表 + 边界校验（host 侧）。
 *
 * 两条硬规矩，都是「远程不得比本地更弱」的直接后果：
 *
 * 1. **方法是白名单，不是反射。** 绝不写 `impl[method](...args)` —— 那样一个
 *    `method: "constructor"` 或原型链上的任意函数都能被网络调用。这里用 switch
 *    穷举，多一个方法就得在两端各写一次，这点成本换的是「网络面 == 契约面」。
 * 2. **realm 由调用方**身份**决定，不由载荷决定。** 参数里的 realm 必须与调用方
 *    身份一致，否则就是越权：本地 Consumer 的 realm 来自插件配置（进程内可信），
 *    远程调用的载荷则完全由对端构造，不校验就等于把跨租户读取开放给任何能连上
 *    端口的人（§5.4.1 的强制过滤在 Provider 侧只过滤「传进来的 realm」）。
 */
import { invalid } from '../../../shared/seam-contracts/errors.ts'
import type {
  KnowledgeIngest,
  KnowledgeQuery,
  KnowledgeSeam,
} from '../../../shared/seam-contracts/knowledge.ts'
import type {
  GraphEdge,
  GraphNode,
  GraphSeam,
  NeighborhoodQuery,
} from '../../../shared/seam-contracts/graph.ts'

export type SeamName = 'knowledge' | 'knowledgeGraph'

export interface MethodSpec {
  /** 位置参数个数。严格相等：多传少传都说明两端契约版本不一致，不猜。 */
  arity: number
  /**
   * 本次调用触及的所有 realm。host 逐个与调用方身份比对。
   * 参数结构非法时抛 invalid（不返回空数组 —— 空数组会被误当作「无 realm 可校验」）。
   */
  realms(args: unknown[]): string[]
  /** 仅查询类调用会从载荷中声明角色；Host 将其收束到签名调用方的角色集合。 */
  roles?(args: unknown[]): string[]
}

const KNOWLEDGE_METHODS: Record<string, MethodSpec> = {
  ingest: {
    arity: 1,
    realms(args) {
      const entry = asObject(args[0], 'ingest.entry')
      const doc = asObject(entry['doc'], 'ingest.entry.doc')
      const chunks = entry['chunks']
      if (!Array.isArray(chunks)) throw invalid('ingest.entry.chunks 必须是数组')
      for (const [i, c] of chunks.entries()) {
        const chunk = asObject(c, `ingest.entry.chunks[${i}]`)
        asString(chunk['text'], `ingest.entry.chunks[${i}].text`)
      }
      asString(doc['docId'], 'ingest.entry.doc.docId')
      asString(doc['space'], 'ingest.entry.doc.space')
      asString(doc['title'], 'ingest.entry.doc.title')
      asNumber(doc['sourceVersion'], 'ingest.entry.doc.sourceVersion')
      asString(doc['embeddingModel'], 'ingest.entry.doc.embeddingModel')
      return [asString(doc['realm'], 'ingest.entry.doc.realm')]
    },
  },
  query: {
    arity: 1,
    realms(args) {
      const q = asObject(args[0], 'query.request')
      asStringArray(q['roles'], 'query.request.roles')
      asString(q['text'], 'query.request.text')
      asNumber(q['topK'], 'query.request.topK')
      const scope = asString(q['scope'], 'query.request.scope')
      if (scope !== 'published' && scope !== 'draft') {
        throw invalid('query.request.scope 只能是 published / draft')
      }
      return [asString(q['realm'], 'query.request.realm')]
    },
    roles(args) {
      const q = asObject(args[0], 'query.request')
      return asStringArray(q['roles'], 'query.request.roles')
    },
  },
  remove: {
    arity: 2,
    realms(args) {
      asString(args[0], 'remove.docId')
      return [asString(args[1], 'remove.realm')]
    },
  },
  rebuild: {
    arity: 1,
    realms(args) {
      return [asString(args[0], 'rebuild.realm')]
    },
  },
}

const GRAPH_METHODS: Record<string, MethodSpec> = {
  upsertNodes: {
    arity: 1,
    realms(args) {
      const nodes = asArray(args[0], 'upsertNodes.nodes')
      return nodes.map((n, i) => {
        const node = asObject(n, `upsertNodes.nodes[${i}]`)
        asString(node['id'], `upsertNodes.nodes[${i}].id`)
        asString(node['kind'], `upsertNodes.nodes[${i}].kind`)
        asString(node['label'], `upsertNodes.nodes[${i}].label`)
        return asString(node['realm'], `upsertNodes.nodes[${i}].realm`)
      })
    },
  },
  upsertEdges: {
    arity: 1,
    realms(args) {
      const edges = asArray(args[0], 'upsertEdges.edges')
      return edges.map((e, i) => {
        const edge = asObject(e, `upsertEdges.edges[${i}]`)
        asString(edge['from'], `upsertEdges.edges[${i}].from`)
        asString(edge['to'], `upsertEdges.edges[${i}].to`)
        asString(edge['kind'], `upsertEdges.edges[${i}].kind`)
        return asString(edge['realm'], `upsertEdges.edges[${i}].realm`)
      })
    },
  },
  neighborhood: {
    arity: 1,
    realms(args) {
      const q = asObject(args[0], 'neighborhood.query')
      asStringArray(q['roles'], 'neighborhood.query.roles')
      asStringArray(q['origins'], 'neighborhood.query.origins')
      asNumber(q['depth'], 'neighborhood.query.depth')
      asNumber(q['maxNodes'], 'neighborhood.query.maxNodes')
      if (q['edgeKinds'] !== undefined) {
        asStringArray(q['edgeKinds'], 'neighborhood.query.edgeKinds')
      }
      return [asString(q['realm'], 'neighborhood.query.realm')]
    },
    roles(args) {
      const q = asObject(args[0], 'neighborhood.query')
      return asStringArray(q['roles'], 'neighborhood.query.roles')
    },
  },
  removeNode: {
    arity: 2,
    realms(args) {
      asString(args[0], 'removeNode.id')
      return [asString(args[1], 'removeNode.realm')]
    },
  },
}

export const METHOD_TABLE: Readonly<Record<SeamName, Record<string, MethodSpec>>> = {
  knowledge: KNOWLEDGE_METHODS,
  knowledgeGraph: GRAPH_METHODS,
}

export function isSeamName(name: string): name is SeamName {
  return name === 'knowledge' || name === 'knowledgeGraph'
}

/** 取方法规格；未注册的方法一律 invalid（不泄漏「存在但不可用」这类信息）。 */
export function methodSpec(seam: SeamName, method: string): MethodSpec {
  const spec = Object.prototype.hasOwnProperty.call(METHOD_TABLE[seam], method)
    ? METHOD_TABLE[seam][method]
    : undefined
  if (!spec) throw invalid(`seam ${seam} 未注册方法 ${method}`)
  return spec
}

/** 显式派发（白名单的实现面）。参数已由 {@link methodSpec} 校验过结构。 */
export function callKnowledge(seam: KnowledgeSeam, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'ingest': return seam.ingest(args[0] as KnowledgeIngest)
    case 'query': return seam.query(args[0] as KnowledgeQuery)
    case 'remove': return seam.remove(args[0] as string, args[1] as string)
    case 'rebuild': return seam.rebuild(args[0] as string)
    default: throw invalid(`seam knowledge 未注册方法 ${method}`)
  }
}

export function callGraph(seam: GraphSeam, method: string, args: unknown[]): Promise<unknown> {
  switch (method) {
    case 'upsertNodes': return seam.upsertNodes(args[0] as GraphNode[])
    case 'upsertEdges': return seam.upsertEdges(args[0] as GraphEdge[])
    case 'neighborhood': return seam.neighborhood(args[0] as NeighborhoodQuery)
    case 'removeNode': return seam.removeNode(args[0] as string, args[1] as string)
    default: throw invalid(`seam knowledgeGraph 未注册方法 ${method}`)
  }
}

// ---- 结构守卫：失败一律 invalid（调用方的问题，不计入熔断） ----

function asObject(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw invalid(`${path} 必须是对象`)
  }
  return v as Record<string, unknown>
}

function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw invalid(`${path} 必须是数组`)
  return v
}

function asString(v: unknown, path: string): string {
  if (typeof v !== 'string' || v.length === 0) throw invalid(`${path} 必须是非空字符串`)
  return v
}

function asNumber(v: unknown, path: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw invalid(`${path} 必须是有限数字`)
  return v
}

function asStringArray(v: unknown, path: string): string[] {
  const arr = asArray(v, path)
  for (const [i, item] of arr.entries()) {
    if (typeof item !== 'string') throw invalid(`${path}[${i}] 必须是字符串`)
  }
  return arr as string[]
}

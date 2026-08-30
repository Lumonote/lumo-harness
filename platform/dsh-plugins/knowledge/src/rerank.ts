/**
 * Rerank Client（§5.4.5 编排图里的「重排」；本项目已承诺但此前未实现）。
 *
 * 与 `embedding.ts` 同构：接口 + TEI 实现 + 严格校验。默认实现走 TEI 的
 * `/rerank` 端点（cross-encoder 精排），与 embedding 用同一镜像不同模型实例。
 */

export interface RerankClient {
  /** 返回**按输入顺序对齐**的相关性分数（越大越相关） */
  rerank(query: string, texts: string[]): Promise<number[]>
  readonly model: string
}

export interface TeiRerankConfig {
  baseUrl: string
  /** 模型标识（记录用；TEI 实例已固定模型） */
  model: string
  timeoutMs?: number
}

export class TeiRerankClient implements RerankClient {
  readonly model: string
  private readonly url: URL
  private readonly timeoutMs: number

  constructor(config: TeiRerankConfig) {
    this.url = new URL('/rerank', config.baseUrl)
    this.model = config.model
    this.timeoutMs = config.timeoutMs ?? 30_000
  }

  async rerank(query: string, texts: string[]): Promise<number[]> {
    if (texts.length === 0) return []
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, texts }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(
          `TeiRerankClient: /rerank 返回 ${res.status}: ${(await res.text()).slice(0, 200)}`,
        )
      }
      const data = (await res.json()) as Array<{ index: number; score: number }>
      if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(
          `TeiRerankClient: 返回条数 ${Array.isArray(data) ? data.length : '非数组'} ≠ 输入 ${texts.length}`,
        )
      }

      // TEI 按分数降序返回，`index` 指回输入下标。不按 index 回填就会静默错位：
      // 分数安在错误的文本上，结果看着正常（有序、分数合理）但内容全错，且不会报错。
      // 下面三条校验把「错位」从静默失效变成显式失败。
      const scores = new Array<number>(texts.length)
      const seen = new Set<number>()
      for (const entry of data) {
        const index = entry.index
        if (!Number.isInteger(index) || index < 0 || index >= texts.length) {
          throw new Error(`TeiRerankClient: index ${index} 越界（输入 ${texts.length} 条）`)
        }
        if (seen.has(index)) {
          throw new Error(`TeiRerankClient: index ${index} 重复 —— 必有文本拿不到分数`)
        }
        seen.add(index)
        if (!Number.isFinite(entry.score)) {
          throw new Error(`TeiRerankClient: index ${index} 的分数非有限值（${entry.score}）`)
        }
        scores[index] = entry.score
      }
      return scores
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new Error(`TeiRerankClient: /rerank 超时 ${this.timeoutMs}ms（${this.model}）`)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * 按分数降序取前 topK。
 *
 * **必须是稳定排序**：交叉编码器给相近片段打出并列分数是常态，缺失分数也按 0 补齐；
 * 排序不稳定会让并列项的相对次序随实现漂移 —— 同一查询两次结果不同，且不会报错。
 * `Array.prototype.sort` 自 ES2019 起保证稳定，直接用它，不得换成不保证稳定的排序。
 */
export function rankByScore<T>(items: T[], scores: number[], topK: number): T[] {
  return items
    .map((item, index) => ({ item, score: scores[index] ?? 0 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((entry) => entry.item)
}

/**
 * Consumer 侧的重排入口（§5.4.5 把「重排」画在编排里，不在 Provider 里）。
 *
 * **fail-open，与 §20 对 embedding 的 fail-closed 有意不对称**：embedding 失效会让检索命中
 * 错误的语义邻域 —— 返回的内容本身是错的，是正确性问题；rerank 失效只是把本就召回到的
 * 正确候选排得不够好，是质量问题。据此 rerank 不可用时退回向量原序，不拒绝服务。
 * 照抄 embedding 的档位会让 reranker 容器一挂就拖垮整个知识库，而它本就是可选组件。
 */
export async function rerankHits<T extends { text: string }>(
  client: RerankClient | undefined,
  query: string,
  hits: T[],
  topK: number,
  onDegrade: (reason: string) => void,
): Promise<T[]> {
  if (!client || hits.length === 0) return hits.slice(0, topK)
  try {
    const scores = await client.rerank(query, hits.map((h) => h.text))
    return rankByScore(hits, scores, topK)
  } catch (e) {
    onDegrade(e instanceof Error ? e.message : String(e))
    return hits.slice(0, topK)
  }
}

/** 粗召回倍数：不过量召回，rerank 拿到的候选集就是最终结果集，重排没有空间。 */
export const DEFAULT_OVERFETCH_FACTOR = 3

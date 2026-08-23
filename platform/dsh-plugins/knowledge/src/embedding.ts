/**
 * Embedding Client（知识库向量的来源；§5.4.4 版本化属于装配参数）。
 * 默认实现：TEI（text-embeddings-inference）HTTP /embed —— 平台自带编排
 * （deploy/compose.local.yml 的 lumo-platform-tei），与用户既有 TEI 生态一致；
 * 不依赖 ctx.llm —— DeepSeek 官方 API 无 embedding 端点。
 */
export interface EmbeddingClient {
  embed(inputs: string[]): Promise<number[][]>
  /** 维度（用于 DDL vector(n)，须与模型返回一致） */
  readonly dimension: number
}

export interface TeiClientConfig {
  baseUrl: string
  /** 模型标识（仅记录/版本化用；TEI 实例已固定模型） */
  model: string
  /** 维度校验：与实例模型一致（bge-m3 = 1024） */
  dimension: number
  timeoutMs?: number
}

export class TeiClient implements EmbeddingClient {
  readonly dimension: number
  private readonly model: string
  private url: URL
  private readonly timeoutMs: number

  constructor(config: TeiClientConfig) {
    this.url = new URL('/embed', config.baseUrl)
    this.model = config.model
    this.dimension = config.dimension
    this.timeoutMs = config.timeoutMs ?? 30_000
  }

  async embed(inputs: string[]): Promise<number[][]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inputs }),
        signal: controller.signal,
      })
      if (!res.ok) {
        throw new Error(`TeiClient: /embed 返回 ${res.status}: ${(await res.text()).slice(0, 200)}`)
      }
      const data = (await res.json()) as number[][]
      if (data.length !== inputs.length) {
        throw new Error(`TeiClient: 返回向量数 ${data.length} ≠ 输入 ${inputs.length}`)
      }
      for (const v of data) {
        if (v.length !== this.dimension) {
          throw new Error(
            `TeiClient: 向量维度 ${v.length} ≠ 配置 ${this.dimension}（模型不匹配 —— §5.4.4 须换 collection）`,
          )
        }
        if (!v.every((x) => Number.isFinite(x))) {
          throw new Error('TeiClient: 向量含非有限值')
        }
      }
      return data
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        throw new Error(`TeiClient: /embed 超时 ${this.timeoutMs}ms（${this.model}）`)
      }
      throw e
    } finally {
      clearTimeout(timer)
    }
  }

  get modelName(): string {
    return this.model
  }
}

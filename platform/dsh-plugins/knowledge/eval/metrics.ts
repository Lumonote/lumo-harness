/**
 * 召回评测指标（§5.4.4 要求的「离线评测对比召回质量」）。
 *
 * 只做**检索**指标，不做 BLEU/ROUGE —— 那是生成质量指标，混进来会让「换模型导致答案
 * 变化」与「召回变差」纠缠在一个数字里，到时无法归因。
 */

export interface EvalCase {
  id: string
  query: string
  /** 期望命中的文档出处；多个表示该问题有多个正确来源 */
  expectedDocIds: string[]
  /** 干扰项说明。没有干扰项的 query 检验不出重排价值，标注时就该筛掉 */
  note: string
}

export interface RunResult {
  expected: string[]
  /** 检索返回的 docId，按名次排列 */
  ranked: string[]
}

export interface Metrics {
  cases: number
  recallAt1: number
  recallAt3: number
  recallAt5: number
  /** 首个相关结果名次的倒数（越大越好） */
  mrr: number
  ndcgAt5: number
}

/** 前 k 条里命中的期望出处占比（|expected| = 1 时即命中率） */
function recallAt(result: RunResult, k: number): number {
  if (result.expected.length === 0) return 0
  const top = new Set(result.ranked.slice(0, k))
  const hits = result.expected.filter((id) => top.has(id)).length
  return hits / result.expected.length
}

function reciprocalRank(result: RunResult): number {
  const expected = new Set(result.expected)
  const index = result.ranked.findIndex((id) => expected.has(id))
  return index === -1 ? 0 : 1 / (index + 1)
}

/** 二元相关性的 nDCG@k：DCG = Σ rel_i / log2(i+2)，IDCG = 全部相关项排最前时的 DCG */
function ndcgAt(result: RunResult, k: number): number {
  const expected = new Set(result.expected)
  const gains = result.ranked.slice(0, k).map((id) => (expected.has(id) ? 1 : 0))
  const dcg = gains.reduce((sum, rel, i) => sum + rel / Math.log2(i + 2), 0)
  const ideal = Math.min(result.expected.length, k)
  let idcg = 0
  for (let i = 0; i < ideal; i++) idcg += 1 / Math.log2(i + 2)
  return idcg === 0 ? 0 : dcg / idcg
}

function mean(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

export function scoreRun(results: RunResult[]): Metrics {
  return {
    cases: results.length,
    recallAt1: mean(results.map((r) => recallAt(r, 1))),
    recallAt3: mean(results.map((r) => recallAt(r, 3))),
    recallAt5: mean(results.map((r) => recallAt(r, 5))),
    mrr: mean(results.map(reciprocalRank)),
    ndcgAt5: mean(results.map((r) => ndcgAt(r, 5))),
  }
}

/** 输出成可直接粘进 §5.4.4 模型切换记录的对比表 */
export function compareTable(rows: Array<{ label: string; metrics: Metrics }>): string {
  const header = '| 配置 | 用例数 | Recall@1 | Recall@3 | Recall@5 | MRR | nDCG@5 |'
  const sep = '|------|-------|----------|----------|----------|-----|--------|'
  const body = rows.map(({ label, metrics: m }) =>
    `| ${label} | ${m.cases} | ${m.recallAt1.toFixed(3)} | ${m.recallAt3.toFixed(3)} `
    + `| ${m.recallAt5.toFixed(3)} | ${m.mrr.toFixed(3)} | ${m.ndcgAt5.toFixed(3)} |`,
  )
  return [header, sep, ...body].join('\n')
}

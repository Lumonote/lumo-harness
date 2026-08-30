/**
 * 离线召回评测（§5.4.4 的「离线评测对比召回质量」）。
 *
 *   pnpm run kb:eval
 *
 * 需要真实依赖：PG(pgvector) + TEI embedding；配了 rerank 才跑 on/off 对比。
 *   docker compose -f deploy/compose.local.yml up -d postgres embedding rerank
 *
 * **离线手动跑，不入 CI**：§5.4.4 原文写的就是「离线评测」；CI 里拉两份 TEI 权重
 * （embedding + reranker 各约 2GB）代价与收益不成比例。
 *
 * 换 embedding 模型时按 §5.4.4 的流程跑它对比新旧 collection 的召回质量，
 * 输出可直接粘进模型切换记录。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { PgKnowledgeProvider } from '../src/pg-provider.ts'
import { TeiClient } from '../src/embedding.ts'
import { TeiRerankClient, rerankHits, type RerankClient } from '../src/rerank.ts'
import { chunkByHeading } from './corpus.ts'
import { compareTable, scoreRun, type EvalCase, type Metrics, type RunResult } from './metrics.ts'

const here = fileURLToPath(new URL('.', import.meta.url))

const env = {
  pg: process.env.LUMO_PG_DSN ?? 'postgres://lumo:lumo@127.0.0.1:55432/lumo',
  tei: process.env.LUMO_TEI_URL ?? 'http://127.0.0.1:55433',
  teiModel: process.env.LUMO_TEI_MODEL ?? 'BAAI/bge-m3',
  teiDim: Number(process.env.LUMO_TEI_DIM ?? 1024),
  rerank: process.env.LUMO_RERANK_URL ?? 'http://127.0.0.1:55434',
  rerankModel: process.env.LUMO_RERANK_MODEL ?? 'BAAI/bge-reranker-v2-m3',
  topK: Number(process.env.LUMO_EVAL_TOPK ?? 5),
  overfetch: Number(process.env.LUMO_EVAL_OVERFETCH ?? 3),
  realm: 'eval-realm',
}

/** 语料：本仓自己的中文架构文档 —— 术语密集且近义干扰多，纯余弦最容易翻车的地方 */
const CORPUS = [
  { prefix: 'architecture', path: `${here}../../../../docs/architecture.md` },
  { prefix: 'roadmap', path: `${here}../../../../docs/roadmap.md` },
  { prefix: 'review', path: `${here}../../../../docs/design-review.md` },
]

async function ingestCorpus(provider: PgKnowledgeProvider): Promise<number> {
  let count = 0
  for (const { prefix, path } of CORPUS) {
    for (const chunk of chunkByHeading(readFileSync(path, 'utf8'), prefix)) {
      await provider.ingest({
        doc: {
          docId: chunk.docId,
          realm: env.realm,
          space: 'eval',
          title: chunk.title,
          sourceVersion: 1,
          embeddingModel: env.teiModel,
        },
        chunks: [{ text: chunk.text, metadata: {} }],
      })
      count++
    }
  }
  return count
}

async function runOnce(
  provider: PgKnowledgeProvider,
  cases: EvalCase[],
  rerank: RerankClient | undefined,
): Promise<Metrics> {
  const results: RunResult[] = []
  for (const c of cases) {
    const factor = rerank ? env.overfetch : 1
    const candidates = await provider.query({
      realm: env.realm,
      roles: ['viewer'],
      text: c.query,
      topK: env.topK * factor,
      scope: 'published',
    })
    const hits = await rerankHits(rerank, c.query, candidates, env.topK, (reason) => {
      // 评测里降级必须显式喊出来 —— 悄悄降级会把「rerank 无提升」的结论坐实成假象。
      throw new Error(`评测中 rerank 降级，结论不可信: ${reason}`)
    })
    results.push({ expected: c.expectedDocIds, ranked: hits.map((h) => h.docId) })
  }
  return scoreRun(results)
}

async function main(): Promise<void> {
  const cases = JSON.parse(readFileSync(`${here}golden.zh.json`, 'utf8')) as EvalCase[]
  const embedding = new TeiClient({ baseUrl: env.tei, model: env.teiModel, dimension: env.teiDim })
  const provider = new PgKnowledgeProvider({
    connectionString: env.pg,
    allowedRoles: ['viewer'],
    embedding,
    embeddingModel: env.teiModel,
  })

  try {
    await provider.init()
    console.log(`入库语料…（realm=${env.realm}）`)
    const chunks = await ingestCorpus(provider)
    console.log(`已入库 ${chunks} 条 chunk，评测用例 ${cases.length} 条，topK=${env.topK}\n`)

    const off = await runOnce(provider, cases, undefined)

    let rerank: RerankClient | undefined
    try {
      const client = new TeiRerankClient({ baseUrl: env.rerank, model: env.rerankModel })
      await client.rerank('探活', ['探活'])
      rerank = client
    } catch (e) {
      console.warn(`reranker 不可达，只输出 off 一档: ${e instanceof Error ? e.message : e}\n`)
    }

    const rows = [{ label: `rerank off（纯向量 topK=${env.topK}）`, metrics: off }]
    if (rerank) {
      const on = await runOnce(provider, cases, rerank)
      rows.push({ label: `rerank on（${env.rerankModel}，overfetch ×${env.overfetch}）`, metrics: on })
      const delta = on.ndcgAt5 - off.ndcgAt5
      console.log(compareTable(rows))
      console.log(`\nnDCG@5 变化：${delta >= 0 ? '+' : ''}${delta.toFixed(3)}`)
      // 否定结论也是结论：一个只会说「有提升」的评测等于没有评测（spec §8 验收 6）。
      if (delta <= 0) {
        console.log('\n⚠️ rerank 未带来提升。请如实记录该否定结论，不要调参数直到好看。')
      }
    } else {
      console.log(compareTable(rows))
    }
  } finally {
    await provider.close()
  }
}

main().catch((e: unknown) => {
  console.error(e)
  process.exitCode = 1
})

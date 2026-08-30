# 知识库召回评测

兑现 `architecture.md` §5.4.4 的一句承诺：

> 新模型上线：建新 collection(v2) → 全量回填 → 双写(v1+v2) → **离线评测对比召回质量** →
> 按 realm 灰度切读

在此之前这一步没有工具，真到换 embedding 模型时只能靠感觉决定要不要灰度。

## 跑

```sh
docker compose -f deploy/compose.local.yml up -d postgres embedding rerank
pnpm run kb:eval
```

reranker 不可达时只输出 `rerank off` 一档并给出告警，不静默跳过。

可用环境变量覆盖：`LUMO_PG_DSN`、`LUMO_TEI_URL`、`LUMO_TEI_MODEL`、`LUMO_TEI_DIM`、
`LUMO_RERANK_URL`、`LUMO_RERANK_MODEL`、`LUMO_EVAL_TOPK`、`LUMO_EVAL_OVERFETCH`。

## 构成

| 文件 | 作用 |
|------|------|
| `golden.zh.json` | 24 条人工标注：query → 期望命中的小节 + 干扰项说明 |
| `corpus.ts` | 按 markdown 标题切块（**评测夹具，不是分块策略**，见 spec §7.3） |
| `metrics.ts` | Recall@1/3/5、MRR、nDCG@5 + markdown 对比表 |
| `run-eval.ts` | 入库 → 跑两遍（rerank on/off）→ 出表 |

## 语料为什么用本仓自己的文档

不是图省事。`docs/` 的中文架构文档恰好具备纯余弦最容易翻车的特征：术语密集，且有大量
**被刻意区分**的近义词——「网关 / 代理 / seam」「realm / 租户 / 项目」「组件 / 技能 / 流程」。
§14 术语字典的存在本身就说明这些词在本项目里不可混用，而向量空间里它们彼此很近。

代价是结论对外部语料的泛化性未知。接入真实业务语料后应当重跑。

## 指标口径

- **Recall@k**：前 k 条命中的期望出处占比。`expectedDocIds` 只有一个时即命中率。
- **MRR**：首个相关结果名次的倒数，没召回到记 0。
- **nDCG@5**：二元相关性，`Σ rel_i / log2(i+2)` 除以理想排列的同式。**这是 rerank 直接改善的量**——同样召回到，排得靠前 nDCG 更高。

不做 BLEU / ROUGE：那是生成质量指标，混进来会让「换模型导致答案变化」与「召回变差」
纠缠在一个数字里，到时无法归因。

## 关于标注质量

`golden.zh.json` 的 24 条由人工标注、每条附干扰项说明，且有测试
（`__tests__/eval-corpus.spec.ts`）保证：

1. 所有 `expectedDocIds` 在真实语料中存在——引用了不存在的小节会让该用例恒定计 0 分，
   把指标压低却查不出原因；
2. 每条都有非空 `note`——没有干扰项的 query 检验不出重排价值，标注时就该被筛掉。

24 条规模偏小，指标方差不可忽略。**结论只看方向，不看小数点**；同一配置跑多次核对稳定性。

## 否定结论也是结论

若 `rerank on` 的 nDCG@5 不高于 `off`，脚本会显式打出告警。**请如实记录该结论，不要调参数
直到数字好看**——一个只会说「有提升」的评测等于没有评测。

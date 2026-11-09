# 知识库召回评测

离线比较 embedding / rerank 的召回质量。保留现有 24 条仓库架构用例，也接受操作者提供的真实业务语料和标注；仓库用例和合成测试不能证明真实业务效果。工具不会抓取语料中的 URL，也不会自动连接默认服务。

## 准备输入

自定义输入是同一个目录内的 JSON 文件。`--input-root` 指向该目录，`--corpus`、`--suite`、`--configuration`、`--baseline` 均为目录内相对路径。不接受绝对路径、`..`、符号链接、目录、设备、超过 16 MiB 的文件、重复 JSON 键、未知字段或非有限数字。

`corpus.json` 的合同：

```json
{
  "schema_version": "lumo-knowledge-corpus/v1",
  "id": "your-business-corpus",
  "revision": 1,
  "documents": [
    { "id": "operator-document-id", "title": "文档标题", "text": "经授权用于评测的完整检索单元" }
  ]
}
```

每条 document 是一个检索单元，最多 10,000 条、每条正文不超过 128,000 字符。ID 唯一。若要评测章节召回，应先按业务分块规则导出各章；此工具不冒充生产分块管道，也不伪造客户语料。

`suite.json`：

```json
{
  "schema_version": "lumo-knowledge-suite/v1",
  "id": "your-business-suite",
  "revision": 1,
  "corpus_digest": "上面 corpus 按 canonical JSON 计算的 64 位小写 SHA-256",
  "cases": [
    {
      "id": "operator-case-id",
      "query": "人工标注的业务查询",
      "expectedDocIds": ["operator-document-id"],
      "note": "干扰文档与标注理由"
    }
  ]
}
```

所有 `expectedDocIds` 必须存在，且不能重复。suite 摘要包含查询、期望出处、干扰说明，避免标注变化后沿用旧分数。`contracts.ts` 导出的 `digest` 对 JSON 对象键排序，数组顺序保留；不要直接对原文件字节做 SHA 代替。

`configuration.json`：

```json
{
  "schema_version": "lumo-knowledge-configuration/v1",
  "embedding": { "model": "BAAI/bge-m3", "revision": "部署的不可变权重revision", "dimension": 1024 },
  "rerank": { "mode": "required", "model": "BAAI/bge-reranker-v2-m3", "revision": "部署的不可变权重revision" },
  "topK": 5,
  "overfetch": 3
}
```

`topK` 为 5–100（报告固定 Recall@1/3/5、MRR、nDCG@5），`topK × overfetch` 不超过 Provider 的候选上限 100。重排模式 `required` 不可用即失败，且在入库前探活；`optional` 明确记录 `unavailable` 并仅输出 off；`off` 的 model/revision 必须为 null，不访问重排服务。开始 on 档后任一查询重排失败都会中止，不能在一个 on 报告里混入降级结果。

## 运行

使用专用评测数据库。随机 realm 和随机前缀的物理 doc ID 防止污染业务命名空间，但 `PgKnowledgeProvider.init()` 仍会运行表初始化和 ledger backfill，不代表在生产数据库执行无影响。评测写入会保留在该专用库，以报告中的 realm 复核；工具不承诺完整物理清理，不会删除业务数据。

先验证输入，不连接任何服务：

```sh
pnpm run kb:eval --input-root /absolute/path/to/eval-bundle \
  --corpus corpus.json --suite suite.json --configuration configuration.json --validate-only
```

真实运行必须显式配置 PostgreSQL 与 TEI origin（不能包含账号密码、路径或 query）。服务地址不从语料读取，DSN、端点、查询正文和语料正文不进入报告：

```sh
LUMO_PG_DSN='postgres://your-eval-db/knowledge_eval' \
LUMO_TEI_URL='http://your-embedding-host:8080' \
LUMO_RERANK_URL='http://your-rerank-host:8080' \
pnpm run kb:eval --input-root /absolute/path/to/eval-bundle \
  --corpus corpus.json --suite suite.json --configuration configuration.json \
  --output /absolute/path/to/new-report.json --markdown-output /absolute/path/to/new-report.md
```

输出文件必须不存在，默认权限 0600，防止意外覆盖旧证据。不传自定义 corpus/suite 时继续使用 `golden.zh.json` 与本仓中文架构文档，并在报告中标识 `repository-golden-zh`，不扩充虚构业务样本。

不传 configuration 文件时，必须设置 `LUMO_TEI_MODEL`、`LUMO_TEI_REVISION`、`LUMO_TEI_DIM`；重排默认 required，还必须设置 `LUMO_RERANK_MODEL`、`LUMO_RERANK_REVISION`。可用 `LUMO_EVAL_RERANK_MODE=off|optional|required`、`LUMO_EVAL_TOPK`、`LUMO_EVAL_OVERFETCH` 调整。PG/TEI URL 没有隐式默认值。

## 报告与基线

JSON 包含 suite/corpus/model/configuration SHA-256、每个 case 的逻辑 doc ID 排名、完整覆盖和重算指标；模型名与 revision 由操作者声明，报告不独立证明服务实际加载了这些权重。真实 CLI 报告标记 `live-services-operator-declared-models`，测试注入的模拟报告标记 `simulated-contract-test`。

将旧 JSON 放入 input-root，使用 `--baseline previous-report.json`。基线必须是同一 suite/corpus 摘要、相同 topK/overfetch/重排模式、相同 off/on 覆盖，每条 case 必须恰好出现一次。工具重新计算旧排名的指标，拒绝伪造分数、缺失用例、重复结果、外部文档及 live/simulated 混比；允许 embedding/rerank 模型更换，并记录基线报告摘要和各指标差值。比较不自动宣告上线合格，阈值和真实业务代表性仍需操作者评审。

指标按文档 ID 去重，避免一个文档多个 chunk 重复加分导致 nDCG 大于 1。若 on 的 nDCG@5 不高于 off，Markdown 保留否定结论。不要改标注或参数直到数字好看。

## 验证边界

```sh
pnpm exec vitest run dsh-plugins/knowledge/__tests__/eval-*.spec.ts
pnpm exec tsc -p dsh-plugins/knowledge/eval/tsconfig.json --noEmit
```

这些验证覆盖输入与路径边界、随机命名隔离、严格重排失败、逐例报告与基线覆盖，使用明确标记的合成合同夹具。未在 CI 下载 TEI 权重，未把模拟排名当作真实模型质量证据。真实业务质量需要操作者提供授权语料、标注、专用 pgvector 与真实 TEI 服务后另跑。

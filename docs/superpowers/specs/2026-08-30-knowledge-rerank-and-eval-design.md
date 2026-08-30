# 知识库召回质量设计说明 —— 兑现 §5.4.5 的重排与 §5.4.4 的离线评测

- 日期：2026-08-30
- 前置：`architecture.md` §5.4（向量检索与知识库）/ §5.4.4（embedding 版本化与模型切换）/
  §5.4.5（GraphRAG 编排）/ §6.4（成本归因）/ §20（故障模式目录与降级预案）；
  已在产事实：`dsh-plugins/knowledge`（`ctx.knowledge` + `ctx.knowledgeGraph` 双 seam、
  pgvector 与 Milvus 两套 Provider、`knowledge_query` 与 `knowledge_graph_query` 两个 Consumer 工具）、
  `shared/seam-contracts/knowledge.ts`（四条契约断言）、
  `deploy/compose.local.yml` 的 TEI 实例（`BAAI/bge-m3`，1024 维）
- 外部输入：[Tencent/WeKnora](https://github.com/Tencent/WeKnora) v0.7.2（MIT）源码调研，
  见 §7 的借鉴与拒绝清单
- 状态：设计待评审，未实现

---

## 0. 定位：这一层补的是两笔自己欠的债

调研 WeKnora 的起点是「能否直接替换本项目知识库」，结论是不能（理由见 §7.2）。但对照过程
暴露出八项能力差距，其中**两项不是借鉴来的新需求，而是 `architecture.md` 已经写下承诺、
实现没有跟上的部分**：

| 缺口 | 规范原文 | 实现现状 |
|------|---------|---------|
| 重排 | §5.4.5 编排图明确画了 `回源取原文(MinIO/PG) ──▶ 重排(rerank)` | 无。`pg-provider.ts` 的 `query()` 按 `ORDER BY vector <=> $1` 排完即返回 |
| 离线召回评测 | §5.4.4 模型切换流程要求「全量回填 → 双写 → **离线评测对比召回质量** → 灰度切读」 | 无。契约测试验的是行为正确性，不是召回质量 |

本篇只做这两项。其余六项差距（文档解析、分块策略、关键词混合召回、分数阈值、上下文增强、
跨 KB 扇出）属于新增能力，不在本轮范围，理由见 §7.3。

**为什么这两项优先**：§5.4.4 的模型切换流程当前是**不可执行**的——「离线评测对比召回质量」
这一步没有工具，真到换 embedding 模型时只能靠感觉决定灰度与否。规范承诺了一道闸门却没造闸门，
比没写这道闸门更危险：读规范的人会以为它存在。

---

## 1. 边界：契约不动，改动全在 Consumer 侧

§5.4.5 的编排图把「重排」画在「回源取原文」之后、「组装上下文」之前——它是 **Consumer 侧
编排的一环，不是 Provider 的职责**。据此确定改动面：

| 文件 | 本轮改动 |
|------|---------|
| `shared/seam-contracts/knowledge.ts` | **不动**（含 `assertKnowledgeContract` 四条断言） |
| `dsh-plugins/knowledge/src/pg-provider.ts` | **不动** |
| `dsh-plugins/knowledge/src/remote-provider.ts` | **不动** |
| `dsh-plugins/knowledge/src/rerank.ts` | 新增 |
| `dsh-plugins/knowledge/src/consumer.ts` | 接入 rerank |
| `dsh-plugins/knowledge/src/graph-rag.ts` | 接入 rerank |
| `dsh-plugins/knowledge/src/index.ts` | 装配可选 `rerank` 配置 |
| `dsh-plugins/knowledge/eval/` | 新增 |
| `deploy/compose.local.yml` | 新增第二个 TEI 实例 |

**这条边界的收益是可验证的**：现有两套 Provider 的契约测试在本轮结束后必须**一条都不改**
且全绿。若发现需要改契约，说明 rerank 被错误地下沉进了 Provider。

**这条边界的代价也要说清**：rerank 挂在 Consumer 意味着**每个 Consumer 都要自己接**。目前只有
两个（`knowledge_query`、`knowledge_graph_query`），共享同一个 `rerank.ts` 模块即可；若将来
Consumer 增多，需要重新评估是否抽一层公共编排。不预先抽象（YAGNI）。

---

## 2. rerank 组件

### 2.1 接口：与 `embedding.ts` 同构

`embedding.ts` 已经确立了「平台自带编排的推理服务客户端」这一模式（接口 + TEI 实现 + 严格
校验 + 超时带模型名）。rerank 照搬该结构，不发明第二种风格：

```ts
export interface RerankClient {
  /** 返回**按输入顺序对齐**的相关性分数（越大越相关） */
  rerank(query: string, texts: string[]): Promise<number[]>
  readonly model: string
}

export class TeiRerankClient implements RerankClient   // POST /rerank
export class NoopRerankClient implements RerankClient  // 未配置：返回全零 → 保持原序
```

`NoopRerankClient` 返回全零依赖**排序稳定性**才能保持原序。JS 的 `Array.prototype.sort` 自
ES2019 起保证稳定，实现时直接用它即可；但不得改用任何不保证稳定的排序，否则「不配置 rerank」
会变成「随机打乱顺序」——这是一条不会报错的静默回归。

选择「返回对齐分数」而非「返回重排后的数组」，是为了让调用方保留原始 hit 对象（`docId`、
`sourceVersion`、向量分数）不被 rerank 层重新包装——重排不应该有能力丢字段。

### 2.2 TEI `/rerank` 的顺序陷阱

TEI 的 `/rerank` 端点接收 `{query, texts, raw_scores}`，返回的是 **按分数降序排列的
`[{index, score}]`**，其中 `index` 指回输入数组的下标。

**不按 `index` 映射回输入顺序，就会静默错位**：分数被安到错误的文本上，重排结果看起来正常
（有序、分数合理）但内容全错。这类缺陷不会让任何测试变红，只会让召回质量莫名其妙地差。

因此 `TeiRerankClient` 必须：

1. 按 `index` 回填到长度等于 `texts.length` 的结果数组
2. 校验每个 `index` 恰好出现一次且在 `[0, texts.length)` 内——重复或越界即抛
3. 沿用 `TeiClient` 的既有校验：返回条数不符抛、分数非有限抛、超时错误带模型名

第 2 条是本节的核心：它把「顺序错位」从静默失效变成显式失败。

### 2.3 降级语义：与 §20 的有意不对称

§20 故障目录对 embedding 的规定是 fail-closed：

> **TEI/embedding 不可用** → 查询侧无 embedding 即 `CapabilityUnavailable`——不拿旧向量代理
> 新文本（语义漂移比没有更糟）

**rerank 不适用这条，必须 fail-open**：

| 组件 | 不可用时行为 | 失败后果 | 档位 |
|------|------------|---------|------|
| embedding | `CapabilityUnavailable` | 召回**错的**内容 | fail-closed |
| rerank | 退回向量原序 + 记 warn | 顺序**次优** | fail-open |

判据是**失败的后果落在正确性上还是质量上**。embedding 失效会让检索命中错误的语义邻域——
返回的内容本身是错的；rerank 失效只是把本来就召回到的正确候选排得不够好。前者是正确性问题，
后者是质量问题。

**这条理由必须写进 `rerank.ts` 的文件头注释**。§20 那张表是全平台降级档位的参照，下一个读它的
人会默认「TEI 相关 = fail-closed」并照抄——那会让 reranker 容器一挂就把整个知识库拖垮，而
reranker 本就是可选组件。档位判错比没有机制更危险（§18 已有同样的表述）。

具体实现：调用点包 try/catch，异常时返回原序并 `ctx.logger.warn`，不向上抛。

---

## 3. overfetch：rerank 生效的前提

这是最容易在实现阶段漏掉的一环。当前 Consumer 拿到 `topK=5` 就向 Provider 要 5 条，rerank
拿到的候选集**就是最终结果集**，重排不改变返回内容，只改变顺序——收益接近于零。

正确的链路：

```text
Consumer 收到 topK=5
   │
   ├─▶ 向 Provider 请求 topK × overfetchFactor = 15 条（向量粗召回）
   ├─▶ RerankClient 对 15 条打分（cross-encoder 精排）
   └─▶ 按新分数取前 5 条返回
```

`overfetchFactor` 默认 3，可配。

**代价诚实记在此处**：向量检索量变为 3 倍（PG 侧是 HNSW `LIMIT 15` 而非 `LIMIT 5`，Milvus 侧
同理），外加一次 cross-encoder 前向推理。这不是免费的优化，是用两处成本换排序质量。
`overfetchFactor` 的最优值由 §5 的评测决定，不靠拍脑袋——这也是先做评测工具的另一个理由。

**不引入分数阈值**。`minScore` 过滤听起来自然，但阈值取值在没有评测数据前纯属猜测，而猜错的
后果是静默少召回（比多召回更难发现）。本轮先把评测建起来，阈值留待有数据后再议。

---

## 4. 装配与编排

### 4.1 compose

`deploy/compose.local.yml` 新增第二个 TEI 实例，复用现有镜像：

```yaml
  rerank:               # TEI 交叉编码器重排（§5.4.5；可选组件，不配则 Consumer 保持原序）
    image: ghcr.io/huggingface/text-embeddings-inference:cpu-1.6
    container_name: lumo-platform-tei-rerank
    environment:
      MODEL_ID: BAAI/bge-reranker-v2-m3
      PORT: "80"
    ports:
      - "55434:80"
    volumes:
      - tei-rerank-data:/data
```

**实测风险**：`bge-reranker-v2-m3` 约 568M 参数，在 `cpu-1.6` 变体上单次前向明显慢于
`bge-m3` embedding。若 Local-lite 开发机体感不可接受，退到 `BAAI/bge-reranker-base`（约
278M）。这是**配置项而非设计分叉**——两者都走同一个 `/rerank` 端点，`RerankClient` 无需改动。
实际取哪个由 §5 的评测在质量与延迟之间给出依据。

### 4.2 插件配置

`KnowledgeConfig` 新增**可选**字段：

```ts
export interface RerankConfig {
  baseUrl: string
  model: string
  /** 粗召回倍数（默认 3）；1 等价于不重排 */
  overfetchFactor?: number
  timeoutMs?: number
}
```

**不配置 = `NoopRerankClient`**。现有部署（含 Standalone/Cluster 的 Milvus 形态）零影响，
无需同步升级。这是 rerank 作为可选质量增强的直接体现，也与 §2.3 的 fail-open 档位一致。

---

## 5. 离线召回评测

### 5.1 语料与 golden set

语料用**本仓库自己的 `docs/` 中文文档**（`architecture.md`、`roadmap.md`、`design-review.md`）。
选它的理由不是省事，而是它恰好具备纯余弦最容易翻车的特征：

- 中文、术语密集
- **大量近义干扰项**：「网关 / 代理 / seam」「realm / 租户 / 项目」「组件 / 技能 / 流程」
  在语义空间里彼此接近，但在本项目里是**被刻意区分**的不同概念（§14 术语字典就是为此存在的）
- 存在已知的「同一问题有唯一正确出处」结构（§ 编号），标注成本低且客观

`eval/golden.zh.json` 结构：

```json
[
  {
    "id": "g001",
    "query": "换 embedding 模型时为什么不能原地覆盖向量",
    "expectedDocIds": ["architecture#5.4.4"],
    "note": "干扰项：§5.4.2 也谈索引，§5.4.3 也谈重建"
  }
]
```

规模 20–30 条，人工标注，入仓。**每条必须带 `note` 说明干扰在哪**——没有干扰项的 query 检验
不出重排价值，标注时就该被筛掉。

### 5.2 指标

| 指标 | 回答的问题 |
|------|-----------|
| Recall@1 / @3 / @5 | 正确出处进没进前 k 条 |
| MRR | 正确出处平均排在第几位 |
| nDCG@5 | 综合考虑位置的排序质量 |

**不做 BLEU / ROUGE**。WeKnora 的端到端测试含这两项，但它们是**生成质量**指标，而本轮范围
只到检索。把生成指标放进检索评测会让「模型换了导致答案变化」和「召回变差」混在一个数字里，
到时无法归因。

### 5.3 运行方式

```
platform/dsh-plugins/knowledge/eval/
  golden.zh.json      # 标注集
  ingest-corpus.ts    # 按 markdown 标题层级切块入库
  run-eval.ts         # 同一 golden set 跑两遍（rerank on / off），输出对比表
```

`pnpm run kb:eval`，**离线手动跑，不入 CI 门禁**。理由有二：§5.4.4 原文写的就是「离线评测」；
CI 里起 TEI 需要拉约 2GB 模型权重（embedding 与 reranker 各一份），代价与收益不成比例。

输出格式设计成可直接粘进 §5.4.4 的模型切换记录——评测的产物要能当决策依据用，否则跑完
只是一堆终端输出。

`ingest-corpus.ts` 的按标题切块是**本轮唯一触及分块的部分**，且刻意保持朴素：它是评测的
夹具，不是分块策略的实现。真正的分块策略见 §7.3。

---

## 6. 显式命名的已知缺口：TEI 推理成本未入账

`shared/manifests/cost-types.manifest.json` 的闭集中有 `inference.gpu`（单位 `second`）这个
槽位，但**当前 `TeiClient` 的 embedding 调用一次成本事件都没有发出**。本轮新增的
`TeiRerankClient` 同样不发。

§6.4 对自己的要求是：

> 本模块的设计目标不是「捕获全部成本」（不可能），而是：每一行都能归因到原因，且**未捕获的
> 成本被显式命名**而不是静默缺席。未命名的缺口会让读账单的人以为账上就是全部。

**本轮不实现该记账**，但在此**显式命名**这笔缺口，它即是 §6.4 所要求的命名：

- **缺口内容**：TEI 的 embedding 与 rerank 推理算力未产生 `inference.gpu` 成本事件
- **本轮的影响**：rerank 使每次检索多一次 GPU 前向，缺口规模随检索量翻倍
- **不本轮做的理由**：这是与「兑现 §5.4.5 / §5.4.4」并列的**另一笔债**，混入会让本轮验收面
  模糊；且 `cpu-1.6` 变体上「GPU 秒数」的计量口径本身需要单独定义（CPU 推理该记什么单位、
  `inference.gpu` 是否需要拆出 CPU 变体），那是一次独立的口径讨论
- **后续口子**：`RerankClient` 与 `EmbeddingClient` 的调用点是唯一的埋点位置，两者结构同构，
  补记账时只需在两处各加一次事件发射，不需要重构

---

## 7. 与 WeKnora 的关系

### 7.1 本轮借鉴到的具体做法

| 借鉴点 | 出处 | 本轮如何用 |
|--------|------|-----------|
| 粗召回 → 精排两段式 | WeKnora 检索链路 | §3 的 overfetch |
| rerank 作为可插拔独立组件（20 家实现共用一个接口） | `internal/models/rerank/reranker.go` | §2.1 的 `RerankClient` 接口 + Noop 实现 |
| 召回质量可评测 | WeKnora 端到端测试 | §5，但只取检索指标，弃生成指标 |

### 7.2 为什么不整体替换

WeKnora 是自带前后端、用户体系、Space RBAC、会话、ReAct Agent、Wiki 的**完整产品**
（约 25 个 compose 服务）；本项目的知识库是**一个被契约锁住的 seam 加两套引擎实现**
（约 1400 行 TS）。粒度差一个数量级。四条硬冲突：

1. **计量单截面会破**——WeKnora 的 RAG 生成、Wiki 生成、ReAct、问题生成全部自行调用 LLM，
   绕过 llm-gateway，§6.4 的用户树与项目树双扣拿不到这些 token
2. **违反「绝不依赖引擎权限」**（§5.3 第 4/8 条、§5.4.1 硬规矩）——把 realm 映射为它的
   `tenant_id` 等于把授权判断委托给引擎
3. **契约有两条断言它无法满足**——其 `SearchResult`（`internal/types/search.go:151`）无
   `source_version` 字段，而契约断言「不得召回低于当前源版本的投影」；其亦无「按 realm 全量
   重建」语义
4. **功能与 dsh + 本平台大面积重叠**——Agent、会话、IM、模型厂商层、RBAC 各是第二套

若将来需要它的解析与混合检索能力，正确形态是写一个
`WeKnoraKnowledgeProvider implements KnowledgeSeam`，与 `PgKnowledgeProvider` 并列，只调用其
纯检索端点 `POST /api/v1/knowledge-bases/:id/hybrid-search`（该端点支持传
`query_embedding` 预计算向量，故 embedding 仍可留在平台侧，计量截面不被穿透）。**这不属于
本轮范围**，记录于此以免结论丢失。

### 7.3 明确不在本轮的六项

文档解析（PDF/Word/Excel/图片）、分块策略、关键词混合召回、分数阈值、上下文增强（父块与
邻近块回填）、跨 KB 扇出。

这些是**新增能力**而非欠债，且其中前两项应属于一个独立的 ingest 管道设计——§5.4.3 的管道图
里 `chunk` 那一步目前是空的，填它需要决定解析器是自研 Go 服务还是复用外部容器，那是一次
独立的选型讨论。

**分数阈值单独说明**：它看似属于本轮（rerank 后过滤很自然），但阈值取值在无评测数据时纯属
猜测，猜错的后果是静默少召回。本轮先建评测，阈值待有数据后再议（§3 末段）。

---

## 8. 验收标准

1. `shared/seam-contracts/knowledge.ts` 与两套 Provider 的契约测试**一行未改**且全绿——这是
   §1 边界成立的证明；若需要改契约，说明 rerank 被错误下沉
2. `rerank.ts` 单测覆盖：`index` 乱序回填正确、`index` 重复抛、`index` 越界抛、条数不符抛、
   非有限分数抛、超时错误含模型名
3. 降级路径有测试：reranker 返回 5xx / 超时 / 连接被拒三种情况下，`knowledge_query` 与
   `knowledge_graph_query` 均返回向量原序结果而非抛错
4. 未配置 `rerank` 时，两个 Consumer 工具的返回结果与本轮之前完全一致（Noop 路径；含顺序，
   见 §2.1 的排序稳定性要求）
5. `pnpm run kb:eval` 可跑通，输出 rerank on/off 的 Recall@1/3/5、MRR、nDCG@5 对比表
6. 评测结果表明 rerank 开启后 nDCG@5 有提升；**若无提升，本设计的前提就是错的，应当记录该
   否定结论而不是调参数直到好看**
7. `deepseek-harness/` 未被修改：`git -C deepseek-harness describe --tags --dirty` 输出
   `dsh-v0.1.1-rc.2` 且无 `-dirty`

第 6 条是本轮最重要的验收项。评测工具的价值在于它**能给出否定结论**；一个只会说「有提升」的
评测等于没有评测。

---

## 9. 风险

| 风险 | 影响 | 应对 |
|------|------|------|
| CPU 上 cross-encoder 延迟不可接受 | Local-lite 开发体感差 | §4.1 的 `bge-reranker-base` 降档；`overfetchFactor` 调小 |
| golden set 规模小（20–30 条），指标方差大 | 结论不稳，误判 rerank 无效 | 标注时强制每条带干扰项 `note`；同一配置跑多次核对稳定性；结论只看方向不看小数点 |
| 语料是本项目自己的文档，存在过拟合本仓术语的可能 | 评测结论对外部语料泛化性未知 | 在文档中声明该局限；将来接入真实业务语料后重跑 |
| `overfetchFactor` 抬高向量检索成本 | 大 realm 上 PG/Milvus 压力上升 | 由评测确定最小够用值；`seam.query` 成本事件（`rows` 口径）本就会反映该增长，可观测 |

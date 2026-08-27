# DeepSeek Harness 分布式智能体平台 · 设计文档

> **一句话**：在开源 [`dsh`](https://github.com/deepseek-ai/deepseek-harness)（Cordis 驱动的「一切皆插件」智能体框架）之上，**零侵入地**构建组件化、可分发、多智能体协同的分布式平台（Agent Capability PaaS）。

> ## ⛔ 第一铁律
> **严格不改 dsh 源码。** 全部能力只经 dsh 原生扩展点实现：Cordis plugin / bundle / `cordis.patch.yml` / seam / event / profile。dsh 始终以 npm 依赖引入，**绝不 fork / vendor / monkey-patch**。
> **验证判据**：升级 dsh 版本无需 rebase 任何补丁；删除本平台全部代码后，dsh 仍可原样独立运行。

---

## 一、文档地图（共 3 篇）

| 文档 | 内容 | 何时读 |
|------|------|--------|
| **[`architecture.md`](./architecture.md)** | **唯一权威技术规范**（§0–§22）：决策快照、约束、dsh 原生机制、分层与三平面、三大核心机制、数据层（含向量检索 §5.4 与知识库共享编辑 §5.4.7）、控制面、调度面（含多集群调度监控 §7.4）、协同面（含共享执行控制 §8.4）、连接器与 RBAC、**项目与协作工作区（§11.1，产品三入口：项目/专家·技能·连接器/自动化）**、网关与语言、选型总表、术语字典、20 条硬规矩、安全模型（§18）、测试与验证策略（§19）、故障模式目录与降级预案（§20）、SLO 与容量模型（§21）、迁移与回滚（§22） | 需要任何设计结论时 —— **以本篇为准** |
| **[`roadmap.md`](./roadmap.md)** | 实施蓝图与端到端流程（§16–§17）：仓库布局、P0–P4 构建顺序、MVP 建议、五类端到端流程串联验证（含共享编辑 + 多集群监控） | 规划排期与验收时 |
| **[`design-review.md`](./design-review.md)** | 独立评审意见：架构 / 技术选型 / 业务产品三维度，**5 条 P0 风险** + 对新增章节的评审 + 替代落地顺序 + 待补章节 | **实施前必读** |

## 二、阅读路径

| 目的 | 路径 |
|------|------|
| **快速对齐全局**（30 分钟） | `architecture` §0 决策快照 → §3 分层与三平面 → §15 二十条硬规矩 |
| **实施前风险对齐** | `design-review` 第一章（5 条 P0），再回看 `architecture` 对应章节 |
| **准备落地排期** | `roadmap` §16 **并读** `design-review` §5.2（两种顺序，见下方决策状态） |
| **查名词边界** | `architecture` §14 术语精确定义 |
| **查选型理由** | `architecture` §13 选型总表（含已否决备选） |
| **理解 dsh 能给什么** | `architecture` §2 dsh 原生机制 → 上游 `deepseek-harness/docs/architecture.md`、`capability-seams.md`、`cordis-primer.md`（**只读**） |

## 三、最终技术栈一览

```text
内核:        dsh (Cordis) — 零侵入
注册/配置:   Nacos（收敛 etcd + NATS + ConfigDistributor）
消息/A2A:    RocketMQ（事务/延时/幂等）
策略/凭证:   OPA (Rego) / Vault
可观测:      OTel + Prometheus + Grafana + Loki
编排:        Kubernetes + Helm
数据:        PostgreSQL(OLTP/主库) · Doris(OLAP) · Nebula(图/血缘) · Milvus(向量/RAG 召回)
             · MinIO(对象存储:日志冷层/制品/Milvus 后端) · Redis Cluster(热/限流) · TiDB/CRDB(联邦,待决)
知识库:      图 + 向量双 seam —— ctx.knowledge.graph(Nebula) + ctx.knowledge.vector(Milvus)
推理:        dsh 原生 ctx.llm + 批处理网关
网关:        全栈 Go 自研（边缘/LLM/连接器/终端 + 东西向 Seam Proxy），无 APISIX/Envoy
语言:        统一 Go 1.22+（Rust 仅局部热点）
协同多端:    React/TS 终端 + 复制式 SessionEvent 日志事件汇
```

## 三·补、部署形态

| 形态 | 载体 | 组成 | 用途 |
|------|------|------|------|
| **Local-lite** | 本地（1 二进制 + 1 PG 容器） | PG（含 pgvector）+ 进程内队列/缓存 + 本地文件 | 日常开发、组件调试、CI 快速用例 |
| **Standalone** | 本地 Docker / 生产单机 | 同引擎单节点：PG·Redis·MinIO·Milvus·RocketMQ·Nacos | 私有化小规模、POC 转正 |
| **Cluster** | 本地 Docker（缩微）/ 生产 K8s | 完整分布式；**本地缩微 = 自研服务多实例 + 中间件单实例** | 生产；**本地用于调试分布式行为与故障注入** |

- **形态 × 载体是两轴**：本地同样可跑 Standalone 与 Cluster 拓扑（`deploy/compose.*.yml`），同一套镜像与应用配置，只换编排清单。
- **迁移界线**：Local-lite → Standalone 是**重装**（数据一次性）；Standalone → Cluster 是**单向在线升级**（`architecture` §13.2.7）。
- **能力缺失显式拒绝**：Local-lite 无 OLAP/图能力时 seam 返回 `CapabilityUnavailable`，**不得用 PG 模拟**。

详见 `architecture` §13.2。

## 四、决策状态

### 已定案（不再讨论替代方案）

> 评审中原有的「改用其它产品／先用小的顶一顶」类建议已按决策清除，仅保留「怎么做好」的要求。

| 议题 | 决策 | 随之而来的义务 |
|------|------|---------------|
| 向量检索 | **Milvus**（`ctx.knowledge.vector`） | `architecture` §5.4 完整设计；`review` T6 四项义务（依赖边界封死 / Provider 层 realm 强制过滤 / 向量–源一致性 / embedding 版本化） |
| 对象存储 | **MinIO**（`ctx.datastore.object`） | 桶按 realm 隔离、生命周期分级、纠删码多节点部署；**对象存储 seam + 附件 + storage→sql KV 已落地（P2b 项 10/11/12，2026-08-26）**——`@lumo/object-store` 插件注册 `ctx.objectStore`（realm 前缀隔离 / 内容寻址 sha256 / 缺对象 undefined / 不可达 fail-closed）+ `ctx.spillStore` 收敛（溢出内容对象化，跨节点 resume 任意节点取回）；**附件后端（项 10）**：`@lumo/attachments` 的 MinIO 版 `AttachmentStore`（save→ref 是 `<realm>/content/<sha256>` 对象键、同内容同键幂等、读回 digest 校验、NOT_FOUND/CORRUPT/INVALID/fail-closed，键规则锁在 `shared/seam-contracts/attachment.ts`）；**storage→sql KV（项 12）**：`@lumo/storage` 的 PG KV 后端（`PgStorageBackend implements StorageBackend`，`ctx.storage` 收敛到 `ctx.datastore.sql`，与 sqlite 跑同一份 dsh 契约套件，真 PG 全绿）（[`specs/2026-08-26-object-store-design.md`](./superpowers/specs/2026-08-26-object-store-design.md)） |
| 网关 | **全栈 Go 自研**（边缘/LLM/连接器/终端 + Seam Proxy） | `review` R3 的能力清单（抗攻击/弹性/证书/热加载原子性）+ **压测、SLO、故障演练三项上线门槛**；**LLM 网关首切片已落地（P2a 起始项，2026-08-26）**——OpenAI 兼容流式/非流式、provider+费率表、计量单截面跨网（emitter=llm-gateway，与 RocketMQ 计量流全链联测真 broker 收账）、双树执法 Go 镜像（[`specs/2026-08-26-llm-gateway-design.md`](./superpowers/specs/2026-08-26-llm-gateway-design.md)）；限流/batch/路由链/集群形态显式外 |
| 数据层构成 | **PG + Doris + Nebula + Milvus + MinIO + Redis** | `review` T3 的运维准入条件（专职人力 / 容量基线 / 备份恢复演练 / schema 演进 / 降级预案） |
| 制品注册表 | **职责三分：原始字节→内容寻址对象存储、元数据/签名/依赖图→PG、灰度规则→Nacos**。硬约束是 **PG 是索引不是真相源**——执法只认按 digest 取回的原始字节，PG 元数据不得作为任何执法判断的输入 | `architecture` §6.1 已修订；实现见 `platform/control-plane/registry`，设计说明 [`specs/2026-08-24-registry-design.md`](./superpowers/specs/2026-08-24-registry-design.md)；**provisioner / OPA scope 评估 / 密钥轮换与吊销 已设计**（[`specs/2026-08-26-registry-governance-design.md`](./superpowers/specs/2026-08-26-registry-governance-design.md)，实现待 P2） |
| Seam 可远程化边界 | **分级表是准入判据的唯一真相源，未定级即拒绝**。§4.1 原文「任意 seam 可远程化」已收窄：杠杆来自平台新增的能力 seam，不来自搬迁 dsh 原有 seam——白名单里没有一个 dsh 原生 seam，这是结论不是遗漏 | `architecture` §4.1.1–§4.1.2；实现见 `platform/shared/seam-contracts/remotability.ts` + 三道闸，设计说明 [`specs/2026-08-24-seam-remotability-design.md`](./superpowers/specs/2026-08-24-seam-remotability-design.md)；**needs-design 13 项各自的远程形态已设计**（[`specs/2026-08-26-seam-remote-forms-design.md`](./superpowers/specs/2026-08-26-seam-remote-forms-design.md)，含实现顺序 P2a–P3）；**行 5（`ctx.subagents` 跨节点委派）已落地（2026-08-27）**：one-shot spawn 切片——承载节点 `@lumo/subagent-host`（HTTP 放置面）+ 父节点 `@lumo/subagent-remote`（Scheduler 放置 → 承载 start → 回调结集 → 终态上报），真 dsh 双进程冒烟全绿（`dsh-plugins/subagent-remote/smoke-parent.ts`）；fork/continuable seed 传输、预算联动放置随后续切片（P2c）；跨 AZ 预算实测保持待补（需真多 AZ 环境，不可本机模拟）；**行 6（`ctx.jobs` 句柄虚拟化）形态已定稿（2026-08-27）**：`(job) → (sessionRef, node, jobId)` 的 `JobRef` 映射、job 级控制闭集（kill/timeout/status）、结果事件闭集（job/started|output|finished）与 `JobControlSeam` 契约锁在 `shared/seam-contracts/job-virtualization.ts`（11 项契约断言全绿）；实现随控制信号通道（§7.4） |
| 成本归因与预算策略 | **单截面只保留为 token 截面**（B2 明确要求保留）；成本走并行事件流：`cost_type` 闭集 + trace 归因 + 单一写入者。预算树三档行为（软限额/透支/硬停），默认退化与今天一致 | `architecture` §6.4；实现见 `platform/shared/seam-contracts/{cost-events,budget-policy,metering}.ts` + `platform/dsh-plugins/metering`，设计说明 [`specs/2026-08-25-cost-attribution-design.md`](./superpowers/specs/2026-08-25-cost-attribution-design.md)；**PG 侧「本期配额」总额模型已落地**（[`specs/2026-08-26-budget-total-model-design.md`](./superpowers/specs/2026-08-26-budget-total-model-design.md)，2026-08-26）；**事件异步削峰本地等价已落地**（PG 事务 outbox + 进程内调度器，幂等键/事件时刻/批处理，[`specs/2026-08-26-metering-outbox-design.md`](./superpowers/specs/2026-08-26-metering-outbox-design.md)）；**台账列清单单源化**（`shared/manifests/usage-ledger.schema.json`——DDL 与 INSERT 同源生成；Go 消费侧（usage-ledger）将 go:embed 同一文件）；**Doris 聚合已设计**（[`specs/2026-08-26-doris-aggregation-design.md`](./superpowers/specs/2026-08-26-doris-aggregation-design.md)——日分区列式 cube、PG 单向重建、桶级幂等、缺 Doris 显式拒绝；实现随 Doris 进拓扑）；**RocketMQ 传输已落地（Standalone 形态，2026-08-26 实测）**——发布/消费都进 Go（npm 无可用 TS 客户端）：`platform/control-plane/usage-ledger`（publisher：outbox 锁批→broker；consumer：校验→幂等落账；四不变式真 broker e2e 全绿，[`specs/2026-08-26-ledger-rmq-transport-design.md`](./superpowers/specs/2026-08-26-ledger-rmq-transport-design.md)），与 TS 侧 `ledgerTransport` 互斥装配；cluster 多实例/HA 随 helm。待补：Doris 聚合实现 |

| 第五类制品·用户自定义流程 | 用户在项目内定义私有流程（DAG + 防环护栏），FlowReview 审核提升（manager/admin 且非作者——职责分离），audience 定向分发（roles/depts/users，空集恒假），版本快照与回滚（approve 同事务快照，回滚=重指不改写） | `architecture` §11 后半；实现见 `platform/control-plane/flows` + 契约 `shared/seam-contracts/flows.ts`，设计说明 [`specs/2026-08-26-user-flows-design.md`](./superpowers/specs/2026-08-26-user-flows-design.md)；**制品层已落地**（生命周期/审核/定向/回滚，真 PG + compose 冒烟全绿）；执行（FlowEngine）、LLM 生成、Nacos 热下发随 P2 |
| 项目与预算树（N3 拍板） | **项目 = 并行预算树**（2026-08-26 定案）：一次调用同时扣用户树与项目树，任一超限即拒；双树同事务扣减为 TS metering 既有已测行为（口径升格），项目树治理面（创建即种子 `budget_trees kind='project'`）由 projects 服务承担 | `architecture` §6.4/§11.1/§22；实现见 `platform/control-plane/projects` + 契约 `shared/seam-contracts/projects.ts`，设计说明 [`specs/2026-08-26-project-workspace-design.md`](./superpowers/specs/2026-08-26-project-workspace-design.md)；**§11.1 首切片已落地**（项目实体/生命周期/成员角色/用量聚合，真 PG 全绿） |

### 仍待拍板

| # | 议题 | 待决内容 | 出处 |
|---|------|---------|------|
| 1 | **落地首切顺序** | 规范为「Nacos → 自研网关 → 连接器 + DAG」；评审主张**先单节点垂直切片**（一个真实业务组件 + 知识库 seam + 计量）验证产品假设，再上分布式控制面。**技术栈一致，分歧只在顺序。** | `roadmap` §16.3 vs `review` §5.2 |
| 2 | **是否引入 TiDB/CRDB** | 规范自标待决；视多集群联邦需求。**后加远比先加后拆便宜**，建议保持待决 | `architecture` §13.3 |


## 五、待补章节（当前完全缺失）

`design-review` §5.3 列出 5 项规范尚未覆盖、但落地前必须补齐的内容：**安全模型/威胁模型**（尤其提示注入）、**测试与验证策略**、**故障模式目录与降级预案**、**SLO 与容量模型**（全篇无任何数字）、**迁移与回滚**。

> **进度（2026-08-24）**：第 1 项**安全模型/威胁模型**已补为 [`architecture.md`](./architecture.md) **§18**（资产与信任边界、提示注入结构性防护三件套、明确不做的事、未覆盖清单），实现见 `platform/dsh-plugins/provenance`。
> **进度（2026-08-26）**：其余 4 项已全部补齐——**§19 测试与验证策略**（契约双实现、会话日志确定性重放、混沌注入清单、压测规范）、**§20 故障模式目录与降级预案**（D-Refuse / D-Degrade / D-Continue 三姿态 × 18 行目录）、**§21 SLO 与容量模型**（首个数字化章节：并发/延迟/可用性/计量/恢复目标 + 三形态容量模型，目标值以压测与演练为校准）、**§22 迁移与回滚**（dsh 升级、形态迁移、schema 演进规范、不可逆清单）。原始清单保留不删，以便追溯评审出处。

## 六、历史文档

早期 15 篇 addendum 已于重构时删除——其内容 **100% 已并入 `architecture.md`**，保留只会造成口径冲突（早期几篇仍含 `etcd/NATS/ConfigDistributor/APISIX/Envoy` 等**已被推翻**的写法）。

如需查阅原文，从 git 历史取回：`git show 798c37c:docs/<原文件名>`

| 原文档 | 主题 | 现对应章节 |
|--------|------|-----------|
| `deepseek_harness_distributed_design.md` | 总体架构 | `architecture` §1–§4 |
| `deepseek_harness_data_layer.md` | 数据层 | §5 |
| `deepseek_harness_agent_scheduling.md` | 调度面 | §6.2、§7 |
| `deepseek_harness_async_multiterminal.md` | 异步 + 多端 | §8.1、§8.2 |
| `deepseek_harness_registry_bigdata_flow.md` | 注册 + 流程化 | §6.1、§9 |
| `deepseek_harness_connectors_rbac_distribution.md` | 连接器 + RBAC + 分发 | §10 |
| `deepseek_harness_tech_architecture.md` | 技术架构总纲 | 全文整合 |
| `deepseek_harness_nacos_rocketmq_a2a.md` | Nacos + 自动安装 + RocketMQ | §6.1、§6.5、§8.3 |
| `deepseek_harness_token_metering.md` | Token 计量·归因·配额 | §6.4 |
| `deepseek_harness_user_flow_distribution.md` | 用户流程 + 定向分发 | §11 |
| `deepseek_harness_tech_definitions.md` | 术语精确定义 | §14 |
| `deepseek_harness_tech_selection.md` | 技术架构选型 | §13 |
| `deepseek_harness_gateway_tech_selection.md` | 网关技术选型（原含 APISIX/Envoy） | §12（已修订为全自研） |
| `deepseek_harness_lang_selection.md` | 自研语言选型 | §12.3 |
| `deepseek_harness_gateway_no_apisix.md` | 网关全自研修订 | §12 |

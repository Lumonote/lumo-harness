# DeepSeek Harness 分布式智能体平台 · 文档索引

> **权威文档（建议从此读起）**：[`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)
> 它是 15 篇 addendum + 主架构 + 原总纲的**优化整合版**，采用最终决策（Nacos / RocketMQ / 全栈 Go 自研网关 / PG·Doris·Nebula·Redis·分布式DB 作 Seam Provider），并消除了早期文档中 `etcd/NATS/ConfigDistributor/APISIX/Envoy` 等已被推翻的残留口径。单文件、内部一致、去冗余。

> **评审意见**：[`deepseek_harness_design_review.md`](./deepseek_harness_design_review.md)
> 针对 V2 的独立第三方评审——架构 / 技术选型 / 业务产品三个维度，含 5 条 P0 风险与一份替代落地顺序。**不修改 V2 原文**，作为决策输入并列阅读。

## 一、权威整合文档结构（V2）

| 章节 | 内容 |
|------|------|
| §0 | 最终决策快照（统一口径对照表） |
| §1 | 系统上下文、目标、约束 |
| §2 | dsh 原生机制（Cordis/seam/event/SessionEvent 日志/bundle/agentTeams） |
| §3 | 统一分层 L0–L6 + 三平面（控制/数据/协同） |
| §4 | 三大核心机制：Seam 网络化 / 复制式日志 / 组件化契约 + 五类制品 |
| §5 | 数据层：PG/Doris/Nebula/Redis/分布式DB 作 Seam Provider |
| §6 | 控制面：Nacos 注册配置 / Scheduler / OPA+Vault / 计量 / 自动安装 |
| §7 | 调度面：高并发协同调度智能体集群 |
| §8 | 协同面：异步 suspend/resume + 多端 + RocketMQ A2A |
| §9 | 注册与大数据流程化（算子目录 + DAG + 血缘） |
| §10 | 连接器 + RBAC + 智能体分发体系 |
| §11 | 用户自定义流程与定向分发（第五类制品） |
| §12 | 网关技术：全栈 Go 自研（取消 APISIX/Envoy）+ 语言选型（Go 参考 sub2api） |
| §13 | 技术架构选型总表（全栈逐领域 + 一致性 + 拓扑 + 风险） |
| §14 | 术语精确定义（边界字典） |
| §15 | 关键决策与风险（15 条贯穿硬规矩） |
| §16 | 实施蓝图（仓库布局 + P0–P4 + MVP 三连） |
| §17 | 端到端流程（四类串联验证） |
| §18 | 原 15 篇 → V2 章节映射 |

## 二、增量演进记录（原始 15 篇，保留备查）

> 这些文件是逐轮讨论的**演进快照**。其早期几篇（主架构/总纲/数据层/调度/异步）仍含 `etcd/NATS/ConfigDistributor` 口径，网关篇（13）曾含 `APISIX/Envoy`——均已被 V2 与后续决策（文档 8/14/15）推翻。**以 V2 为准。**

| # | 文件 | 当时主题 | 现状态 |
|---|------|----------|--------|
| 1 | `deepseek_harness_distributed_design.md` | 总体架构 + Seam 网络化 + 组件化/分发 | 已并入 V2 §1–§4（注册/消息口径已过期） |
| 2 | `deepseek_harness_data_layer.md` | PG/Doris/Nebula/Redis/分布式DB | 已并入 V2 §5 |
| 3 | `deepseek_harness_agent_scheduling.md` | 调度面 | 已并入 V2 §6.2, §7 |
| 4 | `deepseek_harness_async_multiterminal.md` | 异步+多端 | 已并入 V2 §8.1, §8.2 |
| 5 | `deepseek_harness_registry_bigdata_flow.md` | 注册+流程化 | 已并入 V2 §6.1, §9 |
| 6 | `deepseek_harness_connectors_rbac_distribution.md` | 连接器+RBAC+分发 | 已并入 V2 §10 |
| 7 | `deepseek_harness_tech_architecture.md` | 技术架构总纲 | 已并入 V2 全文 |
| 8 | `deepseek_harness_nacos_rocketmq_a2a.md` | Nacos + 自动安装 + RocketMQ | 已并入 V2 §6.1/§6.5/§8.3 |
| 9 | `deepseek_harness_token_metering.md` | Token 计量·归因·配额 | 已并入 V2 §6.4 |
| 10 | `deepseek_harness_user_flow_distribution.md` | 用户流程+定向分发 | 已并入 V2 §11 |
| 11 | `deepseek_harness_tech_definitions.md` | 技术术语精确定义 | 已并入 V2 §14 |
| 12 | `deepseek_harness_tech_selection.md` | 技术架构选型 | 已并入 V2 §13 |
| 13 | `deepseek_harness_gateway_tech_selection.md` | 网关技术选型（原含 APISIX/Envoy） | 已被 V2 §12 修订为全自研 |
| 14 | `deepseek_harness_lang_selection.md` | 自研语言选型（统一 Go） | 已并入 V2 §12.3 |
| 15 | `deepseek_harness_gateway_no_apisix.md` | 网关全自研修订 | 已并入 V2 §12 |

## 三、最终技术栈一览（V2 口径）

```text
内核:        dsh (Cordis) — 零侵入
注册/配置:   Nacos（收敛 etcd+NATS+ConfigDistributor）
消息/A2A:    RocketMQ（收敛 NATS；事务/延时/幂等）
策略/凭证:   OPA (Rego) / Vault
可观测:      OTel + Prometheus + Grafana + Loki
编排:        Kubernetes + Helm
数据:        PostgreSQL(主库/OLTP) · Apache Doris(OLAP) · Nebula Graph(图/血缘) · Redis Cluster(热/限流) · TiDB/CRDB(联邦,可选)
推理:        dsh 原生 ctx.llm + 批处理网关
网关:        全栈 Go 自研（边缘/LLM/连接器/终端/Seam Proxy），无 APISIX/Envoy
语言:        统一 Go 1.22+（参考 sub2api；Rust 仅局部热点）
协同多端:    React/TS 终端 + 复制式 SessionEvent 日志事件汇
```

## 四、阅读建议

- **快速对齐全局**：读 V2 §0 → §3 → §15（决策快照 + 分层 + 硬规矩）。
- **落地实现**：从 V2 §16.3 MVP 三连切入，配合 §12（网关）/§6.4（计量）/§9（流程）。
- **查名词**：V2 §14 术语字典。
- **查选型理由**：V2 §13 选型总表 + 替代对比。

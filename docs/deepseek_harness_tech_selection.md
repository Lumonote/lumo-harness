# 基于 DeepSeek Harness 的技术架构选型（Addendum 12）

> **【已整合 · 以 V2 为准】** 本文内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§13，请以 V2 为权威版本。

> 配套文档体系第 12 篇。前序 1–11 篇已把"做什么、怎么连、名词指什么"讲清，本篇收口**"每处到底选什么技术、为什么、不选什么、代价是什么"**——以 ADR-lite（决策记录）风格逐领域给出选型理由与权衡，作为实现阶段的权威依据。
> 选型以 addendum 8 的演进为准（Nacos + RocketMQ 收敛），与 addendum 7 总纲的模块分解一一对应。

---

## 0. 选型原则（总纲级约束）

| 原则 | 含义 |
|------|------|
| **内核零侵入** | 一切基于 dsh(Cordis) 的 plugin/bundle/seam/event，不 fork 内核 |
| **收敛而非堆砌** | 能用 Nacos 收掉的（注册+配置）就别再引 etcd+Consul+自研三套 |
| **边界匹配** | 强一致归 PG/TiDB，分析归 Doris，关系/血缘归 Nebula，热态归 Redis |
| **工业级优先** | 选有生产验证、社区活跃、运维成熟的中间件，不追新玩具 |
| **与 dsh 契合** | 优先复用 dsh 原生能力（MCP bridge、host/webserver、session 日志） |

---

## 1. 选型总览表

| 层 | 能力 | **选型** | 主要替代 | 一句话理由 |
|----|------|----------|----------|------------|
| 核心框架 | 插件容器/agent loop | **dsh (Cordis)** | 自研框架 | 原生一切皆插件，seam/event 扩展点齐备，零侵入 |
| 控制面 | 注册+配置中心 | **Nacos** | etcd+Consul+自研 | Naming 发现 + Config 推送 + namespace 联邦三者合一 |
| 控制面 | 异步消息 / A2A | **RocketMQ** | Kafka / NATS / Pulsar | 事务消息 + 延时消息 + 至少一次，A2A 信封天然契合 |
| 控制面 | 策略 / 鉴权 | **OPA** | Casbin / 自研 | 单一策略点，DSL 统一评估工具/步骤/分发/预算 |
| 控制面 | 凭证管理 | **Vault** | KMS / Secret Manager / 环境变量 | 凭证不进 prompt，动态租约 + 审计 |
| 控制面 | 可观测 | **OTel + Prometheus + Grafana + Loki** | 各厂 APM | 标准、可自托管、trace/metric/log 三合一 |
| 控制面 | 编排部署 | **Kubernetes + Helm** | Compose / Nomad | GPU/有状态 workload 编排事实标准 |
| 数据面 | 事务/元数据主库 | **PostgreSQL** | MySQL / TiDB | 强一致、JSONB 灵活、生态成熟 |
| 数据面 | OLAP / 分析 | **Apache Doris** | ClickHouse / StarRocks | 高并发实时聚合 + JOIN 友好，适配报表/血缘分析 |
| 数据面 | 图 / 关系 / 血缘 | **Nebula Graph** | Neo4j / JanusGraph | 分布式原生、水平扩展，知识库层级/业务关系/血缘 |
| 数据面 | 缓存 / 限流 / 热态 | **Redis Cluster** | KeyDB / 单机 | 令牌桶/额度余量/信箱/热缓存统一高速层 |
| 数据面 | 多租户强一致（可选） | **TiDB / CockroachDB** | 单 PG | 仅当跨集群联邦需强一致时引入，非必选 |
| 数据面 | 推理底座 | **DeepSeek harness 原生 (SGLang/vLLM 路线)** | 自研推理 | 复用批处理网关汇聚大 batch |
| 数据面 | 连接器 / MCP | **dsh python/ MCP bridge + 连接器网关** | 自研协议 | 复用原生 MCP 支持，不另造 |
| 协同面 | 多端 / 前端 | **React/TS + dsh host/webserver (+Tauri 桌面)** | 全自研 | 终端只是视图，订阅 session 事件汇；IDE 用 dsh 原生 |
| 协同面 | 流程引擎 | **自研 FlowEngine（DAG，基于 dsh）** | Airflow / 外部编排 | 算子进注册表目录，与 seam/组件同生命周期 |

---

## 2. 逐领域选型详述（ADR-lite）

### 2.1 核心框架：dsh (Cordis)
- **选**：直接采用开源 dsh，所有扩展走 Cordis 插件模型、seam 三件套、event 瀑布。
- **不选**：自研 agent 框架。
- **理由**：seam（接口+Provider+Consumer）、`agent/*`/`tools/*` 事件瀑布、`ctx.agentTeams`、`sessions.fork()`、`agent.inject()` 等现成扩展点覆盖组件化/协同/异步全需求。
- **代价/前提**：dsh 处 v0.1 开发者预览，API 会变 → 所有改动收敛到 plugin/bundle/patch 层，只依赖稳定语义（全局硬规矩 1）。

### 2.2 注册+配置中心：Nacos
- **选**：Nacos 同时承担 Naming（发现+心跳+元数据）与 Config（热下发）。
- **不选**：etcd + Consul + 自研 ConfigDistributor 三套。
- **理由**：① 节点/实例/能力/制品注册统一进 Naming；② 配额/限流/audience/灰度/OPA bundle 存 Config 热加载；③ namespace 原生支持跨集群联邦与 realm 隔离。
- **代价**：引入一个 Java 中间件；强一致依赖 Nacos Raft（CP 模式），心跳快路径用 ephemeral 实例 TTL。
- **边界**：Nacos 是"寻址+规则"源，**不是事务真相源**——计费明细仍落 PG。

### 2.3 异步消息 / A2A：RocketMQ
- **选**：RocketMQ 作统一异步骨干，主题模型 `team.*`/`agent.*`/`event.*`/`trigger.*`/ `usage.event.*`。
- **不选**：Kafka（缺原生事务/延时消息语义适配 A2A 协同）、NATS（轻量但事务/延时弱）、Pulsar（能力强但运维重）。
- **理由**：① **事务消息**保"扣配额+发信"原子（UsageLedger 场景）；② **延时消息**原生异步唤醒（部分替代 cron，呼应 addendum 4 Trigger Bus）；③ 至少一次投递 + correlationId 做 A2A 信封；④ 与 dsh `ctx.agentTeams` mailbox/task board backing 契合。
- **代价**：需保证**消费幂等**（msgId/correlationId 去重，全局硬规矩 7）；RocketMQ 不是存储，会话真相仍在复制日志。

### 2.4 事务/元数据主库：PostgreSQL
- **选**：PG 存平台元数据、权限、计费明细 ledger、组织树、流程 manifest/版本/审核、配额与限流策略定义。
- **不选**：MySQL（JSON/扩展弱）、单文件 sqlite（dsh 默认，无法跨节点共享）、TiDB（过度，除非要跨集群强一致）。
- **理由**：强一致 + 事务 + JSONB 灵活 + 生态成熟，是"真相源"首选。
- **边界**：PG **不是分析库**——聚合报表进 Doris；权限/计费不可放 Doris（全局硬规矩）。

### 2.5 OLAP / 分析：Apache Doris
- **选**：Doris 作数据分析主算力（重聚合/即席）+ Session 日志冷存 + 流程运行/计量聚合 cube。
- **不选**：ClickHouse（聚合极强但 JOIN/实时更新偏弱、运维复杂）、StarRocks（能力近但生态/案例相对少）、Druid（偏时序预聚合）。
- **理由**：高并发实时聚合 + 多表 JOIN 友好 + 兼容 MySQL 协议易接入，适配部门/角色/功能多维报表与血缘分析。
- **代价/边界**：**Doris 非事务库**，最终一致；坏 SQL 需 Seam Provider 层 sanitize（参数化 + OPA 行级权限 + 限流 + 禁 DROP/全表扫）。

### 2.6 图 / 关系 / 血缘：Nebula Graph
- **选**：Nebula 存知识库图层级、业务关系/协同网、流程血缘。
- **不选**：Neo4j（单机/因果集群扩展受限、超大规模成本高）、JanusGraph（依赖外部存储、运维重）。
- **理由**：分布式原生、水平扩展、与图 schema 早设计契合知识库质量天花板。
- **代价**：图 schema 需早设计；图写入最终一致。

### 2.7 缓存 / 限流 / 热态：Redis Cluster
- **选**：Redis 作 Session 日志热层、agent 信箱/`ctx.goals` 热态、令牌桶限流、额度周期余量、特征/向量缓存。
- **不选**：单机 Redis（无水平扩展）、KeyDB（兼容性替代，生态弱）。
- **理由**：亚毫秒、数据结构适配令牌桶/集合/流；与 dsh 原生 `agent.inject()` 热态协同。
- **边界**：Redis 是热缓存与高速计数，**不是真相源**（真相在 PG + 复制日志）。

### 2.8 多租户强一致（可选）：TiDB / CockroachDB
- **选（条件性）**：仅当跨集群联邦需要全局强一致（如多区域计费对账）时引入。
- **不选（默认）**：单 PG 已覆盖绝大多数场景。
- **理由**：避免过早引入分布式事务复杂度；默认用 PG + realm 隔离即可。
- **决策原则**：**先 PG，遇到跨集群强一致瓶颈再上**，不要预支复杂度。

### 2.9 策略 / 鉴权：OPA
- **选**：OPA 作单一策略点，统一评估 `tools/pre-execute`/`agent/pre-step`/注册表写入/连接器 egress/`flow.approve`/预算。
- **不选**：Casbin（模型偏 RBAC、跨维度弱）、自研 if-else（不可审计、分散）。
- **理由**：声明式 Rego、策略与代码解耦、可热更新（Nacos 下发 bundle）、审计友好。

### 2.10 凭证管理：Vault
- **选**：Vault 存所有外部系统凭证，连接器网关按需动态获取。
- **不选**：环境变量（无法轮转/审计）、云 Secret Manager（绑定厂商）、硬编码（绝不允许）。
- **理由**：动态租约 + 自动轮转 + 审计日志；凭证**永不进 prompt**（全局硬规矩 4）。

### 2.11 可观测：OTel + Prometheus + Grafana + Loki
- **选**：OpenTelemetry 采集（trace/metric）、Prometheus 存指标、Grafana 看板、Loki 存日志。
- **不选**：各厂闭源 APM（锁定、贵）。
- **理由**：标准、自托管、与 trace context 透传（addendum 9）天然衔接，多端用量看板复用 Grafana。

### 2.12 编排部署：Kubernetes + Helm
- **选**：K8s 编排控制面/数据面/agent worker，Helm 管理发布。
- **不选**：Docker Compose（无调度）、Nomad（生态弱于 K8s）。
- **理由**：GPU 节点（IB/RDMA）、有状态存储（PG/Doris/Nebula/Redis）、无状态 agent worker 统一编排。

### 2.13 推理底座：DeepSeek harness 原生
- **选**：复用 dsh 推理链路 + 自建 LLM 批处理网关（汇聚并发为大 batch）。
- **不选**：自研推理服务。
- **理由**：MoE sparsity 需超大 batch 才喂饱 expert；批处理网关是吞吐命脉（全局硬规矩 3）。

### 2.14 连接器 / MCP：dsh python/ MCP bridge
- **选**：连接器走 dsh 原生 `python/` 的 MCP bridge 注册进 `ctx.tools`，外覆连接器网关做治理。
- **不选**：另造协议。
- **理由**：复用原生 MCP 支持，零侵入内核（全局硬规矩 6 自动安装 reconcile）。

### 2.15 多端 / 前端：React/TS + dsh host/webserver
- **选**：web 用 React/TS 订阅 session 事件汇；IDE 用 dsh 原生 host/webserver；桌面可选 Tauri 包装。
- **理由**：终端只是视图，连接即 replay + live push（addendum 4）；能力协商按 `ConversationNodeDefinition` 选渲染。

### 2.16 流程引擎：自研 FlowEngine（基于 dsh）
- **选**：自研 DAG FlowEngine，算子进注册表目录。
- **不选**：Airflow（重、调度模型不匹配 agent 协同）、外部编排（脱离 seam 生命周期）。
- **理由**：算子即组件、与 seam/组件/技能同生命周期、血缘写 Nebula。

---

## 3. 一致性模型选型（CAP 取舍）

| 数据 | 一致性 | 选型依据 | 代价 |
|------|--------|----------|------|
| 注册/权限/配额/计费明细 | **强一致** | Nacos Raft + PG/TiDB | 写入延迟略高，可接受 |
| Session 日志复制 / 分析聚合 / 图写入 / 血缘 | **最终一致** | 复制日志 + Doris + Nebula | 短暂不一致窗口，靠幂等/版本化解 |
| 限流/额度余量（高速） | **最终一致（Redis）** | 强一致以 Redis 为准防超花 | Redis 故障需降级策略 |

> 铁律：**真相源永远在 PG + 复制式 Session 日志**；Doris/Nebula/Redis 是派生层，绝不能反向充当事务真相。

---

## 4. 部署拓扑与资源画像

```
┌─────────────── 控制面节点 (3×, Nacos/OPA/Scheduler, CP 模式) ───────────────┐
├─────────────── 存储节点 (PG主从 / Doris BE×N / Nebula / Redis Cluster) ─────┤
├─────────────── GPU 推理节点 (IB/RDMA, DeepSeek harness, 批处理网关) ─────────┤
├─────────────── K8s worker (agent worker / capability node / 连接器网关) ─────┤
└─────────────── 边界 (Terminal Gateway / Connector Gateway / LLM 网关) ───────┘
        消息骨干: RocketMQ (NameServer + Broker 集群)
        可观测:   OTel Collector → Prometheus + Loki → Grafana
```

- **控制面 3 节点**：Nacos（CP）、OPA、Scheduler、计量/分发服务，跨 AZ 部署。
- **GPU 节点**：推理底座，IB/RDMA 互联，按昼夜弹性（呼应 DeepSeek 官方 PD 分离）。
- **存储分层**：PG（事务）/ Doris（分析）/ Nebula（图）/ Redis（热）各成集群。
- **无状态 worker**：agent slot 池，崩溃后任务从复制日志 resume。

---

## 5. 风险与未决项（Open Questions）

| 项 | 状态 | 缓解 |
|----|------|------|
| Doris 非事务库，坏 SQL 拖垮集群 | 已知 | Seam Provider 层 sanitize + OPA 行级权限 + 限流 |
| RocketMQ 至少一次 → 重复消费 | 已知 | msgId/correlationId 幂等去重（硬规矩 7） |
| dsh v0.1 API 不稳定 | 已知 | 只依赖稳定语义，改动收敛 plugin 层（硬规矩 1） |
| Nebula 图 schema 设计不当 | 待决 | 早期建模评审，图 schema 作为知识库质量天花板 |
| 是否引入 TiDB/CRDB | 待决 | 默认 PG；出现跨集群强一致瓶颈再上 |
| 批处理网关与 dsh 推理演进适配 | 待决 | 网关做适配层，隔离 dsh 内部变化 |
| 多区域数据驻留合规 | 待决 | realm ↔ Nacos namespace + 区域化存储策略 |

---

## 6. 与既有文档对应

| 文档 | 用到的关键选型 |
|------|----------------|
| 1 总体架构 | dsh/Cordis、Seam Proxy |
| 2 数据层 | PG / Doris / Nebula / Redis |
| 3 调度面 | K8s、RocketMQ、Redis（限流） |
| 4 异步+多端 | RocketMQ、复制日志、React/TS |
| 5 注册+流程化 | Nacos、自研 FlowEngine、Nebula（血缘） |
| 6 连接器+RBAC | 连接器网关、OPA、Vault、MCP |
| 7 总纲 | 全栈模块分解 |
| 8 Nacos+MQ A2A | Nacos、RocketMQ |
| 9 计量配额 | PG(明细)/Doris(聚合)/Redis(限流)、Nacos(规则) |
| 10 用户流程分发 | Nacos Config(audience)、OPA、FlowEngine |
| 11 术语字典 | 本篇为其提供"选型依据"层 |

---

## 7. 体系位置（十二篇闭环）

| 文档 | scope |
|------|-------|
| 1 总体架构 | 分层 + Seam 网络化 + 组件化/分发 |
| 2 数据层 | PG/Doris/Nebula/Redis/分布式DB |
| 3 调度面 | 高并发协同调度 |
| 4 异步+多端 | suspend/resume、future、终端事件汇 |
| 5 注册+流程化 | 注册表 + DAG 流程引擎 + 算子目录 |
| 6 连接器+RBAC+分发 | 外部连通 + 角色权限 + 分发体系 |
| 7 技术架构总纲 | 统一分层 / 模块分解 / 蓝图 |
| 8 Nacos+自动安装+RocketMQ A2A | 注册配置中心 + 自动装配 + 多 agent 可靠协同 |
| 9 Token 计量·归因·配额 | 功能级计数 + 人/部门/角色归因 + 平台溯源 + 限流/限额度 |
| 10 用户流程+定向分发 | 用户自定义流程 → 审核提升通用 → audience 定向分发 |
| 11 技术术语精确定义 | 网关/Proxy/三平面/五制品/注册配置/调度/配额限流/溯源审计 字典 |
| **12 技术架构选型（新）** | **Nacos/RocketMQ/PG/Doris/Nebula/Redis/OPA/Vault/K8s 逐领域选型理由与替代对比** |

至此体系从"架构 → 数据 → 调度 → 协同 → 注册 → 连接器 → 总纲 → 消息 → 计量 → 流程 → 术语"，**补上了最关键的「选型决策」一层**：每项技术都讲清了选谁、为何、弃谁、代价。后续实现阶段可直接据本篇定栈、据术语字典（11）定名、据各层文档定结构。

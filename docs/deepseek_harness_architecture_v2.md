# 基于 DeepSeek Harness（`dsh`）的分布式智能体平台 · 技术规范总纲 V2（优化整合版）

> **对象**：开源 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，MIT，v0.1 开发者预览），由 Cordis 驱动的「一切皆插件」框架。
> **目标**：在 `dsh` 之上（不改其源码）做**大规模分布式集群化扩展**，落地数据分析 / 知识库 / 业务协同**组件化**、**技能分发**、**业务智能体分发协同**，并补齐注册配置、调度、异步多端、计量配额、流程编排、连接器与权限等完整平台能力。
> **方法铁律（第一铁律）**：**严格不改 DeepSeek Harness（dsh）源码**，全部能力通过 dsh 原生扩展点（plugin / bundle / `cordis.patch.yml` / seam / event / profile）实现；dsh 始终以 npm 依赖引入，绝不 fork / vendor / 改内部实现。
> **本文性质**：整合原 15 篇 addendum 与《总体架构》《技术架构总纲》《索引》为**一份内部一致、去冗余、采用最终决策的技术规范**。消除了早期文档中 `etcd/NATS/ConfigDistributor/APISIX/Envoy` 等已被后续决策推翻的残留口径。

---

## 0. 最终决策快照（全文统一口径）

| 维度 | 原早期方案 | **V2 定稿** | 依据文档 |
|------|-----------|-------------|----------|
| 注册 + 配置 | etcd + Redis 心跳 + ConfigDistributor | **Nacos**（Naming 发现 + Config 热下发 + namespace 联邦） | §6.1 / 定稿文档 8 |
| 消息 / A2A / 事件 / Trigger | NATS JetStream | **RocketMQ**（事务/延时消息 + A2A 信封 + 幂等） | §8.3 / 定稿文档 8 |
| 网关 | 边缘 APISIX + 东西向 Envoy + 业务层部分 Node/TS | **全栈 Go 自研**（边缘 + LLM/连接器/终端 + 东西向 Seam Proxy，零外部网关中间件） | §12 / 定稿文档 14/15 |
| 自研语言 | 未统一（含 Node/TS） | **统一 Go 1.22+**（参考 sub2api：Gin+Ent+PG+Redis），Rust 仅局部热点 | §12.3 / 定稿文档 14 |
| 数据层 | PG/Doris/Nebula/Redis/分布式DB 作 Seam Provider | 不变，全部作远程 Seam Provider，组件只声明 `consumes` | §5 |
| 策略 / 凭证 | OPA / Vault | 不变 | §6.3 |

> 一句话：**内核是 Cordis 的 seam/event/profile，控制面收敛为 Nacos + RocketMQ + OPA + Vault + Go 自研网关，数据面把 PG/Doris/Nebula/Redis/分布式DB 包装成 Seam Provider，协同面走复制日志 + 异步多端 + RocketMQ A2A——全程零侵入 dsh 内核。**

---

## 1. 系统上下文、目标与约束

- **定位**：在开源 `dsh` 之上构建**组件化、可分发、多智能体协同**的分布式智能体平台（Agent Capability PaaS）。
- **关键约束（最高优先，任何设计不得违反）——严格不改 dsh 源码**：
  - **禁止**：修改 dsh 仓库内任何源文件；fork / vendor 后改内部实现；monkey-patch / 覆写 Cordis 内核或 `packages/*` 内部函数；向 `packages/core`、`packages/agent-loop`、`packages/session` 等注入补丁代码。
  - **允许（唯一合法扩展方式）**：以独立包/仓库编写 Cordis 插件，仅 import dsh 公开 API；经 `ctx.*` 注册 service / event / seam provider；用 `cordis.patch.yml` 叠加配置；用 `isolate` realm 组合 preset；把 dsh 作为 npm 依赖安装。
  - **验证判据（如何证明未改源码）**：`dsh` 始终以 `npm/pnpm` 依赖引入（不 vendored）；升级 dsh 版本无需 rebase 任何补丁、无冲突；删除我们全部平台代码后，dsh 仍可原样独立运行。
- **开发范式（插件式优先）**：**所有业务/能力功能尽量插件式开发**——组件、技能、智能体、连接器、流程、各 seam 的 Provider/Consumer 一律作为 Cordis plugin / bundle 挂载，复用 `ctx.*` / seam / event；**例外是「后台控制面服务」与「集群化基础设施」**（Scheduler / 网关 / SeamProxy / 计量 / FlowEngine / TriggerBus / AgentTeams backing / Nacos / RocketMQ / K8s / 数据引擎等），它们是独立 Go 服务或外部中间件，不塞进 dsh 插件（分界详见 §3.1）。
- **非目标**：不重写推理引擎（DeepSeek 推理系统另算，仅作为 `ctx.llm` 的远端 Provider）；不做通用低代码 BI（只做 agent 可编排的数据流）。
- **核心判读**：`dsh` 缺的不是「能不能做分布式」，而是**控制面**（注册/调度/治理/可观测）与**把 seam 变成网络可达**。这两点补上，「组件化 / 分发 / 跨节点协同」全是水到渠成的 extension。

---

## 2. dsh 原生机制（必读地基）

`dsh` 一句话概括：**「一切皆插件」，由 Cordis 驱动的共享 Context；能力通过 seam（能力接缝）解耦，行为通过事件瀑布扩展，状态通过 append-only 的 SessionEvent 日志沉淀。**

| 机制 | 作用 | 关键标识 |
|------|------|----------|
| **Cordis Context** | 插件贡献 service、typed event、可逆 effect；无特权内核，挂载即扩展，卸载即回收 | `ctx.*` |
| **Core services** | 各能力挂载点 | `ctx.llm` `ctx.tools` `ctx.agents` `ctx.agentLoop` `ctx.sessions` `ctx.systemPrompt` `ctx.scope` `ctx.jobs` `ctx.goals` `ctx.fs` `ctx.shell` `ctx.subprocess` `ctx.sandbox` `ctx.terminals` `ctx.commands` |
| **Capability Seam** | 可替换能力 = 三件套：**Service Definition（接口）+ Service Provider（实现）+ Consumer（消费，多为模型可见工具）** | ADR 0009 |
| **Event 瀑布** | `agent/pre-step` `agent/request` `llm/stream` `tools/pre-execute` `tools/execute` `tools/post-execute` 必须 `next()`；`agent/turn-stopping` 串行无 next | `agent/*` `tools/*` `fs/*` `telemetry/*` |
| **SessionEvent Log** | 模型可见即日志；`deriveMessages()` 投影历史；fork/resume/审计全派生自此流 | `ctx.sessions.fork()` |
| **Profiles / Bundles** | 运行的 dsh = 按层组合的插件树；bundle 是「Cordis 配置行 + 挂载代码」的分发格式，可被上层 patch | `dsh --profile web --dump-config` |
| **Agent Teams（实验）** | `ctx.agentTeams` 上的私有协调 seam：持久花名册 + 任务板 + 信箱，建立在可续跑 subagent 之上 | `packages/experimental/agent-team` |

**需求 ↔ dsh 原生扩展点映射：**

| 你要的能力 | dsh 里该挂哪里 | 当前缺口 |
|------------|----------------|----------|
| 数据分析组件化 | 组合 `ctx.tools` + `ctx.jobs`（后台计算）+ `ConversationNodeDefinition`（可视化）+ `ctx.goals` | 无「组件」层概念 |
| 知识库组件化 | 以插件定义 `ctx.knowledge` seam（ingest/query + 向量库 Provider + RAG Consumer），复用 dsh 已有 seam 注册机制，不改源码 | 无现成 seam，需自建插件 |
| 业务协同组件化 | `ctx.goals`（目标）+ `agent/*`（拦截/停转）+ 审批 policy seam + `ctx.agentTeams`（交接） | 无流程/审批 seam |
| 技能分发 | 技能本就是 `.agents/skills/` 文件 → 包成 bundle + manifest + 签名 | 无 registry/版本/灰度 |
| 业务智能体分发协同 | Agent = agent preset/profile（`isolate` realm 隔离）+ 组件/技能引用 | 无 Agent Registry、无跨节点协同 |

---

## 3. 统一架构分层（L0–L6 + 三平面）

```text
┌──────────────────────────────────────────────────────────────────────────┐
│ L6 业务应用层   业务工作台 / 行业方案 / 人机协同终端(web/CLI/IDE/mobile/API) │
├──────────────────────────────────────────────────────────────────────────┤
│ L5 分发与治理层  Registry(Nacos) ｜ RBAC/OPA ｜ UsageLedger ｜ 灰度 ｜ 市场  │
├──────────────────────────────────────────────────────────────────────────┤
│ L4 智能体编排层  agent/* 事件 ｜ ctx.agentTeams(分布式) ｜ ctx.goals ｜ 协同  │
├──────────────────────────────────────────────────────────────────────────┤
│ L3 技能层       Skill=bundle+签名+版本+scope ｜ 技能市场 ｜ 用户流程(第五类)   │
├──────────────────────────────────────────────────────────────────────────┤
│ L2 能力组件层   数据分析组件 ｜ 知识库组件 ｜ 业务协同组件 ｜ 连接器组件 ｜ 流程 │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 分布式运行时  dsh 节点集群(gateway/agent/capability/storage)            │
│    ├ DistributedSeamProxy(Go)  ├ Replicated SessionEvent Log(Redis热+冷)  │
│    ├ RocketMQ(A2A+事件+Trigger) ├ FlowEngine(DAG) ├ TriggerBus             │
│    └ Scheduler(放置/并发闸) ｜ 边缘/业务网关(Go) ｜ Provisioner(自动安装)    │
├──────────────────────────────────────────────────────────────────────────┤
│ L0 资源层        GPU/CPU(IB/RDMA) ｜ PG/Doris/Nebula/Redis/分布式DB ｜ K8s  │
└──────────────────────────────────────────────────────────────────────────┘
        横切控制面: Nacos(注册/配置) ｜ OPA(策略点) ｜ Vault(凭证) ｜ OTel(可观测)
        横切协同面: RocketMQ ｜ 复制式 SessionEvent 日志 ｜ agentTeams
```

**三平面划分（命名权威见 §14）：**

| 平面 | 职责 | 关键组件 |
|------|------|----------|
| **控制面（Control Plane）** | 谁在哪、谁能干、怎么调度、怎么计量治理 | Nacos / Scheduler / OPA / Vault / UsageLedger / Provisioner / FlowEngine / TriggerBus / AgentTeams backing / 三类网关 |
| **数据面（Data Plane）** | 实际执行 agent 任务、跑流程、连外部 | dsh 节点（gateway/agent/capability/storage）+ Seam Proxy + 各 Seam Provider |
| **协同面（Collaboration Plane）** | 多 agent / 多人 / 多端协作 | 复制式 SessionEvent 日志 + RocketMQ A2A + 异步 suspend/resume + 多端事件汇 |

### 3.1 开发范式分界（插件式 vs 独立服务）

> **原则：业务/能力尽量插件式；后台与集群化独立。** 这条与「严格不改 dsh 源码」协同——插件式能力零侵入地挂在 dsh 上，后台/集群化则完全在 dsh 之外，二者都不碰 dsh 内核。

| 类别 | 开发范式 | 载体 | 说明 |
|------|---------|------|------|
| 数据分析 / 知识库 / 业务协同组件 | **插件式** | Cordis bundle | 组合 `ctx.tools` / `ctx.jobs` / seam / `ConversationNodeDefinition` |
| 技能 Skill | **插件式** | bundle + `skill.yaml` | 注册进 `ctx.tools` |
| 智能体 Agent | **插件式** | preset / profile（`isolate` realm） | 组合组件/技能引用 |
| 连接器 Connector（tool surface） | **插件式** | 注册进 `ctx.tools` | 治理走 ConnectorGateway |
| 流程 Flow（编排逻辑 / 算子） | **插件式** | `ConversationNodeDefinition` + 算子目录 | 执行走 FlowEngine |
| 各 seam 的 Provider / Consumer | **插件式** | seam 三件套 | Provider 可远程（经 SeamProxy） |
| —— 例外：后台 + 集群化 —— | **独立服务 / 中间件** | Go 服务 / 外部中间件 | 不塞进 dsh 插件 |
| 控制面（Scheduler / 计量 / Provisioner / FlowEngine / TriggerBus / AgentTeams backing） | 独立 Go 服务 | — | 跨节点 / 强一致 / 统一 Go |
| 网关（边缘 / LLM / 连接器 / 终端）+ SeamProxy | 独立 Go 服务 | — | 深度 hook dsh 语义但自身独立 |
| 集群化基础设施（Nacos / RocketMQ / K8s / PG / Doris / Nebula / Redis / 复制日志存储） | 外部中间件 | — | 平台骨架 |

**为什么这样分（opinionated）**：
- **业务能力插件化** → 复用 dsh 的 seam/event/ctx，天然可组合、可分发、可灰度、零侵入内核、随 dsh 平滑升级。
- **后台/集群化独立** → 它们需要跨节点一致性、高吞吐、统一 Go（与 dsh 的 Node/TS 解耦）、不依赖 dsh 进程生命周期；硬塞进 dsh 插件会（a）可能被迫改 dsh 源码、违反铁律，（b）无法独立扩缩容，（c）语言割裂。

---

## 4. 三大核心机制（分布式杠杆）

### 4.1 Seam 网络化（DistributedSeamProxy）—— 最高杠杆

dsh 文档明言：把 filesystem/subprocess 的 Provider 指向远程沙箱，Bash/PTY/LSP 会一并迁移且**无需 provider 分叉**。把它泛化：**让任意 seam 的 Provider 可落在远端节点**。

- Provider 仍按原生三件套声明接口，但可注册为「远程 Provider」：本地挂一个 Go proxy，把调用经 gRPC/QUIC 路由到远端节点的真实 Provider，**Consumer 代码零改动**。
- 知识库、数据分析、工具执行、GPU 推理都能作为「远程 seam」被任意节点消费；复用 `isolate` realm 做租户/节点归属。

```text
本地节点                                 远端 capability 节点
Agent ──ctx.tools/query──▶ Seam Proxy ──gRPC──▶ Knowledge Provider
   (Consumer 不变)           (Go 自研)            (真实 Provider, 原生实现)
```

### 4.2 复制式 SessionEvent 日志（共享真相）

- 原生：`core/session` 是 append-only 日志，`deriveMessages()` 投影历史，`ctx.sessions.fork()` 复制会话。
- 平台层扩展（不改 dsh 源码）：订阅 dsh 已广播的 `session/event`，把日志**按 segment 复制到集群**（Redis 热层 + 对象存储/Doris 冷层），让 agent 可跨节点 resume/migrate，并让多智能体协同拥有共享的持久状态。
- 收益：审计天然完备（「模型可见即日志」）；fork 升级为**跨节点 fork**；多端一致性唯一 reconcile 源。

### 4.3 组件化契约 + 五类制品

**插件 vs 组件**：plugin 是 Cordis 代码（service/event）；**组件是业务面的一等制品**——把若干 plugin / skill / seam 编排成带 manifest、可版本化、可分发、有标准 I/O 契约的整体，以 bundle 挂载，对内核零侵入。

**五类制品（互相引用、互不越界）：**

| 制品 | 含义 | 消费/提供 |
|------|------|-----------|
| 组件 Component | 原子业务能力（数据分析/知识库/业务协同） | 提供 `dsh.component.*`，消费数据 seam |
| 技能 Skill | 能力包（prompt + 工具 + 策略） | 注册进 `ctx.tools` |
| 智能体 Agent | 角色（preset + 组件/技能引用 + policy） | 被 Scheduler 部署 |
| 连接器 Connector | 外部系统桥（API/MCP/SaaS/消息） | 注册进 `ctx.tools`，走 ConnectorGateway |
| 流程 Flow | DAG 编排（用户自定义或通用） | 经 FlowEngine 执行，引用算子/组件 |

**Component Manifest 示例：**

```yaml
apiVersion: dsh.component/v1
kind: Component
metadata:
  name: sales-funnel-analysis
  version: 1.4.0
  signature: ed25519:<sig>
  scopes: [data:read:warehouse, kb:query]
spec:
  requires: { gpu: false, knowledge: sales-kb, dataNode: [doris, nebula] }
  seams: { provides: [dsh.component.analysis], consumes: [ctx.knowledge, ctx.jobs] }
  io: { input: { ref: DataRef, params: FunnelParams }, output: { result: AnalysisResult, view: ConversationNode } }
  consumes:                          # 数据 seam 契约（声明式一致性）
    - seam: ctx.datastore.olap; consistency: eventual
    - seam: ctx.knowledge.graph; consistency: strong
    - seam: ctx.cache
  wires: { tools: [tool-funnel-query], nodes: [node-funnel-chart], jobs: [job-funnel-compute] }
```

---

## 5. 数据层（PG / Doris / Nebula / Redis / 分布式DB 作 Seam Provider）

> **定调**：这些系统不是「底座替换」，而是 capability 节点上的**远程 Seam Provider**；组件只声明 `consumes` 哪种数据 seam，绝不直连引擎。换 ClickHouse/StarRocks 只换 Provider，组件与 agent 零改动。

### 5.1 能力分层与 Seam 映射

| 系统 | 提供的 seam | 一致性 | 双重角色 |
|------|-------------|--------|----------|
| **PostgreSQL** | `ctx.datastore.sql` | 强一致 | ① 平台元数据/权限主库 ② 业务 OLTP 源 |
| **Apache Doris** | `ctx.datastore.olap` | 最终一致 | ① 分析组件主算力 ② Session 日志冷存/用量分析 |
| **Nebula Graph** | `ctx.knowledge.graph` | 强一致(单图内) | ① 知识库图层级 ② 业务关系/血缘/协同网 |
| **Redis Cluster** | `ctx.cache` | 最终一致 | ① 热共享态(信箱/goals/日志热层) ② 特征/向量缓存 |
| **分布式 DB (TiDB/CRDB)** | `ctx.datastore.txn` | 强一致 | ① 多租户系统记录 ② 跨集群联邦一致源 |

### 5.2 平台自身元数据 backing 推荐

| 控制面子系统 | 存储 | 理由 |
|--------------|------|------|
| Registry 元数据 / 权限 / realm | **PostgreSQL** | 强一致、关系建模 |
| Usage Ledger（明细/计费） | **PostgreSQL** | 计费需准确事务 |
| Usage Ledger（分析看板） | **Doris** | 海量用量 OLAP |
| SessionEvent 日志（热/冷） | **Redis / Doris+对象存储** | 低延迟 replay + 列存检索 |
| agentTeams / goals（热/冷） | **Redis / PostgreSQL** | 协同低延迟 + 持久 |
| 知识库图层级 / 血缘 | **Nebula Graph** | 关系遍历 |
| 跨集群联邦一致源 | **TiDB / CRDB / PG 逻辑复制** | 强一致 + 多写 |

### 5.3 治理铁律（数据层）

1. **组件绝不直连数据库**——一律走 seam。
2. **Doris 不是事务库**：权限/计费/订单放 PG 或分布式 DB，Doris 只做分析。
3. **声明式一致性**：组件标 `consistency: strong|eventual`，调度器据此选引擎。
4. **查询安全是底线**：LLM 生成的 SQL/Graph 查询必须在 Seam Provider 层 sanitize（参数化 + OPA 行级权限 + 限流 + 禁 `DROP`/全表扫）。
5. **冷热分层**：热态走 Redis，落库/分析走 Doris/PG。
6. **Nebula 建模要早做**：图 schema 是知识库与血缘的质量天花板。

**典型「经营分析」组件 = 跨多引擎 pipeline（全部经 seam）：**
`PostgreSQL(源) → ctx.jobs(ETL) → Doris(聚合) → Nebula(关系) → Redis(缓存) → ctx.llm(合成) + ConversationNodeDefinition(可视化)`。

---

## 6. 控制面（Nacos + Scheduler + OPA + Vault + 计量 + 自动安装）

### 6.1 Nacos 注册 / 配置中心（收敛 etcd + NATS + ConfigDistributor）

| 能力 | 原三件套 | **Nacos** |
|------|----------|-----------|
| 服务发现 + 健康 | etcd lease + 自研心跳 | **Naming**：ephemeral 实例 + 心跳 + 自动摘流 |
| 元数据(能力/seam) | 自存 | **instance metadata** 原生支持 |
| 动态配置推送 | 自研 patch 下发 | **Config**：listener 推送，节点热加载 |
| 灰度 | 自研 | **beta 灰度发布** 原生 |
| 多集群/隔离 | 自研联邦 | **namespace + 跨集群同步** |

**四类注册映射到 Nacos：**

| 注册类型 | Nacos 形态 |
|----------|------------|
| 节点/实例 | Naming：`service=dsh-node`，`metadata={nodeRole, capabilities:[doris,nebula,gpu]}` |
| 能力/Seam | instance `metadata.seams`（Scheduler/SeamProxy 经 Naming 发现） |
| 制品(组件/技能/智能体/MCP) | Naming：`component.{name}`/`agent.{name}`；Config：`dataId={artifact}.yaml` 存 manifest/版本/签名/依赖 |
| 算子/流程 | 同上，进 Operator/Flow Catalog |

- 节点身份走 dsh `CredentialKey`，**realm ↔ Nacos namespace** 映射做租户隔离。
- 配置分发：bundle 配置、`cordis.patch.yml` 等价物、灰度规则、OPA bundle 全存 Nacos Config，节点 `addListener` 热加载，无需重启。
- 联邦：多集群 namespace 隔离 + 跨集群同步，信任仍靠制品签名（非仅网络）。
- **发现用 watch 事件驱动，不轮询**；**元数据强一致（Nacos Raft），心跳快路径（TTL 秒级过期）**。

### 6.2 Scheduler 调度（放置 + 并发闸 + 容错）

- **放置算法**：`score = w1*constraintMatch(requires,node) + w2*affinityGain(靠数据/靠队友) + w3*(1-node.load) − w4*crossAZcost`，只在有空闲 AgentSlot 且满足 `requires` 的节点候选。
- **三级队列**：Global Task Bus(RocketMQ，持久，按 realm 分区) → 节点 Local Queue → Slot inbox。
- **排序**：优先级 + EDF(截止时间) + 每 realm WFQ(加权公平，防大租户饿死小租户)。
- **四道并发闸**：全局 LLM token 预算 / 节点 Slot 上限 / 租户并发配额 / Seam 速率熔断(Doris/PG)。
- **容错**：Task 持久 + 日志复制 → worker 死重投 resume；subtask 持久 → 重 claim；节点下线任务漂回 Global Bus。

### 6.3 OPA 单一策略点 + Vault 凭证

- **OPA（Rego）** 是平台唯一策略点，统一挂在：`tools/pre-execute`（拒绝工具调用）、`agent/pre-step`（改写可见内容）、注册表写入前（部署）、连接器 egress（出向）、`agent/turn-stopping`（HITL）、**计量前置（是否超预算）**。
- **Vault** 管理所有外部凭证（API Key/Token），**凭证永远不进 prompt、不进日志明文**；连接器网关运行时动态取用。
- **agent 最小权限**：运行时按其 realm+role 收窄 scope，哪怕 manifest 声明更宽。

### 6.4 计量 UsageLedger（Token 计数 · 归因 · 配额）

> 所有 token 消耗**只在 `ctx.llm` 网关这一道截面被计量**；每笔消耗带从 request 透传到底层的 trace context（user / dept / role / agent / component / session），明细落 PG、聚合进 Doris、限流走 Redis、规则由 Nacos 下发。

| 诉求 | 落地 |
|------|------|
| **功能级计数** | 每次 LLM 调用打 `feature` 标签（来自组件/skill manifest 或 agent preset），回答"知识库问答这个功能各部门花多少" |
| **按人/部门/角色归因** | trace context（`user_id`/`dept_id`/`role`）随请求经 dsh 调用链 baggage 透传；组织树同步自 SSO 作权威来源 |
| **平台级溯源** | `usage_ledger`（PG，append-only + 签名）一行串起 request→session→user→dept→role→agent→component→feature→seam→model→token→成本，与连接器审计/session 事件打通 |
| **限流 + 限额度** | 限流：Redis 令牌桶按 `global/tenant/dept/role/user/feature` 多层级前置拦截；额度：平台→部门→角色→用户**单向耗尽**的预算树，超预算即拒/降级 |

- **存储分工**：明细进 PG（强一致溯源）、聚合进 Doris（看板 cube）、限流/额度走 Redis（TTL 对齐周期）。
- **异步削峰**：计量事件走 RocketMQ `usage.event.*`，不阻塞推理。
- **调度联动**：Scheduler 放置时读预算余量，预算将尽的任务降优先级/suspend。

### 6.5 分发自动安装 Provisioner（声明式 reconcile）

Agent manifest 声明 `deps`（components/skills/mcps + 版本），**Provisioner 把节点拉到期望态**：

```text
deploy(agent, realm):
  1. 解析 deps 依赖图(从 Nacos Config / 制品库)
  2. 校验签名(信任链) + OPA scope(≤发布者权限)
  3. 下载 bundle(组件/skill) + MCP server
  4. 安装: mount 为 Cordis plugin/bundle
  5. 应用 Nacos Config 下发的 patch/配置 → 热加载
  6. 注册 agent 实例(Nacos Naming) → Scheduler 接管
```

- **MCP 经 dsh `python/` 的 MCP bridge** 把 tools/resources 注册进 `ctx.tools`，复用原生 MCP 支持。
- 幂等、自愈（节点故障 → 重 provision）、升级=改版本 → 重 reconcile（回滚=降版本）。
- **安装前签名校验 + OPA scope**：自动安装放大了投毒面，信任链不能省。

---

## 7. 调度面（高并发协同调度智能体集群）

> 两条命脉：**① Worker 无状态化 + Session 状态外置（复制日志）= 水平伸缩与崩溃恢复；② LLM 批处理网关 = 吞吐。** 协同走 mailbox/事件总线，不走同步 RPC。

### 7.1 Worker 模型

- **AgentSlot** 是无状态的：只承载 `agentLoop` 执行，会话状态全在复制式 SessionEvent 日志里。崩溃后任务被重投，由任意空闲 Slot 从日志 resume（`ctx.sessions.fork` 的跨节点版）。
- Worker Loop 完全复用 dsh `agent/*` / `tools/*` 瀑布，只是 `ctx.llm` 与 `ctx.tools` 的 Provider 经 Seam Proxy 落远端：

```text
pull Task → 在 Slot 挂载 preset(cordis patch, isolate realm) → loop:
  agent/pre-step(OPA) → agent/request → ctx.llm(批处理网关) → llm/stream
  → tools/pre-execute(OPA+连接器闸) → seam proxy 到远端 → tools/post-execute
  → agent/turn-stopping(可停转) → 结束释放 Slot; 写结果事件到 Session 日志
```

### 7.2 LLM 批处理网关（吞吐命脉）

`ctx.llm` 的 Provider 不一对一调推理集群，而是**批处理网关**：在时间窗内汇聚多个并发 `agent.request`，合并成 MoE 需要的大 batch——「agent 并发越高、吞吐越高」而非雪崩。`assistant/chunk` 原生流式，首 token 延迟不受批处理拖累（prefill/decode 分离）。

### 7.3 协同拓扑（`ctx.agentTeams`：roster + task board(DAG) + mailbox）

| 拓扑 | 适用 | 实现 |
|------|------|------|
| 层级 Planner-Worker | 可分解目标（分析/编码） | 一个 planner 拆 DAG，多 worker claim |
| 流水线 Pipeline | 阶段串接 | subtask 间 `deps[]` 串联 |
| 议会 Deliberation | 需多视角权衡（评审） | 多 agent 向同一 mailbox 发观点，planner 收敛 |

**高并发专项**：批处理网关、Backpressure 前置（Gateway 429 + Seam 熔断）、Redis 缓存工具结果/记忆、并行子代理 fan-out、数据/队友亲和。

---

## 8. 协同面（异步 + 多端 + RocketMQ A2A）

> **终端只是视图，真相在复制式 SessionEvent 日志；异步只是把 turn 做成「可挂起/可唤醒的协程」。**

### 8.1 异步协同（suspend / resume / future / trigger）

dsh 原生即异步友好（日志 durable 可 replay、`agent.inject()` 异步注入、`ctx.jobs` 后台、`agent/turn-stopping` 停转交还）。在其上建三层原语：

| 原语 | 做法 |
|------|------|
| **Suspend/Resume** | turn 中途挂起 → continuation 持久化到日志 → 触发器（人/定时器/webhook/子任务完成）到达 → `agent.inject()` 唤醒续跑，**释放 Slot 不空转** |
| **Future/Promise seam** | `agent A await(team.mailbox.wait(id))`，`B/human resolve(id)` → future 解析、A resume；背靠持久 mailbox，跨节点跨时间成立 |
| **Trigger Bus** | cron/webhook/外部事件 → Gateway → 注入 inbox，沉睡长任务被唤醒（RocketMQ 延时消息实现） |

### 8.2 多端（终端事件汇 + 能力协商 + presence）

- **终端无关事件汇**：所有终端（web/CLI/IDE/mobile/API）订阅 `session/event` + task board + mailbox；连接即 **replay 历史 + live push**，全一致。
- **能力协商**：终端连接声明 `capabilities`，按 `ConversationNodeDefinition` + keyed renderer 选渲染——web 给图表、CLI 给表格、mobile 给卡片。
- **Terminal Gateway / Presence**：Go WebSocket 接入，presence 让多人可见同 session，动作皆成 session 事件；身份走 `CredentialKey` → realm+role，敏感动作签名 + OPA 校验。
- **离线/弱网兜底**：增量 + 轮询 + 重连 replay，不要求常连。

### 8.3 RocketMQ 多 agent A2A（收敛 NATS）

| 能力 | 价值 |
|------|------|
| **事务消息** | 「扣配额 + 发任务」原子（UsageLedger 与发信一致） |
| **延时/定时消息** | 原生异步唤醒 agent/pipeline（部分替代 cron） |
| **顺序/FIFO + 重试/死信** | A2A 大规模可靠投递 |

**主题模型**：`team.{teamId}`(广播) / `agent.{agentId}`(点对点信箱) / `event.{type}`(能力事件总线) / `trigger.{scheduler}`(延时唤醒)。

**A2A 信封**：`{ msgId, from, to, teamId?, sessionRef?, type, correlationId?, payload, ttl? }`。request/response 用 correlationId，pub/sub 用 team 广播。**必做幂等去重**（至少一次投递，按 msgId/correlationId 去重）。衔接 dsh：消息到达 → 唤醒 suspend 的 turn（`agent.inject()`）。

---

## 9. 注册与大数据流程化

### 9.1 分布式注册（见 §6.1，四类注册全进 Nacos）

节点/资源（画像/region/AZ）、能力/Seam（节点提供哪些 seam + 配额）、制品（组件/技能/智能体/流程 manifest）、实例/端点（运行实例地址）。watch 事件驱动，不轮询；联邦中心 ↔ 边缘 pull，冲突按「版本+签名」裁决。

### 9.2 大数据流程引擎（DAG + 算子目录 + 血缘）

- **Pipeline = DAG 算子**，每个算子是已注册的组件，背靠某个 seam（source→PG/Doris/Kafka；transform→Spark/Flink/`ctx.jobs`；aggregate→Doris；graph→Nebula；sink→可视化/KB）。
- **算子目录（Operator Catalog）本身注册进 Nacos** → 全局可发现/复用/版本化，Agent 从目录拉算子而非临时写代码。
- 引擎能力：DAG 编排（并行/断点续跑）、cron/事件调度（接 Trigger Bus）、批流一体、web 端 `ConversationNodeDefinition` 拖拽编排、**血缘写进 Nebula**（图天然适合）。
- **LLM 即编排者**：Agent 生成 DAG → 提交校验（schema+防环+OPA scope+Seam 限流护栏）→ 编译为分布式 job → 进度经 `session/event` 在**所有终端可见**。

---

## 10. 连接器 + RBAC + 智能体分发体系

### 10.1 外部连接器（agent 连通外部世界的标准化桥）

- 覆盖 REST/GraphQL/MCP/SaaS/消息/数据/Legacy/设备，复刻 dsh 的 `tool-*` + MCP（`python/` 已支持）。
- 连接器即组件（manifest 声明 protocol/auth/toolSurface/limits/egress），**注册进 Nacos**，全局可发现复用。
- **连接器网关四道闸**：路由+鉴权+限速+熔断+PII 脱敏+审计，经 Vault 取凭证、OPA 评估 egress，**所有外部调用记 session 事件供审计**。

### 10.2 用户角色权限

- 用户经 `CredentialKey`（SSO/OIDC）认证，归属 **realm（首要隔离边界）**；RBAC 给角色粗粒度、ABAC 补敏感度/时间/分级。
- **OPA 单一策略点**统一评估（见 §6.3）。
- **agent 最小权限**（见 §6.3）。

### 10.3 智能体分发体系（端到端流通）

创作 → 发布（版本+签名+**依赖图**：组件/技能/连接器）→ 发现（Nacos）→ 部署（声明式 manifest→Provisioner→Scheduler→Nacos 注册）→ 联邦（中心↔边缘 pull，**信任靠签名非网络**）→ 灰度（realm canary，OPA 路由版本）→ 生命周期（版本/弃用/回滚=重指版本）→ 运行时（多实例跨节点、agentTeams 协同、全受 RBAC）。部署前置校验：目标 realm 必须依赖齐全、scope 不越权、高敏感外部写操作默认 HITL。

---

## 11. 用户自定义流程与定向分发（第五类制品）

> **流程是继组件/技能/智能体/连接器之后的第五类制品。** 用户在自有空间低代码定义私有流程；管理员或上级角色审核通过后提升为通用流程写入流程目录；再通过 `audience`（role/dept/user）定向分发。

- **用户级自定义**：web 端用 `ConversationNodeDefinition` 拖拽 DAG（复用 §9 算子目录），或自然语言让 LLM 生成（必过 schema+防环+OPA+限流护栏）；草稿态仅作者可见可运行。
- **提升为通用**：提交 → FlowReview 队列 → 审核人重跑护栏 → `published` 进 flow catalog；**manager 仅能审本 dept 下属、admin 审全局**（靠 §6.4 组织树支撑"上级看下级"）。
- **定向分发**：manifest 加 `audience: {roles, depts, users}` + `visibility: private/targeted/global`，规则存 **Nacos Config 热下发**，终端「流程面板」按身份过滤可见列表，支持 canary 灰度。
- **生命周期状态机**：`draft → submitted → published → targeted → deprecated`（每次 publish 产生版本，回滚即重指版本）。
- 运行消耗记 `feature=flow:<id>` 纳入 §6.4 计量溯源。

---

## 12. 网关技术（全栈 Go 自研，零外部网关中间件）

> **决策变更**：原方案中「外层 APISIX + 东西向 Envoy」**已推翻**。本平台网关领域**不引入任何外部商用网关**，边缘网关、LLM/连接器/终端业务网关、东西向 Seam Proxy **全部 Go 自研**，与统一 Go 决策完全一致，消除 Java/C++ 语言割裂。

### 12.1 网关定义与分层

> **网关 = 系统边界上、对某一类流量的「统一接入点（choke point）」，只干四件事、不对业务语义负责**：① 协议适配/接入 ② 路由分发 ③ 横切治理（鉴权/限流/计量/熔断/脱敏/审计）④ 边界隔离。门后才是真正能力。
> **关键判据**：接管进出平台流量并在门上做治理 = 网关；把一次调用透明转给另一位置的实现 = **Proxy（代理）**。

| 名称 | 方向 | 本质 | 选型 |
|------|------|------|------|
| 边缘网关 Edge | 南北 | 网关（门） | **Go 自研**（TLS 终止/全局限流/路由/灰度/基础 WAF） |
| 终端网关 Terminal | 南北 | 网关（门） | **Go 自研**（WS·replay·presence·能力协商） |
| 连接器网关 Connector | 南北 | 网关（门） | **Go 自研**（Vault·OPA·PII·审计） |
| LLM 网关 | 南北+内部 | 网关（门，对内 proxy 到推理集群） | **Go 自研**（batch·计量单截面·配额·模型路由） |
| Seam Proxy | 东西 | **Proxy（桥）** | **Go 自研轻量代理**（Nacos 发现·sentinel 熔断·mTLS） |

> 一句话区分：**Edge/Terminal/Connector/LLM 是「门」（南北向、做治理）；Seam Proxy 是「桥」（东西向、做透明转发）。**

### 12.2 自研实现要点（替代 APISIX/Envoy）

| APISIX/Envoy 原职责 | Go 自研实现 |
|---------------------|-------------|
| TLS 终止 | `crypto/tls` + `autocert`（Let's Encrypt 自动证书） |
| 反向代理 | `net/http/httputil.ReverseProxy` |
| 全局速率限制 | Redis 令牌桶中间件（与内部网关共享同一限流库） |
| 路由/灰度 | 路由表从 **Nacos Config** 动态加载，按 header/权重分流 |
| 基础 WAF | 请求大小限制、路径/参数校验、CORS、限连接数 |
| 东西向服务发现 | 从 **Nacos** 拉 seam Provider 端点 |
| 东西向熔断/重试 | `sentinel-go` 或自研滑动窗口 + 指数退避 |
| 东西向 mTLS | `crypto/tls` 双向证书（平台内 CA 签发） |
| 可观测 | OTel 中间件 → Prometheus + Loki |

- **所有南北流量只经自研边缘网关**，杜绝绕过。
- Seam Proxy 可作 sidecar（Go 二进制）或嵌入 dsh plugin（更紧耦合 seam 路由）。
- 收益：全栈 Go 一致、零外部网关依赖、与 dsh 语义（计量/OPA/Vault/trace）深度耦合无适配层；代价：需自写边缘网关胶水、边界防护（抗 DDoS）自行加固、mTLS/CA 自管。

### 12.3 语言选型：统一 Go（参考 sub2api）

> **自研服务（边缘/LLM/连接器/终端网关 + 控制面）统一用 Go 1.22+。** 你提到的 **sub2api 是强参照**：它是用 **Go + Gin + Ent + PostgreSQL + Redis** 构建的开源 AI API 网关，做「聚合上游 AI 订阅额度 → 拆多 Key 分发下游 + Token 级计费 + 限流 + 负载均衡 + 流式」，与我们的 LLM 网关能力 1:1 同构且已生产验证——直接复用其技术栈是风险最低决策。

**推荐技术栈（复用 sub2api）：**

```text
语言:    Go 1.22+（统一，无例外）
框架:    Gin (HTTP/WS) / gRPC (内部服务间)
ORM:     Ent (PG)
缓存:    go-redis (Redis Cluster)
消息:    RocketMQ Go SDK
策略:    OPA (Rego SDK 嵌入或 sidecar)
凭证:    Vault Go client
可观测:  OTel Go SDK → Prometheus + Loki
部署:    Docker → Kubernetes + Helm
```

**Rust 仅用于极端计算热点**（自研 tokenizer、超大 batch 调度内核、向量近邻检索），以 sidecar/FFI 形态存在；服务主体仍是 Go。理由：瓶颈在 LLM 推理 + 网络 I/O（等 I/O 场景 Go goroutine 教科书级匹配），Rust 无 GC 优势收益有限却付出开发速度/人才成本；需快速 hook OPA/Vault/Redis/RocketMQ/PG/Doris/Nacos，Go 客户端最成熟。

---

## 13. 技术架构选型总表（全栈逐领域）

| 层 | 能力 | 选型 | 主要替代（已弃） |
|----|------|------|------------------|
| 核心框架 | 插件容器 | **dsh (Cordis)** | 自研框架 |
| 注册+配置 | 发现+健康+动态配置 | **Nacos** | etcd+Consul+自研+ConfigDistributor |
| 消息/A2A | 事务/延时/可靠投递 | **RocketMQ** | Kafka/NATS/Pulsar |
| 策略 | 单一策略点 | **OPA (Rego)** | Casbin/自研 |
| 凭证 | 密钥管理 | **Vault** | KMS/环境变量 |
| 可观测 | trace/metric/log | **OTel + Prometheus + Grafana + Loki** | 闭源 APM |
| 编排 | 容器编排 | **K8s + Helm** | Compose/Nomad |
| 事务/元数据 | 平台主库 | **PostgreSQL** | MySQL |
| OLAP | 分析算力 | **Apache Doris** | ClickHouse/StarRocks |
| 图/血缘 | 知识图谱/关系 | **Nebula Graph** | Neo4j/JanusGraph |
| 缓存/限流 | 热态 | **Redis Cluster** | KeyDB |
| 多租户一致(可选) | 联邦一致源 | **TiDB / CRDB** | 单 PG |
| 推理 | LLM 算力 | **dsh 原生 + 批处理网关** | 自研推理 |
| 连接器 | 外部桥 | **dsh python/ MCP bridge** | 自研协议 |
| 网关 | 全栈接入 | **Go 自研（无 APISIX/Envoy）** | Kong/APISIX/Envoy |
| 语言 | 自研服务 | **Go 1.22+（参考 sub2api）** | Node/TS/Rust 主体 |
| 协同多端 | 终端前端 | **React/TS + dsh host/webserver** | 全自研 |
| 流程引擎 | DAG 编排 | **自研 FlowEngine** | Airflow（过重） |

### 13.1 一致性模型（CAP 取舍）

| 数据 | 模型 | 存储 |
|------|------|------|
| 注册/权限/配额/计费明细 | 强一致 | Nacos Raft + PostgreSQL |
| 日志复制/分析/图/血缘 | 最终一致 | Redis/Doris/Nebula |
| 跨集群联邦 | 强一致（中心）+ 最终一致（边缘） | TiDB/CRDB + Nacos 同步 |

> **真相源永远在 PG + 复制式 SessionEvent 日志**；Doris/Nebula/Redis 是派生层，绝不反向充当事务真相。

### 13.2 部署拓扑与资源画像

控制面 3 节点(CP) + GPU 推理节点(IB/RDMA) + 存储分层集群(PG/Doris/Nebula/Redis) + K8s worker + 自研边缘网关 + RocketMQ 骨干 + OTel 可观测。昼夜弹性：闲时回收 agent 节点、忙时扩容，数据节点按需起停。

### 13.3 风险与未决项

| 风险 | 缓解 |
|------|------|
| Doris 非事务/坏 SQL | Seam Provider 层 sanitize + 限流 + OPA |
| RocketMQ 至少一次 | 消费端幂等去重 |
| dsh v0.1 API 不稳 | 改动收敛到 bundle/patch 层，只依赖稳定语义 |
| Nebula schema 晚设计 | 图建模早做 |
| 是否引 TiDB/CRDB | 待决，视多集群联邦需求 |
| 自研网关稳定性/边界防护 | 压测 + SLA + OTel 全埋点 + 前置 LB |

---

## 14. 术语精确定义（边界字典）

| 术语 | 一句话定义 | 易混点 |
|------|-----------|--------|
| **网关 Gateway** | 系统边界上某类流量的统一接入点，做协议适配/路由/治理/隔离 | vs Proxy：网关做治理，Proxy 做透明转发 |
| **Seam Proxy** | 把本地 seam 调用透明转给远端 Provider 的东西向桥 | 是 Proxy 不是网关 |
| **控制面** | 谁在哪、谁能干、怎么调度、怎么计量治理 | 不改业务语义 |
| **数据面** | agent 实际执行、流程跑批、连外部 | 执行层 |
| **协同面** | 多 agent/人/端协作 | 状态与消息层 |
| **组件 Component** | 业务面一等制品（编排 plugin/skill/seam，带 manifest） | vs 插件：插件是内核面代码 |
| **技能 Skill** | 能力包（prompt+工具+策略） | 注册进 ctx.tools |
| **智能体 Agent** | 角色（preset+引用+policy） | 可被 Scheduler 部署 |
| **连接器 Connector** | 外部系统桥 | 走 ConnectorGateway 治理 |
| **流程 Flow** | DAG 编排（第五类制品） | 复用 FlowEngine |
| **注册中心 Naming** | 寻址发现（节点/能力/制品实例） | vs 配置中心：配置是规则下发 |
| **配置中心 Config** | 动态规则推送（manifest/patch/OPA/灰度） | Nacos 二者合一 |
| **Scheduler** | 决策「去哪」的放置算法 | vs 放置：打分函数；vs Worker：执行槽 |
| **配额 Quota** | 周期预算树（"这月能用多少"） | vs 限流：瞬时速率闸（"这一刻能多快"） |
| **溯源 Lineage** | 成本归因链（谁用了多少） | vs 审计：合规追责（谁做了什么） |
| **realm** | 首要租户隔离边界（↔ Nacos namespace） | 权限根 |

---

## 15. 关键决策与风险（贯穿硬规矩汇总）

1. **严格不改 dsh 源码**：全走 plugin/bundle/patch，只依赖稳定语义；dsh 作 npm 依赖、绝不 fork / vendor / monkey-patch；升级无需 rebase 补丁（见 §1 禁止/允许清单与验证判据）。
2. **最大杠杆是 Seam 网络化**，不是把 Agent Loop 搬上网。
3. **组件是业务面制品，插件是内核面制品**；业务逻辑写进组件 manifest，不写进 plugin。
4. **SessionEvent 日志是杀手锏资产**：模型上下文源 = 审计源 = 跨节点共享真相。
5. **协同走 mailbox/事件总线，不走同步 RPC**；**最终一致 + 幂等 claim，不引分布式事务**。
6. **Nacos 收敛注册+配置**，别再自研 etcd+Redis+ConfigDistributor 三套。
7. **RocketMQ 统一异步骨干**，事务/延时消息是 NATS 难平替的；**A2A 必幂等去重**。
8. **网关全栈 Go 自研，零 APISIX/Envoy**；通用治理下沉自研边缘网关 + 共享限流库。
9. **自研语言统一 Go（参考 sub2api）**；Rust 仅局部热点。
10. **组件绝不直连 DB**，一律走 seam；**Doris 不是事务库**。
11. **计量只在 `ctx.llm` 单截面**；明细 PG、聚合 Doris、限流 Redis；限流额度前置拦截。
12. **流程是第五类制品**；创作自由、治理独立（提升/分发必须是独立审批）；audience 定向而非广播。
13. **凭证永远进 Vault 不进 prompt**；连接器必带限速/熔断/egress 白名单/脱敏/审计。
14. **终端只存视图、不存业务状态**；多端共享靠事件 fanout；弱网必须有 replay+轮询兜底。
15. **自动安装声明式 reconcile + 签名校验 + OPA scope**；信任靠签名非网络（联邦/分发同理）。
16. **业务功能尽量插件式，后台/集群化独立**：组件 / 技能 / 智能体 / 连接器 / 流程 / seam Provider 一律作 Cordis 插件挂载；Scheduler / 网关 / SeamProxy / 计量 / FlowEngine / Nacos / RocketMQ / K8s 等独立 Go 服务或中间件，不塞进 dsh 插件（分界见 §3.1）。

---

## 16. 实施蓝图（仓库布局 + 构建顺序 + MVP）

### 16.1 建议仓库布局

```text
platform/
  control-plane/
    edge-gateway/      # Go 自研：TLS/路由/全局限流/WAF
    llm-gateway/       # Go 自研：批处理 + 计量单截面 + 配额 + 模型路由
    connector-gateway/ # Go 自研：Vault/OPA/PII/审计
    terminal-gateway/  # Go 自研：WS/replay/presence/能力协商
    seam-proxy/        # Go 自研：东西向透明转发 + 熔断 + mTLS
    registry/          # Nacos 适配 + 联邦
    scheduler/         # 放置 + 并发闸 + 重平衡
    policy/            # OPA bundle + 评估 SDK
    usage-ledger/      # 计量（PG 明细 + Doris 聚合 + Redis 限流）
    flow-engine/       # DAG 编排 + 算子目录 + 血缘
    trigger-bus/       # cron + webhook + RocketMQ 延时
    agentteams/        # roster/task_board/mailbox（RocketMQ backing）
    provisioner/       # 自动安装 reconcile（组件/skill/MCP）
  data-plane/
    dsh-node/          # 基于 dsh 的节点镜像（改 profile）
    seam-providers/    # PG/Doris/Nebula/Redis Provider 实现
    connectors/        # HTTP/MCP/SaaS/消息 适配器
  shared/
    proto/             # gRPC/事件 schema
    manifests/         # component/skill/agent/connector/flow schema
```

### 16.2 构建顺序（P0–P4，均零侵入内核）

```text
P0 对齐扩展点(读 architecture.md, dump-config)          → 不改内核
P1 组件化 + 技能分发(单节点高价值)                       → Nacos 制品注册 + bundle 签名 + 知识库 seam
P2 跨节点能力                                            → SeamProxy + 复制日志 + Scheduler + RocketMQ
P3 智能体分发协同                                        → AgentTeams 分布式(RocketMQ) + 联邦 + RBAC + 自动安装
P4 平台 GA                                              → OPA/Vault/Usage/OTel + 连接器 + FlowEngine + 用户流程分发 + 昼夜弹性
```

### 16.3 MVP 三连（建议首切）

1. **Nacos 注册 + 配置**（控制面 backbone，喂给 Scheduler/SeamProxy 发现与热下发）
2. **自研 Go 边缘网关 + 自研 Go LLM 网关**（SeamProxy + OPA 策略点 + 计量单截面落地网关技术）
3. **一个连接器(MCP/HTTP) + 一个 DAG 流程跑通 Doris→Nebula 血缘**（验证数据面闭环，RocketMQ 触发）

---

## 17. 端到端流程（串联验证各层咬合）

### 17.1 协同任务生命周期
```text
用户(终端)─▶边缘网关(TLS/RBAC)─▶LLM网关(计量单截面/配额)
  → Global Task Bus(RocketMQ) → Scheduler(查 Nacos seam/节点, 放置)
  → Agent 节点 Local Queue → Worker Slot 挂载 preset(isolate realm)
  → agent/pre-step(OPA) → agent/request → ctx.llm(批处理网关)
  → tools/pre-execute(OPA+连接器闸) → SeamProxy → 远端 Provider → tools/post-execute
  → 结果写 Session 日志 → 多端事件汇可见 → Task ack
```

### 17.2 大数据 Pipeline
```text
Agent(Planner)─LLM 生成 DAG─▶FlowEngine.submit
  → guard(schema+防环+OPA) → 血缘写 Nebula → 编译 job → Scheduler(ctx.jobs)
  → 算子经 seam 读写 Doris/Nebula/PG/Redis → 进度事件 → 多端可见 → sink 可视化
```

### 17.3 多端异步协作
```text
Planner(web)分解 → suspend(continuation 存日志) → 等 future
Worker 异步执行 → mailbox.resolve → future 解析 → Planner resume
Human(mobile)审批 → 边缘网关 → agent.inject() → resume
所有终端经 session/event 一致可见(replay+live)
```

### 17.4 外部连接器调用 + 计量溯源
```text
Agent─ctx.tools:action─▶ConnectorGateway
  → OPA(egress+scope) → Vault 取凭证 → 限速/熔断/PII 脱敏 → 外部 API/MCP
  → 调用记 session 事件(审计) + usage_ledger(feature=..., user/dept/role 溯源)
```

---

## 18. 索引（原 15 篇 addendum → 本总纲章节）

| 原文档 | 主题 | 本 V2 对应 |
|--------|------|------------|
| `deepseek_harness_distributed_design.md` | 总体架构 | §1–§4 |
| `deepseek_harness_data_layer.md` | 数据层 | §5 |
| `deepseek_harness_agent_scheduling.md` | 调度面 | §6.2, §7 |
| `deepseek_harness_async_multiterminal.md` | 异步+多端 | §8.1, §8.2 |
| `deepseek_harness_registry_bigdata_flow.md` | 注册+流程化 | §6.1, §9 |
| `deepseek_harness_connectors_rbac_distribution.md` | 连接器+RBAC+分发 | §10 |
| `deepseek_harness_tech_architecture.md` | 技术架构总纲 | 全文整合 |
| `deepseek_harness_nacos_rocketmq_a2a.md` | Nacos+自动安装+RocketMQ | §6.1, §6.5, §8.3 |
| `deepseek_harness_token_metering.md` | Token 计量·归因·配额 | §6.4 |
| `deepseek_harness_user_flow_distribution.md` | 用户流程+定向分发 | §11 |
| `deepseek_harness_tech_definitions.md` | 技术术语精确定义 | §14 |
| `deepseek_harness_tech_selection.md` | 技术架构选型 | §13 |
| `deepseek_harness_gateway_tech_selection.md` | 网关技术选型（原含 APISIX/Envoy） | §12（已修订为全自研） |
| `deepseek_harness_lang_selection.md` | 自研语言选型 | §12.3 |
| `deepseek_harness_gateway_no_apisix.md` | 网关全自研修订 | §12（已并入） |

> 原 15 篇作为**增量演进记录**保留；本 V2 是**采用最终决策的权威整合版**，消除了早期文档中 `etcd/NATS/ConfigDistributor/APISIX/Envoy` 等已被推翻的残留口径。

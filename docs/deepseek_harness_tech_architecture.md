# DeepSeek Harness 分布式智能体平台 · 技术架构体系总纲

> ⚠️ **已归档 · 演进快照，非当前口径**
>
> 本文为逐轮讨论的历史快照，其内容已被权威整合版 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md) **全文** 取代。
>
> 文中出现的 `etcd / NATS / ConfigDistributor / APISIX / Envoy` 等口径**已被后续决策推翻**；现行决策为 **Nacos / RocketMQ / 全栈 Go 自研网关**。
>
> **请勿据本文实施；一切以 V2 为准。**

> **【已过时 · 以 V2 为准】** 本文已被 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）取代。文中 etcd、NATS、ConfigDistributor 三件套已收敛为 **Nacos + RocketMQ**。

> 本篇是六篇 addendum 的**收口**：把分散的分层、数据、调度、异步多端、注册流程化、连接器权限分发，收敛为一套**可落地的技术架构体系**（统一分层 + 模块分解 + tech stack + 端到端流程 + 实现蓝图）。
> 铁律不变：**零侵入 dsh 内核**，一切走 Cordis 的 plugin / bundle / seam / event / profile。

---

## 0. 阅读路径（七篇体系）

| # | 文档 | 解决 |
|---|------|------|
| 1 | `deepseek_harness_distributed_design.md` | 总体分层 + Seam 网络化 + 组件化/技能/智能体分发 |
| 2 | `deepseek_harness_data_layer.md` | PG/Doris/Nebula/Redis/分布式DB 作 Seam Provider |
| 3 | `deepseek_harness_agent_scheduling.md` | 调度面：高并发协同调度智能体集群 |
| 4 | `deepseek_harness_async_multiterminal.md` | 异步协同 + 多端 |
| 5 | `deepseek_harness_registry_bigdata_flow.md` | 分布式注册 + 大数据 DAG 流程引擎 |
| 6 | `deepseek_harness_connectors_rbac_distribution.md` | 外部连接器 + 用户角色权限 + 智能体分发体系 |
| **7（本篇）** | **`deepseek_harness_tech_architecture.md`** | **技术架构体系总纲：统一分层 / 模块分解 / 端到端流程 / 实现蓝图** |

---

## 1. 系统上下文与目标

- **定位**：在开源 `dsh`（Cordis 驱动、一切皆插件）之上，构建**组件化、可分发、多智能体协同**的分布式智能体平台（Agent Capability PaaS）。
- **关键约束**：不改 Cordis 内核；扩展只通过 plugin / bundle / `cordis.patch.yml` / seam / event。
- **非目标**：不重写推理引擎（DeepSeek 推理系统另算）、不做通用低代码 BI（只做 agent 可编排的数据流）。

---

## 2. 统一分层架构（L0–L6 全集）

```
┌──────────────────────────────────────────────────────────────────────────┐
│ L6 业务应用层   业务工作台 / 行业方案 / 人机协同终端(web/CLI/IDE/mobile/API) │
├──────────────────────────────────────────────────────────────────────────┤
│ L5 分发与治理层  Registry(制品/算子/连接器) ｜ RBAC/OPA ｜ UsageLedger ｜ 灰度│
├──────────────────────────────────────────────────────────────────────────┤
│ L4 智能体编排层  agent/* 事件 ｜ ctx.agentTeams(分布式) ｜ ctx.goals ｜ 协同  │
├──────────────────────────────────────────────────────────────────────────┤
│ L3 技能层       Skill=bundle+签名+版本+scope ｜ 技能市场                      │
├──────────────────────────────────────────────────────────────────────────┤
│ L2 能力组件层   数据分析(流程)组件 ｜ 知识库组件 ｜ 业务协同组件 ｜ 连接器组件  │
├──────────────────────────────────────────────────────────────────────────┤
│ L1 分布式运行时  dsh 节点集群(gateway/agent/capability/storage)             │
│    ├ DistributedSeamProxy(gRPC/QUIC)   ├ Replicated SessionEvent Log(Raft) │
│    ├ Capability Event Bus(NATS)        ├ FlowEngine(DAG)  ├ TriggerBus      │
│    └ Scheduler ｜ ConfigDistributor ｜ TerminalGateway ｜ ConnectorGateway  │
├──────────────────────────────────────────────────────────────────────────┤
│ L0 资源层        GPU/CPU(IB/RDMA) ｜ PG/Doris/Nebula/Redis/分布式DB ｜ K8s   │
└──────────────────────────────────────────────────────────────────────────┘
        横切: OPA策略点 ｜ OTel可观测 ｜ 凭证Vault ｜ 审计(session事件)
```

---

## 3. 模块分解与 Tech Stack

### 3.1 控制面服务（Control Plane）

| 模块 | 职责 | 技术选型 |
|------|------|----------|
| **Registry** | 节点/能力/制品/算子/连接器注册 + 发现 + 联邦 | etcd(Raft 强一致) + Redis(心跳 TTL) + 对象存储(制品 blob) |
| **Scheduler** | 放置(约束+亲和+装箱)、并发闸、重平衡 | Go 服务；WFQ+EDF；watch 注册表事件 |
| **ConfigDistributor** | 推送 profile/bundle/`cordis.patch.yml` | dsh 原生 bundle 机制 + 配置下发 |
| **Policy(OPA)** | 单一策略点：RBAC/ABAC 评估 | OPA(Rego)；挂在 `tools/pre-execute`/`agent/pre-step`/注册/连接器 egress |
| **UsageLedger** | token/组件/节点/连接器计量计费 | PostgreSQL(主) + Doris(分析) |
| **TerminalGateway** | 多端接入、presence、事件汇(replay+live) | WebSocket/QUIC；订阅 `session/event` |
| **ConnectorGateway** | 外部连接器路由、限速、熔断、PII、审计 | 适配器(HTTP/MCP/SaaS/消息)；Vault 取凭证 |
| **FlowEngine** | DAG 编排、调度、血缘、编译为分布式 job | 轻量 DAG 编排器；重算走 Spark/Flink/`ctx.jobs` |
| **TriggerBus** | cron/webhook/外部事件 → 唤醒 agent/pipeline | 定时器 + Webhook Ingress |
| **AgentTeams Backing** | roster+task board+mailbox 持久与跨节点 | CRDB/etcd + NATS(消息) |
| **SessionLog Store** | 复制式 SessionEvent 日志(热/冷) | Redis(热) + Doris/对象(冷, Raft/分段) |

### 3.2 数据面（Data Plane）

| 节点角色 | profile | 挂载 | 技术 |
|----------|---------|------|------|
| Gateway | `web`(改) | 路由+鉴权+SeamProxy 入口+OTel | dsh + 网关插件 |
| Agent | `headless`(改) | `agentLoop`+`ctx.agentTeams`+Seam 消费 | dsh Worker Pool(Slot) |
| Capability | 定制 | 各 seam Provider(KB/Doris/Nebula/GPU/连接器) | dsh plugin + SeamProxy server |
| Storage | — | 日志/向量/对象 | 见 L0 |

### 3.3 基础设施（L0）

Cordis(dsh 内核，保留) ｜ etcd ｜ NATS JetStream ｜ Redis Cluster ｜ PostgreSQL ｜ Apache Doris ｜ Nebula Graph ｜ 分布式DB(TiDB/CRDB) ｜ OPA ｜ Vault/KMS ｜ OTel+Tempo+Prom ｜ K8s+gVisor/microVM。

---

## 4. 端到端流程（四类串联）

### 4.1 协同任务生命周期
```
用户(终端)─▶Gateway(鉴权/RBAC)─▶Task Bus
  →Scheduler(查 Registry 的 seam/节点, 放置)→Agent 节点 Local Queue
  →Worker Slot 挂载 preset(isolate realm)→驱动 agent/* 瀑布
      agent/pre-step(OPA)→agent/request→SeamProxy→ctx.llm(批处理网关)
      →tools/pre-execute(OPA+连接器闸)→远端 Provider→tools/post-execute
  →结果写 Session 日志→多端事件汇可见→Task ack
```

### 4.2 大数据 Pipeline 执行
```
Agent(Planner)─LLM 生成 DAG─▶FlowEngine.submit
  →guard(schema+防环+OPA)→血缘写 Nebula→编译 job→Scheduler(ctx.jobs)
  →算子经 seam 读写 Doris/Nebula/PG/Redis→进度事件→多端可见→sink 可视化
```

### 4.3 多端异步协作
```
Planner(web)分解→suspend(continuation 存日志)→等 future
Worker 异步执行→mailbox.resolve→future 解析→Planner resume
Human(mobile)审批→Gateway→agent.inject()→resume
所有终端经 session/event 一致可见(replay+live)
```

### 4.4 外部连接器调用
```
Agent─ctx.tools:action─▶ConnectorGateway
  →OPA(egress+scope)→Vault 取凭证→限速/熔断/PII 脱敏→外部 API/MCP
  →调用记 session 事件(审计)
```

---

## 5. 横切关注点

| 关注点 | 机制 |
|--------|------|
| **安全/治理** | realm 租户边界 + OPA 单一策略点 + 凭证 Vault(不进 prompt) + 审计(全 session 事件) |
| **可观测** | OTel 把 `agent/*`/`tools/*`/`llm/stream` 瀑布做成跨节点 trace；调度看板 |
| **韧性** | 复制日志 + 任务总线持久 → 崩溃 resume；Seam 熔断；昼夜弹性扩缩 |
| **一致性** | 注册表强一致(etcd)；协同最终一致(消息+幂等 claim)；数据按 seam 声明 strong/eventual |
| **SLA/容量** | WFQ+EDF 调度；四道并发闸；批处理网关提吞吐 |

---

## 6. 实现蓝图（模块树 + 构建顺序）

### 6.1 建议仓库布局
```
platform/
  control-plane/
    registry/        # etcd + Redis 心跳 + 联邦
    scheduler/       # 放置 + 并发闸 + 重平衡
    policy/          # OPA bundle + 评估 SDK
    gateway/         # TerminalGateway + ConnectorGateway
    flow-engine/     # DAG 编排 + 血缘
    trigger-bus/     # cron + webhook
    agentteams/      # roster/task_board/mailbox backing
    session-log/     # 复制式日志 热/冷
    usage-ledger/    # 计量
  data-plane/
    dsh-node/        # 基于 dsh 的节点镜像(改 profile)
    seam-proxy/      # gRPC/QUIC 代理 server+client
    connectors/      # HTTP/MCP/SaaS/消息 适配器
  shared/
    proto/           # gRPC/事件 schema
    manifests/       # component/skill/agent/connector/pipeline schema
```

### 6.2 构建顺序（呼应 P0–P4）
```
P0 对齐扩展点(读 architecture.md, dump-config)          → 不改内核
P1 组件化 + 技能分发(单节点高价值)                       → Registry(制品) + bundle 签名
P2 跨节点能力                                            → SeamProxy + 复制日志 + Scheduler
P3 智能体分发协同                                        → AgentTeams 分布式 + 联邦 + RBAC
P4 平台 GA                                              → OPA/Usage/OTel + 连接器 + FlowEngine + 昼夜弹性
```

### 6.3 MVP 三连（建议首切）
1. **etcd Registry + 心跳**（控制面 backbone，喂给 Scheduler/SeamProxy 发现）
2. **SeamProxy 路由 + OPA 策略点**（让 seam 跨节点 + 单一治理点）
3. **一个连接器(MCP/HTTP) + 一个 DAG 流程跑通 Doris→Nebula 血缘**（验证数据面闭环）

---

## 7. 风险登记（六篇硬规矩汇总）

| 风险 | 对策 |
|------|------|
| 改 Cordis 内核 | 全走 plugin/bundle/patch；只依赖稳定语义 |
| 双放置/错路由 | 注册表强一致(etcd/Raft)+心跳快路径 |
| 推理集群饿死 | LLM 批处理网关汇聚并发为大 batch |
| 后端被打爆 | Seam 速率闸 + Gateway 前置 429 backpressure |
| 凭证泄露 | Vault 取凭证，绝不进 prompt |
| 多端对不齐 | 真相在复制日志；终端只订阅事件汇 |
| 坏 pipeline/SQL | LLM 生成物过 schema+防环+OPA+限流护栏 |
| 联邦投毒 | 跨集群信任靠签名非网络 |
| 协同变事务瓶颈 | 最终一致 + 幂等 claim，不引分布式事务 |
| 升级破坏性变更 | 改动收敛到 bundle/patch 层，跟上游对齐 |

---

## 8. 体系总览图（一张网）

```
          用户/系统(多端+连接器)
                │ RBAC/OPA + 凭证Vault
   ┌────────────┴─────────────────────────────────────────┐
   │ 控制面: Registry │ Scheduler │ OPA │ Usage │ Gateways  │
   │        │ FlowEngine │ TriggerBus │ AgentTeams │ SessionLog│
   └────────────┬─────────────────────────────────────────┘
                │ 发现/放置/策略/事件
   ┌────────────┴────────── 数据面(dsh 节点集群) ──────────┐
   │ Gateway─Agent(WorkerPool)─SeamProxy─▶ Capability 节点  │
   │   │                          │                          │
   │   └── Replicated SessionEvent Log ◀── 真相源 ──┐       │
   └──────────────────────────────────────────────┼───────┘
                                                    ▼
                             L0: PG / Doris / Nebula / Redis / 分布式DB / K8s
```

> 七篇合起来即完整技术架构体系：**内核不改、控制面治理、数据面流通、协同面异步多端、注册流程化、连接器权限分发**全覆盖，且全部基于 dsh 原生扩展点、零侵入。

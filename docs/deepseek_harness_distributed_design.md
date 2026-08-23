# 基于 DeepSeek Harness（`dsh`）的大规模分布式智能体平台：架构与产品设计

> ⚠️ **已归档 · 演进快照，非当前口径**
>
> 本文为逐轮讨论的历史快照，其内容已被权威整合版 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md) **§1–§4** 取代。
>
> 文中出现的 `etcd / NATS / ConfigDistributor / APISIX / Envoy` 等口径**已被后续决策推翻**；现行决策为 **Nacos / RocketMQ / 全栈 Go 自研网关**。
>
> **请勿据本文实施；一切以 V2 为准。**

> **【已过时 · 以 V2 为准】** 本文已被 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）取代。文中注册/消息/日志复制选型仍为 etcd + NATS，最终口径已改为 **Nacos + RocketMQ**。

> 对象：开源 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`，MIT，v0.1 开发者预览）
> 目标：在 `dsh` 之上做**大规模分布式集群化改造**，并落地**数据分析 / 知识库 / 业务协同组件化、技能分发、业务智能体分发协同**
> 方法：不 fork 核心，全部走 dsh 原生的 Cordis 扩展点（plugin / bundle / seam / event / profile）

---

## 0. 先对齐：dsh 到底给了你什么，以及缺什么

`dsh` 的架构一句话概括：**「一切皆插件」，由 Cordis 驱动的共享 Context；能力通过 seam（能力接缝）解耦，行为通过事件瀑布扩展，状态通过 append-only 的 SessionEvent 日志沉淀。**

把它吃透，是后续一切设计的前提。

### 0.1 dsh 的原生机制（必须复用的地基）

| 机制 | 作用 | 关键标识 |
|------|------|----------|
| **Cordis Context** | 插件贡献 service、typed event、可逆 effect；无特权内核，挂载即扩展，卸载即回收 | `ctx.*` |
| **Core services** | 各能力挂载点 | `ctx.llm` `ctx.tools` `ctx.agents` `ctx.agentLoop` `ctx.sessions` `ctx.systemPrompt` `ctx.scope` `ctx.jobs` `ctx.goals` `ctx.fs` `ctx.shell` `ctx.subprocess` `ctx.sandbox` `ctx.terminals` `ctx.commands` `ctx.sessionTitle` |
| **Capability Seam** | 可替换能力 = 三件套：**Service Definition（接口）+ Service Provider（实现）+ Consumer（消费，多为模型可见工具）** | 见 ADR 0009 |
| **Event 瀑布** | `agent/pre-step` `agent/request` `llm/stream` `tools/pre-execute` `tools/execute` `tools/post-execute` 必须 `next()`；`agent/turn-stopping` 串行无 next | `agent/*` `tools/*` `fs/*` `telemetry/*` |
| **SessionEvent Log** | 模型可见即日志；`deriveMessages()` 从日志投影历史；fork/resume/审计全派生自此流 | `ctx.sessions.fork()` |
| **Profiles / Bundles** | 运行的 dsh = 按层组合的插件树；bundle 是「Cordis 配置行 + 挂载代码」的分发格式，可被上层 patch | `dsh --profile web --dump-config` |
| **Agent Teams（实验）** | `ctx.agentTeams` 上的私有协调 seam：持久花名册 + 任务板 + 信箱，建立在可续跑 subagent 之上 | `packages/experimental/agent-team` |

### 0.2 你的需求 ↔ dsh 原生扩展点映射

| 你要的能力 | dsh 里该挂哪里 | 当前缺口 |
|------------|----------------|----------|
| 数据分析组件化 | 组合 `ctx.tools` + `ctx.jobs`（后台计算）+ `ConversationNodeDefinition`（可视化）+ `ctx.goals` | 无「组件」层概念，能力散落 |
| 知识库组件化 | 新增 `ctx.knowledge` seam（ingest/query 接口 + 向量库 Provider + RAG Consumer） | 无 seam，复用 `fs/*` 思路自建 |
| 业务协同组件化 | `ctx.goals`（目标）+ `agent/*`（拦截/停转）+ 审批 policy seam + `ctx.agentTeams`（交接） | 无流程/审批 seam |
| 技能分发 | 技能本就是 `.agents/skills/` 文件 → 包成 bundle + manifest + 签名 | 无 registry/版本/灰度，仅靠 `dsh-plugin` topic |
| 业务智能体分发协同 | Agent = agent preset/profile（`isolate` realm 隔离能力集）+ 组件/技能引用 | 无 Agent Registry、无跨节点协同 |

> **核心判读**：`dsh` 缺的不是「能不能做分布式」，而是**控制面**（注册/调度/治理/可观测）和**把 seam 变成网络可达**。这两点补上，「组件化 / 分发 / 跨节点协同」全是水到渠成的 extension，不需要改 Cordis 内核。

---

## 1. 总体架构：在 dsh 之上加一层「分布式能力 PaaS」

保持 dsh「每节点一个 Cordis Context」的本地模型不变，在其外叠加三层：**控制面（Control Plane）+ 分布式 Seam 代理（跨节点能力）+ 复制式 Session 日志（共享真相）**。

```
┌───────────────────────────────────────────────────────────────────────────┐
│ L6  业务应用层   业务工作台 / 行业方案 / 人机协同终端                         │
├───────────────────────────────────────────────────────────────────────────┤
│ L5  分发与治理层  组件·技能·智能体 Registry ｜ 鉴权RBAC ｜ 计量 ｜ 评测·护栏 ｜ 灰度 │
├───────────────────────────────────────────────────────────────────────────┤
│ L4  智能体编排层  Agent Runtime：agent/* 事件 ｜ ctx.agentTeams(跨节点) ｜ 目标/记忆 │
├───────────────────────────────────────────────────────────────────────────┤
│ L3  技能层       Skill = 文件制品包成 bundle + 签名 + 版本 + 权限 scope        │
├───────────────────────────────────────────────────────────────────────────┤
│ L2  能力组件层    数据分析组件 │ 知识库组件 │ 业务协同组件  （标准 I/O 契约 + manifest）│
├───────────────────────────────────────────────────────────────────────────┤
│ L1  分布式运行时  dsh 节点集群：gateway/agent/capability(KB·GPU·tool)/storage  │
│     ├─ Distributed Seam Proxy（seam 网络可达）                              │
│     ├─ Replicated SessionEvent Log（Raft/流复制，跨节点 fork/resume）        │
│     └─ Capability Event Bus（fs/* tools/* kb/* 跨节点广播）                 │
├───────────────────────────────────────────────────────────────────────────┤
│ L0  资源层        GPU/CPU 节点(IB/RDMA) ｜ 对象存储/向量库 ｜ K8s/运行时隔离  │
└───────────────────────────────────────────────────────────────────────────┘
        ↑ 控制面横切 L1–L6：Scheduler ｜ Config Distributor ｜ OPA ｜ Usage Ledger ｜ OTel
```

**最关键的一条设计杠杆（下文 2.1 展开）**：dsh 文档明言——把 filesystem/subprocess 的 Provider 指向远程沙箱，Bash/PTY/LSP 会一并迁移且**无需 provider 分叉**。把这招泛化：**让任意 seam 的 Provider 可落在远端节点**，组件化与跨节点协同就成立了。

---

## 2. 大规模分布式集群化改造

### 2.1 把「Seam」变成网络可达的（最高杠杆改造）

原生事实：`core/scope` 支持 per-agent 注册；subagent provider 在一个接口后差异巨大；filesystem/subprocess 共享一个执行世界，换 Provider 即整体迁移。

**改造：引入 `DistributedSeamProxy`。**

- Provider 仍按原生三件套声明接口，但可注册为「远程 Provider」：本地挂一个 proxy，把调用经 gRPC/QUIC 路由到远端节点的真实 Provider，**Consumer 代码零改动**。
- 这样：知识库、数据分析、工具执行、GPU 推理都能作为「远程 seam」被任意节点消费。
- 对应 dsh 原生：`Add shell execution → register a ctx.shell backend` 这套机制，原样升级为 `register a RemoteSeamProvider`，复用 `isolate` realm 做租户/节点归属。

```
本地节点                                  远端 capability 节点
Agent ──ctx.tools/query──▶ Proxy ──gRPC──▶ Knowledge Provider
   (Consumer 不变)           (Seam Proxy)      (真实 Provider, 原生实现)
```

### 2.2 运行时拓扑（Data Plane）

每节点是一个 `dsh` 实例（profile），由控制面推送 profile/bundle/patch 组合启动：

| 节点角色 | 启动 profile | 挂载的 bundle |
|----------|--------------|---------------|
| **Gateway** | `web`（改） | 路由 + 鉴权 + Seam Proxy 入口 + OTel |
| **Agent 节点** | `headless`（改） | `agentLoop` + `ctx.agentTeams` + Seam 消费端 |
| **Capability 节点** | 定制 | 知识库 seam Provider / GPU 推理 Provider（ctx.llm）/ 数据分析 job 后端（ctx.jobs） |
| **Storage 节点** | — | 复制式 Session 日志 + 向量库 + 对象存储 |

调度器（Scheduler）依据组件 manifest 的 `requires`（GPU/向量库/数据权限）把 agent/组件放到合适节点，`cordis.patch.yml` 自动叠加生效——完全沿用 dsh 的「层叠 patch」范式。

### 2.3 SessionEvent 日志复制（共享真相）

- 原生：`core/session` 是 append-only 日志，`deriveMessages()` 投影历史，`ctx.sessions.fork()` 复制会话。
- 改造：把该日志**按 segment 复制到集群**（Raft 或 NATS/RStreams），让 agent 可跨节点 resume/migrate，并让多智能体协同拥有共享的持久状态。
- 收益：审计天然完备（「模型可见即日志」），且 fork 升级为**跨节点 fork**。

### 2.4 Agent Loop 服务化 + Agent Teams 跨节点

- 把 `agent/*` 事件与 `agentLoop` 暴露为网络服务：协调器可驱动远端节点的 agent step 并聚合结果。
- `ctx.agentTeams` 当前是进程内实验 seam（花名册 + 任务板 + 信箱）。改造：**用分布式存储 + 事件总线 backing**，使 team 跨节点成立——智能体经「信箱 + 事件总线」通信，而非进程内函数调用。

### 2.5 控制面（横切 L1–L6）

| 控制面子系统 | 职责 | 落点 |
|--------------|------|------|
| **Registry** | 组件/技能/智能体制品的发布、版本、签名、检索 | L5 |
| **Scheduler** | 按 `requires` 把制品放到节点，弹性伸缩 | L1 |
| **Config Distributor** | 推送 profile/bundle/`cordis.patch.yml` | L1 |
| **Policy（OPA）** | 对 seam 调用做鉴权/限流/数据边界 | 横切 |
| **Usage Ledger** | token/组件/节点维度的计量计费 | L5 |
| **Observability** | 把 `agent/pre-step→llm/stream→tools/*` 瀑布做成跨节点 trace | 横切 |

### 2.6 弹性与多租户

- **Realm 隔离**：复用 dsh 的 `isolate` realm——「给某会话不同能力集 = 组合 agent preset，其 service row 需 `isolate` realm」。租户即 realm。
- **昼夜弹性**：借鉴 DeepSeek 推理系统按峰谷动态增减节点；agent 节点同理，闲时回收、忙时扩容。
- **计量**：每条 seam 调用、每步 `llm/stream` 都记 Usage Ledger，按租户/组件归集。

---

## 3. 能力组件化：Component = 编排后的 dsh 制品

**组件与插件的区别（务必分清）**：plugin 是 Cordis 代码（service/event）；**组件是业务面的一等制品**——它把若干 plugin / skill / seam 编排成一个带 manifest、可版本化、可分发、有标准 I/O 契约的整体。组件本身以 **bundle** 形式挂载到 dsh，对内核零侵入。

### 3.1 组件契约（Component Manifest）

```yaml
# component.yaml  — 挂在 bundle 里，由 Registry 索引
apiVersion: dsh.component/v1
kind: Component
metadata:
  name: sales-funnel-analysis
  version: 1.4.0
  signature: ed25519:<sig>          # 制品签名
  scopes: [data:read:warehouse, kb:query]   # 所需权限
spec:
  requires:                         # 调度约束
    - gpu: false
    - knowledge: sales-kb
  seams:                           # 该组件提供/消费的 seam
    provides: [dsh.component.analysis]
    consumes: [ctx.knowledge, ctx.jobs]
  io:                             # 标准 I/O 契约
    input:  { ref: DataRef, params: FunnelParams }
    output: { result: AnalysisResult, view: ConversationNode }
  wires:                          # 挂载到哪些 dsh 扩展点
    tools: [tool-funnel-query]     # 注册到 ctx.tools
    nodes: [node-funnel-chart]     # ConversationNodeDefinition
    jobs:  [job-funnel-compute]    # ctx.jobs 后台计算
```

### 3.2 数据分析组件化

= 一个 bundle，组合：`ctx.tools`（查询/分析工具 schema）→ `ctx.jobs`（后台重计算）→ `ConversationNodeDefinition`（可视化节点）+ `ctx.goals`（分析目标）。

- 标准 I/O：组件接收 `DataRef + params`，产出 `AnalysisResult + 可视化 Node + kb/* 事件`。
- 例：「销售漏斗分析组件」引用 pandas 工具 + 数据仓库 seam + 图表 Node；被任意业务智能体以 `tool-funnel-query` 调用，结果直接渲染到 Web Client Chat（`ConversationNodeDefinition` 是 dsh 原生扩展点）。
- 组件可声明为**远程 seam Provider**（2.1），由 capability 节点承载重算力。

### 3.3 知识库组件化

新增原生式 seam——`ctx.knowledge`：

| Seam 角色 | 实现 |
|-----------|------|
| Service Definition | `ingest(corpus) → kbId` / `query(kbId, q, topK) → chunks` |
| Service Provider | 向量库适配器（Milvus/pgvector/自研），每个 KB 组件自带一个 Provider |
| Consumer | RAG 工具注册到 `ctx.tools`，经 `agent/pre-step` 注入检索结果（`agent.inject()`） |

- 知识库组件 = 打包好的 KB（自有 Provider + ingest 流水线 + RAG 工具 + `kb/*` 事件策略）。
- 复用 dsh 事件范式：`fs/*` 管文件系统策略，`kb/*` 管知识库策略，二者对称。

### 3.4 业务协同组件化

= 流程 / 审批 / 人机协同组件，全部走 dsh 原生扩展点：

- **目标与编排**：`ctx.goals` 管理同会话目标，经 `agent/*` 续跑。
- **审批 / 拦截**：监听 `agent/turn-stopping`（串行、无 next，可停转）与 `tools/pre-execute`（可拒绝），实现 human-in-loop 与合规闸。
- **交接 / 多角色**：`ctx.agentTeams` 花名册 + 任务板做角色间 handoff。
- **事件驱动**：新增 `biz/*` 能力事件（对齐 `fs/*`/`telemetry/*`），让流程状态可被外部系统订阅。

---

## 4. 技能分发（Skill Distribution）

### 4.1 现状与缺口

技能本就是 `.agents/skills/` 下的文件，经符号链接暴露给 Agent 工具。现状发现机制靠 **GitHub `dsh-plugin` topic**——无版本、无签名、无灰度、无私有分发。

### 4.2 设计：Skill Registry / Marketplace

- **打包**：技能 = bundle + `skill.yaml`（语义版本、ed25519 签名、权限 scope、依赖组件）。
- **发现**：建私有/公有 Registry API（不止 GitHub topic）；`dsh-plugin` topic 镜像进 Registry 保 OSS 可发现性。
- **安装即挂载**：拉取后自动注册 bundle，`cordis.patch.yml` 叠加生效——与 dsh 原生安装路径一致。
- **灰度与治理**：按租户 realm 做灰度发布；OPA 校验签名与 scope 后才允许挂载到 `ctx.tools`。
- **回流**：agent 在 `agent/validation` 阶段产出的改进技能，经人工审批后写回 Registry（呼应 dsh「agent 还能改装自己」）。

---

## 5. 业务智能体分发协同（Agent Distribution & Collaboration）

### 5.1 智能体作为制品

**Agent = agent preset/profile + 引用的组件/技能 + policy**，可版本化、可注册、可分发。

- 能力隔离沿用 dsh：`compose an agent preset; a service row there needs an isolate realm`。
- 调度约束写在 manifest 的 `requires`，交给 Scheduler 落节点。

### 5.2 分发

- **Agent Registry**：发布/订阅，跨集群联邦（中心 Registry + 边缘节点 pull）。
- **一键部署**：签名校验 + policy 闸门 → Scheduler 落 agent 节点 → profile/bundle 同步。
- **联邦**：多集群间 agent/技能/组件可授权互访，控制面做跨域鉴权。

### 5.3 协同（multi-agent，跨节点）

- 基于 `ctx.agentTeams` 协调 seam（持久花名册 + 任务板 + 信箱），** backing 改为分布式存储 + 事件总线**（见 2.4）。
- 智能体间经「信箱 + 能力事件总线」通信，而非进程内调用——天然跨节点。
- **共享记忆**：经复制式 Session 日志（2.3）与共享 `ctx.goals` 实现。
- **自改进闭环**：agent 可提交新技能/组件 → 审批 → 入 Registry → 被其他 agent 消费。

```
[业务智能体A@节点1] ──mailbox/event──▶ [Agent Teams 协调seam(分布式)]
        │                                       │
        ├─ consume 远程 KB seam (节点3)          ├─ 任务板派发子任务
        └─ ctx.jobs → 数据分析组件(节点2)        └─ [业务智能体B@节点4] 续跑
```

---

## 6. 治理与平台能力

| 能力 | 实现路径 |
|------|----------|
| 租户隔离 | `isolate` realm，每租户一 realm |
| 鉴权/限流/数据边界 | OPA 挂在 seam 调用与 `tools/pre-execute` |
| 计量计费 | Usage Ledger 归集每条 seam 调用、`llm/stream`、节点时长 |
| 可观测 | 把 `agent/*`/`tools/*`/`llm/stream` 瀑布做成跨节点 OTel trace |
| 护栏/评测 | 在 `agent/pre-step`/`agent/request`  waterfall 注入评测与拒绝 |
| 审计 | append-only SessionEvent 日志即不可篡改审计源 |

---

## 7. 产品形态设计

四个面向，对应平台的四类用户：

| 产品面 | 用户 | 核心能力 |
|--------|------|----------|
| **开发者平台** | 插件/组件/技能/智能体作者 | 脚手架、manifest 编辑、本地 `dsh --dump-config` 调试、发布到 Registry |
| **运行时控制台** | SRE/平台运维 | 集群拓扑、节点角色、弹性伸缩、跨节点 trace、告警 |
| **市场（组件/技能/智能体）** | 所有消费者 | 检索、安装、灰度、联邦订阅、用量看板 |
| **业务工作台** | 业务/终端用户 | 拖拽编排业务流、人机协同审批、结果可视化 |

---

## 8. 关键技术选型

| 关注点 | 推荐 | 与 dsh 的关系 |
|--------|------|----------------|
| 插件容器 | **Cordis（保留）** | dsh 内核，不替换 |
| Seam 网络代理 | gRPC / QUIC（低延迟流式） | 承载 DistributedSeamProxy |
| 日志复制 | Raft 或 NATS JetStream / 对象存储 segment | backing `ctx.sessions` |
| 协调 seam 存储 | CRDB / etcd + 消息总线 | backing `ctx.agentTeams` |
| 策略 | OPA（Rego） | 挂在 seam / `tools/pre-execute` |
| 可观测 | OpenTelemetry + Tempo/Jaeger | trace `agent/*` `tools/*` `llm/stream` |
| 运行时隔离 | 容器 / gVisor / microVM per node | node = dsh profile 实例 |
| Registry | 对象存储 + 元数据 DB + 签名校验 | 组件/技能/智能体分发 |

---

## 9. 实施 Roadmap（分阶段，均走 dsh 扩展点）

| 阶段 | 范围 | 关键交付 | 是否改内核 |
|------|------|----------|------------|
| **P0 对齐** | 通读 `docs/architecture.md` + ADR 0009/0010；用 `dsh --profile web --dump-config` 摸清启动树 | 扩展点清单、patch 模板 | 否 |
| **P1 组件化 + 技能分发（单节点高价值）** | Component Manifest + 本地 Registry + 知识库 seam（`ctx.knowledge`）+ 技能打包/签名/灰度 | 可复用组件、可分发技能 | 否（全 plugin/bundle） |
| **P2 跨节点能力** | DistributedSeamProxy + 复制式 Session 日志 + 弹性 Scheduler | 远程 KB/工具/GPU seam，跨节点 resume | 否 |
| **P3 智能体分发协同** | `ctx.agentTeams` 分布式 backing + Agent Registry + 跨集群联邦 | 多智能体跨节点协同、自改进闭环 | 否 |
| **P4 平台 GA** | 完整控制面（OPA/Usage/OTel）、多租户 realm、昼夜弹性、市场 | 生产级平台 | 否 |

> **全程不 fork dsh core**：所有改动都通过「挂载 plugin / 组合 bundle / 叠加 `cordis.patch.yml`」完成——这正是 dsh 的设计初衷，也保证你能随上游 breaking change 平滑升级。

---

## 10. 关键决策与风险（opinionated）

1. **不要重写 Cordis / 不要 fork 核心**。dsh 的价值与壁垒在于「一切皆插件」的可组合性；自建内核会丢失上游红利。所有扩展走 plugin/bundle/seam/event。
2. **分布式的最大杠杆是 Seam 网络化**，不是把 Agent Loop 搬上网络。先把 `DistributedSeamProxy` + 复制式日志做扎实，组件化/协同自然成立。
3. **组件是业务面制品，插件是内核面制品**。别把业务逻辑写进 plugin；组件用 manifest 编排 plugin/skill/seam，保持可复用、可灰度、可审计。
4. **SessionEvent 日志是你的杀手锏资产**：它既是模型上下文源、又是审计源、又是跨节点协同的共享真相。任何「模型可见」的输入都必须走日志（dsh 的运行时不变量），改造时务必保留。
5. **风险点**：dsh 处开发者预览、会有兼容性破坏性变更；对策是**把你对 dsh 的改动全部收敛到 bundle + patch 层**，核心只依赖稳定语义（seam 三件套、event 瀑布、`ctx.*` 服务），降低升级成本。
6. **分布式一致性取舍**：agent 协同走「最终一致的事件总线 + 复制日志」，而非强一致锁；避免把 LLM 推理路径变成分布式事务瓶颈。

---

### 一句话总结

> 在 `dsh` 上做分布式平台，**底座是 Cordis 的 seam/event/profile，分发是 bundle+manifest+签名 Registry，协同是 `ctx.agentTeams` 的分布式 backing，共享真相是复制式 SessionEvent 日志**。把「seam 变成网络可达」这一杠杆做透，数据分析/知识库/业务协同组件化与技能/智能体分发协同会一次性全部成立——且全程零侵入 dsh 内核。

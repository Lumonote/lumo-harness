# DeepSeek Harness 分布式平台 · 分布式注册 + 大数据流程化 Addendum

> ⚠️ **已归档 · 演进快照，非当前口径**
>
> 本文为逐轮讨论的历史快照，其内容已被权威整合版 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md) **§6.1、§9** 取代。
>
> 文中出现的 `etcd / NATS / ConfigDistributor / APISIX / Envoy` 等口径**已被后续决策推翻**；现行决策为 **Nacos / RocketMQ / 全栈 Go 自研网关**。
>
> **请勿据本文实施；一切以 V2 为准。**

> **【已过时 · 以 V2 为准】** 本文已被 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）取代。文中注册表 etcd/Raft + Redis 心跳已改为 **Nacos**。

> 接续前四篇（总体架构 / 数据层 / 调度面 / 异步协同+多端）。
> 本篇补两块：**① 分布式注册（Discovery & Registration）** 与 **② 大数据流程化增强（Big-data Flow）**。
> 前者是控制面的「发现/寻址骨架」，后者把「数据分析组件化」升级为真正的流程引擎。二者与前述所有层强耦合：算子进注册表、血缘进 Nebula、流程触发接 Trigger Bus、监控接多端。

---

## 0. 范围与总览

| 维度 | 前文 | 本篇新增 |
|------|------|----------|
| 控制面 | Registry（L5 制品注册）、Scheduler 放置 | **分布式注册**：节点/能力/制品/实例四类注册 + 服务发现 + 联邦 + 事件驱动重平衡 |
| 数据面 | 数据分析组件化（bundle + Doris/Nebula seam） | **大数据流程化**：Pipeline = DAG 算子，批流一体、可视化编排、血缘、Agent 编排 |

> 一句话：**注册表让「东西在哪、谁能干什么」全局可寻址；流程引擎让「大数据分析」从单组件升级为可编排、可复用、有血缘的 DAG。** 两者是控制面与数据面的收口。

---

## 1. 分布式注册（Discovery & Registration）

### 1.1 四类注册

| 注册类型 | 内容 | 消费者 |
|----------|------|--------|
| **节点/资源注册** | 节点入网、资源画像（GPU/CPU/内存/带宽）、region/AZ | Scheduler 放置 |
| **能力/Seam 注册** | 该节点提供哪些 seam（doris/nebula/gpu/kb…）及配额 | Seam Proxy 路由、Scheduler `requires` 匹配 |
| **制品注册** | 组件/技能/智能体 manifest：版本、签名、依赖、scope | 市场/分发、Agent 组装 |
| **实例/端点注册** | 运行中的服务实例与地址（用于细粒度路由） | Gateway、Seam Proxy 寻址 |

### 1.2 注册表架构（强一致元数据 + 心跳快路径）

```
┌──────────── 强一致元数据层 (etcd / TiDB / CRDB, Raft) ────────────┐
│  nodes / seams / artifacts / instances   ← 注册真相源, 防双放置   │
└───────────────────────────────────────────────────────────────────┘
        ▲ watch                         │ 读(放置/路由)
        │ 事件驱动                       ▼
┌── 心跳快路径 (Redis TTL lease) ──┐   Scheduler / Seam Proxy / Gateway
│ 节点健康/租约, 秒级过期           │
└─────────────────────────────────┘
        ▲ 跨集群联邦: 中心 Registry ──pull/sync──▶ 边缘 Registry (按版本/签名解决冲突)
```

- **元数据强一致**：用 etcd/Raft 或 TiDB/CRDB，保证 Scheduler 不会把同一 seam 双放置、Seam Proxy 不会路由到已下线的 provider。
- **心跳快路径**：健康/租约走 Redis TTL lease，秒级过期、低开销；元数据层只在注册/变更时写。
- **联邦**：多集群间中心 Registry 与边缘 Registry 同步（pull），冲突按「版本 + 签名」裁决。

### 1.3 发现流（谁在消费注册表）

```
Scheduler.place(task):
   requires = task.requires                      # ["dataNode:doris","gpu:true"]
   nodes = Registry.querySeam("doris") ∩ queryNode("gpu")   # 能力注册
   pick by score (affinity/load) → 下发 Local Queue

Seam Proxy.route(call):
   providerNode = Registry.resolveSeam(call.seam) # seam→节点映射
   forward via gRPC → 远端 Provider
```

### 1.4 事件驱动（不是轮询）

- 节点上下线、seam 配额变更、制品新版本 → 注册表 **watch 事件** → 触发：
  - Scheduler 重平衡（漂移任务）；
  - `cordis.patch.yml` 重分发（节点能力变化 → 重新组合 bundle）；
  - 灰度路由（新制品版本按 realm 灰度，见 §1.5）。
- 节点身份用 dsh `credentials/CredentialKey`，注册即鉴权。

### 1.5 生命周期与灰度

```
注册(带 CredentialKey) → 心跳(lease 续期) → 不健康(Leader 摘除, 任务漂移)
   → 注销(优雅 drain)
制品: 版本注册 → 按 realm 灰度路由(OPA 校验签名/scope) → 全量
```

---

## 2. 大数据流程化增强（Big-data Flow）

### 2.1 从「分析组件」升级为「流程引擎」

前文的数据分析组件 = 一个 bundle 组合若干 seam。本篇把它升级为 **Flow Engine**：

> **Pipeline = DAG 化的算子（operator）流；每个算子是已注册的组件，背靠某个数据/能力 seam。**

```
        ┌── source(PG) ─┐
Planner─┤               ├─ transform(Spark/Flink) ─ aggregate(Doris) ─ graph(Nebula) ─ sink(可视化/KB)
        └── source(Kafka/流)─┘
              DAG, 有依赖/并行/审批门
```

### 2.2 算子目录（Operator Catalog，本身注册进 Registry）

| 算子 | 背靠 seam | 说明 |
|------|-----------|------|
| source | `ctx.datastore.sql/olap`、`ctx.knowledge.graph`、Kafka | 取数（批/流） |
| transform | Spark / Flink / Python(`ctx.jobs`) | 清洗、特征、ETL |
| join / aggregate | `ctx.datastore.olap`(Doris) | 重聚合 |
| graph | `ctx.knowledge.graph`(Nebula) | 关系/社区/血缘 |
| ML / infer | `ctx.llm` + 训练集群 | 建模/推理 |
| sink | 可视化 Node / KB / 数仓 | 产出 |

- **目录即注册**：算子作为组件在 Registry（§1.1）登记 → 全局可发现、可复用、可版本化。
- Agent 组合 pipeline 时，从目录拉算子而非临时写代码。

### 2.3 引擎能力

| 能力 | 实现 |
|------|------|
| **DAG 编排** | 算子依赖图 + 并行执行 + 失败重试/断点续跑（状态在 Session 日志） |
| **调度** | cron / 事件触发（接 Trigger Bus：webhook/定时器唤醒 pipeline） |
| **批流一体** | 同一 DAG 模板既跑批（Spark）也跑流（Flink），算子语义统一 |
| **可视化编排** | web 端用 `ConversationNodeDefinition` 渲染 DAG 节点，拖拽即生成 manifest |
| **血缘（lineage）** | 算子读写关系写进 **Nebula**（图天然适合列/表/算子级血缘，呼应数据层） |
| **参数化/模板** | pipeline 即组件，模板化、版本化、可分发（复用组件 manifest） |

### 2.4 Agent ↔ 流程（LLM 即编排者）

```
Agent(Planner) ──LLM 生成 DAG──▶ FlowEngine.submit(pipelineManifest)
   ├─ 校验(schema/护栏: 防环/防坏SQL/越权 scope)
   ├─ 编译为分布式 job → 数据 capability 节点执行(ctx.jobs + Scheduler)
   ├─ 进度事件 → session/event → 所有终端可见(接多端)
   └─ 输出 → agent.inject() 续跑 / 直接 sink 可视化
```

- **护栏**：LLM 生成的 DAG 必须过 schema 校验 + OPA scope 校验 + 防无限环 + Seam 速率限流（保护 Doris）。
- **长任务**：pipeline 跑批走 `ctx.jobs`，受 Scheduler 并发闸与昼夜弹性约束。

### 2.5 与前述文档的衔接（一张网）

| 流程引擎特性 | 复用前文 |
|--------------|----------|
| 算子存取数据 | 数据层 seam（PG/Doris/Nebula/Redis） |
| 算子发现/复用 | 本篇 §1 分布式注册（Operator Catalog） |
| pipeline 触发 | 异步协同的 Trigger Bus（cron/webhook） |
| 进度/结果多端可见 | 多端的 `session/event` 事件汇 |
| 血缘存储 | 数据层的 Nebula Graph |
| 执行放置/限流 | 调度面的 Scheduler + Seam 速率闸 |
| 状态/断点续跑 | 复制式 SessionEvent 日志 |

---

## 3. 组合架构图（控制面 + 数据面收口）

```
┌──────────── 控制面 backbone: 分布式注册表 (etcd/Raft + Redis 心跳) ────────────┐
│  nodes │ seams │ artifacts(组件/技能/智能体/算子) │ instances   ← watch 事件    │
└───────┬───────────────────────────────────────────────────────────────────────┘
        │ 发现(放置/路由) + 事件(重平衡/patch/灰度)
   ┌────┴──────────────── 运行时 ────────────────────────────────────────┐
   │  Gateway ─ Scheduler ─ Agent 节点(Worker Pool) ─ Seam Proxy          │
   │        │                                        │                     │
   │   Flow Engine (DAG 编排/调度/血缘)            数据 capability 节点      │
   │        │ 算子目录(注册表)                       (Doris/Nebula/PG/Redis) │
   │        ▼                                                                │
   │  Trigger Bus(异步唤醒) ──▶ session/event ──▶ 多端(web/CLI/IDE/mobile)  │
   └───────────────────────────────────────────────────────────────────────┘
```

---

## 4. 关键决策与风险（opinionated）

1. **注册表必须强一致（etcd/Raft）**，心跳快路径才用 Redis。否则 Scheduler 双放置、Seam Proxy 路由到死节点。
2. **发现用 watch 事件驱动，不用轮询**：节点上下线、制品新版 → 触发重平衡/patch/灰度，实时且省资源。
3. **算子进注册表目录**，形成可复用资产；不要让 Agent 每次临时拼 SQL/代码。
4. **血缘进 Nebula**：图库天生适合列/表/算子级血缘，别用关系表硬存。
5. **批流一体**，别维护两套算子（批一套、流一套）——同一 DAG 模板两跑。
6. **LLM 生成的 DAG 必过护栏**：schema 校验 + 防环 + OPA scope + Seam 限流，否则一个坏 pipeline 拖垮 Doris 或越权读数。
7. **流程触发接 Trigger Bus、监控接多端**：让 pipeline 像 agent 一样可异步、可跨端观察。

---

## 5. 代码骨架（Cordis / TS 风格，示意）

```ts
// ---- 分布式注册: 节点 + seam 注册(etcd) ----
const reg = new EtcdRegistry();
await reg.put(`/nodes/${id}`, { capabilities: ["doris","nebula"], realm }, { ttl: 15 }); // 心跳 lease
reg.watch("/nodes/", ev => scheduler.rebalance(ev));   // 事件驱动重平衡
reg.watch("/artifacts/", ev => distributor.patch(ev));  // 新制品→重分发

// Scheduler 用注册表发现
function place(task: Task) {
  const nodes = reg.querySeam(task.requires);   // seam→节点
  return scoreAndPick(nodes, task);
}

// ---- 大数据流程: DAG 提交 + 算子目录(来自注册表) ----
interface Op { id: string; type: string; in: string[]; cfg: unknown; }
interface Pipeline { id: string; dag: Op[]; trigger?: Trigger; }

class FlowEngine {
  catalog = new OperatorCatalog(reg);          // 算子从注册表拉
  async submit(p: Pipeline, cred: CredentialKey) {
    guard(p, cred);                             // schema + 防环 + OPA scope
    lineage.writeNebula(p);                     // 血缘进 Nebula
    await scheduler.runAsJob(p.compile());      // 编译为分布式 job
    sessionEvent.emit(`pipeline/${p.id}/progress`); // 多端可见
  }
}
```

> 同样只依赖 dsh 稳定语义（`ctx.jobs`/`ctx.llm`/`session/event`/`credentials`/`ConversationNodeDefinition`），注册表与 Flow Engine 是控制面/数据面的新增服务，对 Cordis 内核零侵入。

---

### 五篇文档关系

| 文档 | 解决 |
|------|------|
| `deepseek_harness_distributed_design.md` | 总体分层 + Seam 网络化 + 组件化/技能/智能体分发 |
| `deepseek_harness_data_layer.md` | 数据基础设施（PG/Doris/Nebula/Redis/分布式DB）作为 Seam Provider |
| `deepseek_harness_agent_scheduling.md` | 调度面：高并发协同调度智能体集群 |
| `deepseek_harness_async_multiterminal.md` | 异步协同 + 多端 |
| **`deepseek_harness_registry_bigdata_flow.md`（本篇）** | **分布式注册（发现/寻址骨架）+ 大数据流程化（DAG 流程引擎）** |

五篇构成「在开源 dsh 上做分布式智能体平台」的完整蓝图，且全程走 dsh 原生扩展点、零侵入内核。

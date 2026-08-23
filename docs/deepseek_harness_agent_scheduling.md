# DeepSeek Harness 分布式平台 · 高并发协同调度智能体集群设计

> ⚠️ **已归档 · 演进快照，非当前口径**
>
> 本文为逐轮讨论的历史快照，其内容已被权威整合版 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md) **§6.2、§7** 取代。
>
> 文中出现的 `etcd / NATS / ConfigDistributor / APISIX / Envoy` 等口径**已被后续决策推翻**；现行决策为 **Nacos / RocketMQ / 全栈 Go 自研网关**。
>
> **请勿据本文实施；一切以 V2 为准。**

> **【已过时 · 以 V2 为准】** 本文已被 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）取代。文中 Global Task Bus 的 NATS/Redis Streams 已改为 **RocketMQ**。

> 接续 `deepseek_harness_distributed_design.md`（总体架构）与 `deepseek_harness_data_layer.md`（数据层）。
> 本篇细化 **L1 运行时里的「调度面」**：如何让协同智能体在集群上**分布式、高并发、可协作**地运行。
> 前提已具备：① Seam 网络化（DistributedSeamProxy）② 复制式 SessionEvent 日志 ③ `ctx.agentTeams` 分布式 backing。

---

## 0. 范围与总览

调度面要回答三件事：

| 问题 | 答案方向 |
|------|----------|
| **放在哪（分布式）** | Scheduler 按 `requires`/`affinity` 把任务放到合适节点的 AgentSlot |
| **怎么扛住量（高并发）** | 无状态 Worker + Slot 池 + 批处理 LLM 网关 + Backpressure |
| **怎么一起干（协同）** | `ctx.agentTeams`（roster + task board + mailbox）+ 共享日志/目标/KB |

> 一句话：**Worker 无状态化 + Session 状态外置（复制日志）= 水平伸缩与崩溃恢复的命脉；LLM 批处理网关 = 吞吐的命脉。** 这两点做透，高并发协同自然成立。

---

## 1. 核心抽象（数据模型）

| 抽象 | 含义 | 关键字段 |
|------|------|----------|
| **Task** | 调度单元（一次 agent 工作的请求） | `taskId, agentRef, input, priority, sla, requires[], realm, deps[], status` |
| **AgentSpec / Preset** | 智能体定义（能力集 + 组件/技能引用 + policy） | `presetId, seams[], scopes[], isolateRealm` |
| **AgentSlot** | 节点上的一个 agentLoop 实例（worker 槽） | `slotId, nodeId, agentLoopRef, busy, currentTask` |
| **Team** | 协同组 | `teamId, roster[AgentRole], taskBoard(DAG), mailbox` |
| **SeamQuota** | 某 seam 的并发/速率预算 | `seam, maxConcurrent, ratePerSec, tenantScope` |

- **Task 是 durable 的**：进分布式任务总线即落盘，崩溃可重投。
- **AgentSlot 是无状态的**：它只承载 `agentLoop` 执行；会话状态全在复制式 Session 日志里。

---

## 2. 运行时拓扑（调度视角）

```
                 ┌──────────────── 调度面 (Control Plane) ────────────────┐
  客户端 ──▶ Gateway ──鉴权/限流──▶  Global Task Bus(NATS/Redis Streams)
                 │                      │  Scheduler(放置/优先级/配额)
                 │                      ▼
            ┌───────── 数据 capability 节点 (Doris/Nebula/PG/Redis) ─────────┐
            │   ←── DistributedSeamProxy ──→ Agent 节点集群                  │
            │                              ┌──────────────────────────────┐  │
            │   节点 k                      │ Agent Worker Pool (N slots) │  │
            │   ├─ Local Queue             │  slot0 slot1 ... slotN-1    │  │
            │   ├─ Scheduler Agent(client) │   │ 每个 slot = 一个 agentLoop│  │
            │   └─ Seam Proxy client ──────┼─▶ 驱动 agent/* 事件瀑布      │  │
            │                              │  状态↔复制式 Session 日志    │  │
            │                              └──────────────────────────────┘  │
            └───────────────────────────────────────────────────────────────┘
```

- **Gateway**：接入、鉴权（realm）、全局限流（per-tenant 配额），把 Task 投递进 Global Task Bus。
- **Scheduler**：消费总线、做放置决策、下发到节点 Local Queue。
- **Agent 节点**：Worker Pool 拉取 Local Queue 的 Task，驱动 `agentLoop`。

---

## 3. 多级队列与调度算法

### 3.1 三级队列

```
Global Task Bus (跨节点, 持久, 分区 by realm)
   └─ 每节点 Local Queue (内存 + 持久兜底)
        └─ 每 AgentSlot 的 inbox (一个 agentLoop 一次只跑一个 turn 的输入)
```

### 3.2 排序与公平

- **优先级**：`priority` 高者先出；同优先级按 `sla` 截止时间（EDF，Earliest Deadline First）。
- **公平**：每 realm/tenant 一个**加权公平队列（WFQ）**，防止大租户饿死小租户。
- **依赖**：有 `deps[]` 的 Task 进 DAG 等待，前置完成才入队（team 内子任务同理）。

### 3.3 放置策略（Scheduler.place）

```
score(node) = w1 * constraintMatch(requires, node.capabilities)
            + w2 * affinityGain(task, node)        # 任务靠数据/靠队友
            + w3 * (1 - node.load)                 # 负载均衡
            - w4 * crossAZcost                     # 跨可用区代价
选 score 最高的、且仍有空闲 AgentSlot 的节点。
```

- `requires`：如 `dataNode:[doris,nebula]`、`gpu:true` → 只在具备的节点候选。
- `affinity`：把协作团队的多角色尽量放同 AZ（减少 mailbox 延迟）；把分析任务放近 Doris 节点（数据本地性）。
- **装箱**：同节点尽量合并同类任务，提升 LLM 批处理命中率（见 §6.1）。

### 3.4 并发控制（四道闸）

| 闸 | 作用 | 实现 |
|----|------|------|
| 全局 LLM token 预算 | 防推理集群过载 | `SeamQuota(ctx.llm)` 按 tenant 限流 |
| 节点 Slot 上限 | 防单节点 agentLoop 爆炸 | 节点 Slot 池固定大小 |
| 租户并发配额 | 防单租户占满 | WFQ + `maxConcurrentPerTenant` |
| Seam 速率（Doris/PG） | 防后端被打爆 | Seam Provider 层 `ratePerSec` + 熔断 |

---

## 4. Agent Worker 模型（高并发关键）

### 4.1 无状态 Worker + 有状态 Session

```
Worker 进程(可随时死)           Session 状态(外置, 复制日志)
  AgentSlot0 ──驱动──▶ agentLoop    ◀── deriveMessages() 投影历史
  AgentSlot1 ──驱动──▶ agentLoop    ◀── ctx.sessions.fork/resume
  ...                              （崩溃后任意节点/槽可接管）
```

- **关键**：Worker 不存会话状态。任务的上下文全部来自复制式 SessionEvent 日志。
- **好处**：Worker 水平扩缩、崩溃后任务被重投、由任意空闲 Slot 从日志 resume（`ctx.sessions.fork` 的跨节点版）。

### 4.2 Worker Loop（驱动 dsh 原生事件瀑布）

```text
pull Task from Local Queue
  → 在 Slot 上挂载该 agent 的 preset (cordis patch 叠加, isolate realm)
  → loop:
      claim inbox 输入
      agent/pre-step         (可改写/拒绝可见内容, 含护栏/评测)
      agent/request ─▶ ctx.llm(adapter, 走批处理网关) ─▶ llm/stream ─▶ assistant/chunk*
      tools/pre-execute ─▶ tools/execute(seam proxy 到远端) ─▶ tools/post-execute
      agent/turn-stopping   (可停转/交还)
      tools owe another request? → 继续 step; 否则结束, 释放 Slot
  → ack Task 到 Global Bus, 写入结果事件到 Session 日志
```

完全复用 dsh 的 `agent/*` / `tools/*` 瀑布，只是 `ctx.llm` 与 `ctx.tools` 的 Provider 经由 Seam Proxy 落到远端 capability 节点。

---

## 5. 协同调度（多智能体）

### 5.1 Team = roster + task board + mailbox

建立在 `ctx.agentTeams`（分布式 backing）之上：

- **roster**：团队角色清单（planner / researcher / analyst / reviewer…）。
- **task board**：DAG 化的子任务板，持久化 → 支持 work-stealing。
- **mailbox**：agent 间异步、持久的消息信箱（点对点 + 发布订阅）。

### 5.2 协同生命周期（以「经营分析」为例）

```
Planner Agent
  ├─ 收到 Goal (ctx.goals)
  ├─ 分解 → task board: [拉数@Doris, 关系@Nebula, 可视化, 合成]
  └─ 派发 subtask 到 mailbox
        │  (work-stealing)
Worker Agent A ─ claim[拉数] ─▶ 走 ctx.datastore.olap ─▶ 写回结果事件
Worker Agent B ─ claim[关系] ─▶ 走 ctx.knowledge.graph ─▶ 写回结果事件
        │
Planner ─ 汇聚结果 ─▶ 合成 ─▶ 可视化 Node + 交 human 审批(agent/turn-stopping)
```

- **共享记忆**：复制式 Session 日志（共享上下文）+ `ctx.goals`（共享目标）+ KB seam。
- **交接**：经 mailbox/事件总线，而非进程内函数调用 → 天然跨节点。

### 5.3 三种协同拓扑

| 拓扑 | 适用 | 实现 |
|------|------|------|
| **层级 Planner-Worker** | 可分解的目标（分析/编码） | 一个 planner 拆 DAG，多 worker claim |
| **流水线 Pipeline** | 阶段串接（采集→清洗→分析→报告） | subtask 间 `deps[]` 串联 |
| **议会 Deliberation** | 需多视角权衡（评审/决策） | 多 agent 向同一 mailbox 发观点，planner 收敛 |

---

## 6. 高并发专项优化

### 6.1 LLM 批处理网关（吞吐命脉）

- `ctx.llm` 的 Provider 不一对一调推理集群，而是**批处理网关**：在时间窗内汇聚多个并发 `agent.request`，合并成 DeepSeek 推理系统需要的大 batch（MoE  sparsity 要求超大 batch 才喂得饱 expert）。
- 这把「很多 agent 并发」翻译成「推理集群的大 batch」，吞吐随并发上升而上升（而非下降）。

### 6.2 流式 / 增量

- `assistant/chunk` 原生流式；网关边生成边推 UI，首 token 延迟不受批处理拖累（prefill/decode 分离）。

### 6.3 Backpressure（必须前置）

- Local Queue 超阈值 → Gateway 直接 `429` 回客户端，不雪崩。
- 每 Seam 速率熔断（Doris/PG/LLM），保护后端。

### 6.4 缓存与并行

- **Redis**：工具结果缓存、agent 记忆、KV 缓存 → 重复子任务秒回。
- **并行子代理 fan-out**：planner 一次性派发 N 个独立 subtask，Worker 池并行吃。

### 6.5 亲和性

- 分析任务放近 Doris 节点（数据本地性）；同 team 角色放同 AZ（mailbox 低延迟）。

---

## 7. 容错与弹性

| 故障 | 恢复 |
|------|------|
| Worker 崩溃 | Task 在 Global Bus 未 ack → 超时重投 → 任意 Slot 从复制日志 resume |
| 子任务 agent 死 | task board 持久 → subtask 被其他 worker work-stealing 重 claim |
| 节点下线 | Scheduler 摘除，其 Local Queue 任务漂回 Global Bus 重调度；数据节点走副本 |
| 昼夜峰谷 | 按负载扩缩 Agent 节点（闲时回收、忙时扩容），呼应前文弹性 |

---

## 8. 可观测

- **每任务 trace**：`queue_wait → place → step* (agent/pre-step, agent/request, llm/stream, tools/*)` 跨节点串联（OTel）。
- **调度看板**：队列深度、Slot 利用率、每租户并发、各 Seam 饱和度、批处理命中率、task board 阻塞点。

---

## 9. 关键决策与风险（opinionated）

1. **Worker 必须无状态**：会话状态外置到复制日志，否则无法水平伸缩、无法崩溃恢复。这是整篇的命脉。
2. **LLM 批处理网关不可省**：没有它，agent 并发越高推理集群越饿（batch 太小 expert 喂不饱）。这是吞吐的命脉。
3. **协同走 mailbox/事件总线，不走同步 RPC**：同步调用会把 agent 焊成单体，丧失跨节点与容错。
4. **Backpressure 前置**：Doris/LLM 不是无限资源，限流熔断必须放在 Gateway 与 Seam Provider 两层。
5. **不要把 agentLoop 做成巨锁**：用 Slot 池 + 异步事件瀑布，单 slot 一次只推进一个 turn 的输入。
6. **协同最终一致，不引分布式事务**：task board / mailbox 用持久消息 + 幂等 claim，避免把 LLM 路径变成事务瓶颈。
7. **优先级与公平都要有**：只有优先级会饿死小租户；只有公平会拖垮 SLA。WFQ + EDF 组合。

---

## 10. 代码骨架（Cordis / TS 风格，示意非生产）

```ts
// ---- 核心类型 ----
interface Task {
  taskId: string; agentRef: string; input: unknown;
  priority: number; slaMs: number; realm: string;
  requires: string[];            // e.g. ["dataNode:doris","gpu:true"]
  deps?: string[]; status: "queued"|"running"|"done"|"failed";
}

// ---- Scheduler: 放置决策 ----
function place(task: Task, nodes: NodeView[]): NodeView {
  return nodes
    .filter(n => satisfies(n.capabilities, task.requires) && n.freeSlots > 0)
    .map(n => ({ n, score: w1*constraintMatch(n,task) + w2*affinity(n,task)
                       + w3*(1-n.load) - w4*crossAZ(n) }))
    .sort((a,b) => b.score - a.score)[0]?.n ?? throw NoFit;
}

// ---- AgentSlot: 驱动 dsh 原生事件瀑布 ----
async function runSlot(slot: AgentSlot, task: Task, ctx: Context) {
  await ctx.agentLoop.mount(task.agentRef, { isolate: task.realm }); // cordis patch 叠加
  let turn = await ctx.agentLoop.open(task.input);
  while (turn.owes()) {
    const step = await turn.next();
    // agent/pre-step → agent/request → ctx.llm(批处理网关) → tools/*(seam proxy)
    await step.execute({ llm: batchGateway, tools: seamProxy });
  }
  await ctx.sessions.append(resultEvent(task.taskId)); // 写复制日志
  slot.release();
}

// ---- Team: task board + mailbox (work-stealing) ----
class Team {
  board = new DurableDAG();          // 分布式 backing 的 ctx.agentTeams
  mailbox = new DurableQueue();
  async decompose(goal: Goal) { this.board.spawn(planner.split(goal)); }
  async claim(role: string): Promise<Subtask|null> {
    return this.board.takeReady(role);   // 幂等 claim, 崩溃可重取
  }
}
```

> 以上刻意只依赖 dsh 稳定语义（`agentLoop` / `agent/*` / `ctx.sessions` / `ctx.agentTeams` / `cordis.patch`），不碰 Cordis 内核——与总架构「零侵入」原则一致。

---

### 三篇文档关系

| 文档 | 解决 |
|------|------|
| `deepseek_harness_distributed_design.md` | 总体分层 + Seam 网络化 + 组件化/技能/智能体分发 |
| `deepseek_harness_data_layer.md` | 数据基础设施作为 Seam Provider 接入 |
| **`deepseek_harness_agent_scheduling.md`（本篇）** | **调度面：分布式高并发协同智能体集群的运行机制** |

三者共同构成「在开源 dsh 上做分布式智能体平台」的完整蓝图，且全部走 dsh 原生扩展点、零侵入内核。

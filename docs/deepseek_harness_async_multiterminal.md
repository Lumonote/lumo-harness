# DeepSeek Harness 分布式平台 · 异步协同 + 多端设计 Addendum

> **【已整合 · 以 V2 为准】** 本文内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§8.1/§8.2，请以 V2 为权威版本。

> 接续前 three 篇（总体架构 / 数据层 / 调度面）。
> 本篇在调度面之上补两块：**① 异步协同（async）** 与 **② 多端（multi-terminal）**——并说明二者如何叠加成「人在任意端、随时异步参与」的协同集群。
> 全部仍走 dsh 原生扩展点：`session/event`（持久广播）、`agent.inject()`、`ctx.jobs`、`ctx.goals`、`ctx.agentTeams`、`ConversationNodeDefinition`、`credentials/CredentialKey`。

---

## 0. 范围与总览

| 维度 | 前文 | 本篇新增 |
|------|------|----------|
| 协同 | `ctx.agentTeams`（roster+task board+mailbox），同步式 claim | **异步**：suspend/resume、future、trigger bus、长任务、跨端 human-in-loop |
| 客户端 | Gateway 接入 | **多端**：web/CLI/IDE/mobile/API 同为「终端视图」，共享同一事件流 |

> 一句话：**终端只是视图，真相在复制式 SessionEvent 日志；异步只是把「turn 做成可挂起/可唤醒的协程」。两者叠加 = 任何人在任何端、任何时刻异步介入协同。**

---

## 1. 异步协同（Async Collaboration）

### 1.1 为什么 dsh 原生就支持异步

| dsh 原语 | 异步含义 |
|----------|----------|
| **SessionEvent 日志** | durable、可 replay → 任意时刻从日志 resume，天然异步 |
| **`agent.inject()`** | 把模型可见上下文注入「下一个被接纳的请求」——即异步注入，不要求调用方在线 |
| **`ctx.jobs` + `job_*`** | 后台工作，与请求脱钩 |
| **`ctx.goals`** | 同会话目标，跨步骤/跨 turn 延续 |
| **continuable subagents / `agent/*` continuation** | agent 可续跑，状态外置 |
| **`agent/turn-stopping`** | 可停转把控制权交还，之后再唤醒 |

### 1.2 异步原语（在原生之上建三层）

```
① Suspend / Resume（turn 即协程）
   agent turn 中途 suspend → continuation 状态持久化到 Session 日志
   → 触发器(人/定时器/webhook/子任务完成)到达 → resume 续跑
       映射: agent/turn-stopping 停转 + agent.inject() 唤醒 + 日志续投影

② Future / Promise seam
   agent A: future = await(team.mailbox.wait(subtaskId))
   agent B / human: team.mailbox.resolve(subtaskId, result)
   → future 解析, A 的 turn resume。背靠持久 mailbox, 跨节点跨时间成立

③ Trigger Bus（外部唤醒）
   cron / webhook / 消息队列 / 外部系统事件
     → Gateway → 注入 agent inbox (agent.inject 或 ctx.commands)
     → 沉睡的 turn / 长任务被唤醒
```

- **长任务**：跨天运行、节点重启不丢——状态在日志 + 任务总线，worker 死即重投 resume。
- **事件驱动**：外部系统不再「调接口等返回」，而是「发事件进总线，agent 异步处理」。

### 1.3 Human-in-the-loop 异步（跨端）

- 审批/确认请求**持久化**为一条 session 事件；人可在数小时后从任意端批准。
- 批准动作 → Gateway → `agent.inject()` 把结论注入 → 原 turn resume。
- **多人多端同 session/team**：每个人的消息/审批都是一条 session 事件，带 `CredentialKey` 身份与角色；全员视图经同一日志保持一致。

### 1.4 异步协同时序

```
Planner(web) ──分解──▶ task board
   └─ suspend, 等 subtask future
Worker A ──claim[拉数]──▶ 跑完 ──mailbox.resolve(subtaskId)──▶ future 解析
                                                    │
Human(mobile, 2am) ──审批事件──▶ Gateway ──agent.inject()──▶ Planner resume
                                                    │
Planner ──合成──▶ 结果 Node + 交 human 复核(可再次 suspend 等复核)
```
全程无人在线也能推进；谁在线谁介入，介入即事件、事件即真相。

---

## 2. 多端（Multi-Terminal）

### 2.1 核心：终端无关的事件汇（stream）

dsh 原生把 session 事件**持久广播**到 `session/event`。据此：

- 所有终端**订阅同一事件流**（session / team / task board / mailbox）。
- **单一真相 = 复制式 SessionEvent 日志**；终端只是它的一个视图。
- 终端连接即 **replay（从日志补历史）+ live push（订阅 `session/event`）**，天然一致。

### 2.2 终端类型与能力协商

| 终端 | 接法 | 渲染 |
|------|------|------|
| **Web**（`dsh web`, 3080） | WebSocket → `session/event` | 富 UI：`ConversationNodeDefinition` + keyed renderer |
| **CLI**（`npx @deepseek-ai/dsh`） | stdio → 日志投影 | 纯文本 / 树状 |
| **IDE**（VS Code/JB） | 插件驱动 `ctx.agents`，渲染自 `session/event` | 内嵌面板 |
| **Mobile** | 轻量 WS / 轮询 | 紧凑卡片、审批按钮 |
| **API / Webhook / MCP** | REST/gRPC/协议 | 系统消费，无 UI |

- **能力协商**：终端连接时声明 `capabilities`（能渲染哪些 Node 类型）。Agent 产出的可视化节点按终端能力选 renderer——web 给图表、CLI 给表格、mobile 给摘要。
- dsh 原生扩展点 **`ConversationNodeDefinition` + keyed renderer** 正是为此而生。

### 2.3 Terminal Gateway / Presence

```
终端(web/cli/ide/mobile/api)
   │  connect(声明 capability + CredentialKey)
   ▼
Terminal Gateway ── 订阅 ──▶ session/event 流 (replay+live)
   │  presence: 谁在线、在哪个 session/team、什么角色
   │  发送 action: 批准 / 注入 / 命令 / 新消息
   ▼
Gateway ──▶ agent inbox (agent.inject / ctx.commands) 或 team.mailbox
```

- **多终端同看同控一个 session**（协同多人）：presence 让彼此可见；动作都成 session 事件，全员一致。
- **终端身份 = 凭证**：dsh `credentials` / `CredentialKey` → 映射 `realm + role`；审批等敏感动作需签名。
- **离线 / 弱网**：收增量（delta）、可轮询、最终一致；重连即 replay 对齐。

### 2.4 多端架构图

```
        web ┐
        CLI ├─▶ Terminal Gateway ──subscribe/presence──▶ session/event 流
       IDE ┤        │ action(批准/注入/命令)
     mobile┘        ▼
                  Gateway ──▶ agent inbox / team.mailbox
                                │
                          Agent 集群(调度面) ──Seam Proxy──▶ 数据/能力节点
                                │
                          复制式 SessionEvent 日志 ◀── 所有真相在此
```

---

## 3. 异步 × 多端 组合场景

> 经营分析 team：Planner 在 **web** 起任务并 suspend 等数据；Researcher 后台异步跑；**2am 人在 mobile 批了敏感查询**；**web** 看板实时更新、**CLI** 同步打印日志、**IDE** 面板高亮改动——全一致，因为都读同一份复制日志 + task board + mailbox。

---

## 4. 一致性 / 离线 / 安全

| 关注点 | 做法 |
|--------|------|
| 终端一致 | 最终一致，日志 reconcile；事件带 `eventId` 去重幂等 |
| 离线/弱网 | replay + 增量 + 轮询兜底；不要求终端常连 |
| 权限 | 每终端按 `realm+role`（CredentialKey）；审批/注入需签名 |
| 审计 | 所有端动作皆 session 事件 → 不可篡改审计链 |
| 消息顺序 | 同一 session 内按日志序；跨 session 走 team mailbox 因果 |

---

## 5. 关键决策与风险（opinionated）

1. **终端只是视图，真相在日志**：绝不让终端存业务状态，否则多端永远对不齐。日志是唯一 reconciles 源。
2. **异步用 suspend/resume + future，别用忙等/长连接锁**：turn 挂起后释放 Slot，资源不空转；唤醒由事件驱动。
3. **多端共享靠事件 fanout，不靠各自拉 DB**：DB 是 capability 节点的 seam，终端只读事件流。
4. **能力协商必须做**：别假设所有终端都能渲染富节点；按 `capabilities` 选 renderer，否则 mobile/CLI 崩。
5. **弱网/离线必须有兜底**：replay + 轮询 + 增量；否则移动端体验崩。
6. **敏感动作签名 + 角色校验**：人在任意端都能介入，攻击面也变大；审批/注入走 CredentialKey + OPA。

---

## 6. 代码骨架（Cordis / TS 风格，示意）

```ts
// ---- 异步: turn 挂起/唤醒 ----
async function runTurn(slot: AgentSlot, task: Task, ctx: Context) {
  const turn = await ctx.agentLoop.open(task.input);
  while (turn.owes()) {
    const step = await turn.next();
    if (step.needsHuman() && !step.available()) {
      await ctx.sessions.append(suspendEvent(task.taskId, turn.continuation)); // 持久化
      slot.release();                       // 释放 Slot, 不空转
      return;                               // 异步返回, 等待触发器
    }
    await step.execute({ llm: batchGateway, tools: seamProxy });
  }
}
// 触发器(webhook/定时器/人审批) → Gateway → ctx.agents.inject(taskId, result)
//   → 从日志 resume continuation → 重新占用 Slot 续跑

// ---- Future / Promise seam (agent↔agent / agent↔human) ----
class Team {
  async await(subtaskId: string): Promise<Result> {
    return this.mailbox.wait(subtaskId);    // 持久, 跨节点跨时间
  }
  resolve(subtaskId: string, r: Result) { this.mailbox.resolve(subtaskId, r); }
}

// ---- 多端: Terminal Gateway 订阅+重放 ----
function attachTerminal(ws: WebSocket, sessionId: string, cap: Capabilities, cred: CredentialKey) {
  auth(cred);                                // realm + role
  replay(ws, sessionId);                     // 从日志补历史
  subscribe(ws, `session/event:${sessionId}`); // live push
  ws.on("action", a => routeAction(a, cred)); // 批准/注入/命令 → inbox
}
// 渲染: 按 cap 选 renderer
render(node: ConversationNode, cap) => cap.supports(node.type) ? rich(node) : fallback(node);
```

> 同样只依赖 dsh 稳定语义（`session/event`、`agent.inject`、`ctx.agentTeams`、`ctx.agents`、`ConversationNodeDefinition`、`credentials`），零侵入内核。

---

### 四篇文档关系

| 文档 | 解决 |
|------|------|
| `deepseek_harness_distributed_design.md` | 总体分层 + Seam 网络化 + 组件化/技能/智能体分发 |
| `deepseek_harness_data_layer.md` | 数据基础设施（PG/Doris/Nebula/Redis/分布式DB）作为 Seam Provider |
| `deepseek_harness_agent_scheduling.md` | 调度面：分布式高并发协同智能体集群 |
| **`deepseek_harness_async_multiterminal.md`（本篇）** | **异步协同 + 多端：suspend/resume、future、trigger bus、终端事件汇** |

四篇共同构成「在开源 dsh 上做分布式智能体平台」的完整蓝图，且全程走 dsh 原生扩展点、零侵入内核。

# DeepSeek Harness 分布式平台 · Nacos 注册中心 + 自动安装 + RocketMQ A2A Addendum

> ⚠️ **已归档 · 演进快照，非当前口径**
>
> 本文为逐轮讨论的历史快照，其内容已被权威整合版 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md) **§6.1、§6.5、§8.3** 取代。
>
> 文中出现的 `etcd / NATS / ConfigDistributor / APISIX / Envoy` 等口径**已被后续决策推翻**；现行决策为 **Nacos / RocketMQ / 全栈 Go 自研网关**。
>
> **请勿据本文实施；一切以 V2 为准。**

> **【定稿记录 · 已并入 V2】** 本文是 Nacos + RocketMQ 的定稿决策，内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§6.1/§6.5/§8.3，请以 V2 为准。

> 接续前七篇（总纲 + 总体/数据/调度/异步多端/注册流程化/连接器权限分发）。
> 本篇新增三块：**① Nacos 注册/配置中心** **② 多智能体/组件/skill/MCP 分发自动安装** **③ RocketMQ 多 agent A2A**。
> 三者把前文的 etcd + NATS + ConfigDistributor 收敛为两套工业级中间件，并补上「制品下发即自动装配依赖」与「agent 间可靠消息协同」。

---

## 0. 范围与总览

| 维度 | 前文方案 | 本篇升级 |
|------|----------|----------|
| 注册/配置 | etcd(发现) + Redis(心跳) + ConfigDistributor(patch 推送) | **Nacos**：Naming(发现+健康+元数据) + Config(动态推送) 一站式 |
| 制品分发 | 智能体分发体系（发布/部署） | **自动安装**：部署即 reconcile 依赖图（组件/skill/MCP） |
| 消息/A2A | NATS(任务/事件总线) | **RocketMQ**：A2A 信封 + 事务/延时消息 + 能力事件总线 + Trigger |

> 一句话：**Nacos 管「谁在哪、配置怎么下」；自动安装管「下发即装配」；RocketMQ 管「agent 间怎么可靠对话」。** 三者收敛掉 etcd+NATS+ConfigDistributor 三件套。

---

## 1. Nacos 注册 / 配置中心

### 1.1 为什么用 Nacos（对比 etcd + ConfigDistributor）

| 能力 | etcd + Redis + ConfigDistributor | Nacos |
|------|----------------------------------|-------|
| 服务发现 + 健康 | etcd lease + 自研心跳 | **Naming**：ephemeral 实例 + 心跳 + 自动摘流 |
| 元数据(能力/seam) | 自存 | **instance metadata** 原生支持 |
| 动态配置推送 | 自研 patch 下发 | **Config**：listener 推送，节点热加载 |
| 灰度 | 自研 | **beta 灰度发布** 原生 |
| 多集群/隔离 | 自研联邦 | **namespace + 跨集群同步** |
| 运维 | 无界面 | 控制台 + 监听查询 |

→ Nacos 把「注册中心 + 配置中心」合一，省掉 etcd+Redis+ConfigDistributor 三套自研逻辑。

### 1.2 三类注册映射到 Nacos

| 注册类型 | Nacos 形态 |
|----------|------------|
| **节点/实例** | Naming Service：`service=dsh-node`, `cluster=region`, `instance={ip:port, ephemeral:true, metadata:{nodeRole, capabilities:[doris,nebula,gpu]}}` |
| **能力/Seam** | instance `metadata.seams`（Scheduler/SeamProxy 经 Naming 发现） |
| **制品(组件/技能/智能体/MCP)** | Naming：`service=agent.{name}` / `component.{name}`；Config：`dataId={artifact}.yaml` 存 manifest/版本/签名/依赖 |

- 节点身份走 dsh `CredentialKey`，注册即鉴权；**realm ↔ Nacos namespace** 映射做租户隔离。

### 1.3 配置分发：Nacos Config 替代 `cordis.patch.yml` 推送

- dsh 的 bundle 配置、`cordis.patch.yml` 等价物、灰度路由规则、OPA bundle 全存 Nacos Config。
- 节点 `addListener(dataId)` → 变更**推送** → 热加载叠加（对应 dsh 的 patch 机制，无需重启）。
- **灰度**：Nacos beta 发布按 `tag/ip` 灰度，配合 OPA 路由版本（呼应分发体系）。

### 1.4 联邦

- 多集群用 Nacos **namespace** 隔离；跨集群经 namespace 同步（或中心 Nacos 聚合），信任仍靠制品签名（非仅网络）。

---

## 2. 分发自动安装（Auto-install）

### 2.1 依赖图 + Provisioner

Agent manifest 声明依赖：

```yaml
apiVersion: dsh.agent/v1
kind: Agent
metadata: { name: analyst, version: 3.2.0, signature: ed25519:<sig> }
spec:
  preset: analyst-preset
  deps:
    components: [{ name: sales-funnel, version: ">=1.4.0" }]
    skills:     [{ name: dsh-code-review, version: ">=2.0.0" }]
    mcps:       [{ name: slack-mcp, version: ">=1.1.0", scope: [chat:write] }]
  policy: { realm: tenant-a, role: AgentOperator }
```

**Provisioner（声明式 reconcile）**：
```
deploy(agent, realm):
  1. 解析 deps 依赖图(从 Nacos Config / 制品库)
  2. 校验签名(信任链) + OPA scope(≤发布者权限)
  3. 下载 bundle(组件/skill) + MCP server
  4. 安装: mount 为 Cordis plugin/bundle(对应 dsh 扩展点)
  5. 应用 Nacos Config 下发的 patch/配置 → 热加载
  6. 注册 agent 实例(Nacos Naming) → Scheduler 接管
```

### 2.2 MCP 自动安装

- 拉取 MCP server（二进制/容器）→ 启动 → 经 dsh `python/` 的 **MCP bridge** 把其 tools/resources 注册进 `ctx.tools`（tool schema 进 prompt 装配）。
- 安装前校验签名 + scope；连接器类 MCP 走 ConnectorGateway 治理（限速/熔断/PII）。

### 2.3 幂等 / 版本 / 自愈

- **声明式**：节点状态 reconcile 到 manifest 期望态（GitOps 风格）；重复部署幂等。
- **自愈**：节点故障 → 任务漂移 → 新节点重 provision 同一 manifest；升级=改版本→重 reconcile（回滚=降版本）。
- **多智能体共存**：同节点多 agent 各自独立 preset + `isolate` realm，依赖按需共享/隔离。

### 2.4 安全

- 安装前**签名校验**（防投毒）；OPA scope 校验；最小权限挂载。

---

## 3. RocketMQ 多 agent A2A

### 3.1 为什么 RocketMQ（对比 NATS）

| 能力 | 价值 |
|------|------|
| **事务消息** | 「扣配额 + 发任务」原子（UsageLedger 与发信一致） |
| **延时/定时消息** | 原生异步唤醒 agent/pipeline（部分替代 cron） |
| **顺序/FIFO** | 同 agent 消息保序 |
| **高吞吐 + 重试/死信** | A2A 大规模可靠投递 |
| 企业级运维 | 控制台、消费进度、回溯 |

### 3.2 主题模型

```
team.{teamId}        广播(团队内协同/任务板变更)
agent.{agentId}      点对点(某 agent 的信箱)
event.{type}         能力事件总线(fs/* tools/* kb/* biz/*)跨节点
trigger.{scheduler}  定时/延时唤醒(替代部分 cron/webhook)
```

### 3.3 A2A 信封与模式

```ts
interface A2AMsg {
  msgId: string; from: string; to: string;     // agentId / "team"/"broadcast"
  teamId?: string; sessionRef?: string;        // 指向 SessionEvent 日志
  type: "task"|"result"|"question"|"approval"|"event";
  correlationId?: string; payload: unknown; ttl?: number;
}
```
- **request/response**：requester 设 `correlationId`，在自己的 `agent.{id}` 队列等匹配回复（RocketMQ 也内置 `request()` API）。
- **pub/sub**：发 `team.{teamId}` 广播，成员各自消费。
- **去重**：消费端按 `msgId` 幂等（A2A 至少一次，必须去重；dsh 的 session 事件带 eventId 天然幂等）。
- **事务**：配额扣减与发信走事务消息，保证一致。

### 3.4 与 dsh 衔接

- 背靠 `ctx.agentTeams` 的 **mailbox + task board**（前文分布式 backing 改用 RocketMQ 主题）。
- 消息到达 → 唤醒 **suspend 的 turn**（`agent.inject()`，呼应异步协同篇）→ 续跑。
- `agent/*` 事件、能力事件（`fs/*`/`tools/*`）经 `event.{type}` 跨节点广播。

### 3.5 能力事件总线 & Trigger Bus 也走 RocketMQ

- 前文 Trigger Bus（cron/webhook）的延时唤醒 → RocketMQ 延时消息；外部 webhook → 生产者。
- 复制式 Session 日志的跨节点事件 → `event.*` 主题。

---

## 4. 三者咬合（收敛 etcd + NATS + ConfigDistributor）

```
原体系:  etcd(注册) + Redis(心跳) + ConfigDistributor(patch) + NATS(总线)
新体系:  Nacos(Naming+Config)  +  RocketMQ(A2A+事件+Trigger)
保留:    Redis(热缓存) + 复制式 SessionLog + OPA + Vault
```

```
┌────────── Nacos: Naming(节点/seam/制品) + Config(manifest/patch/灰度/OPA) ──────────┐
│  节点注册+健康 ｜ 制品元数据 ｜ 配置推送(热加载) ｜ namespace 联邦                      │
└───────────────────────────────────┬──────────────────────────────────────────────────┘
                                     │ 发现 + 配置
   ┌──────────────── 运行时(dsh 节点) ────────────────┐
   │ Gateway ─ Scheduler ─ Agent(WorkerPool) ─ SeamProxy│
   │   │                    │                           │
   │   └── Provisioner: 部署即自动安装 deps(组件/skill/MCP)│
   │        │                                         │
   │   RocketMQ: A2A(agent.*/team.*) + event.* + trigger.*│
   │        │ 消息→唤醒 suspend turn(agent.inject)        │
   │   Replicated SessionEvent Log(真相源, Redis 热+冷)   │
   └─────────────────────────────────────────────────────┘
```

---

## 5. 关键决策与风险（opinionated）

1. **Nacos 收敛注册+配置**：别再自研 etcd+Redis+ConfigDistributor 三件套；一处管理发现与配置，灰度/联邦原生支持。
2. **自动安装声明式 reconcile**：部署=把节点拉到期望态；重装幂等、故障自愈、升级降版即回滚。
3. **MCP 经 dsh python/ bridge 注册进 `ctx.tools`**：复用原生 MCP 支持，不另造工具协议。
4. **RocketMQ 统一异步骨干**：事务消息（配额+发信原子）与延时消息（异步唤醒）是杀手级特性，NATS 难平替。
5. **A2A 必做幂等去重**：至少一次投递，消费端按 `msgId`/`correlationId` 去重，否则重复执行。
6. **安装前签名校验 + OPA scope**：自动安装放大了投毒面，信任链不能省。
7. **realm ↔ Nacos namespace 隔离**：租户边界落到中间件原生隔离，而非应用层硬隔。
8. **保留 Redis 热缓存与复制日志**：Nacos/RocketMQ 不替代会话真相源与低延迟热态。

---

## 6. 代码骨架（示意）

```ts
// ---- Nacos: 节点注册 + 配置监听热加载 ----
const nacos = new Nacos({ namespace: realm });
await nacos.naming.register("dsh-node", { ip, port, ephemeral: true,
  metadata: { nodeRole: "agent", seams: ["doris","nebula"] } });
nacos.config.addListener("agent.analyst.yaml", realm, cfg => applyPatch(cfg)); // 热加载

// ---- Provisioner: 部署即自动安装依赖 ----
async function deploy(agent: AgentManifest, realm: string) {
  for (const d of resolveDeps(agent)) {            // 组件/skill/mcp
    assertSignature(d);  opa.check(agent.policy, d.scope);
    await install(d);                             // mount Cordis bundle / 启动 MCP
    await applyNacosConfig(d, realm);             // 拉配置热加载
  }
  await nacos.naming.register(`agent.${agent.name}`, {...}); // 注册实例
}

// ---- RocketMQ A2A ----
const mq = new RocketMQ();
async function sendA2A(m: A2AMsg) {                 // 事务消息: 扣配额+发信原子
  await mq.transaction(m, () => usageLedger.deduct(m.from));
}
mq.subscribe(`agent.${myId}`, msg => {
  if (seen(msg.msgId)) return;                      // 幂等去重
  if (msg.type === "approval") ctx.agentLoop.inject(myId, msg.payload); // 唤醒 suspend turn
});
```

> 同样只依赖 dsh 稳定语义（`ctx.tools`/`ctx.agentTeams`/`agent.inject`/`credentials`/MCP bridge），Nacos/RocketMQ 是外部中间件，对 Cordis 内核零侵入。

---

### 八篇文档关系

| 文档 | 解决 |
|------|------|
| 总体架构 | 分层 + Seam 网络化 + 组件化/技能/智能体分发 |
| 数据层 | PG/Doris/Nebula/Redis/分布式DB |
| 调度面 | 高并发协同调度智能体集群 |
| 异步+多端 | suspend/resume、future、trigger bus、终端事件汇 |
| 注册+流程化 | 分布式注册 + 大数据 DAG 流程引擎 |
| 连接器+RBAC+分发 | 外部连接器 + 角色权限 + 智能体分发体系 |
| 技术架构总纲 | 统一分层 / 模块分解 / 端到端流程 / 实现蓝图 |
| **`deepseek_harness_nacos_rocketmq_a2a.md`（本篇）** | **Nacos 注册配置中心 + 自动安装 + RocketMQ A2A** |

八篇构成完整技术架构体系，且全程零侵入 dsh 内核。

# DeepSeek Harness 分布式平台 · 外部连接器 + 用户角色权限 + 智能体分发体系 Addendum

> **【已整合 · 以 V2 为准】** 本文内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§10，请以 V2 为权威版本。

> 接续前 five 篇（总体架构 / 数据层 / 调度面 / 异步协同+多端 / 分布式注册+大数据流程化）。
> 本篇补三块：**① 外部多种连接器（API 等）** **② 用户角色权限（RBAC/ABAC）** **③ 智能体分发体系（完整系统）**。
> 三者是「平台对外联通 + 对内治理 + 制品流通」的收口，全部仍走 dsh 原生扩展点：`ctx.tools`、`credentials/CredentialKey`、`cordis.patch.yml`、MCP（python/ 已支持）、Registry（前文）。

---

## 0. 范围与总览

| 维度 | 前文 | 本篇新增 |
|------|------|----------|
| 对外 | 数据 seam（PG/Doris/Nebula/Redis）、Seam Proxy | **外部连接器**：REST/GraphQL/MCP/SaaS/消息/文件等统一接入，受 RBAC 网关管控 |
| 治理 | OPA 挂在 seam、`isolate` realm | **用户角色权限**：用户↔realm+role，ABAC 多维策略，单一策略点 |
| 流通 | 智能体作为制品（manifest） | **智能体分发体系**：创作→发布→发现→部署→联邦→灰度→回滚的完整系统 |

> 一句话：**连接器让 agent 连通外部世界（凭证进保险库、绝进 prompt）；角色权限用 realm 做租户边界、OPA 做单一策略点；分发体系把 agent 当不可变版本化制品，声明式部署、签名联邦、灰度回滚。**

---

## 1. 外部多种连接器（External Connectors）

### 1.1 连接器 = 对外能力的 typed 组件

连接器是「agent ↔ 外部系统」的标准化桥，复刻 dsh 的 `tool-*` 机制 + MCP 支持：

| 类别 | 示例 | 暴露为 |
|------|------|--------|
| **API/HTTP** | REST、GraphQL、Webhook | `ctx.tools` 动作（tool schema 进 prompt 装配） |
| **MCP** | 任意 MCP server（python/ 已支持） | MCP tool/resource 桥接 |
| **SaaS** | Salesforce/Slack/飞书/钉钉/Notion | 预置连接器模板 |
| **消息/流** | Kafka/RabbitMQ/Redis Stream | 生产/消费动作 |
| **数据** | 外部 DB/数仓/对象存储 | 复用数据 seam 的远程 Provider |
| **Legacy** | SOAP/ FTP/ 内部 RPC | 适配层 |
| **设备/IoT** | MQTT/工控 | 边缘连接器节点 |

### 1.2 连接器即组件（manifest）

```yaml
apiVersion: dsh.connector/v1
kind: Connector
metadata: { name: slack, version: 2.1.0, signature: ed25519:<sig> }
spec:
  protocol: mcp                 # http|graphql|mcp|kafka|...
  endpoint: https://slack.com/api
  auth: { type: oauth2, vaultRef: creds/slack, scopes: [chat:write] }
  toolSurface:                  # 哪些动作成为 ctx.tools
    - send_message
    - read_channel
  limits: { ratePerSec: 20, circuitBreaker: true }
  egress: { allow: [slack.com], piiMask: true }
```

- **注册进分布式注册表**（前文）→ 全局可发现、可复用、可版本化、可模板化。
- **凭证进保险库（vault），绝进 prompt**：运行时由 `credentials/CredentialKey` 注入，agent 只见「动作」不见「密钥」。

### 1.3 连接器网关（Connectivity Plane）

```
Agent(节点) ──ctx.tools:send_message──▶ Connector Gateway(边/网关节点)
        │                                        │ 路由 + 鉴权 + 限速 + 熔断
        │                                        ▼
        └── 经 Seam Proxy 到连接器 Provider ──▶ 外部系统(Slack/API/MCP)
                 所有外部调用记 session 事件 → 审计 + PII 脱敏
```

- 连接器 Provider 可像任何 seam 一样落在网关节点，经 Seam Proxy 路由。
- **治理闸**：每连接器 `ratePerSec` + 熔断器；出向 `egress` 白名单；发送前 PII 脱敏；调用即审计事件。

---

## 2. 用户角色权限（RBAC / ABAC）

### 2.1 身份与边界

- 用户经 `CredentialKey` 认证（SSO/OIDC 映射），归属 **realm（租户）**——realm 是首要隔离边界。
- 角色（RBAC）给粗粒度权限集；属性（ABAC）补细粒度：敏感度、时间、数据分级、部署目标。

### 2.2 角色样例

| 角色 | 权限集 |
|------|--------|
| PlatformAdmin | 全局节点/注册表/策略 |
| TenantAdmin | 本 realm 内用户、部署、连接器 |
| AgentDeveloper | 创作/发布组件/技能/智能体 |
| AgentOperator | 部署/启停/监控（不发布） |
| ConnectorOwner | 注册/轮换连接器凭证 |
| EndUser | 消费智能体、发起任务、HITL 审批 |
| Auditor | 只读审计/追踪 |

### 2.3 单一策略点（OPA）

所有敏感动作统一过 OPA（Rego），评估在 dsh 原生扩展点：

| 动作 | 拦截点 |
|------|--------|
| 调用工具 / seam | `tools/pre-execute`（可拒绝） |
| agent 可见内容 | `agent/pre-step` |
| 部署/发布制品 | 注册表写入前 |
| 调外部连接器 | 连接器网关 egress + scope |
| HITL 审批 | `agent/turn-stopping` |

- **策略维度**：`(realm, role, resource, action, sensitivity, time)` → allow/deny。
- **最小权限给 agent**：agent 只获其在 manifest 声明的 scope，运行时由 OPA 按其 realm+role 收窄。

---

## 3. 智能体分发体系（完整系统）

把「智能体分发」从「制品 + Registry」升级为端到端系统：

```
创作(Author) ─▶ 发布(Publish, 签名+依赖图) ─▶ 注册表(Registry)
                                                    │ 发现/订阅
部署(Deploy) ─ Scheduler 放置 ─ Agent 节点(bundle+patch) ◀──┘
   │ 联邦: 中心 Registry ─pull/sync─▶ 边缘 Registry(签名信任)
   │ 灰度: 按 realm canary, OPA 路由版本
   │ 生命周期: 版本/弃用/回滚(重指版本)
   └─ 运行时: 多实例跨节点, agentTeams 协同, RBAC 管控
```

### 3.1 各环节

| 环节 | 内容 |
|------|------|
| **Authoring** | Agent manifest = preset + 引用组件/技能/连接器 + policy |
| **Publishing** | 注册表落库：版本、ed25519 签名、**依赖图**（组件/技能/连接器） |
| **Discovery** | 按能力/标签/realm 查询；市场浏览 |
| **Deployment** | 声明式：manifest → Scheduler 放置 → profile/bundle 同步 → `cordis.patch.yml` 分发 |
| **Federation** | 跨集群订阅/pull；信任靠签名而非仅网络 |
| **Grayscale** | 按 realm canary；OPA 按策略路由版本 |
| **Lifecycle** | 版本化、弃用、回滚（重指版本号） |
| **Runtime** | 多实例跨节点均衡；agentTeams 协同；全受 RBAC |

### 3.2 部署前置校验

- 目标 realm 必须存在其**依赖图**全部制品（组件/技能/连接器），否则拒绝部署。
- agent 的 scope 必须 ≤ 发布者角色允许的权限（OPA 校验）。
- 高敏感外部动作（连接器写操作）默认要求 HITL 审批。

---

## 4. 三者如何咬合（一张网）

```
用户(SSO/CredentialKey) ──RBAC──▶ realm+role
        │ 授权后
        ▼
智能体分发体系: 发布(注册表) → 部署(Scheduler) → 运行时(Agent 节点)
        │                         │
        │               ┌─────────┴──────────┐
        │               ▼                    ▼
        │        连接器网关(外部 API/MCP)   数据 seam(PG/Doris/Nebula)
        │               │ 每调用过 OPA + 限速 + 审计
        ▼
所有动作 → session/event(审计) → 多端可见 → Auditor 追溯
```

| 本篇能力 | 复用前文 |
|----------|----------|
| 连接器注册/发现 | 分布式注册表 |
| 连接器路由 | Seam Proxy |
| RBAC 策略点 | OPA（seam/`tools/pre-execute`/`agent/pre-step`） |
| 智能体发布 | 制品 Registry + 签名 |
| 智能体部署 | Scheduler 放置 + patch 分发 |
| 联邦/灰度 | 注册表联邦 + realm 灰度 |
| 外部调用审计 | SessionEvent 日志 |

---

## 5. 关键决策与风险（opinionated）

1. **凭证永远进 vault，绝不进 prompt**：agent 只见动作不见密钥；泄露面从「prompt 泄露」降为「网关出向管控」。
2. **realm 是租户边界，OPA 是单一策略点**：别把权限逻辑散落各处；统一在 `tools/pre-execute`/`agent/pre-step`/注册表写入/连接器 egress 评估。
3. **agent 最小权限**：运行时按其 realm+role 收窄 scope，哪怕 manifest 声明更宽。
4. **连接器必带治理闸**：限速 + 熔断 + egress 白名单 + PII 脱敏 + 调用审计，否则一个 agent 能把凭据刷爆外部 API 或泄露数据。
5. **分发体系用不可变版本化制品 + 声明式部署**：回滚=重指版本，不现场改。
6. **联邦信任靠签名不是网络**：跨集群 pull 必须用发布者签名验证，防止投毒。
7. **高敏感外部动作默认 HITL**：写类连接器操作需 `agent/turn-stopping` 审批，避免自主 agent 乱发消息。

---

## 6. 代码骨架（Cordis / TS 风格，示意）

```ts
// ---- 连接器: 注册工具面 + 经网关出向(凭证走 vault) ----
class ConnectorPlugin {
  constructor(cfg: ConnectorManifest, vault: Vault) {}
  register(ctx: Context) {
    for (const action of cfg.spec.toolSurface)
      ctx.tools.register(action, async (args) => {
        const cred = await vault.get(cfg.spec.auth.vaultRef);   // 密钥不进 prompt
        return gateway.call(cfg, action, args, cred);           // 限速/熔断/脱敏在网关
      });
  }
}

// ---- RBAC: 单一策略点(在 tools/pre-execute 评估) ----
ctx.on("tools/pre-execute", async (e, next) => {
  const ok = opa.allow({ realm: e.user.realm, role: e.user.role,
                         resource: e.tool, action: "invoke", sensitivity: e.sensitivity });
  if (!ok) return e.reject("denied by policy");
  await next();
});

// ---- 智能体分发: 发布(依赖图+签名) → 部署(Scheduler) ----
class AgentDistribution {
  async publish(agent: AgentManifest, signer: Signer) {
    agent.deps = resolveDeps(agent);            // 组件/技能/连接器
    reg.put(`/agents/${agent.name}`, sign(agent, signer));
  }
  async deploy(name: string, realm: string) {
    const a = reg.get(name);
    assertDepsPresent(a.deps, realm);          // 目标 realm 依赖齐全
    scheduler.place(a, realm);                 // manifest→节点, patch 分发
  }
}
```

> 同样只依赖 dsh 稳定语义（`ctx.tools`、`credentials`、`cordis.patch.yml`、MCP、Registry），对 Cordis 内核零侵入。

---

### 六篇文档关系

| 文档 | 解决 |
|------|------|
| 总体架构 | 分层 + Seam 网络化 + 组件化/技能/智能体分发 |
| 数据层 | PG/Doris/Nebula/Redis/分布式DB 作 Seam Provider |
| 调度面 | 高并发协同调度智能体集群 |
| 异步+多端 | suspend/resume、future、trigger bus、终端事件汇 |
| 注册+流程化 | 分布式注册 + 大数据 DAG 流程引擎 |
| **`deepseek_harness_connectors_rbac_distribution.md`（本篇）** | **外部连接器 + 用户角色权限 + 智能体分发体系** |

六篇构成「在开源 dsh 上做分布式智能体平台」的完整蓝图，且全程走 dsh 原生扩展点、零侵入内核。

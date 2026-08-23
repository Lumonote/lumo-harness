# 基于 DeepSeek Harness 的网关技术选型（Addendum 13）

> ⚠️ **已归档 · 演进快照，非当前口径**
>
> 本文为逐轮讨论的历史快照，其内容已被权威整合版 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md) **§12（原含 APISIX/Envoy，已修订为全栈自研）** 取代。
>
> 文中出现的 `etcd / NATS / ConfigDistributor / APISIX / Envoy` 等口径**已被后续决策推翻**；现行决策为 **Nacos / RocketMQ / 全栈 Go 自研网关**。
>
> **请勿据本文实施；一切以 V2 为准。**

> **【已过时 · 以 V2 为准】** 本文已被 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）取代。文中「外层 APISIX + 东西向 Envoy」已被 Addendum 15 与 V2 推翻为 **全栈 Go 自研、零外部网关中间件**。

> 配套文档体系第 13 篇。前序 11 篇定义了「网关」的语义边界（Terminal/Connector/LLM 是南北向的门，Seam Proxy 是东西向的桥），12 篇给了全栈选型却没把**"网关本身用什么技术实现"**写清——本篇补齐这一缺口。
> 核心结论先放：**网关必须分两层——外层用工业级边缘网关（APISIX）做 TLS/全局限流/路由；内层业务语义网关（LLM/连接器/终端）必须自研，因为要深度 hook dsh 语义（计量/OPA/Vault/trace）；Seam Proxy 走东西向 Envoy sidecar mesh + 自研路由。**

---

## 0. 为什么单独写这篇

第 12 篇选型总览在"边界"一行只写了 `Terminal Gateway / Connector Gateway / LLM 网关`，没回答"这些网关用什么造"。而网关是反复出现的核心组件（批处理、计量单截面、连接器治理、多端接入都依赖它），技术选型若不钉死，落地时极易出现"拿 Kong/APISIX 硬塞业务钩子"的灾难。

---

## 1. 网关分层模型

```
                    外部 (终端 / 外部系统 / 推理集群)
                              │
        ┌───────────── 外层：边缘网关 (APISIX) ─────────────┐
        │  TLS终止 · 全局速率限制 · WAF · 路由 · 灰度入口      │
        └─────────────┬──────────────┬──────────────┬────────┘
                      │              │              │
         ┌────────────▼───┐ ┌────────▼────────┐ ┌───▼─────────────┐
         │ 终端网关(自研)  │ │ 连接器网关(自研) │ │ LLM 网关(自研)   │  ← 内层业务语义网关
         │ WS接入·replay  │ │ Vault·OPA·脱敏  │ │ 批处理·计量·额度 │
         │ presence·协商  │ │ 限速·熔断·审计  │ │ 模型路由         │
         └────────────────┘ └─────────────────┘ └─────────────────┘
                      │              │              │
                      ▼              ▼              ▼
                  dsh 控制面 / 数据面 / 各 Seam Provider
                      │
        ┌──── 东西向：Seam Proxy (Envoy sidecar + 自研路由) ────┐
        │  把本地 seam 调用透明转远端 Provider，mTLS+熔断+重试   │
        └──────────────────────────────────────────────────────┘
```

**三条判据决定"自研还是外购"**：
- 只做 TLS/限流/路由/WAF → 用工业级网关（APISIX）。
- 要 hook dsh 内部语义（计量单截面、OPA 评估、Vault 取凭证、trace context 注入）→ **必须自研业务语义网关**。
- 东西向进程间调用转发 → sidecar mesh（Envoy），业务逻辑在 dsh plugin 内。

---

## 2. 通用 API 网关候选对比

| 候选 | 适合 | 不适合 / 代价 |
|------|------|----------------|
| **APISIX** | 云原生、高性能、插件丰富（限流/WAF/灰度）、Lua/Go 易扩展、社区活跃 | 深度业务钩子仍需自研插件 |
| **Kong** | 成熟、插件生态大 | 企业版功能收费、较重、与 dsh(TS) 割裂 |
| **Envoy** | 东西向 mesh 王者、xDS 动态、mTLS、重试/熔断 | 配置复杂；作南北网关偏重 |
| **Spring Cloud Gateway** | Java 生态 | 绑定 JVM，与 dsh(Node/TS) 技术栈割裂 |
| **Nginx + Lua** | 极轻、稳定 | 可编程性弱、动态配置难 |
| **纯自研 Go** | 完全可控、深度集成 | 要自己实现限流/可观测/灰度，成本高 |

> **结论**：外层统一用 **APISIX**；业务语义网关与 Seam Proxy 的"业务逻辑"自研，但可把 APISIX/Envoy 当底层传输与基础治理壳。

---

## 3. 各网关技术选型（ADR-lite）

### 3.1 终端网关 Terminal Gateway
- **选**：**自研 WebSocket 服务（Node/TS，复用 dsh 生态）**，外层 APISIX 做 TLS/路由。
- **不选**：Kong/APISIX 直接兜（它们不擅长长连接 session 事件订阅/replay/presence）。
- **理由**：终端订阅 `session/event`（复制日志）、连接即 replay + live push、presence 多人可见、能力协商（按 `ConversationNodeDefinition` 选渲染）——这些是 dsh 原生语义，必须自研粘在 dsh 上。
- **hook 的 dsh 语义**：SessionEvent 日志、presence、能力协商、CredentialKey 身份。
- **代价**：需自建 WS 连接管理 + 重连 replay；APISIX 仅做最外层 TLS/LB。

### 3.2 连接器网关 Connector Gateway
- **选**：**自研 Go/Node 服务**，内嵌 Vault 客户端 + OPA egress 评估 + 限速/熔断 + PII 脱敏 + 审计；外层 APISIX 做 TLS/全局限流。
- **不选**：纯 APISIX/Kong（做不了"动态取 Vault 凭证 + OPA 出向策略 + PII 脱敏"）。
- **理由**：agent 调 `ctx.tools` → 网关路由+鉴权+限速+熔断+脱敏 → 外部系统；凭证永不进 prompt，出向受 OPA 管控（addendum 6）。
- **hook 的 dsh 语义**：`ctx.tools` 出口、OPA 策略点、Vault、session 事件（审计）。
- **代价**：每接一种外部协议要写适配器；但协议适配与治理分离，治理逻辑集中。

### 3.3 LLM 网关（含批处理）
- **选**：**自研 Go 服务**，内嵌 LLM 批处理网关（汇聚并发为大 batch）+ 计量单截面 + 配额/限流 + 模型路由；外层 APISIX 做 TLS/全局限流。
- **不选**：通用网关（Kong/APISIX 无法做 batch 汇聚与 token 计量单截面）。
- **理由**：① batch 汇聚是吞吐命脉（硬规矩 3）；② 所有 token 只在 `ctx.llm` 这一道截面计量（硬规矩 9）；③ 配额/限流前置拦截。
- **hook 的 dsh 语义**：`ctx.llm` Provider 包裹、MeteringProvider、QuotaManager、trace context 注入。
- **代价**：批处理窗口调优（首 token 延迟 vs 吞吐）；与 dsh 推理演进需适配层隔离。

### 3.4 Seam Proxy（东西向，严格说非网关）
- **选**：**Envoy sidecar 做东西向 mesh 治理（mTLS/重试/熔断/可观测）+ 自研 seam 路由插件**（在 dsh plugin 内把 seam Provider 指向远端）。
- **不选**：把 Seam Proxy 当独立南北网关节点部署（过度）。
- **理由**：dsh 文档明言——把 filesystem/subprocess 等 seam 的 Provider 指向远端，Bash/PTY/LSP 一并迁移且无需分叉（addendum 1）。Envoy 负责东西向网络治理，业务路由逻辑在 plugin 内。
- **hook 的 dsh 语义**：Seam 三件套（接口+Provider+Consumer）、DistributedSeamProxy。
- **代价**：sidecar 运维；mesh 配置需与 Nacos 服务发现对齐。

---

## 4. 网关通用能力如何复用（避免重复造轮子）

| 能力 | 落在哪 | 说明 |
|------|--------|------|
| TLS 终止 | 外层 APISIX | 所有网关统一，不各自搞证书 |
| 全局速率限制 | APISIX（粗）+ Redis（细） | 全局维度 APISIX，业务维度自研网关读 Redis 令牌桶 |
| WAF / 防注入 | APISIX | 南北向统一防 |
| 可观测 | OTel（所有网关埋点） | trace/metric 汇入 Prometheus+Loki+Grafana |
| 鉴权（身份） | 外层验 JWT + 内层 OPA | 外层过身份，内层按 realm/role 细粒度 |
| 灰度/路由 | APISIX（按 header/权重） | 业务网关按 Nacos namespace 路由 |

> 铁律：**通用治理下沉到 APISIX/Envoy，业务语义留在自研网关**。不让 Kong/APISIX 硬塞计量/OPA/Vault 钩子。

---

## 5. 与 dsh 集成点速查

| 网关 | 集成的 dsh 语义 | 复用前序文档 |
|------|------------------|--------------|
| 终端网关 | SessionEvent 日志、presence、能力协商、CredentialKey | addendum 4（多端）、11（术语） |
| 连接器网关 | `ctx.tools`、OPA、Vault、session 审计事件 | addendum 6（RBAC/连接器） |
| LLM 网关 | `ctx.llm`、MeteringProvider、QuotaManager | addendum 3（批处理）、9（计量） |
| Seam Proxy | Seam 三件套、DistributedSeamProxy | addendum 1（总体）、11（术语） |

---

## 6. 部署拓扑（网关在边界的位置）

```
[终端/外部/推理] 
      │
  APISIX (TLS/LB/全局限流/WAF/灰度)  ── 唯一南北入口
      │
  ┌───┼───────────────┬──────────────┐
  ▼   ▼               ▼              ▼
终端网关  连接器网关    LLM 网关      (Seam Proxy = 东西向 Envoy sidecar，不在边界)
 (WS)    (Vault/OPA)   (batch/计量)
  │       │            │
  └───┬───┴────────────┴────────────┘
      ▼
  dsh 控制面/数据面 + RocketMQ + 存储(PG/Doris/Nebula/Redis)
```

- 所有南北流量**只经 APISIX 一个入口**，杜绝绕过。
- 三个自研业务网关是 control-plane 服务，可水平扩展、独立发布。
- Seam Proxy 不占边界，随 dsh 节点以 sidecar 形态部署。

---

## 7. 风险与未决

| 项 | 状态 | 缓解 |
|----|------|------|
| 自研网关重复实现限流/可观测 | 已知 | 通用能力下沉 APISIX/OTel，自研只留业务钩子 |
| APISIX 无法做 batch/计量/OPA 钩子 | 已知 | 这些只在自研内层网关做，APISIX 仅做壳 |
| Envoy mesh 配置复杂 | 已知 | 用 Nacos 服务发现对齐，避免手工 xDS |
| 终端网关 WS 重连/replay 一致性 | 待决 | 以复制日志为真相源，replay 幂等 |
| 网关成为单点 | 已知 | APISIX 集群 + 自研网关多副本 + 无状态 |

---

## 8. 体系位置（十三篇闭环）

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
| 11 技术术语精确定义 | 网关/Proxy/三平面/五制品 边界字典 |
| 12 技术架构选型 | 全栈逐领域选型理由与替代对比 |
| **13 网关技术选型（新）** | **网关分层 + APISIX/自研/Envoy 对比 + Terminal/Connector/LLM/Seam Proxy 各自选型** |

至此"网关"从**语义（11）→ 位置（12 边界行）→ 技术（本篇）**三层全部钉死：外层 APISIX 做门，内层 LLM/连接器/终端网关自研 hook dsh 语义，Seam Proxy 走 Envoy 东西向 mesh——既用了工业级组件，又不让通用网关硬塞业务钩子。

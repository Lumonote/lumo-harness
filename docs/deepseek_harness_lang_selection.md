# 基于 DeepSeek Harness 的自研服务语言选型：Rust vs Go（Addendum 14）

> ⚠️ **已归档 · 演进快照，非当前口径**
>
> 本文为逐轮讨论的历史快照，其内容已被权威整合版 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md) **§12.3** 取代。
>
> 文中出现的 `etcd / NATS / ConfigDistributor / APISIX / Envoy` 等口径**已被后续决策推翻**；现行决策为 **Nacos / RocketMQ / 全栈 Go 自研网关**。
>
> **请勿据本文实施；一切以 V2 为准。**

> **【已过时 · 以 V2 为准】** 本文已被 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）取代。本文末仍主张「外层 APISIX + Envoy 东西向」，已被 Addendum 15 推翻为 **全自研 Go**；「统一 Go」结论本身保留并已并入 V2 §12.3。

> 配套文档体系第 14 篇。文档 13 定了网关"分层 + APISIX/自研/Envoy"，但自研部分用什么语言没钉死（当时终端网关含糊写了 Node/TS）。本篇给出结论：**自研网关与控制面服务统一用 Go，参考 sub2api 的 Go+Gin+Ent+PostgreSQL+Redis 组合；Rust 仅用于极端计算热点，不作为服务主语言。** 并据此微调文档 13 的终端网关选型。

---

## 0. 结论先放

> **自研服务（LLM 网关 / 连接器网关 / 终端网关 / 控制面）统一用 Go。** 你提到的 **sub2api 正是同类参考**：它是一个用 **Go + Gin + Ent + PostgreSQL + Redis** 构建的开源 AI API 网关，把上游 AI 订阅额度聚合并拆成多 Key 分发给下游、做 Token 级计费、限流、负载均衡、流式——和我们的 LLM 网关（汇聚 DeepSeek harness + 多租户配额分发 + 计量 + 限流 + 模型路由 + 流式）能力 1:1 对应，已被生产验证。**这等于同行用 Go 把我们要做的事跑通了，直接复用其技术栈是最低风险的决策。**

---

## 1. sub2api 事实核实（强参照）

| 项 | sub2api 实测 | 与我们 LLM 网关的对应 |
|----|--------------|------------------------|
| 后端语言 | **Go 1.21+**（go.mod 1.26.6） | ← 同类网关用 Go 验证可行 |
| 框架 | **Gin**（HTTP） + **Ent**（ORM） | 我们 LLM/连接器/计量网关可同栈 |
| 数据库 | **PostgreSQL 15+** | 对应我们的 PG 明细/元数据主库 |
| 缓存/队列 | **Redis 7+** | 对应我们的限流/额度余量/热态 |
| 前端 | Vue 3.4 + Vite + Tailwind（内嵌二进制 `-tags embed`） | 我们多端前端可参考内嵌/独立部署 |
| 密钥管理 | 多上游账户 + 多 API Key 分发 | ↔ 我们 Vault 凭证 + 多租户 realm |
| Token 计费 | 精准 Token 级用量追踪与成本 | ↔ 我们计量单截面（addendum 9） |
| 限流/并发 | 按用户/账户并发 + 请求/Token 速率 | ↔ 我们限流/额度（addendum 9） |
| 负载均衡 | 粘性会话 + 复合组路由 | ↔ 我们模型路由/放置（addendum 3） |
| protection | 计费熔断、CORS、CSP、URL 校验 | ↔ 我们 OPA + Seam 护栏 |

> **一句话**：sub2api 没有 Rust，全部 Go；它做的"汇聚上游 + 配额分发 + 计量 + 限流 + 负载均衡 + 流式"正是我们的 LLM 网关内核。这是 Go 适用性的直接证据。

---

## 2. Rust vs Go 多维度对比

| 维度 | Go | Rust |
|------|----|------|
| 并发模型 | goroutine（百万级轻量协程） | tokio async（也强，但心智负担高） |
| 峰值性能 | 高，GC 停顿可控（<1ms 级） | 极致，零成本抽象、无 GC |
| 开发速度 | **快**（语法简单、编译秒级） | 慢（所有权/生命周期、编译慢） |
| 云原生/网关生态 | **极丰富**：gRPC、Redis、RocketMQ、OPA(Rego SDK)、Vault client、pgx/Ent、Doris driver | 较好但偏小：tonic、sqlx、tokio 全家桶 |
| 人才与成本 | **多、易招、便宜** | 少、贵、难招 |
| 内存安全 | GC 自动 | 编译期借用检查保证 |
| 适合本场景 | ✅ 高并发 I/O 网关 + 控制面 | ⚠️ 过度，除非纯计算热点 |

---

## 3. 为什么不是 Rust（场景瓶颈分析）

- **瓶颈不在网关 CPU**：我们的吞吐卡点在 **LLM 推理集群 + 网络 I/O**（批处理网关汇聚的是"等待推理返回的并发请求"）。Go 的 goroutine 在"等 I/O"场景是教科书级匹配；Rust 的无 GC/零成本优势在"等 I/O"时收益有限，却要付出开发速度与人才成本。
- **要快速 hook 一堆外部系统**：OPA(Rego) / Vault / Redis 令牌桶 / RocketMQ / PG(Ent) / Doris / Nacos。Go 这些客户端成熟且官方/社区维护活跃；Rust 生态能写但更折腾、踩坑多。
- **与 dsh 解耦，无需同语言**：dsh 是 Node/TS，但网关通过 **gRPC/HTTP/消息总线** 与它交互，不共享进程。Go 编译为独立二进制（可内嵌前端，如 sub2api 的 `-tags embed`），部署简单。
- **开发速度 = 竞争力**：网关要快速迭代计量/限流/OPA/Vault 钩子，Go 的上手快、编译快、排错快是实打实优势。

> **Rust 的唯一合理位置**：若未来某个组件是**极致延迟/吞吐的纯计算热点**（自研 tokenizer、超大 batch 调度器内核、加解密密集、向量近邻检索），可局部用 Rust 写成 sidecar 或 FFI 模块，但**服务主体仍是 Go**。

---

## 4. 推荐技术栈组合（直接复用 sub2api）

```
自研服务统一栈（参考 sub2api）:
  语言:    Go 1.22+
  框架:    Gin (HTTP/WS) / gRPC (内部服务间)
  ORM:     Ent (PG)         ← 复用 sub2api 的 Ent+PG 组合
  缓存:    go-redis (Redis Cluster)  ← 限流令牌桶/额度余量/热态
  消息:    RocketMQ Go SDK  ← A2A + usage.event.*（addendum 8/9）
  策略:    OPA (Rego SDK 嵌入或 sidecar)
  凭证:    Vault Go client
  可观测:  OTel Go SDK → Prometheus + Loki
  部署:    Docker 镜像 → Kubernetes + Helm（sub2api 的 Compose 栈容器化对齐）
```

- **LLM 网关**、**连接器网关**、**计量服务**、**控制面调度/注册适配**、**终端网关（WS）** 全部此栈，单一语言降低维护成本。

---

## 5. 四类网关在 Go 栈下的实现形态

| 网关 | Go 实现要点 |
|------|-------------|
| **LLM 网关** | Gin 收请求 + 批处理汇聚 + `ctx.llm` 语义钩子（计量单截面/配额/模型路由）；Ent 读写 PG ledger；go-redis 令牌桶 |
| **连接器网关** | Gin + Vault client 取凭证 + OPA Rego 评估 egress + PII 脱敏中间件 + 审计写 PG |
| **终端网关** | Gin/gorilla-websocket 收 WS + 订阅复制日志（PG/Doris 或 RocketMQ）+ presence + 能力协商；**用 Go 而非 Node**（见 §6 微调） |
| **Seam Proxy** | Envoy sidecar 做东西向 mesh；Go 写 seam 路由 xDS/plugin，把 dsh 的 Provider 指向远端 |

---

## 6. 对文档 13 的微调（重要）

文档 13 写"终端网关自研 WebSocket（Node/TS，复用 dsh 生态）"。**本篇修正为：终端网关也用 Go（gorilla/websocket），通过复制日志订阅 + Nacos + RocketMQ 与 dsh 协同，不直接耦合 dsh 的 TS 内部。**

理由：
- **统一栈**：避免 Node + Go 双语言维护两套构建/运维/人才。
- **终端网关不依赖 dsh 内部**：它订阅的是**复制式 SessionEvent 日志**（存储层）+ Nacos + RocketMQ，都是语言无关的协议，Go 完全胜任。
- 若某终端需深度嵌入 dsh host（如 IDE 插件），仍可用 dsh 原生 TS 客户端，但**网关接入层统一 Go**。

> 文档 13 的"网关分层（APISIX 外层 + 自研内层 + Envoy 东西向）"与"通用治理下沉"结论**不变**，仅把自研内层语言从"LLM/连接器=Go、终端=Node"统一为"**全部 Go**"。

---

## 7. sub2api：复用 vs 自建

| 可直接复用/参考 | 需我们自建（sub2api 没有） |
|------------------|------------------------------|
| Go+Gin+Ent+PG+Redis 技术组合 | 多租户 realm 隔离（sub2api 是单租户拼车） |
| Token 级计量/计费架构思路 | OPA 单一策略点（细粒度 RBAC/ABAC） |
| 限流/并发/负载均衡模式 | Vault 凭证管理（不进 prompt） |
| 流式(SSE)/复合路由形态 | Nacos 服务发现 + 自动安装 reconcile |
| 内嵌前端/容器化部署 | RocketMQ A2A 多 agent 协同 + 异步 suspend |
|  | Seam Proxy 东西向（组件化接入 DeepSeek harness） |

> sub2api 是**单机/单租户中转网关**，我们是**多租户分布式智能体平台**。复用它的"网关技术栈与计量/限流内核思路"，在其上扩展 realm/OPA/Vault/Nacos/RocketMQ/Seam Proxy。

---

## 8. 风险

| 项 | 缓解 |
|----|------|
| Go GC 在超高频网关有微秒级停顿 | 网关非计算热点，停顿可忽略；必要时对象池复用 |
| 单语言锁定 | Go 生态覆盖全部需求，无锁死风险 |
| sub2api 直接照搬不适配多租户 | 只复用栈与思路，架构按本体系重建 |
| Rust 热点未来误用 | 明确 Rust 仅限局部 sidecar/FFI，不扩散 |

---

## 9. 体系位置（十四篇闭环）

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
| 12 技术架构选型 | 全栈逐领域选型理由 |
| 13 网关技术选型 | 网关分层 + APISIX/自研/Envoy + 四类网关选型 |
| **14 自研语言选型（新）** | **统一 Go（参考 sub2api Go+Gin+Ent+PG+Redis）；Rust 仅局部热点；微调文档13终端网关** |

至此"网关怎么造"从**分层（13）→ 语言（14）** 全部钉死：外层 APISIX，内层业务网关统一 **Go**（sub2api 已验证同构可行），Seam Proxy 走 Envoy 东西向 mesh。语言决策不再悬空。

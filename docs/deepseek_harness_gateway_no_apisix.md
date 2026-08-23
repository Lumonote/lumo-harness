# 基于 DeepSeek Harness 的网关全自研修订（Addendum 15）

> ⚠️ **已归档 · 演进快照，非当前口径**
>
> 本文为逐轮讨论的历史快照，其内容已被权威整合版 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md) **§12** 取代。
>
> 文中出现的 `etcd / NATS / ConfigDistributor / APISIX / Envoy` 等口径**已被后续决策推翻**；现行决策为 **Nacos / RocketMQ / 全栈 Go 自研网关**。
>
> **请勿据本文实施；一切以 V2 为准。**

> **【定稿记录 · 已并入 V2】** 本文是网关全自研的定稿决策，内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§12，请以 V2 为准。

> 配套文档体系第 15 篇。**修订文档 13（网关技术选型）与文档 14（语言选型）中的外部网关决策**：用户明确——**不使用 APISIX，网关全部自研**。本篇据此推翻"外层 APISIX + 东西向 Envoy"方案，改为**边缘网关 + 业务语义网关 + 东西向 Seam Proxy 全部用 Go 自研**，实现真正全栈自研、零外部网关中间件依赖。

---

## 0. 决策变更

| 项 | 文档 13/14 原方案 | **本篇修订** |
|----|-------------------|--------------|
| 外层边缘网关 | APISIX（Java） | **Go 自研边缘网关** |
| 业务语义网关 | Go 自研（LLM/连接器/终端） | Go 自研（不变） |
| 东西向 Seam Proxy | Envoy sidecar（C++） | **Go 自研轻量代理** |
| 自研语言 | Go（统一） | Go（统一，不变） |

> **新原则：网关领域不引入任何外部商用网关（APISIX/Kong/Envoy），全部 Go 自研。** 这与文档 14 的"统一 Go"决策一致，且消除了 Java/C++ 中间件的运维与语言割裂。

---

## 1. 新架构（全 Go 自研）

```
[终端/外部/推理]
      │
  ┌─── 边缘网关 (Go 自研) ───────────────────┐
  │ TLS终止 · 全局限流 · 路由 · 灰度 · 基础WAF │
  └───────┬──────────────┬──────────────┬──────┘
          ▼              ▼              ▼
   ┌────────────┐ ┌─────────────┐ ┌─────────────┐
   │ 终端网关Go │ │ 连接器网关Go│ │ LLM网关Go   │  ← 业务语义网关（自研，不变）
   │ WS·replay │ │ Vault·OPA   │ │ batch·计量  │
   └────────────┘ └─────────────┘ └─────────────┘
          │              │              │
          ▼              ▼              ▼
     dsh 控制面/数据面 + RocketMQ + 存储(PG/Doris/Nebula/Redis)
          │
   ┌── 东西向 Seam Proxy (Go 自研轻量代理) ──┐
   │ 把本地 seam 调用透明转远端 Provider      │
   │ Nacos发现 · 熔断 · 重试 · mTLS           │
   └────────────────────────────────────────┘
```

所有组件均为 Go 二进制，单一语言、单一构建、单一运维体系。

---

## 2. 自研边缘网关（替代 APISIX）实现要点

用 Go 标准库 + Gin 中间件即可实现，无需外部网关：

| APISIX 原职责 | Go 自研实现 |
|---------------|-------------|
| TLS 终止 | `crypto/tls` + `autocert`（Let's Encrypt 自动证书） |
| 反向代理 | `net/http/httputil.ReverseProxy` |
| 全局速率限制 | Redis 令牌桶中间件（与内部网关共享同一限流库） |
| 路由 | 路由表（path/host/header）→ 后端，从 **Nacos Config** 动态加载 |
| 灰度/蓝绿 | 按 header/权重路由到不同版本 service |
| 基础 WAF | 请求大小限制、路径/参数校验、CORS、限连接数 |
| 可观测 | OTel 中间件（trace/metric）→ Prometheus + Loki |
| 健康检查 | 上游探活 + Nacos 心跳摘除 |

> 这些都是 Go 网关的常见写法，成熟可控；代价是比 APISIX 多写一部分胶水，但换来零外部依赖与完全可控。

---

## 3. 东西向 Seam Proxy 改为 Go 自研（替代 Envoy）

原方案用 Envoy sidecar 做东西向 mesh。现改为 **Go 轻量透明代理**：

| Envoy 原职责 | Go 自研实现 |
|--------------|-------------|
| 服务发现 | 从 **Nacos** 拉 seam Provider 端点（与平台统一） |
| 透明转发 | gRPC/HTTP 反向代理，把 dsh 本地 seam 调用转远端 |
| 熔断/重试 | `sentinel-go` 或自研滑动窗口熔断 + 指数退避重试 |
| mTLS | `crypto/tls` 双向证书（平台内 CA 签发） |
| 可观测 | OTel 埋点 |

- 形态：可作 **sidecar（Go 二进制）** 或 **嵌入 dsh plugin**（更紧耦合 seam 路由）。
- 注意：若要极其复杂的 mesh 能力（细粒度流量切分、跨集群联邦 mTLS），Envoy 仍更成熟；但 **MVP 阶段 Go 自研轻量代理足够**，且避免引入 C++ 组件。后续如需可再评估，**不影响当前全自研架构**。

---

## 4. 全自研的收益与代价（opinionated）

| 收益 | 代价 |
|------|------|
| **全栈 Go 一致**：无 Java(APISIX)/C++(Envoy) 语言割裂，构建/运维/人才统一 | 需自写边缘网关的 TLS/路由/限流/WAF 胶水 |
| **零外部网关依赖**：不受 APISIX/Envoy 版本、License、生态绑定 | 失去 APISIX 开箱即用的插件市场 |
| **完全可控**：网关逻辑与 dsh 语义（计量/OPA/Vault/trace）深度耦合，无适配层 | 网关稳定性需自己保障（SLA/压测） |
| **与 dsh 集成最紧**：业务钩子原生嵌入，不绕道外部网关 | 边界防护（WAF/抗 DDoS）需自行加固 |
| **部署简单**：全是 Go 二进制，容器化进 K8s 一致 | 需自建证书/CA 管理（mTLS） |

> 判断：对于一个**深度集成 dsh 语义、且已决定统一 Go**的分布式智能体平台，全自研网关的收益（一致性、可控、零依赖）明显大于代价（多写胶水）。APISIX/Envoy 的价值在于"快速获得成熟网关"，但当我们本就要在网关内深 hook 业务语义时，外部网关只是壳，自研反而更直接。

---

## 5. 技术栈更新（去掉 APISIX/Envoy）

```
自研语言:   Go 1.22+（统一，无例外）
边缘网关:   Go (Gin + httputil.ReverseProxy + autocert + Redis限流)  ← 自研替代 APISIX
业务网关:   Go (LLM/连接器/终端，hook dsh 语义)                      ← 不变
Seam Proxy: Go 轻量代理 (Nacos发现 + sentinel熔断 + mTLS)            ← 自研替代 Envoy
存储/中间件: PG + Doris + Nebula + Redis + Nacos + RocketMQ + OPA + Vault + K8s  ← 不变
```

> 仅网关层变化；数据面/控制面/协同面的中间件（Nacos/RocketMQ/PG/Doris/Nebula/Redis/OPA/Vault/K8s）选型**不变**。

---

## 6. 对文档 13/14 的修订清单

| 文档 | 原表述 | 修订后 |
|------|--------|--------|
| 13 §3.1–3.4 | 外层 APISIX、Seam Proxy 用 Envoy | 外层/东西向均 Go 自研 |
| 13 §4 | 通用治理下沉 APISIX/Envoy | 通用治理下沉**自研边缘网关 + 共享限流库** |
| 13 §6 | 所有南北流量只经 APISIX | 所有南北流量只经**自研边缘网关** |
| 13 §7 | Envoy mesh 配置复杂风险 | 改为自研 Seam Proxy 的熔断/mTLS 自研风险 |
| 14 §6 | 终端网关 Go、其余 Go | 不变（本就统一 Go），本章与文档 14 语言决策一致 |
| INDEX 中间件行 | APISIX(外层)+Envoy | **全 Go 自研（边缘+业务+Seam Proxy）** |

---

## 7. 风险（新增/调整）

| 项 | 缓解 |
|----|------|
| 自研边缘网关需自写 TLS/路由/限流/WAF | 用 Go 标准库 + Gin 中间件，参考成熟 Go 网关写法 |
| 边界防护（抗 DDoS/WAF）需自行加固 | 前置云厂商 LB/基础防护 + 自研限连/限大小 |
| 东西向 mTLS/CA 管理自研 | 平台内 CA 签发 + 证书轮转自动化 |
| 失去 APISIX 插件生态 | 业务钩子本就要自研，插件市场价值有限 |
| 网关稳定性自担 | 压测 + SLA + OTel 全埋点 |

---

## 8. 体系位置（十五篇闭环）

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
| 9 Token 计量·归因·配额 | 功能级计数 + 人/部门/角色归因 + 平台溯源 + 限流/额度 |
| 10 用户流程+定向分发 | 用户自定义流程 → 审核提升通用 → audience 定向分发 |
| 11 技术术语精确定义 | 网关/Proxy/三平面/五制品 边界字典 |
| 12 技术架构选型 | 全栈逐领域选型理由 |
| 13 网关技术选型 | 网关分层（**原含 APISIX/Envoy，本篇修订为全自研**） |
| 14 自研语言选型 | 统一 Go（参考 sub2api） |
| **15 网关全自研修订（新）** | **取消 APISIX/Envoy，边缘+业务+Seam Proxy 全 Go 自研** |

至此网关技术从"分层（13）→ 语言（14）→ 全自研（15）"彻底钉死：**网关领域零外部中间件，边缘网关、LLM/连接器/终端业务网关、东西向 Seam Proxy 全部 Go 自研**，与统一 Go 决策完全一致。

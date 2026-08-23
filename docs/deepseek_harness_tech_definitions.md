# 基于 DeepSeek Harness 的技术术语精确定义与边界（Addendum 11）

> **【已整合 · 以 V2 为准】** 本文内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§14，请以 V2 为权威版本。

> 配套文档体系第 11 篇。前序 1–10 篇讲了"做什么、怎么连"，本篇补**"这些名词到底指什么、边界在哪"**——尤其澄清被泛用的「网关」，并统一全体系术语字典。
> 作用：消除歧义、对齐心智模型、作为后续代码/接口命名的权威依据。

---

## 0. 为什么需要这篇

十篇文档里「网关」至少出现了四种语境，若不定义清楚，落地时团队会对"谁该做什么"产生巨大分歧：

- 调度面（3）的 **LLM 批处理网关**
- 连接器（6）的 **连接器网关**
- 异步多端（4）的 **终端网关（Terminal Gateway）**
- 总体架构（1）的 **Seam Proxy（能力接缝代理）**

它们都叫"网关/网关式"，但**职责边界、流量方向、治理内容完全不同**。下面先钉死「网关」的统一定义，再区分四类。

---

## 1. 网关（Gateway）—— 统一定义

> **网关 = 系统边界上、对某一类流量的「统一接入点（choke point）」。**
> 它只负责四件事，不对业务语义负责：
> 1. **协议适配 / 接入**：把外部协议（HTTP/WS/MCP/SaaS API）翻译成平台内部语义；
> 2. **路由分发**：把请求送到正确的后端/服务/Provider；
> 3. **横切治理**：鉴权、限流、计量、熔断、脱敏、审计——在门上做，不污染后端；
> 4. **边界隔离**：门外是"不可信/外部"，门内是"平台能力"。

**关键判据**：如果一个组件"接管了进出平台的流量并在门上做治理"，它就是网关；如果它只是"把一次调用透明地转给另一个位置的实现"，那是 **Proxy（代理）**，不是网关（见 §2）。二者可叠加。

### 1.1 四种网关/代理的边界对比

| 名称 | 流量方向 | 接入方 → 后端 | 核心治理职责 | 性质 |
|------|----------|----------------|--------------|------|
| **终端网关** Terminal Gateway | 南北 | 终端(web/CLI/IDE/mobile/API) → 平台 | 连接管理、身份、订阅/replay、presence、能力协商 | 网关 |
| **连接器网关** Connector Gateway | 南北 | agent/平台 → 外部系统(API/SaaS/MCP/Legacy) | 凭证 vault、限速、熔断、PII 脱敏、出向审计 | 网关 |
| **LLM 网关** LLM Gateway（含批处理） | 南北 | agent → 推理集群(DeepSeek harness) | batch 汇聚、计量、限流/额度、模型路由 | 网关（对内含 proxy） |
| **Seam Proxy** | 东西 | 平台内 seam 调用 → 远端 Provider | 寻址、路由、网络透明、熔断 | **代理（非网关）** |

> 一句话区分：**Terminal/Connector/LLM 是"门"（南北向、做治理）；Seam Proxy 是"桥"（东西向、做透明转发）。** LLM 网关对外是门、对内把请求 proxy 到推理集群，所以它同时含两种属性。

---

## 2. Proxy / Seam Proxy 定义

> **Proxy（代理）= 把一次本地调用「透明地」转发到另一个位置的实现，调用方不感知真实位置。**

- **Seam Proxy**（总体架构 1）：dsh 文档明言——把 filesystem/subprocess 等 seam 的 Provider 指向远端，Bash/PTY/LSP 会一并迁移且**无需分叉**。把它泛化为 `DistributedSeamProxy`，任意 seam 的 Provider 可落远端节点。
- **与网关的本质区别**：Proxy 关心"调用转到哪、位置解耦"；Gateway 关心"流量怎么进、门上怎么管"。Seam Proxy 不做业务治理，只做寻址/路由/网络透明。

---

## 3. 三个平面（Plane）定义

| 平面 | 定义 | 包含 |
|------|------|------|
| **控制面 Control Plane** | 负责"知道谁在哪、谁能干什么、怎么调度治理"的全局协调层 | 注册中心(Nacos)、调度器、OPA、计量、分发、流程治理 |
| **数据面 Data Plane** | 负责"实际执行能力"的载荷层 | Seam Provider、FlowEngine、连接器、LLM 推理、存储 |
| **协同面 Collaboration Plane** | 负责"多 agent / 多人 / 多端如何一起工作"的交互层 | agentTeams、A2A(RocketMQ)、异步 suspend/resume、多端事件汇 |

> 判据：改一次配置能让全平台生效的，是控制面；真正消耗算力产生结果的，是数据面；agent 之间对话/交接/人介入的，是协同面。

---

## 4. 五类制品（Artifact）精确定义与边界

"制品"= 带 manifest、可版本化、可注册、可分发的**一等公民单元**。五类边界：

| 制品 | 本质 | manifest 关键字段 | 边界（不做什么） |
|------|------|-------------------|------------------|
| **组件 Component** | 能力封装（数据分析/知识库/协同的原子能力） | `consumes`(seam)、`provides` | 不自主决策，被 agent/流程调用 |
| **技能 Skill** | 组件组合 + 工具/MCP + Prompt + Policy | `deps`(组件/技能)、`prompt` | 不含完整业务编排，是"能力包" |
| **业务智能体 Agent** | agent preset + 组件/技能引用 + policy | `preset`、`deps`、`policy` | 是"被部署运行的角色"，不是编排流 |
| **连接器 Connector** | 连通外部系统的标准化桥 | `protocol`、`auth`、`toolSurface`、`egress` | 凭证进 vault，不承载业务语义 |
| **流程 Flow** | DAG 编排（第五类，addendum 10） | `deps(算子)`、`audience`、`state` | 是"编排"，不是能力原子 |

> 边界铁律：**组件是原子能力，技能是能力包，智能体是角色，连接器是外部桥，流程是编排**。互相引用、互不越界。

---

## 5. 注册中心 / 配置中心 / 注册表

Nacos 收敛后三者语义（addendum 8）：

| 概念 | Nacos 中的落点 | 定义 |
|------|----------------|------|
| **注册中心 Registry** | Naming 服务（ephemeral + 心跳） | 解答"谁在哪、提供什么"——节点/实例/能力/制品的**寻址与发现** |
| **配置中心 Config** | Config（addListener 热下发） | 解答"当前该怎么做"——配额/限流/audience/灰度/OPA bundle 的**动态规则** |
| **注册表（目录）Catalog** | Naming 服务 + Config 存 manifest | 制品的**可发现仓库**（组件/技能/智能体/连接器/流程目录） |

> 区分：Registry 管"位置/存在"，Config 管"规则/参数"，Catalog 管"有哪些制品可用"。前序文档有时混用"注册表/注册中心"，此处统一。

---

## 6. 调度器 / 放置算法 / Worker

| 术语 | 定义 | 边界 |
|------|------|------|
| **调度器 Scheduler** | 全局任务协调者，管理三级队列、触发重平衡 | 不执行任务，只决策"去哪" |
| **放置算法 Placement** | Scheduler 内的打分函数：`score = 约束匹配 + 亲和 - 跨AZ代价` | 是 Scheduler 的决策逻辑，非独立服务 |
| **Worker** | 节点上的 `agentLoop` 槽，pull 任务并驱动 dsh 原生瀑布 | 无状态，状态全在复制式 Session 日志 |

---

## 7. 配额 Quota vs 限流 Rate Limit（精确区分）

| | 配额 Quota | 限流 Rate Limit |
|--|------------|-----------------|
| 维度 | 周期/总量预算（日/月/自定义窗口） | 瞬时速率/并发（令牌桶/滑动窗口） |
| 层次 | 平台→部门→角色→用户**单向耗尽树** | 多层级 key（global/tenant/dept/role/user/feature） |
| 超限反应 | 拒/降级（转 HITL 或轻量模型） | 429 + 退避 |
| 存储 | PG(预算) + Redis(周期余量 TTL) | Redis(令牌桶) |
| 语义 | "这月/这周能用多少" | "这一刻能多快" |

> 二者互补：限流防瞬时雪崩，配额防周期成本黑洞。都**前置拦截**（addendum 9）。

---

## 8. 溯源 Traceability vs 审计 Audit

| | 溯源 Traceability | 审计 Audit |
|--|-------------------|------------|
| 问题 | "这笔消耗/动作从哪来、到哪去" | "谁、在什么策略下、做了什么" |
| 数据 | `usage_ledger`（request→user→dept→role→agent→component→feature→token） | 策略评估日志 + 外部调用记录（OPA decision + connector egress） |
| 用途 | 成本归因、排障 | 合规、追责、防越权 |
| 落点 | PG(明细) + Doris(聚合) | Auditor + session 事件 |

---

## 9. 其它贯穿术语

| 术语 | 精确定义 |
|------|----------|
| **SessionEvent 日志** | dsh 原生的 append-only 事件流，是"真相源"；复制后多节点/多端一致（addendum 4） |
| **复制日志 Replication** | Session 日志跨节点复制，是 Worker 无状态化与崩溃 resume 的命脉（addendum 3） |
| **Bundle** | dsh 的组件打包单元，含 `cordis.patch.yml`；安装即 patch 生效 |
| **Profile** | dsh 的运行时配置/环境预设 |
| **Plugin** | Cordis 驱动的插件，模型/工具/agent-loop 皆插件（"一切皆插件"） |
| **Seam** | dsh 的"能力接缝"三件套（接口 Interface + Provider + Consumer），组件化解耦地基（addendum 1） |
| **A2A** | Agent-to-Agent，经 RocketMQ 信封 + correlationId 的可靠消息协同（addendum 8） |
| **Trace Context** | 从 request 透传到每次 LLM/seam 调用的身份 baggage（user/dept/role/...），溯源与计量归因的载体（addendum 9） |
| **HITL** | Human-in-the-loop，人工审批卡点（agent/turn-stopping 或独立审批流） |
| **Provisioner** | 声明式 reconcile 引擎，把节点拉到期望态（自动安装依赖图，addendum 8） |
| **OPA** | Open Policy Agent，单一策略点，统一评估工具/步骤/分发/出向/预算（addendum 6） |

---

## 10. 术语速查总表（一句话定义）

| 术语 | 一句话 | 出处 |
|------|--------|------|
| 网关 Gateway | 系统边界上某类流量的统一接入+治理门（南北向） | 本篇 §1 |
| Seam Proxy | 把本地 seam 调用透明转远端 Provider 的桥（东西向） | 本篇 §2 / 总体 |
| 控制面 | 知道谁在哪、谁能干啥、怎么调度的协调层 | 本篇 §3 |
| 数据面 | 实际执行能力的载荷层 | 本篇 §3 |
| 协同面 | 多 agent/人/端如何一起工作 | 本篇 §3 |
| 组件/技能/智能体/连接器/流程 | 五类制品（原子/包/角色/桥/编排） | 本篇 §4 / 各篇 |
| 注册中心/配置中心/注册表 | 寻址发现 / 规则下发 / 制品目录 | 本篇 §5 / 8 |
| 调度器/放置/Worker | 决策去哪 / 打分函数 / 执行槽 | 本篇 §6 / 3 |
| 配额/限流 | 周期预算树 / 瞬时速率闸 | 本篇 §7 / 9 |
| 溯源/审计 | 成本归因链 / 合规追责 | 本篇 §8 / 6,9 |
| Seam | 能力接缝三件套（接口+Provider+Consumer） | 总体 / 本篇 §9 |
| A2A | RocketMQ 信封的 agent 间可靠协同 | 8 |
| Trace Context | 跨链路透传的身份 baggage | 9 |
| Provisioner | 声明式 reconcile 自动装配 | 8 |
| OPA | 单一策略点 | 6 |

---

## 11. 体系位置（十一篇闭环）

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
| **11 技术术语精确定义（新）** | **网关/Proxy/三平面/五制品/注册配置/调度/配额限流/溯源审计 边界字典** |

至此体系既有"架构（做什么）"，也有"字典（名词指什么）"——任何后续代码/接口/文档命名都有了权威依据。尤其「网关」不再含糊：Terminal/Connector/LLM 是南北向的门（做治理），Seam Proxy 是东西向的桥（做透明转发）。

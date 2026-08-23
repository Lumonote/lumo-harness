# DeepSeek Harness 分布式平台 · 数据层设计 Addendum

> **【已整合 · 以 V2 为准】** 本文内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§5，请以 V2 为权威版本。

> 接续 `deepseek_harness_distributed_design.md`。本题：底层换成**分布式数据库 / 分布式缓存 / PostgreSQL / Nebula 图数据库 / Doris** 等，如何融入架构。
> 一句话结论：**这些系统不是「底座替换」，而是 capability 节点上的远程 Seam Provider；组件只声明 `consumes` 哪种数据 seam，绝不直连引擎。**

---

## 0. 定调：换的不是内核，是能力节点的 Provider

dsh 内核（Cordis / seam / event / SessionEvent 日志）保持不变。前文把节点粗分为 gateway / agent / capability / storage，本 addendum 把 **storage 节点细化为多模态数据节点**——每个数据系统都是一个 typed seam 的 Provider：

```
Agent 节点                          数据 capability 节点（按引擎分池）
  └─ component 声明 consumes:        ├─ PostgreSQL   → ctx.datastore.sql   (事务/元数据)
       doris:olap, nebula:graph      ├─ Apache Doris → ctx.datastore.olap  (OLAP 分析)
       redis:cache, pg:sql           ├─ Nebula Graph → ctx.knowledge.graph (图谱/关系)
                                     ├─ Redis Cluster→ ctx.cache           (热数据/共享态)
                                     └─ 分布式DB(TiDB/CRDB) → ctx.datastore.txn (系统记录)
            │                                  ▲
            └──── DistributedSeamProxy(gRPC) ──┘   Consumer 零改动
```

**不变的原则**：组件写 `consumes: [ctx.datastore.olap]`，调度器把它路由到 Doris capability 节点；哪天换 ClickHouse/StarRocks，只换 Provider，组件与 agent 不动。

---

## 1. 数据系统的能力分层与 Seam 映射

| 系统 | 类型 | 提供的 seam | 一致性 | 双重角色 |
|------|------|-------------|--------|----------|
| **PostgreSQL** | 关系型/事务 | `ctx.datastore.sql` | 强一致 | ① 平台元数据/权限主库 ② 业务 OLTP 源 |
| **Apache Doris** | MPP 列存 OLAP | `ctx.datastore.olap` | 最终一致 | ① 分析组件主算力 ② Session 日志冷存/用量分析 |
| **Nebula Graph** | 分布式图库 | `ctx.knowledge.graph` | 强一致(单图内) | ① 知识库图层级 ② 业务关系/血缘/协同网 |
| **Redis Cluster** | 分布式缓存 | `ctx.cache` | 最终一致 | ① 热共享态(信箱/goals/日志热层) ② 特征/向量缓存 |
| **分布式 DB (TiDB/CRDB)** | HTAP/强一致 | `ctx.datastore.txn` | 强一致 | ① 多租户系统记录 ② 跨集群联邦一致源 |

> 关键区分：**平台 backing（控制面自己用）** vs **业务组件消费（agent 跑任务用）**。前者是平台内部存储，后者是暴露给组件的 seam。两者可以共用同一引擎（如 Postgres 既存 Registry 也供 OLTP 查询），但**访问路径必须都是 seam**。

---

## 2. 各系统如何接入

### 2.1 PostgreSQL → 事务 + 平台元数据主库
- **平台 backing**：Registry 元数据、Usage Ledger、租户/权限（`isolate` realm ↔ schema 映射）、agent 持久化（**替代 dsh 默认本地 sqlite**，实现跨节点共享）。
- **业务消费**：结构化 OLTP 源，作为数据分析组件的 `source` seam。
- **接入**：实现 `ctx.datastore.sql` Provider（Postgres 方言），走 seam 代理。

### 2.2 Apache Doris → OLAP 分析引擎
- **业务消费**：数据分析组件的**主算力**——重聚合、即席查询、实时看板，原生适合「销售漏斗」「留存分析」这类组件。
- **平台 backing**：SessionEvent 日志冷存与 OLAP 检索、跨租户用量分析。
- **接入**：`ctx.datastore.olap` Provider；**必须声明 `consistency: eventual`**，组件编排时不能把它当事务库。

### 2.3 Nebula Graph → 图 / 知识图谱
- **业务消费**：
  - 知识库组件的**图层级**（实体/关系/同义词，做图增强 RAG）；
  - 业务协同的**关系网**（谁审批谁、流程依赖）；
  - 智能体/组件**依赖血缘**。
- **接入**：`ctx.knowledge.graph` 或独立 `ctx.graph` Provider，每个租户一个 graph space（realm 隔离）。

### 2.4 Redis Cluster → 热数据 / 跨节点共享态
- **平台 backing**：复制式 SessionEvent 日志的**热层**、agent 信箱/`ctx.goals` 热态、LLM KV 缓存、特征 store。
- **业务消费**：`ctx.cache` Provider，给组件做结果缓存/会话态。
- **价值**：让跨节点协同的低延迟状态（mailbox、goals）不回源到 Doris/PG。

### 2.5 分布式 DB (TiDB / CRDB) → 系统记录 / 联邦一致
- **平台 backing**：多租户主数据、跨集群一致的 Registry 联邦（中心 Registry 用强一致 DB，边缘 pull）。
- **接入**：`ctx.datastore.txn` Provider，承接需要 ACID 的平台内部写入。

---

## 3. 组件如何消费（manifest 升级）

在 `component.yaml` 的 `consumes` 里声明**具体数据 seam + 一致性要求**，调度器据此选引擎与节点：

```yaml
spec:
  consumes:
    - seam: ctx.datastore.olap      # Doris 聚合
      consistency: eventual
    - seam: ctx.knowledge.graph     # Nebula 关系
      consistency: strong
    - seam: ctx.cache               # Redis 热层
  requires:
    - dataNode: [doris, nebula]     # 调度约束：需这些数据 capability 节点就近
```

`DistributedSeamProxy` 把调用路由到对应引擎的 Provider；Consumer（组件里的 tool）代码不变。

---

## 4. 平台自身元数据该用什么（backing store 推荐）

| 控制面子系统 | 推荐存储 | 理由 |
|--------------|----------|------|
| Registry 元数据 / 权限 / realm | **PostgreSQL** | 强一致、关系建模、事务 |
| Usage Ledger（主） | **PostgreSQL** | 计费需准确事务 |
| Usage Ledger（分析看板） | **Doris** | 海量用量 OLAP |
| SessionEvent 日志（热） | **Redis** | 低延迟 replay/resume |
| SessionEvent 日志（冷/检索） | **Doris + 对象存储** | 列存压缩 + 低成本 |
| agentTeams / goals 状态（热） | **Redis** | 协同低延迟 |
| agentTeams / goals 状态（冷） | **PostgreSQL** | 持久化 |
| 知识库图层级 / 血缘 | **Nebula Graph** | 关系遍历 |
| 跨集群联邦一致源 | **TiDB / CRDB / PG 逻辑复制** | 强一致 + 多写 |

> 注意：**别用 Doris 存 Registry 主数据**——它是最终一致 OLAP，丢事务语义会让权限/版本错乱。

---

## 5. 一个真实的数据分析组件长什么样（多 seam 编排）

典型「经营分析」组件其实是**跨多引擎的 pipeline**，全部经 seam 编排：

```
OLTP源(PostgreSQL, ctx.datastore.sql)
   → ETL(组件内部 job, ctx.jobs)
   → 聚合(Apache Doris, ctx.datastore.olap)        ← 重算力在 capability 节点
   → 关系补充(Nebula, ctx.knowledge.graph)         ← 渠道/客群关系
   → 缓存(Redis, ctx.cache)                        ← 看板热数据
   → LLM 合成(ctx.llm) + 可视化(ConversationNodeDefinition)
```

组件只声明它消费了哪些 seam；引擎替换、节点扩缩都对组件透明。这正是对「数据分析组件化」最落地的诠释。

---

## 6. 一致性、隔离与治理（最关键的非功能）

| 关注点 | 做法 |
|--------|------|
| **声明式一致性** | 组件在 manifest 标 `consistency: strong|eventual`；调度器据此选引擎，agent 不会误把 Doris 当事务库 |
| **租户隔离** | realm ↔ 存储命名空间映射：PG schema / Doris database / Nebula space / Redis key prefix 按 realm 隔离 |
| **查询治理（重点）** | agent 生成的 SQL/Graph 查询**必须在 Seam Provider 层 sanitize**：参数化、行级权限（OPA）、限流、脱敏；禁止 `DROP`、禁全表扫、超大额度的 Doris 查询熔断 |
| **数据血缘/审计** | SessionEvent 日志记「谁查了什么」；Nebula 存关系血缘；Doris 存查询血缘，满足合规审计 |
| **连接治理** | 每个数据 capability 节点前置连接池 + 查询网关，避免 agent 风暴打爆后端 |

---

## 7. 风险与决策（opinionated）

1. **组件绝不直连数据库**——一律走 seam。直连会丧失可替换性、治理点与租户隔离，等于回到「能力写死」的反模式。
2. **Doris 不是事务库**：任何需要 ACID 的平台/业务数据（权限、计费、订单）放 PG/分布式 DB，Doris 只做分析。
3. **Nebula 建模要早做**：图 schema（实体/边类型/索引）是知识库与血缘的质量天花板，别等组件多了再补。
4. **资源弹性**：Doris / 图库是重资源户，按需起 capability 节点、闲时回收（呼应前文昼夜弹性），用 `requires: dataNode` 让调度器管理。
5. **查询安全是底线**：LLM 生成的查询必须过 Seam Provider 的校验网关，否则一个坏 SQL 能拖垮整个 Doris 集群或泄露跨租户数据。
6. **冷热分层**:Session 日志、看板态走 Redis 热层，落库/分析走 Doris/PG——别把所有请求都打到底层 OLAP。

---

## 8. 与总架构的关系

本 addendum 只细化了 **L0 资源层 / L1 数据 capability 节点** 与 **L2 能力组件层的 `consumes` 契约**，其余分层（控制面、治理、产品形态、Roadmap）完全不变。换任何引擎 = 换对应 seam 的 Provider，平台其余部分零改动——这正是「一切皆插件 + seam 网络化」带来的红利。

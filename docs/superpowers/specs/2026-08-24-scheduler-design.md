# Scheduler 设计说明 —— leader 选举 + fencing + 最小放置（阶段 3 第一项）

- 日期：2026-08-24
- 评审对应：design-review **N1【P0】**（全局 Scheduler 新单点）
- 状态：设计已确认，待用户评审后进入实现计划
- 服务位置：`platform/control-plane/scheduler`（独立 Go 服务，不塞进 dsh 插件——§3.1 分界）

## 0. 决策背景

N1 的要求：① 全局 Scheduler 以 leader 选举 + 热备运行，**放置决策必须带 fencing token**，防旧 leader 复活双写；② 降级模式：全局不可用 ≠ 全平台停摆，集群可本地放置、恢复后对账。

**选举底座决策：PG fencing 租约，不用 Nacos/Raft。** N1 原文括号建议「（Nacos/Raft 已在栈内，不新增依赖）」；此处是有记录的偏离。理由：fencing token 必须与被保护的写路径**同源**。放置写入最终落 PG；若 leader 身份来自 Nacos，在「Nacos 侧已失租约、旧 leader 的写仍可能在新 leader 之后提交」的窗口内，无法用单次原子操作覆盖——要堵窗口终究得在 PG 存 term 并在每条写入上条件校验，届时 Nacos 层只是多余一跳。PG 租约使 token 与写入天然同事务。该形状已被 session-log（评审 A1）在同库实跑验证（20 轮×20 并发恰好 1 胜出）。

代价与前提：PG 进入选举关键路径，PG 挂则选不出 leader。复制日志已把 PG 放在关键路径上，未引入新单点；**若日志未来迁离 PG，本决策需重审**。该决策已在 2026-08-24 会话与用户确认。

## 1. 范围

**在范围内：**

- leader 选举 + 热备（1+1），放置写入**事务内 fencing 校验**
- 过滤式最小放置：requires 匹配 + 节点槽位闸。**不做打分公式**——A4 已列为 P2
- 任务生命周期：PENDING / PLACED / RUNNING / COMPLETED / FAILED / ABORTED + attempt 单飞
- 派发：**PG 事务 outbox**（§13.2 已定的 RocketMQ 本地替代；与放置同事务，保「放置 ⟺ 派发」原子）
- 降级：无 leader 时**快速失败**（显式 no-leader 错误，绝不挂起等待）+ 对账接口占位
- 本地节点目录（PG 实现；Nacos 实现留接口）

**不在范围（留给后续阶段）：**

- 打分公式（A4，P2）、EDF/WFQ 排序、租户配额 / 预算 / 熔断四闸中的后三闸（各自执法点已在 §6.3/§6.4，调度联动后做）
- 多集群本地放置降级（依赖 §7.4 集群 Scheduler，彼时实现）
- RocketMQ 真实 broker（A2A 交付；本地 outbox 替代）
- Nacos 注册 / 发现（本地栈无 Nacos，接口预留，生产实现随接入）

## 2. 组件与边界

| 包（`internal/`） | 职责 | 依赖 |
|---|---|---|
| `domain` | Task / Placement / 租约 / 错误类型（NoLeader / FencedOut / NoCapacity） | — |
| `store` | 幂等 DDL、租约操作、放置事务（fencing 校验点） | pgx/v5 |
| `election` | 选主循环：acquire + 续租 ticker + 领导权变更回调 | store |
| `planner` | 过滤式放置决策（requires 匹配 + 槽位计数） | catalog |
| `server` | HTTP API、网关注入身份头（collaborator 同款） | — |
| `catalog` | **NodeCatalog 接口**：本地 PG 实现；Nacos 实现留接口 | store（本地） |
| `dispatch` | **DispatchSink 接口**：本地 PG outbox 实现；RocketMQ 实现留接口 | store（本地） |

两处接口化（catalog / dispatch）遵循「本地换引擎、契约不变」的 Local-lite 铁律（§13.2/铁律 21）：同一服务在本地跑 PG 目录 + outbox，生产换 Nacos + RocketMQ，业务语义零改动。

服务骨架对齐 collaborator：Go 1.24、pgx/v5、flag+env 配置（`LUMO_PG_DSN` / `LUMO_LISTEN` / `LUMO_INSTANCE`）、slog JSON 日志、优雅停机（**先释放租约再关池**——session-log 的「停机不排空在途写」教训）、compose.local.yml 以双实例接入（1+1 热备拓扑）。

## 3. 租约与 fencing 语义

**单行租约表**（CHECK 约束锁单行，全局唯一租约）。acquire 用**一条 UPSERT 完成建租 / 续租 / 接管**三种情形——分开写会在两条语句间留出「两个节点都判定无人持租」的竞态窗口（session-log 同款结论）。

三个不变式：

1. **时间一律取库端时钟**（PG `now()`），不用节点本地时钟——消除时钟偏移导致的「双 leader 同时自认持租」；
2. **续租不换 token，易主才 +1**——续租也 +1 会让持有者自己在途的写被自己的新 token 判为过期；
3. **释放置 `expires_at=0` 而非删行**——token 高水位不回落，否则下一个持有者从 1 重新开始，旧持有者的过期令牌反而「复活」。

续租周期 TTL/3（TTL 默认 10s）。**写路径**：放置事务内 `FOR UPDATE` 锁租约行，校验 `持有者 == 本节点 && token == 当前代 && 租约未过期`，任一不符 → FencedOut。

与 session-log 的一处语义差异：Scheduler 的 leader 也是续租者。进程 GC 停顿超过 TTL 后，**自己的写同样被拒**——这是正确的：此刻接管随时可能发生，token 虽未变但排他性已失。

## 4. 放置事务与任务生命周期

**任务表**：task_id（PK）、realm、cluster_id、requires、priority、state、attempt、node_id、fencing_token（放置时持有的隔离令牌，追溯「这条放置是哪一代租约下写的」）、时间戳。**payload 类列一律 TEXT 存 JSON 文本**——session-log 实测教训：JSONB 拒收 `\u0000` 而模型内容带 NUL 是常事，静默丢行会在日志留空洞；保真度优先于按内容检索。

**attempt 单飞**（§7.4.1「一个任务只在一个集群执行」的单集群化）：task_id 是主键（每任务单行），单飞由放置事务内 `FOR UPDATE` 任务行 + 状态检查保证——活跃 attempt（PLACED/RUNNING）时幂等返回既有放置，不产生第二次派发；旧 attempt 已终结（COMPLETED/FAILED/ABORTED）时开启 attempt+1。**重放置产生新 attempt 而非并行执行**。（实现记录：初稿设想的「task_id 部分唯一索引」无意义——task_id 全局唯一，单行即单状态，事务内状态检查已充分。）

**放置事务步骤**：BEGIN → 锁租约行校验 fencing → 写任务行（task_id 冲突时幂等返回既有放置，不产生第二次派发）→ 写 outbox 行 → COMMIT。放置与派发同事务是 §13.2 选 PG outbox 替代 RocketMQ 的首要理由：PG 事务天然提供「扣槽位 + 发任务」的原子性。

**槽位闸**：放置事务内对目标节点计数活跃放置（PLACED/RUNNING），超出节点容量即拒绝该节点。计数无竞态的前提是租约行锁把并发放置串行化——这正是 fencing 行兼作互斥锁的连带收益。

**drain loop**：leader 侧周期扫描 PENDING 任务按 priority 重试放置——任务在无容量时排队而非被丢弃，槽位释放后自动接续。§6.2 排序只取 priority 一维，EDF/WFQ 随打分公式一起缓做。

## 5. API 表面

| 端点 | 作用 | 备注 |
|---|---|---|
| `POST /v1/placements` | 提交任务放置 | 非 leader → 503 no-leader；task_id 幂等 |
| `GET /v1/placements/{taskId}` | 查询放置状态 / 节点 / attempt | |
| `POST /v1/tasks/{taskId}/result` | 执行器回报终态（COMPLETED/FAILED） | 幂等；槽位由此释放 |
| `POST /v1/nodes` | 节点目录 upsert（容量 + capabilities） | 本地形态；生产由 Nacos Naming 喂 |
| `POST /v1/reconcile` | 降级对账入口（占位语义） | 见 §6 |
| `GET /v1/leader` | 当前 leader + token（观测 / 测试） | |
| `GET /healthz` | 存活探针 | |

## 6. 降级与错误处理

| 错误 | 场景 | HTTP | 调用方动作 |
|---|---|---|---|
| `no-leader` | 租约空或过期未接管 | 503 | 快速失败，绝不挂起等待；本交付不实现本地降级放置（§7.4 阶段补） |
| `fenced-out` | 旧 leader 在途写被新代 token 拒绝 | 503 | 重交安全：task_id 幂等 + attempt 语义兜底，不会双执行 |
| `no-capacity` | 无满足 requires 且有槽位的节点 | 排队 | 任务落 PENDING，drain loop 接续，无需调用方重试 |

**对账接口（占位）**：`POST /v1/reconcile` 接收集群本地放置记录，leader 幂等入库（去重后记录到账本）。占位语义 = 只做「接收 + 去重 + 落账」，多集群的合并裁决逻辑（冲突 attempt 合并、状态回放）留给 §7.4 集群 Scheduler 交付时实现——接口形状现在定死，语义彼时补全。

## 7. 测试与核验清单（对活库，延续阶段 2 标准）

Go 集成测试（`LUMO_TEST_PG_DSN` 指向 compose PG 55432）：

| # | 场景 | 断言 |
|---|---|---|
| 1 | 选举竞态：20 轮 × 20 并发抢租 | 每轮恰好 1 胜出（session-log 同款测试移植） |
| 2 | kill leader → 备接管 | 接管完成 ≤ TTL |
| 3 | 罢免后旧 leader 在途放置 | FencedOut 拒写；新 leader 重放同 task → attempt+1 而非双执行 |
| 4 | 优雅停机释放租约 | `expires_at=0` → 备**零等待**接管 |
| 5 | 同 task_id 重交 | 一次放置、一条 outbox（幂等） |
| 6 | 无 leader 提交 | 503 no-leader 快速失败（不挂起）；reconcile 幂等对账入库 |
| 7 | 槽位满 → 排队 → 释放 | 第二任务 PENDING；首任务终态后 drain 放置成功 |
| 8 | 放置与 outbox 原子性 | 提交成功 ⟺ 两行同在；任一失败 ⟺ 两行皆无 |

compose 双实例 e2e（kill 全局 Scheduler → 备节点接管）归入 §13.2 故障注入清单常态化执行。

## 8. 文档更新（随实现提交）

- **architecture.md §6.2 / §7.4.1**：补选举底座决策记录（PG 租约，偏离 N1 的 Nacos/Raft 建议及理由），标注「若复制日志迁离 PG 需重审」。
- **design-review.md N1 状态**：第 1 条（选举 + fencing）闭环；第 2 条（降级）按「快速失败 + 对账接口」部分闭环，多集群本地放置随 §7.4。

## 9. 遗留与后续

- Nacos 版 NodeCatalog 与 RocketMQ 版 DispatchSink（接口已定，实现随 A2A / 多集群接入）
- 打分公式与 EDF/WFQ（A4，P2）
- 多集群本地放置降级与对账合并裁决（§7.4）
- 选举底座重审触发条件：复制日志迁离 PG

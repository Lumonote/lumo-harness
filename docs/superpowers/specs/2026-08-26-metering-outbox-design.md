# 计量事件异步削峰设计说明 —— usage_event_outbox:扣减与事件同事务,台账搬离请求路径

**评审条目**：B2 落地状态偏离①（RocketMQ `usage-events-<cost_type>` 异步削峰待 RocketMQ 进拓扑；原写 `usage.event.*`——**2026-08-26 真实 broker 联调发现 topic 点号非法（合法字符集 `^[%|a-zA-Z0-9_-]+$`），已修正命名**）
**规范章节**：`docs/architecture.md` §6.4（异步削峰）/ §13.2（Local-lite 等价形态）
**前置**：`docs/superpowers/specs/2026-08-26-budget-total-model-design.md`（总额模型）+ `knowledge/src/graph-projector.ts`（仓库内同构先例）

---

## 1. 问题：承诺的是「不阻塞推理」，现在是进程内直写

§6.4 的原文承诺：

> **异步削峰**：计量事件走 RocketMQ `usage-events-<cost_type>`（命名修正见文首），不阻塞推理。

§13.2 给了 Local-lite 的等价形态：

> 消息 / A2A / Trigger：RocketMQ → **PG 事务 outbox + 进程内调度器**。PG 事务天然提供
> 「扣配额 + 发任务」的原子性——这正是 §8.3 选 RocketMQ 的首要理由，本地用事务直接满足。

当前实现（B2 偏离①记的账「本期为进程内直写」）却在每条流的 `commit` 里**同步直写
`usage_ledger`**：逐行 16 列 INSERT、无批处理、无事件键、无事件时刻概念。三条具体病征：

1. **削峰缺失**：高并发流结束 → 大量单行小事务堆积在 dsh 节点 PG pool；同批数据经
   搬运后一个`多行 INSERT` 事务即可投递，写放大差一个量级。
2. **无幂等键**：`usage_ledger` 没有事件键。RocketMQ 至少一次投递下，同一事件到账
   两次 = 一单记了两笔。今天直写恰好不会重复——但不是设计出来的，是「还没有第二个
   传输」的偶然。这个偶然在传输一换就消失。
3. **事件时刻缺位**：`usage_ledger.ts` 是 `DEFAULT now()` = **写库时刻**。一旦存在
   drain 延迟，「23:59:58 消耗、00:00:02 落账」会把成本划进下一个周期——计数周期门
   按写库时刻判，账单跨期。这里需要的是**事件时刻**（发生时刻）与可见时刻解耦。

仓库里已有同构先例：`knowledge_graph_outbox` + `graph-projector.ts`（跨存储无事务 →
意图与主数据同事务、异步投影、`FOR UPDATE SKIP LOCKED`、失败 warn 不抛、已投影行
保留 + 部分索引）。本切片照它的形状，把计量事件从请求路径搬到 outbox + 进程内调度器。

## 2. 模型：usage_event_outbox（意图表）与 usage_ledger

| 表 | 角色 | 写入方 |
|---|---|---|
| `usage_event_outbox` | 事件意图（已 `assertCostEvent` 的完整事件） | `commit()` / `emit()` —— 与预算扣减**同一事务** |
| `usage_ledger` | 台账（append-only，强一致溯源目标） | **只有 drain 器**（唯一写入者语义不变——换传输不动发出方） |

```sql
CREATE TABLE IF NOT EXISTS usage_event_outbox (
  seq          BIGSERIAL PRIMARY KEY,          -- 投影顺序键
  event_key    TEXT NOT NULL UNIQUE,           -- 幂等键（gen_random_uuid()，DEFAULT now() 前生成）
  payload      JSONB NOT NULL,                 -- assertCostEvent 通过后的 CostEvent 全文
  ts           TIMESTAMPTZ NOT NULL DEFAULT now(),  -- 事件时刻，非投影时刻
  projected_at TIMESTAMPTZ                     -- NULL = 未投影
);
CREATE INDEX IF NOT EXISTS idx_usage_outbox_pending
  ON usage_event_outbox (seq) WHERE projected_at IS NULL;   -- 部分索引：只扫未投影尾巴
```

`usage_ledger` 加一列 `event_key TEXT NULL` + 唯一索引（**存量行 NULL 不迁移**——与
`trace_id`/`emitter` 同哲学，历史行不用假数据回填；PG 的 UNIQUE 允许多个 NULL）。

**职责矩阵**：

| 路径 | 请求路径（同步） | 后台（异步） |
|---|---|---|
| `commit()` | 预算树扣减 ×2 + 写 outbox，**同一 PG 事务** | —— |
| `emit()` | `assertCostEvent` + 写 outbox（无预算树） | —— |
| `drainOnce()` | —— | 未投影行 `FOR UPDATE SKIP LOCKED` → 批量插台账（`ON CONFLICT (event_key) DO NOTHING`、`ts` 显式取 outbox.ts、key 带出）→ 标 `projected_at`，同一事务 |

## 3. 四个跨传输不变式（搬运输的尺子，现在定下来）

任何「事件 → 台账」搬运器（本地的 outbox drain、以及将来把 `drain` 的最后一步换成
RocketMQ 消费）都必须满足——不满足的实现，对账单的伤害是一样的：

1. **一次事件一账**：`event_key` 全局唯一；至少一次投递 / 崩溃重跑不重复入账
   （`ON CONFLICT (event_key) DO NOTHING`）。
2. **事件时刻保真**：台账 `ts` = 事件发生时刻（outbox.ts），**不是**投影时刻。既卖
   削峰（可见性延迟），又不能让延迟偷偷改账单日期。
3. **顺序稳定**：按 `seq` 序搬运；台账内 `(ts, id)` 排序语义不变 ——「本次尖峰的构成」
   何时读、读几次都一致（既有 `byTrace` 断言依赖这条）。
4. **原子配套**：扣减（预算树）与事件意图（outbox）同一事务。本地由 PG 事务满足，
   §8.3 选 RocketMQ 事务消息的理由正是同一件事的集群版——同一个不变式，两个实现为
   它服务，而不是各发明的做法。

`event_key` 在**写 outbox 时**由 PG 内置 `gen_random_uuid()` 生成——不是发出方生成：
发出方跨语言（连接器网关是 Go、jobs 是 TS），不需要（也不可能）协商一致的键格式。
发出方只对事件内容负责，键的生成是管线的事（管线内事件唯一，冗余一次重放靠它去重）。

## 4. 语义变化：写穿即见 → 有界最终一致（显式声明）

- 旧：`emit` / `commit` 返回时台账行已在（同一事务写穿）。
- 新：返回时行在 outbox；可见时刻 ≤ drain 周期（缺省 1000ms）+ 一个批次的投递时间。
- 受影响方：`byTrace` 与台账读方（计费核对、看板下钻）——秒级有界延迟；审计回看路径
  天然容忍。**事件时刻保真**使「可见性延迟」与「记账时间」解耦：延迟影响的是**看到多
  晚**，不是**记在哪一天**。
- **不受影响**：`reserve` / `balance` / 预算树判定——它们是额度执法，保持同步，不搬。
- 契约（`assertMeteringContract`）不含台账断言，预算场景一字不改；台账属性的尺子进
  §7 的新契约辅助。

## 5. drain 器与进程内调度器

- `PgMeteringSeam.drainOnce(batchSize = 100)`：单实例重入保护（`running` 标志，同
  `GraphProjector.drain`——定时器压车）；空批返回 0；任何失败整批回滚并抛出，下一轮
  自然重放（投影失败 warn 不抛，由**插件层**捕获，同知识库 `index.ts` 先例）。
- 插件 `index.ts`：`drainIntervalMs`（缺省 1000）/ `drainBatchSize`（缺省 100）进
  `MeteringConfig`；`init()` 成功后起 `setInterval`（`unref`，不阻塞进程退出）；
  `ctx.effect` 清理。
- `FOR UPDATE SKIP LOCKED`：多节点实例并发搬运互不阻塞也不重复搬——这条是「Local
  进程内」与「Cluster 消费侧」共用的搬运语义，现在写对，将来换传输只换入口。

## 6. 毒丸与积压（诚实边界）

- **毒丸行**：outbox 的 payload 只可能由本管线写出（`assertCostEvent` 在前）；被手工
  编辑坏是唯一来源。drain 时再验一次，失败 → 抛 → 整批回滚 → 下轮重试。**已知不足**：
  毒丸会阻塞其后的批次（与知识库投影先例同款），不做错误标记列——留观测项。
- **已投影行不回收**（同知识库）：部分索引保证轮询只扫未投影尾，历史行不拖慢。
- **积压观测**：outbox 深度/最老未投影行龄（OTel gauge）是整个「削峰」能否自证的
  **待补指标**——离开它，「削了峰」只是断言。不做假指标，列为下一项可观测切片。

## 7. 契约：搬运输不变式进共享契约

新增 `assertCostEventDrainContract(env, assert)`（放 `seam-contracts/metering.ts`，
与 `assertMeteringContract` 同居——它是**台账管线**的尺子，不是预算的）：

- **D1 事件先入管线、drain 后入账**：`emit` → 台账 0 行（「写穿即见」已不是语义）；
  `drainOnce` → 台账行数 = 事件数，`byTrace` 可达。
- **D2 重放幂等**：`redeliverAll()`（模拟至少一次投递）→ `drainOnce` → 台账行数
  **不变**。这是「一次事件一账」的可证明形式。
- 现在只有 PG 一个实现，但它是**为第二个实现写的尺子**：未来 RocketMQ 消费侧必须跑
  同一套断言——防的就是上个品类踩过的「四态只在 stub 上证明过」：属性不在共享契约，
  第二个实现就会各写各的。

## 8. 不做的事

- **不做 RocketMQ 进拓扑 / 消费侧 Go 服务**：RocketMQ 未进部署拓扑（与 Nacos 同因），
  B2 偏离①保持记账——本切片交付 §13.2 明文的**本地等价形态**（PG 事务 outbox + 进程内
  调度器），而不是冒充 RocketMQ 已落地。
- **不做派生聚合引擎**。原计划的下一条义务是 Doris 投影，**已于 2026-09-14 按决策移除**（理由见
  `docs/cluster-development-tasks.md` 的「Usage analytics: 2026-09-14」）；日粒度聚合改由查询面在
  PG 台账上直接分组。
- **不做 outbox 垃圾回收 / 毒丸错误标记 / 积压监控**（§6 留下观测项）。
- **不做消费回执 / 重试指数**（那是 RocketMQ 消费侧的事，本地形态不可重试）。

## 9. 验收判据

| # | 判据 |
|---|---|
| 1 | `commit`/`emit` 不再直写台账：写后 ledger 0 行、outbox 恰 1 行；预算扣减、余额、reserve 行为与切片前完全一致（既有 budget 用例全绿，不变可见时时点） |
| 2 | 扣减与事件同事务（结构不变量：同一事务内 UPDATE 预算树 + INSERT outbox——事务回滚语义读者凭代码可验，列为结构不变量而非可模拟断言的测试） |
| 3 | `drainOnce`：空批 0；批量上限生效；投递后台账行数 = 事件数（D1） |
| 4 | 重放幂等：`projected_at` 置回 NULL 再 drain，台账行数不变（D2，共享契约断言） |
| 5 | 事件时刻保真：手动把 outbox.ts 改为历史时刻再 drain，台账 ts 等于该历史时刻而非 now() |
| 6 | 顺序稳定：混链 `byTrace (ts,id)` 两轮读取一致，批内/批间序与既有语义一致 |
| 7 | 校验仍在写入口：坏事件拒绝时 outbox 0 行 + ledger 0 行（outbox 不是绕过校验的通道） |
| 8 | 旧行兼容：`event_key` 为 NULL 的历史行（含直写模拟行）照常可读，不要求迁移 |
| 9 | 文档同步：§6.4 异步削峰落地状态、B2 偏离①记账更新（本地等价已落地 / RocketMQ 仍待拓扑）、README 已定案行措辞；113 号契约清单不变 |

**迁移**：`init()` 幂等（新表 CREATE IF NOT EXISTS、加列 ALTER IF NOT EXISTS + 唯一
索引 IF NOT EXISTS）；既有库无表直接建，既有台账零迁移。

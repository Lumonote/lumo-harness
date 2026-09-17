# 计量聚合设计说明 —— Doris cube：明细在 PG，聚合可重建，缺能力显式拒绝

> **状态：已被取代（2026-09-14）。** 本设计**未实现即被放弃**——Doris 投影链路
> （`internal/doris` / `internal/projection` / `analytics/doris.go`）已从
> `platform/control-plane/usage-ledger` 移除，用量查询面收敛为只读 PG 台账的日粒度聚合。
>
> **放弃的理由**（保留本文作决策痕迹，不是因为还有效）：
> ① `AGGREGATE KEY` + `SUM` 是**装载时聚合**语义，重放同一批会把 `qty`/`cost_usd`/`tokens`
> 再加一次；要正确必须同时满足「cube 是 `UNIQUE KEY`」且「投影写的是键的**完整聚合值**而非批次增量」，
> 而 `CREATE TABLE IF NOT EXISTS` 对已存在的表什么都不做 —— 一个历史聚合表会**永远静默双计**，
> 没有任何一层报错，只在报表数字上缓慢漂移。
> ② 收益只是把一次 `GROUP BY` 下推，代价是额外组件 + 投影 worker + 位点表 + 一类只能靠约定维持的一致性。
> ③ 台账 append-only、无分区，直查的慢是**直白的**；而陈旧 cube 看起来和「没有用量」一模一样。
>
> 仍然有效的部分（已落到 PG 查询面）：报告时区固定 UTC 且 SQL/Go 同源、`[from, toEnd)` 半开区间、
> 366 天跨度上限。现状见 `docs/cluster-development-tasks.md` 的「Usage analytics: 2026-09-14」。

- 日期：2026-08-26
- 前置：`2026-08-26-metering-outbox-design.md`（事件流/台账管线已定）；`platform/shared/manifests/usage-ledger.schema.json`（列清单唯一真相源）
- 规范章节：`docs/architecture.md` §6.4（存储分工：明细进 PG、聚合直接在台账上分组、限流走 Redis）
- 状态：~~设计说明（Doris 未进拓扑；实现随 P2——待 Doris 接入触发联调）~~ **已取代，不实施**
- 环境：Doris 未起本地拓扑——**能力缺失显式拒绝**（铁律 21），本地看板走「PG 明细 + 降级提示」，不得模拟

## 1. 问题：明细不能回答「解释一次尖峰」

B2 的核心诉求按归因折回到「按 cost_type 下钻某天的尖峰」——这个查询反复扫 `usage_ledger`(
按月 30 万行、数年 3 千万级的 append-only 表)会越来越贵,而且 PG 上做滚动聚合等于把批次
做的立方体再做一遍。

另一个方向是「事件流直接记 Doris」——不行:**Doris 是 OLAP,不是事务库**(钢律:分布式
无事务、不能承担追加真相)。明细唯一真相源在 PG(§6.4 的强一致溯源),Doris 的 cube 必须
是**可从真相重建的投影**——不是第二真相,是索引的远端形态。

## 2. 模型：日分区 2 级滚动 × 归因维度列全展开

```sql
CREATE TABLE IF NOT EXISTS usage_daily_cube (
  bucket_ts   DATETIME NOT NULL,          -- 日桶 00:00(事件时刻 tz 归一 UTC 存)
  cost_type   VARCHAR(32) NOT NULL,
  user_id     VARCHAR(64), dept_id VARCHAR(64), role VARCHAR(64),
  project_id  VARCHAR(64), agent_id VARCHAR(64), component_id VARCHAR(64),
  feature     VARCHAR(128), session_ref VARCHAR(128),  -- NULL 聚合桶由侧表控制;二维全展开
  emitter     VARCHAR(64), model VARCHAR(64),
  events      BIGINT NOT NULL,            -- 事件数
  qty_sum     DECIMAL(20,6), tokens_sum   BIGINT, cost_usd_sum DECIMAL(18,6)
) ENGINE=OLAP
  UNIQUE KEY (bucket_ts, cost_type, user_id, dept_id, role, project_id, agent_id,
              component_id, feature, session_ref, emitter, model)
  DISTRIBUTED BY HASH (bucket_ts, cost_type)
  PARTITION BY RANGE (bucket_ts) ...;     -- 建仓脚本生成月分区,过期分区 DROP(重算可得)
```

- **维度列全展开而非 JSON 列**:下钻查询必须走列式 predicate,JSON 列在 Doris 上退化成
  扫全量。NULL 归因仍展开列(NULL 由聚合端显式置于「未归因」桶,不静默)。
- **幂等键 = 维度组合 + REPLACE**:upsert 按 key replace——重放幂等(同 bucket 重算 N 次
  结果一致),与台账 event_key 幂等并列：**两级幂等**(明细行级 event_key、cube 桶级 replace)。
- **币种/单位**:`qty_sum` 按 cost_type 的单位(闭集已定义,unit 单一合法)之和;`cost_usd_sum`
  照加;两个 `SUM` 口径独立,出现混合单位 = 事件在源头就被拒(assertCostEvent)。
- **TZ**:日期桶按 UTC——账单周期口径是运维定义(计费边界在策略侧,`bucket_ts` 是存储层
  约定)。跨周期归属精度由事件时刻保证(§6.4 已修:outbox.ts→ledger.ts→本投影不变)。

## 3. 同步:从 PG 真相重建(不做第二真相)

```text
doris-sync(独立 Go/worker 随 usage-ledger 批次):
  1. 记录 watermark = usage_ledger.max(id) —— 存 PG 专门的 `usage_sync_watermark` 表
     (一行,synced_id;与预算树同库,单事务读水+写水不跨库——Doris 是投影,水域不用与它一致)
  2. SELECT * WHERE id > w ORDER BY id LIMIT batch(例 5000)
  3. 逐事件算 bucket(UTC 日)、按 (bucket, dims×, emitter, model) 聚合 → 组内 SUM
  4. Doris: 每 key 一行 REPLACE(stream load);失败 → 保持 watermark → 下轮重放(幂等)
  5. 完成后 watermark = max(id)
```

- **只从 PG 读,不经 RocketMQ 事件流重放**:事件流是给「一次性入账」用的,聚合若经流重放,
  流的顺序/去重语义就会变成真相——两个真相源又回来了。PG → Doris 单向投影,watermark
  唯一推进者。
- **延迟目标**:p95 ≤ 5 分钟(与 §21.1 的「事件可见性 ≤ 5s」不同维度:看板容忍分钟级);
  落后告警:watermark 龄 > 30m → P2,> 2h → P1(§21 扩容表微调)。
- **重建**:删分区、重置 watermark、全量重放——**置作为恢复手段存在**(Doris 无备份,
  只有重算,§22.4 已立)。月分区 DDL 在仓内脚本(建仓一次),重建只重放当前窗。

## 4. 消费侧(看板/下钻)契约

- 查询面 = 编排 seam(`usageAnalytics.dive(dims, from, to, unit?)`) → Doris;承诺:
  - 返回行按 `bucket_ts × 下钻维度` 排序稳定;
  - 时间窗按事件时刻(与账单周期判定口径一致);
  - **Doris 不可用 → 返回 `CapabilityUnavailable`(显式)**——看板显示「聚合暂不可用」,
    并给「回退 PG 明细」的按钮(PG 永远可查,慢就慢);不允许静默返回空集。
- 契约化:与其它 seam 一样,`assertUsageAnalyticsContract(dive, env)` 对真 Doris 跑;
  属性:排序稳定、时间窗语义、空集显式拒绝、重放幂等(同窗两次查询行数一致)。

## 5. 不做的事

- **不做「因果库」**:Doris 不承载记账、预算、审计;流水账只在 PG(§6.4 单一真相)。
- **不做逐人实时计数**:Doris 是批式 OLAP,5 分钟内预算告警走 Redis/PG 通道(限流/预算
  树已承担);看板不接实时。
- **不做跨集群聚合**:联邦场景(目录多群)聚合随 N6 数据驻留设计,不在本项。
- **不做单位换算**:`qty_sum` 用闭集单位自然数直接加(§6.4 单位合法唯一),费率/兑换属
  计费系统,不在此做。

## 6. 验收判据

1. 重放幂等:同窗聚合整体重放 N 次,各行 SUM 不变(桶级 REPLACE)
2. 事件时刻保真贯穿:23:59 UTC 事件入当窗(不因同步延时跨窗)
3. Doris 下线 → `dive` 返回 CapabilityUnavailable 而非空集(显式拒绝测试)
4. watermark 原子推进:同步中断(模拟崩溃)后重启,无重复累计(幂等)+ 无丢窗
5. 下钻排序稳定 + 归因列全展开可过滤(单列 filter 走 predicate,可由 explain 或测试断言)
6. 缺 Doris 的形态(Local-lite)明确标注能力缺失——不在本机模拟 OLAP(铁律 21)
7. 文档:§6.4 存储分工句 + README 计量行(聚合设计已出;实现待 Doris 进拓扑)

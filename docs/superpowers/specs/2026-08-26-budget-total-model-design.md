# 预算总额模型设计说明 —— PG 侧补齐「本期配额」，四态在执法点上可达

**评审条目**：B2 落地状态的显式偏离记账（`docs/design-review.md` §B2）
**规范章节**：`docs/architecture.md` §6.4
**前置**：`docs/superpowers/specs/2026-08-25-cost-attribution-design.md`（四态策略层）+ `platform/shared/seam-contracts/budget-policy.ts`

---

## 1. 问题：判定有策略层，执行点没有

上一项交付了 `budget-policy.ts` 的四态判定（`within/soft/overdraft/hard`），但 PG 执法点
（`PgMeteringSeam.reserve`）只能返回 `within/hard` 两态——`stateOfTree` 的注释已写明：
`budget_trees.budget` 存的是**剩余**（每 commit 扣减，可为负），没有总额就算不出「已用」，
软限额 / 透支额度也就无从计算。这是 B2 落地状态里记下的显式偏离：

> PG 无 total → 三态退化为二态（这偏离是记账的，不是要赖账的——本次把它收掉）

次生影响：四态在**契约里只在 stub 上被证明过**（`metering.contract.spec.ts` 的
「配置了透支额度时…」用例是独悬的 stub 用例，不出现在 `assertMeteringContract` 里）。
这与上个切片开头的元问题同形：stub 照契约写、PG 另外写，两边语义不一致而都「通过」。
上一项修掉了「契约只跑 stub」，四态语义却仍只跑 stub。

## 2. 模型：旧行两态、新行四态，一行即本期

`budget_trees` 加三个**可空**列，加列不背数据（与 trace_id/emitter 同哲学——历史行不用
假数据回填）：

| 列 | 语义 | 空 = | 非空 = |
|---|---|---|---|
| `budget`（既有） | **剩余**（每 commit 扣减，可为负） | ——（NOT NULL） | —— |
| `budget_total` | **本期配额总额** | 旧模式：只认剩余，行为与今天完全一致 | 本期配额模式：`used = total − remaining + need` |
| `soft_limit` | 软限额 | 缺省 = `budget_total` | 显式设置 |
| `overdraft` | 透支额度 | 缺省 0 | 显式设置。`budget_total` 非空时透支才存在 |

**一行即本期**：预算的周期语义由「运维在周期开始前重配」承担，表里只有当期一行。
周期列的归属在告警层（`BudgetAlert.period` 是入参，不是表字段）——加 `period` 列等于让
表成为周期真相源，而周期的边界从来是计费策略决定的，不该由台账表背书。

`reserve` 投影（与契约 `MeterResult.state` 定义一致）：`used = (total − remaining) + need`，
`need = estimate ?? 1`；`budgetState(used, { budget: total, softLimit: soft_limit ?? total,
overdraft: overdraft ?? 0 })`。左闭右开即已有纯策略语义：`used === total` 已是 hard——
「恰好用完预算必须已经越界」；旧模式边界保持不变（`remaining < need` 才 hard），
**两种模式的边界不同且都是注册在案的语义，混用由列是否为空显式区分**。

## 3. 两个操作，两个不变量

期初/重配与期中调整是两个不同的不变量，捏成一个 `setBudget` 两个语义都凑不齐。拆开：

- **`setBudget(kind, id, total, opts?)` —— 期初/重配**：`budget_total = total`、
  `remaining = total`（从头花），opts 给则更新 `soft_limit`/`overdraft`，不给则保留存储值
  （新行即 NULL 缺省）。
- **`adjustBudget(kind, id, newTotal, opts?)` —— 期中调整**：`Δ = newTotal − oldTotal`，
  `remaining += Δ`、`budget_total = newTotal`。由此 **`used = total − remaining` 在调整前后
  不变** —— 降额不追溯的机制保证：已发生的消费既不回收（used 不变），也不豁免（降额后
  下一次 `reserve` 立刻按新总额判态，`used ≥ total` 即 hard）。

校验在**写入时**做（fail closed，拒配置于配置处）：`total`/`softLimit`/`overdraft` 有限
非负、`softLimit ≤ total`。否则 `softLimit > budget` 会让「已超预算却显示预算内」（
budget-policy 的 normalize 已写过同样理由）——而 reserve 判态时 budgetState 会抛错，
**把配置错误延迟成线上 run 时错误**，比配置时拒绝坏得多。

旧模式行（`budget_total` NULL）调 `adjustBudget` → 拒绝并提示「先 `setBudget` 重配为
总额模式」——不搞隐式迁移：旧行是「只有剩余」的简化语义，把正数剩余当成总额的
adjust 结果是错的。

## 4. 装配层种子的语义冲突（发现 + 修复）

`index.ts:39` 每次插件启动都调 `setBudget(…, defaultBudget)`（默认 1e9），注释写
「幂等 upsert（仅当未显式配置 budget_trees 行时生效）」——**注释与实现不符**：现有
`setBudget` 是 `ON CONFLICT DO UPDATE` 无条件覆盖，即每次启动都把预算重置回 1e9。

旧语义下这无伤大雅（覆盖的「剩余」本来就是默认值）。新语义下 `setBudget` 是**期初重配
（remaining=total）**，启动即成重配点：运维设置的硬停/透支总额在每次重启后被冲回默认值
——「只有硬停时运维会把预算设成无穷大」的失效路径又多一条。修法：装配层改用
`seedDefaultBudget(kind, id, budget)` —— **仅当无行时插入**（`ON CONFLICT DO NOTHING`），
且插入**旧模式**行（`budget_total` NULL）：「默认不限额」的既有语义是「remaining 巨大，
判两态」，不是「总额 1e9 的四态」。

## 5. 契约扩展：四态与期中调整进入共享契约

`assertMeteringContract` 的 `resetBudgets(user, project)` 拓宽为
`(number | BudgetLimits) × (number | BudgetLimits)`：

- `number` → 只设余额（旧模式），既有场景 1–5 断言不变；
- `BudgetLimits` → `setBudget`（新模式：total=budget、remaining=total、限额入列）。

新增场景：

- **场景 6 四态投影**：soft → 放行、overdraft → 放行且状态升级、hard → 拒绝。原 stub
  独悬用例的姿态「四态只在 stub 上被证明过」进契约后就不是姿态了。
- **场景 7 期中调整**：降额到低于已用 → 立即 hard、不回收（断言 `balance` 精确值；
  若错误地把降额当重配，used 会被抹零，断言即红）；提额 → 剩余平移（`balance` 断言）。

## 6. 不做的事

- **不做 `period` 列**（§2：一行即本期）。
- **不做费率表 / 出账 / Doris 聚合 / 限流 / 历史回填**——与上个切片的 §7 相同。
- **不做分布式事务**：双树扣减仍以 PG 事务完成，RocketMQ 事务消息在 P2（铁律 5）。
- **不做旧模式自动迁移**：加列即可，旧行降级两态；升级 = 运维逐树 `setBudget` 重配。

## 7. 验收判据

| # | 判据 |
|---|---|
| 1 | 旧模式行（total NULL）行为与今天逐字节一致：仅 within/hard，`remaining == need` 仍放行 |
| 2 | 新模式行四态齐全，边界精确（`used == softLimit` → soft、`used == total` → overdraft、`used == total + overdraft` → hard） |
| 3 | `setBudget` 期初重配：remaining 重置为 total；opts 更新 / 保留存储限额 |
| 4 | `adjustBudget`：used 不变（总额平移）；降额低于已用 → 下一次 reserve 即 hard、balance 精确；旧模式行 / 无行 → 抛错并给出修复指引 |
| 5 | 配置写入时校验：负值 / NaN / `softLimit > total` 拒绝，错误信息可读 |
| 6 | 契约场景 6/7 对 stub 与真 PG 都通过（四态与期中调整不再是 stub 专属用例） |
| 7 | 装配层种子不再覆盖运维配置（seedDefaultBudget 仅无行时生效） |
| 8 | 加列幂等：`init()` 跑两次不报错；文档（§6.4 / B2 落地状态 / README 义务）同步 |

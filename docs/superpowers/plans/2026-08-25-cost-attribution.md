# 成本归因与预算策略 —— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-25-cost-attribution-design.md`
**评审条目**：B2【P1】（`docs/design-review.md` §B2）
**规范章节**：`docs/architecture.md` §6.4

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。本项主要动 `platform/`，但要读 dsh 的 `ctx.jobs` / `ctx.llm` 自述以确认接入点，收尾合规校验不可跳过。

**先修缺陷再加功能**（Task 1）。设计说明 §2 那个「余额冻结在正数上」的缺陷必须先修：在它之上加透支与软限额，等于在一个不会触发的封顶上加分级——三态里有两态永远到不了。

**契约测试必须能对真 PG 跑**（Task 2）。只跑 stub 是本项要修的元问题，不能在本项里重犯。无库时 skip，但 **skip 必须可见**。

**`cost_type` 是闭集**：未知取值拒绝入账，不记 `unknown`。

**默认行为不变**：透支额度默认 0，软限额默认等于预算 → 三态退化为今天的硬停。既有部署不该因为本项而改变行为。

**不做**：费率表、出账、Doris 聚合、限流、历史回填（设计说明 §7）。

测试命令：`cd platform && ./node_modules/.bin/vitest run <path>`（`pnpm` 不在 PATH）。
Typecheck：`cd platform && ./node_modules/.bin/tsc -b --noEmit`。

---

## Task 1: 修「余额冻结」缺陷（红 → 绿）

**Files:**
- Modify: `platform/shared/seam-contracts/metering.ts`
- Modify: `platform/dsh-plugins/metering/src/pg-meter.ts`
- Modify: `platform/shared/seam-contracts/__tests__/metering.contract.spec.ts`

- [x] **Step 1: 先写测试（红）**

在契约里加三条断言，**对着 stub 也要成立**（这样 stub 与 PG 被同一把尺子量）：

1. 余额 500、`commit` 600 → 余额为 **−100**，不是 500。
2. 透支后 `reserve` 判 `hard`（透支额度默认 0）。
3. `reserve` 收 `estimate` 时判「够不够这一次」：余额 1、`estimate` 100 → 拒。

`MemoryMeteringSeam` 的 `reserve` 当前只判 `<= 0`，加 estimate 后要判 `budget < estimate`。

- [x] **Step 2: 契约加 estimate（绿）**

`MeterContext` 不动（它是归因维度，不该混进量）。改 `reserve` 签名：

```ts
reserve(context: MeterContext, estimate?: number): Promise<MeterResult>
```

`estimate` 可选：缺省时按「余额 > 0」判（保持现有调用方不变），给了就按「余额 ≥ estimate」判。**可选而非必填**是因为 `llm/stream` 在首 token 前拿不到准确预估，硬要求会逼出一个假数字。

- [x] **Step 3: 改 PG 实现（绿）**

`commit` 的 `UPDATE` 去掉 `AND budget >= $2` —— 无条件扣减，允许负数。
`reserve` 增加 estimate 判定。

**注意**：`budget_trees.budget` 是 `BIGINT`，允许负数无需改类型。但 `balance()` 在无记录时返回 `+Infinity`（fail open），这与「未定级即拒绝」的精神相反——本 Task 不改它（改了会让未预置预算的既有部署全部停摆），但要在注释里写明这是显式选择的 fail-open 及其理由，并列入 Self-Review。

- [x] **Step 4: 跑测试**

```bash
cd platform && ./node_modules/.bin/vitest run shared/seam-contracts/__tests__/metering.contract.spec.ts
```

- [x] **Step 5: 提交**

```
fix(metering): 预算扣减不再在超限时静默跳过——封顶恰在最该生效时失效
```

---

## Task 2: 契约对真 PG 跑（红 → 绿）

**Files:**
- Create: `platform/dsh-plugins/metering/__tests__/pg-contract.spec.ts`

- [x] **Step 1: 先写测试（红）**

对着 `PgMeteringSeam` 跑 `assertMeteringContract`，连接串取 `METERING_TEST_DSN`（或复用 registry 集成测试已有的环境变量约定，先读 registry 的 Go 集成测试怎么取的，TS 侧保持同名）。

**skip 必须可见**：无 DSN 时用 `it.skip` 并在标题里写明原因，不得静默 `return`——静默 return 会让测试报告显示「通过」，那正是本项要修的元问题。

- [x] **Step 2: 建表与清理（绿）**

每个用例前 `TRUNCATE usage_ledger, budget_trees`。**不要 DROP**：DROP 会让并行跑的其它测试拿到不存在的表。

- [x] **Step 3: 跑测试**

有库：`METERING_TEST_DSN=... ./node_modules/.bin/vitest run dsh-plugins/metering`
无库：确认输出里 skip 可见。

- [x] **Step 4: 提交**

```
test(metering): 契约对真 PG 跑——只跑 stub 等于没跑
```

---

## Task 3: `cost_type` 闭集 + 新维度（红 → 绿）

**Files:**
- Create: `platform/shared/seam-contracts/cost-events.ts`
- Create: `platform/shared/seam-contracts/__tests__/cost-events.spec.ts`
- Modify: `platform/dsh-plugins/metering/src/pg-meter.ts`（DDL + insert）

- [x] **Step 1: 先写测试（红）**

`cost-events.spec.ts`：

- 六个合法 `cost_type` 逐一被接受
- 未知取值被拒，**错误信息列出合法取值**（读得到取值才省得翻代码）
- 每个类型的 `unit` 是它该有的那个（`llm.tokens`→tokens、`connector.call`→call、`seam.query`→rows、`job.compute`→second、`storage.bytes`→byte-day、`inference.gpu`→second）
- `qty` 必须为有限非负数；负数/NaN/Infinity 被拒（负成本是记账错误，不是退款）
- `traceId` / `emitter` 非空

- [x] **Step 2: 实现（绿）**

```ts
export const COST_TYPES = {
  'llm.tokens':     { unit: 'tokens' },
  'connector.call': { unit: 'call' },
  'seam.query':     { unit: 'rows' },
  'job.compute':    { unit: 'second' },
  'storage.bytes':  { unit: 'byte-day' },
  'inference.gpu':  { unit: 'second' },
} as const
export type CostType = keyof typeof COST_TYPES
export interface CostEvent {
  context: MeterContext
  costType: CostType
  qty: number
  unit: string
  traceId: string
  emitter: string
  costUsd: number
  /** 仅 llm.tokens 有意义；保留以不破坏现有查询 */
  tokens?: number
  model?: string
}
export function assertCostEvent(e: CostEvent): void
export function unitFor(t: string): string   // 未知即抛
```

`unit` 既在表里又能从 `costType` 推出 —— 冗余是刻意的：入库的行要能独立解读，不必回查代码里的映射表。但 `assertCostEvent` 必须校验两者一致，否则冗余就变成了第二个真相源。

- [x] **Step 3: DDL 加列（绿）**

`usage_ledger` 加 `trace_id TEXT`、`emitter TEXT`、`qty NUMERIC(20,6)`、`unit TEXT`。

**用 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`**，不改 `CREATE TABLE IF NOT EXISTS` 就完事——既有库已经建过表，只改 CREATE 对它无效，而这正是「本地测试全绿、部署后列不存在」的经典来源。新列可空（历史行不回填假数据，设计说明 §7）。

加索引：`(trace_id)` —— 判据 6 要按 trace 取回因果链，无索引会随台账增长退化成全表扫。

- [x] **Step 4: 跑测试并提交**

```
feat(metering): cost_type 闭集与 trace 维度——自由文本列撑不起「解释一次尖峰」
```

---

## Task 4: 单一写入者 CostEventSink（红 → 绿）

**Files:**
- Modify: `platform/shared/seam-contracts/metering.ts`（加 sink 接口）
- Modify: `platform/dsh-plugins/metering/src/pg-meter.ts`（实现）
- Create: `platform/dsh-plugins/metering/__tests__/sink.spec.ts`

- [x] **Step 1: 先写测试（红）**

- 六类事件各落一行，字段完整
- 同 `traceId` 的多行可按 trace 取回，且顺序稳定（按 ts, id）
- `llm.tokens` 事件仍写 `tokens` 列（现有查询不破）
- 非 `llm.tokens` 事件的 `tokens` 列为 0/NULL，`qty`/`unit` 承载量
- 未知 `cost_type` 在 sink 层就被拒，**不落任何行**（不能先写再校验）

- [x] **Step 2: 实现（绿）**

```ts
export interface CostEventSink {
  emit(event: CostEvent): Promise<void>
  byTrace(traceId: string): Promise<CostEvent[]>
}
```

`PgMeteringSeam` 实现它。**`usage_ledger` 的写入集中到一个私有方法**，`commit()` 与 `emit()` 都走它——两条写路径各写一遍 INSERT 就是 schema 的第二份副本。

- [x] **Step 3: 跑测试并提交**

```
feat(metering): 成本事件单一写入者——发出方跨语言，schema 不能有第二份
```

---

## Task 5: 预算三态（红 → 绿）

**Files:**
- Create: `platform/shared/seam-contracts/budget-policy.ts`
- Create: `platform/shared/seam-contracts/__tests__/budget-policy.spec.ts`
- Modify: `platform/dsh-plugins/metering/src/pg-meter.ts`

- [x] **Step 1: 先写测试（红）**

被测对象是纯函数 + 一个去重器：

```ts
export type BudgetState = 'within' | 'soft' | 'overdraft' | 'hard'
export interface BudgetLimits {
  budget: number
  /** 缺省 = budget（三态退化为硬停，行为与今天一致） */
  softLimit?: number
  /** 缺省 0（默认不允许透支） */
  overdraft?: number
}
export function budgetState(used: number, limits: BudgetLimits): BudgetState
export function worseOf(a: BudgetState, b: BudgetState): BudgetState
```

断言：
- 四态边界逐个（含 `used == softLimit`、`used == budget`、`used == budget + overdraft` 三个恰好相等的点 —— 边界差一是这类函数唯一的真实缺陷来源）
- 缺省 limits（无 softLimit、overdraft=0）时只出现 `within` / `hard`
- `worseOf` 取更严者，且满足交换律
- 降额不追溯：`budget` 从 1000 降到 100 而 `used=500` → 状态 `hard`，但**不产生任何回收动作**（断言 `used` 不变）
- 预警去重：同 (周期, 树, 状态) 只回调一次；换周期或状态升级则再发一次（升级要发——`soft`→`overdraft` 是新信息）

- [x] **Step 2: 实现（绿）**

去重器复用闸 C 的形状（`TurnCallBudget` 的 warned 集合 + 有界淘汰）。**同一个坑要防两次**：周期键只增不减，去重集合必须有界。

- [x] **Step 3: 接进 reserve（绿）**

`reserve` 返回值加 `state: BudgetState`，`hard` 才拒。`reason` 保留现有取值以不破坏调用方，新增 `denied-hard-limit`。

- [x] **Step 4: 跑测试并提交**

```
feat(metering): 预算三态与透支——只有硬停时运维会把预算设成无穷大
```

---

## Task 6: 文档同步

**Files:**
- Modify: `docs/architecture.md` §6.4
- Modify: `docs/design-review.md`（B2 落地状态 + 汇总表行）
- Modify: `docs/README.md`（已定案表加一行；**待拍板 #3 不动**）

- [x] **Step 1: §6.4 改写**

保留「所有 token 消耗只在 `ctx.llm` 这一道截面」——**这句是对的，B2 也明确要求保留**。在它后面加一句限定：那是 **token** 截面，不是成本模型的全部；并加 `cost_type` 闭集表、三态表、单一写入者约束、已知未计量清单。

- [x] **Step 2: B2 落地状态**

格式同 T1/R1。要点：闭集而非自由文本的理由、三态里「软限额缺失导致功能被绕过」这条因果、预算扣减缺陷的发现与修复、契约只跑 stub 的元问题、`fs`-式的显式偏离记账（RocketMQ 未进拓扑）。

- [x] **Step 3: 汇总表 B2 行**

- [x] **Step 4: README 已定案加一行，并确认待拍板 #3 仍在**

设计说明 §9 说明本项在既成事实上继续但不构成拍板。README 的待拍板 #3 **不能删** —— 删了就等于偷偷拍板。

- [x] **Step 5: 校验 + 提交**

```bash
file docs/architecture.md docs/design-review.md docs/README.md
for f in docs/architecture.md docs/design-review.md docs/README.md; do tr -dc '\000' < "$f" | wc -c; done   # 必须都是 0
git diff --stat docs/
```

```
docs(metering): §6.4 成本类型闭集与预算三态、评审 B2 落地状态
```

---

## 收尾：第一铁律合规校验（不可跳过）

- [x] **Step 1**

```bash
git -C deepseek-harness describe --tags --dirty   # 必须 dsh-v0.1.1-rc.2，无 -dirty
git -C deepseek-harness status --porcelain -uno   # 必须无输出
```

- [x] **Step 2: 全量测试 + typecheck**

```bash
cd platform && ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc -b --noEmit
```

- [x] **Step 3: 对照 9 条验收判据**（设计说明 §10），逐条指到具体用例名

---

## Self-Review

**设计说明覆盖检查**：

| 设计说明章节 | 落在哪 |
|---|---|
| §2 预算扣减缺陷 | Task 1 |
| §3 cost_type 闭集 | Task 3 |
| §4 单一写入者 | Task 4 |
| §5 预算三态 | Task 5 |
| §6 归因链新维度 | Task 3（DDL）+ Task 4（sink） |
| §7 不做的事 | 全程；Task 6 写进文档 |
| §9 待决事项 | Task 6 Step 4（README #3 不动） |
| §10 验收判据 | 收尾 Step 3 |

**待评审的取舍**：

1. **`reserve` 的 `estimate` 是可选而非必填**（Task 1）。必填更严，但 `llm/stream` 在首 token 前拿不到准确预估，硬要求会逼出一个假数字，而假预估比没预估更坏——它看起来像个判据。代价：不传 estimate 的调用方仍然只判「余额 > 0」，剩 1 token 也能发起大调用。**这是本计划最可能被推翻的一处。**
2. **`balance()` 在无预算记录时返回 `+Infinity`（fail open）**（Task 1 Step 3）。与 R1 的「未定级即拒绝」精神相反。本项不改，因为改了会让所有未预置 `budget_trees` 行的部署立刻停摆——那是一次生产事故而不是一次修复。正确做法是先加「预算记录缺失」的告警，观察到零告警后再翻成 fail closed。**这条必须进落地状态，否则它会被当成已解决。**
3. **`unit` 既入库又可从 `costType` 推出**（Task 3）。冗余刻意保留（入库行要能独立解读），但必须有一致性校验，否则它就是第二个真相源。

**已知不足**：
- 成本事件本期同步直写 PG，会给写路径加一次 IO。§6.4 的 RocketMQ 异步削峰是目标形态，RocketMQ 未进拓扑前无法落地——与 T1 的 Nacos 偏离同因，需一并记账。
- `cost_usd` 由 Provider 自报，无费率表校验。一个报错单位的 Provider 能污染账单，本项不设防（费率管理明确不做，§7）。
- 判据 3 的真 PG 契约测试在 CI 无库时会 skip。skip 可见但仍是 skip——**真正的门槛是把 PG 放进 CI**，与 T3 的运维准入条件同批。

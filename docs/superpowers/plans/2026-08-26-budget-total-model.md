# 预算总额模型 —— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-26-budget-total-model-design.md`
**评审条目**：B2 落地状态的显式偏离记账（`docs/design-review.md` §B2）
**规范章节**：`docs/architecture.md` §6.4

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。本项只动 `platform/` 与 `docs/`，收尾合规校验不可跳过。

**两种模式、两种边界**：`budget_trees.budget_total` 为 NULL = 旧模式（仅 within/hard，
`remaining < need` 才 hard，既有行为不变）；非空 = 本期配额模式（四态、左闭右开，
`used = total − remaining + need`）。**两种模式的边界不同且都是注册在案的语义**——这是
「默认行为不变」与「四态功能」之间的分界线，用列空值显式区分，不得互相渗透。

**契约是两实现的同一把尺子**：四态与期中调整必须进 `assertMeteringContract`（场景 6/7），
不能学上个切片「四态只在 stub 上被证明」——那与「契约只跑 stub」是同一个元问题。

**写入时校验（fail closed at config）**：配置错误在 `setBudget`/`adjustBudget` 处拒绝，
不让它延迟成 `reserve` run 时的抛错。

测试命令：`cd platform && ./node_modules/.bin/vitest run <path>`；typecheck `./node_modules/.bin/tsc -b --noEmit`。
真 PG 用例：`METERING_TEST_DSN=postgres://lumo:lumo@127.0.0.1:55432/lumo ./node_modules/.bin/vitest run dsh-plugins/metering`。

---

## Task 1: 策略层抽出 limits 校验——不再写第三份 (红 → 绿)

**Files:**
- Modify: `platform/shared/seam-contracts/budget-policy.ts`
- Modify: `platform/shared/seam-contracts/__tests__/budget-policy.spec.ts`

- [x] **Step 1: 先写测试（红）**

`budget-policy.spec.ts` 加一组用例（纯函数）：

- `resolveLimits(1000)` → `{ budget: 1000, softLimit: 1000, overdraft: 0 }`
- `resolveLimits(1000, { softLimit: 800, overdraft: 200 })` 透传
- `softLimit > budget` 抛错；负数 / NaN / Infinity 抛错（`budget`/`softLimit`/`overdraft` 三路）
- `budgetState` 经 `resolveLimits` 之后行为不变：既有 22 例全绿（重构守护网）

- [x] **Step 2: 实现（绿）**

`budget-policy.ts` 抽出并导出：

```ts
export function resolveLimits(budget: number, opts?: BudgetLimits): Required<BudgetLimits>
```

`budgetState` 内部改调 `resolveLimits`（错误文案保持一字不差，既有断言依赖它们）。

- [x] **Step 3: 跑测试并提交**

```
refactor(budget-policy): limits 校验抽为 resolveLimits——判态与配置写入共用同一份
```

---

## Task 2: 契约进四态与期中调整（红 → 绿）

**Files:**
- Modify: `platform/shared/seam-contracts/metering.ts`
- Modify: `platform/shared/seam-contracts/__tests__/metering.contract.spec.ts`

- [x] **Step 1: 先写测试（红）**

`assertMeteringContract` 拓宽 `resetBudgets` 签名为
`(user: number | BudgetLimits, project: number | BudgetLimits) => Promise<void>`；
新增场景 6（四态投影）与场景 7（降额立刻 hard、不追溯；提额平移）：

```ts
// 场景6（stub 侧现状就该过；PG 侧会是红的——PG 没有总额模型，这就是本 Task 的红）
await resetBudgets({ budget: 1000, softLimit: 800, overdraft: 200 }, 10_000)
// commit 900 → used=900 → soft 放行；+200 → used=1100 → overdraft 放行；+200 → used=1300 → hard 拒
// 场景7
await resetBudgets({ budget: 1000 }, 10_000)
// commit 900 → within；adjustBudget('user','u1',500) → balance === -400 且被拒于 hard（used=900 不变）
// adjustBudget('user','u1',2000) → balance === 1100（提额平移）且放行
```

场景 6/7 断言结构：`check()` 的 `approved === (state !== 'hard')` + 具体 state 值 + 精确
`balance`。

- [x] **Step 2: 实现接口与 stub（绿）**

`MeteringSeam` 增：

```ts
setBudget(kind: 'user' | 'project', id: string, total: number,
          opts?: { softLimit?: number; overdraft?: number }): Promise<void>
adjustBudget(kind: 'user' | 'project', id: string, newTotal: number,
             opts?: { softLimit?: number; overdraft?: number }): Promise<void>
```

`MemoryMeteringSeam` 实现：`setBudget` → remaining = total、limits 更新；`adjustBudget` →
remaining += (newTotal − oldTotal)、limits.budget 更新（soft/overdraft 保留，opts 给则替换）、
未配置额度的树抛错；两方法都对 `softLimit > total` 抛错（与 PG 同一失败面）。

`resetBudgets` 返回数字时走旧路径（stub 直接设 remaining、清 limits——旧模式）。

- [x] **Step 3: 跑测试并提交**

```
feat(metering): 四态与期中调整进共享契约——stub 与 PG 被同一把尺子量（场景6/7）
```

---

## Task 3: PG 总额模型（红 → 绿）

**Files:**
- Modify: `platform/dsh-plugins/metering/src/pg-meter.ts`
- Create: `platform/dsh-plugins/metering/__tests__/pg-budget.spec.ts`

- [x] **Step 1: 先写测试（红）**

`pg-budget.spec.ts`（own schema `metering_budget_test`，skip 可见）：

- **旧模式不变**：`INSERT budget_trees(kind,id,budget)` 直塞行（total NULL）→ reserve 只
  可能 within/hard；`remaining == need` 放行（旧边界，与新模式相反——防渗透）
- **新模式四态**：`setBudget(1000,{softLimit:800,overdraft:200})` + 精确 commit/reserve 组合
  命中 `used == softLimit`→soft、`used == total`→overdraft、`used == total+overdraft`→hard
- **setBudget 期初重配**：commit 后用 `setBudget` 重置 → remaining == total；opts 更新限额、
  不给 opts 保留存储值
- **adjustBudget**：提额 → balance 平移（used 不变）；降额到低于已用 → 立即 hard 且
  balance 精确值（不回收）；旧模式行 → 抛错含「setBudget」字样；无行 → 抛错
- **写入校验**：`softLimit > total`、负数、NaN → 抛错
- **DDL**：`init()` 后 `budget_total/soft_limit/overdraft` 列存在（`LIMIT 0` 查不报错）；
  `init()` 两次幂等

- [x] **Step 2: 实现（绿）**

`pg-meter.ts`：

- `METERING_DDL` 的 `budget_trees` CREATE 加三列；`METERING_MIGRATIONS` 加三条
  `ADD COLUMN IF NOT EXISTS`（既有库必须走 ALTER，同上个切片教训）
- `BudgetTreeRow` 加 `budget_total/soft_limit/overdraft`
- `stateOfTree`：total NULL → 旧两态；否则 `budgetState((total − remaining) + need, limits)`
- `reserve` 的 SELECT 扩为 `budget, budget_total, soft_limit, overdraft`
- `setBudget` 改期初语义（remaining=total、写 total/limits、写入时校验）；新增
  `adjustBudget`（FOR UPDATE 读旧行、Δ 平移、旧模式/无行抛错、写入校验）；新增
  `seedDefaultBudget`（`ON CONFLICT DO NOTHING`，直插旧模式行，不改 total 列）
- 复用 `resolveLimits` 做校验（不写第三份）

- [x] **Step 3: pg-contract.spec.ts 接上（绿）**

`resetBudgets` 助手：number → 旧模式直插：`INSERT INTO budget_trees (kind,id,budget)
VALUES … ON CONFLICT (kind,id) DO UPDATE SET budget = EXCLUDED.budget`（**不能用
setBudget** —— 它会把行变成新模式、左闭边界）；`BudgetLimits` → `seam.setBudget(…)`。

- [x] **Step 4: 跑测试并提交**

```
feat(metering): PG 总额模型——旧行两态不变，新行四态可达（B2 偏离收账）
```

---

## Task 4: 装配层种子不再覆盖运维配置（红 → 绿）

**Files:**
- Modify: `platform/dsh-plugins/metering/src/index.ts`
- Modify: `platform/dsh-plugins/metering/__tests__/pg-budget.spec.ts`

- [x] **Step 1: 先写测试（红）**

pg-budget.spec.ts 加：已有新模式行（setBudget 配置过）→ `seedDefaultBudget(1e9)` **不动它**
（total/remaining 原样）；无行 → 插入旧模式行（total NULL、remaining=defaultBudget）。

- [x] **Step 2: 实现（绿）**

`index.ts` 的 `setBudget(…, defaultBudget)` 改 `seedDefaultBudget(…, defaultBudget)`；
注释「仅当未显式配置时生效」与实现终于对齐。

- [x] **Step 3: 跑测试并提交**

```
fix(metering): 装配层默认预算只做种子——不再把运维配置冲回 1e9（注释与实现不符）
```

---

## Task 5: 文档同步

**Files:**
- Modify: `docs/architecture.md` §6.4
- Modify: `docs/design-review.md`（B2 落地状态）
- Modify: `docs/README.md`（已定案 metering 行：总额模型划钩，RocketMQ/Doris 留待补）

- [x] **Step 1: §6.4**：预算状态表加一句：总额模型落地情况（PG 已按 total+remaining 实现；
  旧行 total NULL 两态；装配层种子语义）。
- [x] **Step 2: B2 落地状态**：原「PG 无 total → 三态退化二态」偏离 → 已收账，改锁
  seedDefaultBudget 修复与「配置写入即校验」；剩余偏离（RocketMQ 进程内、fail-open
  balance、CI 无 PG skip、Doris）不动。
- [x] **Step 3: README**：已定案 metering 行待补三者划掉「PG 侧本期配额总额模型」。
- [x] **Step 4: 校验 + 提交**

```
docs(metering): 总额模型落地状态——B2 偏离收账，PG 四态在执法点可达
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

- [x] **Step 3: 对照设计说明 §7 的 8 条验收判据**逐条指到具体用例名

---

## Self-Review

**设计说明覆盖检查**：

| 设计说明章节 | 落在哪 |
|---|---|
| §2 模型（旧行/新行/单行即本期） | Task 1（resolveLimits）+ Task 3（DDL/stateOfTree） |
| §3 两个操作两个不变量 | Task 3（setBudget/adjustBudget）+ Task 2（契约场景 7） |
| §4 装配层种子冲突 | Task 4 |
| §5 契约扩展 | Task 2 + Task 3 Step 3 |
| §6 不做的事 | 全程；Task 5 写进文档 |

**待评审的取舍**：

1. **`setBudget` 语义从「设剩余」改为「期初重配（remaining=total）」**——`setBudget` 的
   既有调用方只有测试助手与装配层种子，均已在计划内显式处理（seedDefaultBudget 接管
   装配层）。若未来有未预料的调用方假设旧语义，会表现为「启动后预算被重置」——这恰好
   是语义变化本身。
2. **旧模式与新模式边界不同且并存**（`remaining == need` 在旧模式放行、新模式 hard）。
   两种边界都有独立理由（默认行为不变 vs 左闭是既定案策略），但「混用」可能被后来者
   当成 bug。已在文档两处明说，属显式设计。
3. **`adjustBudget` 放进共享接口**——它是**运维**语义不是**调用方**语义，进接口意味着
   每个实现都要保证「used 不变」这个不变量，值得；不进接口则契约场景 7 无从成立。
4. **种子行是旧模式**（total NULL）——「默认不限额」的既有语义是「大的剩余」，不是
   「总额 1e9 的四态」；若种子进四态，左闭边界会让默认部署的边界语义悄悄改变。

**已知不足**：
- `budget_total` 更新仍只用「当期一行」——跨周期的结转不存在（无 period 列），
  周期开始是运维动作。
- 双树扣减仍是本地 PG 事务；RocketMQ 事务消息在 P2（铁律 5）。
- 契约四态场景在 CI 无 PG 时仍 skip（skip 可见）——真正门槛仍是 PG 进 CI，与 T3 同批。

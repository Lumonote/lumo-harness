# 计量事件异步削峰 —— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-26-metering-outbox-design.md`
**评审条目**：B2 落地状态的显式偏离①（RocketMQ `usage.event.*` 异步削峰待 RocketMQ 进拓扑）
**规范章节**：`docs/architecture.md` §6.4（异步削峰）/ §13.2（Local-lite 等价：PG 事务 outbox + 进程内调度器）
**仓库先例**：`platform/dsh-plugins/knowledge/src/graph-projector.ts`（同形状，照它做）

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。本项只动 `platform/` 与 `docs/`，收尾合规校验不可跳过。

**本地交付本地等价形态**：§6.4 承诺「RocketMQ `usage.event.*` 异步削峰」；§13.2 明文
Local-lite 等价 = **PG 事务 outbox + 进程内调度器**（PG 事务天然提供「扣配额+发任务」
原子性）。RocketMQ 未进拓扑，B2 偏离①**保持记账**——本切片不得冒充 RocketMQ 已落地，
文档措辞必须是「本地等价已落地 / RocketMQ 传输仍待拓扑」。

**四个跨传输不变式是尺子**：①一次事件一账（event_key 唯一 + ON CONFLICT DO NOTHING）；
②事件时刻保真（ledger.ts = outbox.ts，非 now()）；③顺序稳定（按 seq 搬运，(ts,id) 语义
不变）；④原子配套（预算树扣减与写 outbox 同事务）。①②③ 有可证明的测试；④是结构
不变量（同事务语句序列，读者凭代码可验），计划注明不可模拟断言。

**写穿即见 → 有界最终一致是显式语义变化**：`emit`/`commit` 返回时行在 outbox，
可见 ≤ drain 周期（缺省 1000ms）+ 批投递时间。`reserve`/`balance`/预算树**不搬**，
契约（`assertMeteringContract`）一字不改。既有 sink 断言「写后即读台账」改为「drain
后读台账」——是断言迁移，不是改语义假装没变。

测试命令：`cd platform && ./node_modules/.bin/vitest run <path>`；typecheck `./node_modules/.bin/tsc -b --noEmit`。
真 PG 用例：`METERING_TEST_DSN=postgres://lumo:lumo@127.0.0.1:55432/lumo ./node_modules/.bin/vitest run dsh-plugins/metering`。
基线（切片前）：3 文件 20 用例全绿。

---

## Task 1: DDL + 事件先入 outbox（红 → 绿）

**Files:**
- Modify: `platform/dsh-plugins/metering/src/pg-meter.ts`
- Create: `platform/dsh-plugins/metering/__tests__/outbox.spec.ts`

- [x] **Step 1: 先写测试（红）**

`outbox.spec.ts`（own schema `metering_outbox_test`，skip 可见；`withSeam` 后 TRUNCATE
`usage_ledger, budget_trees, usage_event_outbox`）：

```ts
// 判据 1 + 7 的写入口形态：
it('commit/emit 不再直写台账——事件先入 outbox')
  → setBudget ×2 + commit(...) → ledger 0 行、outbox 恰 1 行且 payload 内 costType='llm.tokens'
  → emit(...) → ledger 仍 0 行、outbox 2 行
it('坏事件既不入台账也不入 outbox——outbox 不是绕过校验的通道')
  → emit({...costType:'made.up'}) rejects → outbox 0 行 + ledger 0 行
```

- [x] **Step 2: 实现（绿）**

`pg-meter.ts`：

- `METERING_DDL` 加 `usage_event_outbox` 新建表（`seq` PK / `event_key` UNIQUE /
  `payload` JSONB / `ts DEFAULT now()` / `projected_at` + 部分索引 `WHERE projected_at IS NULL`）；
  `METERING_MIGRATIONS` 加 `ALTER TABLE usage_ledger ADD COLUMN IF NOT EXISTS event_key TEXT`
  + `CREATE UNIQUE INDEX IF NOT EXISTS usage_ledger_event_key_idx ON usage_ledger (event_key)`。
- `commit`：树扣减 + `INSERT INTO usage_event_outbox (event_key, payload) VALUES (gen_random_uuid(), $1)`
  ——**同一事务**（幂等键 PG 内置生成，见设计说明 §3）。
- `emit`：`assertCostEvent`（既有）+ 单句 INSERT outbox。
- 两路径的事件先 `assertCostEvent`（ledger 直写旧代码以注释保留于 `batchInsertLedger` 内）。

- [x] **Step 3: 跑测试并提交**

```
feat(metering): 事件先入 usage_event_outbox——扣减与事件同事务，台账从请求路径拿掉
```

> 预期：本 Task 新用例绿；`sink.spec.ts` 既有直写断言转红——这是语义迁移的中间态，
> Task 4 收。Task 2/3 未接前不提交 sink 适配。

---

## Task 2: drainOnce —— 批量 + 幂等 + 事件时刻（红 → 绿）

**Files:**
- Modify: `platform/dsh-plugins/metering/src/pg-meter.ts`
- Modify: `platform/dsh-plugins/metering/__tests__/outbox.spec.ts`

- [x] **Step 1: 先写测试（红）**

`outbox.spec.ts` 加（`drainOnce` 尚不存在 → 红）：

```ts
it('drain 后台账行数 = 事件数；空批 drainOnce 返回 0')
  → 空 outbox：drainOnce() === 0
  → emit ×3 → drainOnce() === 3 → ledger 3 行、outbox 仍 3 行（已投影行不回收）
it('批量上限生效')
  → emit ×5 → drainOnce(2) === 2 → ledger 2 行；（再 drain 清尾）drainOnce(10) === 3
it('事件时刻保真——ledger.ts = outbox.ts，非投影时刻')
  → emit → raw UPDATE outbox SET ts = '2026-01-01 00:00:00+00' WHERE seq = …
  → drainOnce → ledger.ts === '2026-01-01 00:00:00+00'（TEXT 比较）
it('顺序稳定（同 ts 由 event_key… 由 seq tiebreak）')
  → emit A、B → 两行 outbox.ts 手动置为同一时刻 → drainOnce
  → byTrace 顺序 = [A, B]（插入序 == seq 序；(ts,id) 以 id 破平）
it('重放幂等——projected_at 置回 NULL 再 drain，台账行数不变')
  → emit ×2 → drainOnce → 2 行 → raw UPDATE outbox SET projected_at = NULL → drainOnce → 仍 2 行
```

- [x] **Step 2: 实现（绿）**

`pg-meter.ts`：

- `drainOnce(batchSize = 100)`：`running` 重入保护 → `BEGIN` →
  `SELECT seq, ts, event_key, payload FROM usage_event_outbox WHERE projected_at IS NULL
   ORDER BY seq LIMIT $1 FOR UPDATE SKIP LOCKED` → 无行 `COMMIT` 返 0 →
  逐行 `assertCostEvent(JSON.parse(payload))`（防手工编辑，毒丸整批回滚见设计说明 §6）→
  `batchInsertLedger(client, rows)`（多行单语句 INSERT，显式 `ts = outbox.ts`、
  `event_key` 带出、`ON CONFLICT (event_key) DO NOTHING`）→
  `UPDATE ... SET projected_at = now() WHERE seq = ANY($1)` → `COMMIT` → 返回条数。
- `insertLedger` 改 `batchInsertLedger`（唯一写入者——schema 只在一条 SQL 里）。

- [x] **Step 3: 跑测试并提交**

```
feat(metering): drainOnce 批量入账——event_key 幂等、事件时刻保真、seq 序稳定
```

---

## Task 3: 搬运输不变式进共享契约（红 → 绿)

**Files:**
- Modify: `platform/shared/seam-contracts/metering.ts`
- Modify: `platform/dsh-plugins/metering/__tests__/outbox.spec.ts`（改跑共享契约）

- [x] **Step 1: 先写测试（红）**

`metering.ts` 增（先写断言场景，未实现 → 编译错/红）：

```ts
/** 台账管线不变式的共享尺子：任何「事件 → 台账」搬运器（本地 drain / 未来 RocketMQ
 *  消费侧）都跑同一套——防止「幂等只在 PG 直写下偶然成立」复刻「四态只在 stub」。 */
export interface DrainEnv {
  sink: CostEventSink
  drainOnce(): Promise<number>
  ledgerRows(): Promise<number>
  redeliverAll(): Promise<void>   // 模拟至少一次投递（本地实现：projected_at 置回 NULL）
}
export async function assertCostEventDrainContract(env: DrainEnv, assert: (c: boolean, m: string) => void): Promise<void>
// D1 事件先入管线：emit → ledgerRows() === 0（写穿即见已不是语义）→ drainOnce ≥ 事件数 → ledgerRows() === 事件数
// D2 重放幂等：redeliverAll() → drainOnce → ledgerRows() 不变
```

`outbox.spec.ts` 的「重放幂等」与「drain 后行数」用例改为调用共享契约（真 PG）。

- [x] **Step 2: 实现（绿）**

按上面接口实现 `assertCostEventDrainContract`（纯编排，不含存储知识）；
`outbox.spec.ts` 通过 `withSeam` 装配 `DrainEnv` 跑它。

> 取舍：D1 的「drain 前 ledger 0 行」要求测试环境无后台轮询——契约只在测试内
> 装配（无 interval），成立。

- [x] **Step 3: 跑测试并提交**

```
feat(metering): 搬运输不变式进共享契约——D1/D2 对第二个实现就位尺子
```

---

## Task 4: sink.spec 适配 + 进程内调度器（红 → 绿）

**Files:**
- Modify: `platform/dsh-plugins/metering/__tests__/sink.spec.ts`（TRUNCATE 加
  `usage_event_outbox`；各处「写后即读」改为「`await seam.drainOnce()` 后读」——
  直写模拟用例改断言 outbox 0 行）
- Modify: `platform/dsh-plugins/metering/__tests__/pg-budget.spec.ts` / `pg-contract.spec.ts`
  （TRUNCATE 三表）
- Modify: `platform/dsh-plugins/metering/src/index.ts`（`drainIntervalMs`/`drainBatchSize`
  进 `MeteringConfig`；`init` 后起轮询 `setInterval`，`unref`，失败 `ctx.logger.warn`
  不抛——知识库 `index.ts` 同款；`ctx.effect` 清理）
- Modify: `platform/dsh-plugins/metering/__tests__/pg-budget.spec.ts`（加一条：
  `seedDefaultBudget` 与 outbox 无关的防回归——若未来有人把种子改回走 commit/emit
  会污染 outbox 断言；或不必——注释说明即可）

- [x] **Step 1: 断言迁移（红 → 绿）**

sink.spec 既有 10 用例按语义迁移（直写断言 → drain 后断言）+ 新增：
「未知 cost_type 被拒时不落 outbox」已并入 Task 1，此处删除其 ledger-only 旧断言。
pg-budget / pg-contract TRUNCATE 三表；跑全量 metering 确认全部恢复绿。

- [x] **Step 2: 插件轮询**

`index.ts`：`meter.init()` 的 `.then` 里（`ready` promise + disposed 守卫，照知识库）
起轮询；失败 warn；effect 清理。interval 逻辑为薄壳（仓库先例无 interval 测试，
drainOnce 已全覆盖）；可用注释记该行为仅由集成验证。

- [x] **Step 3: 跑测试并提交**

```
feat(metering): 进程内调度器——轮询 drainOnce，失败下轮重放（sink 用例接 outbox 语义）
```

---

## Task 5: 文档同步

**Files:**
- Modify: `docs/architecture.md` §6.4（异步削峰落点：本地 = outbox + 进程内调度器，
  集群 = RocketMQ 传输——语义、幂等键、事件时刻）
- Modify: `docs/design-review.md`（B2 偏离①记账更新：本地等价已落地；RocketMQ 传输
  仍待拓扑——不得划掉）
- Modify: `docs/README.md`（已定案 metering 行：待补三者中「RocketMQ 异步削峰」措辞
  拆为「本地 outbox 等价已落地 / RocketMQ 传输待拓扑」，Doris 聚合保持待补）
- Modify: 本计划 + 设计说明勾选

- [x] **Step 1: §6.4** 异步削峰一句扩为两形态表（Local / Cluster）。
- [x] **Step 2: B2** 偏离①原文保留，加「2026-08-26：本地等价落地」行（不视为收账）。
- [x] **Step 3: README** 措辞更新 + 设计说明/计划勾选。
- [x] **Step 4: 校验 + 提交**

```
docs(metering): 异步削峰本地等价落地——B2 偏离①记账更新（传输仍待拓扑）
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
cd platform && METERING_TEST_DSN=... ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc -b --noEmit
```

- [x] **Step 3: 对照设计说明 §9 的 9 条验收判据**逐条指到具体用例名

---

## Self-Review

**设计说明覆盖检查**：

| 设计说明章节 | 落在哪 |
|---|---|
| §2 模型（outbox 表 / 职责矩阵） | Task 1（DDL + 写路径）+ Task 2（drainOnce） |
| §3 四个不变式 | Task 1（原子配套）/ Task 2（①幂等 ②时刻 ③顺序）+ Task 3（契约化） |
| §4 写穿即见 → 有界最终一致 | Task 4（sink 断言迁移）+ 设计说明已显式声明 |
| §5 drain 器与调度器 | Task 2 + Task 4 Step 2 |
| §6 毒丸与积压 | Task 2（毒丸整批回滚）+ 设计说明§6（观测留待） |
| §7 契约 | Task 3 |
| §8 不做的事 | 全程；Task 5 写进文档 |

**待评审的取舍**：

1. **`emit`/`commit` 返回值语义变弱**（保序强一致 → 有界最终一致）。预算执法
   （reserve/balance）不动，账目读方容忍秒级；事件时刻保真保证「延迟不换周期」。
   若未来有调用方要求写穿即见，唯一正解是 drain 等待，而不是回退直写。
2. **幂等键由 PG 生成而非发出方生成**——发出方跨语言无法协商键格式；代价是「同一
   逻辑事件的两个发出方实例各自生成键」时不去重——但幂等键的职责本来就是
   「防同一事件的重复投递」，不是「防两个事件长得像」。
3. **毒丸整批回滚**（无错误标记列）——与知识库投影先例同款；显式「毒丸阻断」比
   「静默丢行」诚实，后者在审计场景不可接受。
4. **SKIP LOCKED 保留**——单实例下无差，但它是「本地进程内」与「Cluster 消费侧」
   共用的搬运语义；现在写对避免换传输时重演（也避免多 dsh 节点共享 PG 时的双写）。

**已知不足**：
- ORDER BY seq 无可杀突变的测试（小表扫描序恰好等于 seq 序）——记为结构不变量，
  与知识库投影同款，不假装覆盖。
- outbox 积压监控（深度/最老行龄）留待可观测切片；写入口与搬运成功的观测缺失，
  已在设计说明 §6 留待补。
- RocketMQ 传输 / Go 消费侧未做（拓扑未就位），B2 偏离①保持记账。
- interval 轮询为薄壳（无 interval 测试，仓库先例同款）；集成验证时由实际运行确认。

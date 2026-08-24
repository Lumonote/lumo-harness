# Seam 可远程化分级 —— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-24-seam-remotability-design.md`
**评审条目**：R1【P0】（`docs/design-review.md` §R1）
**规范章节**：`docs/architecture.md` §4.1

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。本项**大量读**该树（分级表的每一条都要对着 `deepseek-harness/docs/capability-seams.md` 与 `packages/*` 的自述核实），因此收尾的合规校验不可跳过。

**分级表的唯一真相源是 TS**（`platform/shared/seam-contracts/remotability.ts`），不生成 JSON 副本。理由：今天唯一的消费者是 TS 插件（`seam-proxy`/`seam-host`），TS 常量还能拿到编译期穷举。将来若出现 Go SeamProxy，从 TS 生成 JSON，不手工维护第二份。

**fail closed 的方向不可协商**：未定级 = 拒绝。加载期硬拒，不做「先警告后拒绝」的过渡期——过渡期在这里等于永久默认可远程。

**幂等性不得有第二份**：`remote.ts` 的 `IDEMPOTENT_METHODS` 必须被分级表吃掉，`isIdempotent()` 签名不变以免动 `client.ts`。

**运行期预算默认 `warn` 不是 `enforce`**：超预算是性能回归，不是安全事故；但告警必须结构化可断言。

测试命令：`cd platform && pnpm vitest run <path>`（配置 `include: ['**/*.spec.ts']`）。

---

## Task 1: 分级表与查询 API（红 → 绿）

**Files:**
- Create: `platform/shared/seam-contracts/remotability.ts`
- Create: `platform/shared/seam-contracts/__tests__/remotability.contract.spec.ts`

- [ ] **Step 1: 先写测试（红）**

`remotability.contract.spec.ts`，四组断言：

1. **覆盖完整性**：一份从 `deepseek-harness/docs/capability-seams.md` 抄录的 `seam` 角色服务清单（硬编码在测试里，作为「对着上游核对过」的证据），逐个断言在分级表中有条目。清单漏一个就红。
2. **理由必填**：每个 `never` / `needs-design` 条目 `why` 非空。
3. **预算自洽**：每个 `remotable` 条目 `perTurnCallBudget × latencyBudgetMs ≤ TURN_NETWORK_BUDGET_MS`。
4. **幂等性单一来源**：`remotable` 条目的每个方法都声明了 `idempotent`；非 `remotable` 条目不得声明 `methods`（声明了说明定级与实现不一致）。

- [ ] **Step 2: 实现分级表（绿）**

`remotability.ts` 导出：

```ts
export type SeamClass = 'remotable' | 'never' | 'needs-design'
export type CallShape = 'unary' | 'server-stream' | 'handle' | 'waterfall' | 'registry' | 'transport'
export interface MethodGrade { idempotent: boolean }
export interface SeamGrade {
  class: SeamClass
  shape: CallShape
  /** 仅 remotable：逐方法幂等性。取代 remote.ts 的 IDEMPOTENT_METHODS */
  methods?: Readonly<Record<string, MethodGrade>>
  /** 仅 remotable */
  perTurnCallBudget?: number
  latencyBudgetMs?: number
  /** never / needs-design 必填；remotable 可选 */
  why?: string
  /** needs-design：正确归属（LLM 网关 / 复制日志 / Scheduler / …） */
  belongsTo?: string
}
export const TURN_NETWORK_BUDGET_MS = 6_400
export const SEAM_GRADES: Readonly<Record<string, SeamGrade>>
export function gradeOf(seam: string): SeamGrade | undefined
export function isRemotable(seam: string): boolean
export function assertRemotable(seam: string): void   // 抛错，错误信息含 class + why
export function isIdempotent(seam: string, method: string): boolean
```

条目按设计说明 §3–§5 逐条填，`why` 用设计说明表格里的理由，**不要写成「见文档」**——错误信息里能读到原因才有用。

- [ ] **Step 3: 跑测试**

```bash
cd platform && pnpm vitest run shared/seam-contracts/__tests__/remotability.contract.spec.ts
```

- [ ] **Step 4: 提交**

```
feat(seam): 可远程化分级表——未定级即拒绝，幂等性并入单一真相源
```

---

## Task 2: 吃掉 remote.ts 的双表

**Files:**
- Modify: `platform/shared/seam-contracts/remote.ts`

- [ ] **Step 1: 先加断言（红）**

在 `remotability.contract.spec.ts` 里加一组：`remote.ts` 的 `isIdempotent` 与分级表对**所有** `remotable` seam 的所有方法给出相同答案，且对未定级 seam 一律 false。

- [ ] **Step 2: 删表改代理（绿）**

`remote.ts` 删掉 `IDEMPOTENT_METHODS`，`isIdempotent` 改为转发到 `remotability.ts`。签名不变，`client.ts` 不动。删除时留一行注释说明幂等性搬去了哪里——否则下一个人会在这里重新加一张表。

**注意循环依赖**：`remotability.ts` 不得 import `remote.ts`（`remote.ts` 单向依赖 `remotability.ts`）。`assertRemotable` 需要抛 `RemoteSeamError` 的话会形成环——因此 `assertRemotable` 抛普通 `Error`，由调用方（`seam-host`）负责转成 `forbidden`。

- [ ] **Step 3: 全量跑 seam-contracts 测试 + typecheck**

```bash
cd platform && pnpm vitest run shared/seam-contracts && pnpm run typecheck
```

- [ ] **Step 4: 提交**

```
refactor(seam): 幂等白名单并入分级表——两张表必然漂移
```

---

## Task 3: 闸 A —— seam-proxy 加载期拒绝

**Files:**
- Modify: `platform/dsh-plugins/seam-proxy/src/index.ts`
- Create: `platform/dsh-plugins/seam-proxy/__tests__/gate.spec.ts`

- [ ] **Step 1: 先写测试（红）**

`gate.spec.ts` 直接测一个纯函数而不是整个插件 apply（插件需要真 Cordis Context，成本高且不测到重点）。因此先从 `index.ts` 里抽出：

```ts
/** 校验配置里要接管的 seam 全部可远程化。任一不合格即抛，错误信息含类别与理由。 */
export function assertSeamsRemotable(seams: readonly string[]): void
```

断言：
- `['knowledge','knowledgeGraph']` 通过
- `['terminals']` 抛，消息含 `never` 与理由片段
- `['llm']` 抛，消息含 `needs-design` 与 `belongsTo`
- `['nonexistent-seam']` 抛，消息说明「未定级」而不是「不存在」——语义是 fail closed
- `[]` 通过（不接管任何 seam 是合法的）

- [ ] **Step 2: 实现并接到 apply（绿）**

`index.ts`：
- `seams` 配置类型从 `Array<'knowledge' | 'knowledgeGraph'>` 放宽为 `string[]`。**这是刻意的**：收窄的联合类型让非法值在 TS 编译期就被挡住，看似更好，但 `cordis.yml` 是运行时 YAML，编译期类型对它不起作用，只会造成「类型上不可能发生所以不校验」的错觉。放宽 + 运行时闸才是真的防线。
- `mode === 'remote'` 时，在建 client 之前调 `assertSeamsRemotable(seams)`。顺序要紧：先校验再建连接，否则非法配置会先开一堆 socket。
- `mode === 'local'` 时**也要校验**——local 模式今天不注册远程 Provider，但配置里写着 `terminals` 说明作者的意图是错的，等切到 remote 才炸就晚了。

- [ ] **Step 3: 跑测试**

```bash
cd platform && pnpm vitest run dsh-plugins/seam-proxy
```

- [ ] **Step 4: 提交**

```
feat(seam-proxy): 加载期可远程化闸——local 模式同样校验，配置放宽给运行时闸
```

---

## Task 4: 闸 B —— seam-host 服务端拒绝

**Files:**
- Modify: `platform/dsh-plugins/seam-host/src/server.ts`（或 `dispatch.ts`，视 seam 名解析在哪）
- Create: `platform/dsh-plugins/seam-host/__tests__/gate.spec.ts`

- [ ] **Step 1: 读现状**

先读 `server.ts` 定位 seam 名从请求路径解析出来、交给 `isSeamName`/`methodSpec` 之前的那一点。闸 B 必须插在**触碰任何 Provider 之前**。

- [ ] **Step 2: 先写测试（红）**

- `never` 类 seam 名 → `forbidden`，且断言 Provider 的 mock 未被调用（这是判据 4 的「不触碰 Provider」）
- 未定级 seam 名 → `forbidden`
- `remotable` 且在 `METHOD_TABLE` 里 → 放行

再加一条契约断言（放 `remotability.contract.spec.ts` 更合适，因为它跨两个包）：**`remotable` 集合 == `METHOD_TABLE` 键集合**。两边不等就是定级与实现不一致。

- [ ] **Step 3: 实现（绿）**

在 seam 名解析之后立刻校验，失败抛 `forbidden`（用 `errors.ts` 的既有 helper）。

注意错误码选择：不可远程化用 `forbidden` 而不是 `invalid`。理由——`invalid` 语义是「参数/方法非法」，而这里 seam 名是合法标识符，被拒的原因是**准入策略**。且 `forbidden` 不计入熔断（见 `remote.ts` 的 `countsAsFailure`），这正确：客户端配置错了不该把 host 判死刑。

- [ ] **Step 4: 跑测试并提交**

```
feat(seam-host): 服务端可远程化闸——准入判据不交给调用方
```

---

## Task 5: 闸 C —— 每 turn 调用预算

**Files:**
- Create: `platform/shared/seam-contracts/turn-budget.ts`
- Create: `platform/shared/seam-contracts/__tests__/turn-budget.spec.ts`
- Modify: `platform/dsh-plugins/seam-proxy/src/client.ts`
- Modify: `platform/dsh-plugins/seam-proxy/src/index.ts`（配置项）

- [ ] **Step 1: 先写测试（红）**

`turn-budget.spec.ts`，被测对象是一个纯计数器：

```ts
export type BudgetMode = 'warn' | 'enforce'
export interface BudgetViolation {
  seam: string; turn: string; count: number; budget: number
}
export class TurnCallBudget {
  constructor(opts: { mode: BudgetMode; onViolation?: (v: BudgetViolation) => void })
  /** 记一次调用。enforce 模式下超预算抛错；warn 模式下回调后照常返回。 */
  record(seam: string, turn: string): void
}
```

断言：
- 预算内不触发回调
- `warn` 模式第 budget+1 次触发回调，且 `record` 不抛
- `enforce` 模式第 budget+1 次抛，消息含 seam/count/budget 三个数
- 违规回调的字段完整（判据 5 的「结构化」）
- 不同 turn 各自计数（换 turn 归零）
- 不同 seam 各自计数
- 无预算声明的 seam（不该发生，因为闸 A 已拦）→ 不计数不抛，交给闸 A 报错，这里不重复执法
- **只在第一次越界时回调一次**，之后同 turn 同 seam 不再刷告警——否则一个写得碎的组件会刷出上百条相同告警，把信号埋掉

- [ ] **Step 2: 实现（绿）**

内部用 `Map<turn, Map<seam, count>>`。**必须处理内存增长**：turn 只增不减，长会话会让 Map 无界膨胀。做法：只保留最近 N 个 turn（N=8），超出时淘汰最旧——预算是 turn 内语义，历史 turn 的计数没有用途。这一点要写进注释，因为「看起来能用但会漏内存」是最容易过 review 的缺陷。

- [ ] **Step 3: 接到 client.ts（绿）**

`SeamProxyConfig` 加 `budgetMode?: BudgetMode` 与 `onBudgetViolation?`；`call()` 增加可选 `turn` 参数……

**这里有个设计问题必须先解决**：`call(seam, method, args)` 没有 turn 上下文，而 `remote-seams.ts` 里的适配器实现的是 seam 接口本身（`query(request)`），接口里也没有 turn。硬塞 turn 参数就破了「远程适配器与本地 Provider 接口完全相同」这条 §4.1 的核心约束（`remote-seams.ts` 文件头明确禁止远程专有参数）。

**决定**：turn 由 `SeamProxyClient` 的**可变当前 turn 指针**提供，不进 seam 接口。`client.setTurn(turnId)` 由平台侧的 turn 边界监听器调用（`session-log` 或 `recovery` 插件已经在监听 turn 事件）。未设 turn 时用哨兵值 `'no-turn'`，计数照常但不淘汰——单机脚本调用不该因为没有 turn 就绕过预算。

这条决定要记进 Self-Review：它把预算的准确性押在「有人记得调 setTurn」上。替代方案是用 AsyncLocalStorage 隐式传播，更准确但引入一个跨 await 的隐式上下文，调试成本高。当前选显式，理由是本项的预算是**回归探测器**而非安全闸，漏计的代价可接受；若将来改成 `enforce` 为默认，就必须换成隐式传播。

- [ ] **Step 4: 跑测试并提交**

```
feat(seam-proxy): 每 turn 调用预算——粗粒度硬规矩的执法点，默认告警可配拒绝
```

---

## Task 6: 文档同步

**Files:**
- Modify: `docs/architecture.md`（§4.1 插入分级表 + 两条硬规矩 + 修正「任意 seam」的措辞）
- Modify: `docs/design-review.md`（R1 落地状态 + 汇总表那一行）
- Modify: `docs/README.md`（§五 待补章节进度不动；R1 属评审条目不属待补章节）

- [ ] **Step 1: §4.1 改写**

现文第一句把 dsh 的远程沙箱特例推广成「任意 seam」。**不要删掉这句**——它是设计初衷的记录；改成「原推广已被 R1 收窄」并给出收窄后的表述：杠杆来自平台新增能力 seam，不来自搬迁 dsh 原有 seam。附三张表（`never` / `needs-design` / `remotable`）与两条硬规矩，指向 `remotability.ts` 为唯一真相源。

**必须写进去的一句**：`ctx.fs` 判 `never` 指的是「通用 SeamProxy 不得代理」，`fs-e2b` 走 `ctx.e2b` 专用句柄依然合法。不写这句，下一个人会认为规范自相矛盾（dsh 明明有远程 fs）。

- [ ] **Step 2: R1 落地状态**

格式同 N1/T1。要点：三道闸、白名单里没有 dsh 原生 seam 这个结论、`ctx.web` 判 `needs-design` 是治理决定而非技术决定、闸 C 默认 `warn` 的理由、`setTurn` 显式传播的已知弱点。

- [ ] **Step 3: 汇总表 R1 行**

- [ ] **Step 4: 校验 + 提交**

```bash
file docs/architecture.md docs/design-review.md
git diff --stat docs/
```

```
docs(seam): §4.1 分级表与两条硬规矩、评审 R1 落地状态
```

---

## 收尾：第一铁律合规校验（不可跳过）

本项读了大量 dsh 源码与文档，必须证明未写入。

- [ ] **Step 1**

```bash
git -C deepseek-harness describe --tags --dirty   # 必须 dsh-v0.1.1-rc.2，无 -dirty
git -C deepseek-harness status --porcelain -uno   # 必须无输出
```

- [ ] **Step 2: 全量测试 + typecheck**

```bash
cd platform && pnpm vitest run && pnpm run typecheck
```

- [ ] **Step 3: 对照验收判据**

| # | 判据 | 对应测试 |
|---|---|---|
| 1 | 分级表覆盖上游全部 seam 角色服务 | `remotability` 覆盖完整性用例 |
| 2 | `never`/`needs-design` 写进配置 → 加载期抛，含类别与理由 | `seam-proxy/gate.spec.ts` |
| 3 | 未定级 seam → 加载期抛（fail closed） | 同上 |
| 4 | `never` 类到达 host → `forbidden` 且不触碰 Provider | `seam-host/gate.spec.ts` |
| 5 | 超预算：`warn` 出结构化告警且成功；`enforce` 拒且含三数 | `turn-budget.spec.ts` |
| 6 | `isIdempotent` 与分级表一致；`remotable` == `METHOD_TABLE` 键集 | `remotability` 双表一致性用例 |
| 7 | 每个 `never`/`needs-design` 有非空 `why` | `remotability` 理由必填用例 |

---

## Self-Review

**设计说明覆盖检查**：

| 设计说明章节 | 落在哪 |
|---|---|
| §2 三个类别与判定依据 | Task 1（`SeamClass`） |
| §3 黑名单与理由 | Task 1 表体 |
| §4 needs-design 与归属 | Task 1 表体（`belongsTo`） |
| §5 remotable 白名单与预算 | Task 1 表体 |
| §6 硬规矩 A（未定级即拒） | Task 3（闸 A）+ Task 4（闸 B） |
| §7 硬规矩 B（粗粒度预算） | Task 5（闸 C） |
| §8 与现有代码合并 | Task 2 |
| §9 验收判据 | 收尾 Step 3 |

**三处待评审的取舍**：

1. **`seams` 配置从联合类型放宽为 `string[]`**（Task 3）。看起来是放松类型安全。真实理由：`cordis.yml` 是运行时 YAML，联合类型对它无效，却会让人以为已经防住了。但代价真实——TS 侧调用 `apply()` 时不再有编译期提示。**这是最可能被评审推翻的一处**，替代方案是保留联合类型并额外做运行时校验（两处维护，且联合类型每加一个 remotable seam 就要改）。
2. **turn 用显式 `setTurn` 而非 AsyncLocalStorage**（Task 5）。漏调 `setTurn` 会让预算失准且**静默**。当前可接受是因为闸 C 是回归探测器；若默认改 `enforce`，必须先换隐式传播。
3. **白名单里一个 dsh 原生 seam 都没有**（Task 1）。这是本计划最强的结论，也最容易被读成「工作没做完」。它需要在 §4.1 与评审落地状态两处都说清是结论而非遗漏，否则下一个人会「补全」它。

**已知不足**：分级表的覆盖完整性靠测试里硬编码的上游 seam 清单守住，而该清单是**人工抄录**的。上游升级后新增 seam 不会让测试变红。真正的解法是从 `deepseek-harness/docs/capability-seams.md` 解析——但那会让平台测试依赖一个只读外部树的文件路径，形成脆弱耦合。取舍是：清单里注明抄录自哪个 tag，dsh 版本升级的检查表里加一条「重核分级表」。

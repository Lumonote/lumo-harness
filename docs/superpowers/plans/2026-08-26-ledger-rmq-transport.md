# 计量台账 RocketMQ 传输 —— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-26-ledger-rmq-transport-design.md`
**评审条目**：B2 落地状态偏离① 收账（RocketMQ 传输接线）
**规范章节**：`docs/architecture.md` §6.4 / §8.3

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。本项只动 `platform/` 与 `docs/`，收尾合规校验必查。

**两条硬事实**（设计说明 §1）：npm 无 TS RocketMQ 客户端 → 发布/消费都进 Go；两条装配
路径（local drain / rmq Go 服务）互斥并存，台账永远单一写入者。

**真依赖测试**：Go 集成用 `LUMO_TEST_PG_DSN`（真 PG，55432）与 `LUMO_TEST_RMQ_ENDPOINT`
（真 namesrv，19876），未设置 skip 且 skip 可见；TS 侧沿用 `METERING_TEST_DSN`。发布/消费
属性必须**真实 broker 实测**——同前序切片「对真 PG 跑」同哲学，stub 证明不了传输。

**Σ 四个不变式**（设计说明 §3）：①一次事件一账 ②事件时刻保真 ③顺序稳定 ④原子配套。

测试命令：
- TS：`cd platform && METERING_TEST_DSN=… ./node_modules/.bin/vitest run dsh-plugins/metering`
- Go：`cd platform/control-plane/usage-ledger && LUMO_TEST_PG_DSN=… LUMO_TEST_RMQ_ENDPOINT=localhost:19876 go test ./...`

---

## Task 1: cost_type 闭集单一真相源（红 → 绿）

**Files**：Create `platform/shared/manifests/cost-types.manifest.json`；Modify
`platform/shared/seam-contracts/cost-events.ts`（COST_TYPES 改由 manifest 派生）；
Modify `platform/shared/seam-contracts/__tests__/cost-events.spec.ts`（加闭集锁）

- [ ] **Step 1 测试（红）**：cost-events.spec 断言 `COST_TYPES` 数值与 manifest 严格一致
  （6 类型 × unit）；tsc 后实现。
- [ ] **Step 2 实现（绿）**：manifest JSON（`{"costTypes": {"llm.tokens": {"unit": "tokens"}, …}}`）
  六项；cost-events.ts 里 `COST_TYPES` 从 import 该 JSON 构造（文档注释「为什么闭集」保留
  在 TS 侧，数值不再两处）。
- [ ] **Step 3 提交**：`refactor(cost-events): 闭集单源化——数值入 manifest，TS 派生（Go 侧将 embed 同一文件）`

---

## Task 2: Go usage-ledger 骨架 ledger 核心（红 → 绿）

**Files**：Create `platform/control-plane/usage-ledger/{go.mod,cmd/usage-ledger/main.go,internal/manifest/gen.go,internal/ledger/ledger.go}`；Create
`internal/integration/ledger_test.go`

- [ ] **Step 1 测试（红）**：`ledger_test.go`：
  - DDL+INSERT 列清单来自 embed（golden 19 列断言,与 TS 侧锁一致）
  - 校验：闭集外拒绝、缺归因拒绝、unit 不符拒绝
  - 幂等：同 event_key 两插 = 1 行;事件时刻保真(显式 ts)
  - 真 PG(55432/GOLANG schema 由 DSN 或独立 schema——Go 无 pg-schema.ts 等价物,
    用 `options=-c search_path=` 套 schema 同法)
- [ ] **Step 2 实现（绿）**：`internal/manifest`（embed 内侧 ledger schema JSON + 生成
  DDL/INSERT 字符串,列清单/参数规则与 TS `batchInsertLedger` 对齐,任何 drift 引全部红）;
  `internal/ledger`（Validate + BatchInsert ON CONFLICT (event_key)）;`cmd` main 装配(暂仅
  /healthz)。
- [ ] **Step 3 提交**：`feat(usage-ledger): Go 骨架 + ledger 核心——embed 清单生成 DDL/INSERT、幂等、校验`

---

## Task 3: publisher + consumer（红 → 绿）

**Files**：Modify `internal/manifest`；Create `internal/rmqpublish/publisher.go`、
`internal/rmqconsume/consumer.go`；Create `internal/integration/rmq_e2e_test.go`

- [ ] **Step 1 测试（红）**：`rmq_e2e_test.go`（真 PG + 真 namesrv, skip 可见）：
  - publish 一批(seed 3 行 outbox, published_at NULL)→ 3 条消息到 broker, 3 行 marked
  - broker 侧真实重放(手动 topic 重新消费)幂等(重放一批已消费的→账行不变)
  - 跨链事件时刻:outbox.ts ↔ payload.ts ↔ ledger.ts 同值
  - publisher batch 半失败(人工置 seq 顺序 one bad)不标记(golden 标 0;恢复)
  - consumer 校验拒绝:闭集外 payload 不上账但告警(slog 捕获或注入 hook)
- [ ] **Step 2 实现（绿）**：publisher: `SELECT … WHERE published_at IS NULL ORDER BY seq
  LIMIT $1 FOR UPDATE SKIP LOCKED`→逐条 produce(topic `usage-events-<cost_type>`, body 事件
  JSON + headers `event_key`/`ts`)→整批 mark;consumer: push 订阅(broker `LUMO_RMQ_*` env),
  校验→ledger(decoder), error 退避重试(最大 5 次)后告警不落库;
  main 同时启动两个 goroutine(装配差异由同镜像多实例,同进程默认全开)。
- [ ] **Step 3 提交**：`feat(usage-ledger): rmq publisher+consumer——四不变式落地并真 broker 实测`

---

## Task 4: TS 装配与部署(drain 互斥 + compose 接入)

**Files**：Modify `platform/dsh-plugins/metering/src/pg-meter.ts`（DDL 加 `published_at` 列）;
Modify `platform/dsh-plugins/metering/src/index.ts`（`ledgerTransport` config + rmq 时停 drain）;
Create TS 装配测试（outbox.spec 加一条 published_at 列存在/SELECT 不报错 — differential defense）;
Modify `platform/deploy/compose.standalone.yml`(usage-ledger Go 服务, env)。

- [ ] **Step 1 测试（红）**：pg-meter DDL 测试加 published_at 列;index 配置测试(transport 缺省
  'local' 保持现状;'rmq' 时 drain 不启动——装配级测试用测试 seam 输出线)。
- [ ] **Step 2 实现（绿）**：ALTER/DDL + config 分支;compose 服务(attach 卷 load config, env)。
- [ ] **Step 3 提交**：`feat(metering): ledgerTransport 装配开关 + usage-ledger 进 standalone 清单`

---

## Task 5: 文档收账

**Files**：Modify `docs/architecture.md` §6.4（异步削峰双形态 Go 服务）、Modify
`docs/design-review.md`（B2 偏离①记账行划掉:传输已接线 Standalone 实测；cluster 多实例/HA
留 helm 阶段）、Modify `docs/README.md`（计量行:RMQ 传输已落地(standalone 形态)）

- [ ] **Step 1 三处文档同步**（措辞:Standalone 拓扑实测收账;cluster HA 随 helm）。
- [ ] **Step 2 校验 + 提交**：`docs(metering): RocketMQ 传输已接线——B2 偏离①收账(Standalone 形态)`

---

## 收尾：第一铁律合规 + 全量

- [ ] **Step 1** `git -C deepseek-harness describe --tags --dirty` = dsh-v0.1.1-rc.2 无 -dirty；
  `git -C deepseek-harness status --porcelain -uno` 空
- [ ] **Step 2** TS 全量 + tsc；Go `go vet`/`go test ./...`（真依赖）
- [ ] **Step 3** 对照设计说明 §6 的 8 条判据指到用例

---

## Self-Review

**设计说明覆盖检查**：

| 设计说明章节 | 落在哪 |
|---|---|
| §2 拓扑三通道 | Task 3+4（publisher/consumer + 互斥装配） |
| §3 四不变式 | Task 2（①②③ ledger 核心）+ Task 3（e2e 真 broker） |
| §4 Go 服务内部 | Task 2（骨架）+ Task 3（双 goroutine、错误面） |
| §5 闭集单源 | Task 1 |
| §6 验收 8 判据 | Section 各任务 |

**待评审取舍**：

1. **同进程双 goroutine 全开**（无力可配置 half-mode）：这是装配差的最小形态——生产集群
   同镜像多实例按消费组/发布是否启用拆分，从配置设 0/1，二态拆成。选中理由:教程少、
   无多进程协调负担;不选理由:多实例分发布=需要确认只一 publisher(依赖 SKIP LOCKED 已保证)。
2. **TS 直插 outbox 测 line 与 Go publisher 共用 `published_at`**,不与 projected_at 打架——双
   通道同一行,两种装配模式装同一 compile;local 模式不碰 published_at(维持现状)。
3. **事务语义没有硬分离**——publisher 标 published_at 的单事务与「读批+发+标」跨存储:
   crash 窗(发成功,未标)会重复发→消费幂等兜底,即 at-least-once。**合法**且已测。
4. **闭集 manifest 是数据单源**——TS/Go 语义注释各自保留;数值不两处,是账本 schema
   单源化的同形;任何类型新增=改 manifest+两锁红,显式更新。

**已知不足**：
- DLQ 持久化、消费顺序跨 topic 不承诺（设计 §7）;
- RocketMQ HA/多 broker、Cluster 多实例不在此切片(helm 阶段);
- TS dsh-node 与 Go 服务的同一 dsh 装配尚未跑通 e2e(dsh-node 镜像倾斜阶段 P2);
- 发布/消费的 OTel 指标(积压、延迟)未挂(§21 依赖后续可观测切片)。
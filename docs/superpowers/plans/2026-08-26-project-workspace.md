# 项目工作区 §11.1 —— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-26-project-workspace-design.md`
**评审条目**：N3（项目与预算树层级关系，拍板 B）
**规范章节**：`docs/architecture.md` §11.1 / §6.4 / §10.2

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。本项只动 `platform/` 与 `docs/`，收尾合规校验必查。

**拍板（2026-08-26，用户定案）**：项目 = 并行预算树（N3 选项 B）。执法层零新代码
（双树同事务扣减是既有已测行为），本切片交付项目实体治理面。

**真依赖测试**：Go 集成用 `LUMO_TEST_PG_DSN`（真 PG，standalone 15432），未设置 skip
且 skip 可见。TS 契约测试纯函数无外部依赖。

测试命令：
- TS：`cd platform && ./node_modules/.bin/vitest run shared/seam-contracts`
- Go：`cd platform/control-plane/projects && LUMO_TEST_PG_DSN=… go test ./...`

---

## Task 1: 契约 —— 状态机 + 角色矩阵（红 → 绿）

**Files**：Create `platform/shared/seam-contracts/projects.ts`；Create
`platform/shared/seam-contracts/__tests__/projects.spec.ts`

- [ ] **Step 1 测试（红）**：闭集断言（3 状态、3 角色、6 动作）；能力矩阵全组合
  （3 角色 × 6 动作 = 18 格逐格断言，与设计 §3 矩阵一致）；状态机全转移含非法
  （archived 态编辑拒绝在 API 层，契约层锁转移闭集）。
- [ ] **Step 2 实现（绿）**：`PROJECT_STATUSES` / `PROJECT_ROLES` / `PROJECT_ACTIONS`
  闭集 + `canProject` + `transitionProject`，语义注释在 TS（为什么删除必须两步）。
- [ ] **Step 3 提交**：`feat(contracts): 项目工作区契约——状态机/角色能力矩阵（§11.1，N3 拍板 B）`

---

## Task 2: Go projects 服务 —— domain + store + server（红 → 绿）

**Files**：Create `platform/control-plane/projects/{go.mod,Dockerfile}`；Create
`cmd/projects/main.go`、`internal/domain/{domain.go,domain_test.go}`、
`internal/store/{store.go,store_test.go}`、`internal/server/{server.go,server_test.go}`

- [ ] **Step 1 domain（红→绿）**：状态机/角色矩阵 Go 版（与 TS 同矩阵——判据 7 双实现），
  单测逐格对照设计 §3。
- [ ] **Step 2 store（红→绿）**：DDL（projects/project_members + 唯一索引）；Create
  （含 owner 种子 + budget_trees 种子，同事务）；成员 CRUD（最后 owner 保护）；状态
  转移；Delete（行删除，usage_ledger 不动）；usage 聚合（group by cost_type + 预算
  四态）。单测用纯函数 + SQL 形状；活库行为进 integration。
- [ ] **Step 3 server（红→绿）**：HTTP 端点表（设计 §4）；身份头解析（X-Lumo-User/
  Realm，不自签）；X-Lumo-Confirm 删除确认；非成员 404（不可见而非 403——列表语义
  决定存在性本身不可泄露）；最后 owner 409；非法转移 409。httptest 全覆盖。
- [ ] **Step 4 提交**：`feat(projects): §11.1 项目工作区服务——生命周期/成员角色/并行预算树种子/用量聚合`

---

## Task 3: 真 PG 集成（红 → 绿）

**Files**：Create `platform/control-plane/projects/internal/integration/projects_test.go`

- [ ] **Step 1 测试（红）**：独立 schema（同 usage-ledger 惯例）；判据 1–6 逐条：
  创建三件套（成员行/预算行/重名拒绝）→ 角色执法（editor/viewer/owner）→ 状态机
  （跳归档直接删被拒；归档后 edit 拒、账照记——直接 INSERT usage_ledger 行验证
  聚合不受 status 影响）→ 最后 owner 保护 → 删除两层授权 + 台账行保留断言 →
  usage 聚合数值与手插台账一致 + 预算四态。
- [ ] **Step 2 提交**：`test(projects): 真 PG 集成——判据 1-6 全绿（15432）`

---

## Task 4: compose 接入 + 文档收账

**Files**：Modify `platform/deploy/compose.standalone.yml`（projects 服务，8086/18086）；
Modify `docs/architecture.md`（§6.4 拍板 B 写入 + §11.1 实现状态）；Modify
`docs/design-review.md`（N3 状态行）；Modify `docs/README.md`（待拍板 #3 → 已定案表）

- [ ] **Step 1 compose**：服务 + Dockerfile build 实测（healthz）。
- [ ] **Step 2 文档**：§6.4 记「项目树=并行预算树（2026-08-26 拍板，双树同事务扣减既成
  事实升格口径）」；README 把待拍板 #3 移入已定案（注明拍板内容与出处）；N3 行划账。
- [ ] **Step 3 提交**：`feat(deploy)+docs(projects): projects 进 standalone 清单；N3 拍板 B 写入 §6.4/README——项目=并行预算树`

---

## 收尾：第一铁律合规 + 全量

- [ ] **Step 1** `git -C deepseek-harness describe --tags --dirty` = dsh-v0.1.1-rc.2 无 -dirty；
  `git -C deepseek-harness status --porcelain -uno` 空
- [ ] **Step 2** TS 全量 + tsc；Go `go vet` / `go test ./...`（真依赖）
- [ ] **Step 3** 对照设计说明 §6 的 7 条判据指到用例

---

## Self-Review

**设计说明覆盖检查**：

| 设计说明章节 | 落在哪 |
|---|---|
| §1 拍板 B | Task 2 store（预算种子）+ Task 4 文档 |
| §2 数据模型 | Task 2 store DDL |
| §3 契约 | Task 1 |
| §4 端点表 | Task 2 server |
| §5 计量接线 | Task 3（判据 6：种子后四态可读） |
| §6 验收 7 判据 | Task 1（7）/ Task 3（1-6） |
| §7/§8 不做的事与风险 | 显式外，不偷偷做 |

**已知不足**（设计 §7）：模板/空间挂载/OPA 跨项目节点/多集群视角/期初重配 API/第五类制品
全部显式推迟，各自有归属章节。

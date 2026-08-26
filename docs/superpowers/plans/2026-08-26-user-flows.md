# 用户自定义流程（第五类制品）—— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-26-user-flows-design.md`
**规范章节**：`docs/architecture.md` §11（第五类制品）/ §9.2（护栏）
**前置**：§11.1 项目工作区已落地（flows 依赖 project_members 只读）

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。本项只动 `platform/` 与 `docs/`。

**真依赖测试**：Go 集成用 `LUMO_TEST_PG_DSN`（standalone 15432），skip 可见；TS 契约
测试纯函数。

测试命令：
- TS：`cd platform && ./node_modules/.bin/vitest run shared/seam-contracts`
- Go：`cd platform/control-plane/flows && LUMO_TEST_PG_DSN=… go test ./...`

---

## Task 1: 契约 —— 状态机 + 防环 + audience 匹配（红 → 绿）

**Files**：Create `platform/shared/seam-contracts/flows.ts`；Create
`platform/shared/seam-contracts/__tests__/flows.spec.ts`

- [ ] 状态机全合法转移逐条 + 全非法转移拒绝 + deprecated 终态；闭集断言（5 状态/5 事件/3 可见性）。
- [ ] validateFlowDefinition：合法 DAG 过；空节点/重复 id/缺 operator/悬边各拒；**有环拒**
  （含自环与间接环）。
- [ ] audienceMatches：roles/depts/users 任一命中即真；空 audience 恒假（targeted 但无
  audience = 配置错误，宁可不可见）。
- [ ] 提交：`feat(contracts): 第五类制品契约——流程状态机/DAG 防环护栏/audience 匹配（§11）`

---

## Task 2: Go flows 服务（红 → 绿）

**Files**：Create `platform/control-plane/flows/{go.mod,Dockerfile,cmd/flows/main.go,
internal/{domain,store,server}}`

- [ ] domain：状态机/防环/audience Go 版（判据 7 双实现，逐格对照 TS）。
- [ ] store：三表 DDL；Create（校验+重名）；UpdateDefinition（仅 draft）；Submit；
  Review（approve 同事务写 flow_versions + 审计行；reject 回 draft + 审计行）；
  Target（audience+visibility）；Deprecate；Rollback（版本必须存在）；面板过滤查询。
- [ ] server：端点表（设计 §4）；身份头；执法映射（403/404/409/400）；
  **作者自审 403**；1MB 请求上限。httptest 全覆盖。
- [ ] 提交：`feat(flows): 第五类制品服务——生命周期/FlowReview/定向分发/版本回滚`

---

## Task 3: 真 PG 集成（红 → 绿）

**Files**：Create `platform/control-plane/flows/internal/integration/flows_test.go`

- [ ] 判据 1-6 逐条（防环拒入、状态机、审核职责分离+版本快照、定向+幂等、面板过滤
  三可见性、回滚重指）。flows 依赖表（project_members）同构自建。
- [ ] 提交：`test(flows): 真 PG 集成——判据 1-6 全绿（15432）`

---

## Task 4: compose + 文档收账

**Files**：Modify `platform/deploy/compose.standalone.yml`（flows，8087/18087）；
Modify `docs/architecture.md`（§11 第五类制品实现注记）；Modify `docs/README.md`
（已定案表/制品行更新）

- [ ] compose build+up+冒烟（建草稿→提交→审过→定向→面板过滤）。
- [ ] 提交：`feat(deploy)+docs(flows): flows 进 standalone 清单；§11 第五类制品实现注记`

---

## 收尾：第一铁律合规 + 全量

- [ ] dsh tag 干净 + 工作树干净；TS 全量 + tsc；Go vet + 全测试（真依赖）
- [ ] 设计说明 §6 判据 1-7 指到用例

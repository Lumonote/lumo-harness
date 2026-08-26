# LLM 网关首切片 —— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-26-llm-gateway-design.md`
**规范章节**：`docs/architecture.md` §12（网关）/ §6.4（计量单截面）
**排序依据**：seam 远程形态设计 §3 P2a 起始项（§2.1 ctx.llm 第一跳）

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。

**真依赖测试**：`LUMO_TEST_PG_DSN`（standalone 15432）+ 假 OpenAI 上游（httptest，
上游是假的可接受——被测的是网关的截面与执法，真实依赖 PG 是真依赖）。联测走 compose
（真 broker）。

测试命令：
- Go：`cd platform/control-plane/llm-gateway && LUMO_TEST_PG_DSN=… go test ./...`
- 联测：compose 冒烟（gateway + usage-ledger + psql 断言）

---

## Task 1: 设计 + 计划（本文件）—— 提交

## Task 2: Go llm-gateway 服务（红 → 绿）

**Files**：Create `platform/control-plane/llm-gateway/{go.mod,Dockerfile}`；
`cmd/llm-gateway/main.go`；`internal/domain/{budget.go,budget_test.go}`（四态镜像）；
`internal/store/{store.go}`（providers + reserve + commit）；
`internal/gateway/{gateway.go}`（流式/非流式转发 + usage 扫描）；
`internal/server/{server.go,server_test.go}`（HTTP 面）

- [ ] domain：budgetState/worseOf/stateOfTree Go 镜像（逐格对照 TS budget-policy
  判序；used 左闭）。
- [ ] store：llm_providers DDL；reserve（双树 FOR UPDATE 四态 worst）；commit（单事务
  双树无条件扣减 + outbox INSERT——payload 形状 = ledger.Event 的 CostEvent JSON）。
- [ ] gateway：非流式收全量转发；流式逐 chunk 转发 + 有界扫描 usage + 网关注入
  stream_options。
- [ ] server：端点 + 归因头解析（缺必填 400）+ 402/404 映射。
- [ ] 测试：httptest 假上游（SSE 含 usage / 缺 usage 两种）→ 断言 outbox 行、双树
  扣减、402、chunk 顺序（首 chunk 透传不经全量缓冲）。
- [ ] 提交：`feat(llm-gateway): 模型访问面+计量单截面跨网——流式背压/费率/双树执法镜像（真 PG）`

---

## Task 3: compose 接入 + 全链联测 + 文档收账

**Files**：Modify `platform/deploy/compose.standalone.yml`（llm-gateway，8088/18088）；
docs（§12 实现注记、README 已定案表）

- [ ] compose build + up；宿主起假上游（一次性 go run）→ 种子 provider + 预算树 →
  curl 网关 → 等 usage-ledger 轮询 → psql 断言 usage_ledger 行（emitter=llm-gateway）。
- [ ] 文档：§12 LLM 网关行加实现注记；README 已定案表（网关行）更新。
- [ ] 提交：`feat(deploy)+docs(llm-gateway): 网关进 standalone 清单；与计量事件流全链联测收账（§2.1 联测项）`

---

## 收尾

- [ ] dsh 合规；TS 全量 + tsc；Go vet + 全测试
- [ ] 设计说明 §5 判据 1-7 指到用例

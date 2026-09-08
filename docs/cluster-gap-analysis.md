# 集群模式功能缺口分析（2026-09-08）

> **范围**：`LUMO_DEPLOYMENT_MODE=cluster` 下尚未完成的功能。Standalone / Local 的差异只在确有对比价值处提及。
> **判据**：[`architecture.md`](./architecture.md) §7.3/§7.4/§8.2/§8.4/§9.2/§12.1、[`roadmap.md`](./roadmap.md) §16–§17、[`implementation-status.md`](./implementation-status.md)。
> **方法**：三路代码审计（控制面 Go 服务 / 插件与数据面 / 部署接线），文末「口径差异」列出与既有文档自述不一致之处。
> **性质**：本文只记录**代码与装配层面的缺口**。需要目标环境提供外部依赖（真实 IdP、SaaS 端点、生产信任根、外部 DSN）的事项归 `implementation-status.md`「有意保留的外部集成边界」，不重复列出。

## 摘要

十个 Go 服务**编译级完整**：全仓 0 个 `TODO/FIXME/XXX`、0 个 `501`、0 个占位 `panic`。因此缺口全部是**静默的** —— 表现为「表建了没人写」「outbox 写了没人读」「能力在但装配没挂」「注册表为空」。

| 类别 | 数量 | 性质 |
|---|---|---|
| A. 静默 P0 | 5 | 代码完整，链路跑不通，用户可见 |
| B. 装配缺口 | 6 | 插件本体完整，启动器不挂载 |
| C. 设计能力缺失 | 8 | 全树零命中 |
| D. 部署与验收 | 6 | 编排/监控/验收不闭环 |
| E. 死代码与占位 | 8 | 影响面小 |

---

## A. 静默 P0：代码完整、链路跑不通

### A1. 流程引擎算子目录为空

- **现象**：`FlowEngine` 只注册 `identity` / `echo` 两个原样返回的 no-op 算子，全仓再无其它 `Register` 调用。引用真实算子（LLM / 工具 / 连接器 / 知识检索）的流程要到**运行时**才报 422「未注册算子」。
- **证据**：`platform/control-plane/flows/internal/engine/engine.go:25-26`（唯一两处 `Register`）；`internal/domain/domain.go:130-132` 入库只校验算子名非空、不校验存在性。
- **影响**：手动 run、事件触发、webhook 触发全部失败，当前只有 identity/echo 能跑通。
- **设计出处**：`architecture.md:835` 要求算子目录注册进 Nacos；`platform/shared/seam-contracts/flows.ts:62` 注明「执行接线是 FlowEngine（P2）」。目录表、端点、Nacos 注册三样均不存在。

### A2. cron 自动化可创建但永不执行

- **现象**：DDL 与保存校验都接受 `trigger_kind='cron'`，UI 自动化表单也提供「定时」选项；但 flows 侧只消费 `event` / `webhook`，全仓无 cron 调度器或适配层。用户建了定时规则**静默不执行，无任何报错**。
- **证据**：`platform/control-plane/projects/internal/store/store.go:62,400` 允许 cron；`platform/control-plane/flows/internal/store/store.go:309,315` 只消费 event/webhook，注释称「cron 由外部调度器按同一入口投递」但该调度器不存在。

### A3. 已发布文档快照永不进入向量检索

- **现象**：`collab_publish_outbox` 只写不读 —— `PendingPublishes` / `MarkDispatched` 零调用方，`architecture.md:480` 要求的 reindex 管道不存在。outbox 只增不减。
- **证据**：`platform/control-plane/collaborator/internal/store/store.go:327`（Publish 事务写 outbox）、`:367-368`、`:390-391`（两个消费方法，无调用方）。
- **影响**：发布态文档永不进入 RAG 召回，与 §17.4「发布 = 不可变快照 → reindex 入 Milvus」的闭环断在最后一跳。

### A4. Agent 永远不可被派单

- **现象**：`UpsertWorkerRuntime` 是全仓唯一写 `governance_worker_runtime` 的地方，**零调用方**，且没有运行态上报端点。而派单候选要求 `runtime_status == "active"`，无行时回落 `not_reported`，因此 Agent 恒不合格。
- **证据**：`platform/control-plane/governance/internal/store/store.go:914`（唯一命中，无调用方）、`:838`（回落 `not_reported`）、`:908` 与 `internal/server/server.go:957`（Eligible 要求 active）；`server.go:841,847,1600` 自动与显式派单都过滤 `!Eligible`；`domain.go:836` 的理由文案即「Agent 执行态尚未上报 active 健康状态」。UI 也如实显示「执行态未上报」（`platform/dsh-plugins/lumo-ui/src/client/index.tsx:1961`）。
- **影响**：除非人工写库，Agent 不可被派单 —— 多 Agent 管理页的配置再完整也不会产生可执行候选。

### A5. Doris 投影整包未接线

- **现象**：`usage-ledger/internal/doris` **0 导入**。HTTP Stream Load 客户端是真的，但缺 sync worker、watermark 表和查询面。
- **证据**：`grep internal/doris` 在 `platform/` 下零命中（含测试外全部调用点）；设计见 `docs/superpowers/specs/2026-08-26-doris-aggregation-design.md:50-55,69-74`（要求独立 doris-sync worker + watermark + `usageAnalytics.dive`）。
- **影响**：聚合看板与下钻无数据源。

---

## B. 装配缺口：插件本体完整，启动器不挂载

结构性发现：**cluster 专属能力依赖的配置，启动器一个都不读**。它们不是被关掉，而是从未被打开。`platform/data-plane/dsh-node/src/deployment.ts:20-21` 的 `clusterOnly` / `distributed` 字段除传给 UI 展示外无任何消费方。

| # | 项 | 现状 | 证据 |
|---|---|---|---|
| B1 | **Seam 网络化**（设计自称最高杠杆） | `plugins.ts` 登记了 `@lumo/seam-host` / `@lumo/seam-proxy`，但 `dsh-node/src/index.ts` 全文无 `seam` 字样，compose 无任何 seam 变量。`ctx.seamProxy` 无人注册，插件内的 mTLS / 熔断 / 每 turn 预算闸全部空转 | `platform/data-plane/dsh-node/src/plugins.ts:24-25,55-56` vs `dsh-node/src/index.ts`（零命中） |
| B2 | **计量台账仍走 local drain** | `ledgerTransport` 缺省 `'local'`，dsh-node 不传该字段也不读环境变量 → 每个节点各自轮询共享 PG outbox。设计的 outbox→RocketMQ→usage-ledger 未启用 | `platform/dsh-plugins/metering/src/index.ts:42,50,80`；`dsh-node/src/index.ts:385-397` |
| B3 | **Milvus / Nebula / 重排未配置** | 字段只存在于 knowledge 插件内部，部署侧无 `LUMO_MILVUS_URL` / `LUMO_NEBULA_URL` → 回落 pgvector + PG 递归 CTE，§5.4.5 重排完全不启用 | `platform/dsh-plugins/knowledge/src/index.ts:63,68,139-147`；`dsh-node/src/index.ts:370-384` 不传 |
| B4 | **OPA 没进节点** | `control` 只注入本地 `RbacControlPolicy`；`LUMO_OPA_ADDR` 只被 Go 服务消费 → 节点工具闸门用内置角色表，策略无法集中变更 | `platform/dsh-plugins/control/src/index.ts:46-50`、`pg-control.ts:94`；`dsh-node/src/index.ts:398-402` |
| B5 | **制品下发闭环缺一段** | `skill-local` 只校验已 materialize 的本地快照，注释自认 reconcile/download 归未来 Provisioner；`PROVISIONER_ARTIFACT_NAME` 在 compose 中默认空 → 节点不挂 skill-local，技能回落**可变文件系统根** | `platform/dsh-plugins/skill-local/src/index.ts:5-8`；`platform/deploy/compose.cluster.yml:218,302,343,374,406,437`；`dsh-node/src/index.ts:166-189` |
| B6 | **跨节点读滞后判不出** | `liveHead === undefined` 时恒返回 `fresh`，`queryWithStaleness` 形同虚设 | `platform/dsh-plugins/session-log/src/index.ts:156-166`（注释自认「v1 诚实边界」） |

---

## C. 设计能力缺失（全树零命中）

| 能力 | 出处 | 说明 |
|---|---|---|
| 多集群调度 | §7.4.1 | 无 `clusterId` 概念（仅 dsh-node 注册 Nacos 时携带）；无全局/集群 Scheduler 分层、无联邦注册表、无 suspect 30s→down 90s、无跨集群重平衡。Scheduler 端点仅 `/v1/leader`、`/v1/nodes`、`/v1/placements`、`/v1/reconcile` |
| 全局执行监控面 | §7.4.2 | 无 cluster_id 维度、无 OTel 远程写、无告警分级（`task_lost`/`cluster_down`/`queue_backlog`） |
| 边缘网关 Edge | §12.1 | `edge-gateway` 零命中，南北流量目前直达各服务 |
| 终端网关 Terminal | §8.2 | `terminal-gateway` 零命中；`presence` 仅存在于 mailbox 契约与 collaborator |
| 共享执行控制 | §8.4 | `session/control` 零命中；pause/resume/stop/abort/approve 未作为一等事件落地；无 Session Console |
| AgentTeams 拓扑 | §7.3 | `agentTeams` 零命中，只有 `mailbox` 插件 |
| 流程血缘 → Nebula | §9.2 / §17.2 | `lineage` 零命中；`血缘` 仅出现在知识图谱投影（`knowledge/src/graph-projector.ts`） |
| LLM 批处理网关 | §7.2 | `llm-gateway/internal` 无 batch 实现（README 已注明 batch 显式外） |

---

## D. 部署与验收

1. **Doris、Nebula 不在任何编排中**：`compose.cluster.yml` / `compose.standalone.yml` / Helm 均无这两个中间件；`compose.local.yml:142` 注释自认该形态缺 OLAP 能力并返回 `CapabilityUnavailable`；而 `acceptance-cluster.sh:21,34` 又要求外部 Nebula 健康 URL。
2. **Helm 无中间件容器、无 Secret 模板**：operator 必须提供 `vault-token`、`registry-trust`、`control-plane-token`、`subagent-host-token` 四个 Secret。
3. **Helm 默认关闭项**（`values.yaml`）：`connectorOAuth.enabled`(:25)、`deviceGateway.enabled`(:39)、`deviceGateway.istioIngress.enabled`(:65)、`serviceMesh.istio.enabled`(:82)、`productionControls.enforced`(:94)、`productionControls.observability.enabled`(:96)、`dshNode.enabled`(:111)、`dshWeb.enabled`(:129)、`provisioner.enabled`(:160) 全部为 `false`。
4. **Prometheus 漏抓 governance**：`platform/deploy/prometheus.yml:10` 的 targets 含其余 9 个控制面服务，**不含 `governance:8089`** → 该服务 `/metrics` 与 4 条告警永不生效。`prometheus-standalone.yml` 同样。
5. **验收链路从未真正执行**：
   - 全仓无任何脚本或 env 文件设置 `LUMO_TEST_*`（仅 `acceptance-cluster.sh:17-23` 以「必填」方式引用）；
   - CI 的 `deploy-smoke` job 被 `if: ${{ false }}` 关闭（`.github/workflows/ci.yml:102`），`production-gates` 只做 helm 渲染与 `bash -n`；
   - `preflight-deployment.sh:111` 的必需服务子集只有 `postgres redis minio rocketmq nacos scheduler-0 governance registry dsh-web/dsh-node prometheus`（cluster 另加 `scheduler-1`），**不含** connector-gateway / llm-gateway / flows / projects / usage-ledger / collaborator / opa / vault / milvus；
   - acceptance 的 Go 集成测试**不含 governance 与 collaborator**。
6. **集群就绪是静态声明**：`LUMO_CLUSTER_STATUS=ready` 硬编码在 `compose.cluster.yml:265,540` 与 helm `templates/configmap.yaml:7`，不是健康聚合结果；管理页门禁依赖该声明值。设备网关另为可选 overlay（`compose.cluster.devices.yml`），smoke / acceptance 完全未覆盖设备链路。

---

## E. 死代码与占位（影响面小）

| 项 | 证据 |
|---|---|
| `breakglass` 整包死代码：纯内存 map、0 导入、无 HTTP 端点、无 PG 实现 | `governance/internal/breakglass/breakglass.go:35-36`；`grep internal/breakglass` 零命中 |
| Scheduler 对账只落账 + 单调前并，不修复分歧 | `scheduler/internal/store/store.go:95`、`internal/server/server.go:451`、`store.go:941-953` |
| Scheduler 派发 outbox 无消费者（`ClaimDispatch` 仅测试调用，实际派发由父侧插件直接 POST） | `scheduler/internal/dispatch/dispatch.go:36-50`、`store.go:798`；`dsh-plugins/subagent-remote/src/client.ts:74` |
| `lumo_service_heartbeats` 死表（仅迁移创建，代码零引用） | `platform/deploy/migrations/001_platform.sql:8` |
| `session-title-gw` 死包：无 `src/`、package.json 无 main/exports，却仍被装配引用 | `dsh-node/src/plugins.ts:27,58` |
| `AppendOnlyMerger` 已弃用（标注诚实，未装配） | `collaborator/internal/crdt/merger.go:88-91` |
| connector 审计只写不读（服务内无查询端点） | `connector-gateway/internal/audit/audit.go` |
| `llm_providers` 建表但无管理 API，需运维 seed | `llm-gateway/internal/store/store.go:22-32` |

---

## F. 建议补齐顺序

1. **A1 + A4**（「能力在但跑不通」，用户直接撞到）：补 FlowEngine 算子目录；补 Agent 运行态上报入口。
2. **B 组装配**（成本最低、收益最大，全部是「只差接线」）：挂 seam-host/seam-proxy → metering 切 `rmq` → knowledge 接 Milvus/Nebula → control 接 OPA → 制品 Provisioner 纳入装配。
3. **A2 / A3 / A5**（建了没接线）：cron 调度器、reindex 管道、doris-sync worker。
4. **D 组**：修 Prometheus 漏抓 governance；让验收脚本可执行（补 `LUMO_TEST_*` 或改 CI 开关）；`clusterStatus` 改为健康聚合。
5. **C 组**是从零开始的大工程（多集群调度、终端网关、共享执行控制），按业务需要单独排期，不与上面并列推进。

---

## 口径差异（需修正的既有表述）

| 既有表述 | 实际情况 |
|---|---|
| `implementation-status.md:33`「Doris 支持日聚合 cube、Stream Load 和查询」 | 只有 HTTP 客户端，整包 0 导入，无 worker / watermark / 查询面（见 A5） |
| `plugin-feature-maturity-audit.md` 称缺 `GET /effective-permissions`、`POST /permission-explain` | 已存在：`governance/internal/server/server.go:106-107`。该审计快照已过期 |
| `docs/README.md` 网关选型表列「边缘网关 / 终端网关 全栈 Go 自研」 | 两者均无实现（见 C） |
| `implementation-status.md:29`「Scheduler 支持 Nacos 节点目录并由 `LUMO_NACOS_ADDR` 切换」 | 属实，但仅单集群；多集群调度未实现（见 C） |

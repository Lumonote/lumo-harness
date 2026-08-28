# Implementation status — 2026-08-28

配置变量与开发默认值边界见 [`configuration.md`](./configuration.md)。

本轮按项目评审中列出的剩余开发项补齐了可运行闭环：

- 注册表增加 `/v1/blobs/{digest}`，新增 Provisioner CLI；计划、下载、sha256 复核、原子落盘、JSONL+zstd 格式的 `install-state.jsonl.zst` 和按间隔持续 reconcile（检测缺失/篡改后自动修复）均有测试；Bundle/安装快照共用有大小、行数、zstd window、重复键与记录顺序校验的 JSONL+zstd 流；Standalone profile 与 Helm 可选 Deployment/PVC 已接入。
- Connector Gateway 支持 Vault 凭证 Provider 和 OPA 策略 Provider；Scheduler 支持 Nacos 节点目录并由 `LUMO_NACOS_ADDR` 切换，dsh 承载节点会以临时实例注册并续报。
- 知识插件支持 PG/ Milvus REST v2 向量 Provider、Nebula Graph adapter Provider；PG 源表支持全量 rebuild，Doris 支持日聚合 cube、Stream Load 和查询。
- 协作服务支持同镜像内的 yrs Rust 语义内核（Yjs v1 update apply/state encode/text materialize），未配置内核的本地开发才使用明确命名的确定性更新集 fallback；FlowEngine、TriggerBus、持久事件 outbox worker、自动化绑定执行、运行幂等记录和已发布快照执行 API 已加入。
- 项目控制面已开放制品/空间/自动化 CRUD 与 dashboard；Scheduler 的 Nacos/PG 节点目录和数据驻留硬过滤已接入。
- Milvus Provider 会校验/创建 collection，并支持配置源回放接口执行 realm 级 rebuild。
- 新增外置 `platform/dsh-plugins/lumo-ui` 平台插件包：不修改 `deepseek-harness/` 源码，通过官方 `dsh.client` 扩展机制挂载到原生 DSH AppFrame；右下角运营入口、项目/权限、流程、连接器、集群和 16 个插件能力均在同一 DSH Web 页面内展示。面板采用 React Bits 风格的渐变胶囊、Aurora/Blur Reveal/玻璃卡片与 Shiny Button 本地实现，所有上游地址和身份均由运行环境注入。控制面 CORS 由 `LUMO_CORS_ORIGIN` 环境变量注入，统一 `/metrics` 增加 HTTP 延迟 histogram。
- 协作服务的 WAL 已改为 Redis 原子全局序列号 envelope；快照读取按状态位点过滤、裁剪按 envelope 序号执行，并修复数据库无记录与数据库故障的错误区分、文档元数据解析和 realm-scoped 权限主键。Helm 可选 DSH 节点池使用 Pod 唯一 ID + Nacos 临时注册 + HPA，支持超过两个节点/智能体。

## 有意保留的外部集成边界

这些不是源码 TODO，而是必须由目标环境提供的适配面：

1. yrs 内核在 Docker 构建阶段从 crates.io 获取依赖并作为独立进程打包；本轮已完成联网 `cargo check` 与离线 Rust 单测，仍需在发布环境完成最终镜像构建。未配置内核的本地 fallback 不提供文本语义 materialize。
2. Nebula 通过项目约定的 graph adapter HTTP 接口访问，Milvus 需要预先建好与 embedding dimension 一致的 collection；Provider 会对 realm、角色和版本字段强制过滤。
3. TriggerBus 的消费者分发仍是进程内，但事件入口、outbox claim/requeue/ack、自动化执行和运行幂等记录已在 flows 服务内闭环；跨服务事件骨干仍应由 RocketMQ 或调用方 outbox 接入。Doris 也必须由 PG replay 驱动，不能反向作为明细真相源。
4. 连接器协议适配（MCP/SaaS OAuth）仍由 Connector Gateway 的 manifest/credential 边界承载，具体 SaaS 需要按供应商注册 manifest；不会在通用网关里硬编码第三方协议。

## 尚未达到生产验收的项目级事项

- 当前项目下的 `deepseek-harness/` 源码实际存在，只是被 `.gitignore` 忽略；Compose/Standalone 已新增从该源码构建 `platform/data-plane/dsh-node/Dockerfile` 的默认路径，也支持用 `LUMO_DSH_IMAGE` 替换为发布镜像。尚未在当前沙箱实际启动完整 Cluster 并完成跨节点 resume、失联接管、RocketMQ/Nacos/Milvus/Nebula/OPA/Vault 联合演练，当前阻塞是 Docker daemon socket 权限，不是缺少源码。
- Scheduler 已支持可选 EDF 截止时间、加权公平队列、能力值匹配和硬反亲和；抢占需要执行器取消协议，尚未启用，避免伪造“已抢占”状态；无 leader 时仍快速失败并保留对账路径。
- 观测提供统一请求级 Prometheus 指标、延迟 histogram、Scheduler 排队任务 gauge
  （`lumo_scheduler_pending_tasks`，可接 Prometheus Adapter）及基础告警规则；cluster 与
  standalone Compose 均已带 Prometheus 抓取配置。尚未补齐 OTel trace、业务级分位数和
  CRDT/计量专用指标。
- MCP/SaaS OAuth、审批委托/break-glass、租户密钥销毁和产品市场决策需要目标供应商与业务规则，不能从仓库代码安全推导。

## 验证结果

- Lumo 外置插件的 TypeScript 类型检查与 bundle、DSH 节点 TypeScript 语法检查、Helm 默认/启用 DSH
  节点池渲染、Compose 配置、集群冒烟脚本语法和 `git diff --check` 通过。
- 十个 Go 模块均已执行 `go test ./...`；collaborator、flows、governance、observability、
  projects、registry、scheduler、usage-ledger 通过，connector-gateway 与 llm-gateway
  仅因当前沙箱禁止 `httptest` 监听 `[::1]` 失败。
- 直接执行完整平台 TypeScript 测试得到 50 个测试文件：34 个通过、11 个显式跳过，
  303 个断言通过；5 个失败文件来自沙箱禁止 `127.0.0.1` 监听的 HTTP 测试，及
  5 个必须提供 `STORAGE_TEST_DSN` 的真实 PG 契约断言。知识图投影器新增元数据归集、
  图展开、事务提交/回滚和失败后重入测试；全量 `tsc -b --noEmit` 已通过。上述未通过项
  是运行环境前置条件，不是业务断言失败。

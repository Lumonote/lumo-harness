# 分布式集群整改与验证记录（2026-11-06）

基线为 `bf105cd`，对应 [整改前评估](cluster-assessment-2026-11-05.md) 的十组问题。整改通过独立平台服务、Cordis 插件及公开 API 完成，不修改 `deepseek-harness/` 的受控源码。本记录区分代码行为、实际执行证据和部署方需要提供的生产条件。

## 整改对照

| 原问题 | 最终实现 | 自动化判据 |
| --- | --- | --- |
| 全局/本地调度超配 | 两条准入路径先锁同一全局租约行；有效全局 leader 存在时禁止本地降级；容量检查锁节点行 | 容量 1 并发放置、全局租约恢复、本地/follower 交错回归 |
| 协作文档旧写者覆盖 | PG 文档 lease/递增 epoch、连续 WAL 序号、同步提交后 ACK、快照 base CAS 与覆盖前缀裁剪同事务；发现过期停止写入并断开旧连接 | 旧实例恢复、24 路并发序号、尾部恢复、缺口拒绝快照、8 路并发初始化 |
| 旧执行结果结算新代 | 外部结果必须带正 attempt 与 node_id，事务匹配 realm/node/attempt；stop 同样检查代次 | 缺代次、错节点、旧结果、旧 stop、新代迁移和重复报告回归 |
| 远程排队与孤儿任务 | 202 轮询等待放置，启动带 assignment；放置前持久清理意图，超时/父进程退出后重试撤销；承载端持久取消墓碑拒绝迟到 start | 排队转执行、取消/放置竞争、stop-before-start、父侧清理重启及回执恢复 |
| 固定 32 条队头阻塞 | 全量到期候选按队列选取；PG 持久虚拟服务量；失败原因与指数退避；drain 批大小可配 | 第 33 条任务、跨 Store/批次公平、退避后恢复回归 |
| 日志复制缺口 | 每条待复制事件先 fsync 本地 spool；按 session/seq 顺序重试；flush 校验确认状态；副作用前刷新租约并刷新相关日志；积压/围栏失败关闭 readiness | 短暂写失败与补写、磁盘重启恢复、积压上限、过期租约与日志连续性回归 |
| 实际集群归属丢失 | requested_cluster_id 与 assigned_cluster_id 分离；attempt 保存实际集群，故障迁移按实际归属选择 | 无集群约束任务 A→B→C 连续迁移，旧代结算不释放新槽位 |
| Helm release 串流量与渲染错误 | Pod/Service/治理 selector 增加 release instance；修复 device issuer 卷缩进；增加 values schema、结构断言和 kubeconform | 七种配置组合、同 namespace 两 release 隔离、生产配置反例 |
| 持久化承诺与基础设施 HA | 协作权威 WAL 移入 PG；提供生产外部基础设施/Secret 契约与 preflight，拒绝开发凭证和开发 Vault；spool 使用每 Pod 持久卷并纳入备份 | 生产 values 正反例、DDL 收敛与数据库结构比较；生产故障域仍需运维环境演练 |
| 发布验收与弹性 | nightly/候选发布 full Compose 门禁；真实 leader/node 故障脚本；外部 backlog HPA 契约、PDB、拓扑分散、NetworkPolicy、HTTP readiness/drain 与 preStop | 调度/节点/日志/回执活库测试，Helm 检查，真实容器故障与排空验收 |

额外修复：Seam Proxy 半开状态只允许一个探针，重试增加抖动；协作 WebSocket 的广播和 ACK 共用写锁；同用户多连接独立订阅；多个协作服务并发首启通过事务级 advisory lock 串行建表。Agent Teams 对接上游公开 provider/activation API。执行节点监听错误、进程租约丢失和销毁统一停止准入、工具执行、调度与心跳，等待在途续租和执行退出后再释放租约；无 PG 本地模式也不会在迟到的监听回调中重新就绪。执行节点的 Nacos 续报、排空禁用及注销由 host 内同一个写者串行处理，排空先停止续报并等待在途注册，再禁用节点，防止迟到续报重新开放准入。新进程注册及 readiness 变化时显式更新实例元数据，覆盖上一代排空留下的禁用状态，避免 POST 注册成功但节点永远不能再次放置。

真实启动同时修复了与当前上游的装配差异：无任务 headless 的 sandbox-policy 移除 startup 注入，workflow 使用当前公开 `workflow-ptc` 并复用 base storage；承载插件声明全部执行服务及 `sessionLogReplication` 依赖，readiness 依赖异常返回带诊断的 503；平台 UI 声明 bundle 元数据，避免市场再次挂载无配置实例。镜像运行层提供固定版本 pnpm 和 Git，支持源版本固定的插件通过官方 profile manager 安装。

## 运行与升级契约

- 数据库增量为 `008_scheduler_assignment_queue.sql`、`009_collaborator_document_runtime.sql`、`010_subagent_durable_lifecycle.sql`；服务启动 DDL 同步包含这些语句。共表归属、迁移语句收敛和 PostgreSQL 实际结构均有检查。
- 协作文档升级必须先停止全部旧版 collaborator 写者，备份 PG 与 Redis，再部署新版。旧文档首次取得 PG 文档锁时导入 Redis WAL 尾部；导入失败保持未迁移状态，不确认新更新。迁移不删除旧 Redis 数据。新文档和完成导入的文档仅依赖 PG 恢复。禁止让不认识 epoch 的旧写者与新版混合滚动。
- 终态上报和 start/stop 必须使用原始 assignment；同一个已取消任务 ID 保持取消终态，新业务重试使用新 task_id。已启动但未确认停止的执行保持占槽，不以“发送过取消请求”推断物理执行已结束。
- 普通执行节点使用稳定 nodeId 与随机 boot holder 的独占 PG 进程租约。有效旧租约不会被新实例抢走；过期后新代在开放准入前，为上一代已接受但未持久结集的请求写入 `HOST_PROCESS_LOST` 失败回执，已有真实回执保持不变。旧代不能再准入、执行新工具或提交回执。没有可证明 request 的历史记录要求人工核对，不猜测重跑。
- 父进程重启后使用 `ctx.remoteSubagentRuns.recover(childId, parent)` 显式恢复结果等待。恢复验证配置 realm、ownerUserId、持久 parentSessionId 及当前真实父 Agent；不会重跑 child，也不会自动重建旧 JavaScript Promise、OS 句柄或模型调用栈。
- `LUMO_SESSION_LOG_SPOOL_DIR` 必须指向该节点独占的持久目录；cluster/production Helm 使用 StatefulSet 与每 Pod PVC，多个节点不得共享同一 spool。被围栏、日志分叉或已追加事件未能进入 spool 的 session 会写入 `.fenced` 持久隔离标记，节点保持不可就绪；需保留现场核对，不能删除 spool 来掩盖缺口。普通 PG 暂时失败仅重试，不因此永久隔离。磁盘故障若连隔离标记也无法写入，错误明确上报且当前进程停止准入，不能承诺磁盘丢失后还可恢复尾部。节点启动身份每次变化，避免重启复用过期写者权限。PVC 丢失不等于可从 PG 还原尚未提交的本地尾部。
- `/healthz` 表示进程存活，`/readyz` 检查启动状态、数据库与日志复制；已进入排空的节点拒绝新 start、暂停治理认领、从 Nacos 撤销准入，等待既有准入/运行及日志刷新。`POST /drain` 使用 realm/seam token，撤销注册与刷新共享总时间预算，超时返回失败。
- Helm 旧 Deployment 的 selector 不可原地修改，迁移为 StatefulSet 也需要受控维护窗口或新 release 迁移。见 [部署与回滚说明](../platform/deploy/README.md)。PDB 约束自愿中断，不能替代跨宿主机/可用区容灾。

调度配置：`LUMO_DRAIN_BATCH=64`、`LUMO_PENDING_BACKOFF_MS=1000`、`LUMO_PENDING_BACKOFF_MAX_MS=30000`。日志积压上限：`LUMO_SESSION_LOG_MAX_PENDING=10000`。排队原因、最老等待年龄与日志 backlog 可用于定位瓶颈；HPA 外部指标必须接入真实 Prometheus adapter 数据。

## 验证记录

验证在本机隔离 PostgreSQL、Redis 及独立 Compose 项目中进行，测试身份不是生产凭证。

本机 Docker 内存约 7.65 GiB，构建使用满足上游引擎要求的 Node 24，并串行执行官方 host/client 构建。验收使用真实 CPU 推理的 `BAAI/bge-small-en-v1.5`（384 维）和 `cross-encoder/ms-marco-MiniLM-L-6-v2`；产品默认 BGE 配置保持不变，本次不作为默认大模型的吞吐或容量证明。真实 full 拓扑曾因 TEI 默认预热批次过大出现 OOM，现提供批次/并发/线程配置，验收使用 512 tokens、单批 1 请求、并发 4、单线程；不能把重启循环中的短暂 healthy 记成通过。DSH 镜像运行层保留安装依赖与动态插件管理所需的 pnpm，采用多阶段构建排除构建用的下载 store。

- 协作服务全套 Go 测试及 `go test -race ./...` 已通过，包含新 WAL/围栏/快照和发现过期回归；`go vet ./...` 已通过。
- 调度服务最终全套实库 `go test -race ./...` 通过，含迟到请求取消墓碑、并发初始化及跨批公平；`go vet ./...` 通过。
- 数据面、host 和生命周期最终复核为 11 个文件、81 项通过、无跳过，见 `review-regressions.json`；新增 HTTP 生命周期、Nacos 注册及排空预算测试实际执行。各专项测试集合存在重叠，不相加作为总覆盖量。
- 最终 runtime 相关 37 个文件、280 项用例在真实 PG、Redis、MinIO 上全部通过、无跳过；包含监听错误、断租隔离和未入盘尾部重启拒绝恢复的回归。TypeScript 检查通过，结果保存在 `platform/.build/cluster-acceptance-report/runtime-final.json`。
- DDL 归属、迁移收敛及实库共表结构 16 项通过。普通子代理 boot 租约、崩溃回执及取消组合的 18 项 PostgreSQL 回归通过。
- 上游 `fcc0ad46` 的独立副本兼容验证、4 个覆盖层测试文件共 41 项通过；实际副本的 web TypeScript 和 client bundle 构建通过。真实上游工作区的受控源码保持干净。
- 第一铁律检查：真实上游 `status --porcelain -uno` 为空，`assert-pristine.mjs` 通过。该 checkout 没有 tag，原 `describe --tags --dirty` 返回 `No names found`；加 `--always` 返回 `fcc0ad46`、无 `-dirty`。CI 使用同一兜底，避免把无 tag 误判为源码改动。
- Helm 七组合、双 release 隔离及生产负例通过 Kubernetes 1.31 kubeconform；Compose 镜像 12/12、端口 11/11 检查通过。
- 真实启动补齐上游包管理器版本装配：外层插件管理 CLI 使用所选上游 `packageManager` 的精确 pnpm pin，profile 保持独立默认值与版本检查；21 项安装行为回归通过。RocketMQ 测试删除重建 topic 后等待真实 gRPC 队列路由恢复 `NORMAL`，避免代理缓存的 `UNSPECIFIED` 类型造成假失败；三个原失败用例实库重跑通过。调度集成测试使用独立 schema，避免清表或抢租约干扰正在验收的集群。
- full 拓扑依赖验收中的 10 组 Go 实库测试共 196 项通过，8 组 Vitest 持久化/恢复测试共 80 项通过，均无跳过，见 `acceptance-summary.json`。该阶段曾显式跳过 smoke/probes，运行拓扑行为另外验收。
- 当前上游真实 bundle 装配的 31 项及后续 HTTP/装配的 10 项回归通过；排空元数据跨进程保留的 Nacos 注册回归最终为 6 项通过，故障脚本自身的恢复/失败判据 6 项通过。见 `boot-assembly.json`、`boot-regressions.json`、`nacos-restart.json` 和 `deploy-tests.log`。

单机 Nacos 的持久 Raft peer 曾保留容器重建前的旧 IP，查询和 readiness 正常但 PUT 元数据报无 leader；共享 Compose 固定回环内部身份，隔离验收卷保留旧 Raft 目录后恢复。既有部署需按备份/恢复流程迁移，生产多节点不能使用该单机配置。可选社区插件仍受上游兼容门禁约束：不匹配当前 dsh 版本的插件跳过并告警，不使用 accept-risk；社区 Web skin/preset 等待其旧服务契约，不作为本轮核心执行图已就绪的证明。

完整拓扑在最终镜像下实际运行 24 个服务。Smoke 验证 14 条控制面存活探针、leader/nodes、两个执行节点 `/readyz=200`、Web 登录页与匿名访问 401、Prometheus 就绪，全部通过；另外 6 项真集群行为探针全部通过。故障脚本的 22 个断言通过且恢复清理无错误，覆盖全局 leader KILL 后更高 token 接管、放置重放/重复终态幂等、执行节点 KILL 后发现移除/重注册、排空关闭准入与重启恢复，以及 PostgreSQL/Nacos 暂停期间的拒绝准入与恢复。PostgreSQL 故障探针恢复后检查没有新增任务、持久准入或槽位；这不表示真实 Agent/LLM 任务已经执行。

故障和启动阶段的失败报告保留在报告目录中，包括 Nacos 旧 peer、排空元数据保留和模型 OOM 的定位依据。首次五节点并行插件编译曾使 Nacos OOM，恢复后执行验收，并从健康拓扑再次全程无人干预复验：22 个故障断言仍全部通过，恢复清理无错误。冷启动资源峰值与固定源码插件首次网络下载仍须计入部署容量，不能只按稳定态内存估算。源码版本不兼容的可选插件被上游门禁拒绝并告警，未绕过检查。

持久证据位于 `platform/.build/cluster-acceptance-report/`（本地忽略目录）：`runtime-final-build.log`、`runtime-image-verification.json`、`smoke.log`、`probes.log`、`fault-injection.json`、`fault.log`、`acceptance-summary.json` 及各专项 JSON/日志。最终容器内的关键修复源文件 SHA-256 与工作区一致，没有以容器临时补丁代替镜像交付。CI 上传对应 artifact，保留 14 天。报告中的本机时间只用于定位日志，不作为生产 RTO/SLO。

本机验收结束后已清理隔离项目 `lumo-cluster-regression-full` 的容器、网络和测试卷，保留构建镜像与全部本地报告；汇总见 `final-summary.json`，清理日志见 `cleanup.log`。工作区改动未提交或推送。

## 生产边界

代码层面的围栏和本机故障回归不构成生产 HA 认证。生产部署仍需提供外部 HA PostgreSQL、注册中心、消息与对象存储端点、实际身份和 Secret，并验证其证书、路由、备份与恢复权限。

PG `synchronous_commit=on` 保证本机提交持久化；跨主机/可用区 RPO 0 还需要同步 standby、切换策略与独立存储的实际保障。当前 Compose 中间件仍用于开发/验收，其单实例不能承诺可用区故障 RPO/RTO。网络分区不能被等同于执行进程已停止；非幂等外部副作用仍按既有恢复策略处理。

真实 LLM 任务、长期压力、宿主机断电、跨可用区切换、生产备份恢复与容量/成本曲线需要有相应基础设施和负载后测量。本次不填造节点上限、p99、RTO 或可用性承诺。

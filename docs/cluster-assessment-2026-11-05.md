# 分布式集群现状与优化建议（2026-11-05）

评估基线：`bf105cd`。以下保留的是整改前的静态评估，范围是控制面、数据面、协同面、Compose/Helm 和 CI，不是在线集群认证。随后按用户要求实施的修复、回归与升级边界见 [整改与验证记录](cluster-remediation-2026-11-06.md)，不应将本文原始风险描述视为当前实现状态。

**判断：分布式核心机制已大量实现，代码具备开展受控多节点试点的基础；生产正确性、故障恢复和运维验收尚未收敛。** 不能用现有功能清单的关闭比例推算生产完成度，也没有压测依据给出可承载节点数、并发量或可用性承诺。

| 方面 | 当前已经实现 | 成熟度边界 |
| --- | --- | --- |
| 架构与扩展 | 独立 Go 控制面、DSH 外置插件、能力 seam、local/standalone/cluster 装配 | 核心分层合理，后续优化可继续通过平台扩展点完成 |
| 调度 | PG 选主租约、事务 fencing、attempt、原子 outbox、能力/驻留/反亲和、负载与集群偏好、EDF/WFQ、取消和抢占 | 全局与本地调度并发、结果代次、排队扫描存在正确性缺口 |
| 跨节点执行 | Scheduler 放置、Nacos 发现、远程 start/result/stop、持久回执、治理 Worker 认领 | 普通子代理的 202 排队没有执行闭环；父进程内等待状态不等于可持久恢复 |
| 日志与恢复 | PG 复制日志、租约和摘要去重、分叉检测、恢复器、工具意图 WAL 与副作用分类 | 单次复制失败可能留下日志缺口；恢复不包含本机 OS 句柄迁移 |
| 协作与多集群 | 文档 CRDT、Redis WAL、PG 快照、归属环、节点失联通知、线程后继约束、集群注册与漂移 | 文档归属缺写者围栏；全局任务的实际集群归属记录不足；仍共享中心 PG |
| 部署与运维 | Compose compact/full、Helm、部分服务双副本、资源限制、探针、DSH HPA、可选 mTLS、告警规则、备份恢复脚本 | 开发中间件为单实例；K8s 故障域与缩容排空不足；完整拓扑 CI 未启用 |

以下 P0/P1/P2 是本次建议的整改顺序。代码路径确认和真实故障复现分别说明；尚未进行实库并发或完整集群故障注入。

**1. P0：统一全局/本地调度的容量保护。**

- 证据：[server.go:232](../platform/control-plane/scheduler/internal/server/server.go#L232) 在本进程 `elec.Current()==nil` 时尝试本地降级；正常 follower 也满足这个条件。[degradedPlacement:100](../platform/control-plane/scheduler/internal/server/server.go#L100) 只检查目标集群和本地租约。
- [checkFencing:406](../platform/control-plane/scheduler/internal/store/store.go#L406) 对全局租约和集群租约分别锁不同的行；[PlaceTask:479](../platform/control-plane/scheduler/internal/store/store.go#L479) 查询节点容量及活跃数没有共同的节点锁。事务使用默认 `Begin`，代码未设置 SERIALIZABLE。[现有测试:113](../platform/control-plane/scheduler/internal/integration/cluster_lease_test.go#L113) 还明确允许两种租约同时有效。
- 触发条件：容量为 1 的节点空闲；全局 leader 和持本地租约的 follower 同时放置不同任务，两者均可能读到活跃数 0，然后各自提交，形成超配。这是经两路代码复核的并发风险，未做实库复现。
- 优化：follower 路由到 leader；本地降级须在事务中与全局租约状态协调。所有作用域统一按节点行锁或原子容量预留约束槽位，明确锁顺序，不能只各自校验租约。
- 验收：双调度者并发提交到容量 1 的节点，任意交错都只能成功放置一个任务；同时覆盖全局租约恢复与本地降级退出。

**2. P0：补齐协作文档的所有权 fencing 和快照 CAS。**

- 证据：[server.go:123](../platform/control-plane/collaborator/internal/server/server.go#L123) 仅在 WebSocket 握手时检查归属；[循环:204](../platform/control-plane/collaborator/internal/server/server.go#L204) 不再校验 owner。[Nacos 同步:100](../platform/control-plane/collaborator/internal/ownership/nacos.go#L100) 查询失败保留旧环；[Snapshot:197](../platform/control-plane/collaborator/internal/hub/hub.go#L197) 对本地文档快照；[SaveState:346](../platform/control-plane/collaborator/internal/store/store.go#L346) 无条件覆盖状态及 `wal_seq`。
- 最小风险序列：A 合并 seq=1 后暂停在保存前；归属变更，B 接管并保存包含 seq=2 的快照、裁剪 WAL；A 恢复后用 seq=1 的旧快照覆盖 PG。B 随后退出时，seq=2 既不在 PG，也不在已裁剪的 WAL 中。CRDT 合并的幂等性不能防止存储层旧快照覆盖。
- 优化：持久化文档 owner lease/epoch，在 WAL 写入、快照保存及裁剪处验证 epoch；快照加 CAS，保证已覆盖序号不回退并验证完整前缀。归属变化时断开旧连接并停止旧实例写入。该项为静态确认的风险，未做真实故障复现。
- 验收：成员扩缩容、旧实例暂停后恢复、注册中心分区时，快照不回退，已确认更新在新 owner 上完整可恢复。

**3. P1：执行终态回报强制绑定 attempt 和 assignment。**

- 证据：[handleResult:529](../platform/control-plane/scheduler/internal/server/server.go#L529) 只验证终态，未要求正 `attempt`；[CompleteTaskAttempt:834](../platform/control-plane/scheduler/internal/store/store.go#L834) 仅在 `attempt>0` 时附加代次条件。缺省、0 或负值会走更新当前任务的兼容路径。
- 影响：迁移后旧执行端若通过兼容格式回报，可能结算新 attempt 并错误释放其槽位。当前标准客户端已经携带正 attempt，问题是服务端接口仍允许绕过，不能依赖所有客户端永远正确。
- 优化：HTTP 回报拒绝非正 attempt，验证执行节点、assignment 或执行租约；内部兼容接口与外部回报接口分开。
- 验收：旧代、缺代次、错节点回报均不能改变新 attempt，重复正确回报仍幂等。

**4. P1：普通远程子代理支持排队执行或可靠撤销。**

- 证据：[client.ts:37](../platform/dsh-plugins/subagent-remote/src/client.ts#L37) 收到 202 直接抛错；[provider.ts:189](../platform/dsh-plugins/subagent-remote/src/provider.ts#L189) 只在已收到 201 时尝试失败结算。202 的任务已经在 Scheduler 持久化，并可能随后被 drain 放置。
- 真实 outbox 消费器 [governed-dispatch.ts:77](../platform/dsh-plugins/subagent-host/src/governed-dispatch.ts#L77) 联查 governance task/run，绑定 Worker；普通远程 child 不符合该执行条件，父侧也不再发送 start。由此可能出现“用户已收到失败，但服务端任务随后占槽”的孤儿任务。
- 优化：统一执行信封并实现持久消费，或让父侧等待放置完成再启动远端；调用超时、取消和退出时可靠撤销排队意图。
- 验收：节点满载时新子任务可排队、腾位后执行；父侧取消或重启不会留下无人执行的 PLACED 任务。

**5. P1：消除固定前 32 条造成的队头阻塞。**

- 证据：[drainOnce:345](../platform/control-plane/scheduler/cmd/scheduler/main.go#L345) 每轮只取 32 条；[PendingTasks:891](../platform/control-plane/scheduler/internal/store/store.go#L891) 先按 deadline/priority 截断，之后才进行能力匹配及公平排序。[planner:224](../platform/control-plane/scheduler/internal/planner/planner.go#L224) 的 `served` 每次调用重置。
- 影响：前 32 条一直等待不存在的 GPU、离线 Worker 或其他无法满足的约束时，后面的可执行任务可能一直不被扫描；批内 WFQ 无法提供跨批公平保证。
- 优化：按 realm/queue 分层选择候选，保存公平游标或虚拟服务量；不可调度任务记录原因、退避并延后扫描；批大小配置化，增加等待年龄指标。
- 验收：构造 32 条不可调度任务加第 33 条可执行任务，后者在有界时间内启动；持续负载下测量租户等待时间和权重兑现情况。

**6. P1：日志复制失败需要可靠重试、补洞和健康屏障。**

- 证据：[session-log/index.ts:295](../platform/dsh-plugins/session-log/src/index.ts#L295) 对普通网络/数据库异常只记日志后结束该事件的复制；[flush:333](../platform/dsh-plugins/session-log/src/index.ts#L333) 只等待队列，没有证明事件连续落库；[restore.ts:130](../platform/dsh-plugins/session-log/src/restore.ts#L130) 对缺失 seq 明确拒绝恢复。
- 优化：持久待写队列、连续确认游标、指数退避和补洞；对复制积压设上限，暴露“当前不可恢复”的健康状态。关键副作用前要求相关意图与必要历史达到持久化屏障。
- 限定：完整装配的 recovery 会在工具前写意图，治理 Worker 在 authority 查询失败时会主动中止，不能直接断言所有 PG 分区都会继续执行工具。确定的问题是单次日志复制失败缺少自身补偿闭环。
- 验收：在任意 seq 注入一次短暂写失败，恢复后日志仍从 0 连续，能跨节点重建；不能以 flush 返回成功替代完整性检查。

**7. P1：把请求集群约束与实际执行位置分开。**

- 证据：[PlaceTask:511](../platform/control-plane/scheduler/internal/store/store.go#L511) 保存请求的 `task.ClusterID`；全局请求允许为空，并未写入选中节点的实际集群。[MigratableActiveTasks:55](../platform/control-plane/scheduler/internal/store/migration.go#L55) 却仅按任务 `cluster_id` 匹配 down 集群。
- 影响：不指定集群的任务实际落在 A，A 故障后可能不进入跨集群迁移候选。现有迁移测试直接构造固定集群任务，未覆盖从真实全局放置进入故障恢复的路径。
- 优化：拆分 `requested_cluster_id` 与 `assigned_cluster_id`，后者与 node/attempt 一起持久化；故障处理按实际执行归属查询。
- 验收：全局任务不指定集群，先落 A，再使 A 故障，验证按副作用策略迁移或进入人工恢复，并拒绝旧代结果。

**8. P1：修复 Helm 多 release 隔离与可选配置渲染。**

- [values.cluster.yaml:11](../platform/deploy/helm/lumo-platform/values.cluster.yaml#L11) 指导同 namespace 以第二 release 表达第二集群，但 [service.yaml:19](../platform/deploy/helm/lumo-platform/templates/service.yaml#L19)、[deployment.yaml:51](../platform/deploy/helm/lumo-platform/templates/deployment.yaml#L51) 以及 [dsh-node.yaml:253](../platform/deploy/helm/lumo-platform/templates/dsh-node.yaml#L253) 的 selector 只有服务类型，没有 release/cluster 维度，Service 会选中另一套 release 的 Pod。
- 优化：Service、Deployment、Pod 和相关治理策略统一加入 `app.kubernetes.io/instance`，按需加 cluster 标签；把双 release 同 namespace 安装列为必测组合。已有 Deployment selector 不可原地修改，升级需制定受控重建或迁移方案。
- 另有模板缩进缺陷：[deployment.yaml:324](../platform/deploy/helm/lumo-platform/templates/deployment.yaml#L324) 的 `device-issuer` 卷位于前一个 secret 映射内部。本次将卷片段中的模板表达式替换为固定字符串，用系统 Ruby/Psych 解析，返回 YAML 语法错误；这验证了片段问题，尚未代替完整 Helm 渲染。
- 验收：两个 release 的 EndpointSlice/Pod 选择完全隔离；deviceGateway、governedWorker、provisioner、mTLS 等实际支持组合均可渲染并通过 Kubernetes schema 检查。

**9. P1：明确持久化承诺，建设真正的基础设施 HA。**

- [compose.shared.yml:30](../platform/deploy/compose.shared.yml#L30) Redis 只开启 AOF，未改变默认 `appendfsync everysec`；[AppendWAL:275](../platform/control-plane/collaborator/internal/store/store.go#L275) Lua 写入成功即返回，没有等待持久落盘/副本确认。因此代码注释中的 RPO0 不能扩展为掉电、磁盘丢失或主备切换下的承诺。
- 当前 Compose 的 PG/Redis/MinIO/RocketMQ/Nacos 为单实例，Vault 使用开发形态；compact 把多个逻辑副本放在同一 bundle 容器内，共享故障域。卷持久化、双进程与备份脚本都不能替代主备容灾。
- 优化：单独提供生产 profile，接入运维托管的 HA PG、注册中心、消息与对象存储，替换开发 Vault；明确定义进程、宿主机、可用区三种故障模型下的 RPO/RTO，并做恢复演练。
- 不宜直接把 Redis 改成 Cluster：当前 [Store.New:190](../platform/control-plane/collaborator/internal/store/store.go#L190) 等多处使用单节点客户端，CRDT Lua 的双 key 还需要核对 hash slot。先明确使用单主+故障转移还是分片，再统一客户端和 key 约束。
- 全局与本地调度仍共用同一 PG，中心 PG 断连时并不具备边缘离线自治。若业务确实要求跨地域自治，再设计集群本地持久队列和重连对账。

**10. P1/P2：让真实集群验收成为发布条件，再优化吞吐和弹性。**

- [.github/workflows/ci.yml:228](../.github/workflows/ci.yml#L228) 的 deploy-smoke 仍关闭，原步骤也只是 Local-lite up/down。现有 [acceptance-cluster.sh:92](../platform/deploy/acceptance-cluster.sh#L92) 已接存活检查、行为探针和活库测试，并防止全 SKIP 假绿，应继续利用；[故障操作说明:277](../platform/deploy/README.md#L277) 仍主要是人工停节点、停 leader、pause 和分区示例。
- 优先增加 nightly/release 完整拓扑：双 Scheduler、两个逻辑集群和多个执行节点；断 leader、停执行节点、父进程重启、回执 ACK 丢失、PG/Redis/Nacos 分区、协作文档归属变化。断言唯一结算、连续日志、正确槽位释放、无跨 realm 越权及有界恢复时间，并保存报告。
- [dsh-node.yaml:273](../platform/deploy/helm/lumo-platform/templates/dsh-node.yaml#L273) HPA 只有 CPU 指标，LLM 网络等待时可能 CPU 很低而队列很长。建议按可调度 backlog、最老任务等待时间和可用 slot 伸缩，CPU 作为辅助指标；缩容先撤销准入、从目录下线并等待任务排空。
- 补充 PDB、拓扑分散/反亲和、NetworkPolicy 与可执行的排空 hook。readiness 应反映注册、依赖、制品与调度资格，不能仅看 [subagent TCP 端口:178](../platform/deploy/helm/lumo-platform/templates/dsh-node.yaml#L178)。
- 性能优化须依据实测：先观察排队 p95/p99、放置耗时、DB 锁等待/连接数、日志复制积压、回执最老年龄、失联误判和恢复耗时。再调整 drain 批量、连接池预算、索引、事件通知和批写。暂不据无压测证据扩服务、分库或引入新的调度中间件。

建议分三个里程碑推进：

| 里程碑 | 范围 | 退出标准 |
| --- | --- | --- |
| M1 正确性收敛 | 1–8，优先容量锁、文档 fencing、执行代次、排队闭环 | 对应最小反例成为自动回归；无超配、旧快照覆盖、旧代结算和孤儿任务 |
| M2 可重复多节点验收 | 完整拓扑、故障注入、依赖 HA、真实生产身份、备份恢复 | 每次候选发布有可追溯报告；RTO/RPO 与唯一结算、日志连续性达标 |
| M3 容量与运营优化 | 基于队列的伸缩、排空、数据库预算、SLO/告警通知与成本约束 | 在约定负载下给出实测容量、延迟、恢复与成本曲线，能够安全扩缩容 |

本次实际验证与限制：

- 并行核查了调度容错、跨节点执行和部署测试；高风险的双租约放置与 CRDT 快照覆盖由另一条审计路径复核。
- `compose-ports-verify.sh`：11/11 通过；`compose-images-verify.sh`：12/12 通过。
- 无依赖 Node 探针确认 Seam Proxy 半开熔断窗口可连续放行 10 次请求，未限制单探针并发（[balancer.ts:81](../platform/dsh-plugins/seam-proxy/src/balancer.ts#L81)）。这是后续 P2 优化，可加半开并发闸和抖动退避。
- Ruby/Psych 对 deviceGateway 卷片段的固定值替换解析失败，确认缩进语法问题；未运行完整 Helm 渲染。
- 当前终端无 Go、Helm，checkout 也无 `platform/node_modules` 和 `deepseek-harness/`。未安装依赖，未运行完整 Go/Vitest、实库并发、多节点集成、压力或掉电测试。上述生产风险均不应表述为已发生的线上事故。
- 旧状态文档存在漂移：例如服务端启动日志仍说控制指令下发未接线，但 [control/index.ts:260](../platform/dsh-plugins/control/src/index.ts#L260) 和 [:293](../platform/dsh-plugins/control/src/index.ts#L293) 已提供工具闸门与主动取消/唤醒；不能据 `effectuation=recorded` 就判定控制完全无效。建议维护一张由能力、实现、实际执行测试、环境和证据链接组成的验收矩阵，替代重复手工统计“已关闭”数量。

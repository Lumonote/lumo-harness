# DeepSeek Harness 分布式平台 · 实施蓝图与端到端流程

> 本篇自权威规范 [`architecture.md`](./architecture.md) 抽出（原 §16、§17），**章节编号保持不变**，以维持既有交叉引用有效。
>
> ⚠️ **落地顺序存在替代方案**：评审意见 [`design-review.md`](./design-review.md) §5.2 认为本篇 §16.2/§16.3 的顺序把最高风险的自研工程排在了产品验证之前，建议改为「先单节点垂直切片跑通一个真实组件，再按真实瓶颈引入基础设施」。**决策前请并读两篇。**

---

## 16. 实施蓝图（仓库布局 + 构建顺序 + MVP）

### 16.1 建议仓库布局

```text
platform/
  control-plane/
    edge-gateway/      # Go 自研：TLS/路由/全局限流/WAF
    llm-gateway/       # Go 自研：批处理 + 计量单截面 + 配额 + 模型路由
    connector-gateway/ # Go 自研：Vault/OPA/PII/审计
    terminal-gateway/  # Go 自研：WS/replay/presence/能力协商
    collaborator/      # Go 自研：知识库文档 CRDT 实时协作（Yjs 同步/快照/版本）
    seam-proxy/        # Go 自研：东西向透明转发 + 熔断 + mTLS
    registry/          # Nacos 适配 + 联邦
    scheduler/         # 放置 + 并发闸 + 重平衡
    policy/            # OPA bundle + 评估 SDK
    usage-ledger/      # 计量（PG 明细 + Doris 聚合 + Redis 限流）
    flow-engine/       # DAG 编排 + 算子目录 + 血缘
    trigger-bus/       # cron + webhook + RocketMQ 延时
    agentteams/        # roster/task_board/mailbox（RocketMQ backing）
    provisioner/       # 自动安装 reconcile（组件/skill/MCP）
  data-plane/
    dsh-node/          # 基于 dsh 的节点镜像（改 profile）
    seam-providers/    # PG/Doris/Nebula/Milvus/MinIO/Redis Provider 实现
    connectors/        # HTTP/MCP/SaaS/消息 适配器
  deploy/
    compose.local.yml      # Local-lite: 1 二进制 + 1 PG（秒级启动）
    compose.standalone.yml # 单机形态: 同引擎单节点拓扑
    compose.cluster.yml    # 缩微集群: 2 节点×2 集群 + 中间件单实例（故障注入调试）
    helm/                  # 生产 Cluster 形态
    migrate/               # Standalone → Cluster 迁移工具（一等交付物）
  shared/
    proto/             # gRPC/事件 schema
    manifests/         # component/skill/agent/connector/flow schema
```

### 16.2 构建顺序（P0–P4，均零侵入内核）

```text
P0 对齐扩展点(读 architecture.md, dump-config)          → 不改内核
P1 组件化 + 技能分发(单节点高价值)                       → Nacos 制品注册 + bundle 签名 + 知识库 seam
P2 跨节点能力                                            → SeamProxy + 复制日志 + Scheduler + RocketMQ
P3 智能体分发协同                                        → AgentTeams 分布式(RocketMQ) + 联邦 + RBAC + 自动安装
P4 平台 GA                                              → OPA/Vault/Usage/OTel + 连接器 + FlowEngine + 用户流程分发 + 昼夜弹性
```

### 16.3 MVP 三连（建议首切）

1. **Nacos 注册 + 配置**（控制面 backbone，喂给 Scheduler/SeamProxy 发现与热下发）
2. **自研 Go 边缘网关 + 自研 Go LLM 网关**（SeamProxy + OPA 策略点 + 计量单截面落地网关技术）
3. **一个连接器(MCP/HTTP) + 一个 DAG 流程跑通 Doris→Nebula 血缘**（验证数据面闭环，RocketMQ 触发）

---

## 17. 端到端流程（串联验证各层咬合）

### 17.1 协同任务生命周期
```text
用户(终端)─▶边缘网关(TLS/RBAC)─▶LLM网关(计量单截面/配额)
  → Global Task Bus(RocketMQ) → Scheduler(查 Nacos seam/节点, 放置)
  → Agent 节点 Local Queue → Worker Slot 挂载 preset(isolate realm)
  → agent/pre-step(OPA) → agent/request → ctx.llm(批处理网关)
  → tools/pre-execute(OPA+连接器闸) → SeamProxy → 远端 Provider → tools/post-execute
  → 结果写 Session 日志 → 多端事件汇可见 → Task ack
  · 任一时刻协作者/管理员可下发 pause/resume/stop/abort/approve（§8.4 控制指令，全量入日志）
```

### 17.2 大数据 Pipeline
```text
Agent(Planner)─LLM 生成 DAG─▶FlowEngine.submit
  → guard(schema+防环+OPA) → 血缘写 Nebula → 编译 job → Scheduler(ctx.jobs)
  → 算子经 seam 读写 Doris/Nebula/Milvus/MinIO/PG/Redis → 进度事件 → 多端可见 → sink 可视化
```

### 17.3 多端异步协作
```text
Planner(web)分解 → suspend(continuation 存日志) → 等 future
Worker 异步执行 → mailbox.resolve → future 解析 → Planner resume
Human(mobile)审批 → 边缘网关 → agent.inject() → resume
所有终端经 session/event 一致可见(replay+live)
```

### 17.4 知识库共享编辑 + 多集群监控
```text
多人 + agent 进入同一空间文档 ──▶ CRDT 实时同步(WS) / 评论 @ 人 / 光标可见
  → 发布 = 不可变快照(version N) → reindex 入 Milvus(只索引 published)
  → 跨集群: 全局调度放置 → 每集群 OTel 上报 → 全局监控面(执行/健康/SLO)
  → 预算红线 → 全局降级指令(pause/degrade) → 集群执行 → 结果回全局日志
```

### 17.5 项目工作区闭环（三入口串联）
```text
项目(创建/成员/授权) ──▶ 挂载专家·技能·连接器(目录选择/版本/签名)
  → 配置自动化(cron/webhook/事件触发 → 流程/流水线)
  → 运行(全局调度 §7.4) → 会话/知识库(§5.4.7 共享编辑) → 日志归因(project_id §6.4)
  → 项目仪表板: 用量/预算/集群状态/执行监控 + 控制指令(§8.4)
```

### 17.6 外部连接器调用 + 计量溯源
```text
Agent─ctx.tools:action─▶ConnectorGateway
  → OPA(egress+scope) → Vault 取凭证 → 限速/熔断/PII 脱敏 → 外部 API/MCP
  → 调用记 session 事件(审计) + usage_ledger(feature=..., user/dept/role 溯源)
```


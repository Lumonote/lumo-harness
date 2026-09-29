# 集群运营与容器拓扑重规划

## 目标

让集群管理员能从清晰的入口找到真实可用的页面；提供容器更少的本地开发形态，同时保留完整验收和生产拓扑。精简形态必须明示共享故障域的代价，生产部署继续保留服务隔离与横向扩缩能力。

## 现状盘点

### 页面与导航

- 主导航只展示 5 个工作台，但 `Surface` 实际实现了 10 个工作台。技能管理、连接器、开放设计和 PPT 工作台只能通过命令菜单或其它隐蔽入口找到。
- 用户、部门、角色目录及登录凭证管理已经实现在 `OrganizationManagement`，但它嵌在个人「用户中心」页面底部，且只对集群管理员显示。个人账户安全与平台组织治理因此混在一起。
- 节点目录、服务健康、调度操作已在项目运营面板中；受管桌面节点的注册、策略、证书与命令队列由 `ClusterNodesPanel` 处理。两者是不同对象，不应合成一个含糊的“节点”页面。
- Compose 中 Prometheus、OPA、Vault、Nacos、PostgreSQL 等服务没有逐一对应的产品页面。对它们应在服务健康摘要中显示状态，不能为了菜单对称而造空白管理页。

### 构建与运行容器

| 形态 | Compose 声明服务 | 默认活动容器 | 用途 |
|---|---:|---:|---|
| Cluster 完整 | 36 | 34 | 保留逐进程容器；两个 `provisioner` profile 服务默认不启动 |
| Cluster compact | 38 | 30 | 六个集群专属进程容器并入两个 per-cluster bundle；另有两个 `provisioner` profile 服务默认不启动 |
| Standalone | 22 | 20 | 两个 `provisioner` profile 服务默认不启动 |
| 镜像构建目标 | 4 个 Dockerfile / 5 个运行目标 | — | `control-plane`、`provisioner`、`dsh-node`、`console`，以及 `dsh-node` 内的 `cluster-bundle` 变体 |

12 个 Go 控制面程序已经打包在同一个 `control-plane` 镜像里，Compose 的多个服务名是不同运行进程/副本，不是 12 次独立镜像构建。需要分别统计镜像构建目标、Compose 声明服务和 profile 实际启动容器，不能把它们统称为“容器数”。Cluster 清单中的每个逻辑集群包含 agent 父节点、node 承载节点和专属 Scheduler；node 承载节点及 Scheduler 都参与该集群的注册/健康语义。它们是必须保留的运行进程身份，但不要求一进程一容器。

## 目标信息架构

| 导航域 | 页面 | 主要职责 | 可见条件 |
|---|---|---|---|
| 工作 | 协作空间、项目运营、资料库 | 任务协作、项目与流程、知识来源 | 按部署能力显示 |
| 平台运营 | 集群与服务、用户与角色 | 集群/节点健康、调度；用户、部门、身份源、角色及授权 | 集群就绪；组织页另需管理员角色 |
| 平台治理 | 技能管理、连接器 | 授权、版本、连接器能力与状态 | 后端能力已装配 |
| 创作与发现 | 开放设计、PPT 生成、技能中心、更多 | 原有创作插件、专家与制品目录 | 对应运行时/插件可用 |
| 我的账户 | 用户中心 | 当前用户的登录方式、MFA、Passkey、会话和安全事件 | 当前登录用户 |

不为每个 Docker 服务创建一个页面。一个运营页面可以聚合多个相关服务；只有存在稳定 API、明确操作者和可验证结果时才提供管理动作。

### 已完成的可见性调整

- 侧栏列出已实现的技能、连接器、开放设计和 PPT 工作台。
- 将个人中心底部的组织管理入口移到「项目运营 → 用户与角色」；入口仅在集群已就绪且当前用户具有管理员角色时显示。
- 将服务健康页签命名为「集群与服务」，保留现有节点和调度入口；个人中心只负责个人身份与安全。

### 后续页面分层

1. **集群总览**：列联邦集群 ID、realm、版本、心跳年龄和派生健康状态；提供到节点明细的入口。
2. **节点与桌面设备**：通用执行节点与受管桌面设备分别展示；设备页面保留登记、排空、策略、激活和命令历史。
3. **组织与权限**：用户、部门、角色目录、用户角色期限、登录方式。读写都由现有 Governance API 与服务端角色门禁决定。
4. **运行服务**：按“入口与会话、协作与调度、组织与项目、制品与知识、基础设施”分组显示健康状态；缺少管理 API 的基础设施只显示健康与诊断链接。
5. **制品与审计**：Registry 分发、Connector 调用审计、用量台账只在各自 API 和权限边界可用时开放独立分区。

## 统一 Compose 配置与容器边界

### 配置分层

单例与集群共用同一项目名 `lumo-platform`，并由 `up.sh` 组合三层配置：

1. `compose.shared.yml` 是共享基础服务的唯一来源：PostgreSQL、Redis、MinIO、RocketMQ、Nacos、Prometheus，以及持久化卷。
2. `compose.control-plane.bundle.yml` 是共享控制面运行时：10 个 Go API、Scheduler 和 Collaborator 由一个 supervisor 容器启动，原端口和 DNS alias 保留。
3. `compose.standalone.yml` 或 `compose.cluster.yml` 只声明形态差异；Cluster 默认叠加 compact 运行拓扑，full 使用 `cluster-full` profile，验收与设备监听仍用单独覆盖。

这样切换单例和集群使用相同基础服务与数据库卷定义；同一时刻应只运行一种服务器形态。RocketMQ 的 NameServer、Broker 和 Proxy 在一个容器中按顺序启动，NameServer 供同容器 Broker 使用 `127.0.0.1:9876`。

### 容器拓扑

| 形态 | 默认活动容器 | profile 展开后的完整形态 | 主要合并边界 |
|---|---:|---:|---|
| Standalone | 8 | — | 10 个 API、Scheduler、Collaborator 进程共用 `api-bundle`；RocketMQ 三个进程共用一个容器 |
| Cluster compact | 16 | — | 10 个 API、两个全局 Scheduler、两个 Collaborator 进程共用 `api-bundle`；每集群 agent、node、Scheduler 放进一个 bundle |
| Cluster full | — | 24 | 共用基础服务与 API bundle；全局/每集群 Scheduler、Collaborator、DSH 进程分别运行，便于故障域验收 |

容器数包含共享基础服务、数据/模型服务、应用与 Prometheus，不含未启用的 `provisioner` profile。合并只改变容器边界：API 和 DSH 的子进程仍独立监听，保留 instance/node/cluster 身份、端口、健康检查和 Nacos 上报。一个 bundle 内任一关键子进程退出会让 supervisor 退出并由 Docker 重启整个容器，因此 compact 适合本地开发和资源受限部署，full 用于进程故障注入；生产需要横向扩缩时继续使用 Helm 的独立 Deployment。

`provisioner`、`artifact-runtime`、向量模型、Milvus/etcd、OPA 和 Vault 继续按资源、持久化或权限边界独立运行。只有具有独立伸缩/故障隔离价值的边界才保留单独容器；代码模块数量不决定容器数量。

### 持久化迁移

统一项目名会让新卷使用 `lumo-platform_*` 名称。旧版本的 `lumo-platform-cluster_*` 与 `lumo-platform-standalone_*` 卷会保留，但 Compose 不会自动把它们挂到新服务，也不会自动合并两套 PostgreSQL 数据。切换已有部署前必须先备份并选择要保留的环境数据，再显式恢复到新拓扑；不能只执行 `up --force-recreate`。迁移与备份脚本必须组合共享文件和对应形态 overlay，并把 Registry 备份目标映射到 `api-bundle`。

### 已实现页面

原生 DSH 主导航显示已实现的技能、连接器、开放设计和 PPT 工作台；平台运营把已有用户/部门/角色管理放入“用户与角色”，仅集群就绪且具管理员角色时显示。节点目录、服务健康、调度与桌面设备继续使用已有 API 页面，不为没有管理 API 的中间件造空页面。

## 实施顺序与验收标准

1. **导航与用户管理（本次）**：管理员可以从项目运营入口进入用户/角色管理；非管理员看不到该入口；已有工作台可从侧栏直达；个人安全页不再承载平台组织管理。
2. **控制面 bundle 实现**：10 个 API、Scheduler 与 Collaborator 在 Standalone 和 Cluster compact 共用一个控制面容器；full 仍逐进程运行，所有逻辑服务端口、身份和健康探针保留。
3. **Cluster bundle 实现**：默认每个 cluster-a/cluster-b 用一个 DSH bundle 容器；所有逻辑 node、agent、scheduler 进程与服务发现地址保持可观测；完整独立容器拓扑仍可显式启动。
4. **运营页补齐**：先上集群总览，再加入制品和审计分区。每个页面都要映射到具体 API 和角色，不支持的操作明确禁用或标记未装配。

本次已完成导航可见性、单例/集群共享配置、统一控制面 bundle、单容器 RocketMQ，以及 Cluster compact/full 两种进程布局。目标拓扑分别是 Standalone 8 个、Cluster compact 16 个、Cluster full 24 个活动容器；运行时数据迁移仍需按上文要求通过备份与恢复显式执行。未实现的中间件管理 API 不生成空页面。

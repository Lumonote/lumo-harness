# Cluster 组织治理、桌面节点与制品分发设计

- 日期：2026-08-28
- 状态：设计基线；实现状态以 [`../../implementation-status.md`](../../implementation-status.md) 为准
- 约束：遵守 [`../../architecture.md`](../../architecture.md) 的 realm 隔离、Nacos/Registry/Provisioner 职责分离、OPA 单一策略点，以及「不改 dsh 源码」第一铁律
- 相关设计：[制品注册表](./2026-08-24-registry-design.md)、[制品治理与 Provisioner](./2026-08-26-registry-governance-design.md)、[项目工作区](./2026-08-26-project-workspace-design.md)、[用户流程](./2026-08-26-user-flows-design.md)

## 1. 目标与最终决策

本设计把以下需求收敛为一条 Cluster 专属链路：可安装的 PC 端软件注册为受控节点，运营端可见其运行状态；组织可按用户、角色、部门、项目治理技能；专家、技能、连接器、插件和 CLI 以不可变制品分发到已注册节点；用户可创作低风险技能或基于已审批制品构建新的 Bundle。

最终决策如下：

1. 只有服务端 `deployment_mode=cluster` 且集群状态为 `ready` 时，组织治理、远程节点、跨节点制品分发和多 Agent 委派才可用。UI 隐藏不是安全边界，所有 API、任务提交和安装计划都必须再次校验。
2. PC 端是 `desktop-worker`，通过 Node Gateway 的出站 mTLS WebSocket 接入；不把企业桌面设备直接暴露给 Nacos 或 Scheduler。Gateway 将健康状态与能力投影到 Nacos Naming，供控制面发现。
3. Nacos 只保存目标节点的期望态、灰度/撤销规则和变更通知；原始包放内容寻址对象存储，元数据与审计放 PostgreSQL。节点安装时必须按 digest 重新下载、验签并重解析 manifest。
4. 用户、角色、部门是治理对象；项目是使用与计量边界；技能和其他制品是可分发能力；Agent/专家是实际执行主体。组织上下级不自动等同于权限继承或能力转授。
5. 用户自定义内容一律产生新版本和新 digest。Overlay/合并产物是新的不可变 Bundle，绝不覆写基础制品或扩大已审批的 scope。

## 2. 部署形态与功能门禁

形态由服务端配置决定，不由「是否装了 Nacos」「节点数是否大于一」或「能否访问 Scheduler」推断。

| 能力 | Local-lite | Standalone | Cluster（`ready`） |
|---|---|---|---|
| 本地预置/本地目录技能 | 支持 | 支持 | 支持 |
| 本机私有技能与本机 Agent | 支持 | 支持 | 支持 |
| 用户、角色、部门目录 | 不支持 | 不支持 | 支持 |
| 跨用户/角色/部门技能分发 | 不支持 | 不支持 | 支持 |
| 桌面节点注册与运营观察 | 不支持 | 不支持 | 支持 |
| 跨节点 Provisioner / 灰度 / 撤销 | 不支持 | 不支持 | 支持 |
| 上下级多 Agent 委派与独立子任务 | 不支持 | 仅本机本地协作 | 支持 |

### 2.1 统一门禁契约

所有 Cluster 专属入口先执行同一个判断：

```text
requireClusterReady(request):
  deployment_mode == "cluster"
  AND cluster.status == "ready"
  AND actor.realm == target.realm
```

不满足时返回：

```json
{
  "code": "CLUSTER_ONLY",
  "message": "该功能仅在状态为 ready 的 Cluster 部署中可用"
}
```

受该门禁约束的接口包括组织树、角色管理、技能授予/撤销、桌面节点注册、Rollout、跨节点安装计划、节点列表、上级委派和远程任务控制。前端使用同一份 feature descriptor 渲染入口，但不得自行放行。

```json
{
  "deployment_mode": "cluster",
  "cluster_status": "ready",
  "features": {
    "organization_governance": true,
    "skill_distribution": true,
    "desktop_workers": true,
    "artifact_rollouts": true,
    "cross_node_delegation": true
  }
}
```

## 3. PC 端软件与节点注册

### 3.1 PC 应用边界

PC 端软件由安装包（Windows NSIS、macOS PKG/DMG、Linux 包）交付，包含用户界面、受限的本地 Worker 运行时、更新器和节点证书存储。它不是控制面副本，也不直接访问 PostgreSQL、Vault、Scheduler 管理接口或任意 Nacos namespace。

节点分两类：

| 节点 | 注册路径 | 适用任务 |
|---|---|---|
| `server-worker` | 受管运行环境直接以工作负载身份注册 Nacos Naming | 服务端常驻任务、受控连接器、生产任务 |
| `desktop-worker` | PC 应用以出站 mTLS WebSocket 连接 Node Gateway，由 Gateway 投影到 Nacos | 用户确认的本地工具、个人知识、低风险/显式允许的任务 |

桌面设备只接受出站连接，避免要求用户网络开放入站端口。Gateway 是桌面连接的唯一接入点，负责证书校验、会话绑定、心跳、命令转发和审计；Nacos 仍是控制面内部的节点目录。

### 3.2 激活、身份与生命周期

```text
管理员/用户创建一次性设备激活码
  → PC 登录 SSO 并交换短期 bootstrap token
  → Node Gateway 校验用户、realm、设备策略和激活码
  → 设备生成本地密钥对，Gateway 签发轮换 mTLS 证书
  → desktop-worker 建立出站 WSS、上报画像和 heartbeat
  → Gateway 写 Nacos 临时实例 + 节点状态表
  → Scheduler/运营端只消费经校验的节点目录
```

节点状态机：

```text
PENDING_ACTIVATION → ONLINE → DRAINING → OFFLINE
                                │            │
                                └→ REVOKED ←─┘
```

- `PENDING_ACTIVATION`：尚未取得有效设备身份，不参与调度。
- `ONLINE`：心跳、客户端版本、策略版本和能力声明均有效，可成为候选节点。
- `DRAINING`：不再接受新任务，既有任务按策略完成、取消或迁移。
- `OFFLINE`：心跳过期或连接断开；Scheduler 按任务可恢复性进行对账，不能把断开误判为已完成。
- `REVOKED`：用户禁用、设备遗失、证书撤销或安全基线不满足；立即拒绝新任务和新制品安装。

节点画像至少包含 `node_id`、`realm_id`、`cluster_id`、`kind`、`owner_user_id`、`os/arch`、客户端版本、能力、数据驻留域、当前负载、心跳时间和安全姿态。设备序列号、IP、精确地理位置等敏感信息只按运营需要最小化保存和展示。

### 3.3 桌面设备安全与调度限制

桌面节点默认不是生产执行节点。下列条件同时满足，Scheduler 才能把任务放到 `desktop-worker`：

```text
任务明确允许 desktop-worker
∩ 节点在线且不处于 draining/revoked
∩ 节点已安装任务要求的精确 digest
∩ 设备安全版本、OS/CPU 与数据驻留要求匹配
∩ 用户授权与 OPA 对本次任务均放行
∩ 任务风险等级允许本地执行
```

高风险连接器、生产写操作、任意 Shell、无受控网络出站的 CLI 和未审核插件默认不得投放到桌面节点。桌面 Worker 中的 CLI 必须经声明式工具接口调用，并受参数 schema、文件根目录、网络、CPU/内存、超时、输出大小与审计控制；Prompt 不能获得任意 Shell。

### 3.4 运营端节点视图

运营端至少提供：

- 节点列表与按 realm、集群、部门、节点类型、状态、能力和版本筛选；
- 节点详情：归属用户、设备姿态、安装代际、运行任务、心跳、错误和审计记录；
- 启用、禁用、drain、证书撤销、重试 reconcile、按节点/标签/部门灰度发布；
- 安装矩阵：期望版本、实际版本、desired/applied generation、失败码与上次对账时间。

运营端可查看不等同于可控制：对用户设备、部门范围和生产节点的操作仍按 OPA 与组织范围授权。

## 4. 组织、角色和项目边界

### 4.1 模型分层

| 对象 | 职责 | 不应被误解为 |
|---|---|---|
| User | 登录身份、任务责任人、设备归属 | 自动拥有部门所有技能 |
| Role | 一组平台管理/操作权限 | 自动拥有所有高风险工具 |
| Department | 单父节点组织树与管理范围 | 角色继承树或协作组 |
| Project | 工作区、授权使用范围、并行预算树 | 第六类制品 |
| Skill / Artifact | 可被授予或安装的能力 | 一经可见即可执行 |
| Agent / Expert | 持有技能快照并执行任务的主体 | 用户权限的无限代理 |

每个用户有一个主部门，可额外加入项目或协作组；协作组不塞入部门树。部门采用 realm 内单父树和物化路径，移动部门必须拒绝移入自身子树并写审计。

```text
集团
├─ 技术中心
│  ├─ 平台部
│  └─ 算法部
└─ 业务中心
   ├─ 华东区
   └─ 华南区
```

角色可以组合/继承角色，但必须无环。部门上下级只提供 ABAC 管理范围，例如「actor 的部门是 target 部门祖先」；它不自动产生 `realm_admin`、高风险 scope 或隐式技能授权。

### 4.2 组织数据与权威来源

SSO/LDAP/企业通讯录是用户基础身份、部门与在职状态的权威来源。平台保存同步投影，并只允许受控的本地管理员为紧急/本地账号写入；普通部门管理员不能任意篡改基础身份。

建议表结构如下（全部带 `realm_id`、审计列与软删除/状态列）：

```sql
users(user_id, realm_id, username, display_name, primary_dept_id,
      manager_user_id, status, source, last_login_at)
departments(dept_id, realm_id, parent_dept_id, name, manager_user_id,
            path, level, status)
roles(role_id, realm_id, name, description, parent_role_id, status, source)
role_permissions(role_id, permission, effect)
user_roles(user_id, role_id, expires_at, granted_by)
user_department_memberships(user_id, dept_id, membership_kind)
```

内置角色可包括 `platform_admin`、`realm_admin`、`dept_manager`、`project_owner`、`project_editor`、`operator`、`viewer`、`agent_operator` 与 `auditor`。权限采用 `resource:action`，如 `skill:assign`、`artifact:publish`、`node:manage`、`task:delegate`；具体放行仍由 OPA 结合资源归属、部门路径、项目和风险等级判定。

## 5. 技能定义、分发与有效能力

### 5.1 技能风险分级

| 类别 | 示例 | 默认处理 |
|---|---|---|
| Prompt Skill | 写作规范、行业知识、提示模板 | 用户可私有创建与使用 |
| Workflow Skill | 有限的分析/审批流程 | 用户可创建低风险草稿，发布需审核 |
| Tool Skill | 数据查询、内部 API 调用 | 受控制品，需 scope、OPA 与审核 |
| Connector Skill | CRM、邮件、Jira、数据库连接器 | 高风险受控制品，凭证只从 Vault 解析 |

用户创建的技能必须有不可变版本、digest、作者、风险级别、依赖和 scope 声明。包含命令执行、本地文件访问、外网、凭证、数据库写、对外发信、任务触发或 GPU/本地模型的内容不得以普通 `SKILL.md` 直接放行，必须进入制品治理流程。

### 5.2 授予、撤销与版本选择

技能可授予 `user`、`role`、`department`、`project` 或 `agent`，部门授权可选择是否下传子部门。授权与撤销分别留痕：

```sql
skill_grants(grant_id, realm_id, skill_id, version_constraint,
             subject_type, subject_id, scope, include_children,
             expires_at, granted_by)
skill_revocations(revoke_id, realm_id, skill_id, subject_type, subject_id,
                  reason, expires_at, revoked_by)
```

有效技能按以下顺序决策：

```text
用户显式撤销
  > 用户直接授予
  > 项目授予
  > 角色授予
  > 当前部门授予
  > 祖先部门的 include_children 授予
  > 默认拒绝
```

命中多个版本约束时，解析为唯一精确版本；无法解析、版本冲突、版本已撤销或 scope 超出当前任务上限时失败关闭，不能静默挑选“最新”。技能已被分发不代表本次工具调用自动允许，仍需 OPA 验证用户、角色、部门、项目、任务、节点、数据驻留和风险状态。

### 5.3 用户自定义技能生命周期

```text
DRAFT → VALIDATING → PRIVATE → REVIEWING → APPROVED → SIGNED → PUBLISHED → DEPRECATED
```

作者默认只能编辑草稿、私有运行、提交审核和查看自己的记录。给他人/部门/全局分发、声明高风险 scope、引用凭证、执行 CLI 或覆盖系统技能需要相应角色与审核。发布时重新执行 manifest、路径、大小、依赖、digest、scope、OPA、SBOM/license 与沙箱验证，不能复用草稿期的结论。

## 6. 制品、Bundle 与 Nacos 分发

### 6.1 逻辑制品与运行载荷

本设计沿用架构总纲的逻辑制品边界，不为“文件形态”无止境增加新的权限类别：

| 面向用户的名称 | Registry 逻辑形态 | 分发/装载形态 |
|---|---|---|
| 专家 | Agent / Expert preset | 引用技能、组件、连接器和策略的不可变描述 |
| 技能 | Skill | 本地经校验的 Skill Snapshot |
| 插件 | Component | Cordis plugin/bundle，经声明的 entrypoint 装载 |
| 连接器 | Connector | 连接器 manifest；凭证从 Vault 动态获取 |
| CLI | Connector 的 executable/MCP 子形态或受限 Component 工具面 | 受 sandbox 约束的声明式可执行工具，非任意 Shell |
| 流程 | Flow | 已发布 DAG 快照 |
| Bundle | 部署组合物，不新增授权 kind | 一组精确制品版本的不可变、可签名闭包 |

这样既能支持用户所称的插件和 CLI，又不会把同一安全边界拆成相互矛盾的第六、第七类权限模型。

### 6.2 存储与通知职责

| 内容 | 真正落处 | 允许的用途 |
|---|---|---|
| 原始包、manifest、二进制、SBOM | 内容寻址对象存储（MinIO/S3） | 安装端按 digest 取原始字节并执法 |
| 制品索引、签名、依赖图、审批、安装回报 | PostgreSQL | 查询、闭包解析、审计和运营展示；不是安装信任根 |
| 目标节点期望态、灰度、撤销、动态配置 | Nacos Config | 热通知与对账的目标状态 |
| 受管服务/节点健康与能力 | Nacos Naming | 控制面发现与调度候选 |
| 已验证制品缓存与 `install-state.json` | 节点本地 | 原子切换、重启恢复和篡改检测 |

Nacos 中只发布期望态，不发布大文件和不可信明文凭证。按 realm 和 cluster 隔离：

```text
namespace: realm-{realm_id}
group:     LUMO_ARTIFACTS / LUMO_ROLLOUTS / LUMO_REVOKES
dataId:    cluster.{cluster_id}.desired.json
           cluster.{cluster_id}.rollout.json
           cluster.{cluster_id}.revoke.json
```

```json
{
  "schema_version": 1,
  "generation": 42,
  "cluster_id": "cluster-a",
  "bundles": [{
    "artifact_id": "bundle.customer-service-enterprise",
    "version": "1.0.0",
    "digest": "sha256:…",
    "object_uri": "s3://lumo-artifacts/sha256/…",
    "target": {
      "node_kind": ["server-worker", "desktop-worker"],
      "capabilities": ["cpu"]
    }
  }],
  "revoked_digests": []
}
```

节点启动、心跳和定时 reconcile 都必须主动对账；Config listener 只用于缩短收敛时间，不能成为唯一可靠性机制。

### 6.2.1 Bundle 与导出格式：JSONL + zstd

制品 Bundle、节点安装清单快照以及可下载的审计/安装历史导出统一采用
**JSONL + zstd**：对象扩展名为 `.jsonl.zst`，HTTP 传输为 `Content-Type: application/zstd`
并声明原始媒体类型 `application/x-ndjson`。JSONL 保留逐条可校验、可流式处理和故障定位的
边界，zstd 用于高压缩率和快速解压；它们不取代 PostgreSQL 的事务表、Nacos Config 的小型
期望态 JSON 或 HTTP API 的请求/响应 JSON。

一个 Bundle 的解压内容是严格的记录流：

```json
{"type":"bundle-header","schema_version":1,"bundle":"bundle.customer-service","version":"1.0.0"}
{"type":"artifact","name":"skill.enterprise-policy","version":"2.0.0","digest":"sha256:…"}
{"type":"entry","path":"skills/enterprise-policy/SKILL.md","encoding":"utf8","sha256":"…","data":"…"}
{"type":"entry","path":"bin/pdf-render","encoding":"base64","sha256":"…","data":"…"}
{"type":"bundle-footer","entry_count":2,"content_digest":"sha256:…"}
```

- 每条记录恰好一行 UTF-8 JSON，不允许空行、重复键或未声明的 `type`；`entry.path` 必须是
  相对路径，拒绝符号链接和目录穿越。
- 压缩流字节、解压后的整包、每个 entry 和行数都有独立上限；解压器还必须限制 zstd window，
  防止压缩炸弹。
- `bundle-header` 与 `bundle-footer` 各且仅有一条，footer 的条目数与内容 digest 必须匹配；
  每个 entry 在落盘前再校验自己的 sha256。
- Registry 对**原始 `.jsonl.zst` 字节**计算 digest 并签名，节点不重新压缩或重序列化再验签；
  读取时先验签压缩字节，随后流式解压、严格解析和逐 entry 校验。PG 中的解析投影只供展示和
  依赖查询，不能替代安装端验证。
- JSONL 记录不得携带 Token、密码或 Vault Secret；连接器仅引用 `secret_ref`，运行时凭证仍从
  Vault 获取。

### 6.3 安装与回滚链路

```text
上传临时对象
  → Registry 校验与构建/合并
  → 审批、签名、写入 PG 索引
  → 生成 Cluster Desired State
  → 发布 Nacos Config
  → Provisioner 接收通知并主动对账
  → 下载原始字节、重算 digest、验签、重解析 manifest
  → 校验 requires、scope、设备与部署形态
  → 原子安装/切换并写 install-state
  → 回报 applied generation 与实际 digest
  → Scheduler 仅使用已满足精确 digest 的节点
```

`node_artifact_installations` 至少包含节点、制品、desired/applied version 与 digest、desired/applied generation、状态、错误和对账时间。状态为 `PENDING`、`DOWNLOADING`、`VERIFYING`、`INSTALLING`、`ACTIVE`、`FAILED`、`ROLLED_BACK`、`REVOKED`、`INCOMPATIBLE`。新版本失败时旧版本保持 `ACTIVE`；回滚是重新发布旧的精确版本，撤销是禁止新使用并由风险策略决定是否安全停止。

### 6.4 用户 Overlay 与不可变 Bundle

“合并”不是文件覆盖，而是构建一个新的制品闭包：

```text
基础专家 + 已批准技能 + 已批准插件/连接器 + 用户 Overlay + 组织配置
                                      ↓
                           新 Bundle（新版本、新 digest、新签名）
```

合并必须失败关闭，至少拒绝：

- 试图改写系统安全策略、realm、OPA 规则、审计配置或最高权限；
- 增大任一输入制品已批准的 scope，或引入未审批依赖；
- plugin id、entrypoint 或工具名冲突；
- 不可解析的依赖版本、符号链接、目录穿越、隐式安装脚本；
- 把 Token、API Key、密码写进 Bundle/Nacos；
- 未声明网络访问、任意 Shell 或与桌面策略不兼容的 CLI。

合并后的 Bundle 仍需完整走验证、审批、签名、注册和灰度，不能因基础制品已审批而跳过。用户私有 Bundle 默认只可在所属项目的受允许节点测试；跨部门、全局或生产投放必须提升审核范围。

## 7. 多 Agent 协同与上下级委派

上级关系只定义可管理范围，不让父任务把自己的权限“借给”子任务。委派时为每个子任务计算独立技能快照：

```text
child.allowed_skills =
  parent.task.allowed_skills
  ∩ delegatee.effective_skills
  ∩ project.allowed_skills
  ∩ target_node.installed_artifacts
  ∩ OPA.allow(task, actor, node)
```

任何一项为空或不满足精确版本时，子任务拒绝创建或保持等待 Provisioner 收敛；父任务不得绕过此交集将高权限连接器、CLI 或密钥能力转交给下属。共享会话可共享结果和事件，不合并各 Agent 的工具权限；实际执行方的身份、技能快照和 OPA 判定始终是审计主体。

任务可以是协作 DAG 的一部分，也可以独立分配给下属。控制面必须记录委派者、受派者、父任务、项目、技能快照、节点、授权依据、开始/结束和终态。暂停、取消、重派等控制命令走既有全局控制信号与审计链路。

## 8. API、审计与验收

建议在现有控制面 API 下增加或收敛以下资源：

```http
GET    /v1/features
GET    /v1/nodes
GET    /v1/nodes/{id}
POST   /v1/nodes/{id}/drain
POST   /v1/nodes/{id}/reconcile
POST   /v1/nodes/{id}/revoke

GET    /v1/users/{id}/effective-skills
GET    /v1/departments/tree
POST   /v1/departments
PATCH  /v1/departments/{id}
POST   /v1/roles
PUT    /v1/users/{id}/roles/{roleId}

POST   /v1/skills
POST   /v1/skills/{id}/versions
POST   /v1/skills/{id}/submit
POST   /v1/skills/{id}/approve
PUT    /v1/{subjects}/{id}/skills/{skillId}
DELETE /v1/{subjects}/{id}/skills/{skillId}

POST   /v1/artifacts/uploads
POST   /v1/artifacts/{id}/merge
POST   /v1/artifacts/{id}/register
POST   /v1/rollouts
POST   /v1/rollouts/{id}/pause
POST   /v1/rollouts/{id}/rollback
```

所有写接口必须带 realm、身份、幂等键、操作原因和审计事件；会改变其他用户、部门、节点或生产运行状态的操作还必须通过 OPA。审计事件至少记录操作者、授权路径、目标、旧/新 generation、结果、拒绝原因与关联 trace。

发布前的最低验收场景：

1. Standalone 调用任一 Cluster API 返回 `CLUSTER_ONLY`，即使本机装有 Nacos。
2. 一台已激活桌面设备在运营端出现为 `ONLINE`，断开后在心跳阈值内变为 `OFFLINE`，且 Scheduler 不再放置新任务。
3. 目标节点未安装精确 digest 时，Scheduler 返回 `NO_COMPATIBLE_ARTIFACT_NODE`，不会临时跳过验签安装。
4. 用户显式撤销技能能够覆盖角色/部门继承；角色或部门移动后，有效技能计算可解释且写审计。
5. 父任务无法把自身独有的高风险技能委派给下属；子任务的技能快照是上述交集。
6. Bundle 合并遇到 scope 扩大、入口冲突或隐式执行内容时失败；成功产物具备新的 digest、版本和审批记录。
7. 安装包被替换、篡改或签名撤销时，Provisioner 拒绝激活；升级失败不删除旧 `ACTIVE` 版本。

## 9. 非目标与后续切片

本设计不把 SSO/LDAP 的具体供应商协议、Windows/macOS 签名基础设施、MCP/SaaS OAuth 适配、MDM/设备证明供应商、跨 realm 组织联邦或桌面远程控制协议写死。它们必须在不改变上述身份、审计、最小权限与 fail-closed 契约的前提下以适配器接入。

实施顺序建议为：先落统一 Cluster 门禁和组织/节点数据模型，再接 PC 注册与运营视图；随后接技能授权计算和任务快照；最后接用户 Overlay/Bundle、灰度与跨节点联合演练。每个切片都以真实 Registry/Provisioner/Scheduler/Nacos 链路测试验收，不用 UI 演示替代服务端授权与安装验证。

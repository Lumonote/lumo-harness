# 集群管理接口与使用边界

本文件记录 2026-09-07 的开发范围。新增 Lumo 管理入口要求 `LUMO_DEPLOYMENT_MODE=cluster` 和 `LUMO_CLUSTER_STATUS=ready`。Local、Standalone 的原有装配、技能安装及工作流入口保持原路径；运行测试进展见对应小节，真实集群联调仍待验收。

## 用户、部门和角色

Governance 的组织管理写操作要求同 realm 的 `realm_admin`、`platform_admin` 或 `admin`。浏览器不提供可信身份；Lumo 代理从已验证的会话生成上游身份断言。

| Governance 接口 | 行为 |
| --- | --- |
| `POST /v1/users` | 同事务创建用户与 bcrypt 登录凭证；ID 和登录名冲突返回 409 |
| `PUT /v1/users/{userID}` | 管理员修改显示名称、主部门及状态 |
| `GET /v1/users/{userID}/access` | 返回登录名、可登录状态和含期限的角色分配，不返回凭证摘要 |
| `PUT /v1/users/{userID}/credentials` | 设置或重置登录名/密码，撤销会话并清除相关登录锁定记录 |
| `PUT /v1/users/{userID}/roles/{roleID}` | 分配或更新角色期限 |
| `DELETE /v1/users/{userID}/roles/{roleID}` | 撤销角色 |
| `PUT /v1/roles/{roleID}` | 修改名称、说明及启停状态 |
| `PUT /v1/departments/{departmentID}` | 修改名称、上级、负责人及状态；移动部门时更新整个子树路径 |

用户创建字段为 `id`、`display_name`、`primary_dept_id`、`username`、`password`。密码遵循既有密码策略；不会自动赋予管理员角色或发送邀请。角色期限使用 RFC 3339 时间，`null` 表示长期有效。

组织写操作使用 realm 级 PostgreSQL 事务锁。撤销角色、停用角色或停用用户不能移除最后一个可登录管理员，也不能只留下临时管理员而移除最后一个长期管理员。部门移动拒绝环；含有效用户或有效子部门的部门不能停用。

用户状态、凭证和角色变更写入既有个人安全事件表。集群认证代理仅合并同时进行的身份查询，不缓存已完成查询；已有 WebSocket 每 5 秒重新核对会话、用户、角色和部门。失效或身份变化后连接断开。Standalone 保留 15 秒缓存与原连接行为；Local 不装配此代理。

## 技能与节点

`GET /v1/skills/{skillID}/access` 返回技能授权和禁用规则；管理员通过既有 `POST .../grants`、`POST .../revocations` 新增规则，并通过 `DELETE .../{grants|revocations}/{id}` 移除规则。授权对象可为用户、角色、部门、项目或 Agent；授予时校验对象在当前 realm 有效，指定版本必须存在，子部门继承仅适用于部门。

`PUT /v1/desktop-nodes/{nodeID}/state` 接受 `DRAINING`、`REVOKED`、`PENDING_ACTIVATION`，同时清除调度资格。已撤销节点不能恢复或被重新登记覆盖；排空状态不会被心跳重置。只有在线、心跳有效且已有调度资格的节点才显示为可调度。

这里的“重新激活”只恢复待激活状态。真正成为可调度节点仍需接入设备 mTLS 身份、受信任制品安装及激活验收，不在页面中直接设置 `ONLINE` 或调度资格。

## 项目、Agent 和连接器

项目成员面板代理既有 Projects 的添加、修改角色及删除接口，仅项目 owner 可编辑，归档项目只读。最后一个项目 owner 的保护由 Projects 服务执行。

Agent 编辑使用 `PATCH /v1/agent-presets/{id}`，提交读取时的 `revision`。资产所有者可修改运行配置，realm 管理员还可转移所有者和项目范围；新配置不会伪造 Worker 已上线。冲突时保留当前编辑内容，重新读取后再修改。

### 受治理 Agent 文本执行

集群承载节点可绑定一个确定的 Agent、所有者、项目、预设修订和模型。
启动时设置已有的 `LUMO_AGENT_ID`、`LUMO_USER_ID`、`LUMO_PROJECT_ID`，
并设置 `LUMO_AGENT_PRESET_REVISION`、`LUMO_AGENT_PROVIDER`、
`LUMO_AGENT_MODEL`。`LUMO_NODE_CAPACITY` 不得超过预设的并发上限。
同时需要可用的 Governance 地址、控制面令牌、realm 令牌，以及与
Scheduler/Governance 共享的 PostgreSQL。Helm 的对应入口是
`dshNode.governedWorker`，默认关闭。

当前执行范围为文本交付。带工具/连接器、知识空间、外部系统提示引用或金额
预算的预设不会被此执行配置上报为可用。任务保留上级目标、继承约束和验收
条件；执行器不开放宿主工具。每个 Run 的稳定会话 ID、领取记录和两侧运行态
在同一事务中提交；重复轮询不会创建第二个 Agent。

取消在 Agent 创建前后都有效。执行期间轮询当前任务、预设、所有者和节点
实例；失去有效执行身份或无法读取权威状态时停止。结果投递有独立轮询、
领取租约和指数退避，网络故障不会阻塞取消检查，过期的投递者不能结算新一轮
领取或覆盖新的 Scheduler attempt。

同一 realm/Worker/project/node 的替代实例取得有效心跳后，会为尚无持久化
结果的旧执行写入失败或取消回执；已有结果继续重试投递。失败摘要明确说明
结果未知，用户可检查原会话后另建重试 Run。该机制不自动重放旧 Run，也不
恢复内存工作流。不同 node ID 的替代、永久节点失联及员工设备任务传输仍待实现。

2026-09-12：执行、取消、身份校验和回调单元测试已运行；真实 PostgreSQL
事务测试已加入 CI 和集群验收脚本，本机尚未执行数据库或多节点验收。

Connector Gateway 新增 `GET /capabilities` 返回当前身份是否具有配置管理权限；`GET /connectors/{id}/manifest` 返回包括停用项在内的清单，`PUT /connectors/{id}` 延用既有注册校验。权限按网关配置的 `AdminRoles` 判断。清单只含受管凭证引用，不读取或返回 Vault 凭证值。

托管 OAuth 使用 `GET /connectors/{id}/oauth` 查询状态和最近 20 条授权审计，
`POST .../oauth/refresh` 手动续期，`DELETE .../oauth` 断开 Realm 共享授权。
浏览器通过认证代理 `POST /auth/connector-oauth/start` 发起（需 `X-Lumo-Auth-Request: 1`），
回调为 `/auth/connector-oauth/callback`；代理独占网关的 `POST .../oauth/start|callback`
调用，不把 access/refresh token 返回 UI。未配置托管能力时显示明确的不可用状态。
配置、Vault 权限、并发和中断语义见 [`configuration.md`](./configuration.md#连接器托管-oauth)。

## 流程修订

| Flows 接口 | 行为 |
| --- | --- |
| `GET /v1/projects/{pid}/flows/management` | 项目内可管理流程与修订状态；作者可见自己的草稿，有审核角色的项目成员可见待审项 |
| `GET /v1/flows/{id}/management` | 元数据、获准读取的定义和操作权限 |
| `PATCH /v1/flows/{id}/management` | 保存初始草稿或发布后修订；继续使用现有 DAG 解析和验证 |
| `POST /v1/flows/{id}/management/change` | 通过 `command=create/submit/review/discard` 管理发布后的修订 |

初始草稿保存携带 `expectedUpdatedAt`。发布后的修订单独存储，保存携带 `changeId` 和 `changeRevision`；提交、审核、撤回携带 `changeId` 和 `revision`。每次新建修订使用新 ID，避免撤回重建后被旧页面覆盖。

修订作者须为原作者且仍为有效项目的 owner/editor；审核人须为具有现有 `manager` 或 `admin` 角色的其他项目成员。新入口不扩大原审核角色。项目归档后，新管理界面关闭编辑和审核权限。

修订审核与父流程行锁绑定。通过审核会写入下一个不可变版本、审核记录并切换发布指针；拒绝则退回修订草稿。整个过程保留原流程的发布/分发状态和受众。若期间发生版本回滚，过时基准的修订不得直接发布，需要撤回并基于当前版本重建。历史快照读取、定向分发和版本切换继续使用原有项目权限接口。

## 部署与验证

Governance 初始化扩展已有安全事件类型；Flows 初始化新增 `flow_change_drafts` 表。新增表不会改变已有流程、历史版本和执行记录。启动器只在集群装配中为认证代理注入 `clusterMode: true`，新增管理样式仅作用于组织及集群面板。

企业 OIDC 登录已接入 Governance、认证代理和登录页面。管理员可在组织管理中关联、解除及恢复已有用户的企业身份；`PUT /v1/users/{userID}/oidc` 使用当前配置的 issuer 和请求中的 `subject`，`DELETE` 保留禁用记录并撤销 OIDC 会话。`GET .../access` 返回安全的关联状态及本地/企业登录可用性。默认不自动建档，不按用户名或邮箱合并账户；企业角色仍由治理授权。

OIDC 临时事务和身份关联分别保存在 `governance_auth_oidc_flows`、`governance_auth_oidc_identities`；已有会话迁移为默认本地认证路径。新企业会话复用停用和撤销机制，期限不超过 ID Token 到期时间。新增企业身份校验不会允许删除已有的最后一个本地管理员恢复入口。配置、协议范围、MFA 和 IdP 停用边界见 [`configuration.md`](./configuration.md#企业-oidc-登录)。

受治理文本执行的测试进展见对应小节。实际多节点会话失效、数据库并发、浏览器交互及生产依赖联调仍待后续验证。OIDC 与连接器 OAuth 的真实供应商、客户端凭据、回调及用户策略仍须由目标环境配置；桌面设备的真实激活仍依赖原设计中列出的环境输入。

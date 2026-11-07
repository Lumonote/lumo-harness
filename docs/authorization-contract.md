# 授权判定契约

## 规则

所有服务端授权均归一为：

```text
PolicyDecision(actor, resource, action, context)
```

资源属于一个 Realm，且可选地绑定 Project 与 Space。有效权限取最小交集：

```text
Realm action grant ∩ Project membership ∩ Space grant
```

任一边界拒绝或暂时无法确认，即拒绝。项目角色或 Space 授权不能提升 Realm
动作权限；这条规则也适用于 Agent 与服务账号。

## 当前落地

Governance 提供：

- `GET /v1/effective-permissions`：返回当前调用者在可选
  `project_id`、`space_id` 资源上下文中的全部受支持动作及其决策。
- `POST /v1/permission-explain`：接收 `{ action, resource }`，返回具体的
  allow/deny 原因和命中的策略。

目前支持 `task:delegate` 与 `task:execution:update`。受信任网关注入直接角色，
Governance 按当前 PostgreSQL 角色继承与动作规则解析 Realm 动作权限；未显式配置时沿用
内置兼容默认。有 `project_id` 时，项目必须存在、属于当前 Realm 且处于 active，
非直接 Realm 管理员还必须是项目成员。

Space 的权威授权源现接入 Collaborator 的 `collab_space_grants`。Governance
通过 `LUMO_COLLABORATOR_URL` 调用只读内部接口
`GET /v1/runtime/spaces/{spaceID}/permissions`，使用服务 Bearer 凭据以及服务端
已经认证的 `X-Lumo-User`、`X-Lumo-Realm`。内部接口独立验证服务凭据，不接受
query/body 指定另一个用户。响应包含 realm、Space、用户与当前直接授权；无授权
返回空集合。响应不可缓存，Governance 逐次读取、核对全部归属字段、限制响应大小，
并拒绝重定向、非法权限或不一致的响应。无法确认来源时返回 503，不使用旧授权放行。

当前两个受支持动作都可启动或修改工作，因此 Space 必须同时授予 `read` 和
`edit`；独立的 `comment`、`publish` 或单独 `edit` 不能代替这一交集。Realm
管理员同样需要 Space grant，不会因为 Realm 角色自动跳过该边界。这里接入的是
协作文档 Space；资料库文件和目录的继承 ACL 仍由 Knowledge Provider 自己判定。

项目归属从 Projects 权威表 `project_spaces` 与 `projects` 解析；只接受同 realm
的绑定。省略 `project_id` 时，Governance 自动把 Space 的真实项目加入判定；
显式提交其他项目不能通过。未知 Space、未装配项目表或未配置 Collaborator
来源仍以授权未知拒绝，不能退化为允许。当前这条链路服务于统一权限决策入口；
它不自动开放原本被文本执行档位禁止的知识或连接器工具。

Standalone/Cluster Compose 的控制面 bundle 已注入 Collaborator 地址，Helm
默认使用同 release 的 Collaborator Service，可用 `governance.collaboratorUrl`
覆盖。服务间 TLS 使用既有 observability HTTP transport 配置；配置非空地址时
必须同时配置 `LUMO_CONTROL_PLANE_TOKEN`。

## Space 授权管理

项目 owner 可在项目详情的知识空间区打开“管理授权”，为现有项目成员分别分配
`read/edit/comment/publish`，或确认撤回全部权限。非 owner 不显示管理入口；
归档项目仅查看，恢复后才可保存。创建 Space 不会自动写入其他服务的权限表；
owner 可通过该页面明确给自己或其他成员授权。

服务接口为 `GET /v1/projects/{projectID}/spaces/{spaceID}/grants` 与
`PUT /v1/projects/{projectID}/spaces/{spaceID}/grants/{userID}`。写请求是
`{ permissions: ["read", "edit"], expectedRevision: 0 }`；首次没有记录使用版本 0，
后续必须使用读取时的版本。`permissions: []` 是撤回，保留递增版本的空记录，
不会删除后重用版本。保存冲突返回 409，页面保留草稿并要求重新读取。

两个接口均验证服务凭据和可信用户身份，事务持有 Projects 的项目父行锁，重新校验
realm、真实 Space 绑定、当前 owner 与项目状态，并锁定检查启用用户。非空 grant
只可发给同 realm 的当前项目成员；旧成员和停用用户的授权仍可撤回。权限及递增版本
与 `collab_space_grant_audit` 在同事务写入。Collaborator 是 grant 的唯一写入者；
项目、成员、用户表仅按现有共享 PostgreSQL 部署读取，不存在跨库隐形写入。

新管理 grant 冻结真实 `project_id` 和 Space 的 `incarnation`。Projects 的 Go/TS 写者
为新建 Space 生成独立 UUID，普通更新保留该值。后续每次读取会重新核对成员、启用用户、
active 项目、Space 归属和实例；同项目删除后重建相同 ID、或跨项目复用 ID，均不能恢复
旧权限。管理列表保留旧记录的 revision，但把失效权限显示为空；当前 owner 必须明确按
当前 revision CAS 提交，才会为新实例重新授权。审计同时保留原、新实例及项目。

WebSocket 在输入、输出时重读授权，并每 5 秒检查空闲连接的撤权；无法读取时关闭连接。
旧 `Store.Grant` 装配记录仅在完全没有 Projects Space 与认领表的独立部署中保留原显式
授权语义。集成部署中所有未绑定旧 grant 均拒绝，owner 必须从当前版本明确 CAS 升级，
不能以“当前没有项目绑定”证明它一直属于独立空间。Projects 的 `project_space_claims`
由触发器记录认领并回填当前 Space，没有项目外键，解绑或项目删除不清除。回填无法
重建迁移前已经删除的绑定历史，缺少 claim 不构成放行依据；只缺一张权威表或其他查源
错误失败关闭。因此旧 legacy grant 不会在绑定消失或升级后恢复旧项目内容的访问。

迁移 `020_collaborator_space_grant_management.sql` 与服务启动 DDL 补齐 grant 的
`revision/project_id` 和审计表；迁移 022 补 Projects Space 实例，023 补 grant/audit 的
实例快照，024 补永久认领表及触发器。DDL 收敛测试组合迁移 002/020/023，并比较
Go/TS 项目表的真实形状；服务启动 DDL 同步包含这些迁移，不依赖单独执行迁移脚本。

## 动态会话的知识读取

显式开启的动态用户知识工具使用当前登录 principal，经独立的
`knowledgeAuthenticatedQuery` 只读能力进入知识 seam。本地调用不使用部署身份；集群
每次单独签发当前用户的身份声明，不修改共享 proxy 的调用者。realm 和 project 固定，
只有问题与 topK 是模型参数，published 是唯一检索状态。

知识 Provider 先验证当前 active 用户、active 项目与成员关系，按该项目当前 Space
登记收窄召回，返回前再次验证归属与成员，并检查资料目录/文件 ACL、内容版本和墓碑。
手工发布、未标为资料文件的 source 在对应项目 Space 下对具备检索角色的项目成员可读；
资料文件仍须通过其独立 ACL。这里的知识资料读取合同不等同于 Collaborator 的协作
Space grant，不宣称查询经过 `collab read`；协作文档的编辑、发布和统一执行决策仍使用
前述四权限合同。知识工具不会授予这些写入权限。

## 可配置任务动作与角色继承（v1.2.1）

`GET /v1/permission-actions` 返回动作目录；当前只包含 `task:delegate` 和 `task:execution:update`。同 Realm 角色可继承一个父角色，最多 32 层，禁止环，停用角色会截断其后的继承。角色规则写入唯一事实表 `governance_role_permissions`，`allow` 授权、`deny` 对所有直接与继承角色全局优先；`inherit` 表示删除该动作规则并恢复该角色的内置兼容默认。未登记的内置角色继续兼容既有默认，普通自定义角色默认不授予任务动作。

- `GET /v1/roles/{roleID}/permissions` 返回当前版本、显式规则、生效角色与动作解释。
- `PUT /v1/roles/{roleID}/permissions` 接收 `expected_revision` 和完整 `permissions` 数组；空数组清除显式规则。
- `DELETE /v1/roles/{roleID}/permissions` 接收 `expected_revision`，恢复全部默认。
- `PUT /v1/roles/{roleID}/parent` 接收 `expected_revision` 与 `parent_role_id`；`null` 清除父级。

策略写入除入口直接管理员门槛外，还会在 Realm 事务锁内复验操作者为当前活动目录用户、持有未过期且活动的直接 `platform_admin` / `realm_admin` / `admin` 授权。等待锁或读取请求体期间撤权不能继续写入；仅外部请求头有管理员名称、目录无直接授权的调用方不能配置策略。写入以 revision CAS 防止覆盖，角色名称、状态更新同样递增权限 revision，并记录策略前后事实与操作者审计。

`roles` 始终为直接角色；继承结果只放在 `effective_roles` 与 `role_resolution`，不得回填认证角色头。继承管理员角色可获得其任务动作和角色技能，但不能取得组织管理、目录管理或 Realm 全量任务可见性。配置 `task:delegate` 也不会打开组织用户目录。任务实际执行、结果上报、委派详情与列表按当前同一事实解析器校验；任务项目从服务端记录取得，项目必须存在、处于 active 且属于当前 Realm，然后再校验成员资格，直接管理员只能绕过同 Realm 项目成员检查。

可选 `LUMO_GOVERNANCE_POLICY_URL` 将同一 request、role_facts、proposed 决策交给 OPA。OPA 的布尔 `result` 只能进一步收窄，不能放宽本地 deny、项目或 Space 拒绝；未定义/格式错误/超限响应、网络失败等返回 503，不缓存放行。默认不启用，继续使用 PostgreSQL 角色事实适配器。示例策略位于 `platform/deploy/policies/governance-permissions.rego`。

## 后续接入要求

后续知识库或其他 Space 类型接入时必须提供独立且可验证的归属与 grant，不能
借用协作文档权限，不接受客户端携带的布尔授权。Agent 下授还需在相同决策中增加：父权限子集、最大深度、预算、
时长、连接器范围与数据驻留域；其中任一限制超过父任务上下文即拒绝并写审计。

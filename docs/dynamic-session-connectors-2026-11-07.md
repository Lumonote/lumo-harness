# 动态 Session 当前 owner 连接器与原生审批（2026-11-07）

普通认证 Session 可显式开启 `user_connector_list` 和 `user_connector_invoke`。工具使用当前登录用户、项目权限和数据库执行租约，不复用部署账号或管理员工具。默认关闭，浏览器没有共享 carrier 的交互权限。

## 配置

Helm 同时配置网关精确授权和执行节点工具授权。下面仅示意现有动态 Session 配置中的新增部分；`authorityUrl/nodeId/projectId/workspaceRoot/provider/model` 等原配置仍必填。

```yaml
ownedSessionConnectors:
  - realm: dev
    project_id: dev-project
    connector_id: issues
    operation: create

dshWeb:
  userSessionExecution:
    projectId: dev-project
    connectors:
      realm: dev
      gatewayUrl: http://lumo-platform-connector-gateway:8082
      actions:
        - connectorId: issues
          operations: [create]
```

网关授权是 `realm/project_id/connector_id/operation` 的精确四元组，不支持通配符。Helm 拒绝未匹配的动作、不同 realm、带账号的 URL，以及未启用 Governance 或 connector-gateway 的组合。网关仍要求已注册且启用的连接器、当前用户角色、OPA/出站策略和凭证解析都通过。

Compose 使用 `LUMO_OWNED_SESSION_CONNECTORS` JSON 数组，`compose.control-plane.bundle.yml` 将其显式下发至 connector-gateway 子进程。空字符串关闭该入口。执行节点仍通过 `LUMO_USER_SESSION_EXECUTION.connectors` 提供同样的工具授权：

```json
[{"realm":"dev","project_id":"dev-project","connector_id":"issues","operation":"create"}]
```

网关使用固定的 `LUMO_GOVERNANCE_URL` 和现有控制面服务凭据重新认证登录。普通 Session 必须仍有 `task:delegate` 项目授权；不要用管理员静态身份替代它。

## 调用和审批

1. 每次调用独立查询 Governance 的当前登录和项目权限，再查询 `session_owners`、执行节点 generation 与 Session writer 租约。用户、项目、节点、process、node fence、Session fencing token 或 writer 不匹配即拒绝。
2. 只读动作通过固定连接器操作执行。写动作先把完整 invocation（仅 operation、pathParams、query、body；无请求头或已解析凭证）及连接器版本写入迁移 030 的 `owned_connector_receipts`，返回 SHA-256、修订号和五分钟有效期。每个 Session 最多保留 8 个有效待确认/已确认凭据，跨网关副本事务仲裁。
3. 使用官方 `ctx.userQuestions.ask` 的 approval intent 阻塞当前工具调用。认证会话页面通过 `interactionList` 读取该精确 live Agent 的问题，以纯文本展示完整请求；通过 `interactionAnswer` 回传 questionId、receiptId、digest、revision 和 approve/reject。UI 不解释 Markdown、HTML 或外部资源。
4. 用户只能确认一次。决定和消费在数据库行锁后再次检查当前 owner、执行租约和真实数据库时钟，精确校验摘要、修订号、状态和有效期。执行时读取持久化请求，重新验证连接器版本与策略，模型不能在确认后替换 payload。
5. 外部 I/O 最长 30 秒，每秒复验登录、项目和执行租约，返回前再次复验。失权或 fencing 取消 I/O；连接断开、超时等不确定结果记录 `unknown` 并封存，禁止复用同一凭据。请核对外部系统和审计，再决定是否以新请求重试。

高敏感写操作，以及 OPA 要求额外审批的动作，不由当前 owner 的单人确认放行；它们继续使用现有独立管理员审批流程。此工具不授予 shell、任意 URL/请求头、Vault 或凭证读取能力。

## 生命周期与限制

完成或拒绝时立即清除 receipt 中的业务 payload。五分钟到期后凭据不能再确认/消费；健康网关的每分钟清理任务以及新请求入口会清除过期 payload，并将无完成结果的已消费调用标为 `unknown`。过期清理使用仅覆盖仍保留 payload 行的索引。服务停机期间无法承诺清理时间。

这是 receipt 存储的保留策略，不会删除 Session 原有工具参数、对话历史或其他业务审计。业务数据可能已经存在于这些系统的独立保留策略下。登录凭据与网关解析的外部系统凭据不写入审批问题或 receipt。

原生待答问题属于精确 live Agent。进程重启后不重建或自动执行旧问题；持久化 receipt 到期失效，外部不确定调用不自动重放。动态 Session 恢复时仍遵守现有待执行输入核对和租约 fencing。

## 验证范围

新增回归覆盖真实原生 UserQuestionService waterfall、真实 AgentLoop + Gateway + 非 carrier 认证传输、当前 owner/项目隔离、恶意 HTML 纯文本展示、精确绑定的确认/拒绝和重复点击。Go 真 PostgreSQL 用例覆盖并发消费、摘要/修订号、锁等待期间失权/过期、并发待答限额、未知外部结果和禁止重放。Helm 正反例验证默认关闭与配置一致性。

这些回归的外部连接器使用本地 HTTP 测试服务，模型使用确定性测试 adapter；不等同于真实供应商计费验收或跨物理主机故障验收。

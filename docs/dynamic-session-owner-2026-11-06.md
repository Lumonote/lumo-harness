# 动态用户会话归属与认证文本入口（2026-11-06）

本批增加可显式启用的 `/lumo/chat` 文本会话页面及 `/lumo/sessions/*` HTTP/NDJSON 传输。每个请求从 Governance 登录 cookie 取得当前用户，以公开 `connection.createPeer()` 生成 `lumo-user` 非 owner Peer，再经 Gateway 与 `remoteAccess` 按本次持久归属事实授权。原生 carrier 共用 owner 的 `/api`、WebSocket、文件和其他原生入口在此模式下拒绝访问；这条实现没有把 HTTP 上下文伪装成原生 WebSocket 多用户隔离。

## 配置和部署

必须使用服务端 Web profile，挂载公开 connection、Gateway、remoteAccess、agents、sessionQuery、sessionPersistence 与 meteringScope，并运行 session-control。先执行 [迁移 017](../platform/deploy/migrations/017_session_owners.sql)；session-control 启动也包含相同 DDL。身份代理内部 WebServer 必须保持仅绑定 `127.0.0.1`，外部只暴露身份代理监听端口。

节点配置示例：

```sh
export LUMO_DSH_PROFILE=web
export LUMO_PROJECT_ID=project-1
export LUMO_USER_SESSION_EXECUTION='{"authorityUrl":"http://session-control:8092","nodeId":"node-1","projectId":"project-1","workspaceRoot":"/srv/lumo/user-sessions","provider":"approved-provider","model":"approved-model"}'
```

`LUMO_USER_SESSION_EXECUTION` 必须为完整 JSON 对象，projectId 必须等于部署项目；默认不设置则不启用。插件配置对应 `@lumo/user-auth.config.sessionTransport`。用户须有当前有效 Governance 登录态，并通过当前 Realm ∩ Project 的 `task:delegate` 权限检查。模型与工作区固定于部署；用户不能自行传入 cwd、Agent 预设、provider/model 或子会话父 ID。工作区拒绝符号链接和非目录。

Standalone 和完整 Cluster Compose 会把该变量传给 Web 进程；Compact 继承 Cluster 的 `dsh-web` 定义，配置相同。它不会传给 headless Worker。Compose 同时透传可选的 `LUMO_THREAD_EXECUTION`，两者空值均表示关闭；Thread 配置另见[稳定执行合同](thread-stable-execution-2026-11-06.md)。

Helm 使用 `dshWeb.userSessionExecution` 对象，序列化为同名环境变量。以下是叠加 `values.cluster.yaml` 的显式配置示例，provider/model 必须替换为当前部署已经批准的值：

```yaml
dshWeb:
  replicas: 1
  projectId: project-1
  userSessionExecution:
    authorityUrl: http://lumo-platform-session-control:8092
    nodeId: lumo-platform-dsh-web-0
    projectId: project-1
    workspaceRoot: /var/lib/lumo/session-spool/user-sessions
    provider: approved-provider
    model: approved-model
```

`nodeId` 是这条入口的稳定登记身份，必须在重启后保持相同；工作区应位于此节点的持久卷内。当前入口没有跨副本路由和会话执行租约，因此一个登记身份只能由一个 Web 执行进程使用；Helm 开启此配置后要求 `dshWeb.replicas: 1`。不得通过复制相同 JSON 启动第二个执行进程。Helm 默认 `userSessionExecution: {}`，不会生成该环境变量，也不会选择模型或认领旧会话。

启用后登录跳转 `/lumo/chat`，支持新建、分页列举自己的会话、消息与历史、恢复和停止。此页面是独立文本入口，不承诺原生 DSH UI 的协议兼容。每进程本入口的 live Agent 当前上限为 64，进程内已访问归属事实最多 512 个，达到后显式拒绝；进程退出会等待持久写者清理。

## 持久归属合同

内部 API 均受现有 control-plane service token middleware 保护。Bearer token 只在服务间使用，不进入浏览器。

| 接口 | 行为 |
|---|---|
| `POST /v1/session-owners` | 输入 realm/owner_user_id/project_id/node_id/可选 parent_session_ref；服务生成全新随机 session_ref、reserved 行与一次创建 token，拒绝 caller 自选 session_ref |
| `POST /v1/session-owners/{ref}/activate` | 持有创建 token 才可把 reserved 置 active；重复激活幂等，owner/project/node 永不改写 |
| `GET /v1/session-owners/{ref}?realm=...` | 读取当前不可变归属和状态，查询不返回创建 token |
| `GET /v1/session-owners?realm=...&owner_user_id=...&node_id=...` | 只列 active 归属，按 session_ref 游标分页，每页最多 100 |

父归属若非空，必须已经 active 且 realm/owner/project/node 全部一致。此字段不允许浏览器认领父 ID；动态用户创建目前固定为空。没有任意绑定、转让、删除后认领或 legacy 自动迁移接口。

创建链先 reserve，确认公开持久后端和 live store 均无该 ID，再公开 `agents.create()`、flush，最后 activate。失败或崩溃留下 reserved 行，不能以读取/重试方式抢占为他人；需检查持久日志处理。active 是归属状态，读取历史仍须由持久后端证实 session 存在。共享 TypeScript 客户端位于 `platform/shared/session-owners.ts`，供 Thread 的受信创建链复用。

## 执行与安全边界

所有执行只允许文本模型；Agent scope 同时配置空工具白名单和拒绝 guard。因此不会暴露固定部署 owner 的 `agent_teams` 或 Thread 工具，也不会把动态用户的任务绑定给固定 `actingUserId`。未启用知识、连接器、附件、fork、任意模型、宿主机文件操作或原生交互式审批。

每次操作重新读取 PG 归属，核对当前 owner/realm/project/登记节点与 active；未知 legacy、其他用户、其他项目/节点以及未提交创建均拒绝。Gateway 使用按请求创建并释放的非 owner Peer，只授予目标 Session 的明确动作。列表直接从本用户归属索引读取。会话在正常重启后通过公开 resume 恢复，创建或恢复的 Agent 在输入前安装文本限制和可信计量归因。

列表再按当前部署项目过滤，分页游标仍来自归属服务。若重启后的持久日志含 `next-turn` 或 `next-step` 待执行输入，Agent 在公开串行创建通知中拒绝发布，阻止自动重放和额外模型费用；HTTP 返回 `session_pending_input`，页面提示先核对历史。它不删除待确认消息，也不推断之前一轮是否已经完成。干净历史可以正常恢复并继续下一轮。

计量 user/project 来自持久归属，component=`user-auth`、feature=`session:text`。prompt 前、每个模型 step 前和运行中的周期检查会重新验证登录及项目权限；撤权或认证服务错误会取消执行。长 HTTP 流也周期检查并在失效时关闭响应，包括正在等待 socket 背压的响应；这些轮询不是零延迟撤权保证。外部供应商模型故障、额度和限流仍须按生产环境另行验收。

Bot 所需的 `/lumo/runtime/teams/{id}` 是另一个内部 GET 读面：代理以常量时间核对 service Bearer，重建固定 realm/token headers，移除浏览器身份和 cookie；无登录 cookie 路径，也不接受写入。它读取团队存储的当前事实，不创建或转让团队权限。

## 验证

已运行真实 PostgreSQL 的 session-control 全模块 race 回归，覆盖随机创建、并发唯一、错误 token、不可重分配、父链范围、外 realm/用户读取和重新构造 Store 后归属恢复。HTTP 路由测试拒绝 caller session_ref、额外身份字段、PUT/DELETE 及非法请求。

真实 Gateway + remoteAccess + Peer + SessionController + AgentLoop + JSONL 用例已通过：Alice 新建并记录 `lumo-user` prompt principal，Bob 在 Gateway 调用前被拒；整个 runtime 重启后同一会话第二轮保留首轮 prompt/answer，计量绑定 Alice。模型使用确定性 adapter，owner HTTP 使用协议替身；真实 PG 归属测试单独覆盖数据库行为。

公共 HTTP/NDJSON/原生 WS 拒绝测试与其余认证回归由最终验证记录汇总，不能据此宣称所有浏览器交互、生产供应商和跨节点端到端已验收。

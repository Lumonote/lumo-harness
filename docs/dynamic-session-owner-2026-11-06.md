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

启用后登录跳转 `/lumo/chat`，支持新建、分页列举自己的会话、消息与历史、恢复、停止和创建会话分支。此页面是独立文本入口，不承诺原生 DSH UI 的协议兼容。每进程本入口的 live Agent 当前上限为 64，进程内已访问归属事实最多 512 个，达到后显式拒绝；进程退出会等待持久写者清理。

## 持久归属合同

内部 API 均受现有 control-plane service token middleware 保护。Bearer token 只在服务间使用，不进入浏览器。

| 接口 | 行为 |
|---|---|
| `POST /v1/session-owners` | 输入 realm/owner_user_id/project_id/node_id/可选 parent_session_ref；服务生成全新随机 session_ref、reserved 行与一次创建 token，拒绝 caller 自选 session_ref |
| `POST /v1/session-owners/{ref}/activate` | 持有创建 token 才可把 reserved 置 active；重复激活幂等，owner/project/node 永不改写 |
| `GET /v1/session-owners/{ref}?realm=...` | 读取当前不可变归属和状态，查询不返回创建 token |
| `GET /v1/session-owners?realm=...&owner_user_id=...&node_id=...` | 只列 active 归属，按 session_ref 游标分页，每页最多 100 |

父归属若非空，必须已经 active 且 realm/owner/project/node 全部一致。普通创建的父归属固定为空；分支由服务端在重新确认源会话归属后填写。没有任意绑定、转让、删除后认领或 legacy 自动迁移接口。

创建链先 reserve，确认公开持久后端和 live store 均无该 ID，再公开 `agents.create()`、flush，最后 activate。失败或崩溃留下 reserved 行，不能以读取/重试方式抢占为他人；需检查持久日志处理。active 是归属状态，读取历史仍须由持久后端证实 session 存在。共享 TypeScript 客户端位于 `platform/shared/session-owners.ts`，供 Thread 的受信创建链复用。

## 会话分支（2026-11-07）

`POST /lumo/sessions/fork` 只接收 `{ "sessionId": "session-..." }`，创建新会话。
服务端重新检查登录、项目和源会话的 owner/realm/project/node，读取公开 SessionQuery
快照，只复制截至最新一个已结束轮次的完整历史；正在排队的后续输入不纳入分支。
尚无已完成轮次时返回 `session_fork_unavailable`，不会分配新 ID 或调用模型。

历史种子由 DSH 公开 `buildForkSeed` 生成，并保留 `inheritedEventCount`；新 ID 仍由
Session-control 分配。分支使用新的独立工作目录、固定部署模型和相同用户的计量范围，
经过持久 flush 与再次验证登录后才激活。浏览器不能提交目标 ID、cwd、模型、父归属或
任意切点。它不会复制工作目录文件，也不会让源会话后续的消息进入分支。

页面“创建会话分支”按钮使用上述认证入口，列表标记分支。创建或恢复后的文本限制
与普通会话相同；prompt 与队列编辑明确拒绝非文本消息部件。

## 执行与安全边界

所有执行只接受文本输入；Agent scope 默认同时配置空工具白名单和拒绝 guard。显式开启
下述知识档位时，只增加自己的只读工具，不复用部署 owner 的知识工具、`agent_teams`
或 Thread 工具，也不会把动态用户的任务绑定给固定 `actingUserId`。连接器、附件、任意
模型、宿主机文件操作或原生交互式审批尚未开放。

每次操作重新读取 PG 归属，核对当前 owner/realm/project/登记节点与 active；未知 legacy、其他用户、其他项目/节点以及未提交创建均拒绝。Gateway 使用按请求创建并释放的非 owner Peer，只授予目标 Session 的明确动作。列表直接从本用户归属索引读取。会话在正常重启后通过公开 resume 恢复，创建或恢复的 Agent 在输入前安装文本限制和可信计量归因。

列表再按当前部署项目过滤，分页游标仍来自归属服务。若重启后的持久日志含 `next-turn` 或 `next-step` 待执行输入，Agent 在公开串行创建通知中拒绝发布，阻止自动重放和额外模型费用；HTTP 返回 `session_pending_input`，页面提示先核对历史。它不删除待确认消息，也不推断之前一轮是否已经完成。干净历史可以正常恢复并继续下一轮。

计量 user/project 来自持久归属，component=`user-auth`、feature=`session:text`。prompt 前、每个模型 step 前和运行中的周期检查会重新验证登录及项目权限；撤权或认证服务错误会取消执行。长 HTTP 流也周期检查并在失效时关闭响应，包括正在等待 socket 背压的响应；这些轮询不是零延迟撤权保证。外部供应商模型故障、额度和限流仍须按生产环境另行验收。

Bot 所需的 `/lumo/runtime/teams/{id}` 是另一个内部 GET 读面：代理以常量时间核对 service Bearer，重建固定 realm/token headers，移除浏览器身份和 cookie；无登录 cookie 路径，也不接受写入。它读取团队存储的当前事实，不创建或转让团队权限。

## 可选的当前用户知识查询（2026-11-07）

默认不配置 `knowledge`，模型仍看不到工具。需要只读检索时，在同一固定会话配置中加入：

```json
{
  "authorityUrl": "http://session-control:8092",
  "nodeId": "node-1",
  "projectId": "project-1",
  "workspaceRoot": "/srv/lumo/user-sessions",
  "provider": "approved-provider",
  "model": "approved-model",
  "knowledge": { "realm": "dev", "defaultTopK": 5, "spaces": ["space-1"] }
}
```

Helm 对应 `dshWeb.userSessionExecution.knowledge`，realm 必须与 `dshWeb.realm`
一致。topK 为 1–10；`spaces` 可选，只能继续收窄当前项目的 Space，空数组表示无可读
空间。省略 spaces 仍受固定 project 的当前登记约束。未知配置字段（例如 roles、userId、
actingUserId）拒绝启动。启用时启动器额外依赖 `knowledgeAuthenticatedQuery`：本地由
知识插件提供，集群由已配置签名身份的 seam-proxy 提供；缺能力、未签名或缺权威表均
失败关闭，不能回退为部署账号。

模型仅可调用 `user_knowledge_query({question, topK?})`，不能传 realm/project/user/
roles/spaces/draft。每次执行从当前登录 authority 重新取得 principal，核对持久 owner、
项目权限与归属，再用当前用户及角色查询 published 知识。返回内容前再次检查登录与
项目权限，身份或角色改变即丢弃结果；查询期限 15 秒，停止执行也会取消结果等待。单次
最多返回 10 段、每段 8000 字符、合计 48000 字符，保留 docId 和 sourceVersion 便于引用。

集群请求逐次签名，不改变共享 proxy 的身份；Alice/Bob 并发查询不共享可变 actor。PG
知识 Provider 在召回前验证 active 用户/项目/成员，按项目当前 Space 收窄，并在最后
过滤阶段再次读取这些事实及资料 ACL、源版本与墓碑。手工 published source 在项目
Space 内按检索角色和成员关系可读；资料文件另受目录/文件 ACL 限制。此读取规则与
Collaborator 的 `read/edit/comment/publish` 协作授权各有合同，不把知识读取描述为
统一经过协作 Space grant。完整关系见[授权契约](authorization-contract.md)。

## 验证

已运行真实 PostgreSQL 的 session-control 全模块 race 回归，覆盖随机创建、并发唯一、错误 token、不可重分配、父链范围、外 realm/用户读取和重新构造 Store 后归属恢复。HTTP 路由测试拒绝 caller session_ref、额外身份字段、PUT/DELETE 及非法请求。

真实 Gateway + remoteAccess + Peer + SessionController + AgentLoop + JSONL 用例已通过：Alice 新建并记录 `lumo-user` prompt principal，Bob 在 Gateway 调用前被拒；整个 runtime 重启后同一会话第二轮保留首轮 prompt/answer，计量绑定 Alice。模型使用确定性 adapter，owner HTTP 使用协议替身；真实 PG 归属测试单独覆盖数据库行为。

新增 `owned-fork.spec.ts` 使用真实 AgentLoop、Gateway、JSONL 与公开历史查询，验证
分支继承首轮、与源会话后续输入隔离、独立工作目录、同用户计量及进程重启后继续对话；
另测空历史、外部用户、伪造元数据和登录撤回在分配新 ID 前被拒。这里的模型与归属 HTTP
仍是协议替身，不能当成真实供应商或物理跨主机验收。

公共 HTTP/NDJSON/原生 WS 拒绝测试与其余认证回归由最终验证记录汇总，不能据此宣称所有浏览器交互、生产供应商和跨节点端到端已验收。

新增真实 AgentLoop 用例覆盖默认无工具、Alice/Bob 当前身份隔离、伪造参数与部署工具
拒绝、模型请求后撤权、查询返回前撤权；独立签名代理用例覆盖并发用户、无签名拒绝和
取消。真实 PG 的项目/资料 ACL 与撤权回归由本轮最终验证记录汇总。

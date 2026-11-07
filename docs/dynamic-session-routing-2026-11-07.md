# 动态用户会话：执行租约与跨 Web 副本路由

动态 `/lumo/sessions` 入口保留不可变的 realm、owner、project 和 node 归属，
现在由 Session-control PostgreSQL 的进程租约与会话执行租约约束执行。
开启显式路由后，同一项目内任意 Web 副本都能列举用户的会话，并把已有会话的历史、
流、输入、停止、队列编辑和分支请求发送给当前登记的原节点进程。
本能力不会迁移本地工作目录或日志，也不在原节点离线时自动改派 owner。

## 持久执行边界

迁移 `027_session_execution_leases.sql` 与 Session-control 启动 DDL 同步。
`session_execution_nodes` 的主键是 `(realm,node_id)`，包含固定项目、当前随机进程 ID、
不公开的随机凭据摘要、递增 fence、登记 origin 和库端到期时间。
进程租约为 15 秒，会话执行租约为 10 秒；Web 运行时每 2 秒续期，并在操作和模型
step 前重新验证。进程身份与 session-log 已有 writer holder 均由启动器注入，重启会变化。

过期凭据不能续期或用同一个 process ID 重新认领；新进程只能在旧节点租约到期或
正常释放后取得下一代 fence。会话执行代同样递增，且只能在其不可变归属节点执行。
失租、权威源不可达或返回事实不一致会永久封闭当前运行时，取消已准备的 Agent，
关闭其公开持久写者，并拒绝后续恢复；恢复需要启动新进程。

PG session-log 的 acquire、append 和 publishHead 会在同一数据库事务中，按
node → execution → writer 顺序锁定当前事实，并核对 writer holder、进程代和未到期
状态。即使旧写者自己的日志租约尚未过期，它也不能再续租、发布 head 或提交日志。
没有 owner 表／归属的旧会话继续使用既有日志合同；已有 owner 但缺少执行租约拒写。
本地 JSONL 还保留上游公开 kernel writer lock，不绕过仍存活旧进程持有的文件锁。

内部服务接口均沿用 Session-control 的 control-plane token 鉴权，凭据不返回读面：

| 接口 | 用途 |
| --- | --- |
| `POST /v1/session-execution/nodes/{id}/{acquire,renew,release}` | 当前进程的登记、续期、释放 |
| `GET /v1/session-execution/nodes/{id}?realm=...&project_id=...` | 只返回未到期的精确项目节点事实 |
| `POST /v1/session-execution/sessions/{ref}/{acquire,renew,release}` | 当前节点进程的会话执行代 |
| `GET /v1/session-owners?realm=...&owner_user_id=...&project_id=...` | 跨节点、当前项目的用户归属分页 |

## 显式可信路由

默认不配置 routing，维持单 Web 节点的部署方式，但真实启动入口仍使用执行租约。
需要多个节点时，在 `LUMO_USER_SESSION_EXECUTION` 原配置中添加：

```json
{
  "authorityUrl": "https://session-control.example",
  "nodeId": "web-0",
  "projectId": "project-1",
  "workspaceRoot": "/var/lib/lumo/session-spool/user-sessions",
  "provider": "approved-provider",
  "model": "approved-model",
  "routing": {
    "transportSecurity": "tls",
    "routes": {
      "web-0": "https://web-0.internal.example",
      "web-1": "https://web-1.internal.example"
    }
  }
}
```

每个 origin 必须直达一个稳定节点，不能填会随机分配副本的共享负载均衡地址。
只接受无用户名、密码、path、query、fragment 的 HTTP(S) origin，禁止重定向。
`tls` 要求 HTTPS；`mesh-mtls` 表示 HTTP 明文只在已配置的 mTLS mesh 内传输；
`development` 仅供专用开发网络。部署方必须提供与所选档位一致的网络与证书。

源端先取得当前登录和项目权限，读取不可变 owner，再获取权威的当前 node、
process、fence 和 endpoint。endpoint 必须与静态白名单完全一致，缺失或过期路由返回
`503 session_execution_unavailable`。浏览器不能提交目标 URL 或选择执行进程。

内部 `POST /lumo/runtime/session` 使用服务令牌和精确目标执行代鉴权。
源端只向已匹配的静态可信 origin 发送专用 envelope，不转发 Cookie、任意浏览器
身份头或调用者给出的 principal。envelope 中的登录 credential 仅用于目标端向
Governance 独立重验；它不进入数据库、命令、prompt、日志、错误响应或模型上下文。
目标端只调用本地 owned transport，不能递归路由。

源和目标分别周期重新验证当前登录、角色、项目与目标执行代。每个返回流帧也会检查，
撤权会中断等待／背压响应并取消运行；模型 step 与只读知识工具继续使用当前用户。
单次 unary 路由最多 35 秒、JSON 响应最多 4 MiB；流单个缓冲区最多 1 MiB、连接
最多 30 分钟，可由浏览器重新订阅。已经提交的外部模型请求不承诺零延迟撤回。

## Helm 部署

`dshWeb.userSessionExecution.routing` 对应上述对象。多个 Web 副本要求：

- `workloadKind: StatefulSet`，独立持久 `spool` 与 `harness` home；
- `routing.nodeIdFromEnvironment: true`，启动器从每个 Pod 的 `LUMO_NODE_ID` 获取身份；
- routes 覆盖当前 release 每个 `<name>-dsh-web-<ordinal>`，且 origin 各不相同；
- `mesh-mtls` 需开启 chart 的 Istio 配置；生产门禁拒绝 `development`。

可以把 origin 指向 headless Service 的每 Pod DNS。此时传输安全档位和 mesh 必须匹配。
普通配置不自动扩容；增加副本前需同步静态路由，缩容后原节点会话仍留在原归属与卷中。

## 验证范围

新增真实 PG 用例检查节点竞争唯一胜者、错误凭据／Realm／项目拒绝、过期旧进程不可
续期、重启后的递增代，以及旧 PG log writer 在自身租约仍有效时也不能持久写。
新增路由、流撤权、内部 HTTP 目标代与 Cookie 隔离用例，并保留真实 AgentLoop、
Gateway、Peer、JSONL、干净历史恢复和待确认输入拒绝回归。
实际通过计数以本批最终验收记录为准，协议替身、同机 HTTP 与真实供应商／物理跨主机
生产验收分别记录。

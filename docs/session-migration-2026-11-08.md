# 动态用户会话：显式检查点与节点迁移

本能力为动态认证会话提供主动检查点、共享快照、目标恢复和 owner/执行代切换。
只有提交了完整检查点的会话能够在原节点随后离线时迁移。原节点及其卷丢失且从未
保存快照时，事件复制日志不能推导缺失的 header 或工作区，仍须从可信原节点卷备份恢复。

## 部署开启

Session-control 迁移为 `038_session_migrations.sql`；启动 DDL 与该迁移保持同形。
在既有 `LUMO_USER_SESSION_EXECUTION` 对象或 Helm 对应配置中添加：

```json
{
  "migration": { "enabled": true }
}
```

其余 node、project、workspaceRoot、模型和可信 routing 配置沿用
[跨节点会话路由](dynamic-session-routing-2026-11-07.md)。开启需要至少两个白名单节点，
共享 objectStore、PG sessionLog、sessionLogReplication 与 Recovery WAL 均已挂载。
未配置这些依赖时启动拒绝，不能把本地内存对象当共享备份。

首版限定 Linux/macOS 节点、相同绝对 `workspaceRoot`、相同模型策略；每个节点挂独立
持久卷。工作区根目录的父卷须已经存在，根目录叶子可在首次导入时创建。
完整 header 含原始 cwd，目标必须满足同一路径约定；不会静默改写原生不可变元数据。
profile 不允许 connector 写工具；其未知外部效果不能只靠文件快照证明安全。
Helm 还要求至少两个 StatefulSet 副本、已开启的共享 objectStore 与 session-control、
Governance，且 `workspaceRoot` 位于 `/var/lib/lumo/session-spool/` 的专用子目录；
禁止把检查点工作区放在容器临时文件系统。

## 用户操作

所有动作使用当前登录及项目权限；`POST /lumo/sessions/{action}` 携带 JSON 和既有
`x-lumo-auth-request: 1`。浏览器不能提交 owner、realm、目标 URL、进程凭据或快照正文。
“我的会话”页提供可折叠迁移区，包含白名单节点选择、保存检查点、目标恢复与状态查询。
冻结或提交结果未知时暂停发送、附件上传和模型切换；恢复保留未发送草稿，不自动发送。
原节点离线时，可以从其他在线 Web 副本打开同一项目会话查询和恢复。

| action | 请求 | 结果 |
| --- | --- | --- |
| `migrationStatus` | `{ "sessionId": "session-…" }` | 当前持久回执与可选择的白名单目标节点 ID |
| `checkpoint` | `{ "sessionId": "session-…", "targetNodeId": "web-1" }` | 完整检查点提交后返回 `checkpointed` 回执；源会话立即冻结 |
| `recover` | `{ "sessionId": "session-…", "migrationId": "mig_…" }` | 自动路由到回执的目标，恢复、校验、激活；`ready: true` 表示目标原生 Agent 已准备完成 |

`checkpoint` 要求会话已经空闲、没有待发送或插入消息、没有 Recovery WAL 孤儿。
它不取消正在执行的工作，也不重放旧输入。普通访问在待恢复状态下返回
`409 session_migration_frozen`，用户可在其他在线 Web 副本查询状态并提交 `recover`。
原节点离线不会使该状态伪装成“没有会话”。

`502 session_migration_unknown` 表示控制面写入结果未知。先查询 `migrationStatus`，
不要重新发送旧业务消息。提交检查点的进程永久退休该 session 的旧执行身份；其他会话
继续续租。没有已提交回执的失败不会切换 owner；已提交检查点不会自动解冻旧写者。
首版没有“回滚到旧源继续执行”按钮，避免目标激活结果未知时出现两个写者。
HTTP 成功但检查点或激活回执畸形也按结果未知处理；不能因为状态码为 200 就解除
页面冻结，或把无法验证的回执解释成事务没有提交。

## 快照与恢复协议

1. 本地同步关上该 session 的新请求准入，等待已有请求结束；真正的空闲维护锁覆盖
   捕获过程。调用公开 persistence.flush 和复制队列 flush，并逐条比较 PG 复制事件与
   原生事件，必须从 seq=0 连续且相同。
2. 原生 read handle 导出精确 header、inheritedEventCount、完整事件及文件摘要。保留
   createdAt、cwd、父会话、委派深度、preset 及已落日志的模型选择。没有调用会补造
   header 的旧 `restoreSession` 重建器，也不改写历史事件。
3. 快照写入 `realm/session-migration/v1/session-id/migration-id/sha256`，再独立读回
   并比对字节数和 SHA-256。控制面只接受当前原节点的非公开凭据和精确执行代，持久
   保存固定范围与摘要；同事务令原执行租约到期并增加 fence，阻止源的新旧进程重获它。
4. 目标读取控制面回执及共享快照，检查 owner/realm/project/目标/模型策略和摘要。
   原生 create/open writer 的 kernel lock 保护整个暂存工作区导入。精确原生日志前缀
   验证后，才写暂存文件并追加缺少的连续事件，flush 后再次读取比较。
5. 目标独立重验当前登录/项目、存活进程凭据。控制面按 node → execution → owner →
   migration 锁序，在同一事务移动 owner、递增 execution fence、绑定目标 writer 和
   写入 activated 回执。没有删除租约或重置历史 fence。
6. 目标通过原生 Agent resume 和既有模型/权限/pending-input 闸门准备会话。原有输入
   不重新发送；用户的新输入可继续。原生恢复追加自身协议事件时，原历史前缀不变。

目标导入前用私有目录中 fsync 的 marker 绑定 migration ID、session 和快照摘要。
公开 `withFileLock` 按 Session 在同一目标主机串行保护 marker、目录归属和导入；
原生 writer lock 继续保护日志。marker 更新使用完整临时文件 fsync、原子 rename 与
父目录 fsync，不会因写断产生半份状态；崩溃遗留临时文件不作为所有权凭据。
只有匹配的 marker 能继续中断的暂存导入；native 日志只能是完全相同的前缀。
已推进的会话、陌生目录或原生会话、摘要变化、额外文件和未完成 turn 均拒绝覆盖。
可信暂存文件被写断时，可从同一份已认证快照修复；激活后不再导入覆盖。
极小的 mkdir 成功但 ownership marker 尚未 fsync 的崩溃窗口保持拒绝，需运维核对
暂存目录，不能以“看起来目录存在”替代所有权证据。
同一 ID 的 checkpoint 写入重试只允许原始 source proof 和仍有效的冻结 owner；
目标已激活或 owner 已变更/停用时，旧写入返回冲突，应查询持久状态。
`activated` 回执表示历史迁移提交成功；再次 `recover` 仍需当前登录、active owner、
项目权限和目标执行身份，回执本身不会重新启用已停用会话。

## 明确限额与保留

- 每份 JSON 快照最多 32 MiB、10,000 条事件；工作区最多 256 个目录/文件条目、
  8 MiB 正文，单文件最多 2 MiB。
- 只接受普通文件和目录，拒绝符号链接、硬链接、设备/socket、路径逃逸、重复路径、
  不一致的父目录、异常编码和摘要。二进制内容原样保存；权限规范为私有目录700、
  普通文件600、源用户可执行文件700，不复制 setuid 或其他用户的访问权限。
- 所有读写有请求取消和节点失租信号；恢复 API 有界执行。失租来源不能通过重试恢复
  旧执行身份。原生 kernel writer lock 不被绕过，旧进程未退出时可能需运维处理后恢复。
- 迁移快照作为恢复证据保留，不参与推断式零引用删除。当前没有快照自动过期或物理
  删除功能；应按会话备份数据配置对象存储的访问控制、加密与容量预算。

## 已完成验证与尚待环境验收

真实隔离 PostgreSQL 用例覆盖 owner/lease/fence 原子切换、多个激活请求、服务重建后
回执读取、原节点重启不能逃出冻结、伪造 owner/project/realm/token/摘要拒绝、离线目标
和失败激活不部分提交。HTTP 用例检查严格 envelope 和固定错误码。

TypeScript 用例使用两个独立 AgentLoop/原生 JSONL 上下文验证精确 header/谱系与事件
前缀、二进制文件、后续新输入、激活回包丢失无重放、目标重启后的断文件/日志前缀
继续、陌生目录拒绝、模型策略撤回、权限/孤儿意图、链接/路径/大小限制及单会话退休。
测试的控制面 HTTP 为协议替身；数据库权威行为由上述真实 PG 用例独立验证。

2026-11-09 续开发已通过 Session-control 真实隔离 PostgreSQL 全包竞态回归：
300 PASS / 0 FAIL / 0 SKIP（包含子测试），报告为
`/private/tmp/lumo-session-control-final-20261109.jsonl`。另补畸形成功回执的
checkpoint/activate/query 分类回归，确认写操作保持 unknown、只读查询返回 unavailable。

尚需多主机独立卷、真实共享对象存储和已安装节点的端到端断电、网络分区与原生
文件锁验收。上述本机测试不等于物理跨主机生产故障验收。

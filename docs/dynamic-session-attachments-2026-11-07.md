# 动态会话附件

附件应用默认关闭。部署在 `LUMO_USER_SESSION_EXECUTION`（或 Helm
`dshWeb.userSessionExecution`）中显式加入：

```json
{"attachments":{"realm":"dev","maxUploadBytes":8388608,"maxTextBytes":1048576,"maxPerMessage":4}}
```

`realm` 必须等于部署 Realm，三个限额只能收紧。启用必须具备共享不可变
`ctx.attachments` 和持久执行租约；不得回退本地文件。支持 UTF-8 的
`text/plain`、Markdown、CSV、JSON（作为纯文本处理），以及原生 PNG/JPEG/WebP/GIF。
PDF、Office、HTML、SVG 和其他格式明确拒绝；不执行脚本、宏、OCR、远程 URL 或宿主路径读取。

页面在选定会话后上传二进制，服务器完整验证后返回不含对象键、URL、路径的 opaque
`receipt_id`。上传不等于已向模型发送；消息内容只接受严格的 text 或
`{"type":"attachment","receipt_id":"att_…"}`。浏览器不能提交原生 image/base64、
file ref 或自行构造持久引用。文件名和普通消息不能伪造服务器保留的附件 marker。

迁移 028 的 PG receipt 绑定 Realm、owner 用户、project、session；对象保存在既有不可变
AttachmentStore。每次创建、读取、继承都由当前进程密钥、node generation、精确 session
执行租约校验，等待数据库锁后重新按数据库时钟核对 expiry。每个会话最多 100 个未退役、可再次发送的 receipt；历史累计回执不截断，
每进程最多两个传输，有 30 秒截止时间。上传失败可留下无法访问的内容寻址对象，不签发
部分 receipt；对象回收需遵守其他日志/receipt 引用的保留策略。

独立入口：

- `POST /lumo/session-attachments/{sessionRef}`：原始二进制，明确支持的
  `Content-Type`、URI 编码的 `X-Lumo-Attachment-Name`、`X-Lumo-Auth-Request: 1`。
- `GET /lumo/session-attachments/{sessionRef}/{receiptId}`：完整有界读取，先验证字节数与
  SHA-256 再返回下载，使用 no-store、nosniff、attachment disposition 和 sandbox CSP。
- 内部 `/lumo/runtime/session-attachments/...` 使用独立二进制通道、服务令牌和有界凭据封套。
  来源只向配置的固定 origin 转发，目标独立验证当前登录、项目、当前 owner 和执行租约。
  不跟随 redirect，不透传 Cookie、浏览器身份或任意 URL。

文本消息只写入服务器生成的 receipt marker；模型通过只读 `user_attachment_read` 工具按
字符 offset/limit 读取（每次最多 32000 字符，`next_offset=-1` 表示结束）。工具只允许本
Agent、本会话真实 user/message 已引用的 receipt；每次读取及返回前重新验证当前登录和
项目权限。未发送上传、其他会话、其他 owner 或撤销后的结果不能被读取。图片由服务器
解析 receipt、验证存储字节，再通过上游原生 image admission 写持久 image ref，保留模型
image modality admission 与图片预算。

重启从 PG receipt 与原生日志恢复。fork 只从 completedPrefix 的 user/message 中提取
实际 receipt，先绑定到仍 reserved 的新 owner，再激活；未发送上传和未完成轮次不继承。
带附件的队列编辑当前不支持，普通文本编辑也不能伪造保留 marker。

验证分别覆盖真实 AgentLoop/JSONL 的重启和 fork、未发送隔离、图片原生入参、损坏字节、
撤权、固定跨节点路由，以及 Go PG 的精确 owner/lease/锁等待到期与部分写回滚。HTTP
测试覆盖大于 JSON 请求上限的二进制上传和目标独立认证。这些应用验收不代表未配置的
真实模型供应商或物理跨主机故障验收已完成。

## 附件逻辑退役（2026-11-09）

“管理已上传附件”可重新读取当前 Session 的可用回执，加入待发送，或显式退役。待发送附件上的退役按钮也会先持久化退役，再移除界面项。`attachmentList` 与 `retireAttachment` 通过现有 owner Session 路由到当前执行节点；浏览器不提供内容键或存储地址。

退役以 `retired_at` 记录不可逆时间，重复请求返回相同回执。Go 权威事务锁定当前节点、执行租约和 owner，核对 realm、用户、项目、进程 secret、writer 和 fencing token，并在取得锁后与提交前使用数据库当前时间重验租约。等待 owner 锁时过期的操作回滚。迁移已冻结的 Session 不允许退役；迁移检查点也等待正在进行的附件管理操作。

后续消息的附件提升会拒绝退役回执。执行节点在附件解析之前建立每 Session 的发送/退役互斥位，保持到原生 prompt 接受或请求失败，避免先读到可用回执、退役后再发送。已经接受的队列项属于已有输入，不撤回、不重发。跨副本写入仍由精确执行租约和原生写者锁限制。

历史消息仍能下载与调用只读附件工具；只读工具继续要求该回执出现在本 Session 的原生用户消息中。创建分支时仅复制已完成前缀引用的回执，复制当时的 `retired_at`；退役回执不会因继承而恢复可发送状态。退役前已经建立的其他 Session 回执独立保留。

网络中断可能发生在退役已提交之后。界面保留待发送项并显示失败；用户可点击“读取附件与容量”重新核对并移除已退役项，也可重复同一个幂等退役请求。不会自动发送消息。

迁移 `044_session_attachment_retirement.sql` 与启动 DDL 都为已有回执追加可空 `retired_at`，不改写已有内容。退役仅管理可用性：旧 `content/`、`file-content/` 内容与原生日志可能共享，继续保留原生引用、配额 charge；可发送名额与累计保留量分开统计。它不释放容量，也不向托管内容 GC 提供删除权威。


## 长期会话容量管理（2026-11-09）

`attachmentInventory` 接受 `status=active|retired|all`、`limit=1..100`（默认 50）和上一页 `next_cursor`。库存按 receipt ID 做 keyset 分页，返回公开回执，不包含对象键。游标仅用于同一范围的继续浏览；并发新上传或退役后重新读取第一页，分页不是冻结快照。每页及统计在同一个持有 owner 锁的权威事务中读取，等待锁后、提交前均重新验证精确节点和执行租约；返回浏览器前再核对登录与项目授权。

`usage` 包含累计、活跃、退役的回执数及逻辑字节，固定 `accounting=logical-retained-reference-bytes`、`retirement_releases_quota=false`、`active_limit=100`。这些字节按持久引用计费，分支另计，不代表内容去重后的物理占用或可回收量。Realm / Project 的总配额仍是独立的硬约束。退役只释放当前会话的发送名额，历史读取、分支继承和配额 charge 保留；配额不足应由管理员调整保留策略或配额，不能承诺退役立即释放磁盘。

分支对已完成原生日志前缀中的全部 attachment marker 去重后每批最多 100 个继承。逐批验证父会话当前归属和登录/项目授权，子会话在所有批次成功前保持 reserved；失败不暴露部分可用分支。重复批次不增加回执或逻辑 charge，已退役回执保持退役，未出现在前缀中的上传不继承。创建失败后，内部清理使用该 child 的一次创建 token 和当前执行 proof；先退役本进程 child 租约身份，再事务内只允许 reserved/failed 且同父 child 的暂存引用释放，置 failed 阻止后续激活。激活若已提交，清理被拒，active 历史和 charge 全部保留。进程崩溃或清理结果未知时仍保留，不能推断不存在引用。迁移继续使用同一 session_ref 的权威 PG 回执行，不通过有界列表截断历史。

迁移 `045_session_attachment_inventory.sql` 与启动 DDL 添加活跃回执索引，支持名额统计。没有对旧共享命名空间、Session 快照、Spill、备份做物理删除。它们仍需完整引用权威、保留期和恢复证明后才能单独设计 GC。

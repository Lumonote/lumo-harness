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
执行租约校验，等待数据库锁后重新按数据库时钟核对 expiry。每个会话最多 100 个 receipt，
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

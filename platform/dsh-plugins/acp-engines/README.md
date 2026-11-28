# 本地 ACP 引擎会话

工作台按可信的 realm、用户、项目隔离记录。左侧项目和最近对话提供搜索、重命名、置顶、归档、导出与删除；最近项只显示标题和时间。输入区支持加号附件、项目、`/`、`@` 和 Skill；右栏展示文件、工具、Diff、计划、附件容量和远程任务。

## 历史、草稿与进程

完整事件、消息受理记录、续接请求和元数据保存在状态目录的 `acp-conversations.sqlite`，通过 SQLite 事务、WAL 和 FULL 同步在执行前保存用户消息及稳定 `clientMessageId`。分页接口为 `GET /sessions/:id/history?before=N&limit=200`，全文检索为 `GET /sessions?q=...`，丢失发送响应后可查询 `GET /sessions/:id/receipt?clientMessageId=...`；重复发送相同标识不会再派发，不同正文复用标识会被拒绝。

“释放进程”保留聊天和引擎恢复句柄，“删除记录”才删除历史并释放附件引用；运行中必须先停止并等待引擎确认。引擎意外退出、运行时重启会将未确认回合标成中断，绝不自动重新执行。原 `acp-sessions.json` 的旧记录会迁移，但原本未存储的正文无法补造，仍显示历史不完整。SQLite 不受旧 JSON 索引的 128 项上限限制。

恢复原生上下文使用 `session/load`，失败保留历史与重试入口，不回退到 `session/new`。加载时的历史转写和权限请求不会作为新消息或新审批执行。SSE 使用事件序号去重、断线补发和分页补齐；慢客户端会关闭订阅并从持久日志重连，不无限缓存。

草稿按环境、身份、项目、会话保存文字、Skill、引用和视图状态；附件二进制放入 IndexedDB。切换身份不混用草稿；取消或发送失败保留未确认内容。上下文加载已有独立取消信号，停止和浏览器断开可立即释放准备阶段的工作区；已发出的回合则等待引擎终态再释放。同一真实目录通过租约避免独立会话与群组并发修改。

ACP 本机进程仅在本地部署启用，`LUMO_ACP_ENGINES=off` 可关闭，`LUMO_ACP_MAX_SESSIONS` 默认 8。支持恢复的空闲进程可回收，历史继续保留。独立插件可用 `recoveryIndexPath` 指定状态目录，默认 `.lumo/acp-sessions.json`，SQLite 保存于相邻路径。

## 角色协作

群组支持 2–6 个跨引擎角色、通讯录、Logo 和颜色，以及指定成员、顺序协作和讨论汇总。团队与话题续接保存可见交接摘要，归档不占活跃话题容量；执行前先预检并连接本轮所需成员，避免运行一半才发现容量不足。

房间采用 v2 摘要索引与独立话题快照，兼容旧数据；群组通过增量 SSE 订阅当前回合，历史另行分页。角色上下文只共享公开答复。跨引擎续接不会声称转移供应商的隐藏会话状态，而是在新对话首轮使用用户确认的摘要。

附件有持久引用、容量统计和清理入口。未被引用的上传超过 24 小时宽限期可回收，历史存在时保留附件。文件预览限制在所属工作区，安全显示文本与支持的位图；PDF/Office 等不支持的格式明确提示，不执行活动内容。远程执行复用治理项目、执行者和集群的任务链，显示实际分配节点、控制状态、结果和产物；本机目录和附件不会被伪装成远端已有文件。

## 工具与模型

Agent 工作台的「开发工具与模型」展示全部已注册工具；检测到入口与完成登录是不同状态。「连接并读取模型」建立临时会话读取真实能力后关闭，不派发任务。ACP 使用 `configOptions`，兼容旧版 `models`；Codex 桥接使用 `model/list` 并把选择传给 `turn/start`。没有静态模型名单。

`POST /engines/:id/models` 读取目录，`POST /sessions/:id/model` 切换独立会话模型。`GET/POST /agents` 和 `POST /agents/:id/delete` 管理按身份范围隔离的通讯录；`POST /rooms/:id/connect`、`POST /rooms/:id/model` 连接成员或切换模型。全部路径以 `/lumo/api/acp` 为前缀。

群组会话在列表与连接响应中带 `room` 归属，独立会话 API 拒绝直接修改其生命周期和模型。成员详情只读；回合和审批继续使用现有引擎链路。模型配置和成员句柄写入失败时保留控制入口，不伪报成功或自动重复发送。

## 真实本机 Claude 验收

默认启动优先寻找 `claude-agent-acp`，兼容 `claude-code-acp`，按需安装固定为 `@agentclientprotocol/claude-agent-acp@0.113.0`。能力、命令、模式和模型来自握手及原生事件。可用以下显式开关运行真实调用（会使用本机登录和模型额度）：

```sh
LUMO_REAL_CLAUDE_SMOKE=1 \
LUMO_CLAUDE_ACP_BIN=/absolute/path/to/claude-agent-acp \
CLAUDE_CODE_EXECUTABLE=/absolute/path/to/claude \
node --experimental-transform-types platform/dsh-plugins/acp-engines/tools/claude-local-smoke.mjs
```

脚本在新的系统临时目录中读取随机标记、写固定内容，并验证原生工具事件、一次性权限、消息幂等、持久历史、释放/重启/恢复和取消。仅批准 fixture 文件的指定操作；结果保存在该目录 `report.json`。该脚本验证真实引擎和存储，浏览器及真实分布式服务器应另行验收。

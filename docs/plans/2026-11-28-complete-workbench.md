# 对话与环境工作台完整开发

用户已授权完成 `docs/optimization-review-2026-11-28.md` 中的全部开发项。保留当前工作区既有改动，不提交或重置；`deepseek-harness/` 只读。

## 实施与验收清单

- [x] SSH：指纹实际验证、隧道/服务就绪、失败/重启状态恢复、任务自动刷新、原子保存与损坏保护。
- [x] 独立聊天：持久事件日志、分页、重启恢复、历史查看、释放进程与删除记录分离。
- [x] 历史管理：重命名、归档、置顶、搜索、导出、继续/分支。
- [x] 草稿：按环境/身份/项目/会话保存文字、附件、Skill、引用、目标和视图状态。
- [x] 执行可靠性：稳定消息 ID、受理记录与查询、共享工作区执行锁、取消和异常清理。
- [x] 原生交互：引擎命令/模式、计划、结构化工具输入输出、Diff/文件/产物预览、Skill 来源和加载状态。
- [x] 环境：共享地址簿、身份与真实执行位置、本机激活向导、在线状态、暂停与退出。
- [x] 远程执行：复用受管设备/调度任务链路、上下文映射、事件与产物引用、恢复状态。
- [x] 群组：团队与话题续接、可见摘要、归档/历史分页、容量预检与可恢复的空闲进程回收。
- [x] 附件：存储统计、持久引用、未引用附件回收、容量反馈。
- [x] 性能：摘要索引、增量群组事件、列表缓存、消除消息全量序列化、基准。
- [x] 原生维护：准确覆盖层清单及删除条件、公开扩展替代、入口按模块拆分。
- [x] 菜单：紧凑新对话入口、环境/执行入口与右栏功能整合。
- [x] 本地验收：单元/协议/真实 Claude Code 进程、模拟界面、类型/构建/守卫。
- [x] 本机联合核验：真实 Claude 写入、官方 Codex CLI 只读复核；群组审批、成员同步、双引擎恢复和原生取消。
- [ ] 应用内双模型完整接力：当前 Codex 模型服务返回仅允许官方客户端的 403；已保留失败和实际工具结果，需兼容的服务配置后复验。
- [ ] 外部验收：真实分布式服务器、SSH 主机、设备激活与断网重连；尚无指定测试服务器。

## 分工

- ssh_reliability：remote-hosts 服务、SSH 执行器、共享契约、面板与测试。
- chat_frontend：对话/群组/历史/附件的前端和测试。
- desktop_connections：受信桌面连接、设备激活、状态投影、地址簿与环境界面。
- rooms_attachments：群组、话题、附件存储、文件预览和服务端测试。
- 主任务：持久聊天、EngineHost、发送幂等与执行锁、原生协议投影、路由接线、远程执行整合、覆盖层治理与总体验证。

## 接口约定

- `GET /lumo/api/acp/sessions/:id/history?before=N&limit=200`：`{events:[{seq,event}],hasMore,before?,seq,session}`。
- `POST /sessions/:id/metadata`：`{title?,archived?,pinned?}`；`POST /release` 保留记录和恢复索引；`POST /delete` 明确删除。
- `GET /sessions/:id/export` 导出；`POST /prompt` 增加稳定的 `clientMessageId`。
- `POST /rooms/:id/continue`：`{summary,name?,id?}`；原话题保留，生成继承团队配置的新话题。
- `SessionSummary` 增加 commands/modes/archived/pinned/historyOnly；新增 session.commands/session.modes 事件。
- 工具事件：`input/output` 有界字符串、`locations`、`diffs`、`exitCode`；计划条目规范化。
- `EngineHost.reserveWorkspace(cwd,owner)` 返回释放函数，重复 owner 用引用计数；prompt 通过 options.workspaceOwner 参与同一租约。
- `ensureCapacity(count,scope,excludeIds)` 可回收同身份可恢复的空闲会话；`release` 保留恢复句柄。
- 附件 `stats/retain/releaseOwner/collect`；历史记录删除才释放引用。

## 进度记录

- 2026-11-28：全部列出的开发项已落盘。用户随后指定本机 Claude Code，真实文件操作、一次性审批、幂等、原生恢复和取消已通过，不再等待引擎信息。
- 2026-11-28：按补充授权完成 Claude + 官方 Codex CLI 联合核验；真实 UI 联测发现并修复角色会话映射/审批归属和恢复后项目目录两项问题。应用内自动接力的模型服务限制见验收文档，未修改身份绕过限制。
- 本轮证据、真实链路边界及复现入口见 [开发验收](../workbench-acceptance-2026-11-28.md)；性能见 [规模验证](../workbench-scale-2026-11-28.md)。
- 未提交、发布或修改 upstream；真实远端联调和浏览器冷启动/长对话/慢网性能测量仍是验收工作，不能由模拟测试推导通过。

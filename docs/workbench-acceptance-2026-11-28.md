# 对话与环境工作台开发验收

日期：2026-11-28（Asia/Shanghai）。对应 [优化审查](optimization-review-2026-11-28.md) 的 12 个开发项和用户确定的紧凑原生交互要求。本轮保留既有未提交修改，未提交、部署或发布。

## 已交付的开发

| 范围 | 最终行为 | 主要实现 |
| --- | --- | --- |
| SSH 与连接 | 实际校验 SHA256 主机密钥，SSH/SCP 共用固定信任；端口绑定和 HTTP 就绪后才显示连接；取消、退出、重启、损坏配置有明确处理 | `remote-ssh*`、`remote-host-store`、`remote-hosts-api` |
| 持久聊天 | SQLite 保存完整事件、元数据、受理和续接记录；分页、正文检索、导出；进程释放保留记录，删除独立 | `conversation-store`、`sqlite-conversation-store`、`conversation-routes` |
| 草稿与历史 | 按环境/身份/项目/会话保留文字、附件二进制、Skill、引用和查看状态；重命名、归档、置顶、续接 | `conversation-drafts`、`conversation-management`、`use-conversation-search` |
| 可靠执行 | 发送前原子受理、稳定消息 ID、丢响应查询、真实工作区互斥；Skill 准备阶段可立即取消，已执行回合等引擎确认停止 | `engine-host`、`workspace-leases`、`routes` |
| 原生交互 | 保留引擎公布的命令、模式、工具输入输出、Diff、位置和计划；`/`、`@`、Skill、加号附件、项目与右侧工具区 | `session-protocol`、`agent-composer-input`、`agent-execution-content`、`agent-chat-dock` |
| 环境与本机设备 | 统一地址簿；真实进程/证书/连接新鲜度；受信本机激活、暂停接单、恢复、退出；构建已有 desktop-agent | `desktop_connections.rs`、`server_book.rs`、`local_status.go`、`environment-panel` |
| 远程任务 | 复用治理项目、合格执行者、集群和 delegation/task/run 链路；幂等提交、实际分配节点、暂停恢复取消、结果产物 | `chat-remote-api`、`chat-remote-execution` |
| 群组与话题 | Logo/颜色、跨引擎角色、可见摘要续接、归档、历史分页、启动容量预检和可恢复空闲进程回收 | `role-room-*`、`role-rooms` |
| 附件 | 持久引用、占用统计、24 小时宽限期后的未引用上传回收；记录存在时保留文件 | `attachment-lifecycle`、`attachment-store` |
| 性能 | 群组摘要索引、独立话题快照、增量 SSE、分页与去重订阅；移除消息全量序列化滚动依赖 | [存储规模验证](workbench-scale-2026-11-28.md) |
| 原生维护 | 新功能放在平台模块；登记 9 包范围及根配置的历史覆盖债务、替代入口和退出条件；实际文件变化校验 | [覆盖层清单与退出计划](../platform/dsh-overrides/README.md) |
| 菜单布局 | 左侧项目/最近对话，最近项只显示标题和时间；紧凑输入区和图标，右栏按需展开 | `agent-chat*`、`role-room-surface`、`environment-panel` |

远程任务选择的是现有契约支持的执行者与集群；最终机器来自真实 `assigned_node_id`，没有虚构指定节点接口。本机文件和附件不会未经同步便声称可在远端读取。安全文件预览覆盖文本与位图，PDF/Office 等格式明确显示当前不支持。

## 自动回归和构建

- ACP：16 个测试文件、149 项通过；性能测试默认跳过，另行显式运行通过。包括日志写入失败重试、回合结束后旧审批撤销、删除后迟到回调、取消 Skill、工作区租约、SSE 慢客户端及断线补齐。
- 对话、附件、远程任务、SSH、环境及桌面构建相关 UI/协议：19 个测试文件、150 项通过。
- 真实双引擎联测后新增 3 项前端状态回归和 1 项服务端映射回归；最后相关 9 套、94 项复测通过，ACP 全套已包含新增服务端项。UI 严格类型与生产 server/client 构建再次通过。
- 覆盖层与构建组合：50 项通过；清单对应当前上游实际变化 16 个文件，两个启动包在当前版本仅检查原生兼容性。
- 桌面 Rust：全套 93 项通过；最后设备生命周期修改后 4 项定向检查再次通过。Registry `desktop-agent` Go 包测试通过。
- 平台服务端和 Lumo UI TypeScript 检查通过，Lumo UI server/client 构建通过，全仓守卫与 `git diff --check` 通过。旧大文件基线未增加，主要入口和桌面构建文件已缩小。

各组合存在交集，不将以上数字相加为唯一用例总量。构建仍报告 tsdown `external/noExternal` 配置弃用警告；Node 22 对内建 SQLite 给出实验性 API 提示，均未造成构建或测试失败。

## 真实本机 Claude Code

用户指定使用本机 Claude Code。已用本地 `claude` **2.1.322**，通过 `@agentclientprotocol/claude-agent-acp` **0.113.0** 和 `CLAUDE_CODE_EXECUTABLE` 明确调用该可执行文件。测试使用新的临时目录和默认手动审批模式，不在项目源代码中执行模型写入。

2026-11-28 **14:32:22–14:32:49** 的成功运行验证了：

1. 实际 initialize/session-new，读取引擎返回的模型与模式。
2. Claude 读取随机标记文件；仅批准固定目标、固定内容的一次性写入，产出 `receipt.txt`，并接收到真实工具事件。
3. 同一消息 ID 重发只返回原受理记录，不再执行。
4. 释放进程并重新创建 EngineHost 后，完整日志仍存在；原生 `session/load` 恢复后，Claude 无需读文件便复述上一轮随机标记。
5. 新回合调用原生取消，收到 `stopReason=cancelled`。

会话 ID：`a392d81f-90c5-428f-98dd-b7d2f5286b64`；引擎会话 ID：`e6d6a6a6-e92c-4e5b-9c01-9c1db332efd7`；落盘 46 条事件。报告保留于本次机器临时目录 `lumo-claude-smoke-GF8Tel/report.json`。可复现脚本见 [claude-local-smoke.mjs](../platform/dsh-plugins/acp-engines/tools/claude-local-smoke.mjs)，使用说明见 [ACP README](../platform/dsh-plugins/acp-engines/README.md)。

首次沙箱调用未返回，提升网络权限后能调用模型。验收脚本曾错误匹配旧的一次性授权 ID，且一轮模型误用了 `/tmp` 简写路径；脚本拒绝了这些操作，随后修正授权 ID 与提示中的完整路径后通过。没有因此放宽审批或目录范围。

## 真实浏览器 Claude Code

通过 `127.0.0.1:4199` 的本机验收入口，使用生产 `EngineHost`、附件存储、群组与 ACP 路由，实际完成了 UI → BFF → 本机 Claude → 文件的链路。目录限制为 `/private/tmp/lumo-workbench-browser-smoke/project`，未加载项目源码或修改用户配置。

1. 在界面选择临时项目，通过加号上传测试 `README.md`。
2. Claude 读取附件中的验收值，发出 `Write browser-result.txt` 权限请求；界面展示完整目标路径与内容。
3. 点击一次性 `Yes`，真实工具状态变为已完成，返回 `LUMO-REAL-BROWSER-2026`。
4. 从右侧项目文件打开 `browser-result.txt`，预览显示相同值；浏览器控制台无错误。
5. 从会话设置释放运行资源后，界面显示“会话已关闭／可恢复”，聊天内容、工具记录与附件仍在。

会话 ID：`1f3676d6-0e36-43f0-958a-b0ba6b5d1b04`。此阶段入口未接入 Skill，后续已通过隔离的真实 SkillRegistry 完成正文加载验收（见下节）。分布式服务未配置，文档预览别名为验收 fixture，不计入真实 PDF/Office 或远程链路验收。

## Claude Code + Codex 联合测试

按用户补充授权，加入本机 `codex-cli 0.166.0`，使用真实 `codex app-server` 和生产 `bridgeCodexToAcp`。测试沿用已有登录，Codex 保持 `on-request`／`workspace-write`，Claude 使用手动审批。

2026-11-28 14:52–15:06 的真实界面测试确认：

- 创建两个角色、两个引擎的群组，实际连接双方进程并读取真实模型列表。
- Claude 读取 `browser-result.txt`，公开报告 `LUMO-REAL-BROWSER-2026`；Codex 的持久消息中包含该公开回复，随后执行读取同一文件的命令，工具输出相同且退出码为 0。
- Codex 后续模型请求返回 HTTP 403：`This account only allows Codex official clients`。原会话后续回合和全新话题的无工具回合也未成功；界面正确标记失败并保留已执行的工具结果。因此，**应用内双模型完整自动接力未通过**，不能将工具成功或上下文已传递等同于整轮成功。
- 释放双方进程、重启验收 BFF 后恢复，两个角色均回到“可对话”；原有历史、附件和工具输出保留。
- UI 停止 Codex 回合后，持久日志记录 `stopReason=cancelled`（15:02:01）；群组显示已停止。
- 通过可见摘要创建新话题，保留团队、项目和摘要，旧话题归档保留；新成员首次连接时，无需刷新即可打开成员会话。
- 新话题内 Claude 的固定文件写入审批及时出现在群组中，并正确归属成员。一次性批准后生成 `group-approval.txt`，右侧预览显示 `GROUP-APPROVAL-OK`。

原群组 ID：`2b0f0e8b-407d-4c39-8d14-6f963804331a`；续接话题 ID：`a0197450-a098-4874-8bcb-2312b542c8db`。当前本机验收状态存放在 `/private/tmp/lumo-workbench-browser-smoke/state`；结束时全部五个测试引擎会话均已释放，记录仍保留。

为区分账号在官方 CLI 与应用接入中的行为，另外运行了本机官方 `codex exec --ephemeral --sandbox read-only`：固定无工具文本检查成功；再将 Claude 的公开交接结果交给 Codex，仅允许核验两个指定测试文件，两个读取命令均退出 0，最终返回：

```json
{"receivedHandoff":"A3N8R6T4","fileMatch":true,"approvalFileMatch":true}
```

这证明 **Claude 生成 → 官方 Codex CLI 独立核验** 已通过；这次交接由测试执行者提供，不能替代应用内自动接力验收。没有修改认证、服务地址、客户端身份或放宽沙箱来规避 403。剩余自动接力验收需要当前服务允许该应用接入，或用户配置支持该接入方式的模型服务。

联测修复了两项真实界面缺陷：

1. 群组增量事件原先缺少角色会话 ID；前端又丢弃相同 revision 的权威快照，导致成员详情入口和审批归属不及时更新。现增量同步角色会话映射并接受同版本权威快照，继续拒绝旧快照；真实群组审批和详情已复核。
2. 已有独立会话重载时，设置面板的项目目录未初始化。现随会话接入填入目录，流式状态变化不会覆盖手动输入；真实刷新和恢复记录已复核。

## 设置与审批界面、真实 Skill 补充验收

2026-11-28 15:41–15:55，继续使用上述本机真实入口完成：

- 会话与群组设置改为名称管理、工具与模型／群组外观、工作区、话题与运行。记录操作使用原生图标，已释放的会话只显示恢复入口，并禁用尚不可用的模型／模式修改。
- 项目选择只保留一行，默认显示项目名，完整路径在悬停提示中；编辑图标原位切换路径输入，Enter 完成、Esc 恢复原值。目录选择仍使用已安装的宿主目录服务。
- 权限请求使用共用卡片：工具、成员和完整目标路径直接展示，原始参数按需展开。执行命令始终直接可见。使用 DSH 公开 `Button` 组件，页面旧样式不再覆盖原生按钮的背景、边框、尺寸、悬停和禁用状态。
- ACP 选项附带原生 `permissionKind` 展示信息；仅将已知英文文案改为“允许一次／本会话允许编辑／拒绝”，未知文案保持原样，回答仍提交原始 ID。
- 使用真实公共 `Context`、`SkillRegistry`、`FileSystemSkillProvider` 和生产 `acpSkills`；只加载临时 fixture 根目录（`includeDefaultRoots:false`、`watch:false`）。界面只列出 `browser-proof`，`user-invocable:false` 的 `browser-internal` 被过滤。Claude 返回正文独有标记 `LUMO-SKILL-38a5660d-8d80-4a96-9d13-0160167d3c45`，本轮用户消息未带标记，持久日志没有工具调用，结束原因为 `end_turn`。
- 群组写入被拒绝后返回 `DENIED-OK`，目标 `denied-proof-20261128.txt` 不存在。等待第二个写入审批时停止，日志记录审批 `cancelled`、回合 `cancelled`（15:48:09），目标 `cancelled-proof-20261128.txt` 不存在；随后无工具消息返回 `AFTER-CANCEL-OK`。
- 更新后的真实审批界面显示原生主按钮与次按钮，拒绝后返回 `STYLE-DENIED-OK`，`permission-style-proof.txt` 不存在。1280 像素桌面和 430 像素窄屏、深浅主题完成检查；窄屏文档宽度与视口均为 430，审批和输入区无横向溢出。主授权按钮实测高 28 像素。

日志核对发现 broker 重建后，递增计数器会为同一个恢复的引擎会话生成重复审批 ID。现改用 UUID，回归验证旧 ID 无法回答新 broker 的请求；未改变引擎的选项 ID 和权限语义。

最后组合回归：23 个测试文件、206 项通过，1 个性能用例按默认条件跳过（此前已单独通过）；包括新增的路径编辑取消、中文输入法 Enter、历史会话模型禁用、权限原始 ID／文案保留和重启后旧审批拒绝。服务端与 UI 类型检查、生产 server/client 构建、仓库守卫通过。测试结束时全部引擎进程已释放，记录保留。

## 浏览器和剩余验收边界

通过受控浏览器检查了模拟预览的新建、项目选择、Logo、深浅主题、`/` 命令/Skill 菜单、`@` 文件引用、消息代码块、复制按钮、右侧执行记录及切换页面后草稿恢复。800 像素宽视口无横向溢出，空输入框实测高 38 像素，文字 14 像素；复制控件位于代码块标题行，未覆盖外框。该预览始终标明“模拟工具与回复”，不能替代真实执行证据。

真实 Claude 全链路、双引擎进程恢复与停止、官方 Codex CLI 核验已通过；应用内自动接力受上述模型服务 403 阻塞。真实分布式服务器、SSH 主机、设备证书、调度策略和断网重连尚未联调，因为没有指定测试服务器。对应代码与协议测试已完成，不能据此声称远端整条用户链路通过。存储基准不包括冷启动、浏览器长对话渲染和真实慢网络；这些限制详见性能文档。

上游洁净检查：`git -C deepseek-harness status --porcelain -uno` 无输出，`describe --tags --dirty` 为 `dsh-v0.2.3-alpha.2`。本轮没有修改上游源码。

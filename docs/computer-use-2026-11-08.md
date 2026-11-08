# 2026-11-08 本机电脑操作

目标是让现有对话里的 Agent 像 Codex 一样观察应用、截图、点击、输入、滚动和拖动。本次复用上游 Computer Use 的公开插件和工具，平台补齐当前对话授权、桌面互斥、停止控制和打包。没有另建 Bolt 助手，也没有修改 `deepseek-harness/` 源码。

## 使用

1. 在本机桌面工作台的插件页面启用官方 **Computer Use** 扩展。
2. 打开要执行任务的对话，使用官方支持的 **PTC** Agent 预设。
3. 打开侧边栏的「电脑操作」，点击「允许当前对话操作电脑」。该授权只对当前对话有效，重启后需要重新授权。
4. 在对话里说明任务。首次操作时按官方界面完成 macOS 系统权限和逐应用授权。
5. 「立即停止」立即拒绝新的电脑操作并取消当前动作；正在结束的 Provider 返回前，面板保持停止中。

以上为 macOS 官方扩展的使用路径。Windows 本地 Web profile 通过 `LUMO_WINDOWS_CUA=1` 显式加载独立 Provider，再在同一面板授权当前会话；SDK、Job supervisor、工具目录和实机验收步骤见[Windows 插件说明](../platform/dsh-plugins/computer-use/README.md)。Linux 不提供本机输入驱动。

仅打开控制面板不会启动原生辅助程序或触发系统权限。模型配置继续使用原生 DSH 配置；此功能不另存 API Key、不替换供应商协议，也不自动切换默认 Agent 预设。

## 实现与边界

| 层 | 实现 | 边界 |
| --- | --- | --- |
| 桌面观察与输入 | macOS 使用官方 `@deepseek-ai/dsh-experimental-cua-macos`；Windows 可显式加载隔离 SDK Provider | macOS 14 及以上；Windows 需 `LUMO_WINDOWS_CUA=1`、目标原生包和 supervisor，尚待实机验收；Linux 不提供本机输入 |
| 工具、应用授权和截图验证 | 官方 `cua` 工具与 `cuaAccess` | 保留 OS 权限、逐应用 consent、快照过期与坐标验证 |
| 本机协调 | `@lumo/computer-use` / `lumoComputerUse` | 仅 Local Desktop 装配；Standalone/Cluster 不暴露服务器桌面 |
| 控制入口 | 本地工作台「电脑操作」 | 读取真实前台会话，显示授权归属、占用、正在结束的动作和最近事件 |
| API | `/lumo/api/computer-use`、`/enable`、`/stop` | 上游浏览器会话认证；拒绝 API Peer；写操作还要求同源 Origin 和 JSON，授权校验控制版本 |
| 安装包 | 官方 Swift helper 的 release 构建 | 构建期准备目标架构，不要求最终用户安装 Xcode |

`tools.guard` 是最终拒绝闸门，`tools/execute` 只合并调用取消信号并包裹现有 Provider。当前开放官方 `cua`，包括 PTC 内部通过公开工具管线发起的调用。识别但拒绝 `cua_driver_native__*` 和 `mcp__cua-driver-mcp__*`：这些备用通道尚不能证明取消后的后端完成时机，不能与本机互斥保证混用。浏览器可由原生 Provider 作为应用操作；本次没有新增浏览器 DOM/标签页驱动。

一次观察、动作和下一次观察共用同一个 Agent 租约，正常轮次结束才释放。同一会话的另一个 Agent 也不能插入。默认从最近调用活动起 120 秒到期，包含尚未结束的长调用；到期会取消租约，必须等本轮结束才可重新获得。停止、卸载与 Agent 结束均等待当前 Provider Promise 完成后再释放，不自行超时抢锁。官方原生通道正常取消会等待确认；若其清理本身失败，平台无法额外证明系统后台已完全静默，应检查应用状态再重试。已发给应用的输入无法撤销，也不会自动重放。

同用户、同主机的参与进程使用上游 `withFileLock` 和统一的 `~/.lumo/computer-use/desktop` 路径。只在原持锁 PID 已退出时接管，不按锁龄抢占。该锁不能协调跨主机、不同 PID 命名空间，或没有加载本插件的第三方电脑操作程序。

租约结束以公开 Session 事件中的真实 `turn/end` 为准；`agent/turn-stopping` 可被追加引导延长，不在这一阶段提前解锁。原生对话取消、模型异常和轮次结束都会关闭本轮租约；取消时等待进行中的调用返回后释放。

授权请求携带最近状态中的 `controlRevision`，成功授权或停止都会推进版本。停止可覆盖页面上尚未完成的授权请求；先发出、晚到达的旧授权不能在停止后重新开启桌面控制。后台缺少当前平台的 Provider 时拒绝授权，但保留停止入口。

协调日志保留最近 100 条内存元数据：会话/调用标识、工具、已知方法、时间和结果代码；不复制截图、输入文本、剪贴板内容或原始错误文本。上游对话仍按其自身规则保留工具执行轨迹。

## 打包与发行

`platform/desktop/cua-helper.mjs` 在复制后的 runtime 包内调用官方 `native/build_app.py`，构建目标架构的 release helper。源码包里遗留的 `native/.build`、`native/bin` 不进入复制流程。生成后及通用裁剪后分别验证 receipt、内容摘要、Mach-O 架构、可执行权限和 codesign；缺少产物会阻止构建。

源码插件的依赖闭包入口和 TypeScript 编译清单共用 `packagedTypeScriptPluginDirectories`，避免只添加编译任务却没有把插件及其依赖复制进安装包。发布目录的 JavaScript 已在禁用 TypeScript 支持的独立 Node 进程内完成 Cordis 装配验证。

默认使用 ad-hoc 签名。正式签名可设置 `LUMO_CUA_SIGNING_IDENTITY`，以及可选的绝对路径 `LUMO_CUA_SIGNING_KEYCHAIN`。这不等于完成 Developer ID 公证；正式发布仍需完整签名、公证及安装后系统权限验收。`runtime-manifest.json` 的 `computerUse` 字段记录目标、签名类型、摘要和可重定位执行文件路径。

macOS 构建机需要 Xcode/Swift 工具链和 Python 3。Windows 构建跳过 Swift helper，改为构建目标架构的 Rust Job Object supervisor，并校验固定版本 SDK 的 DLL/Node addon PE 架构、supervisor 摘要和 receipt；manifest 的可重定位路径统一使用 `/`。缺目标原生依赖或编译失败会阻止安装包构建。

## 验证范围

- 协调器与真实 DSH 工具管线：会话隔离、整轮互斥、PTC 嵌套调用、跨进程锁、取消、卸载、过期和日志内容；真实 AgentLoop 覆盖取消、模型异常、监听器异常、追加引导延长轮次。
- 本地 API：浏览器认证、API Peer 拒绝、同源校验、请求大小/格式、部署模式隔离和异常状态。
- 页面：真实前台会话选择、授权与停止、停止中状态、缺少 Provider 和不支持平台；4185 隔离实例中实际确认侧边栏入口、状态读取、未启用时禁止授权，以及跳转官方插件页。
- 打包：TypeScript 运行依赖闭包、helper 构建参数、receipt/摘要/架构/签名和平台分支。
- 真实官方 helper：arm64、x64 均完成 release 编译、ad-hoc 签名与验证；arm64 迁移到包含空格的 `.app/Contents/Resources/runtime` 路径后验证仍通过。没有启动 helper 或申请 OS 权限。

本次不把模型模拟响应或工具 mock 当作实际电脑任务验收。真实模型观察、系统权限、逐应用授权、点击/输入/截图闭环，以及 Developer ID 公证后安装仍需专门验收。

本轮通过的检查包括：平台与客户端 TypeScript、Host/Client bundle、冻结锁文件离线校验、协调器 19 项、UI/API 与既有导航 44 项、真实打包 JavaScript 加载与编译 14 项，以及本地装配/基线和 helper 打包相关测试。最终隔离页面还实际调用了停止 API，返回关闭且未授权；测试服务已关闭。已有安装应用需要重新构建和安装才会包含本次功能。

## 后续设备与 Bot 接入

现有 `execute_task → runner socket → task_result` 保留自己的执行契约。新增远程电脑请求使用独立不可变计划、设备权威 lease 与本机 owner 逐次批准；Bot 身份不替代本机批准。批准只给指定空闲 Session 追加一次有界任务，限制 observe/interact 工具能力，持续重验设备权威，原生完成清理后上报回执。计划摘要不匹配、权限撤回、外来引导消息或过期均停止；结果未知和重启不重放。显式配置与限制见 [插件说明](../platform/dsh-plugins/computer-use/README.md#远程请求与本机逐次批准)。

桌面设备通道已支持取消与重启恢复；runner 对端实现、EOF 边界和 30 秒期限仍见 [桌面设备文档](./desktop-devices.md)。

## 2026-11-09 批准并发与取消收尾

本机 broker 在等待远端批准回执前先保留全局批准位，防止不同请求同时通过空闲检查。等待期间撤销、卸载、立即停止或本机授权变更均令旧批准失效；已确认的远端批准转为 cancel，再解除本机等待，不启动 Agent。控制版本覆盖“原来已经关闭，再次点击停止”的情况，避免仅检查 disabled 状态漏掉停止意图。

本批定向 TypeScript/打包测试为 9 文件、56 PASS、0 FAIL、0 SKIP；平台 `tsc -b --noEmit` 通过。Registry computerbridge 与 desktop-agent 在 macOS 合计 17 PASS、0 FAIL、0 SKIP 的 race 测试通过（包括真实 Unix socket runner）；报告为 `/private/tmp/lumo-desktop-agent-race-unsandboxed-20261109.jsonl`。补齐公开依赖后，完整 desktop-agent 本机构建及 Windows amd64/arm64 交叉构建均通过，computerbridge 两种 Windows 架构的测试二进制也完成交叉编译。真实 Windows Job Object 测试在 macOS 上明确跳过，不作为 Windows 实机通过证据。

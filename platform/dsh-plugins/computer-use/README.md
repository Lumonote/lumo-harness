# 本机电脑操作治理

`@lumo/computer-use` 通过上游公开的 `tools.guard`、`tools/execute` 和 Agent 生命周期事件，治理现有 CUA Provider。插件本身不生成鼠标、键盘或其他系统输入，不替换上游原生驱动、应用授权、截图验证或取消逻辑。

插件名为 `lumo-computer-use`，服务名为 `lumoComputerUse`。Provider 和 UI 由宿主配置另外组合。默认支持已核验取消确认机制的上游 macOS `cua` 工具；Windows 提供显式启用的隔离进程原型，见下文。插件同时识别 `cua_driver_native__*` 和 `mcp__cua-driver-mcp__*`，但会在派发前以 `COMPUTER_USE_PROVIDER_NOT_SUPPORTED` 拒绝它们：这些传输尚无足以证明后端静默的公开确认契约，其中 MCP 的调用可在取消时提前拒绝而远端仍未结束。普通浏览器工具使用其自身的授权机制。

## 启用与停止

插件启动时始终关闭，不接受配置文件自动启用。宿主先验证用户选中的真实会话及其访问权，再调用 `ctx.lumoComputerUse.enable(sessionId)`；只有该 Session 的工具调用才能进入 Provider。该操作不授予操作系统权限或应用访问权，上游的原生授权仍然有效。

`snapshot()` 返回启用状态、获授权的 Session、当前占用者、待结束的操作数及最近 100 条审计元数据。审计只记录工具名、已知方法名、调用标识和结果代码，不记录参数、输入内容、截图或原始错误消息。

`stop()` 立即撤销 Session 授权并取消当前工作流。在 Provider 调用的 Promise 结束前，状态保持 `stopping`，其他调用不能接管桌面；结束后保持关闭，必须由用户再次启用。停止无法撤销已经发送给应用的输入，插件不会重试或重放被取消的操作。

服务的 `controlRevision` 在每次成功启用和每次停止时递增，即使停止前已经关闭也递增。远程批准在等待设备权威回执期间保留本机批准占位，并复验该版本；等待期间的停止、本机重新授权、请求撤销和插件卸载都会阻止旧批准启动 Agent。不同请求也不能同时穿过批准等待窗口。

上游 macOS Provider 的正常取消会等待原生请求确认；传输异常时会等待连接清理。如果原生清理自身返回 `NATIVE_CLEANUP` 等失败，调用结束不能证明系统后端已经静默。插件无法撤销已递交的系统操作，也不承诺任何故障下系统回调均已消失；上游返回的清理失败需按宿主故障处理。

## 工作流独占

首个获准的 CUA 调用取得整轮工作流的桌面租约。一次截图和下一次动作之间仍然持有租约，同一个 Session 的另一个 Agent 对象也不能插入操作。同一 Agent 的并行桌面调用同样被拒绝。

租约绑定准确的 Session 对象和当前轮号。已提交的 `session/event` 中 `turn/end` 才是真实关轮边界；`agent/turn-stopping` 仍可能被追加引导消息延长，因此不会释放桌面。调用者信号取消、`agent/status` 进入空闲、`agent/disposed`、空闲期限和插件卸载也会关闭租约；释放时会等待当前 Provider 调用的 Promise 结束。正常结束一轮后保留 Session 授权，以便用户在同一会话继续下一轮。过期的 Agent 在这一轮结束前不能自动重新抢占桌面。

默认锁路径为 `~/.lumo/computer-use/desktop`，同一用户的不同配置和版本使用同一路径。插件通过上游 `withFileLock` 将独占扩展到参与该协议的其他本机进程；活着的 PID 持锁时不会因为锁时间较长而被抢占。此机制仅支持同一主机和 PID 命名空间，不支持跨主机共享目录或多个 PID 命名空间共用锁，也不能约束未加载本插件的其他电脑操作程序。

## 配置

| 配置 | 默认值 | 说明 |
| --- | --- | --- |
| `idleLeaseMs` | `120000` | 从最近一次调用活动开始计算的租约期限，范围为 100–3600000 毫秒；到期会取消尚未结束的操作。 |
| `lockFile` | `~/.lumo/computer-use/desktop` | 锁目标的绝对路径；上游实际创建 `<lockFile>.lock`。如需多进程独占，所有参与进程必须使用相同路径。 |

## 验证

在 `platform/` 下运行 `node node_modules/vitest/vitest.mjs run dsh-plugins/computer-use/__tests__`。测试使用假 Provider，不操作真实桌面，覆盖真实工具管线、最终拒绝规则、嵌套工具调用、整轮占用、会话隔离、取消与卸载、审计脱敏及独立子进程持锁。

## Windows 隔离 Provider（显式启用，待实机验收）

本地 Windows Web profile 可通过 `LUMO_WINDOWS_CUA=1` 加载 `@lumo/computer-use/windows`。这只加载能力，用户仍须在 UI 中选择有访问权的真实 Session 并启用。Provider 名称为 `lumo-cua-windows`，工具名称为 `lumo_cua_windows__*`。远端 worker 不加载此本机桌面能力；Linux 也不提供本机输入驱动。

实现复用官方 `@trycua/cua-driver@0.28.0` 的原生 SDK、动态工具目录及精确参数，并使用官方 `createMcpToolDefinition` 处理规范 MCP 结果和附件图片接纳。SDK Future 被取消不能证明原生操作结束，因此 SDK 在独立 Node 进程运行。Windows supervisor 在子进程恢复执行前将它放进禁止 breakaway 的 Job Object；停止时终止整棵进程树，确认 Job 活跃进程数为零后发出 `quiet`，Host 还须等待 supervisor 正常退出。

同一 Session 的工作流复用 driver，以保留窗口快照 token。停止、关轮、租约到期和卸载会清理该代 driver；即使当前没有调用在途，也会持有桌面租约直到清理确认。切换 Session 会创建新一代 driver。取消后必须重新发现窗口和获取快照，不得重放旧 token 或已递交的输入。supervisor 崩溃、确认丢失或清理超时会将 Provider 隔离；在途派发和桌面租约保持等待，需重启 Host，不能通过重新启用绕过。

只支持已登录的交互式 Windows 桌面。Windows 服务会话、UAC/安全桌面、提权与更高完整性级别的应用不在授予范围。权限查询只接受 `{ "prompt": false }`；需要系统授权时由用户直接处理。后台投递被拒绝不能自动切换为前台投递。默认不弹系统权限框。

在 Windows 的 `platform/` 下运行以下命令构建并核对 supervisor 和目标 SDK 的 PE 架构；桌面打包会执行相同检查。打包需保留目标架构的 SDK optional dependency。源码和 x64/ARM64 原生包必须与锁文件一致。

```powershell
node tools/build-windows-cua.mjs
```

`.github/workflows/windows-cua.yml` 用真实 Windows 编译器检查 x64/ARM64 Win32 定义，并执行 Job Object 停止与 Host 异常退出的进程测试。这些测试使用 Node fixture，不能证明真实截图、点击、文字输入或模型视觉。当前开发机为 macOS：Windows 编译、真实 Job Object 和 Windows 原生桌面均未在此机验收。

## Windows 原生桌面验收

在可丢弃、已登录的 Windows 桌面上打开专用测试窗口，再显式设置验收开关。先查看当前安装版本实际返回的工具目录和参数 schema；此步骤不发送点击或输入，只初始化 SDK 并被动查询权限。

```powershell
$env:LUMO_WINDOWS_CUA_E2E = '1'
node tools/windows-cua-acceptance.mjs --catalog
```

创建 JSON 验收计划，顶层字段为 `version: 1`、测试进程 `pid`、测试窗口 `windowId`、`observe`、`actions` 和唯一的 `expectedText`。`observe` 是从实际目录构造的 `get_window_state` 参数，须请求截图。`actions` 是至少各含一次 `click` 和 `type_text` 的数组，每项为 `{ "name": "实际工具名", "args": { …实际 schema 要求的完整参数… } }`。这些参数必须精确绑定同一个测试 `pid` 和 `window_id`（在参数根或 `target` 内），不能借用当前前台窗口。`windowId` 保留原始精确值，可为十进制字符串；不将 64 位窗口 ID 强制转为 JavaScript number。点击坐标、元素 token 和投递方式以当前 SDK schema 与新鲜快照为准。

```powershell
node tools/windows-cua-acceptance.mjs C:\acceptance\plan.json C:\acceptance\evidence
```

成功才会写入前后真实 PNG 和 `acceptance.json`：验证图片尺寸、内容哈希变化、新鲜原生窗口状态中的预期文本，以及截图取消后的 Job 清理和 driver 重新初始化。清理未获确认时命令会保持等待以保留独占，需重启验收 Host。脚本不调用真实模型，因此报告固定声明 `modelVisionValidated: false`；端到端模型视觉仍须使用声明图片输入的真实模型，在 UI 中单独验收。

## 远程请求与本机逐次批准

`@lumo/computer-use/remote` 接收设备通道下发的固定摘要计划，只有设备 owner 在本机浏览器对该计划明确批准，才能给已经空闲且没有待输入的本机会话追加一次任务。只允许按 `computer.observe` 或 `computer.interact` 白名单调用现有电脑工具；普通 shell、连接器、权限提升、额外消息和未知工具均拒绝。原生轮次及 Provider 完成清理后才发送终态回执。

本地 Web profile 需要显式设置 `LUMO_REMOTE_COMPUTER_USE=true`、`LUMO_DEVICE_NODE_ID`、`LUMO_DEVICE_OWNER_USER_ID`、`LUMO_DEVICE_BRIDGE_FILE`。设备代理的 `--computer-host-file` 指向 Host 私有状态目录中的 `remote-computer/host.json`；`LUMO_DEVICE_BRIDGE_FILE` 则指向设备代理 `--state-dir` 下的 `computer-bridge.json`。两者的 realm 和 node ID 必须完全一致。发现文件只发布 loopback 地址和随机本机 bearer；设备 mTLS 凭据保留在设备代理内。

Host 的 ledger 保留最多 200 个请求，重启会把运行中请求改为 unknown，不恢复执行；批准或完成回包丢失也不重放。私有桥接与 ledger 的进程锁在原生工作确认结束前保持，卸载无法确认静默时不释放。当前没有历史 ledger 自动回收，达到上限后须由运维核对终态记录再维护。

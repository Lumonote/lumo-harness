# 本机电脑操作治理

`@lumo/computer-use` 通过上游公开的 `tools.guard`、`tools/execute` 和 Agent 生命周期事件，治理现有 CUA Provider。插件本身不生成鼠标、键盘或其他系统输入，不替换上游原生驱动、应用授权、截图验证或取消逻辑。

插件名为 `lumo-computer-use`，服务名为 `lumoComputerUse`。Provider 和 UI 由宿主配置另外组合。当前仅允许已核验取消确认机制的上游 macOS `cua` 工具。插件同时识别 `cua_driver_native__*` 和 `mcp__cua-driver-mcp__*`，但会在派发前以 `COMPUTER_USE_PROVIDER_NOT_SUPPORTED` 拒绝它们：这些传输尚无足以证明后端静默的公开确认契约，其中 MCP 的调用可在取消时提前拒绝而远端仍未结束。普通浏览器工具使用其自身的授权机制。

## 启用与停止

插件启动时始终关闭，不接受配置文件自动启用。宿主先验证用户选中的真实会话及其访问权，再调用 `ctx.lumoComputerUse.enable(sessionId)`；只有该 Session 的工具调用才能进入 Provider。该操作不授予操作系统权限或应用访问权，上游的原生授权仍然有效。

`snapshot()` 返回启用状态、获授权的 Session、当前占用者、待结束的操作数及最近 100 条审计元数据。审计只记录工具名、已知方法名、调用标识和结果代码，不记录参数、输入内容、截图或原始错误消息。

`stop()` 立即撤销 Session 授权并取消当前工作流。在 Provider 调用的 Promise 结束前，状态保持 `stopping`，其他调用不能接管桌面；结束后保持关闭，必须由用户再次启用。停止无法撤销已经发送给应用的输入，插件不会重试或重放被取消的操作。

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

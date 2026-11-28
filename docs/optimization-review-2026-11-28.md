# Lumo 对话与环境管理：优化和开发评估

> 本文保留修复前的审查现场。2026-11-28 已完成所列开发项；修复结果和本机 Claude Code 真实联调证据见 [开发验收](workbench-acceptance-2026-11-28.md)，性能测量见 [规模验证](workbench-scale-2026-11-28.md)。真实远端链路仍未验收。

评估日期：2026-11-28。依据当前工作区实现，包含尚未提交的改动。本轮完成代码审查、定向测试和隔离的最小复现；没有修改业务代码，没有连接真实服务器或调用付费模型。

当前最需要补齐的是可靠性和用户操作的完整流程。左右对话布局、品牌 Logo、附件入口、项目选择、Skill 正文加载、模型切换、群组顺序协作和环境入口已经有实现；下一阶段应把“能打开、能发送”推进到“记录可保存、状态可信、执行可追踪、环境能接通”。

下文 P1 表示建议下一轮优先处理，P2 表示在基础流程稳定后推进。优先级同时考虑日常使用影响和执行后果，不表示已经完成全仓安全审计。工作量的小/中/大仅用于相对排序。

## 1. P1：SSH 隧道必须以真实就绪状态为准

**性质：已复现的可靠性问题；工作量：中。**

- `RemoteHostsService.openTunnel()` 调用 `forward()` 后立即设置 `connected/up`，执行记录随即写入 `succeeded`，没有等待转发端口或远端工作台就绪。
- 进程退出只更新 `tunnel.status=down`，主机 `state` 仍可保持 `connected`。
- 重新创建服务会直接载入持久化的 `up` 状态，但内存中的隧道进程表为空，`closeTunnel()` 返回 false；页面又根据旧 `up` 隐藏“建立隧道”。异常退出后可能出现“看似在线、无法断开、无法直接重连”。
- 安装等操作批准后在后台执行，前端只在初次加载及操作请求返回后读取状态，缺少任务结束时的更新；完成后可能仍显示“安装中”。

依据：[隧道启动与退出处理](../platform/dsh-plugins/lumo-ui/src/remote-hosts-api.ts#L263)、[运行成功记录](../platform/dsh-plugins/lumo-ui/src/remote-hosts-api.ts#L237)、[重启读取](../platform/dsh-plugins/lumo-ui/src/remote-hosts-api.ts#L121)、[关闭隧道](../platform/dsh-plugins/lumo-ui/src/remote-hosts-api.ts#L219)、[前端刷新](../platform/dsh-plugins/lumo-ui/src/client/remote-hosts-panel.tsx#L47)、[按钮状态](../platform/dsh-plugins/lumo-ui/src/client/remote-hosts-panel.tsx#L93)。

建议增加 `starting → ready → down/failed` 状态，分别记录 SSH 转发是否建立、远端服务是否可访问、服务器身份是否已认证。重启后对瞬时进程状态重新核对；任务期间通过现有事件链或有限轮询更新。SSH 本地设备标识也不能用作已加入调度集群的证明。

**验收：**端口占用、SSH 认证失败、远端服务未启动、运行中断线及异常重启都不会误报可用，且页面能重新发起连接；安装完成自动刷新。

## 2. P1：SSH 指纹和配置保存需要兑现界面承诺

**性质：代码确认并部分最小复现；工作量：中。**

填写的 `hostKeyFingerprint` 目前仅决定 `StrictHostKeyChecking=yes/accept-new`，实际 SHA256 值没有进入公钥比对。不同非空指纹生成完全相同的 SSH 参数。现有 known_hosts 校验仍然存在；问题是用户指定的指纹并没有被执行。

另外，配置读取失败被当作空列表，写入异常被吞掉。最小复现中，父路径是普通文件导致保存失败，`create()` 仍返回成功；重建服务后记录消失。损坏的 JSON 也会在下一次录入时被覆盖。

依据：[SSH 参数](../platform/dsh-plugins/lumo-ui/src/remote-hosts-api.ts#L77)、[配置读取](../platform/dsh-plugins/lumo-ui/src/remote-hosts-api.ts#L125)、[录入返回成功](../platform/dsh-plugins/lumo-ui/src/remote-hosts-api.ts#L134)、[吞掉保存异常](../platform/dsh-plugins/lumo-ui/src/remote-hosts-api.ts#L309)。

建议校验获取到的公钥与指定指纹，匹配后再写受管 known_hosts；区分首次信任和指纹固定。配置操作使用校验、原子提交和明确错误反馈；损坏文件保留原件并进入恢复流程。浏览器地址簿已有的损坏保护可以作为行为参考。

**验收：**正确指纹首次连接成功，错误指纹及已知 key 冲突均拒绝；写入失败不显示成功；损坏配置不被后续操作覆盖。指纹还需真实 SSH 测试，当前复现只验证参数和代码路径。

## 3. P1：完整聊天记录与引擎进程应有独立生命周期

**性质：明确的产品能力缺口；工作量：大。**

独立对话的索引只保存会话元数据。可见事件保存在最多 2000 项的内存缓冲里，重启后恢复引擎上下文并不恢复完整界面记录。“结束会话”还会删除恢复索引，使其从当前列表入口消失；恢复索引本身最多保留 128 项。

这与用户把“最近对话”当作长期聊天历史的预期有差距。群组已有自己的公开对话持久化，不能把这个缺口泛化成所有聊天都不保存。

依据：[恢复索引](../platform/dsh-plugins/acp-engines/src/session-index.ts#L21)、[关闭会话](../platform/dsh-plugins/acp-engines/src/engine-host.ts#L249)、[事件缓冲](../platform/dsh-plugins/acp-engines/src/engine-host.ts#L385)、[现有恢复边界](../platform/dsh-plugins/acp-engines/README.md)。

建议拆分“聊天记录”“引擎进程”“恢复句柄”：停止或释放进程保留记录，删除聊天作为单独操作。优先评估宿主公开 session/log 服务的契约；不匹配的业务事件使用插件存储和公开 API，避免冒用原生事件类型。记录支持分页和版本迁移后，再补重命名、归档、置顶、全文搜索、导出和分支。

**验收：**刷新、应用重启、结束执行和回收空闲进程后仍能查看完整历史；超过恢复索引容量不会删除聊天正文；只有明确删除记录才移除历史。

## 4. P1：切换会话应保留草稿与当前查看位置

**性质：已确认的状态生命周期问题；工作量：小到中。**

文字、附件和 Skill 选择分别保存在组件状态中。切换独立会话、群组或通讯录会卸载组件；重新连接独立会话也会清空文字。群组 `select()` 没有相同 ID 的短路，点击当前群组也会先清空当前视图。

依据：[条件挂载和 key](../platform/dsh-plugins/lumo-ui/src/client/role-room-surface.tsx#L65)、[选择群组](../platform/dsh-plugins/lumo-ui/src/client/use-role-rooms.ts#L61)、[连接时清空](../platform/dsh-plugins/lumo-ui/src/client/use-acp-session.ts#L39)、[附件清理](../platform/dsh-plugins/lumo-ui/src/client/chat-attachments.tsx#L23)、[上下文清空](../platform/dsh-plugins/lumo-ui/src/client/agent-composer-input.tsx#L8)。

建议用“环境、realm、账号、项目、对话”作为草稿作用域，保留文字、附件、文件引用、Skill、目标角色、滚动位置和右栏状态。同一个条目重复选择不重挂载。跨刷新恢复附件需要二进制草稿存储或受管临时文件，不能只保留失效的 Object URL；账号切换仍需严格隔离。

**验收：**A 写草稿并选择附件/Skill → B → 通讯录 → A，内容仍在；账号切换不出现其他身份的草稿；发送成功只清掉本次发送的快照。

## 5. P1：补齐发送幂等与工作区执行互斥

**性质：一项协议保证缺失，一项已复现竞争窗口；工作量：中。**

独立会话发送没有稳定的消息请求 ID。若服务端已经执行、响应丢失，且原回合结束后用户再次发送保留的草稿，就可能执行第二次。群组已有请求 ID 去重，可复用其语义，但独立会话当前未接入。

另一处问题位于项目互斥：独立会话在加载 Skill 前检查群组是否占用工作区，`await skills.load()` 之后没有重新取得执行权。最小复现让群组在等待期间变为忙碌，独立会话仍返回 202 并派发 prompt。实际存在多个页面或请求并发时，同一目录可能同时执行。

依据：[独立发送请求](../platform/dsh-plugins/lumo-ui/src/client/use-acp-session.ts#L147)、[检查、异步加载与派发](../platform/dsh-plugins/acp-engines/src/routes.ts#L171)、[群组去重](../platform/dsh-plugins/acp-engines/src/role-rooms.ts#L54)、[群组占用检查](../platform/dsh-plugins/acp-engines/src/role-rooms.ts#L67)。

建议引入统一的 `clientMessageId/turnId` 和受理状态查询，区分“未接收”“已接收”“执行中”“结果待核对”。工作区互斥由共享执行入口原子取得，持有到终态；不能依靠 UI 禁用或一次早期检查。以后支持并行时，再以独立工作树或明确的只读任务放开。

**验收：**受理后丢弃响应，重试同 ID 只执行一次；Skill 加载期间并发启动群组，只有一方取得同目录执行权；取消、异常和进程退出均释放执行权。

## 6. P1：原生交互的重点是保留协议能力与执行结果

**性质：已确认的事件适配缺口；工作量：中到大。**

- Codex 桥已经传出 `rawInput/rawOutput/locations/aggregatedOutput`，但 EngineHost 再次转换时只保留工具标题、类型和状态。
- EngineHost 发出了 plan 事件，当前转写 reducer 没有对应展示分支。
- `available_commands_update/current_mode_update` 明确被忽略；现在的 `/` 菜单主要是 Lumo 固定操作与宿主 Skill，不能据此声称原生引擎命令已经完整支持。
- 右栏活动目前主要定位到简略记录；项目文件面板主要完成文件引用，尚无这一流程中的文件内容、变更差异和产物预览。

依据：[桥接输出](../platform/dsh-plugins/acp-engines/src/codex-bridge.ts#L210)、[事件转换](../platform/dsh-plugins/acp-engines/src/engine-host.ts#L334)、[转写 reducer](../platform/dsh-plugins/lumo-ui/src/client/acp-session-state.ts#L19)、[命令菜单来源](../platform/dsh-plugins/lumo-ui/src/client/agent-composer-input.tsx#L73)、[文件面板](../platform/dsh-plugins/lumo-ui/src/client/agent-context-browser.tsx#L42)。

建议先建立按引擎协商的能力描述和结构化事件投影，再接原生工具卡片、计划清单、命令菜单、日志、Diff 和文档预览。仅映射允许展示的必要字段，避免直接倾倒原始协议对象。Skill 的正文加载已实现，后续补来源、版本、加载状态和与引擎能力的适配。

**验收：**用户可查看实际命令、输出、退出状态、变更文件和计划；支持的原生命令能被发现并执行，不支持项有明确状态；附件或文件不可读时不显示为已读取。

## 7. P1：本机访问服务器、本机接入集群、群组远程执行需要串成流程

**性质：产品与执行架构缺口；工作量：大。**

目前环境页保存地址并打开远端工作台，新页面由服务器完成登录。它不切换当前本地 Host，也不会自动把本机注册为集群执行节点。

设备控制面已经有策略、激活码、在线状态、排空和撤销能力；当前设备接入页仍展示 `desktop-agent` 启动参数，用户需要人工准备状态目录、信任文件和激活码文件。跨角色/跨工具 ACP 工作台也只在 `deploymentMode === 'local'` 时创建引擎服务，不能通过打开服务器地址自动获得远程群组执行。

依据：[远端入口](../platform/dsh-plugins/lumo-ui/src/client/environment-panel.tsx#L59)、[本地 ACP 装配](../platform/dsh-plugins/lumo-ui/src/index.ts#L2472)、[设备接入说明](../platform/dsh-plugins/lumo-ui/src/client/cluster-panels.tsx#L308)、[桌面导航边界](../platform/desktop/src/pet.rs#L276)、[现有交付边界](./personal-agents-management-2026-11-26.md#L125)。

建议分阶段完成：

1. 环境身份：地址、连接状态、当前账号/组织、项目归属和执行位置分别可见；统一浏览器与桌宠地址簿的数据服务。
2. 本机激活向导：通过受信本地桥完成服务器选择、激活、策略同步、在线验证、暂停接单和退出，复用现有设备控制面。
3. 执行路由：每个会话或角色明确选择“本机/受管设备/集群”，通过现有调度与设备链路执行，传递项目及文件映射、事件和产物引用；避免新建第二套远程进程控制系统。
4. 需要桌面内切换远端工作台时，使用隔离窗口或独立连接上下文；保持当前本地窗口的原生权限边界。

**验收：**普通用户不用命令行即可激活本机；同一任务能看清在哪台机器执行；暂停和退出后不再接新任务；跨环境切换不混淆账号、草稿、项目路径和历史。

## 8. P1/P2：群组需要长期话题、上下文续接和进程容量管理

**性质：明确的容量及协作能力边界；工作量：中到大。**

当前上限是 16 个房间、每房间 24 轮、每角色公开输出 8000 字符；第 25 轮会拒绝发送。旧轮次的跨角色共享仅使用最近 3 轮、每条旧答复前 2000 字符。这是共享参考资料的边界，各引擎还保留自己的会话上下文，不能描述成所有引擎只记得 3 轮。

引擎默认最多 8 个活进程，空闲成员也计入容量。多个群组保留成员会话时，后续群组可能执行到一半才遇到容量不足。

依据：[群组限制和共享上下文](../platform/dsh-plugins/acp-engines/src/role-room-model.ts#L6)、[发送上限](../platform/dsh-plugins/acp-engines/src/role-rooms.ts#L69)、[房间存储上限](../platform/dsh-plugins/acp-engines/src/role-room-store.ts#L83)、[进程容量](../platform/dsh-plugins/acp-engines/src/engine-host.ts#L131)。

建议将团队配置与话题分开，提供“继续新话题”、可见摘要、证据和产物引用；显示上下文截断，保留可检索历史。发送前预检所需进程容量，空闲回收依赖第 3 项的记录/进程分离。基础闭环稳定后，再开发话题分支、并行委派、工作树隔离和跨设备同步。

**验收：**长期项目超过 24 轮仍能续接，旧记录可检索；摘要继承范围可见；多群组切换不会因为闲置进程耗尽而突然中断。

## 9. P2：附件增加容量反馈和回收机制

**性质：明确的生命周期缺口；工作量：中。**

附件按身份作用域持久化并有 256 MiB 上限，但当前 AttachmentStore 只有上传、读取、解析，没有引用计数、删除或垃圾回收。上传成功但消息失败、放弃草稿、删除群组，均没有对应回收链。长期使用达到上限后，界面没有释放容量的操作。

依据：[容量与写入](../platform/dsh-plugins/acp-engines/src/attachment-store.ts#L19)、[持久目录装配](../platform/dsh-plugins/acp-engines/src/embed.ts#L32)、[上传与发送](../platform/dsh-plugins/lumo-ui/src/client/chat-attachments.tsx#L39)。

建议区分临时上传与已被消息引用的附件，提供容量信息、未引用文件宽限期回收、删除记录后的引用释放，以及按引擎能力的格式提示。PDF、Office 等预览优先复用现有公开查看器能力。

**验收：**放弃或失败上传不会永久占满配额；保留的聊天附件不会误删；空间不足时可以查看占用并清理。

## 10. P2：扩大聊天规模前优化读取和渲染

**性质：静态确认的性能风险，尚未测出用户侧延迟；工作量：中。**

群组活动时约每 1.5 秒拉取房间列表、完整当前房间和待决权限；存储 `list()` 会先深克隆所有群组正文，再投影成摘要。独立和群组页面还用 `JSON.stringify` 全量消息判断滚动，并遍历整个列表。部分会话列表刷新存在重复订阅。

依据：[群组轮询](../platform/dsh-plugins/lumo-ui/src/client/use-role-rooms.ts#L22)、[全量克隆](../platform/dsh-plugins/acp-engines/src/role-room-store.ts#L77)、[群组滚动依赖](../platform/dsh-plugins/lumo-ui/src/client/role-room-conversation.tsx#L33)、[独立会话滚动依赖](../platform/dsh-plugins/lumo-ui/src/client/acp-session-panel.tsx#L113)。

建议摘要独立索引、历史分页、共享列表缓存、群组增量事件订阅和游标恢复。以消息版本号替代全量序列化，先拆分可缓存的消息组件，再依据测量决定是否窗口化。

**验收：**固定长对话、多群组、流式输出和慢网络场景，记录输入响应、首屏、增量延迟、请求量及内存；设定预算并证明改进后再放宽容量。当前不能仅凭这些代码断言页面已经卡顿。

## 11. P2：原生扩展需要明确覆盖层的退出计划

**性质：维护债务与规则口径冲突；工作量：持续治理。**

上游工作区保持干净，但隔离构建副本仍通过锚点替换修改多个包，包括 UI、gateway 和 session-controller。因此“上游目录没有改动”不能证明“完全没有兼容补丁成本”。覆盖层 README 仍存在“两个扩展位”“零补丁 rebase”等与实际范围不一致的表述，根 CLAUDE.md 的设计约束也更严格。

依据：[覆盖层写入](../platform/dsh-overrides/apply.mjs#L44)、[覆盖包清单](../platform/dsh-overrides/apply.mjs#L74)、[文档表述](../platform/dsh-overrides/README.md#L14)、[零补丁声明](../platform/dsh-overrides/README.md#L111)、[根约束](../CLAUDE.md)。

此外，客户端 `index.tsx` 约 277 KB、`lumo.css` 约 287 KB，服务端入口约 169 KB。通过体积守卫不代表后续改动成本低，但不应只按行数机械拆分。

建议建立覆盖层清单：用途、对应上游版本、公开扩展点替代路径和删除条件；优先迁移已能使用 slots/services 的部分。保持 pin、兼容闸门和 pristine 检查。业务文件按聊天、环境、项目、能力、身份边界逐步拆分，同时减少全局 CSS 覆盖；不通过修改 `deepseek-harness/` 解决这些问题。

**验收：**覆盖清单与实际包一致，上游升级经过契约和关键用户流程验证，已被原生能力取代的覆盖可删除；文档不再把源树洁净等同于零适配成本。

## 12. P1：以真实用户链路建立发布验收

**性质：验证缺口；工作量：取决于真实环境。**

新 Agent 和环境界面的浏览器验证主要使用模拟 API。交付文档明确未完成真实 Claude Code/Codex 登录后的模型调用、项目写入，以及真实服务器与 SSH 隧道验收。已有协议和 UI 测试有价值，但不会覆盖真实工具版本、认证、端口、文件权限、沙箱及网络断开之间的组合。

这不等于整个项目没有真实集群测试：实现状态中已有 PostgreSQL、多进程及真实 Compose 调度验证记录；需要补的是新入口到实际执行结果的完整路径。

依据：[Agent 验证范围](./personal-agents-management-2026-11-26.md#L102)、[环境验证范围](./personal-agents-management-2026-11-26.md#L128)、[已有集群验证](./implementation-status.md#L170)。

建议先固定两条验收路径：

- 本机对话：真实工具登录 → 选项目 → 加附件/Skill → 查看权限与工具结果 → 停止 → 重启 → 恢复记录及继续对话。
- 服务器接入：真实服务器登录 → 本机激活 → 任务实际派发 → 结果和文件可追踪 → 断网/异常重启 → 恢复 → 暂停接单及退出。

测试记录版本、部署拓扑、执行位置和回合 ID。模拟回归用于快速覆盖边界，真实链路用于确认交付可用。

## 菜单和页面继续优化的方向

沿用用户已经确定的布局：左侧按项目与最近对话组织，最近项只显示标题和时间；输入框保持紧凑，附件使用加号，明确的图标配 tooltip 和无障碍名称。

| 位置 | 建议承载的操作 | 需要补的能力 |
|---|---|---|
| 左侧顶部 | 新对话，菜单选择独立会话或群组 | 群组不应成为唯一突出的新建入口；原生对话与 Agent 对话逐步统一导航 |
| 左侧项目/最近 | 历史、搜索、归档与重命名 | 持久记录、正文搜索、草稿恢复 |
| 左侧底部 | 当前环境与连接状态 | 显示明确环境名；展开查看账号和连接；与真实执行位置对应 |
| 输入区 | 消息、加号、模型、项目、`/`、`@`、停止 | 动态引擎命令、明确的发送状态；真实能力支持后再展示执行位置切换 |
| 右侧工具栏 | 文件、变更、产物、执行、成员 | 结构化输出、Diff、计划和文件预览，保留按需展开 |
| 环境与连接 | 服务器地址、本机接入、SSH、连接诊断 | 激活向导、暂停/退出、可靠的连接状态 |
| 设置/管理工作台 | 工具与模型、技能与连接器、项目自动化、集群治理、账户权限 | 根据部署形态与权限显示，复用既有后台能力 |

“单机/服务器/集群”是部署或执行环境的事实，不能做一个仅修改页面标签的模式开关。先完成连接、身份和执行路由，再提供对应快捷操作。

## 建议实施顺序

| 阶段 | 范围 | 完成标准 |
|---|---|---|
| 第一批：日常可靠性 | SSH 状态/指纹/保存、草稿、发送幂等、工作区互斥 | 异常连接不误报成功；切换不丢草稿；同一消息不重复执行；同目录执行不冲突 |
| 第二批：完整对话体验 | 持久记录、进程释放、原生事件和命令、右栏结果、附件回收 | 重启仍有完整记录，执行过程和产物可核对，长期使用不被容量卡住 |
| 第三批：远程协作 | 本机激活向导、环境身份、执行路由、群组续话题与容量预检 | 用户可从本机完成服务器接入，并确认任务实际执行位置和恢复状态 |
| 持续工作 | 真实链路验收、性能预算、覆盖层削减、入口拆分 | 每个阶段都有对应证据，避免只用页面展示判定能力完成 |

动态并行群组、自动工作树、跨设备群聊同步和群内应用可以放在上述基础完成后。当前先投入这些增强，会扩大现有状态、记录和执行问题的影响范围。

## 本轮验证记录

执行了 5 个现有测试文件，共 **70 项通过**：`remote-hosts-api`、`session-lifecycle`、`event-recovery`、`role-rooms`、`chat-composer-context`。这证明已有行为通过现有断言，不能据此推导新增审查场景也已覆盖。

在临时目录及内存替身中运行了以下探针，未启动真实 SSH 或模型进程：

| 探针 | 当前结果 |
|---|---|
| 没有任何 readiness 信号就批准建立隧道 | `state=connected`、`tunnel=up`、运行记录 `succeeded` |
| 用持久化 up 快照重建服务，进程表为空 | 仍显示 connected/up，`closeTunnel=false` |
| 隧道进程返回 255 | 隧道 down，主机仍 connected |
| 两个不同的非空指纹 | 生成相同 SSH 参数 |
| ENOTDIR 导致配置保存失败 | 录入返回成功，内存 1 条，重载 0 条 |
| 配置文件是损坏 JSON 后继续录入 | 原损坏文件被覆盖 |
| 独立请求等待 Skill 时群组变为 busy | 只检查一次工作区，仍派发 prompt，HTTP 202 |

未做真实 SSH 指纹握手、断网设备联调、付费模型调用或性能基准。外部协议文档在线读取未返回可用内容，原生交互结论依据仓库已经接收和丢弃的事件，不将其当作外部工具最新完整能力清单。

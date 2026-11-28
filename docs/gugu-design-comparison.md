# Gugu 与 Lumo：项目协作和云端接入

对照版本：Gugu [`474319f`](https://github.com/GUYI-AI/gugu/tree/474319f38d9bc0cb80e90c08833d38c3f81f479b)。下面的“已有”指 Lumo 源码中能定位到的能力，不代表某个安装包已经发布，也不代表已连接真实云主机。

2026-11-26 补充：早期对照偏重项目、设备与记忆。此次进一步实现了开发工具目录、真实模型读取与切换、可复用 Agent 通讯录、选成员建群、点名角色和成员执行详情，见[个人 Agent 与管理工作台整合](personal-agents-management-2026-11-26.md)。当前群组仍为顺序编排，不能据此宣称具有 Gugu 的动态并行委派、话题分支或跨设备群聊同步。

| 用户问题 | Gugu 的具体做法 | Lumo 已有基础与值得借鉴的部分 |
| --- | --- | --- |
| 谁可以加入或管理项目？ | [群成员权限](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/src/lib/groupMemberPermissions.ts)区分群主、管理员、普通成员和项目群；项目群不能通过普通群入口直接邀请人类。 | Lumo 已有[项目角色判定](../platform/control-plane/projects/internal/domain/domain.go)、[末位所有者保护](../platform/control-plane/projects/internal/store/store.go)和[空间细分授权](../platform/dsh-plugins/lumo-ui/src/client/project-space-grants-panel.tsx)。借鉴的是让界面解释谁能做什么；项目成员和群聊成员仍是两种关系。 |
| 断网后能否找到其他机器上的项目？ | [账号项目目录](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/src/session/renderer/features/remote-hosts/account-projects.ts)保留机器与项目的对应；连上后优先使用机器返回的数据。离线分支和运行中会话不可推断。 | Lumo 已有[按身份列项目的目录](../platform/control-plane/projects/internal/server/directory.go)。将来若缓存目录，应保存来源、读取时间和账号范围；离线时显示“上次看到”，不能把读不到的项目判为删除或把缓存成员当成授权。 |
| 现在操作的是哪台机器？ | [设备范围](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/src/session/renderer/features/remote-hosts/device-scope-store.ts)让同一模块的资源共用机器选择，重开默认本机；[连接状态](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/src/session/renderer/features/remote-hosts/connection-status.ts)区分连接中、登录失效、重连、休眠等原因。 | Lumo 的[设备接口](../platform/control-plane/governance/internal/server/devices.go)和[节点面板](../platform/dsh-plugins/lumo-ui/src/client/cluster-panels.tsx)区分已登记、策略、激活、连接与调度。应据这些事实给出下一步；没有电源状态的设备不应标成“休眠”。 |
| 自建工作台和供应商托管有什么不同？ | [自建说明](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/docs/guides/self-hosting.zh-CN.md)分开配置自有后端、文件服务与可选官方服务；[云唤醒](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/src/session/renderer/features/remote-hosts/ensure-cloud-host-ready.ts)只在明确需要远端就绪时触发，浏览项目不会启动机器。 | Lumo 已有[自建集群](../platform/deploy/compose.cluster.yml)和[设备代理](../platform/control-plane/registry/cmd/desktop-agent/main.go)。三个动作应分开：打开工作台由目标站点登录，登记执行节点由管理员批准，创建或唤醒云实例则需要供应商接口。已有前两种基础不能推导出第三种能力。 |
| 重连时会不会把刚才的操作执行两次？ | [任务交接记录](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/src/session/shared/core/sessions/task-collaboration.ts)将已接受的会话间投递投影为只读历史，读取记录不会再次发送。 | Lumo 的[任务收件箱与回执恢复](../platform/control-plane/registry/cmd/desktop-agent/main.go)已有持久化路径；任务详情应分别展示“请求已提交”“设备已收到”和“已返回结果”，刷新只重读事实。 |
| 换工具后怎样接着做？ | [记忆分类](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/packages/core/src/shared/assistantMemory.ts)区分偏好、反馈、项目和参考资料；[会话命名](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/electron/session/main/core/sessions/renameSession.ts)允许用户保留自己选的名字。 | 当前工作树的[桌面项目记忆](../platform/desktop/src/dev_memory.rs)按工作区保存长期记忆和显式导入的记录，[会话入口](../platform/desktop-assets/dev-tools.mjs)仍使用工具与 UUID 定位。若以后共享记忆，应先定义哪条属于个人、哪条由项目成员可读。 |

**这次落实的场景**

- 项目所有者可按用户 ID 或从有权限读取的工作域目录添加成员，按角色筛选名册；改角色和移除成员会校验界面读到的原角色。另一位所有者已改变角色时，服务端拒绝旧请求。前后端都会保护最后一位所有者。
- 在集群工作台登记 Linux 服务器后，直接打开返回的设备 ID 对应的详情。详情区分等待签名策略、等待激活、已连接但策略未应用与可调度；过期的一次性激活码会从界面移除。[接入步骤](../platform/deploy/README.md#桌面设备-tls-接入)
- 桌宠可保存多个自建工作台的 HTTPS 地址，以系统浏览器打开。账户登录由目标站点处理，本地服务离线也能使用该入口。[桌宠说明](../platform/desktop/README.md)

- 项目目录现在可回显本标签页最近读取的页面，按站点、工作域和账号隔离。网络故障时标注“上次读取”，禁用打开；联网后重新读取，401/403 清空快照。缓存有页数、大小和读取时效限制，可手动清除。它只覆盖访问过的筛选页，不推断其他机器的项目文件或分支。
- 桌宠新增「选择内容并交接」：选择已保存目标、长期记忆和具体会话的最近导入记录，预览后复制 Markdown。复制前核对内容摘要和记忆版本，变化后要求重新预览；未选择的历史、个人补记及其他会话不会混入。
- 参考 Gugu 的[会话置顶](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/electron/session/main/core/sessions/setSessionPinned.ts)和[归档／恢复](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/electron/session/main/core/sessions/archiveSession.ts)，Lumo 在工作区内按编码助手和 UUID 整理关联会话。置顶优先显示，归档从默认列表移出，保留备注和导入记录；恢复不启动终端。并发修改会检查版本。Gemini CLI 与 Claude Code、Codex 共用这套记忆和交接入口，支持平台见[桌面说明](../platform/desktop/README.md)。

跨设备记忆自动同步、远端项目文件访问和云实例启停仍未实现。

**本轮验证**

项目服务在独立 PostgreSQL 实例上通过全套 Go 测试，包括同一成员并发变更的冲突检查。
相关桌宠、成员、服务器接入和既有界面的 82 项 Vitest 测试通过；桌面壳 24 项 Rust 测试通过。
新增用例验证：旧快照不会覆盖刚保存的工作台名称，权限、策略或证书变更后的迟到签发结果不会恢复激活码。
360×500 的 Chrome 检查使用模拟 Tauri 接口验证了云工作台的增改删与打开入口，没有连接真实云服务器。

后续离线目录与选择式记忆交接的定向回归、账号隔离和预览失效测试也已加入，相关 10 个文件的
108 项 Vitest 测试全部通过。新增交接流程在 360×500 Chrome 中通过模拟 Tauri 接口验证，
Rust 回归增至 26 项。全量检查的依赖限制见下文。

全量前端回归及类型检查目前受本地上游依赖不匹配影响：
`@deepseek-ai/dsh-host-authentication-token` 缺失，现有 WebServer 声明也缺少
`WebEntryUrl` / `webserver/entry-url`。这些检查尚未全绿，不能据本轮定向测试判断安装包可发布。

# 原生工作台融合与样式修复验收

本次交付对应 [融合计划](./plans/2026-11-28-native-integration.md)。此前真实 Claude Code、官方 Codex CLI、附件、Skill、审批、停止和恢复的证据仍见 [工作台验收](./workbench-acceptance-2026-11-28.md)。本文只记录本次新增实现和验证，区分代码回归、组件预览与完整原生壳运行。

## 已实现

- 通过公开 `sidebar.workspaces`、`sidebar.panellist`、`main` 插槽统一 DSH、ACP、群组的项目与最近记录。原生会话继续使用宿主服务和原生对话内容；外部引擎与群组进入原生主面板，不再额外套一层左侧记录。记录键包含来源，项目按路径合并，最近记录显示标题和时间。
- 统一搜索、重命名、置顶、归档和恢复。搜索保留来源身份，切换连接后不继续使用旧宿主或旧身份的结果；元数据写入仍由所属服务处理。
- ACP 与群组共用输入组件，保留附件、`/`、`@`、Skill、发送与停止，以及来源引擎的审批选项。DSH 对话继续使用其原生输入组件。
- 原生知识检索与连接器消费者公开可复用的执行服务，通过已有 MCP 通道向本机会话提供 `knowledge_query`、`connector_list`、`connector_invoke`。保留 realm、用户、项目、会话范围、发布态检索与来源审批；没有创建伪 DSH Agent。MCP 断开或会话撤销时取消进行中的调用。
- 审批列表只投影到所属会话，连接器审批失败不隐藏原生审批；授权作用域包含项目，审批 ID 使用 UUID，防止重启后复用旧 ID。
- 群组创建读取完整引擎目录，默认角色从可用入口分配，不再硬编码 Claude Code／Codex。刷新只补齐空选择，保留用户已选引擎和已存 Agent 的模型；未就绪工具显示具体原因。
- 历史记录组件直接加载自身 CSS。修复增加管理菜单包裹层后旧选择器失效导致的大边框、Logo 与标题重叠、时间挤在同一行。长标题省略，归档入口缩小，空项目的开始按钮使用宿主按钮。
- 删除已被公开插槽替代的侧栏导航与项目分组源码覆盖。包括首页 hero 输入槽在内，当前兼容清单缩减为 6 个包范围及根配置，在固定上游提交上实际修改隔离副本的 8 个文件。原生输入桥接改用已有 `conversation.input.dock`。本次没有新增源码覆盖。

- 新增会话与群组的共享工具侧栏及 `/tools` 命令。只展示当前身份已绑定的真实工具和权限规则，不将入口存在表述为执行成功；没有装配的知识库或连接器不会出现在清单里。
- 修复 MCP 中继没有随 Host 插件打包的问题；产物中输出 `mcp-relay.mjs`。群组并发启动复用同一监听器、使用独立会话凭据；关闭中的桥不再签发凭据。
- 完整预览统一构建 Host、Client 和 Web 静态资源，使用 Web 包自身的 Vite。预览与插件管理直接执行 Node CLI，避免包管理器重写共享依赖链接。生成的 `lib` 和 Web `dist` 投影有上游洁净度、跟踪文件和目录重叠检查。
- 修复完整原生壳中连接入口的文字换行及状态点拉伸；原生历史使用公开 `FishLogo`，侧栏入口使用原生图标。

## 验证结果

| 验证范围 | 结果与含义 |
| --- | --- |
| Lumo UI、ACP、双通道工具、连接器、知识库、覆盖层、节点启动和预览构建组合回归 | 184 个文件通过、7 个文件跳过；1,476 项通过、35 项跳过。未配置 PostgreSQL 等外部条件的用例不计为通过 |
| 原生装配、目录、历史、群组面板、群组引擎和宿主装配定向回归 | 6 个文件、29 项通过 |
| 生成产物与进程验证 | 实际启动构建配置输出的 MCP 中继，验证初始化、工具发现、身份传递、调用和撤销后的 401；真实临时 Git 仓库验证生成库与前端投影、跟踪文件保护、脏树及软链重叠拒绝 |
| 平台与 Lumo 客户端类型检查 | 两项均通过 |
| Lumo server/client 打包 | 通过 |
| 生产客户端产物激活 | 4 个主题、11 个插槽；最终产物 SHA-256 为 `a582d8045d7404c4f53c9885c530ba4d452c378cd1c11cfc7aacc58653c9f1e9` |
| 原生插槽装配 | 使用公开 renderer 浏览器产物中的真实 `SlotRegistry` 和 Cordis，覆盖普通提供服务与 Service 访问器、声明前等待、导航与卸载 |
| 仓库守卫、差异空白检查、覆盖兼容审计 | 通过；守卫仍有已有体积与颜色警告 |
| 上游洁净度 | `status --porcelain -uno` 无输出；版本为 `dsh-v0.2.3-alpha.2`，无 `-dirty` |

主要复现命令（类型检查与测试在 `platform/` 执行）：

```sh
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p dsh-plugins/lumo-ui/tsconfig.check.json --noEmit
node node_modules/vitest/vitest.mjs run dsh-plugins/lumo-ui dsh-plugins/acp-engines dsh-plugins/dual-plugins dsh-plugins/connector dsh-plugins/knowledge dsh-plugins/knowledge-vault dsh-overrides data-plane/dsh-node desktop/__tests__/build-preview.spec.ts desktop/__tests__/node-tools.spec.ts desktop/__tests__/dsh-client-bundle.spec.ts
node tools/guards/run.mjs
```

## 浏览器观察与真实运行边界

本机 `4199` 验收入口使用真实生产组件和本机引擎路由。浅色、深色均核对了侧栏布局：Logo 与标题有独立间距，标题与时间分行，行高约 45 像素，没有旧的按钮外框；浏览器控制台没有错误。

该入口此前为了 Claude／Codex 联测只提供两个引擎。本次恢复完整 11 项目录，当前机器检测到 Claude Code、Codex、Gemini、WorkBuddy、Kiro 的启动入口；创建并保存了 WorkBuddy／Kiro／Gemini 群组。**入口检测与群组配置通过不代表这些引擎均已登录或完成模型调用**，本次未向后三者发送任务。

完整原生壳已在隔离的本机 `4200` 验收环境启动，使用真实 Cordis 插件装配和本机 Claude Code，测试数据与生产 profile 分离。此前缺失静态资源、Vite 版本不匹配及包管理器重链接问题均已修复。

已观察到的真实链路：

1. 统一目录在 DSH 原生对话与 Claude 会话间切换；没有嵌套第二套侧栏。
2. Claude 在真实项目上下文中调用 `acp_engines_list`，对话显示一次性审批，批准后工具完成，返回完整 11 项引擎目录。共享工具面板列出本环境实际提供的 `acp_engines_list` 与 `knowledge_query`。
3. 会话设置中的重命名同步到项目、最近记录和会话标题；归档后移入归档目录，从记录菜单恢复后重新出现，搜索可定位记录。
4. `/` 展示平台命令及引擎真实命令，`@` 展示项目实际文件；设置中的模型和运行模式来自已连接 Claude。没有选择绕过审批模式。
5. 完整重建并重启服务后，DSH 原生记录、Claude 消息和自定义标题保留；会话处于可恢复状态，通过“恢复运行”重新连接 Claude，再次实际调用 `knowledge_query`，成功返回 `hits: []`（隔离知识库无匹配文档），没有伪造检索命中。
6. 创建紫色 Bot Logo 的 Claude/Codex 群组，设置和历史保留外观；群组中两个成员分别显示已下发的共享工具。Codex 请求被模型服务 403 拒绝后，同一群组切换 Claude，收到真实 `CLAUDE_GROUP_OK` 回复。
7. 同项目的独立会话等待审批时，群组新执行被工作区锁拒绝；独立调用结束后，同一草稿可重试。初始化中的群组内部会话不再短暂出现在独立历史里，群组错误也不带入独立对话。最后一次定向回归为 3 个文件、22 项通过，客户端类型检查再次通过。
8. 深色完整页面核对了设置面板、紧凑输入框、图标附件入口、Logo、标题截断和连接状态点；稳定启动后没有新增控制台错误或警告。

停止并重建开发服务器期间，旧页面曾记录原生服务卸载导致的 `sessions service unavailable`、`root` 槽暂时不存在及请求取消；服务完成后刷新可恢复，稳定刷新与会话切换未出现新错误。开发期在线热替换的这一瞬态尚不等同于无缝热升级验收。

完整壳没有配置 DeepSeek 模型凭据，因此原生 DSH 的真实模型发送不计入本轮通过项。可选社区插件下载也未在该隔离 profile 中开启；工具清单只反映已装配的实际服务。连接器共享的来源权限、审批回执与取消通过回归验证，本轮没有连接真实外部连接器。
本轮在完整宿主再次验证了应用内 Codex 请求，模型服务仍返回 HTTP 403：`This account only allows Codex official clients`。因此 Claude／Codex 完整自动接力仍未通过，保留此边界，不以官方 CLI 能成功代替 app-server 验收。没有指定分布式服务器或 SSH 主机，真实远端连接与断网恢复也仍未联调。本次没有将这些未通过项目计入功能回归通过项。

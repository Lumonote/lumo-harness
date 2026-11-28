# 2026-11-25 审计问题修复与验收记录

本记录对应主仓库基线 `ed1ab5e7101e176fcf542137b5128d82fe7cc311`，上游 DSH 固定为 `4b399c39a6d1479cd84ca591b4d7c88e24d38a96`（`dsh-v0.2.3-alpha.2`）。日期使用 Asia/Shanghai。修复不修改上游源码，不扩展受治理会话的工具白名单，不把本地测试结果表述为生产验收。

## 实施顺序与完成条件

1. 控制面：统一旧 Flow API 的当前权限和事务内状态迁移；设备完成回执同时结束 Scheduler attempt；新版本发布与 lineage 同事务；手动运行持久去重、节点回执、结果查询；新增已认证同步身份查询。
2. 执行可靠性：Codex 提前停止与回合隔离、MCP 配置转发；dual 工具授权/审批/执行阶段的取消；Knowledge 有界初始化、数据库超时和卸载清理。
3. 会话界面：可信调用身份绑定、活动会话管理与可恢复索引、SSE 游标和重连、RunTree 快照恢复、手动 Flow 结果入口。
4. 桌面同步：显式共享项目 ID、已认证账号维度的状态隔离、配置变更围栏、容量不足时的持久待接收队列、卡片与游标写入顺序。
5. 工程门禁：覆盖资源参与 runtime 缓存指纹；Rust 单测入口及 macOS/Windows CI；发布工具固定版本与 SHA256；更新现状文档。

每批均需针对性回归、规格审查、独立质量审查。全部修改完成后运行服务端与客户端类型检查、全平台测试、真实 PostgreSQL 测试、Rust 测试、工程守卫及上游 pristine 检查，再应用回用户工作区。

## 问题与验收对照

| 编号 | 问题 | 完成判据 |
|---|---|---|
| F01 | 旧 Flow API 只看作者身份 | 移出成员、降级、归档均被当前权限拒绝，事务内复查；保留既有全局 manager 初审契约 |
| F02 | Agent 工具缺少可信身份 | 从受控宿主绑定读取当前身份，不能从参数或同名 Agent 取得身份；撤权失败关闭 |
| F03 | Codex 提前停止丢失 | 启动响应前记忆取消，响应后中断准确回合，旧完成通知不终止新回合 |
| F04 | 跨设备使用不同本地工作区 ID | 显式配对同一远端项目 ID，本地 UUID 可以不同 |
| F05 | 换服务器/账号复用同步基线 | 使用服务端验证的 realm/user/project/server 作用域，旧响应不能写入新作用域 |
| F06 | 卡片满容量丢远端内容 | 持久保留待接收内容，释放容量后即使无新增远端变化也能恢复 |
| F07 | 设备完成未释放 Scheduler 容量 | 正确 attempt 终态同事务完成；旧 attempt 无法释放新任务容量 |
| F08 | Flow 并发覆盖状态 | 行锁内加载并校验状态，过时请求不能覆盖 deprecated |
| F09 | ACP 会话无恢复入口 | 列表、附着、停止、关闭、防重复创建；重启仅恢复支持 load 的索引，不重放 prompt/审批 |
| F10 | SSE 重放/永久断连 | Last-Event-ID 优先、严格游标、客户端单调去重、缺口重同步、RunTree 自动重连 |
| F11 | Codex 丢 MCP 参数 | new/load 均转发经过校验的线程配置；真实工具调用另行验收 |
| F12 | 工具取消只是信号 | 取消前不执行，取消审批可结束等待；运行后取消/超时返回 result_unknown，迟到结果不能改终态 |
| F13 | Knowledge 初始化失败不恢复 | 初始化成功后才注册能力，有限重试/总时限，真实 Cordis 卸载不会等待死锁 |
| F14 | 手动 Flow 无持久运行记录 | 幂等 key、输入冲突检测、断连后可查询、逐节点已确认结果、未知副作用禁止自动重放 |
| F15 | 新版本发布缺 lineage | 发布/审核/lineage 原子提交，lineage 故障回滚发布 |
| F16 | runtime 指纹漏组件 | 任一实际覆盖资产内容变化都使缓存失效 |

## 环境与证据边界

- 控制面测试使用本次创建的临时 PostgreSQL，独立于业务数据库。
- Codex 协议回归使用内存 JSON-RPC；该证据不代替已安装真实引擎的 MCP、审批和停止验收。
- 桌面 Rust 回归使用显式测试配置，不需要完整发布资源；macOS 本地测试不代替 Windows CI 或签名安装包验收。
- 记忆同步的本地状态与并发回归不代替两台真实设备的配对、令牌刷新、离线恢复验收。
- 对可能已产生副作用的超时执行，记录“结果未知”，不承诺恰好一次，也不自动重放任意中断的 DAG。

## 已落实的行为约束

- **授权与调度终态**：旧 Flow 入口也在事务内复查当前项目权限和状态；设备回执必须匹配 task/run/attempt/node/worker，治理终态与 Scheduler 容量释放原子提交。Agent 工具从宿主绑定取得身份，未绑定或失效的身份继续拒绝调用。
- **手动 Flow**：调用方可以用 `Idempotency-Key` 重试同一请求，输入变化返回冲突。浏览器断连不取消已开始的运行；流程页面可查询运行记录及发起人自己的节点结果。进程中断或超时不自动重放有未知副作用的节点。后续版本发布与 lineage 同事务提交；本批未自动回填历史缺失的 lineage。
- **事件恢复**：ACP 服务端优先采用 `Last-Event-ID`，对缺失或超前的游标发送重置说明；RunTree 保持浏览器自动重连，重新拉取快照、去重增量并在失败时退避。旧请求返回不能覆盖新选择。
- **ACP 会话**：列表、附着、恢复、停止、关闭及权限请求按 realm/用户/项目核验。索引仅记录恢复所需元数据；运行时退出保留，用户结束会话删除。仅支持 `loadSession` 的引擎可显式恢复，界面提示历史转写不完整；MCP 配置失败会终止创建/恢复并清理凭据。详情及外部身份变更检测边界见 [ACP 说明](../../platform/dsh-plugins/acp-engines/README.md)。
- **桌面同步**：两台设备使用同一远端账户和同步项目标识配对，状态按服务器、realm、用户和项目隔离。超过 64 条本机容量的内容持久排队。首次、每 24 小时及手动完整对齐可检测同地址服务器恢复旧备份；必须在应用运行、联网且完整扫描成功后才能保证恢复。用户的冲突选择持久保存至成功回执，云端相同内容的重放不会撤回选择。
- **取消与初始化**：Codex 记录启动完成前的取消请求并在回合 ID 可用后中断准确回合；dual 工具在执行前取消时不调用 handler，执行中超时或取消返回 `result_unknown`。Knowledge 仅在初始化成功后注册能力，启动失败采用有限重试，卸载会终止等待和初始化连接。
- **构建与维护**：覆盖资产复制和 runtime 指纹使用同一清单；SkillHub 输入固定版本及 SHA256，Tauri CLI 固定精确版本。新增不依赖完整打包资源的 Rust 测试入口，并接入 macOS/Windows CI。大文件提取职责模块，体积守卫仍只能收紧。

## 后续优化的投入依据

| 项目 | 当前动作 | 继续开发前需补的证据 |
|---|---|---|
| O01 Rust PR 门禁 | 新增普通 CI 和正式测试入口 | Windows CI 实际运行、签名包验收 |
| O02 发布输入 | SkillHub 固定版本和摘要，Tauri CLI 固定精确版本 | 三平台实际构建；摘要校验不等于发布者签名验证 |
| O03 Flow 并发 | 本批先保证运行记录与状态一致性 | 队列年龄/积压、节点 p95、活跃任务、租户分布及 lease/幂等压测 |
| O04 大文件拆分 | 提取 Flow 生命周期/手动运行/节点回执、桌面同步存储/执行/对齐、RunTree 流恢复及 Flow 结果页面 | 继续按领域拆路由/页面；体积 guard 不得放宽掩盖新增体积 |
| O05 安装包组成 | 不沿用旧 1.1.1 包体作为当前测量 | 当前提交三平台文件数、压缩/展开体积、冷启动/离线验收 |
| O06 生产证据 | 将本次测试限定到基线与修改集 | 真实 IdP/KMS/证书、HA/PITR、RPO/RTO、升级回滚与业务 eval |
| O07 文档现状 | 修正 overlay/pin 描述，保留历史记录 | 按部署形态持续维护版本、测试证据和真实验收日期 |

存储清理、提高 DAG 并发、按需下载组件和广泛页面重构需要业务策略或基线测量；本批不以未经测量的性能承诺替代这些工作。

以下事项也未由本批本地回归证明完成：外部 desktop runner 随产品交付的契约、设备上线自动进入调度候选池的集成责任、goals/notes 是否加入跨设备同步、真实业务语料下的检索及 Agent Teams 质量。它们需要相应集成环境或产品范围决定，不作为本次代码缺陷修复的通过项。

## 最终验证

F01–F16 的本次代码修复已实现。下表记录本地隔离环境的最终回归；这不是生产环境、真实引擎、跨平台安装包或物理双设备的验收证明。

| 验证 | 结果与范围 |
|---|---|
| 全平台 Vitest | 348 个测试文件、3,198 项通过，0 失败、0 跳过；使用真实 pgvector/PostgreSQL、Redis、MinIO 和文档 Python 依赖 |
| TypeScript | 服务端 project references 与 lumo-ui 客户端检查均通过 |
| 桌面 Rust | 87 项通过，包含增量/完整对齐、重启、冲突选择及真实本机 HTTP 传输回归 |
| Go 控制面 | Flow 全模块 10 个测试包，Governance store/device 2 个包，Projects memsync 1 个包，Edge session route 专项 1 个包通过；使用隔离 PostgreSQL，不把包数记为用例数 |
| 部署 Python | 38 项通过；使用保留 Node/Docker 的完整 PATH |
| Node 工具与守卫单测 | 79 项通过，1 项 GNU tar 专属用例因 macOS 环境跳过；其中 2 项本机监听测试在解除沙箱网络限制后重跑通过 |
| 工程检查 | 6 项守卫通过，保留 5 个既有颜色警告；客户端/服务端入口体积上限分别收紧至 281,334 / 169,167 字节；`git diff --check` 通过 |
| 上游 | `git -C deepseek-harness status --porcelain -uno` 无输出，`describe --tags --dirty` 为 `dsh-v0.2.3-alpha.2` |

审查中发现并补测了同步冲突选择被重放撤回、RunTree 快照失败退避被增量绕过、关闭待连接 ACP 会话后迟到附着，以及异常引擎列表响应导致页面异常的问题。全平台曾发现新增 Scheduler 写入缺少归属登记，已按精确语句登记事务契约；检查规则未放宽。

代码之外仍需完成：真实引擎 MCP/审批/停止与恢复、两台设备同步、Windows CI、三平台签名构建与安装包统计，以及同一发布版本的 HA/PITR/RPO/RTO 和业务质量评估。上述未验证项及 O03–O06 的后续测量工作不计入“已完成”。

复验入口（依赖需使用独立测试实例）：

- `platform/`：`node node_modules/typescript/bin/tsc -b --noEmit`；`node node_modules/typescript/bin/tsc -p dsh-plugins/lumo-ui/tsconfig.check.json --noEmit`。
- `platform/`：配置 `LUMO_TEST_PG_DSN`（含 pgvector）、`SESSION_LOG_TEST_REDIS`、`OBJECT_STORE_TEST_ENDPOINT`、`OBJECT_STORE_TEST_CREDS`、`LUMO_AUTH_PROXY_TEST=1` 和 `LUMO_PPT_PYTHON` 后，运行 `node node_modules/vitest/vitest.mjs run --maxWorkers=2 --testTimeout=30000 --hookTimeout=30000`。Python 环境需包含 Office/PDF 测试依赖，否则相关用例会跳过。
- 仓库根目录：`node platform/desktop/test.mjs`；`python3 -m unittest discover -s platform/deploy/tests -p 'test_*.py'`。部署回归需要 PATH 中保留 Node 和 Docker。
- 控制面模块：在 `flows/` 执行 `go test ./... -count=1 -timeout=180s`；在 `governance/` 执行 `go test ./internal/store ./internal/device`；在 `projects/` 执行 `go test ./internal/memsync`；在 `edge-gateway/` 执行 `go test ./internal/server -run '^TestSessionRoute' -count=1`。涉及数据的用例需设置隔离 PostgreSQL DSN。
- `platform/`：`node tools/guards/run.mjs`；仓库根目录：`git diff --check` 及本文开头基线对应的上游 pristine 检查。

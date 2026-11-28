# 项目实践与多工具、多 Bot 协作验收

本次实现对应 [开发计划](plans/2026-11-28-project-collaboration.md)，运行于现有 DSH 原生宿主、群组与 EngineHost。界面入口是群组右侧「项目流程」和 `/workflow`，使用方法见 [ACP 说明](../platform/dsh-plugins/acp-engines/README.md)。

## 已实现

- 普通引擎会话、群组和项目流程加载项目根目录 `AGENTS.md`、`CLAUDE.md`、`.lumo/project.md`。流程固定来源、正文和 SHA-256 快照；规则改变时拒绝沿用旧计划。
- 群组与 Agent 通讯录支持能力标签。按声明能力、职责推断、可用性和任务数量分配成员，并展示理由；可手动指定，独立评审者不承担实现。工具来自完整注册表。
- 协调成员使用真实引擎生成任务 DAG；模型只生成受约束的任务描述，不能替用户配置验收程序。支持 1–8 个任务和 1–3 个并行任务。
- 每个任务独立 Git worktree，依赖提交先集成；平台记录真实 diff 与提交。集成后执行用户配置命令，绑定退出码、输出、时间与同一提交，再由独立成员只读评审。
- 明确点击合并才快进原分支。原始分支、HEAD 或未提交状态变化时拒绝合并；冲突留在隔离工作区。中断不重放，可重新验收或只读核对合并回执，未响应停止的成员可显式结束。
- 群聊消息与项目流程按创建时间统一展示；历史按钮定位具体流程。记录保留执行会话、此前验收结果和审批归属。写入前解码验证，容量超限保留最后有效快照。

## 自动化验证

在 `platform/` 执行：

```sh
node node_modules/vitest/vitest.mjs run dsh-plugins/acp-engines dsh-plugins/lumo-ui dsh-plugins/dual-plugins --maxWorkers=4
node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p dsh-plugins/lumo-ui/tsconfig.check.json --noEmit
node tools/guards/run.mjs
node desktop/build-preview.mjs
```

广泛回归 152 个文件通过、1 个既有跳过，1,315 项通过、1 项跳过。最后收紧原生模式选择后，重新运行工作流集成测试，16 项全部通过，包含新增的规划模式不被切换为可写模式回归。平台与客户端类型检查、架构守卫和最终原生预览构建通过；守卫仅有已有颜色基线警告。

真实模型验收脚本的 `--self-test` 也通过，覆盖 13 项一次性审批策略断言，不消耗模型额度。

工作流集成测试使用模型传输替身，但文件、Git worktree、分支合并、冲突、命令执行和磁盘恢复均为真实操作。覆盖实际退出码失败不能被模型“通过”声明替代、依赖提交可见、独立评审拒绝、权限所属群组、重启中断、停止与重复请求、原项目变化阻止合并。子进程测试覆盖取消、超时、输出上限和后台子进程回收；模型解码覆盖伪造成功状态、异常路径、超大证据和原子写入拒绝。

## 完整原生页面

已在本机隔离 profile 的 `127.0.0.1:4200` 完整 DSH 装配中验证右侧图标、`/workflow`、规则与任务表单、原生对话展示。桌面和 430 像素窄屏均实际检查；窄屏文档宽度与视口同为 430，侧栏可滚动，无页面横向溢出。

最终构建后实际重启隔离宿主，三轮真实验收的草稿、失败、错误和命令证据均保留；页面重新加载后可查看和编辑第三轮草稿，未自动重发模型请求。全部 5 个真实引擎会话已释放，无仍在执行的请求。

## 实际模型与验收边界

真实本机 Claude 流程使用单独临时 Git 项目，三个不同 Bot 分别承担两项实现及规划／独立评审；不把同一引擎的多个 Bot 描述为多种引擎已联测。可复现脚本为 `platform/tools/project-collaboration-smoke.mjs`，必须显式设置 `LUMO_PROJECT_SMOKE=1`，按 `prepare`、`plan`、`run`、`merge` 分阶段执行。审批仅允许固定测试路径、内容的一次性文件操作。

三轮实际调用均保留了现场，尚未获得完整真实成功流程：

| 轮次 | 实际结果 | 现场证据 |
| --- | --- | --- |
| 1 | 本机 OMC 启动钩子产生未跟踪 `.omc/` 元数据，规划后的 Git 检查正确拒绝使用该结果。 | `/private/tmp/lumo-project-smoke-yJ6Bi0/evidence.json` |
| 2 | 已真实生成两个任务并分配给不同 Bot。Claude 继承 `auto` 模式，而所用服务不支持该模式所需的审批服务，文件未写入；真实 Node 验收以退出码 1 / ENOENT 失败，未进入评审或合并。 | `/private/tmp/lumo-project-smoke-xPQ8XF/evidence.json` |
| 3 | 修复模式选择后，在真实规划调用遇到 HTTP 402 / Usage limit reached，流程保留为可重试草稿，未进入实现或合并。服务返回的恢复时间为 **2026 年 11 月 30 日 14:13（UTC+8）**。 | `/private/tmp/lumo-project-smoke-0Ww3F3/evidence.json` |

后续测试项目在初始提交中明确声明忽略 `.omc/`，原始项目始终未被合并修改。产品仅在继承 `auto` 且引擎明确提供 `default` 时选择原生手动审批模式；规划／只读等其他模式不变。没有修改用户全局配置或放宽 Git 检查。模式修复通过了原生 RPC 与审批集成回归，但修复后的真实写入、独立评审和合并仍待额度恢复验证。

额度恢复后可继续第三轮现场，不必重建或重放旧任务：

```sh
LUMO_PROJECT_SMOKE=1 node platform/tools/project-collaboration-smoke.mjs plan --state=/private/tmp/lumo-project-smoke-0Ww3F3/state.json --approvals=manual
LUMO_PROJECT_SMOKE=1 node platform/tools/project-collaboration-smoke.mjs run --state=/private/tmp/lumo-project-smoke-0Ww3F3/state.json --approvals=manual
LUMO_PROJECT_SMOKE=1 node platform/tools/project-collaboration-smoke.mjs merge --state=/private/tmp/lumo-project-smoke-0Ww3F3/state.json
```

`run` 阶段需要在原生页面批准对应固定测试文件的权限请求；只有真实命令和独立评审通过后才执行最后的 `merge`。临时目录是本机验收现场，不随 Git 提交分发；其他机器应先执行 `prepare` 建立自身测试项目。

应用内 Codex 在此前完整宿主验收中仍受模型服务 HTTP 403 限制，见 [原生融合验收](native-integration-acceptance-2026-11-28.md)。本次不将其计为真实跨引擎通过。未提供远端服务器，真实分布式执行仍未验收；本功能实现的是本机项目协作，远程任务继续通过既有远程执行入口。Git 工作树不是安全沙箱；原生引擎审批和宿主权限保持有效。

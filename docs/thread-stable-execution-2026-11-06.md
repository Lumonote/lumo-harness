# Thread 固定节点与稳定会话执行（2026-11-06）

本批在 `codex/v1.2.1` 补齐了显式配置的 Thread 文本轮次：协调者在登记的本节点发起执行，首轮通过公开 `ctx.agents.create()` 创建会话，后续轮次通过公开 `ctx.agents.resume()` 恢复同一持久会话。协作服务在执行前持久准入，结束后保存不可变回执；治理服务按当前用户、项目、任务与 Agent 预设重新授权。

这是 §24.2 Thread 档位的一条可运行路径。现有 Worker 一次性委派、mailbox suspend/wake 与这条路径分别保留各自语义；本文不代表全部集群、多智能体或产品设计已完成。设计依据仍以 [架构规范](./architecture.md) 及 [§24 协调者设计](./superpowers/specs/2026-09-20-cluster-multi-agent-coordinator-fleet-design.md) 为准。

## 一、已交付链路

```text
协调者 Agent / agent_threads_run
  → 读取 authoritative Thread 行，核对 coordinator/session/node/workspace
  → governance：当前 owner、角色、项目权限、TaskAccess 与固定预设授权
  → collaborator：admit 事务持久化、同轮去重、跨 Thread Agent 槽位准入
  → 本节点持久 session 的 create / resume
  → 文本模型执行；工具全拒；执行期间轮询授权
  → AgentHandle.dispose() 等待循环退出与持久日志落盘
  → collaborator：finish 保存回执并更新 Thread 状态
  → 返回 runId、summary、当前 Thread
```

核心实现位于：

| 职责 | 源码 |
|---|---|
| 本节点稳定会话执行 | `platform/dsh-plugins/agent-teams/src/thread-runner.ts` |
| 当前授权与准入/完成 HTTP 客户端 | `platform/dsh-plugins/agent-teams/src/thread-control.ts` |
| 显式工具与运行时入口 | `platform/dsh-plugins/agent-teams/src/tools.ts`、`threads.ts`、`index.ts` |
| 回执事务、并发槽位、Thread 状态 | `platform/control-plane/collaborator/internal/store/thread_rounds.go` |
| 服务鉴权后的回执 HTTP API | `platform/control-plane/collaborator/internal/server/thread_rounds.go` |
| 当前治理授权 | `platform/control-plane/governance/internal/server/thread_authorization.go`、`internal/store/thread_authorization.go` |
| 节点环境变量装配 | `platform/data-plane/dsh-node/src/index.ts` |

## 二、配置与部署前提

Thread 执行默认关闭。启用 `threadExecution` 必须同时提供协作服务地址、service token、固定 `actingUserId`、`realm`、`nodeId` 和绝对 `workspaceRoot`。运行时还必须挂载公开 `agents`、`sessionPersistence` 与 `meteringScope`。缺少这些服务时不会装配执行器，可通过 `ctx.agentThreads.capabilities().roundRunner` 检查。

治理侧必须已有当前 active 用户、有效且未过期的角色、当前项目授权、目标任务 contributor 权限，以及 active Agent 预设。预设的 owner、project、revision、provider、model 必须与节点配置逐项相同；全局空 project 预设不适用于本切片。角色来自治理数据库，浏览器头、模型输入和 prompt 不能改变执行身份。治理任务可以派给其他 Worker：Thread 是协调者的子轮，不要求该任务已派给这个 Agent，也不创建治理 TaskRun 或改派任务。

使用一个**专供 Thread 文本执行的 Agent 预设**。该预设需要：

- `connector_ids = []`、`knowledge_space_ids = []`、`system_prompt_ref = ""`。
- `max_budget_cents = 0`；当前未接入该预设的金额上限执法，非零显式拒绝。
- `max_concurrency >= 1`，并配置覆盖节点 `timeoutMs` 的 `timeout_seconds`。
- 不与 governed Worker 共用同一个 Agent。两条执行路径尚未统一容量账本；节点装配会拒绝与本机 governed Worker binding 相同的 Agent ID，跨节点部署也应遵守这条约束。

`meteringScope` 负责逐轮身份与 trace 归因；生产还应正常挂载 `@lumo/metering` 的计量和预算服务。金额上限配置为零仅表示当前预设没有独立 cap，不能据此取消既有用户树、项目树的预算执法。

直接配置插件时，`@lumo/agent-teams` 的 `config` 示例：

```yaml
realm: acme
storageBackend: pg
collaboratorUrl: http://collaborator:8081
controlPlaneToken: ${CONTROL_PLANE_TOKEN}
actingUserId: alice
nodeId: thread-node-1
workspaceRoot: /var/lib/lumo/workspaces
threadExecution:
  governanceUrl: http://governance:8089
  projectId: project-1
  agentId: text-thread-agent
  presetRevision: 3
  provider: lumo-gateway
  model: approved-model
  timeoutMs: 60000
```

上例是插件配置形状；实际 secret 由装配层注入，YAML 占位符不是插件自带的变量替换功能。`actingUserId` 固定为部署身份，不是当前浏览器登录用户的动态映射。

使用 `dsh-node` 装配时：

```sh
export LUMO_REALM=acme
export LUMO_USER_ID=alice
export LUMO_NODE_ID=thread-node-1
export LUMO_COLLABORATOR_URL=http://collaborator:8081
export LUMO_THREAD_WORKSPACE_ROOT=/var/lib/lumo/workspaces
export LUMO_THREAD_EXECUTION='{"governanceUrl":"http://governance:8089","projectId":"project-1","agentId":"text-thread-agent","presetRevision":3,"provider":"lumo-gateway","model":"approved-model","timeoutMs":60000}'
# LUMO_CONTROL_PLANE_TOKEN 由现有部署 Secret 注入。
```

这些是追加到现有节点配置的字段，不能替代完整节点 profile、治理预设、模型路由或持久化配置。`LUMO_THREAD_EXECUTION` 必须是 JSON 对象。未提供时保持执行关闭。

持久化路径需要跨本节点进程重启保留。runner 校验挂载的 `sessionPersistence.identity` 与调用使用的后端一致，检查 session ID、历史 cwd 和登记的 workspace，拒绝缺历史后新建或已有历史被覆盖。工作目录限定为 `workspaceRoot/thread/<threadId>/`，检查各级目录，拒绝符号链接与越界。

数据库升级需先具备 collaborator 管理的 `threads` 基础表，再执行 [015_collaborator_thread_rounds.sql](../platform/deploy/migrations/015_collaborator_thread_rounds.sql)。015 的 `thread_rounds.thread_id` 引用该表，因此不能在空库上把 015 当作完整初始化。collaborator 启动 DDL 同样包含此表；生产迁移应先于流量开放执行。014 的 Thread 分页索引属于前一批交付。

## 三、调用与授权边界

显式工具调用：

```json
{"threadId":"thread-1","attempt":1,"prompt":"整理第一轮项目结论"}
```

下一轮保留相同 Thread 与 session，递增 `attempt`，例如 `attempt: 2`。`agent_threads_run` 同步等待本轮完成，返回 `threadId`、`runId`、当前 `thread` 与成功的文本 `summary`。调用必须来自登记的 coordinator Agent；服务端从实际 `exec.agent` 取父 Agent，不接受模型自报 owner 或 coordinator。

每次执行前读取 Thread 权威行，逐项核对 realm、project、task、node、session、workspace 与 coordinator；登记节点不等于本节点时拒绝。治理接口 `POST /v1/runtime/tasks/{taskID}/thread-authorization` 与现有 runtime preset 接口使用相同 service-token middleware：

- 从数据库读取指定 owner 的 active 状态和当前有效角色。
- 通过 `TaskAccess` 要求 contributor，并通过既有权限判定要求 Realm ∩ Project 授权。
- 核对 task project，拒绝完成、失败、取消、取消中以及业务终态任务。
- 核对预设的 active 状态与固定身份，拒绝未接线的知识、连接器、保护提示和金额 cap。
- 返回当前预设和授权事实；不产生 TaskRun。

runner 在准入前、准入后发送首条输入前、执行期间和接受最终结果前重新核验授权。授权丢失会取消执行；这不是对用户撤权的零延迟保证。

默认工具白名单为空，并通过公开工具 guard 拒绝其他插件稍后在 Agent scope 注册的工具。Thread 仅执行文本模型轮次，不继承父 Agent cwd、工具权限或任意模型选择；持久 session 的模型选择会在本轮输入前显式固定到已授权的 provider/model。

## 四、准入、完成、重试和不确定结果

`runId` 根据 realm、Thread ID、task ID、attempt 确定性生成。请求 hash 同时覆盖 prompt、稳定会话与工作目录、协调者、固定 owner、Agent、revision、模型和 `maxConcurrency`。同一轮换输入或执行身份会冲突。

| 阶段/情况 | 实际行为 |
|---|---|
| 首次 admit | 锁定权威 Thread，检查当前状态、固定身份和 Agent 共享槽位；持久写入 `running` 回执，再允许模型输入 |
| 后续新轮 | 前轮必须 completed、当前 Thread 必须 idle、attempt 必须连续递增且执行身份相同；恢复同一持久 session |
| 同轮同输入重试 | 读取已有不可变回执；completed 返回原 summary，不追加模型调用 |
| 同轮并发 | 仅一次准入拿到执行 token，其余看到 running/uncertain，不启动第二个模型 turn |
| finish | 校验独有 token 的 hash，事务保存终态/summary 并更新 Thread；completed 回 idle，failed/cancelled 回执均把 Thread 置为 failed（Thread 无 cancelled 状态） |
| finish 响应丢失 | 不猜测结果，不重新执行；按原轮次查询 durable receipt |
| 崩溃或 teardown/flush 失败 | 保持 running，并向调用侧表达 uncertain；没有过期接管、自动清槽或自动重跑 |
| 已失败或取消 | 不在同一 Thread 上自动恢复执行；需要检查日志和登记状态，按显式生命周期流程处理 |

PG 使用 `(realm, agent_id)` 的事务 advisory lock 串行化活动槽位计数与插入，多个 collaborator 实例、多个 Thread 共用该 Agent 的 `max_concurrency`。`running` 回执占用持久槽位；uncertain 在数据库仍是 running，**不会因节点重启、请求超时或经过一段时间自动释放**。已完成的同轮重试不消耗新槽位。

执行 token 只返回首次准入方，数据库存 hash，普通查询和重放不会泄漏 token。轮次结果不可变；同 token 重复提交相同 finish 可以幂等返回，不能把既有结果改写成另一终态或 summary。

## 五、summary、持久日志与计量

成功 summary 只取本轮新增事件中的最终 assistant 文本，最多 16000 个 Unicode 字符，保存到回执并返回给协调者。没有有效文本交付或本轮未正常 completed 时不制造成功。它是交付摘要，完整证据仍在稳定会话日志中。

每轮在模型输入前绑定 `SessionMeterRegistry`：user/project/agent 来自可信固定授权，`componentId = agent-teams`、`feature = thread:<threadId>`、`traceId = run:<runId>`。同一稳定 session 的不同轮次使用不同 trace。先等待公开 `AgentHandle.dispose()` 完成循环和持久写者清理，再释放归因，避免迟到 usage 被计到下一轮或默认身份；清理失败时保留不确定回执。

计量 PG 集成测试验证了真实 AgentLoop 的 usage 事件按两轮 trace 写入 PG，并采用可信 owner。这里使用确定性模型 adapter，未请求外部供应商。

## 六、已验证证据

最终 TS 广回归为 **1122 PASS / 0 FAIL / 0 SKIP（105 文件）**；governance 为 **137 PASS / 0 FAIL / 0 SKIP**，collaborator 为 **103 PASS / 0 FAIL / 0 SKIP**。Go 回归使用 race 检查和真实 PostgreSQL，collaborator 同时具备真实 Redis，历史 WAL 迁移用例本次也实际执行。全平台 TypeScript 类型检查，以及两个 Go 模块的 `vet`、`build` 均通过。

其中包含 26 个 runner 用例、1 个真实 PG 计量用例，以及真实 PG 的治理 HTTP 授权回归。治理回归覆盖用户停用、角色撤销/过期/禁用、项目与任务协作者撤销、身份和版本/模型漂移、受限预设、终态、service token、无 TaskRun/改派副作用。以上是本批所选包与模块的回归范围，不能外推为全部生产集群验收。

真实进程冒烟使用独立 PostgreSQL schema、governance 与 collaborator 两个独立 Go 进程，以及真实 AgentLoop/JSONL 持久化：

1. 首轮写入一个 turn；两个控制面进程和 Agent runtime 全部重启后，第二轮的模型请求仍包含第一轮输入与结果，持久日志共两个 turn。
2. 同轮重试不新增模型调用；相同请求并发时仅一个 completed，另一个 uncertain，总共一个模型调用。
3. 跨节点、当前用户停用、项目成员撤销均在模型调用前拒绝。
4. 共三个实际 mock adapter 调用，未创建治理 TaskRun；归因绑定与释放均通过。

摘要保存在本地构建产物 `platform/.build/thread-rounds-20261106/thread-process-smoke.json`；广回归证据为同目录的 `final-ts-results.json`、`governance-test.jsonl`、`collaborator-test.jsonl`，并保留编排脚本和进程日志。临时进程、测试 schema、PG/Redis 容器与临时环境文件均已清理，输出检查无 token/DSN。`.build` 是本机验证产物，不是需要部署或提交的源码。

## 七、剩余能力与限制

| 能力 | 当前边界 |
|---|---|
| 自动持续协作 | 当前为同步、显式发起的文本轮次；旧 suspend/wake 只做状态和 mailbox 通知，尚不自动启动模型 |
| 跨节点执行 transport | 仅登记本节点执行；远端 coordinator 到固定承载节点的执行 transport 尚未接线，不会降级到其他 Worker |
| 动态多用户 session owner | 固定部署 owner；上游浏览器 carrier 共享 owner Peer，尚未完成动态会话 owner 持久化及原生 HTTP/WS 全入口隔离 |
| host boot 控制 | 尚未直接接入 host boot 的即时暂停、drain 或硬取消信号；本轮授权轮询与传入 AbortSignal 不等同于该集成 |
| 复制健康联动 | 已检查持久后端和本节点 session，尚未把 `sessionLogReplication` 健康/积压直接纳入 Thread 准入和运行中取消 |
| 真供应商模型 | 已测真实 AgentLoop + mock adapter；未完成此链路的外部 vendor LLM 验收与成本/限流故障演练 |
| 强制异构评审 | 既有判据不等于 Thread 执行链路已强制使用不同模型、preset 或 reviewer；自动强制接线仍待开发 |
| Worker 与 Thread 联合容量 | 当前仅 Thread 按 realm/Agent 共用持久槽；必须使用独立文本 Agent，尚无与 governed Worker 的统一容量准入 |
| 高权限工具和保护提示 | 知识、连接器、工具、保护提示引用与 preset 独立金额 cap 均未在这条执行路径启用，配置时显式拒绝 |

后续开发应分别补齐 transport、自动唤醒执行、动态身份、boot/复制健康与容量统一，再按真实供应商和故障演练逐条验收。当前证据只支持本文明确列出的执行闭环。

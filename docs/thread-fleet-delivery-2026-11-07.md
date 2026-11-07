# Thread 舰队、动态归属、Bot 授权与异构审核

本批在 `codex/v1.2.1` 接通五项此前未开发能力。实现全部位于 platform 插件与 Go 控制面，`deepseek-harness/` 源码保持只读。

| 能力 | 本次实际行为 |
|---|---|
| 跨节点路由 | 协调者经持久命令邮箱提交不可变输入；登记节点轮询领取，使用公开 Agent API 在原稳定 Session 执行。没有同步节点 RPC 协同，也不移动 Thread 的节点、Session 或工作目录。 |
| 自动唤醒执行 | 持久登记下一轮输入、事件 key 和截止时间；唯一事件把 waiting 原子置 pending、Thread 置 idle；目标节点自动执行。控制面和执行器重启不丢等待项。重复事件不重复执行。 |
| 动态 owner | Session-control 分配全新 ID，持久固定 owner/project/node；独立认证文本页面 `/lumo/chat` 按当前登录用户创建和恢复会话，并使用非 owner Peer、Gateway 与 remoteAccess。 |
| Bot 团队授权 | 签名 v2 绑定外部 subject；当前映射、grant、团队 captain/revision、项目及 Agent preset 联合检查。持久消息冻结映射与授权版本，重试不能借用后续新 grant。 |
| 强制异构审核 | 执行前冻结模型、预设版本与生产任务契约；服务端枚举封闭文本输出生成清单；独立审核任务原子绑定清单，任务完成事务强制检查当前独立异构审核结果。 |

## 跨节点命令与自动唤醒

`agent-teams` 的 `threadExecution` 保留原固定项目、Agent、预设和模型配置；新增 `distributed: true` 启用异步节点路由；此模式必须同时设置 `sessionControlUrl`，启用受信 Session 分配与 owner 校验。例如部署环境的 `LUMO_THREAD_EXECUTION`：

```json
{
  "governanceUrl": "http://governance:8089",
  "projectId": "project-a",
  "agentId": "thread-assistant",
  "presetRevision": 1,
  "provider": "configured-provider",
  "model": "configured-model",
  "timeoutMs": 600000,
  "distributed": true,
  "sessionControlUrl": "http://session-control:8092"
}
```

所有参与节点都须配置同一 realm、可信控制面 token 和该执行身份。当前节点邮箱串行执行，一次领取一项；提高预设并发上限不会自动提高单节点邮箱吞吐。当前执行 profile 仍是专用 Agent 的固定文本能力；owner 的动态多用户文本入口另见下节，不把固定 Worker 身份冒充动态用户。Thread 与 governed Worker 仍须使用不同 Agent，避免两个执行槽计数域共享一个 Agent。

原 `agent_threads_run` 在此模式提交持久命令并等待回执；调用取消只结束等待，已经提交的命令仍以服务端持久事实为准。源端核对当前真实协调者 Agent，目标端使用领取产生的进程内不透明能力，并再次核对注册表及当前治理权限；不能将 wire 上自报的 `parent.id` 当作协调者授权。

新增工具：

- `agent_threads_schedule`：`threadId/attempt/prompt/wakeKey/deadline`。冻结下一轮完整输入，进入 waiting；截止时间最多 24 小时。
- `agent_threads_signal`：`commandId/wakeKey/eventId`。相同事件幂等，不同事件不能重新兑现同一等待项。

服务端 API 为 `POST /threads/{id}/commands`、`GET /thread-commands/{id}`、`POST /thread-commands/{id}/wake`，节点使用独立 claim/finish 端点。所有接口受控制面 token 与 realm/user 边界保护，浏览器不持有 service token。过期由目标轮询或读取命令时处理；即使目标离线，读取也能把等待项过期并释放其等待状态。

领取与轮次准入都持久去重。**claimed/运行结果不确定时不会自动释放、重领或换节点执行**，必须核对日志与回执处理。该限制保证不会把“不知道是否运行”变成第二次模型调用。节点丢失时原 Thread 保持失败，需要显式新建替代 Thread；工作目录没有迁移功能。

启用 owner 分配后，创建 Thread 时 Session ID 由 authority 生成，调用方的旧 Session ID 不会被认领。协调者必须已有同 owner/project 的 active 归属。Thread 创建链目前先提交不可变归属再登记 Thread；active 仅表示归属已提交，Session 是否真实存在仍由 runner 在 create/resume 前通过持久后端单独确认，不能据 owner 行推断已有历史。原无 owner 档位可兼容运行，不能声称具备动态用户隔离。

## 动态文本会话与 Bot

动态用户配置 `LUMO_USER_SESSION_EXECUTION`，登录进入 `/lumo/chat`。该模式阻断原生共享 owner 的 HTTP/WS 入口，当前支持文本创建、列表、历史、输入、观察和停止；未开放 fork、附件、知识或连接器工具。逐请求、逐 step 及运行中检查当前登录与项目权限，撤权会停止执行并关闭流；持久待执行消息未被确认时拒绝自动恢复，避免崩溃后重复计费。完整配置与接口见 [动态 Session owner](./dynamic-session-owner-2026-11-06.md)。

治理 `LUMO_BOT_TEAMS_URL` 指向团队 authority 所在节点的认证代理地址。`GET /lumo/runtime/teams/{id}` 只接受 service Bearer，读取当前持久团队事实；代理重建固定 realm/token，不依赖浏览器身份。无可信团队读面时授权拒绝。映射/grant 的安装与 v2 签名示例见 [Bot 接入](./bot-ingress.md) 和 [部署说明](../platform/deploy/bot/README.md)。旧 v1 事件仍可执行纯内部流程，不能继承作者身份启动团队委派；迁移也补标历史消息及 replay 链。

## 审核与交付范围

生产运行开跑前 `PUT /v1/runtime/task-runs/{runID}/prepare` 冻结执行事实。审核发起使用 `POST /v1/tasks/{taskID}/runs/{runID}/review-tasks` 与 `Idempotency-Key`，服务端在同事务中创建审核任务、Run、清单绑定和调度 outbox，避免先调度后绑定的竞态。页面也提供审核任务入口。

当前强制范围是平台**封闭文本交付集合**：所有接受的文本块及 summary 都进入服务端清单；原始任务意图和验收契约来自执行前快照。审核 Agent 必须使用不同 Worker，预设、模型和节点的独立性按现有异构矩阵检查；结果必须明确批准精确清单 digest。任务 complete 同事务读取证据，缺失、同构、拒绝、过期、重试后的旧审核以及未知影响均返回冲突。同任务的历史未知执行不能被后续已批准的文本重跑掩盖；任意当前或历史附件均不在封闭文本清单内，拒绝按此范围验收。完成后也不能通过旧 Run 追加附件。

未知连接器或宿主机副作用、任意上传附件的完整影响不能靠自报数量证明。未知执行标记 unknown，附件另由存在性检查拒绝验收；两者均不具备可供完成放行的封闭文本证据。当前实现保守地对所有可证明文本交付强制审核；没有以浏览器 `proven=true` 或人工 complete 绕过证据。详细契约见 [独立运行审核](./independent-run-review-2026-11-06.md)。

## 数据迁移与验证

迁移 016–019 分别由 collaborator、session-control、governance、flows 启动 DDL 接管；服务启动与迁移的结构收敛由真实 PostgreSQL 形状检查覆盖。019 同时包含治理授权表及 Flow 历史 scope 升级，两个服务各执行自己的部分。

验证使用隔离 PostgreSQL/Redis、真实 Go HTTP 进程、公开 AgentLoop/JSONL/Gateway/Peer/remoteAccess 与确定性模型 adapter。最终结果：

| 检查 | 结果 |
|---|---|
| TypeScript 回归 | 112 个文件，**1180 PASS / 0 FAIL / 0 SKIP**；包含真实动态会话 HTTP/Gateway/AgentLoop 组合测试。 |
| Go 全包 race | collaborator 109、governance 206、flows 249、session-control 248，合计 **812 PASS / 0 FAIL / 0 SKIP**；使用真实 PostgreSQL，相关迁移与 WAL 用例使用 Redis。无测试文件的包不计入用例跳过数。 |
| 静态与构建检查 | 全平台 `tsc -b --noEmit`、上述四个 Go 模块的 `go vet` 和 `go build` 均通过。 |
| Helm 配置接线 | 真实渲染及 YAML 解析通过，Thread/动态用户环境变量 JSON 与输入一致，7 类无效配置全部拒绝；未完成依赖 PyYAML 的完整组合验证脚本。 |
| 上游只读约束 | pristine 闸门通过，`deepseek-harness` 为 `fcc0ad46`，无源码或锁文件改动。 |

进程冒烟已经证明：持久命令到登记节点执行，两轮间控制面与运行时重启，等待事件随后自动续跑并保留前轮历史，重复事件及重启后回执重放不增加调用，撤权后无模型调用；合计仅 2 次确定性模型调用。源端真实协调者身份与目标进程内 claim 能力另由单元测试覆盖。

本机证据保存在 `platform/.build/thread-fleet-20261106/verification-summary.json`，同目录保留测试、配置和进程冒烟报告。隔离测试容器及临时凭据文件已清理。该证据没有使用真实外部供应商，也不等同于跨主机故障、生产高可用及外部模型验收；本批未发布生产，也未完成浏览器视觉验收。

随后补跑的[原生模型配置与 Docker 双节点验收](./model-and-docker-acceptance-2026-11-07.md)
通过了 Thread 网络隔离、运行中 SIGKILL、完整集群依赖故障及本机 Helm 全组合检查；
原生外部供应商调用被拒绝，物理跨主机和生产验收边界保持开放。

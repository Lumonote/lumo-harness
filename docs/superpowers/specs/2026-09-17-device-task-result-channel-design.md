# 设备任务结果通道设计说明 —— 接上 `execute_task` 的最后一跳（队列 #12，方案 ①）

- 日期：2026-09-17
- 评审对应：`architecture.md` §17.1「员工设备执行链路」、`desktop-devices.md`（设备命令面）
- 状态：**设计稿，待批准后实施**（本文不含已实现内容；§5 给出四步实施与验证）
- 服务位置：`platform/control-plane/governance`（设备网关 + store）、`platform/control-plane/registry/cmd/desktop-agent`（设备侧）
- 前序：`cluster-development-tasks.md` 第 59 行的复核结论、`implementation-status.md` 的 2026-09-17 #12 节
- 决策来源：**方案 ①**（`completed` = 已接受，另开设备侧结果通道）。理由见 §0。

## 0. 决策背景：为什么必须是 ①，以及为什么必须新增一个消息类型

`execute_task` 今天**保证失败**：设备的命令 switch 只处理 `reconcile`/`start`/`stop`
（`registry/cmd/desktop-agent/main.go:765-811`），`execute_task` 落在 switch 之外，`result`
保持初值 `failed` + `{"error":"command_denied"}` 回给网关，`CompleteDeviceCommand` 走「本地拒绝」
终态，任务以「Device did not accept the task assignment」收场。为这一跳写好的代码全在、**零调用方**。

**为什么不能只接「接受」那半。** 网关把 `completed` 读作**已接受**：审计事件名是
`device_execution_accepted`，转移是 `scheduler_tasks PLACED→RUNNING`。只接接受半，任务会稳定进入
`RUNNING`，而**没有任何东西能把它结束掉**——把「立刻失败」换成「永远运行」，比现状更坏。
C5 那条「记了没做可对账」在这里不成立，因为写下的不是诚实的 `recorded`，是假的 `RUNNING`。

**为什么结果不能搭同一条命令的 `result` 回传。** `CompleteDeviceCommand` 对同一 `command_id`
的第二条结果做**不可变性校验**（同 payload 幂等、不同则 `ErrConflict: command result is immutable`，
`store/devices.go:711-724`）；且设备侧 `journal/<command_id>` 以 `O_EXCL` 建文件，一个命令只处理一次
（`main.go:743`）。所以「接受」与「完成」**不可能共用一条命令回执**。

**为什么不用 HTTP 结果面。** 结果上报面已经存在
（`POST /tasks/{taskID}/runs/{runID}/result`，`server/task_results.go:48-62`），但它要求
`task:execution:update` 权限（`server/server.go:532-538`）——那是**用户/Worker 身份**的权限。
设备是 mTLS + WS 身份，在 governance 里没有用户权限集。让设备走这条面等于**给它开第二个信任边界**；
而设备连接上已经有完整的围栏（`connection_id`、`revision`、`certificate_expires`、`connection_expires`），
`CompleteDeviceCommand` 的接受路径已经在用它们。**把结果放进同一个连接，是少一个信任边界的选择。**

**为什么方案 ② 被否。** ② 要把 `completed` 改读作「已完成」，那就得改 `CompleteDeviceCommand`
的转移（RUNNING→COMPLETED）与审计名——改的是控制面里**已经正确、已经上线**的那半。而且
`runTaskRunner` 有 30s socket 期限（`main.go:262`），② 只能承载 30s 内跑完的任务，超出即失败，
把一个「结果通道」问题变成了「任务时长上限」问题。

## 1. 现状侦察（全部读代码取证，非推断）

| # | 事实 | 证据 |
|---|---|---|
| R1 | `execute_task` 未处理 → 稳定失败 | `registry/cmd/desktop-agent/main.go:765-811`（switch 只有三种 action）、`:738`（`result` 初值 `failed`/`command_denied`） |
| R2 | 五个函数完整、**零调用方** | `persistTaskInbox`(`:192`)、`persistTaskReceipt`(`:218`)、`taskResultPayload`(`:240`)、`runTaskRunner`(`:251`)；`-task-runner-socket` 在 `:323` 解析、`:336` 校验为绝对路径，之后**再未出现**。Go 不报未使用函数，`vet` 亦无声 |
| R3 | 设备 WS 的 `write` **已经过 `writeMu`**，可从其它 goroutine 安全调用 | `main.go:606-613`（`writeMu.Lock()` 包住 `ws.WriteJSON`） |
| R4 | 设备网关**只认两种入站类型**：`heartbeat` 与 `result`；`default:` 直接 `return`（**关连接**） | `governance/internal/device/gateway.go:624-637` |
| R5 | `CompleteDeviceCommand` 的接受路径：`state ∈ {completed,failed}`；`completed` 且 `action='execute_task'` 时把 run/delegation/scheduler_tasks/scheduler_task_attempts 四处 PLACED·QUEUED→RUNNING，写审计 `device_execution_accepted` | `store/devices.go:686,745-785` |
| R6 | 同一方法在 `failed` 时**已经会写** `governance_task_results`（本地拒绝的终态回执） | `store/devices.go:790-795` |
| R7 | **`domain.TaskResult` 与设备产物逐字段同构**：`task_id/run_id/state/session_ref/node_id/summary/output`；`Validate()` 接受 `COMPLETED\|FAILED\|CANCELLED`，`COMPLETED` 要求 `session_ref` 且（`summary` 或 `output`）非空，`output` ≤1MiB 合法 JSON，`summary` ≤16000 rune | `domain/task_result.go:13-40`；对照 `main.go:240-250` 的 `taskResultPayload` |
| R8 | **结果记录逻辑已存在且已含全部围栏**：不可变重放（同 payload 幂等、异则 `ErrConflict`）、run 绑定（`run.ID==RunID`、`AssignedNodeID`、`SessionRef`）、任务已关闭则拒、写 `governance_task_results`、更新 run 与 delegation（`COMPLETED` 时 `business_state→VERIFYING`）、审计 `execution_result`、通知父任务 `child_result` | `store/task_results.go:44-120` |
| R9 | 命令行**带着权威的任务身份**：`run_id`/`attempt`/`session_ref`/`action`/`state`/`connection_id`/`revision` | `store/devices.go:29-46`（DDL + 三条 `ADD COLUMN`） |
| R10 | `runTaskRunner` 同步、30s deadline、返回**终态** `COMPLETED\|FAILED\|CANCELLED`，并已校验输出尺寸与「COMPLETED 必须有交付物」 | `main.go:251-296` |
| R11 | 每 `(realm, run_id)` 只允许一条**在途**命令（偏唯一索引），但**每设备在途命令上限是 16** | `store/devices.go:44-46`、`dispatchDeviceTask` 的 WHERE |

**R7 + R8 + R9 是本次的关键**：设备产物已经是 `domain.TaskResult` 的形状，控制面已经有带完整围栏的
结果记录逻辑，命令行已经带着权威的 run 身份。**缺的只有「运输 + 授权绑定」这一层**，不是数据模型，
也不是业务规则。这把本项从「新增一条链路」缩小成「把已有的三块接起来」。

## 2. 范围

**在范围内：**

- 设备侧处理 `execute_task`：**先落不可变收件箱，再回「已接受」，再异步执行**（三步的顺序是不变量，见 §4）
- 一条**新的入站 WS 消息类型 `task_result`**，承载设备侧最终结果
- 控制面把它记进既有结果面：**run 身份一律取自命令行**，不取设备自报
- 设备**没有配 `-task-runner-socket` 时不得接受**（见 §3.4）
- 结果不可变与重放幂等：由 R8 既有语义承担，本次不新造

**不在范围内（逐条写明理由）：**

- **`completed` 的语义与 `CompleteDeviceCommand` 的转移**——这正是方案 ① 要**不动**的那半（§0）
- **HTTP 结果面与 `task:execution:update`**——不改；设备不走它
- **取消/中断**：任务执行期间的 `stop`/`cancel` 语义（`scheduler_tasks` 的 CANCELLING 态如何到达设备）
  **本轮不做**，因为设备命令面目前没有「取消某条在途 execute_task」的 action，且
  `runTaskRunner` 的 socket 契约里也没有取消帧。这是**下一项**，不是本项的一部分——但 §6 会记下它，
  免得实施后误以为「已经能取消了」
- **设备重启后恢复在途任务**：收件箱与回执都是不可变的，重启后**重发同一份回执是安全的**（R8 幂等），
  但「启动时扫收件箱、把没有回执的 run 报成 FAILED」不在本轮。§6 记为已知缺口
- **`execute_task` 之外的新 action**：不动

## 3. 设计

### 3.1 设备侧：`case "execute_task"` 的三步与一条 goroutine

顺序是**不变量**，不是实现细节：

```
case "execute_task":
  1) validateTaskEnvelope(cmd.Task)          // 已有，:141
  2) persistTaskInbox(stateDir/tasks, cmd.ID, cmd.Task)   // 已有，:192
     └─ 失败（含「run ID 已绑定到不同任务」）→ 不接受，走 command_denied
  3) 回 result{State:"completed", Result:{"accepted":true}}   // 这就是「已接受」
  4) go 异步：runTaskRunner → persistTaskReceipt → write(task_result)
```

**第 2 步必须在第 3 步之前**：接受的含义正是 `dispatchDeviceTask` 注释里那句
「Scheduler remains PLACED until the desktop confirms that the assignment was **persisted in its
local task inbox**」。先回执再落盘，等于**对控制面撒一个无法回滚的谎**：设备崩了，控制面记着
「已接受」，而本地什么都没有。

**第 4 步必须异步**：`runTaskRunner` 有 30s deadline，同步做会把命令循环连同心跳一起卡住
（心跳 10s 一次，`main.go:616`）。

异步 goroutine 里的收尾顺序同样是不可变的：

```
resp, err := runTaskRunner(ctx, o.taskRunnerSocket, cmd.ID, cmd.Task)
receipt := taskReceipt{Version:1, CommandID:cmd.ID, Task:cmd.Task, State:..., Summary:..., Output:..., UpdatedAt:now}
        // State 由 resp 决定；err != nil 时 State="FAILED" 且 Summary 是**固定的**诊断串
persistTaskReceipt(stateDir/tasks, receipt)   // 不可变；已存在且不同 → 记日志，不覆盖
payload, _ := taskResultPayload(receipt, o.nodeID)
write(message{Type:"task_result", CommandID: cmd.ID, Result: payload})
```

**回执先于上报**：`persistTaskReceipt` 失败时不发 `task_result`（宁可让控制面等超时，也不要上报
一个本地没有留痕的结果）。这与第 2 步是同一条理由。

### 3.2 线上形状：`task_result` 复用 `message.Result`，不新增字段

入站消息沿用既有 `message` 结构（设备侧 `main.go:274-289`，网关侧同形），只新增一个 `Type` 取值：

```json
{"type":"task_result","command_id":"<43 字符命令 ID>","result":{ …domain.TaskResult… }}
```

`result` 就是 `taskResultPayload` 的产物——**它已经是 `domain.TaskResult` 的逐字段同构**（R7），
所以网关侧 `json.Unmarshal(message.Result, &domain.TaskResult{})` 直接成立，
`Validate()` 也直接复用。**不新增字段、不新增形状**：多一个形状就多一处要同步的契约。

`CommandID` 在这里的作用**不是**「哪条命令的结果」这一层语义（那由 `command_id` 的
不可变性承担），而是**授权绑定的把手**：网关用它把这条消息钉到那一行命令上，从那一行取权威的
run 身份（§3.3）。

### 3.3 控制面：新 store 方法，run 身份一律取自命令行

```go
// RecordDeviceTaskResult 记录一次设备侧任务执行的最终结果。
// 调用方（设备网关）已通过 mTLS 认证设备身份；本方法再用命令行把身份钉死。
func (s *Store) RecordDeviceTaskResult(
    ctx context.Context, realm, nodeID, connection, commandID string, result domain.TaskResult,
) error
```

实现要点，**每一条都对应一个具体的越权或错配形态**：

1. `SELECT action,state,run_id,attempt,session_ref,revision FROM governance_device_commands
   WHERE realm=$1 AND node_id=$2 AND id=$3 AND connection_id=$4 FOR UPDATE`，并 JOIN
   `governance_device_connections` / `governance_desktop_nodes` / `governance_users`，
   条件与 `CompleteDeviceCommand` **逐条相同**（连接未过期、证书未过期、`revision` 一致、
   节点非 `REVOKED`、用户 `active`）。**复用同一组围栏，不另立一套。**
2. **命令必须已经到达 `state='completed'`**（即已被接受）。没有接受过的命令不得产生结果——
   否则设备可以跳过接受直接写结果，`PLACED→RUNNING` 的转移就被绕过了。
3. **`run_id` / `attempt` / `session_ref` 一律用命令行的值覆盖消息里的值**；若设备自报与行不一致，
   **拒绝**（不是静默采信行、也不是采信设备）。静默采信任何一侧都会让「谁说了算」变得不可测——
   而这里恰恰是越权写别人 run 的入口。
4. `action` 必须是 `execute_task`；`run_id`/`attempt`/`session_ref` 非空（与
   `CompleteDeviceCommand` 的 `:733-735` 同一判据）。
5. `result.NodeID` 置为 `nodeID`（来自认证身份），并据此走 R8 既有的
   `run.AssignedNodeID` 绑定校验——**「设备只能报自己那条 run」这条规则因此不需要新写**，
   它已经在 `RecordTaskResult` 里。
6. 具体写入**复用 `RecordTaskResult` 的事务体**（把 `:57-119` 提成
   `recordTaskResultTx(ctx, tx, realm, result, actor)`，两个入口共用）。
   `actor` 用 `"device:"+nodeID`，让审计能区分「Worker 报的」与「设备报的」。

### 3.4 没有 task runner 时**不得接受**

`-task-runner-socket` 是可选参数。若为空，`runTaskRunner` 必然返回
`"task runner is not configured"`（`main.go:253`）。

**此时应当拒绝（`command_denied`），而不是「先接受再报 FAILED」。** 接受一个自己做不到的任务，
是在任务账本上写下假的 `RUNNING`；而拒绝是一条**诚实**的终态回执，任务以「设备未接受」收场，
可按既有重试路径重试。这与 §0 里否掉「只接接受半」的是同一条判据。

同理，**本地执行槽位**：每设备在途命令上限是 16（R11），但那是**命令投递**的上限，不是桌面机的
执行容量。建议设备侧只保留**一个**执行槽（在跑时后续 `execute_task` 一律拒绝）。这是一处
**需要拍板的取舍**（§6 Q1）。

### 3.5 上线顺序：**先治理面，后设备**

网关对未知入站类型是 `default: return`——**直接关连接**（R4）。因此：

> **新设备 + 旧网关 = 设备每次上报结果都会掉线。**

所以必须**先部署 governance（网关认 `task_result`），再滚动设备**。这一条要写进发布说明；
反过来做会表现为「设备频繁重连」，与结果通道本身无关，排查时很容易找错方向。

建议在网关侧同时把 `default:` 的行为改得更可诊断（例如回一条 `{"type":"error","error":"unknown_message_type"}`
再关），但那是**独立的小改动**，不阻塞本项——且改它要先确认设备侧对未知消息的处理
（`main.go:729` 对非 `desired`/`commands` 的入站是 `return errors.New("unknown gateway message")`，
即**设备也会因未知类型退出**）。两侧同病，见 §6 Q2。

## 4. 不变量（实施后应能被测试钉住）

| # | 不变量 | 违反时的形态 |
|---|---|---|
| I1 | 未落盘不收件：`persistTaskInbox` 成功之前**不得**回「已接受」 | 设备崩 → 控制面记 RUNNING、本地无任务 |
| I2 | 回执先于上报：`persistTaskReceipt` 成功之前**不得**发 `task_result` | 控制面收到一个本地无痕的结果，不可复核 |
| I3 | 结果只能记在**已被接受**的命令上 | 绕过 `PLACED→RUNNING` 直接落结果 |
| I4 | run 身份取自命令行；设备自报与之不一致即拒 | 设备越权写别人的 run |
| I5 | 同一 run 的结果**不可变**：同 payload 幂等、异 payload 冲突 | 重放把已完成的任务改写成别的结果 |
| I6 | 没有 task runner 的设备**不接受** `execute_task` | 任务账本上的假 RUNNING |
| I7 | 执行不阻塞命令循环（心跳继续走） | 30s 任务期间设备被判失联 |

I5 由 R8 既有语义提供，**本项只需不为它新开旁路**——这是「复用」而非「新增」的地方，
也是实施时最容易写歪的地方（自己再写一条 INSERT 就会绕过不可变性）。

## 5. 实施顺序与验证

四步，**每步结束时都能编译且不回归**（全部是增量，未接线的路径与今天行为一致）：

1. **store**：把 `task_results.go:57-119` 提成 `recordTaskResultTx`，两个入口共用；
   新增 `RecordDeviceTaskResult`。验证：`task_results_integration_test.go` 既有用例仍全过
   （需活库，`platform/deploy/test-local-pg.sh`），新增针对 §3.3 六条要点的用例。
2. **网关**：`gateway.go:624` 的 switch 加 `case "task_result":`（先 `AuthenticateDevice`，
   再 `RecordDeviceTaskResult`，与 `result` 分支同形）。验证：`internal/server` 与
   `internal/device` 用例；确认未知类型仍走 `default`。
3. **设备**：`case "execute_task":` + 异步 goroutine + `task_result` 上报。
   验证：设备侧单测（收件箱/回执的不可变与幂等已有函数，可直接测）。
4. **端到端**：需要一台模拟 Agent 的活体用例——起 governance + registry，让设备连上，
   投一条 `execute_task`，断言 `governance_task_results` 出现该 run 的行、
   `governance_delegation_tasks.business_state='VERIFYING'`、审计有 `execution_result`、
   且父任务收到 `child_result` 通知。**这一步才是「端到端验收」**，前三是单元级。

文档同步：`desktop-devices.md`（设备命令面补第四种 action 的**实际**处理与新的入站类型）、
`cluster-development-tasks.md` 第 59 行、`cluster-gap-analysis.md` 的 #12 口径、
`implementation-status.md`。

## 6. 未决问题与已知缺口（实施前需要拍板或接受）

- **Q1（需拍板）本地执行并发度**：建议**单槽 + 拒绝超额**（§3.4）。备选是「接受并排队」，
  但那要求设备能持久化「排队中」这一状态（收件箱只有「已收到」，没有「排队位次」），
  会把复杂度推到收件箱契约里。**建议单槽。**
- **Q2（需拍板，不阻塞）两侧对未知消息都「退出连接」**：网关 `default: return`（R4）、
  设备 `unknown gateway message`（`main.go:729`）。这让**任何**协议增量的上线顺序都是硬约束，
  而不只是本项。建议改成「记日志 + 忽略未知类型」并各自加一条用例——但这是**独立的协议演进**问题，
  且放宽它本身有安全含义（未知类型可能是攻击面），所以不塞进本项。
- **Q3（已知缺口）取消/中断**：见 §2。任务跑起来之后**今天没有办法取消它**。
  设备命令面没有对应 action，`runTaskRunner` 的 socket 契约也没有取消帧。
  实施本项之后，这个缺口会**第一次变得可观察**（任务真的在跑了），所以必须同时记进文档，
  否则会表现为「新 bug」。
- **Q4（已知缺口）重启恢复**：见 §2。收件箱与回执不可变 → 重发安全；但「启动时把无回执的 run
  报成 FAILED」未做。当前形态是：设备重启后那条 run **停在 RUNNING**，直到超时或被人工处理。
- **Q5（已自查，无需拍板）`attempt` 的粒度**：命令行带 `attempt`，而 `RecordTaskResult` 的绑定校验
  没用它（只用 `task_id` + `attempt DESC LIMIT 1`），一度怀疑「一个 run 只能有一条结果」会吞掉重试。
  **查了 schema，不成立**：`governance_task_runs` 是 `id TEXT PRIMARY KEY` 且
  `UNIQUE (task_id, attempt)`（`store/store.go:352-368`）——**每次 attempt 是独立的一行、独立的 run id**。
  因此 `governance_task_results.run_id PRIMARY KEY` 恰好等于「**每个 attempt 一条结果**」，语义正确，
  不需要改主键。实施时**不要**把 `attempt` 当成同一 run 内的版本号来用（它不是）。

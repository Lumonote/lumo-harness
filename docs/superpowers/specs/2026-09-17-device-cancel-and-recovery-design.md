# 设备任务取消与重启恢复（B 包）设计

日期：2026-09-17
状态：设计已评审通过（取消的边界口径经用户确认），待实现
范围：「剩余所有功能」四包分解中的第 2 包

---

## 0. 前置修复：结果通道在此之前是**死的**

写本设计时的侦察发现并修掉了一个 P0，先记在这里，因为 B 的两项都建立在同一条链上。

`persistTaskInbox` 与 `persistTaskReceipt` **写同一个路径** `stateDir/tasks/<runID>.json`。
`createImmutableJSON` 用 `O_EXCL`，所以先写的收件箱记录让后写的回执必然拿到 `ErrExist`；
而 `ErrExist` 分支的语义是「这条记录已存在，接受相同重放、拒绝不同内容」，于是它把**收件箱
JSON 当成回执**读出来做比较，判定为不同，返回 `desktop-agent: task result is immutable`。
回到 `finishDeviceTask`，这一句是 `log` 之后 `return` —— **`task_result` 从来没被发出去过**。

证据（不是推断）：新增用例 `TestReceiptLandsAfterTheInboxRecordInTheSameDirectory`
按生产顺序（同一目录先收件箱后回执）走一遍，修前失败并打印上面那条文案，修后通过。
修法是给两者不同后缀（`.inbox.json` / `.receipt.json`）。

**为什么两个既有用例都没抓到**：`TestTaskInboxIsImmutableAndIdempotent` 与
`TestTaskReceiptIsImmutable` **各自拿一个全新的 `t.TempDir()`**，谁都见不到对方的文件——
「两个函数各自正确」恰好是路径撞车从内部看起来的样子。这与 D5 那轮的静默跳过同族：
**每个断言单独看都对，没人跑过那个真正会发生的顺序。**

**它同时解释了为什么活库全绿也抓不到**：设备往返没有任何活库用例覆盖，修复前后
`test-local-pg.sh` 都是 1,319 PASS。这条是「真库跑绿」这个交付标准**够不着**的一处，
必须靠按生产顺序写的单元用例——写在这里，免得下一次误以为「活库绿=设备链通」。

---

## 1. 侦察事实（这些决定了设计形状，先列出来）

| # | 事实 | 证据 |
|---|---|---|
| R1 | **runner 不在本仓库**：设备是客户端，通过 UNIX socket 发一条 `execute_task`、读一条响应 | `runTaskRunner` `:251-281`；全仓检索 runner 服务端零命中（只有 node_modules 里的无关 README） |
| R2 | 该交换是**一问一答，没有中途通道**，且**硬超时 30s** | `main.go:262` `conn.SetDeadline(time.Now().Add(30 * time.Second))`；`:263` 写一条；`:266-270` 读一条 |
| R3 | 设备是**单槽位**的：一次只跑一个任务 | `taskSlot := make(chan struct{}, 1)` `:770`，占用 `:851`、释放 `:864` / `:929` |
| R4 | scheduler 侧**已经会**置 `CANCELLING` | `scheduler/internal/store/store.go:681`（`UPDATE scheduler_tasks SET state='CANCELLING'`），且漂移逻辑**刻意排除** CANCELLING（漂走等于丢掉那次取消） |
| R5 | governance 侧**没有取消桥**：`devices.go` 里 `cancel` 零命中 | 全文件检索 |
| R6 | 设备命令的 `run_id` **就是** `scheduler_tasks.task_id` | `devices.go:439` `AND o.task_id=q.run_id`；`store.go:681` 按 `task_id` 更新 |
| R7 | 回程通道已经建好且带全套围栏 | `task_result`（2026-09-17 spec）+ `RecordDeviceTaskResult` 的不可变重放、run/node/session 绑定 |
| R8 | `runTaskRunner` 已接受 `ctx` | `:251` 第一个参数；调用处 `:291` 传的是外层 `ctx` |

R1 与 R2 是本次设计里**最有约束力的两条**：它们决定了「在途取消」不可能做到真正的即时中断。

---

## 2. B1 取消

### 2.1 口径（用户 2026-09-17 确认）

**做到本仓库能兑现的那半，并诚实标注另一半。** 能覆盖的两段：

- **① 已接受但未起跑**——完全可控。此时槽位已占、收件箱已落，但 runner 还没被调用。
- **② 在途（≤30s）**——弃等 + 关闭 socket。**EOF 是本仓库唯一可用的中断信号**（R2：
  协议没有中途通道）。

**不可保证的一段，写进代码注释与 `desktop-devices.md`**：runner 收到 EOF 之后是否真的停止，
由 socket 对端决定，**不在本仓库的契约内**。刻意**不**定义 `{"type":"cancel_task"}` 这样的
取消帧——那会造出一条「协议里写着、两端都没实现」的路径，正是 C3/C4「不在 Helm chart 里」
的同族形态：**看起来有契约，实际没有任何一方在执行它**。

### 2.2 链路：三跳新建 + 一跳复用

```
操作面取消
  → scheduler_tasks.state = 'CANCELLING'            （已有，R4）
  → [新建] governance：把「scheduler 已 CANCELLING 的、设备承载的 run」
     落成一条 governance_device_commands(action='cancel_task')
  → [新建] 设备：case "cancel_task" 命中在途任务 → 取消等待、关 socket、写 CANCELLED 回执
  → [复用] 设备经既有 task_result 通道上报                  （R7）
  → [复用] scheduler 收终态
```

**governance 那一跳的判据**（R6 给出连接键）：

```sql
-- 找「设备命令还在途、但对应的调度任务已被取消」的行，为它们补一条 cancel_task。
-- run_id 就是 scheduler_tasks.task_id（R6），不需要新列。
SELECT c.realm, c.node_id, c.id, c.run_id
  FROM governance_device_commands c
  JOIN scheduler_tasks t ON t.task_id = c.run_id
 WHERE c.action='execute_task' AND c.state IN ('queued','delivered')
   AND t.state = 'CANCELLING'
```

插入的 `cancel_task` 行沿用既有形状（含 `run_id`/`attempt`/`session_ref`），并受既有的
每设备 16 条在途上限约束——**取消命令不该被这个上限挡住**，否则一台塞满的设备正好无法被取消。
所以插入时对 `cancel_task` 单独放宽（实现时按现有 `DispatchDeviceTasks` 的计数条件加一条
`action='cancel_task'` 的豁免，并在注释里写明理由）。

### 2.3 设备侧：匹配、取消、回执

设备需要记住「在途的是哪一条命令」——现在只有 `taskSlot` 一个 token，**没有任何地方存
command id**。新增一个受 mutex 保护的在途记录：

```go
type inflightTask struct {
    commandID string
    runID     string
    cancel    context.CancelFunc   // 来自 context.WithCancel(ctx)，见 R8
}
```

三个分支：

- **命中在途且 `command_id` 相符** → `cancel()`。`runTaskRunner` 的 dial/读写因 ctx 取消
  立刻返回，其 `defer conn.Close()` 发出 EOF；槽位随既有 `defer func(){ <-taskSlot }()` 释放。
- **命令不认识 / 不在途** → 该 `cancel_task` 对应的任务要么已完成、要么从未开始。**不报错**，
  回一条 `{"cancelled":false,"reason":"not in flight"}`，由控制面按幂等处理（可能只是取消
  晚到了一步）。
- **回执状态**：`finishDeviceTask` 现在把任何 error 都记成 `FAILED` + "device task runner failed"。
  需要区分：`errors.Is(ctx.Err(), context.Canceled)` 时记 **`CANCELLED`**，summary 用
  「task cancelled by the control plane」。**这一步是必要的**——否则一次成功的取消会在任务
  台账里留下一条假的 `FAILED`，而 `FAILED` 与 `CANCELLED` 在后续的业务状态机里不是一回事。

### 2.4 幂等与围栏

不新造任何机制：回执的不可变重放、run/node/session 绑定、`RecordDeviceTaskResult` 的围栏
全部复用（R7）。取消产生的回执与正常完成产生的回执走**完全同一条**路径，区别只在 `state`。

---

## 3. B2 重启恢复

### 3.1 判据

设备重启后，扫描任务目录，找**有收件箱记录、没有回执**的 run。路径后缀由 0 节的前置修复
确定：`<runID>.inbox.json` 存在而 `<runID>.receipt.json` 不存在。

### 3.2 上报时机与状态

**必须在 WS 连上之后**——恢复依赖既有的 `task_result` 通道，而通道在 `connect()` 内才有
`write`。落点：`connect()` 内、首次快照写出之后，顺序执行一次恢复扫描。

- **状态取 `FAILED`**，理由：设备重启中断了这次执行，且**本机已经不知道它跑到哪一步**；
  报 `CANCELLED` 会与 B1 的语义混淆（那是控制面主动取消），报 `COMPLETED` 是撒谎。
  这一条沿用 2026-09-17 spec §「不在范围内」已经写下的口径（「把没有回执的 run 报成 FAILED」）。
- **summary 必须写明是重启中断**，而不是 runner 失败——两者的处置不同：runner 失败要查任务
  本身，重启中断要查设备稳定性。
- **扫描失败不影响连接**：读目录出错只记日志，不能让设备因此连不上控制面（那会把一个
  局部问题放大成全设备离线）。

---

## 4. 测试计划（按「真库跑绿」标准）

| 层 | 内容 |
|---|---|
| 设备单测 | ① `cancel_task` 命中在途 → ctx 被取消、回执为 `CANCELLED`、槽位释放；② 未命中 → `cancelled:false` 且不产生回执；③ 恢复扫描：有 inbox 无 receipt 的 run 被上报为 FAILED；④ 已有 receipt 的 run **不**被重复上报 |
| 设备单测 | ⑤ 前置修复的顺序用例（已加）继续作为回归 |
| governance 活库 | ⑥ CANCELLING 的调度任务 → 产生 `cancel_task` 行；⑦ 已完成的 run **不**产生；⑧ `cancel_task` 不受 16 条在途上限阻挡 |
| 端到端 | ⑨ 真进程 + 真 PG：设备接受任务 → 控制面取消 → 设备报 CANCELLED → 任务终态 |

**一处刻意写明的测试盲区**：取消桥的「一个 run 只有一条活跃 cancel」由两层保证——查询里的
`NOT EXISTS`（顺序调用方）与部分唯一索引 + `ON CONFLICT DO NOTHING`（并发调用方）。集成本套件
**只驱动单个派发者**，所以把索引删掉测试仍全绿（实测变异验证过）。索引保留的理由是「不该假设
永远只有一个进程」，而不是「它被测到了」。**这个区别必须写在注释里**——把没被测到的保证说成
被测到了，正是下一个人删掉它的方式。

## 5. 不做什么

- 不定义 runner 的取消帧（见 2.1）。
- 不改 `completed` 的语义（仍读作「已接受」）。
- 不动 `execute_task` 之外的 action。
- 不做「取消一个尚未下发到设备的任务」的控制面侧优化——那是 scheduler 自己的状态机，
  governance 只管设备承载的那一段。

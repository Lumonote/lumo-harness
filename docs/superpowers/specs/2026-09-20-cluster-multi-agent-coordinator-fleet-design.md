# 集群模式多智能体协同设计说明 —— 协调者 · 线程舰队（§24）

- 日期：2026-09-20
- 前置：`architecture.md` §4.2（复制式 SessionEvent 日志）/ §5（数据层）/ §6.4（计量与预算树）/
  §7.1（Worker 模型、句柄型 seam 不可跨节点）/ §7.3（协同拓扑）/ §7.4（多集群调度）/
  §8.1（异步协同 suspend/resume/future/trigger）/ §8.4（共享执行控制）/ §10（连接器 + RBAC）/
  §11.1（项目 = 协作工作区）/ §18（安全模型）/ §22.3（schema 演进规范）；
  **§23 业务控制面**（`2026-08-29-task-control-and-dispatch-design.md`：统一 Worker、φ 三档、
  任务/Run 拆分、评审闸门、证据链汇报）；
  已在产事实：`dsh-plugins/agent-teams`（`ctx.agentTeams`：roster + 任务板 + 会合面）、
  `dsh-plugins/control`（`ctx.sessionControl`：四挂点状态闸门）、`dsh-plugins/mailbox`（PG 会合面）、
  `dsh-plugins/subagent-host` / `subagent-remote`（跨节点委派 wire）、`dsh-plugins/session-log`
  （append-only 复制日志 + `queryWithStaleness`）、`control-plane/{scheduler,governance,session-control,collaborator}`
- 外部输入：知识库《Claude Code 大重构深度分析——从文件夹到协调者舰队，兼论运行时替换与自我测量》
  （下称**文章**）
- 状态：设计定稿；实现按 §13 的 P6a–P6f 切片推进，各片独立可验收

---

## 0. 定位：这一层补的是什么

Lumo 已经能**把活派出去**（§23 统一 Worker + 五维派单 + 任务/Run + 证据链汇报），也能
**把执行停下来**（§8.4 控制指令 + `control` 插件四挂点）。缺的是中间那一层：

> **一次目标，怎样变成一组互不踩踏、能各自续跑、有人验收、且成本可解释的并行线程？**

今天能造出来的是**一次性成员**：`agent-teams` 的成员是 one-shot 可重复派发
（`src/index.ts:11-20` 给了完整理由——集群 wire 只覆盖 one-shot spawn，一次性建模才让
一份代码同时成立在 local/standalone/cluster 三形态）。这个取舍当时是对的，但它使
「改代码 → 跑测试 → 修 CI → 再跑」这种多轮工作无处安放，也让并行度只能换到
**token 上的 N 份钱**——因为每个成员都从头重建上下文。

文章的价值不在它给出的产品形态（那是 Anthropic 的客户端），而在它对**并行舰队成立条件**的
拆解：三个执行模型（Fork / Teammate / Worktree）、共享记忆承载的是**决策而非事实**、
审批经济学的算术、以及两条最容易被忽略的结构性代价——**局部正确性不保证组合正确性**与
**同源审查无法发现同源盲区**。本篇把那套拆解收敛成 Lumo 编号体系下的 **§24 集群模式多智能体协同**。

三条设计立场，先于一切细节：

1. **不重建执行面，只补编排语义。** 线程的续跑就是 §7.1 的跨节点 resume，唤醒就是 §8.1 的
   mailbox，闸门就是 §8.4 的状态表，配额就是 §6.4 的预算树。本层新增的是**角色、记忆、
   闸门档位与看板分格**，不是执行机制。
2. **第一铁律不动摇。** 全部新增落在 `control-plane/*` 独立 Go 服务、`shared/seam-contracts`
   与 `dsh-plugins/*`（Cordis plugin，只 import dsh 公开 API）；不改 `deepseek-harness/` 一行。
3. **诚实优于完整。** 依赖上游供应商的行为（前缀缓存）不写成保证，写成可证伪的判据；
   做不到的事进 §15「不做的事」。

---

## 1. 选型映射（本节优先级最高，先读再读别的）

文章的多数定量结论是**客户端产品**结论，直接引用会重演 15 篇 addendum 因口径冲突被删的事故。
融入时文章只作**能力清单**引用，选型一律以 `architecture.md` §13 为准：

| 领域 | 文章做法（**不采纳**） | Lumo 已定案 | 依据 |
|---|---|---|---|
| 线程运行位置 | 云沙盒；「不久支持本机」 | **承载节点即执行平面**（§7.4 放置），无云沙盒概念 | §7.1 / §7.4 |
| Fork 的载体 | `AgentInput.isolation: "worktree" \| "remote"` | `subagent-host` wire + 承载节点工作目录 | §7.1 |
| 共享记忆载体 | 文件 + `MEMORY.md` 索引 + `Projects` 工具面 | **PG（项目作用域，append-only）**，不用文件 | §5 |
| 编排脚本 | `Workflow` DSL（`agent()/parallel()/pipeline()/phase()`） | **FlowEngine DAG**（§9.2）+ 五类制品分发（§10.3） | §9.2 |
| 定时任务默认值 | Cron 7 天自动过期、`durable=false` | TriggerBus 定义（按 §9.2） | §9.2 |
| 配额 | 200 新线程/天/账户（厂商配额） | **预算树**（§6.4）+ scheduler 并发闸 | §6.4 |
| 分发与运行时 | Bun/Rust 原生二进制、零依赖 | 无关（那是 CLI 客户端分发问题） | — |
| 权限失效场景 | 多仓库项目里 permission rules 静默失效 | Lumo 权限在**服务端**判定（OPA + RBAC），不依赖客户端配置 | §6.3 / §18 |

> **执行纪律**：本篇及后续实现中，`Bun` / `claude.exe` / `Projects` / `200 线程/天` /
> `.claude/workflows/` / `auto mode` 只允许出现在「未采纳备选」语境。任何把它们写成
> 现行口径的文本都是缺陷。

**编号归位**：文章用「重构线 ①–④」，本篇用 §24.1–§24.9。文章章节到本篇的映射：
其 §2.2/§3.3→§24.1，其 §3.1/§3.5（Fork）→§24.3.1，其 §2.6/§3.5（Worktree）→§24.3.2，
其 §2.3/§3.2/§12.5→§24.4，其 §6→§24.5，其 §2.4/§11.4→§24.6，其 §12.4→§24.7，
其 §9.2/§12.2→§24.8，其 §12.1/§2.7→§24.9。文章的第二、三、五、八节（运行时替换、
Bun 移植、自我测量、时间线）**显式不在本篇**——它们与平台无关。

---

## 2. §24.1 协调者：从归属字段升为一等角色

### 2.1 现状

`agent-teams` 已有 `TeamState.captainSessionId`（`model.ts:107`）与三种拓扑
`planner-worker | pipeline | deliberation`（`model.ts:46`）。但 captain 只是一个**归属字段**：
它记录了团队挂在哪个会话下，没有定义**协调者的行为边界**。而 §7.3 给 planner 的职责是
「拆 DAG，多 worker claim」——那是**分解者**，不是文章讲的协调者。

文章对协调者的定义是反直觉的，且值得原样保留：**协调器不做大多数决策，它只做路由与验收**；
它**看不到线程的逐步执行，只看得到线程汇报回来的东西**；因此它**永远不会被阻塞**，
响应性是它的第一属性，智能是第二属性（官方把它默认在 low effort，Cursor 的措辞是
"because it delegates rather than executes, it is never blocked"）。

### 2.2 三条语义（本设计的硬约束）

| | 语义 | 落地 | 今天会犯的反例 |
|---|---|---|---|
| **S1** | **只收汇报，不看步骤** | 协调者上下文只装配 `TeamTask.output` 与 §23.4 的 `report.evidence[]`，**不装配成员轨迹** | 把成员 session 全量读进协调者，上下文被工具输出淹没 |
| **S2** | **不执行，故永不被阻塞** | 协调者预设**不授予任何副作用工具**；需要外部动作一律派线程 | 协调者自己调 connector / 自己写文件 |
| **S3** | **低 effort、高响应** | 协调者作为 preset 档位：低 effort、无副作用工具、短上下文预算 | 把最强的模型放在最上层当「指挥官」 |

> **S2 与 §8.4 是同一张表的两个投影。** 协调者会话在 `control` 的状态闸门里天然落在
> 「只读放行」档：副作用工具前缀（`control/src/release.ts` 的
> `bash / pwsh / write / edit / connector_ / knowledge_publish`）对协调者一律拒绝。
> 不新增机制，只新增**档案**。

> **S2 的准确表述是「协调者不是成员」，不是「协调者什么都不能做」。** 实现时才看清这一点：
> `cancelTask` 的注释写着「**船长或指派者**」——取消任务本来就是协调者的合法动作。
> S2 锁的是「不得持有成员身份、不得占据任务」，协调者级操作照常。

> **✅ 缺口已闭合（2026-09-20）。** 实现时发现插件层原本**没有** S2 的结构性保证：
> 成员身份只是一个**名字**，与 `captainSessionId` 无绑定，于是「船长把自己的会话 id
> 注册成成员名，再 `claimTask`」是通的。
>
> 落法是**两点一判据**（`isCoordinatorName`）：
> - `addMember` 挡住「先把协调者变成成员」——这是上面那一步绕行；
> - `memberByName` 挡住「以协调者身份行事」——它是认领、改派、指派、派发的共同收口点。
>
> 于是 `startTask` / `completeTask` / `failTask` **不需要第三人**：它们的判据是
> `task.assignee === memberName`，而 `assignee` 只能由 `addTask` / `claimTask` /
> `reassignTask` 三条路径设置，三条都过 `memberByName`。这条**是推断不是假设**——
> `agent-teams/__tests__/coordinator.spec.ts` 逐条钉住，第四条设置 `assignee` 的路一出现就会红。
>
> 错误码刻意新增了一个：`COORDINATOR_IS_NOT_A_MEMBER` 与 `NOT_FOUND` 分开。
> 「查不到」与「查得到也不许」在聚合时意义完全不同——混成一个码，越权尝试会被淹没在
> 一堆名字拼写错误里，而它恰恰是最该被看见的那一类。

### 2.3 「绝不把理解转手给别人」的工程化

文章引用的那条提示词指令（"Never hand off understanding to another worker"）的工程含义是：
**协调者必须自己持有验收判据**，而不是把判断权下放后又不掌握细节。否则它会退化成
文章说的 "rubber-stamp weak work"。

落点（复用 §23.4，不新增机制）：

1. `TeamTask` 增 **`acceptance`** 字段——派发时由协调者写死的验收条件，**成员可见**；
2. 验收只吃 §23.4 的六段式 `report`，**没有 `evidence[]` 的段一律 `verified=false`**，
   且按 §23.4 硬规矩 2「无证据的结论强制标注未验证且不进周报」；
3. 协调者**不接受自己派发的 Run 的验收结论**——见 §24.8 异构审查者。

> 这是把一句提示词纪律换成一条**可测的判据**：构造一个无 `evidence` 的报告，
> 协调者必须拒收（§14 验收判据 4）。

---

## 3. §24.2 两档成员：Worker（既有）与 Thread（新增）

文章最重要的一条工程事实是：**只有「线程 = 完整会话」，权限模型、hooks、既有工作流才能
原封不动地复用**；而它为此付出的代价是「每个线程都是完整会话，所以项目比单会话更快触达
用量上限」——这是**刻意的语义选择**，不是实现偷懒。

Lumo 不需要推翻既有 one-shot 成员（它的三形态一致性是真收益），而是**加一档**：

| 档 | 名字 | 执行面 | 生命周期 | 用在哪 |
|---|---|---|---|---|
| 短 | **Worker**（既有，不改） | one-shot spawn / `lumo-remote` | 单次 attempt，跑完即返还 | 正交、可一次说完的子任务 |
| 长 | **Thread**（新增） | 承载节点上的**稳定会话** | 跨 Run，可被事件唤醒 | 改代码 → 跑测试 → 修 CI → 再跑 |

### 3.1 Thread 的续跑复用既有三件套，不引入 continuable 句柄

**不引入 continuable**——`agent-teams/src/index.ts:11-12` 已记录理由（集群 wire 只覆盖
one-shot；且两个现成实现都绑 continuable + session log projection，平台未挂载）。
Thread 的三件事各有既有落点：

| 需求 | 落点 | 依据 |
|---|---|---|
| 续跑状态 | `session-log` append-only 复制日志 | §4.2 |
| 唤醒 | `mailbox`（future/promise）+ TriggerBus | §8.1 |
| 配额 | 预算树（新 Run/天，见 §24.9） | §6.4 |

于是 **Thread ≜ (稳定 `sessionRef`, 承载节点, 事件订阅集合)**——没有任何新执行机制。

> **与 §7.1 的张力必须显式登记。** §7.1 已判定「句柄型 seam 的会话不可跨节点恢复」：
> `ctx.terminals` / `ctx.subprocess` / `ctx.jobs` / 本地 `ctx.fs` 交出的是有生命周期的 OS 引用，
> 钉在节点上、不住在日志里。一个正在改文件的 Thread 正是这种会话。因此：
> **Thread 亲和到承载节点；节点丢失 = Thread 终止、标记 `failed` 并重派新 Run，绝不假装可迁移。**
> 模型可见状态仍可重建到最近检查点，工作目录（§24.3.2）不迁移。

### 3.2 Thread 与 §23.3 任务态机的关系

Thread **不新增业务态**。§23.3 的业务态机
（`DRAFT → ROUTING → ASSIGNED → EXECUTING → VERIFYING → IN_REVIEW → DONE | REJECTED | ARCHIVED`）
与执行态（Run 的 7 值闭集，一字不改）正交，已经能表达「一个任务下多次尝试」：

- 一次 **Run** = Thread 的一个**轮次**；
- 多轮 Thread 的每一轮都是新 Run，`(task_id, attempt)` 唯一约束照旧；
- `IN_REVIEW` 打回时业务态回 `ROUTING` 并创建带反馈的新 Run——**§23.3 已定义这条回退**，
  Thread 只是让「新 Run 能接着上一轮的现场继续」而不是从零重来。

### 3.3 实现时补齐的四条口径（2026-09-20）

初版 §24.2 在这四处**没有给出可判定的定义**，实现方只能自行选择。以下是追认的口径——
它们不是新决策，是把已经做出的合理选择写下来，免得下一个人重新猜一遍。

**（1）「事件订阅集合」不进注册表。** §24.2.1 把 Thread 定义为
`(稳定 sessionRef, 承载节点, 事件订阅集合)`，但 §11 的表里没有这一列，**这是对的**：
订阅就是 mailbox 的等待项（id 由线程 id + 轮次派生，**强制带 TTL**，§8.1 既有纪律），
它是**等待中的动作**而不是线程的属性。代价要说清楚：**订阅集合不可从注册表枚举**，
要看只能问 mailbox（死信查询是最近的口子）。若将来看板需要「这条线程在等什么」，
那要走 mailbox 的查询面，不是往 `threads` 加一列。

**（2）`workspace` 是相对节点工作区根的路径，绝对路径一律拒。**
§24.3.2 只说了 `thread/{threadId}/`，没说相对谁。定成相对路径的理由与 §24.2.1 的
「不假装可迁移」同源：**绝对路径是节点局部事实**，把它写进一行会被别的节点读到的记录里，
就是「假装可迁移」的另一种形态。

**（3）两种多轮续跑**形态不同，但**不新增状态**——改为**记谱系**。
同一节点上的「接着上一轮现场」与节点丢失后的「新建 Thread 重来」成本与风险完全不同
（后者现场为空），而状态集里只有 `failed` 能区分它们。**当前看板只能从 `failed` 推。**

**决策（2026-09-20）：加一列 `threads.replaces`（nullable，指向被它取代的失败前身），
用它把「这是第 N 次重来」变成记录下来的事实，而不是从 `failed` 推出来的猜测。**

- **为什么不加状态**：状态集描述的是「这条 Thread 此刻怎么样」，而「它是第几次重来」是
  **谱系**，两件事正交。塞进状态集会立刻产生 `failed-restart`、`failed-initial` 这类组合爆炸，
  且每加一种失败形态就要加一个状态。
- **为什么与决策记忆用同一个形状**：`project_decisions.supersedes` 已经解决了同一类问题
  （新条目指向被取代的旧条目）。**同一件事用同一种形状**，读的人不必学第二套。
- **为什么值得加**：§24.9 的成本结构里，重来一次是**真金白银的重复工作**——
  「这个任务重来了几次」必须是算得出来的数，否则成本异常没有第一现场。
- **实现归属**：`control-plane/collaborator`（`threads` 的唯一建表方，
  `ADD COLUMN IF NOT EXISTS` + `init()` 幂等，遵 §22.3）。**尚未实现**，登记在 §14.5。

> **⚠️ 实现期发现的来源订正（2026-09-20）。** 下面写的「心跳上报」在实现时被落成了
> `heatbeat` 包读 `lumo_service_heartbeats` 里 `service='dsh-node'` 的行。**那张表承载节点
> 按设计就不写**——三条证据：
>
> 1. `heartbeat/heartbeat.go` 与 `scheduler/internal/store/store.go:129` 都写明
>    `lumo_service_heartbeats` 的语义是「**控制面服务实例**存活」，governance 用它求值就绪门禁；
>    后者还明写它与 `scheduler_clusters` **刻意分开**——「把『集群』塞进去等于让一个字段承担
>    两个语义，**正是 E4/D6 刚花一轮拆开的东西**」。
> 2. `dsh-node/src/index.ts` 的承载节点报的是**两件别的事**：Nacos 注册
>    （`serviceName: 'lumo-dsh-node'`，含 `nodeId`）与集群存活自报。都不写这张表。
> 3. 全局检索：承载节点的 `last_seen` 在 PG 里**不存在**——`last_seen` 只属于
>    `scheduler_clusters` 与控制面服务心跳表；`scheduler_nodes` 只有 `registered_at`，
>    且注册是 upsert，**不刷新**。
>
> **正确来源是 Nacos**：节点在那儿注册并心跳，`threads.node_id` 与 Nacos 实例元数据里的
> `nodeId` 是同一个标识（`dsh-node` 注册时显式带它），所以 join 键现成。
> **按实现期描述的那样让节点去写 `lumo_service_heartbeats` 是错的**——那会把 E4/D6 刚拆开的
> 两个语义重新合回去。
>
> **为什么这次没顺手改掉**：本机没有 Nacos 可跑，改了就**无法验证**。在一个「判定节点死亡、
> 误判会终止全集群线程」的组件里放一段未经真实 Nacos 验证的集成代码，产出的正是那种
> 「看起来做完了」的东西——而这恰是本仓库活库验收纪律要防的形状。**留待能验证它的人做。**
>
> **改造不是「只换实现」**：`heartbeat.Reader` 是 pgx 形状的
> （`Query(ctx, sql, args...) (pgx.Rows, error)` + 固定的 `SelectSQL`），不是「给我存活行」
> 的抽象缝，所以要**新抽一层 `LivenessSource`**，再把 `ReadAll` 作为其中一个实现。

**（4）节点失联的「重派新 Run」由协调者触发（2026-09-20 拍板）。**
判据已给（`failed` + `reassign_run: true`），触发者定为**协调者**——与 §24.1 的职责
一致：协调者做路由与验收，重派正是路由。信号链是：
**心跳/承载节点上报 → collaborator 标记 `failed` → mailbox 通知协调者 → 协调者决定重派**。
collaborator 本身**不探测节点存活、只接受显式上报**（上报方必须引对 `node_id`，引错即拒），
所以「谁上报」是心跳侧的事，而「重不重派」是协调者的判断——**两件事分开**，
这正是把「不可恢复」与「可重试」区分开的既有纪律（§7.1 R2）。
**当前这个信号链未实现**：collaborator 只到「标记 `failed`」为止，通知与重派两端都空着。
因此 §14 判据 9 描述的是**判据层的行为**，不是当前端到端的实际行为。

> **关于落点**：§13 把 P6e 落在 `control-plane/collaborator`，但 §24 正文从未论证
> 「`threads` 该由哪个控制面服务持有」。collaborator 是 CRDT 协作服务，承接 Thread
> 注册表并非它的天然职责。当前选择的理由只有两条：**一张表只能有一个写入方**，
> 且本切片只开放了这一个服务。**若将来为别的理由拆分控制面，这张表应一并重估归属。**

---

## 4. §24.3 隔离原语：Fork 与工作目录

文章列了三种内部执行模型，Lumo 的对应关系是：

| 文章模型 | 语义 | Lumo 现状 |
|---|---|---|
| **Teammate** | 独立上下文 + 代理间直连消息 | **已有**：`mailbox`（PG，跨节点跨时间）+ `agent-teams` roster |
| **Fork** | 共享父级缓存，token 最省 | **缺**。`subagent-host.ts:28` 明示「范围外（契约为其留位）：fork/continuable 的 seed 传输」 |
| **Worktree** | 完全隔离的文件系统 | **缺**。`ChildParentDescriptor.cwd` 是「父会话 header 的 cwd」——**子代理直接继承父的 cwd** |

### 4.1 Fork-Join：先把上游的 fork 到底是什么说清楚

> **本节在 2026-09-20 依据上游源码与官方文档重写过一次。** 初版把 fork 写成「只复用系统前缀、
> 对话历史不复用」——**那是错的**，会让 P6f 建在一个不存在的能力上。上游的实际语义见下。

文章引用的 Fork-Join 模式（Bilgin Ibryam 模式 8）说「父 Agent 的缓存被每个 fork 重用，
使并行分支的 token 成本基本免费」。**这个能力在 Lumo 依赖的 dsh 里已经有实现**，不必新建：
`@deepseek-ai/dsh-subagent-fork-in-process`，provider 名 `fork`，`agent-teams` 的
`MEMBER_PROVIDER_PREFERENCE` 已经把它列为候选（`roster.ts:49`）。

**上游语义（逐条照抄官方文档与源码，不是我的推论）：**

| 事实 | 出处 |
|---|---|
| 子 agent 的初始内容 = **父级已完成的对话轮次**（fork 时刻的一次性快照） | `subagent-fork-in-process/README.zh.md` |
| 进行中的那一轮**绝不包含**；第一个已完成轮次之前，初始内容为空 → 行为等同 spawn | 同上 |
| 此后父级记录的任何内容**都不会**到达子 agent（不是活连接） | 同上 |
| 子 agent 获得**全新的工具作用域**，不继承父级的工具 | 同上 |
| 但会继承两类策略事实：`permissionPreset`（仅 auto / danger-full-access）与父会话显式的 `sandboxMode`；**`approvalPolicy` 一律钉死 `'never'`**（子代理的审批请求被确定性拒绝） | `subagent/src/child-agent.ts:222-252` |

**因此必须把两个杠杆拆开——初版把它们混成了一个：**

| 杠杆 | 机制 | 用在哪 |
|---|---|---|
| **A. 上下文延续** | 用 `fork`：子代理从父级已完成历史接着干，**不必重新粘贴上下文** | 子任务**延续**父对话（审查、续写、接着分析） |
| **B. fan-out 的缓存复用** | 兄弟请求共享**逐字节相同的请求前缀**（同一 system prompt + 同一工具集 + 同一 seed）→ 命中 provider 侧前缀缓存 | 正交并行分叉 |

**两个杠杆都能降成本，但它们不是同一件事，用途也不同：**
杠杆 A 的代价是**子代理拿到了父的对话历史**——这与 §7.3 的上下文隔离（模式 7：
「独立上下文、只回传输出」）**是矛盾的**。所以：**正交并行的子任务用 `spawn`，
延续性的子任务用 `fork`**，不可混用。`agent-teams` 今天把 `fork` 排在优先级最后、
且集群形态下 `lumo-remote` 必胜，对**正交**工作而言是**正确的默认**——真正的缺口是
**没有按任务选择 provider 的能力**，而不是「fork 没被用上」。

### 4.2 R1b 的结论：**已证伪**（2026-09-20 实测上游源码）

初稿假设：seed 是「父级已完成的日志前缀」，而日志本身是复制日志，所以承载节点可以只收
`(parentSessionRef, upToSeq)` 引用再自行读同一份事实。**这个假设不成立。**

证据是上游 `subagent-fork-in-process/src/index.ts:48-55,77`：

```ts
function completedTurnPrefix(parent: Agent): SessionEvent[] {
  const events = parent.session.snapshotEvents()   // ← 要的是活的 Agent 对象
  ...
}
start(request) { const seed = completedTurnPrefix(request.parent) }   // ← request.parent: Agent
```

`fork` 要的是 **`request.parent: Agent`**——一个活的进程内对象，承载节点上没有它。
这不是新发现：`shared/seam-contracts/subagent-host.ts` 的 `ChildParentDescriptor` 注释
早就写过同一件事（「dsh 的 `SubagentProvider.start` 收的是 `parent: Agent`：活的进程内
对象，跨节点不可序列化，承载节点上根本没有它」）。**初稿是在已经写着答案的地方又猜了一次。**

**进一步追查（2026-09-20）把结论推得更死：跨节点 fork 不是「另一件工程」，是被架构排除的。**

我原本的退路是「自写 provider，从复制日志读前缀，再经 `startInProcessRun` 起子代理」。
这条路也不成立——`startInProcessRun` 对 `parent` 的依赖**不止 seed**（`subagent-in-process-driver/src/index.ts:107-140`）：

```ts
const parent = request.parent
const childDepth = resolveChildDepth(parent, request.maxDepth)
const inherited = captureDelegatedPolicyOverrides(parent)      // 读 parent.ctx 的 permissionPresets / sandboxPolicy
applyChildComposition(childCtx, parent, { persona, toolFilter }) // 子代理的人格与工具集来自父
await parent.ctx.agents.create({ parentAgent: parent, ... })   // ← 必须有活的 parent
```

**`parent: Agent` 是必需入参，`seed` 只是可选的附加输入。** 于是承载节点上要有**父会话的活体**，
而那正是 §7.1（评审 R2）判定「句柄型 seam 的会话不可跨节点恢复」要排除的东西。
硬要做只能在承载节点重建父会话——**同一份会话日志出现两个写者**，
这比「不可恢复」危险得多：两个写者会各自 append，日志的 seq 契约当场破裂。

> **结论：集群形态下不做 fork，且这不是待办事项，是设计边界。**
> 若将来真要集群续跑，正确的问题是「怎样让**子会话**从复制日志的某个前缀起步」，
> 而不是「怎样把 fork 搬过网」——前者不需要父会话的活体，是另一条完全不同的路。
> **登记在这里，避免下一个人重新走一遍我这两步。**

### 4.3 P6f 实际交付：逐次派发的 provider 选择

按 §24.3.1 的约定，R1b 证伪即 **P6f 降级**。剩下能诚实交付的是「能选的时候选对」：

- `TeamTask.continuesContext?: boolean`（缺省 = 正交），协调者经
  `agent_teams_create_task` 声明，成员可见性经 `buildMemberPrompt` 无关——它是**执行面**属性；
- `roster.ts` 的 `selectDispatchProvider` 在**每次派发**决定 provider（而不是装配期一次性决定）；
- 三条守卫，**顺序即优先级**：

| # | 守卫 | 为什么 |
|---|---|---|
| 1 | `base` 非进程内 → **原样返回** | 最重要的一条。集群里 `base` 是 `lumo-remote`，换成进程内的 `fork` 会让成员从承载节点**悄悄退回父进程**执行：负载全压一个节点且**不报错**。**换 provider 绝不能改变执行位置。** |
| 2 | 非延续性任务 → 原样返回 | 正交并行要的就是上下文隔离，给它父级历史是反向的 |
| 3 | `fork` 不可用 → 原样回落并说明 | **不抛**：延续性是**优化**（少粘贴一次上下文），不是正确性要求；为它让派发失败是把优化做成单点 |

**未被本切片覆盖**（如实登记）：正交并行时「保证兄弟请求前缀逐字节相同」的配置纪律
没有做成强制检查——它有收益但无法在本仓库验证（依赖上游供应商的前缀缓存行为，见 R1a）。

**判据（可证伪，不是「感觉更快了」）**：

1. 同批 N 条线程的**缓存命中率显著高于** N 条独立会话（同任务、同 preset）；
2. 同 seed 同任务下，Fork 路径与非 Fork 路径的**输出一致性**在容差内——即复用前缀
   **不改变行为**，只改变成本；
3. 前缀不一致时（例如成员被注入了不同工具集）**必须显式放弃复用**并记录原因，
   不得为了命中率而改写任务内容。

> **诚实标注（这是本设计唯一一处依赖上游供应商的地方）。** 文章说「成本接近零」，
> 那是 Anthropic 服务端的事实。Lumo 经 `llm-gateway` 转发（§12），是否命中前缀缓存
> **取决于上游供应商是否提供该能力**。因此判据写成「命中率提升」而不是「接近零」，
> 且该优化**失败无害**：供应商不支持时只是没有收益，不影响正确性——因此**不设 fail-closed**，
> 与 §18 的分级一致。

### 4.2 工作目录隔离（**有意偏离文章**）

文章用 `git worktree` / 独立仓库副本，冲突走普通 PR 流程，并明确承认：
**「并发冲突没有被消除，只是被推迟到了既有的、人类已经熟悉的那个界面上」**。

Lumo 没有那个界面——交付单元是**项目**（§11.1 项目 = 协作工作区）而不是仓库。因此本设计
**不引入 worktree / PR 抽象**，改用：

1. Thread 在其承载节点上占有一个**独立工作目录**（`thread/{threadId}/`，由 Provisioner 按
   制品 digest 物化，与 §10.3 的制品分发同源）；
2. 该目录**不进复制日志**——目录不是模型可见状态，与 §7.1 判定的句柄型 seam 同训；
3. **收敛路径是产出物（artifact）不是合并**：Thread 的交付物进对象存储
   （§5 的 MinIO，内容寻址 sha256），由协调者/项目 owner 做合并裁决。

> **偏离登记（必须留痕）**：文章把冲突处理定义为「普通 PR 流程的 merge conflict」，
> 好处是不需要新工具链。Lumo 放弃这一点，代价是**并发冲突的裁决界面需要新造**，
> 收益是不把平台绑到 git 上（Lumo 的交付物可以是知识库、流程、连接器配置，不都是代码）。
> 这是有意承担的偏离，不是遗漏。

---

## 5. §24.4 项目决策记忆（共享记忆的正确形态）

### 5.1 现状与判据

**Lumo 完全没有这类机制。** `dsh-plugins/knowledge` 是**文档 RAG**（Nebula 图 + Milvus 向量，
`ctx.knowledge.graph` / `ctx.knowledge.vector`），回答的是「哪份文档里有这个」，
不是「这个决定是什么、为什么」。

文章把共享记忆的判据给得很准：它举的例子（**发布日期改到周五、为什么砍掉导出功能、
动账单服务之前要先联系谁**）有一个共同特征——**它们是决策，不是事实；它们无法从代码里读出来**。
所以共享记忆承载的不是知识，而是**决策的考古层**。

### 5.2 设计

1. **作用域挂项目，不挂 realm。** 决策记忆属于 §11.1 的项目工作区，避免跨项目污染；
   Provider 层强制 realm 过滤（沿用 §5.4 的既有义务）。
2. **分层：常驻索引 + 按需主题条目。** 索引逐条一行、有行数上限；命中后按需读全文。
   文章给的理由是工程性的：**膨胀的索引会同时损害命中率和上下文预算**。
3. **载体不是文件。** 文章用 `MEMORY.md` + 主题文件，因为它跑在客户端沙盒里；
   Lumo 落 PG（append-only），与 `session-log` / 台账同一条纪律。
4. **多写者冲突：append-only + 显式覆盖，不原地改。** 文章承认这是**未解问题**
   （§12.5：N 条线程同时写，「改到周五」与「改到下周三」可能同时存在）。Lumo 的答案
   不是新造并发控制，而是复用既有纪律：新决策**追加**，被判定的旧条目标记 `superseded`
   并指向新条目；**冲突由协调者在验收时裁决，不由系统自动裁决**。
5. **腐化治理。** 文章的 `autoDream` 是其对「记忆会退化」的承认。Lumo 落成**离线固化任务**
   （TriggerBus 定时触发，§9.2）：做**去重、剪枝、矛盾标注**，**只标注不裁决**——
   自动裁决矛盾记忆等于让机器替人做事实判断，与 §18 的信任边界冲突。

   **三个操作的确切语义（本节补写于 2026-09-20：初版只列了三个词、没定义，实现方不得不
   自行解释——这是设计的缺陷，不是实现的问题）：**

   | 操作 | 语义 | 判据类型 | 会不会改数据 |
   |---|---|---|---|
   | **去重** | 规范化后**全等**的有效决策 → 报为重复候选 | 确定性 | **否** |
   | **剪枝** | 超出索引上限的行，**最旧优先**列为候选 | 确定性 | **否** |
   | **矛盾标注** | 同话题的两种说法 → 报候选取代对 | 启发式 | **否** |

   **三条必须一起读的约束**：

   - **固化任务绝不删除、绝不取代、绝不裁决。** 它只产出**候选报告**；真正的取代由人在
     验收时执行（即第 4 条的 supersede 关系由人建立，不由任务建立）。判据：连跑两次
     固化任务后，`project_decisions` 的行数与内容**逐字节不变**。
   - **「剪枝」是「报候选」而不是「删」。** 字面上「剪枝」容易被读成删除——这里明确取
     「指出哪些行该走」的含义。理由与 append-only 同源：**决策的考古层一旦删除就不可恢复**，
     而它存在的意义正是「别人后来会需要知道当时为什么这么定」。
   - **矛盾标注是启发式的，必须按启发式对待。** 它能抓「同话题两种说法」，**抓不到
     「用完全不同的词说反话」**。因此报告必须自带 `policy: "flag-only"`，且**没有任何
     「谁赢」字段**——有那个字段，就迟早会有人拿它当裁决结果用。

### 5.3 三种记忆的作用域必须分清（照文章 §2.3 的两套 `MEMORY.md` 教训）

| 记忆 | 内容 | 载体 | 随什么走 |
|---|---|---|---|
| **指令性** | agent preset、项目引用的组件/技能/连接器 | §10.3 制品 + 项目引用 | 制品版本（可 review、可回滚） |
| **决策性** | 为什么这么定、谁负责、边界在哪 | 本节的 `project_decisions` | 项目 |
| **事实性** | 文档、知识库内容 | §5.4 知识空间 | 知识空间 |

放错位置的后果与文章一致：要么团队看不到，要么版本里混入临时笔记。

---

## 6. §24.5 动作放行三档：审批经济学

### 6.1 现状与算术

`control` 的 `awaiting-approval` 是**人工专属**：任何进入该态的会话都等人，没有替代路径
（`gate.ts:45-51` 的状态表；`policy.ts:27-36` 的角色授权表里 `approve` / `reject` 只给
`approver` 与 `admin`）。

文章用五个数字论证了为什么必须改：**人工审批作为安全机制已经在实践中失效**——
97% 的权限提示被批准（审批退化为反射性点击）、拒绝单个工具执行请求只有 3%、
拒绝高层项目计划却有 39%（人对「动作」几乎不判断，对「方案」才认真判断）、
近半数用户自设宽泛 Bash 放行规则、25% 的交互会话以绕过权限模式启动。

> 这五个数字是**厂商自报、未独立复现**（文章 §15 明确标注）。但即使打对折，
> 「97% 批准率」这一条的结论方向也不变：**逐次审批换来的安全性在数量级上是幻觉**。
> Lumo 采纳的是这个**方向**，不是那些数字。

### 6.2 三档闭集

§23.2 已经把**派单**做成了 `AUTO / SUGGESTED / MANUAL` 三档（φ≥90 / 70≤φ<90 / φ<70）。
本设计把同一思路扩展到**动作放行**——同一个 `confidence_band` 概念，不同的判据来源：

| 档 | 判据 | 行为 |
|---|---|---|
| `AUTO` | 只读 + 已授权 seam + 无外部副作用 | 直接放行，事后审计 |
| `REVIEW` | 有副作用但可逆 / 影响面限于本项目 | 进 `awaiting-approval`，**批量验收**（§24.6） |
| `DENY` | 不可逆 / 跨 realm / 触达凭证（§10 Vault）/ 超出生成环境范围 | 直接拒绝 |

### 6.3 分类器只收窄，不放宽（硬约束）

**分类器的定位必须说清楚**，照文章引 Anthropic 自己的限定语：**它减少提示，不保证安全。**

1. **只收窄，不放宽。** 分类器的输出与 OPA 判定**取交集**：OPA 判否即否，分类器只能把
   OPA 放行的动作降档。这与 `OpaControlPolicy` 的既有语义同训——中心策略收窄本地授权
   （`policy.ts:84-105` 的注释已写明这套纪律）。
2. **不可用即 fail-closed 回落到全人工，不回落 `AUTO`。** 与「拿不到判定时绝不放行」
   是同一判据。
3. **兜底防自旋（照抄文章的成熟做法）**：**连续 3 次被拒**、或**单 Run 累计 20 次被拒**
   → 自动回落全人工档。这条必须在设计里，否则分类器误判会变成无限重试。
   （对照 `gate.ts:53-70` 对「词表外状态」fail-closed 的既有理由：未知不构成放行的理由。）

> 分类器的实现形态（OPA 策略 vs 独立 Go 判定 vs 模型判定）**不在本设计拍板**——
> 三档闭集与三条不变量是本设计的内容，判定器是可替换件。见 §16 风险 R2。

### 6.4 与 §8.4 控制指令的关系

`pause / resume / stop / abort / reject / approve / replay / degrade` **一个都不新增**。
本设计只改一件事：**`approve` 可以由分类器行使，且行使记录必须可审计**——
落 `usage_ledger`（`feature=session/control`，§8.4.2 既有义务）+ 审计行（`control` 插件
`pg-control.ts` 的表所有权不变，本插件仍**不写** `session_control_state` / `session_control_audit`）。

---

## 7. §24.6 线程看板：注意力路由

文章里最值钱的一刀是**把 `Ready for review` 与 `Waiting on you` 分成两格**。它给出的理由
不是分类学，而是注意力经济学：**审代码需要进入心流，回答问题只是一次点击**——
把两类打断分开呈现，是用产品设计对抗「注意力税」。

Lumo 已有雏形：`lumo-ui/src/client/cluster-panels.tsx:417` 的汇总结构
`{ total, active, awaiting_review, accepted, needs_attention, unresolved }`。本设计把它升格为
**线程看板的正式分格**：

| 格 | 含义 | 对应业务态（§23.3） | 注意力类型 |
|---|---|---|---|
| **待深度审** | 有产出物待裁决 | `IN_REVIEW` | 心流 |
| **待轻量答** | 只等一个决定 / 一次批准 | `awaiting-approval`（§8.4） | 点击 |
| **执行中** | 无需介入 | `ASSIGNED` / `EXECUTING` / `VERIFYING` | 无 |
| **已停** | 失败 / 取消，等处置 | `FAILED` / `REJECTED` | 分类 |
| **已完成** | 终态 | `DONE` / `ARCHIVED` | 无 |

两条从文章 §11.4 直接继承的可见性要求（**都不缩短实际耗时，只降低感知等待**）：

- **「在跑但没有新消息」必须能被看懂。** 文章原话是官方文档承认这个歧义存在
  （"a thread that shows as running with no new messages is usually still working"）。
  Lumo 落点：看板对**有活跃 Run 但超过 `stalledAfterMs` 无事件**的线程显示为
  「执行中（静默 N 分钟）」，而不是让它看起来卡死。
- **等待有上限。** §8.1 的「每个等待强制带 TTL，没有『永远等下去』这个选项」直接适用；
  TTL 到期进死信并在「已停」格呈现。

> **设计原则**：看板是**投影**，不是状态机（§15 第 14 条「终端只渲染视图，不实现状态机」）。
> 格子由业务态 + 控制态派生，**不新增存储**。

---

## 8. §24.7 组合正确性（文章称这是重构真正的代价）

### 8.1 问题

§23 的评审闸门保证**单个 Run** 的产出被审过。文章的核心警告是更高一层：
**每条线程的局部正确性不保证组合正确性**——各自 CI 全绿，合起来跑不起来；
而且**冲突是滞后的**：线程在自己的分支上跑完测试，合并时才炸。

文章还给出了成本量级：**架构性冲突的修复成本远高于文本冲突**——两条线程分别引入两套
状态管理方案，冲突会以「两个都能跑、但合起来不能跑」的形式出现，
而**这类问题不会被任何自动化工具捕获**。

### 8.2 落点：一个闸门，不新增状态

**不新增业务态。** §23.3 的闭集不动，改为在 `IN_REVIEW → DONE` **这条边上**加一道闸门：

1. 同一目标下**多个 Run 的产出物**在同一个目标态上做一次**集成验证**；
2. 验证内容 = **契约测试**（`shared/seam-contracts` 已是 TS/Go 双实现，天然可做）
   + 集成冒烟；
3. **不通过则整批打回**（业务态回 `ROUTING`，§23.3 已定义这条回退），
   **而不是逐个打回**——逐个打回会让协调者陷入「A 改好、B 又坏」的无限循环。

### 8.3 并行度的真实上限

文章的原话值得直接引用为设计原则：**并行度有一个由「合并难度」决定的上限**。
任务拆得越细、越正交，舰队就越有效；任务是「把整个鉴权模块改成 OAuth2」，几条线程大概率
会在同一批文件上反复相撞。

因此 §24.1 的协调者在派发时必须回答一个问题：**这批子任务是否可正交分解？**
不可正交时**显式降级为单线程顺序执行**，而不是让 N 条线程去撞同一批文件。
这条要写进协调者的预设指令，并作为 §24.2 Thread 与 Worker 的选择判据：

| | **可正交分解** | **强耦合 / 同一批文件** |
|---|---|---|
| **可远程完成**（制品 + 项目引用足够） | ✅ **并行** | ⚠️ **单线程顺序执行** |
| **需要承载节点本地环境** | ✅ 并行（放置到匹配节点） | ⚠️ 单线程顺序执行 |

---

## 9. §24.8 异构审查者

### 9.1 问题

文章的判断是原则性的，不是调参能解决的：**同源审查无法发现同源盲区**。
而 Anthropic 的对抗机制（单会话内的 Verification Agent、多代理的 implementer-reviewer、
项目级的 PR + 人审）**三处都是同源模型做的审查**。

文章另给了一条经验阈值：**编辑 3 个以上文件时自动激活 Verification Agent**——
达到它就认为风险跨过了单点校验的边界。

### 9.2 落点：不新建机制，把既有职责分离扩展到 Run

`control-plane/flows` 的 FlowReview **已经有同型的职责分离**：
「审核人须为具有 `manager` 或 `admin` 角色的**其他**项目成员」——**审核人不得是作者**。
本设计把它从流程扩展到 Run：

1. **Run 的验收者不得是该 Run 的派发者**（协调者不验收自己派的活）；
2. **审查者与被审者必须不同源**——至少满足「不同 agent preset / 不同模型 / 不同承载节点」
   三者之一；
3. **触发阈值**：改动影响面 ≥3 个产出物 / 跨项目引用 / 触达共享契约时，
   **强制**独立审查（照文章的 3 文件阈值，但把单位从「文件」换成 Lumo 的「产出物」）。

> **登记**：这三条是**约束**不是机制——它们不新增服务、不新增表，只新增校验。
> 违反时按 §23.4 的口径处理：结论标 `verified=false`，不进周报。

---

## 10. §24.9 成本结构反转与配额语义

### 10.1 文章的要害

官方文档里有两句话是成本模型的要害：「因为每个线程都是完整的 cloud session，项目消耗额度
明显快于单会话」与「**空闲线程在 CI 失败或有 review 评论时会醒来并继续消耗**」。

第二条尤其值得停一下：传统的用量模型是「你发起了什么 → 你付多少」，新模型里
**存在一批「睡着的」计费实体，它们会被外部事件叫醒**。推论是：

- 成本上界不再是「你今天的操作量」，而是「**你今天触发的所有异步回路**」；
- 直觉性的成本管控（少提问、少开窗口）**不再有效**；
- 唯一有效的控制手段变成：什么时候创建线程、什么时候关线程、为协调者与线程分别选什么档位。

### 10.2 落点

1. **唤醒必须可归因。** `cost_type` 闭集**不扩**（§22.5 不可逆清单只加不删，§23.4 明确
   不扩集）；唤醒产生的成本按既有 `trace` 维度归因到**唤醒事件**，
   使「有多少钱花在等事件上」可查询。
2. **配额语义补一条：`新 Run/天`，并发只是调度参数。**
   文章的事实是「并发数由协调器决定，没有固定上限；硬边界在别处：每天 200 条新线程」。
   在 Lumo 就是：`scheduler` 的并发闸控制**同时**多少，预算树上的
   **每项目每日新 Run 数**才是**配额**。两者是两个不同的旋钮，不能混用。
3. **短生命周期默认值。** 文章的两条默认策略值得继承：定时任务 **7 天自动过期**、
   `durable=false` 默认（会话结束即失效）。Lumo 的 TriggerBus 定义按 §9.2，
   本设计只登记这条**默认偏保守**的取向：**不显式维持的唤醒订阅会自己消失**。
4. **off-peak 空转要能被看见。** §24.6 的「执行中（静默 N 分钟）」同时是成本信号——
   一个静默很久但仍在计费的线程，是成本异常的第一现场。

---

## 11. 数据模型

全部遵 §22.3：加列 nullable + `ADD COLUMN IF NOT EXISTS`、一次一条语句、`init()` 幂等、
索引 `IF NOT EXISTS`、待处理尾用部分索引。

```sql
-- ① 项目决策记忆（§24.4）：append-only，不原地改
CREATE TABLE IF NOT EXISTS project_decisions (
  id            TEXT PRIMARY KEY,
  realm         TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  kind          TEXT NOT NULL,            -- 闭集：decision | boundary | ownership | trap
  summary       TEXT NOT NULL,            -- 索引行（逐条一行，有行数上限）
  body          TEXT NOT NULL,            -- 全文，按需读
  supersedes    TEXT,                     -- 指向被本条目取代的旧条目
  superseded_by TEXT,                     -- 反向指针，由固化任务回填
  evidence      JSONB,                    -- (session_ref, seq)[]，照 §23.4
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_decisions_live
  ON project_decisions (realm, project_id, kind) WHERE superseded_by IS NULL;

-- ② Thread（§24.2）：稳定会话 + 承载节点 + 事件订阅
CREATE TABLE IF NOT EXISTS threads (
  id            TEXT PRIMARY KEY,
  realm         TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  task_id       TEXT NOT NULL,            -- §23.3 的任务
  coordinator_session_ref TEXT NOT NULL,  -- 协调者会话
  session_ref   TEXT NOT NULL,            -- Thread 的稳定会话
  node_id       TEXT NOT NULL,            -- 承载节点（亲和，不迁移）
  workspace     TEXT NOT NULL,            -- 承载节点上的独立工作目录
  -- 状态闭集：idle | running | awaiting | stopped | failed | done
  --   failed 是**必须**的一档，不是可选：§24.2.1 与 §7.1（评审 R2「终止会话并标记 failed」）
  --   都要求承载节点丢失时进入它。
  --   **stopped 与 failed 的处置恰好相反**（这条论证由 P6e 实现方给出，比初版更锐利）：
  --     stopped = 有人主动停下，**现场还在**（工作目录与会话日志都在承载节点上），处置是等人/等指令；
  --     failed  = **现场已经没了**，工作目录不迁移，必须重派新 Run。
  --   混成一个值，协调者就失去了「要不要重派」的输入，而这正是本切片要防的那类静默错误。
  --   （初版本行漏写 failed，与 §24.2.1/§14 判据 9 自相矛盾；2026-09-20 实现时发现，已补。）
  state         TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS threads_session ON threads (realm, session_ref);

-- ③ 动作放行记录（§24.5）：三档 + 兜底计数
CREATE TABLE IF NOT EXISTS action_reviews (
  id            TEXT PRIMARY KEY,
  realm         TEXT NOT NULL,
  session_ref   TEXT NOT NULL,
  run_id        TEXT,                     -- §23.3 的 Run
  action        TEXT NOT NULL,            -- 工具名 / 外部动作标识
  band          TEXT NOT NULL,            -- 闭集：AUTO | REVIEW | DENY
  decider       TEXT NOT NULL,            -- 闭集：classifier | human | fallback
  reason        TEXT NOT NULL,
  denied_streak INT NOT NULL DEFAULT 0,   -- 连续被拒计数（兜底判据）
  denied_total  INT NOT NULL DEFAULT 0,   -- 单 Run 累计被拒计数（兜底判据）
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS action_reviews_recent
  ON action_reviews (realm, session_ref, created_at DESC);
```

**加列（既有表）**：

```sql
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS acceptance TEXT;
```

`acceptance` 为 NULL = 本切片前创建的派单（语义「无验收条件」，**不回填假数据**，
照 §23.4/§22.3 规则 2）。读侧必须显式识别旧模式行。

---

## 12. 契约（TS，`shared/seam-contracts/`）

新增 `shared/seam-contracts/coordinator.ts`，与既有契约同训（结构等价、零 import dsh、
TS/Go 双实现）。

**P6a 已落地（2026-09-20）**：`shared/seam-contracts/coordinator.ts` + 消费面
`dsh-plugins/control/src/release.ts`。以下签名以代码为准（29 条用例覆盖，见 §14 判据 1–3、5）。

```
// 动作放行三档（§24.5）——纯函数，供 control 插件与 Go 控制面同源判定
type ReleaseBand = 'AUTO' | 'REVIEW' | 'DENY'
classifyAction(facts: {
  sideEffect: boolean
  reversible: boolean
  crossRealm: boolean
  touchesCredentials: boolean
  opaAllowed: boolean            // OPA 判否即否，分类器只收窄
  classifierAvailable: boolean
  classifierVerdict?: 'allow' | 'review'   // 没有 'deny'：拒绝由事实给出
}): { band: ReleaseBand; reason: ReleaseReason }
```

**规则有序，先命中先返回**（顺序即优先级）：

| # | 条件 | 结论 | 为什么在这个位置 |
|---|---|---|---|
| 1 | `!opaAllowed` | `DENY` / `opa-denied` | 语义上终局，排在任何技术性判定之前 |
| 2 | `crossRealm` | `DENY` / `cross-realm` | 租户边界，分类器不该有机会发问 |
| 3 | `touchesCredentials` | `DENY` / `credentials` | 凭证不出边界（§10） |
| 4 | `!reversible` | `DENY` / `irreversible` | **摘下判定域**：不可逆没有「判错了再改」这个选项（比文章更严） |
| 5 | `!sideEffect` | `AUTO` / `read-only` | 与分类器可用性**无关**，见下 |
| 6 | `!classifierAvailable` | `REVIEW` / `classifier-unavailable` | fail-closed 回全人工 |
| 7 | `classifierVerdict === 'allow'` | `AUTO` / `classifier-allow` | 唯一能产出 `AUTO` 的非只读路径 |
| 7 | 否则（含 `undefined`） | `REVIEW` / `classifier-review` | 「没意见」不等于「同意」 |

**两条从实现中固化下来的判据**（写在这里是因为它们容易被实现成错的形状）：

- **只读动作与分类器无关。** 把只读也推进人审队列，正是文章批评的 97% 批准率场景——
  审批一旦退化成反射性点击，它就既不安全也不快。分类器的职责边界是**副作用动作**。
- **`classifier-unavailable` 与 `classifier-review` 必须是两个理由。** 前者是**故障**，
  后者是**判定**。混成一个的后果是「分类器挂了」会表现成「工具被判定为危险」，
  现场会去查工具而真正的问题在分类器。因此 `available()` 与 `verdict()` 任一次抛错，
  都必须同时把可用性打成 false——`control/src/release.ts` 用同一次 try 包住两者。

**消费面：默认行为与接线前逐字节一致。** `control/src/release.ts` 的 `toolRelease` 把
`gate.ts` 的状态档与 `classifyAction` 合成放行结论，三条边界：

- `running` 档**根本不调用分类器**（不为记录而制造一次判定）；
- `aborted`（及词表外状态）**在分类之前返回**——分类器没有机会对已中止的会话发问；
- 分类器是**可选**装配。**订正（2026-09-20）**：原文写「`control` 不提供实现（形态未拍板，R2）」，
  现已带一个**最小实现**（`classifier.ts` 的前缀名单 `AllowlistClassifier`，选它因为最保守：
  无新依赖、无第二数据源、判定可枚举），但**默认不装配**——
  `releaseClassifierOf(undefined) → undefined`，没配 `classifier` 就不 `provide`，
  闸门走 fail-closed 分支，**行为与接线前逐字节一致**。「可替换件」这条性质的全部实现
  就是这一行装配：换掉它不需要动闸门，也不需要动它的用例。原句保留在下方以存证：
  只消费别处注册的
  `releaseClassifier` 服务；缺席时走 fail-closed 分支，即「只读档拒一切副作用工具」。

**不变量（§14 验收判据逐条对应）**：
1. `opaAllowed === false` → `DENY`（分类器无权放宽）
2. `classifierAvailable === false` → 有副作用的动作最多 `REVIEW`，绝不 `AUTO`

// 兜底回落（§24.5 第 3 条）
type FallbackVerdict = 'keep' | 'fallback-to-manual'
fallbackVerdict(input: { deniedStreak: number; deniedTotal: number }): FallbackVerdict
// 阈值：连续 3 次 或 单 Run 累计 20 次 → 'fallback-to-manual'

// 组合验证闸门（§24.7）
type IntegrationVerdict = 'pass' | 'reject-batch'
integrationVerdict(input: { contractTestsPass: boolean; smokePass: boolean }): IntegrationVerdict

// 异构审查者（§24.8）
type ReviewerEligibility = { eligible: true } | { eligible: false; reason: string }
reviewerEligibility(input: {
  dispatcher: string; reviewer: string          // 同一主体即不合格
  dispatcherPreset?: string; reviewerPreset?: string
  dispatcherModel?: string;  reviewerModel?: string
  dispatcherNode?: string;   reviewerNode?: string
  affectedArtifacts: number
}): ReviewerEligibility
// 不变量：dispatcher === reviewer → 不合格；三者全同 → 不合格；affectedArtifacts >= 3 → 强制独立审查
```

**为什么是纯函数**：这三组判据是**唯一判据来源**，挂点只消费它们的输出——判据散在挂点里会漂移。
与 `control/src/gate.ts` 的既有训诫同源（「它是这一层唯一的判据来源」），且能在
`environment: 'node'` 下直接测试，不必拉起整个 cordis 装配。

---

## 13. 实施切片

按依赖排序，每片独立可验收：

| 片 | 内容 | 依赖 | 落点 |
|---|---|---|---|
| **P6a** | **动作放行三档 + 兜底回落**：契约 `coordinator.ts` 的四组纯函数 + `control` 插件消费（`release.ts`） | 无 | `shared/seam-contracts/` + `dsh-plugins/control` |
| **P6b** | **协调者档位**：S1/S2/S3 语义 + `isCoordinatorName` 判据（`addMember` / `memberByName` 两点）+ `acceptance` 字段 + `acceptanceVerdict`（**其证据入参无生产者，见 §14.5**） | P6a | `dsh-plugins/agent-teams` |
| **P6c** | **异构审查者 + 组合验证闸门**：`reviewerEligibility` / `integrationVerdict` 接入 §23.3 的 `IN_REVIEW → DONE` 边 | P6a | `control-plane/governance` |
| **P6d** | **项目决策记忆**：`project_decisions` 表 + 索引/主题两级读面 + append-only supersede + 固化任务 | 无 | `control-plane/projects` + `dsh-plugins/project` |
| **P6e** | **Thread 档位**：`threads` 表 + 稳定会话 + mailbox 唤醒 + 工作目录隔离 | P6b | `dsh-plugins/agent-teams` + `control-plane/collaborator` |
| **P6f** | **Fork 选择 + 跨节点 seed 可行性**：先证伪/证实 §24.3.1 的 R1b 假设，再让成员 provider 可按任务选择（正交→`spawn`/`lumo-remote`，延续→`fork`） | P6e | `dsh-plugins/agent-teams`（`selectDispatchProvider`）。**R1b 已证伪**（见 §24.3.1 §4.2），`shared/seam-contracts/subagent-host.ts` **未动** |

**落地进度（2026-09-20）**：

- **P6a 已落地**：契约 `coordinator.ts`（`classifyAction` / `fallbackVerdict` /
  `integrationVerdict` / `reviewerEligibility`）+ 消费面 `control/src/release.ts`
  （`toolRelease`，接线后行为与接线前逐字节一致）。
- **P6b 已落地**：`acceptance` 字段（`model.ts` + `store.ts` 往返）+ `acceptanceVerdict`
  纯函数（`acceptance.ts`）+ 测试。
  **P6b 遗留的两处缺口已收口（2026-09-20，见下）**：S2 的结构性保证见上方 §24.1；
  `acceptance` 的可见性——协调者经 `agent_teams_create_task` 设置、成员经
  `buildMemberPrompt` 看到，且「有没有验收条件」由 `hasAcceptance` 单点裁决
  （`acceptanceVerdict` 与 prompt 构造共用，两处不会各自漂移）。
  **仍未闭合**：`acceptanceVerdict` 的证据入参**没有生产者**——见下方 §24.4 的「缺口 B」。
- **P6a-tail 已落地**：`action_reviews` 表（§11 DDL 逐字节相同）+ 写入/查询面 +
  `POST/GET /v1/sessions/{ref}/action-reviews`。闭集校验、append-only、同 id 同内容按重放、
  同 id 异内容 409。**真库 13/13 零跳过；`ddl-ownership` 9/9（带 PG 的结构断言真跑）**。
- **P6c 已落地**：`governance/internal/domain/coordinator.go`（Go 双实现，与 TS 逐条对齐）
  + 闸门接进 `store.TransitionBusinessTask` 的 `complete` 分支（即 `IN_REVIEW → DONE`，
  闭集未动；打回 = 返 nil error + `next=ROUTING` + 审计带 `integration_verdict`）。
  **真库 84 PASS / 0 SKIP**。缺口：`ReviewerEligibility` 在 Go 侧**无消费方**（治理面没有
  「指派审查者」的路径），只交付可调用判据。
- **P6d 已落地**：`project_decisions`（§11 DDL 逐字节相同，脚本比对过）+ 两级读面
  （索引有界 / 全文按需）+ append-only + supersede + 固化任务（**只报候选，不改数据**，
  真库用例断言跑完数据零变化）。TS 侧**无写入面**（取代事务只允许一处实现）。
  **真库 34 PASS / 0 SKIP**。缺口：未接 TriggerBus（§13 本就排除）；矛盾标注是启发式的，
  已按启发式对待（`policy: "flag-only"`，无「谁赢」字段）。
- **P6e 已落地**：Go `control-plane/collaborator`（`threads` 唯一建表方与写入方：状态闭集/
  转移表/轮次身份/节点丢失结论/工作目录归属 + 5 个端点）+ TS `agent-teams`（判据消费面
  `thread.ts`、走既有 mailbox 的 `thread-wake.ts`、注册表客户端、运行时装配）。
  **TS 13 文件 / 221 用例绿；collaborator 真库 7/7**。口径补齐见 §24.2 的 §3.3。
  **未做**：工作目录物化（只做路径归属与解析，无 mkdir）、重派的实际动作（只给结论）、
  节点存活探测（只接受显式上报）。
  **订正（2026-09-20）**：本行原把「跨节点续跑」列为未做——**贴错了标签**。
  §24.2.1 明写「Thread 亲和到承载节点；节点丢失 = 终止、重派新 Run，**绝不假装可迁移**」，
  所以跨节点续跑是**设计排除**，不是欠账。工作目录不迁移这一点使它连"能做但不做"都不是：
  就算模型可见状态能从复制日志重建，现场也已经没了，重派本来就是正确处置。
- **P6f 已落地（降级后）**：R1b **证伪**（见 §24.3.1 的 §4.2），P6f 按约定降级为
  **逐次 provider 选择**——`TeamTask.continuesContext` + `roster.ts` 的
  `selectDispatchProvider`（三条守卫：进程外一律不动 / 正交原样 / fork 不可用则回落不抛）
  + 工具参数 + 接线测试。**TS 14 文件 / 242 用例绿**。
  **未做**：集群内的 fork（需自写从复制日志重建种子的 provider，另一件工程）、
  正交并行的「请求前缀逐字节相同」强制检查（依赖上游缓存行为，无法在本仓库验证）。
- **§14.5 的三条缺口已处置完毕（2026-09-20）**：两条闭合（证据通道、评审者判据的消费方），
  第三条改判为**设计边界**（集群内 fork 被 §7.1 排除，不是待办）。
- **§24 的 P6a–P6f 全部走完**（P6f 为降级交付）。其余切片状态见本表各行。

**第二轮（2026-09-20，P6 之后的剩余项）——五路并行落地：**

| 路 | 内容 | 状态 |
|---|---|---|
| A | Thread 全生命周期：失联信号链、工作目录物化、重派动作、`agent_threads_*`（6 个工具） | 4/5 落地；**注册表发现未做**（仓库唯一的 TS Nacos 模式是**按 node_id 解析**、非按服务名解析基址；跨插件 import 要新增依赖边 + `pnpm install`，本次禁止）。**另见下方 ⚠️：信号链的来源有问题** |
| B | §24.5 的 Go 双实现 + **跨语言同矩阵对照** + 分类器最小实现 | 全落地。矩阵由 TS 生成并提交（`fixtures/release-matrix.json`，192 classify + 28 fallback **穷举**），Go 读**同一份**逐行对照；TS 侧另有新鲜度锁（`UPDATE_RELEASE_MATRIX=1` 才写盘）。**对抗演练已验**：篡改矩阵一行 → TS 红；改 Go 阈值 → Go 红 |
| C | §24.8 从「只记录」升级为「按阈值强制」 | **走了记录路线**（强制版卡点见 §14.5）。新增 `ReviewImpact{Artifacts,Proven}` + `ReviewDisposition` + `ReviewDispositionFor`（`HighImpactArtifacts` **唯一比较处**）。不可证时**不写 `artifacts` 键而非写 0**——「0 会被读成『0 个产出物』」 |
| D | 固化任务接 TriggerBus + 唤醒可归因 | 固化**默认关闭、无内置频率**（§16 R4：编一个默认值比留空更糟），经既有 `project_automations` cron + 只读算子；**顺带修了一个既有生产缺陷**（见下）。唤醒归因**做了一半**：事件唤醒的执行现在带 `X-Lumo-Trace = flow-trigger-<id>`，写进既有 `usage_ledger.trace_id`（`cost_type` 闭集未动）；另一半（dsh 侧 agent Run / Thread 轮次）需要 `ThreadRound.Key()` 的生产者，**未做** |
| E | §24.6 线程看板 | 落地（14 条纯函数 + 1 条渲染证据）；**三处读面缺口见 §14.5**，其中「待轻量答」格**如实显示「读不到」**而不是 0 条或空 |

> **D 顺带修掉的既有生产缺陷（值得单列）**：`flows` 的 `store.ClaimTriggers` 的 CTE 里四个
> `COALESCE` **没起别名**，PostgreSQL 会把它自动命名为 `coalesce` / `coalesce_1`…，于是外层
> `SELECT ... replay_automation_id FROM claimed` 找不到列、直接 `42703`。
> **这条链此前从未真正工作过**——worker 每轮失败、不 ack、什么都不搬，而 `SetErrorHandler`
> 未设时连日志都没有，表现成「事件进得来、流程永远不被触发」。
> 它一直藏着是因为此前的投递测试**全用 fake outbox**，那条 SQL 的列名解析根本没被执行过。
> **这正是本仓库活库验收纪律存在的理由。**

> **A 的信号链来源问题（实现期发现，详见 §24.2.3(4) 的 ⚠️ 块）**：判定器读
> `lumo_service_heartbeats` 里 `service='dsh-node'` 的行，而承载节点**按设计不写那张表**
> （它是「控制面服务实例存活」，且与 `scheduler_clusters` 刻意分开——E4/D6 刚拆开的东西）。
> 正确来源是 **Nacos**。**未顺手改**的理由是**无法验证**（本机无 Nacos），不是难度。

**P6a 先行的理由**：它是纯函数 + 加表，改动面最小，却是 §24.5 / §24.7 / §24.8 三节的共同判据源
——先把它做成可测的真值，后面三片才有可依赖的判据。**P6f 最后**：它依赖上游供应商行为，
是唯一一片**收益不确定但失败无害**的，不该挡住前面五片。

---

## 14. 验收判据

> **落地状态（2026-09-20 复核）。** 下表 13 条不是同一种东西，直接当「都验过了」读会出错。
> 三种成色：
>
> | 成色 | 含义 | 条目 |
> |---|---|---|
> | **端到端** | 有真库/真接线验证 | 1、2、3、**4**（证据由子 Run 身份供给，§14.5 已闭）、**5**（评审者判据在治理面有记录式消费方，真库 86/0/0）、6、7、8、11 |
> | **判据级** | 判据正确且被测试覆盖，但**消费方尚未接线** | 9（链路已建齐——判定/上报/通知/重派四段都在，**但存活来源不对**，见 §24.2.3(4) 的 ⚠️）、10（**半**：事件唤醒的 Run 已可归因，dsh 侧 agent Run / Thread 轮次仍缺 `ThreadRound.Key()` 的生产者）、12（**半**：§24.5 两组已有 Go 双实现 + 穷举同矩阵对照；§24.7/§24.8 两组仍无跨语言对照） |
> | **不成立 / 已变** | 前提消失或前提从未成立 | 13（R1b 证伪、集群 fork 改判为设计边界后，此判据失去对象，§24.3.1 §4.2） |

> **一处跨语言命名漂移（登记，未统一）**：TS 的类型叫 `FallbackVerdict`，Go 侧落成了
> `FallbackDecision`——因为同名的 Go 函数占用了那个标识符。**同一个概念两种叫法**正是本仓库
> 为 15 篇 addendum 的术语冲突付过学费的那类问题。它不影响行为（同矩阵对照测试覆盖了值），
> **但会让人在两侧之间来回找**。统一它要改一侧的公开标识符，属破坏性改名，**留给有意为之的人**。
>
> 「判据级」不等于「半成品」——判据本身是完整的、能判的、有测试的；缺的是**调用它的地方**，
> 而那个地方的缺失是设计缺口（§14.5 逐条说明了缺什么），不是实现偷懒。

1. **三档边界**：`opaAllowed=false` 时无论分类器如何判，`band` 恒为 `DENY`（分类器无权放宽）。
2. **fail-closed 回落**：`classifierAvailable=false` 时 `band` 最多为 `REVIEW`，**绝不 `AUTO`**。
3. **兜底防自旋**：`deniedStreak=3` 或 `deniedTotal=20` → `fallback-to-manual`；边界值
   （2/19 不触发、3/20 触发）三点必测。
4. **协调者拒收无证据报告**：构造一个无 `evidence[]` 的段 → `verified=false`，协调者拒收。
   （此项在本设计前**恒失败**，是新增能力的证据。）
5. **异构审查**：`dispatcher === reviewer` → `eligible:false`；
   preset/model/node 三者全同 → `eligible:false`；`affectedArtifacts >= 3` 且审查者同源 →
   `eligible:false`。
6. **组合验证整批打回**：任一契约测试失败 → `reject-batch`，业务态回 `ROUTING`（§23.3 既有回退），
   **不产生逐 Run 打回**。
7. **决策记忆 append-only**：新决策不修改旧行，旧行 `superseded_by` 指向新行；
   `superseded_by IS NULL` 的部分索引只返回有效决策。
8. **决策记忆作用域**：跨 realm 查询返回空（Provider 层强制过滤，§5.4 既有义务）。
9. **Thread 不假装可迁移**：承载节点失联 → Thread 标 `failed` 并重派新 Run；
   `threads.session_ref` 唯一约束生效；不存在「同一 Thread 两个 node_id 并存」的行。
10. **唤醒可归因**：一次由事件唤醒的 Run，其成本可按 wake 事件聚合查询（`cost_type` 闭集未扩）。
11. **schema 幂等**：`init()` 连跑两次不报错（§22.3 规则 1 的每列必测项）。
12. **契约双实现**：TS 与 Go 对同一输入矩阵产出同一 `band` / `fallbackVerdict` /
    `integrationVerdict` / `reviewerEligibility`（同 §23 验收判据 1 的惯例）。
13. **Fork 不改变行为**：同 seed 同任务，Fork 路径与非 Fork 路径输出在容差内；
    前缀不一致时显式放弃复用并记录原因。

---

## 14.5 未闭合的缺口：两条判据没有生产者（**刻意不伪造消费方**）

§24 交付了两条**判定正确、测试完整、但没有消费方**的判据。它们不是「还没接线」，
而是**接线所需的前置能力本身就不存在**。记在这里是因为：伪造一个消费方比留一个缺口更糟——
伪造出来的接法会被当成设计的一部分继承下去。

> **状态更新（2026-09-20）：三条里两条已闭合，第三条改判为「设计边界」。**

| 判据 | 卡在哪 | 处置 |
|---|---|---|
| `acceptanceVerdict` 的**证据入参** | 成员写回只有 `TeamTask.output: string` 一个通道，**没有结构化的证据通道** | ✅ **已闭合。** 证据**不需要成员自报**——派发方本来就拿着 `MemberRun.id`，只是在折叠结局时丢了（`foldMemberResult` 的签名里根本没接住它）。补回后：`MemberOutcome.runId` → `evidenceOfRun()` → `TeamTask.evidence` → 派发结果里的 `acceptance`。**证据是系统已知的事实，成员没有伪造空间** |
| `ReviewerEligibility`（Go 侧） | 治理面没有「指派审查者」路径 | ✅ **已闭合（记录式消费）。** 两个身份都是既有事实，不需要调用方声明：dispatcher = `assignee_worker_id`，reviewer = 本次 `complete` 的 `actor`。落 `governance_task_audit.detail.reviewer_self_review`。**只记 `self-review` 不记 `homogeneous`**：后者要 model/preset/node 三组事实才能证「不同源」，治理面没有这三组数据，于是它会在**每一次正常完成**上触发，是噪音不是发现 |
| 集群内做 fork | —— | ⛔ **改判：不是缺口，是设计边界。** 见 §24.3.1 §4.2 —— `startInProcessRun` 需要**活的父 `Agent`**，而 `seed` 只是可选附加输入。承载节点上重建父会话会让同一份日志出现两个写者。**若将来要做集群续跑，正确的问题是「怎样让子会话从复制日志的某个前缀起步」，不是「怎样把 fork 搬过网」** |
| `threads.replaces`（重来谱系） | 决策已定（§24.2.3(3)），**实现未做** | `control-plane/collaborator` 加可空列 + `ADD COLUMN IF NOT EXISTS`，遵 §22.3；新 Thread 取代失败前身时写入。**门槛很低，只是没排在已完成的切片里** |
| **节点失联的存活来源** | 实现读的是 `lumo_service_heartbeats`，而承载节点**按设计不写那张表** | **来源订正见 §24.2.3(4) 的 ⚠️ 块**：正确来源是 Nacos。改造要**新抽一层 `LivenessSource`**（现有 `Reader` 是 pgx 形状的）。**未做的理由是无法验证**（本机无 Nacos），不是难度 |
| §24.6 看板的「待轻量答」格 | lumo-ui 够不到「控制态列表读面」与 `collaborator` 的 `GET /threads` | 两条读面：① 控制态列表（session-control 目前只能按会话逐个读，任务行里没有 `session_ref`）② lumo-ui 代理 collaborator（host 的 `ServiceName` 里没有它）。看板已**如实显示「读不到」**而不是 0 条 |
| §24.8 审查的**强制**版 | 影响面无可证来源 | 见上表末「一处值得记下的设计缺陷」——`ReviewDispositionFor` 判据已就位且只有一份，卡在事实来源 |

**为什么阈值必须从真实数据推、不能由调用方声明。** 若把 `affectedArtifacts` 做成请求参数，
调用方永远可以填 `0` 来绕过审查——那是标准的静默绕过，本仓库一贯拒绝的形状。
唯一不可绕的来源是**已经发生的证据**，所以 (b) 是正路。

> **一处值得记下的设计缺陷**：§24.8 把「派发者不验收自己的活」写成**无条件**约束。
> 接进 `complete` 边时会撞上一个真实场景——小团队里同一个人既派发又验收，
> 无条件执行会让任务永远无法完成。本设计的处置是**只在 `affectedArtifacts >= 3` 时强制**
> （这正是文章那条「编辑 3 个以上文件才激活验证」的经验阈值），阈值以下只作提示。
> **该处置尚未实现**，因为阈值的数据源就是上表的缺口。

## 15. 不做的事（显式外）

- **原生二进制 / 运行时替换 / 零依赖分发**（文章重构线 ③）。这是 CLI 客户端的分发问题，
  与平台无关。文章自己也承认它「在工程上正确，在透明度上是一次回撤」。
- **厂商配额数字**（200 新线程/天/账户）。配额由预算树推导（§24.9），不照抄数字。
- **`Workflow` DSL 新语言**。编排脚本复用 §9.2 的 FlowEngine + §10.3 的五类制品分发，
  不新造一门 DSL。文章的 `resumeFromRunId` 缓存语义由 `flows` 的运行幂等记录承载。
- **云沙盒 / 「本机执行」路线图**。Lumo 的承载节点**就是**执行平面（§7.4），
  不存在「云端隔离缺口」这个问题。
- **git worktree / PR 工作流**。交付单元是项目不是仓库；见 §24.3.2 的偏离登记。
- **自动裁决矛盾记忆**。只标注不裁决（§24.4 第 5 条）。
- **分类器的实现形态**。三档闭集与三条不变量是本设计的内容，判定器是可替换件（R2）。
- **前端页面**。本篇只交付后端语义、契约与判据；`lumo-ui` 看板分格是独立切片
  （§24.6 已给出分格定义，实现不在内）。

---

## 16. 风险与取舍

**R1 —— Fork 的两个未验证前提（本设计里不确定性最高的一处）。**

拆成两条，因为它们的失败后果不同：

- **R1a：前缀缓存是否生效取决于 `llm-gateway` 背后的供应商。** 这是**收益型**风险：无缓存则
  只是没有收益，不影响正确性，因此**不设 fail-closed**。判据写成「命中率提升」而非文章说的
  「成本接近零」。
- **R1b：跨节点 fork 的 seed 能否用「引用」代替「传输」——✅ 已证伪（2026-09-20）。**
  上游 `fork` 要的是 `request.parent: Agent`（活的进程内对象），承载节点上没有它，
  所以「只传 `(parentSessionRef, upToSeq)` 引用」不成立。**P6f 据此降级**为逐次 provider
  选择（§24.3.1 的 §4.2/§4.3）。**残留**：集群里要做 fork 需自写 provider 从复制日志
  重建种子，代价与「选对 provider」不是一个量级——登记为独立工程，不在 §24 范围内。

**触发重审的条件**：若接入自建推理集群（前缀缓存可自控），或上游 `fork` 从「日志前缀快照」
改成别的 seed 形态，R1a/R1b 的判据都要重估。

**R2 —— 分类器的误判成本不对称。**
放行一个不该放行的动作，代价远大于拒绝一个本该放行的动作。因此三条不变量全部偏向拒绝侧：
只收窄、fail-closed 回人工、兜底回落。**代价是可用性**——分类器故障时全平台退回逐次人审，
与文章批评的「97% 批准率」现状一样慢。这是**有意选择**：宁可慢，不可放错。

**R3 —— Thread 的长生命周期与无状态 AgentSlot 的张力。**
§7.1 的 AgentSlot 是无状态的，而一个正在改文件的 Thread 会钉住承载节点。
本设计的取舍是**亲和而非迁移**（节点丢失即重派），代价是节点故障时 Thread 的工作现场丢失，
收益是不违反「句柄型 seam 不可跨节点恢复」的既有结论。**不引入 continuable**，
所以这条张力不会被「看起来能迁」的假象掩盖。

**R4 —— 决策记忆的腐化速度可能超过固化速度。**
文章的 `autoDream` 是承认自动维护不够。Lumo 用 TriggerBus 定时固化，但
**频率与剪枝策略需要运营数据校准**，本篇给不出默认值（给一个编出来的默认值比留空更糟）。
登记为需在运营中定的参数。

**R5 —— 注意力路由看板是投影，可能被误当成状态机。**
§15 第 14 条要求「终端只渲染视图，不实现状态机」。看板分格若被写成独立状态存储，
会立刻产生「看板说待审、控制面说 running」的双真相。本设计明确**不新增存储**
（§24.6 的设计原则），实现时必须守住。

**R6 —— 组合验证闸门会显著拉长交付时延。**
整批打回意味着一个任务下的所有 Run 要为最慢的那个等。这与文章承认的
「并行让你开始得更快，却让收尾更容易卡住」是同一现象。取舍是**宁可整批重来**，
也不产出「各自都对、合起来不能跑」的结果——后者是不可审计的。

---

## 17. 对既有文档的影响

| 文档 | 影响 |
|---|---|
| `architecture.md` §7.3 | 增一行指针指向本篇（协同拓扑的协调者语义与两档成员在此）。**不改 §7.3 既有拓扑定义** |
| `architecture.md` §8.4 | 增一行指针：`approve` 可由分类器行使（§24.5）；控制指令闭集**不扩** |
| `architecture.md` §7.1 | **不改**。本篇 §24.2.1 显式服从其「句柄型 seam 不可跨节点恢复」结论 |
| `docs/README.md` | 专题设计表增一行 |
| `§23` 业务控制面 | **不改其闭集**：业务态机、`cost_type` 闭集、报告六段式全部复用；只加一个 `acceptance` 列与一条 `IN_REVIEW → DONE` 边上的闸门 |

**对既有待决事项的影响**：无。本篇不触碰 `docs/README.md` §四的两条待决项
（落地首切顺序已按 §23 的建议记录为「基础设施顺序已完成」，TiDB/CRDB 与本层正交）。

---

## 附：与文章结论的偏离清单（集中留痕）

| 文章结论 | Lumo 处理 | 理由 |
|---|---|---|
| 线程运行在云沙盒，本机执行是路线图 | **不采纳** | §7.4 承载节点即执行平面 |
| 冲突走 git merge conflict / PR | **偏离**：产出物 + 项目裁决界面 | 交付单元是项目不是仓库（§24.3.2） |
| 共享记忆是文件 + `MEMORY.md` 索引 | **改造**：PG append-only + supersede | 平台无文件型记忆，与台账同纪律（§24.4） |
| 协调器无 connectors（「无手」） | **改造**：协调者无**副作用**工具，保留只读 seam | Lumo 的外部操作已经过 seam 隔离，不必绝对化（§24.1 S2） |
| 200 新线程/天 | **改造**：新 Run/天 配额，由预算树定 | 配额是部署决策不是产品常量（§24.9） |
| 「并行分支成本接近零」 | **改造**：判据改成「命中率提升」 | 依赖上游供应商，不可承诺（§24.3.1） |
| 同源审查（三处都是同源） | **不采纳**：加异构硬约束 | 文章自己判定这是原则性限制（§24.8） |

# Implementation status (2026-09-15)

配置变量与开发默认值边界见 [`configuration.md`](./configuration.md)。

> 集群模式下**代码与装配层面**的功能缺口清单见 [`cluster-gap-analysis.md`](./cluster-gap-analysis.md)（首版 2026-09-08，**2026-09-14 逐项复核、2026-09-15 再复核、2026-09-16 修正计数并复核 C 组、2026-09-17 改判 E7b**：现合计 34 项 = **28 已闭合 / 3 部分闭合 / 0 仍未闭合 / 3 非缺口**。首版 A/B 两组已全部闭合；E2 与 E3 经再复核**改判为误读**，不是缺口；C8 于 2026-09-16 闭合；**C7 流程血缘同样于 2026-09-16 判为已闭合**（血缘事实落 PG outbox、Nebula 降为可选呈现层）；**C3 边缘网关 / C4 终端网关为部分闭合**——代码与两种 compose 形态早已落地，是清单没跟上；那次逐点核对接线面还发现二者**不在 Helm chart 的 `services` 里**，所以当时是「已实现但没接线」。**这两个服务当天就补进了 chart**（路由表由模板从 release 名与各服务端口派生、以目录挂载；入口层的 Service 类型保持 ClusterIP、需要暴露时按服务覆盖），于是它们的残留换成了同一条：**真集群端到端验收**——`acceptance-cluster.sh` 对 C3/C4/C7 三者零探针）。**计数以缺口清单文末的表为准**——此处此前写的 18/2/11 与那份表自相矛盾（把 C 组的「部分闭合」当成「未闭合」多加了一次），凡引用请回去加一遍；**2026-09-17 又发现同一处第四次分叉**：E6 的行早在 09-16 就写着「已闭合」而表没跟改，与 E7b 一起从「仍未闭合」移出，故由 26/3/2/3 变为 28/3/0/3。**「以表为准」这条规则本身是有条件的**——那一次是**表错、行对**（行带行号与用例名，表只有一个数字），冲突时先看哪一边带了证据。本文记录的是外部集成边界与生产验收事项，两者互补。

## 2026-09-17 实施：生效面接线——「pause」从「拒工具」变成「真的停在 turn 边界」

**一句话**：`pause` 此前的实际效果只有「拒掉副作用工具」，**turn 照跑**——agent 继续调模型、
继续读文件、继续说话。现在它在 `agent/pre-step` 上**真的不开新步**；`abort` 从「拒绝所有工具」
变成**硬取消当前 turn**（在途模型调用一起断）；`resume` 会注入续跑注记并唤醒。

### 一、先把「下发未接线」这句话改到该改的地方

上一节（提交面接线）把 `control.Dispatcher` 记成「仍未接线」。本轮确认了它**不是**
「pause 不生效」的原因，理由是证据而不是推理：

- **状态行本身就是通道。** `@lumo/control` 读 `session_control_state`（1s 缓存）并在挂点上
  消费它。控制面写 `paused` 的那一刻，执行面已经能读到了——不需要任何推送。
- **所以 `Dispatcher` 的剩余价值在别处**：§8.4.2 要求控制指令作为 `session/control` 事件
  **进复制日志、多端可见**。那是「终端能不能看到有人按了暂停」的问题，不是「暂停生不生效」。
- **而直插日志是不允许的**：`session_log` 是**单写者 + fencing** 的（`session_writer_lease`
  持有 `fencing_token`，`session_log` 的主键是 `(session_ref, seq)`，注释写明「同 seq 上内容
  不同则是单写者约束被突破，必须响亮失败」）。一个没有租约的外部进程 INSERT 进去，轻则撞 seq、
  重则让真正的写者被自己的不变式判为违规。
- 因此那条链的正解是**节点寻址的信箱**（照 `job_control_command` 的先例：`correlation_id`
  主键幂等 + `take`/`ack` 租约 + `FOR UPDATE SKIP LOCKED`），**不是** HTTP 直推、更不是直插日志。
  这条留作后续切面，本轮的交付不含它。

### 二、停转只有两条路，`agent/turn-stopping` 不是其中之一

| 手段 | 语义 | 对应 §8.4.1 的作用点 |
| --- | --- | --- |
| `agent/pre-step` 返回 `{kind:'reject'}` | 这一步不开 → 这个 turn 不开。**可逆** | pause / stop 的「turn 边界」 |
| `agent.cancel(cause)` | 硬取消当前 turn，连在途模型调用一起断。**不可逆** | abort 的「会话」 |

`agent/turn-stopping` **只能延长不能缩短**：循环在 turn 已经结束、且 `inbox.nextStep` 为空时
才调它，调完再看一眼 `inbox.nextStep` 决定要不要继续（`agent-loop/src/agent.ts` 的 `turn()`）。
它是「turn 要结束了」的通知点，不是挂起点——把它当挂起点会得到「turn 永远跑完，只是没人拦」。

### 三、拒这一步之前必须把消息放回去（否则那不是暂停，是丢数据）

上游 `preStep()` 先 `inbox.claim(target, turn)` 再走 `agent/pre-step` 瀑布钩子，而 **claim 是消费**。
直接 `reject` 会把用户刚发的消息吞掉。做法与上游 `goal-round-driver` 的 `restoreOtherClaimed()`
同款：倒序 `prepend` 把这一批**原样放回**，且**不唤醒**（开不开下一个 turn 由状态恢复决定）。

两个细节：

- **放回哪个列表**：`agent/pre-step` 的载荷不含 `target`，但循环里 `target` 初值 `'next-turn'`、
  第一次迭代后才变 `'next-step'`，而 `step` 取自 `phase.step + 1`、每个 turn 归零 ⇒
  `step === 1` ⟺ 来自 `next-turn`。这是**推断不是契约**，所以收在一个纯函数
  （`claimedTarget`）里，理由写在唯一一处，上游改结构时测试会红在这一点上。
- **重复 id 必须跳过**：真 inbox 对「同一 id 同时 pending」是**抛错**的
  （`inbox.ts` 的 `inboxProjectionSchema.apply`），抛出来的错会毒掉整份会话日志。

### 四、一张表、两个投影

`gate.ts` 里现在是**一张状态表**派生两个函数：`controlGate`（工具级：allow / read-only / deny）
与 `controlActuation`（turn 级：run / suspend / cancel）。合成一张表是为了防漂移——分成两张，
症状就是「按了暂停，工具被拒了但 agent 还在说话」。

`suspend` 覆盖 `paused` / `awaiting-approval` / `stopped` 三者，且**不区分**它们是否可逆：
「哪个状态能被 resume」是 Go `internal/state` 的显式矩阵的知识，在这里复制一份判断等于给同一个
问题留第二份实现。

**词表外一律 fail-closed，但方向要逐条判**：工具全拒 + 停转，**不**取消——取消不可逆，而
「不认识的值」不构成执行不可逆动作的理由。停转已经足够安全，且状态一旦变得可辨认就能继续。

**这里踩到一个真坑**：查表最初写成对象字面量 `table[state]`，于是 `table['constructor']` 会取到
原型上的成员，**「命中」了一条 `gate === undefined` 的记录**；挂点里 `gate === 'deny'` 判否之后
落到「只读放行」那条分支——未知值就从 fail-closed 变成了 fail-open。改用 `Map` 后没有原型链。
反向用例专门钉了这一点（见下）。

### 五、主动轮询：补上「没人触发就不会发生」的两个动作

两个动作没有挂点可挂，因为**没人来触发**：`aborted` 的硬取消（agent 可能正在一段长模型调用里，
下一个步边界遥遥无期）与恢复后的唤醒（agent 已经 idle，没有任何事件会来）。

- 轮询周期 `actuationPollMs`（缺省 1s，**0 = 关闭**）。关掉只影响这两个动作；停转（开步前）、
  工具闸门、turn 边界观测都在挂点里，不受影响。没有控制面的部署可以关掉——状态永远是 `running`，
  这一轮询是纯开销。
- **重复抑制是这里唯一的风险**（1s 一轮会把 `cancel` 刷成每秒一次），所以抽成纯函数
  `actuationStep(previous, actuation, pending)`：`cancel` 同一状态只发一次；`run` 只在
  「上一轮还是 suspend」且「确实有输入等着」时才唤醒。
- 「有输入等着」这个条件是必要的：`steer()` 对 idle 的 driver **会开一个 turn**，
  而一个只有注记、没有待办的 turn 是一次纯粹的模型调用开销。「恢复」不该变成「凭空烧一次调用」。
- `cancel` 之后回到 `running` **不**唤醒：suspend 特殊在「我们把输入放回了队列且不唤醒」，
  必须有人补那一脚；cancel 没有这个问题，被硬取消之后能继续的路径本来就是新输入。

### 六、验证

- `actuation.spec.ts` **20/20 PASS**（判据表逐格、词表外 12 个对抗值、放回顺序与去重、
  不唤醒、cancel 的 cause、唤醒注记的 source 与 id、轮询重复抑制 4 组）。
- 既有控制用例回归：`control-schema-contract.spec.ts` 8 passed | 1 skipped（真 PG，本机无库）、
  `opa-policy.spec.ts` 5、`dispatch-routing.spec.ts` 18 —— **闸门重构逐字兼容**。
- 收窄 `tsc --noEmit`（`shared/seam-contracts` + `control/src` + `control/__tests__`）：
  见下节结论。
- **反向用例（两条，证明不空转）**：
  1. 把查表从 `Map.get` 换回对象字面量下标 → 「词表外 fail-closed」那条变红
     （`constructor` 拿到 `undefined`），证明 `Map` 这个选择是**承重**的，不是风格。
  2. 让 `preStepDecision` 拒之前不放回消息 → 「paused 时把 claim 掉的消息放回」那条变红。

### 七、边界

- **`resume` 会注入一条模型可见的注记**（`source.plugin = 'lumo/control'`）。这是 §8.1 的设计
  （「触发器到达 → 注入唤醒续跑」），不是副作用；但要知道它**会进模型上下文**。
- **不含 Go `Dispatcher`**（§一 已说明它解决的是另一个问题，且正解是信箱）。
- **未在真 dsh 进程里跑过**：本仓库的插件测试一向不重测「dsh 会不会按契约把钩子发出来」，
  那由 dsh 自己的用例保证；本层的判据与顺序用假 agent 覆盖。真进程里的行为仍属未验证。
- **`actuationPollMs` 没有进任何部署文件**：缺省 1s 对两种 compose 与 Helm 都适用，
  没有控制面的形态也没被特意关掉（多一次索引读/秒）。这是一处**已知的、刻意的**不做。

## 2026-09-17 实施：控制指令的提交面接线——`dispatch` 从占位符变成真链路

**一句话**：TS 插件的 `ctx.sessionControl.dispatch` 此前唯一的行为是抛
`ControlCommandRoutingError`（一个「这条链还没接上」的占位符）；现在它真的
`POST /v1/sessions/{ref}/control` 并把控制面的结论带回来。连带修掉三处会误导运维的分类错误，
并把「dsh 服务拿得到控制面地址」做成 Helm 渲染门禁。

### 一、先说名字撞车，否则后面全读错

本仓库有**两个 `dispatch`**，它们是一条链上的**两个不同环节**：

| 名字 | 位置 | 干什么 | 状态 |
| --- | --- | --- | --- |
| `control.Dispatcher` | Go `session-control/internal/control` | 把**已裁决**的指令送到**会话执行面**（§8.1 suspend / `agent.inject()`） | **仍未接线** |
| `ControlSeam.dispatch` | TS `dsh-plugins/control` | 把控制指令**提交给控制面**（`POST /v1/sessions/{ref}/control`） | **本轮接线** |

所以 `cluster-development-tasks.md` 里「`effectuation` 恒为 `recorded`」「`dispatch_failures_total`
故意没有告警规则（因为没人下发）」那两句**依然成立**——它们说的是第一个。本轮动的是第二个。
两个都叫 dispatch 是历史巧合，不是同一个东西。

### 二、契约从「必须抛错」放宽为「必须交出证据」

`shared/seam-contracts/control.ts` 里 `dispatch` 的契约原本是「有权就**必须**抛
`ControlCommandRoutingError`」。那是接线前的形态——它把**一种实现**写成了契约，接好线之后
会把正确实现判成违规。改成两条**都合法**，但都要求留下「控制面说了什么」的证据：

- 配了控制面地址 → 返回控制面的 `outcome`（**哪怕控制面回的是拒绝**）；
- 没配（local 形态没有这个服务）→ 抛路由错误，明说本实例没接线。

唯一仍然禁止的是 `allowed=true` 而无 `outcome`：**本层直接声称生效**。契约断言还新增一条
自洽检查——`allowed` 必须等于「`outcome` 属于 `{applied, noop}`」。带着结论却把方向说反的实现
比不带结论的更危险：它看起来证据齐全，却会把一条被拒的指令报成成功。

### 三、「拿到结论」与「没拿到结论」是两个正交出口

这是本轮最值钱的一条，直接照搬 Go 侧 `Controller.Execute` 的 `(Result, nil)` / `(Result{}, err)` 二分：

| 情形 | 处置 | 为什么不能合并 |
| --- | --- | --- |
| 控制面回 403 `policy_denied` | **返回结论**，`allowed=false` | 要去找管理员（永久） |
| 控制面回 503 `policy_unavailable` | 返回结论 | 要去看 OPA（临时，可重试） |
| 连接被拒 / 超时 | **抛 `ControlPlaneUnreachableError`** | 不知道结果，重试有意义 |
| 401 `{"error":"control_plane_auth"}`（认证中间件） | **抛 `ControlPlaneProtocolError`** | 是令牌不匹配，不是「控制面拒绝了这条指令」 |
| 网关的 502 HTML | 抛 `ControlPlaneProtocolError`，**带原文前 200 字** | 那个服务根本没起来 |
| `outcome` 是没见过的值 | 抛 `ControlPlaneProtocolError` | 不猜一个结论 |

**不按 HTTP 状态码判结论**：控制面的 `statusFor` 是多对一的（403 同时是 `policy_denied` 与
`realm_mismatch`，409 同时是 `state_rejected` 与 `conflict`）。也**不**在 TS 侧抄一份
status→outcome 对照表来交叉校验——那会是同一个契约面的第二份实现，漂移后症状是「某条指令被静默
归错类」。

### 四、顺带修掉三处会把人引向错地方的分类

1. **本地前置把「引擎不可用」报成了「权限不足」**。`OpaControlPolicy` 在 OPA 连不上/非 2xx/
   `result` 缺失时统一返回 `policy-denied`。而 Go 侧 `internal/policy` 早就把这两件事分成
   `ErrUnavailable` 与 `Allowed=false`，理由写在它的包注释里（「一次 OPA 容器崩溃会表现成全公司
   突然都没有控制权限了」）。TS 侧新增 `policy-unavailable` 拒因，并逐条对齐 Go 的判据表——
   **特别是 `result` 缺失/null 归为 unavailable 而不是 `allow=false`**（那是策略包没加载）。
2. **`ControlPolicy` 与 `ControlSeam` 的 `allowed` 语义不同，却共用一个类型**。前者的
   `allowed` 是「本层不拦」，后者是「指令已生效」。拆成 `ControlPolicyVerdict` 与
   `ControlDecision` 两个类型，结构上保持赋值兼容（本地拒绝时可以直接当结论返回，那时两个
   `false` 语义恰好重合）。
3. **未配置控制面地址时不给缺省值**。`LUMO_SESSION_CONTROL_URL` 故意没有 `?? 'http://localhost:8092'`
   之类的回落：有缺省时，一个没配这个变量的部署会去连 localhost，症状是「控制面连不上」——
   排查方向变成网络与容器名，而真实原因是「这个部署没有接线」。

### 五、部署装配与门禁

- **compose**：`cluster-a-dsh-0/1`、`cluster-b-dsh-0/1`、`dsh-web`（共 5 处）与 standalone 的
  `dsh-node` 各加 `LUMO_SESSION_CONTROL_URL=http://session-control:8092`。**刻意不进
  `depends_on`**：`dispatch` 是运行期按需调用，把它写成启动期依赖会把「控制面起不来」升级成
  「数据面也起不来」。
- **Helm**：`dshWeb.sessionControlUrl` 走显式 values；dsh-node 段在模板里拼，且**必须用
  `index .Values.services "session-control"`** —— 键名带连字符，`.Values.services.session-control.port`
  会被当成减法。
- **门禁**：`helm-verify.sh` 新增一条断言，期望值**写死**（不从渲染结果反推），计数**钉成 2**
  （少一个 = 漏接线，多一个 = 模板里复制粘贴）。反向用例已验证：把 values 里的 URL 改成 `:9999`
  → 报「1 dsh workload(s) ... expected 2」，改回即绿。

### 六、验证

- 新增 `dsh-plugins/control/__tests__/dispatch-routing.spec.ts` **18 条全绿**，用真 HTTP 假控制面
  而不是 mock `fetch`——断言的宾语是「线上真的会发出去的东西」（路径、方法、头、body）。
- 契约测试 `control.contract.spec.ts` **5 条**：新增「转发桩也通过」「控制面拒绝也算结论」两条正向
  用例，与「allowed 与 outcome 矛盾」一条反向用例。
- `helm-verify.sh` 全绿（含新增那条）；三个 compose 文件用 PyYAML 结构化核对——按**服务**而不是
  按**行**回答「谁拿到了这个变量」，6 个 dsh 服务全部命中且值正确，local 形态没有 dsh 服务。
- 受影响的 TS 子树收窄 `tsc --noEmit`（临时 tsconfig，用完即删）。

### 七、边界（明确未做）

- **Go 侧 `Dispatcher` 仍未接线**，`effectuation` 仍是 `recorded`。那是 §8.1 的 continuation +
  `agent.inject()`，`agent/turn-stopping` 的签名是 `Promise<void> | void`，**停不了 turn**。
- `dispatch` 目前**没有生产调用方**——它是契约面，控制台走的是浏览器直连控制面的 HTTP 路径。
  接线它买到的是「agent 侧可以程序化地控制会话」，不是「控制台按钮能用了」。
- 未做真集群端到端：本轮只验到「配置能到、请求形状对、响应解析对」。

## 2026-09-17 实施：双写方分诊——三处候选里两处是真冲突，另有两条只活在迁移里的语句

**一句话**：上一轮在 C5 里顺带扫出的三处「两端各写一份同一张表」，逐项核对后是**两处真冲突 +
一处刻意同源**；顺着同一条线（「迁移里的语句，服务 DDL 抄了没有」）还挖出**两条只存在于迁移、
从未进入任何服务 DDL 的语句**——在没有 Compose 文件跑 `migrate.sh` 的前提下，它们等于不存在。
分诊判据同时被做成仓库级门禁 `platform/shared/__tests__/ddl-ownership.spec.ts`。

### 一、分诊结果：只问一句「这两个写入方会不会同时在线」

| 表 | 两个建表方 | 同时在线？ | 判定 |
| --- | --- | --- | --- |
| `projects` / `project_members` / `project_artifacts` / `project_automations` | TS `dsh-plugins/project` ↔ Go `control-plane/projects` | **是**（`@lumo/project` 不在 `plugins.ts` 的 `localOnly` 名单里，standalone/cluster 都会装载；两服务共用同一个 `LUMO_PG_DSN`） | **刻意共表**，逐列比对**完全一致** → 无需改 |
| `project_spaces` | 同上 | 是 | **真冲突**：Go 有 `UNIQUE (project_id, name)`、TS 没有 |
| `usage_ledger` | TS `metering` ↔ Go `usage-ledger` | 是 | **刻意同源**：两侧都不是手写列清单——TS 直接 `import shared/manifests/usage-ledger.schema.json`，Go 在 `internal/manifest` 里 embed 同一份副本，漂移由双向字节锁（`manifest_test.go`）+ TS 的 19 列基线共同看守 |
| `task_reports` | Go `governance` ↔ Go `projects` | **是**（两个控制面服务同库） | **真冲突**：唯一分歧是 FK，而 FK 由**从不读写这张表**的那一方声明 |
| `collab_space_grants` | Go `collaborator` ↔ `deploy/migrations/002` | 同一个所有者 | **迁移伴生**，不是双写 |

**表名一样不等于冲突**——`knowledge-vault` 与 `knowledge` 就是刻意的形态分工，靠 `localOnly`
名单分流。反过来，「两个 Go 控制面服务各建一张表」看起来最不像冲突，恰恰是真冲突。

### 二、修法（四处）

1. **`task_reports` 的两份声明删掉一份**。`governance` 声明了它、还带
   `REFERENCES governance_delegation_tasks(id) ON DELETE CASCADE`，但**全仓检索零读写**；
   读写方只有 `projects`，而 `projects` 那份不带 FK。`governance` 先启动则 `projects` 的
   `INSERT` 对任何 `governance` 不认识的 `task_id` 直接 **FK 违约 500**（`task_id` 取自 URL
   路径，无任何校验）；`projects` 先启动则那条级联**永不生效**（`governance` 从不 DELETE 任务，
   级联今天根本不触发——FK 唯一活着的作用是**拒绝插入**）。DDL 归唯一读写方，删 `governance` 那份。
2. **`project_spaces` 的唯一性两侧对齐**。Go 侧原本是建表时的内联 `UNIQUE`，TS 侧完全没有。
   两侧改成**同一条具名唯一索引** `project_spaces_project_name_uq`：
   内联 `UNIQUE` 会让 PG 自动命名一个 `..._project_id_name_key`，与具名索引并存时「谁先建表」
   会留下**不同**的索引集；而 `CREATE TABLE IF NOT EXISTS` 对既有库是空操作，内联约束加不上去
   （同 002/004 的理由）。这条唯一性不是装饰——`projects` 的 `createSpace` 把 upsert 错误映射成
   **409「space conflict」**，TS 先建表时那条分支**静默失效**。另加迁移 `005`。
3. **`idx_scheduler_tasks_pending_edf` 补进 scheduler 的服务 DDL**。它此前只在
   `deploy/migrations/003_scheduler_fairness.sql` 里。服务自带的 `idx_tasks_pending` 是
   `(priority DESC, created_at) WHERE state='PENDING'`，**不含 `deadline_ms`**，服务不了
   `store.go` 那条按 EDF 排序的取任务查询——所以只跑服务 DDL 的部署每次都退化成全表扫。
4. **`collab_space_grants` 的主键修正抄进 collaborator 的服务 DDL**。迁移 002 用
   `DROP CONSTRAINT` + `ADD CONSTRAINT` 把主键从 `(space, subject)` 修到
   `(realm, space, subject)`，但服务 DDL 里没有这两条。旧 local-lite 建的库在 Compose 里
   **永远修不好**这条主键，而它是**租户隔离**缺陷（两个 realm 会在同一个 space id 上互相覆盖），
   不是格式问题。代价是每次启动 DROP+ADD 一次主键——与 `control-plane/heartbeat` 的
   `SchemaSQL` 同款做法，值得。

### 三、门禁：`platform/shared/__tests__/ddl-ownership.spec.ts`（9 条，含真 PG）

把上面这套判据从「这次查过」变成「以后自动查」：

| 用例 | 判据 |
| --- | --- |
| 扫描器自证 | 字面量表名 > 50，否则判为解析器失效（「没有规则要查」与「规则全通过」退出码一样） |
| 归属 | 同一张表被 ≥2 个**生产**文件声明时，必须在共表清单里（清单本身从源码推导） |
| 清单不过期 | 清单里每个名字都得真的被两个建表方声明 |
| 表态完整 | 每张共表要么有结构断言、要么有书面理由，不许两处都写 |
| 动态建表点 | 扫描器看不见的（表名由插值产生）必须逐个认领，且认领的表名确实在源文件里 |
| **迁移 ↔ 服务收敛** | 迁移里每条非建表语句，必须出现在**该表每一个非迁移建表方**的 DDL 里（候选排除迁移自己，否则自证成立） |
| **结构一致（真 PG）** | 两份 DDL 各建一遍，再问 PG 实际长什么样：列 / 可空 / 默认 / 唯一索引（名字+列集）/ 外键。语义比较，不维护「已知无害差异」清单 |

两个实现细节值得记：Go 的 `` `"…" + 常量 + "…"` `` 拼接要**折**掉才看得见（
`control-plane/heartbeat/heartbeat.go` 的 DDL 全是拼的，常量值从源码现场取，不手抄）；
本机 `readFileSync` 每次调用约 150ms，619 个文件串行读要 90 秒以上——所以走并发池 + 记忆化，
本机约 5 秒（见 `.workbuddy-ai/memory/local-sandbox.md`）。

### 四、验证

| 项 | 结果 |
| --- | --- |
| 新门禁 | **9/9 PASS**（含真 PG 的两条结构比较）；连跑三次无抖动 |
| 反向用例 ① | 临时删掉 TS 侧唯一索引 → **形状断言 + 收敛断言同时变红**，diff 精确指出缺 `project_spaces_project_name_uq`；还原转绿 |
| 反向用例 ② | 临时删掉 scheduler 的 EDF 索引 → **收敛断言变红**并指名 003 的那一条；还原转绿 |
| 受影响的 Go 服务 | `projects` / `scheduler` / `collaborator` / `governance` / `heartbeat` 全部 `go test ./...` 绿 |
| 受影响的 TS 套件 | `control`（8+5+2）、`metering`（31）、`project` —— **46/46 PASS** |
| 类型检查 | 收窄 include 的临时配置 → **EXIT=0，日志 0 字节**，用完即删 |

### 五、边界与仍未做

- **结构比较需要 `LUMO_TEST_PG_DSN`**：没有 DSN 时那两条 `it.skip`，describe 标题里写明
  「未设置 → 跳过，非通过」。归属与收敛两类断言不依赖 DSN，任何时候都跑。
- **两张共表没有结构断言，理由已写进代码**：`usage_ledger`（Go 侧 DDL 由清单在运行期生成，
  静态取不到；重写一遍等于用手抄的判据测另一份手抄的判据）与 `lumo_service_heartbeats`
  （`SchemaSQL = CreateTableSQL + ";" + UpgradeSQL`，两个都是非字符串常量，折不动）。
  后者有收敛断言兜着。
- **`dsh-plugins/project` 的 `addSpace` 全仓零调用方**，且没有 23505 的错误映射。加上唯一索引后
  若将来把它接上，重名会以未处理的 PG 错误冒出来。**本轮没动**——给死代码加错误处理是猜。
- **本机只跑了单机真 PG**，不是多节点集群。

## 2026-09-17 实施：C5 下发链路——仓库里有两套 §8.4，它们对不上

**一句话**：清单上「会话执行面的下发尚未接线」这句话**说错了通道**。状态型指令的下发通道
就是 PG 表 `session_control_state` 本身（`@lumo/control` 插件读它、在 `tools/pre-execute`
上执行闸门）。它不是**缺**，是**坏**——仓库里存在**两套独立的 §8.4 实现**，都用
`CREATE TABLE IF NOT EXISTS` 建同一对表，列集与状态词表却不同。先初始化的一方赢，另一方
静默拿到一张自己不认识的表；插件把不认识的状态按「没有指令」处理，于是**操作者已经暂停的
会话仍在跑副作用工具**。

### 一、取证（先让契约测试红，失败信息本身就是证据）

新写的 `platform/dsh-plugins/control/__tests__/control-schema-contract.spec.ts` 首跑
**3 红 1 绿**，逐条对应一处分歧：

| # | 分歧 | 事实 |
| --- | --- | --- |
| 1 | 状态词表 | Go 五态 `running/paused/awaiting-approval/stopped/aborted`；插件四态 `running/paused/**stopping**/aborted`。`stopping` 是**幽灵状态**——Go 的状态机从不写它（`stop` 的落点是 `stopped`） |
| 2 | CHECK 约束 | 插件建表时带 `state IN ('running','paused','stopping','aborted')`。**插件先建表 → Go 写 `awaiting-approval` / `stopped` 直接报 23514** |
| 3 | 唯一写入方 | 两侧都在建 `session_control_state` / `session_control_audit`。列集差异：state 表 Go 独有 `realm/revision/last_*/correlation_id`，插件独有 `reason/actor`；audit 表 Go 是 `id BIGSERIAL + outcome + from_state/to_state`，插件是 `request_id TEXT + allowed BOOLEAN + denied_cause` |

判据一律**从源码推导**（现场解析 Go 的 `state.go` 与 `store.go`），不手抄字符串——写死字符串的
契约测试在改名当天会静默失效，而「没有规则要查」与「规则全通过」在退出码上一样。

### 二、修法：单一写入方 + 单一词表 + 闸门 fail-closed

1. **两张共用表归 Go 唯一所有**（与 §八/§九 同一条规则）。插件的 `CONTROL_DDL` 只剩
   `session_controllers`（它自己那张 co-controller 名单）。
2. **词表以 Go 的五个为准**，删掉幽灵 `stopping`。`SESSION_CONTROL_STATES` 成为运行时
   常量，`SessionControlState` 由它派生——两侧词表从此有一个可比较的集合。
3. **执行闸门抽成纯函数** `controlGate()`（`src/gate.ts`）：`running` → 放行；
   `paused` / `awaiting-approval` / `stopped` → 只拒副作用工具；`aborted` → 全拒；
   **词表外的值一律 `deny`**。最后一条是本次修掉的**安全洞**：此前
   `awaiting-approval` 落进「不认识」分支 = 放行，即 HITL 审批挂起期间副作用工具照跑。
   与存活闸门**刻意相反**（那条对未知 fail-open，是为了不让配置问题变成全平台停摆）；
   这条 fail-closed，因为放行的代价是执行了不该执行的写操作。
4. **插件的 `dispatch()` 不再是第二个写入方**：它现在只做本地 RBAC 前置，有权时抛
   `ControlCommandRoutingError` 指向 `POST /v1/sessions/{ref}/control`。**不允许**回落成
   「已生效」——那会让调用方以为一条没人执行的指令执行了。契约里加了一条反向断言钉住它。
5. `audit()` 改为读 Go 的真实列（此前按插件自己的列名读同一张表，必然运行时报错）。
6. 顺手修掉状态缓存的**无界增长**（长驻进程里会话数只增不减，过期条目没人清）。

### 三、验证

| 项 | 结果 |
| --- | --- |
| 契约 + 闸门 + 契约断言 | **15/15 PASS**（`control-schema-contract.spec.ts` 8 条 / `opa-policy.spec.ts` 5 条 / `control.contract.spec.ts` 2 条） |
| **真 PG 端到端** | 用 Go 源码里的**真实 DDL** 建表 → 插件的 `init()` 不得改动它 → 用 Go 的列形状写 `paused` → 插件 `state()` 读回 `paused` → 闸门 `read-only`；再改 `awaiting-approval` 同样读回；陌生会话回落 `running`；审计读面拿到 `applied` + `policy_denied` 两行 |
| 反向用例 | 临时从词表删掉 `awaiting-approval` → 契约测试**立刻变红**，还原后转绿（证明不空转） |
| 类型检查 | 收窄 include 的临时配置 → **EXIT=0，日志 0 字节**（全仓 `tsc -p tsconfig.json` 在本机是已知的环境前置失败 TS6053，不是判据） |

### 四、边界与仍未做

- **`agent/turn-stopping` 不能停转**：上游签名是 `Promise<void> | void`，它只是边界通知。
  「pause 真的把 turn 挂起」仍要 §8.1 的 continuation + `agent.inject()`，**这才是
  「pause 不暂停」背后的真缺口**，本轮只把这条事实写进注释，没有假装修好。
- **`dispatch()` 的路由未实现**：现在它抛出指向控制面 HTTP 入口的错误。把
  `POST /v1/sessions/{ref}/control` 接上（含控制面 URL/token 的部署装配）是下一步。
- **`policy.ts` 的消费者变窄**：它现在只被 `dispatch` 的前置检查用到。若路由实现改为
  完全交给控制面的 OPA，这个模块应连同它的 5 条用例一起重新定位——不要让它无声地烂着。
- **本机只跑了单机真 PG**，不是多节点集群。

### 五、顺带发现：同一种「两端各写一份同一契约面」还有三处

按「`CREATE TABLE` 表名」扫全仓，除本次这对之外还有三处（`projects`/`project_*`、
`usage_ledger`、`task_reports`）。**当晚已逐项分诊**——结论是两处真冲突、一处刻意同源，
外加两条只活在迁移里的语句。见下一节「双写方分诊」。

## 2026-09-17 队列全量复核：「还剩什么没开发完」的重新取数

方法照 `stale-gap-list-reaudit`：**先做存活统计**（不逐项读，先整表查它声称缺失的符号在不在），
再对每个「疑似真缺口」取**「实现会在哪一行」**的检索证据。清单 = `cluster-development-tasks.md`
的 A–E 表 + 优先级表 + 两条跨设备行（#12/#13）。

### 一、一整类结论被活库推翻：「PostgreSQL integration verification pending」

A2 / A3 / A5 / B6 / C2 / E3 / E7 / E8 与优先级表两行都写着这条。本轮用本机**真 PostgreSQL**
（`postgres://lumo:lumo@127.0.0.1:15432/lumo`，standalone compose 那台，端口实测可连）
对**全部 15 个控制面 Go 模块**跑 `go test ./... -count=1 -json`：

| 结果 | 数量 |
| --- | --- |
| 通过 | **1193** |
| 跳过 | 12 |
| 失败 | **0** |

**跳过的 12 条没有一条是 PG**：Redis 5 条（`ratelimit`）、S3/MinIO 4 条（`registry/objstore`）、
RocketMQ 3 条（`usage-ledger/integration`）—— 这三样本机确实没有（端口探测全 closed）。
所以「PostgreSQL 集成验证」这一类可以**整体结案**；仍欠的是**别的依赖**与**真集群**，不是数据库。

⚠️ 边界必须写清：这是**单机真 PG**，不是多节点集群。`acceptance-cluster.sh` 那条链、真 `promtool`、
多节点 run 仍未跑过。**不要把这一行读成「集群验收已过」。**

### 二、真缺口（缺的是接线或实现，都有位置）

| 项 | 缺哪一跳 | 检索证据 |
| --- | --- | --- |
| C5 会话指令下发 | `Dispatcher` **故意留空** → 每条响应 `effectuation=recorded`。下发器**本身写好了**：`control.go:427` 会置 `dispatched`，`control_test.go:505` 断言过 | `session-control/cmd/session-control/main.go:164`（读的是函数体，不是包注释） |
| C5 Session Console UI | 读投影（状态 / 按钮可用性 / 时间线 / 队列）已就绪，界面零消费方 | `lumo-ui/src` 全目录检索 `session-control` **零命中** |
| C4 终端网关事件源 | `Source` 保持 nil → WS 接入返回 503。这是**诚实的**（不伪造空历史），但功能不可用 | `cmd/terminal-gateway/main.go:104-110` + `internal/server/server.go:105` |
| #12 取消 / 中断 | runner socket 契约里没有 cancel 帧，设备侧也没有对应 action | 行末记录（本文件 #12 节） |
| #12 重启恢复 | 有 inbox 记录、无回执的 run 会一直 `RUNNING` 直到超时 | 同上 |
| #12 真端到端 | 仓库里**不存在任何设备链路 e2e/验收脚本** | 全仓检索 |
| C1 全局/集群 Scheduler 分层 | 设计稿明确「留到下一轮」：真实分层要拆进程、拆配置面、拆部署形态，且与存活信号来源耦合 | `2026-09-15-multicluster-scheduling-design.md:45` |
| 语义意图识别 | `AnalyzeIntent` 的 `Method` 是 `explicit-contract-and-governed-keywords`，无 LLM | `governance/internal/domain/intent.go:83` |
| A2 cron 重启验收 / A3 seam URL 部署装配 / B1 部署验收 | 需要真环境，非代码 | 队列行 |

### 三、有意边界（补全等于替用户做产品决策）

| 项 | 为什么是取舍 |
| --- | --- |
| D1 Nebula 不进任何编排 | 产品决策；`acceptance-cluster.sh:58-66` 已把它改成**可选**探针，不再阻塞验收链 |
| E1 breakglass 内存实现 | 合规边界：接入正式审批/密钥系统前不自行赋予生产权限 |
| E7b connector 审计投影器 | **按构造不可实现**：dsh 没给平台插件留「写自定义持久事件类型」的通道，写进去会让会话重载**整份被拒**（`cluster-gap-analysis.md:424` 一带） |
| E6 append-only merger | 有意保留作接口契约的反例，删掉等于删证据 |

### 四、误读 —— 本轮的独立产出

| 既有表述 | 实际情况 | 误判的动作 |
| --- | --- | --- |
| 优先级表 P2：「edge/terminal 网关不在 Helm chart 里，`helm install` 会少装南北入口」 | `values.yaml:297-298` 两者都在且 `enabled: true`，另有 `templates/edge-routes.yaml`、secret/configmap/deployment/NOTES 全套 | **修好一处后没回写引用它的汇总段**：C3/C4 行 2026-09-16 记了「已补进 chart」，P2 段是同一件事的汇总却停在前一天 |
| C1 行：「Still open: preference scoring, version-consistency gating」 | 两项都已实现：`planner.PickWeighted`（`server/placement.go:74`）、`ClusterVersionUnproven` + `declared_version`（`domain/version_gate_test.go`）。该行**整行不含任何 2026-09-17 记录** | **同一文档两处状态不同步**：实现记在本文 §10，队列行没跟改 |
| E7b 行：「投影器从未写」 | 已改判**不做**，理由是「按构造不可实现」 | **把「有意不做」留成「未实现」**，读者会以为它要排期 |
| A2/A3/A5/B6/C2/E3/E7/E8 + P0 表两行：「PG verification pending」 | 1193 条活库用例全过，0 失败 | **把「当时本机没有库」固化成了「永远验不了」**；库一直在 15432 上跑着 |

**三条可复用的教训**：① 一处修好后，**要去改引用它的汇总段**，否则同一文档会自相矛盾；
② 实现记录写进 A 文件、状态留在 B 文件 = 必然漂移，**两边都要落**；
③ 「有意不做」与「还没做」必须用不同措辞，否则前者会被当成待办重新排期。

### 五、可排期的剩余清单（分组，组间有依赖）

1. **接线类（不需要新设计，都是「已写好、缺最后一跳」）**：C5 下发器、C5 控制台 UI、
   C4 事件源、A3 seam URL 部署装配。四者互相独立，可并行。
2. **跨设备链路（#12 收尾）**：取消/中断、重启恢复、真端到端脚本。**依赖 1 完成与否无关**，
   但 e2e 脚本要先有「怎么起 governance + registry + 模拟 Agent」的夹具，这是本组的前置。
3. **需要真集群才能验收（本机只能 SKIP）**：C3/C4/C7 的端到端探针、C1 迁移的**目标端**
   （设计稿 §9.10 第 1 条：任务置回 PENDING 后要真的落到另一集群的健康节点）、真 `promtool`、
   多节点 run、B1 部署验收。
4. **需要别的依赖才能验收**：Redis 5 条、S3 4 条、RocketMQ 3 条（本机无端口）。
5. **产品决策（不建议当待办排期）**：D1 Nebula、E1 breakglass、E7b 投影器、
   语义意图识别是否要做 LLM 版。
6. **视图层证据（#13 残留）**：`client.spec.tsx` 依赖 jsdom，三块面板的**渲染**只能靠 CI。

## 2026-09-17 跨集群偏好打分与版本一致性前置（C1 剩下的两件准入）

- **偏好打分：A4 否掉的不是「打分」，是「没定义的打分」。** 架构 §6.2 的公式
  （`w1*constraintMatch + w2*affinityGain + w3*(1-load) − w4*crossAZcost`）被评审列为
  P2，理由是不可实现——值域、归一化、`affinityGain` 从哪来、权重怎么调，四项里三项没定义。
  本轮按同一条评审的建议**逐项定义**：每项归一到 `[0,1]`；`load = clamp01(1−active/capacity)`；
  亲和优先取**显式** `preferred_clusters`（1/0），否则按「项目在本集群的活跃任务数 / 峰值」
  归一，**无输入取 0 而不是 0.5**（「没有信息」与「打平」必须分开）；**硬约束不参与打分**，
  仍在 `EligibleNodes` 里剪枝（打分是偏好，剪枝是正确性）。
- **唯一可验证的性质是「有界偏好」**：`AffinityBound = Affinity / Load`，含义是「亲和分最多
  能翻转多少负载比差」。默认 `{1, 0.25}` → 最多压过 25% 的负载差，`Affinity=0` 即退回纯负载
  最小。正反两侧都有用例，比「权重看起来合理」结实。
- **「纯增量」这句话有可执行版本**：默认权重下亲和分在没有输入时恒为 0，于是
  `PickWeighted` 与既有 `Pick` **逐字节同序**——`TestPickWeightedMatchesPickUnderDefaultWeights`
  在 6 种节点形状上比对两个函数的输出。`Pick` 现在只是前者带默认权重的封装。
- **版本一致性前置：判定集合是「放置闸门当下真正允许的集群」**（已注册 + 未被存活闸门挡住），
  不是「所有已注册集群」。这不是省事：一个已 `down` 的集群本来就不接新放置，它的旧版本不该
  让全局任务停摆，否则一次失联会连带把版本闸门也点着。三档结论里只有「≥2 个不同版本」判为
  不一致，且**整体拒绝**（含等于多数版本的那些）——滚动升级升到一半时，落到哪一边都是错的
  一半，挑「多数版本」是把发布流程的决策偷偷换成调度器的启发式。
- **只拦全局放置**（`task.ClusterID == ""`），显式指定 `cluster_id` 的不受影响。**默认关**
  （三态，打错字报错并点名变量）：打开它会把「有人在滚动升级」变成「全局任务排队」，那是
  产品决策而不是正确性修复。
- **与存活闸门刻意相反的一处**：存活闸门对未知 fail-open（拦下来会把「注册表没配好」升级成
  全平台停摆），版本闸门对未知 **fail-closed**（fleet 有版本而某集群没声明/没注册 → 不可证明
  → 排除）。放行它等于给闸门留一个**一行配置就能绕过的后门**，而绕过它的人只会觉得「这个集群
  没配上报而已」。代价不对称：前者是全平台，后者只是单个集群被排除，且随时能靠声明版本、
  指定 `cluster_id` 或关掉闸门回来。
- **【本轮最重要的发现】给 version 加一个「对称的 declared 标记」是错的。** 第一版按对称性
  给 version 也加了 `version_declared` 列 + `VersionDeclared` 字段，两个方向的代价立刻显形：
  ① `RegisterCluster(Version: "v3")`（**所有**不带新标记的写法）静默变成空操作，返回值看起来
  正常——抓到它的是上一轮就存在的一条活库用例；② `ALTER TABLE ... DEFAULT false` 把所有迁移前
  就有 `version` 的行判成「未声明」，而闸门读的正是它。判据是现成的：**「空值是不是一种有意义
  的声明」**——空能力集是（这个集群没有 GPU），空版本号不是。于是 `Version != ""` 就是那个标记
  本身。**declared 标记不是对称性产物，是「空值有语义」时才需要的东西**；version 的列、字段与
  配套函数已整体移除。
- **另一处：字段名里的「事实」与「裁决」不能混。** 第一版把「这个集群版本不可证明」叫
  `BlocksGlobalPlacement`，于是「显式指定了 cluster_id 的放置」也被拦了——那个字段同时装了
  「事实」（目录层就知道）与「裁决」（只有 planner 知道任务是不是全局的）。改名
  `ClusterVersionUnproven`，把 `task.ClusterID == ""` 移进 planner。
- **接线面（本轮花时间最多的地方）**：store 的 `ActiveClusterCountsByProjects`（一条
  `= ANY($2)` + `GROUP BY`，按 realm 隔离、只算活跃态）与 `preferred_clusters` 往返；
  server 的 `PreparePlacement`/`PickPrepared` 放在独立文件里给 HTTP 与 drain 共用（两处各拼
  一遍会漂移，而漂移方向恰恰是「drain 漏掉了亲和输入」，任何响应都看不出来）；compose 的
  `LUMO_CLUSTER_VERSION` 由**承载节点**声明（同「调度器还在跑 ≠ 集群还能接放置」那条判据），
  每集群一个变量以便本机复现「升到一半」；Helm 的 `dshNode.clusterVersion` +
  `services.scheduler.clusterVersionGate`（**刻意不默认成 `image.tag`**：节点池跑另一个镜像，
  借用全局 tag 会静默报错版本，而错版本比缺版本更糟——闸门会放行它本该拦下的混合版本放置）。
- **静态门禁补了三条规则**（`cluster-registry-check.py`）：`invalid-version-gate-value`、
  `version-gate-without-declarer`（闸门开着而整个拓扑无人声明 = **恒放行**）、
  `version-gate-split-fleet`（闸门开着而拓扑写死两个版本 = 全局放置一直排队，而它与「没有容量」
  同形）。反例自证从 6 条扩到 10 条，其中两条是 Helm 侧的 `--set` 渲染用例——它顺带证明那几个
  键真的接在模板上（键名写错时 `--set` 静默忽略，于是「闸门开着」的用例会因「闸门根本没开」
  而假绿）。
- **告警两条**：`LumoClusterVersionInconsistent`（P2，判据取闸门的结论而不是队列长度——被版本
  拦下的任务与「没有容量」同形，都是 202 + PENDING）、`LumoClusterVersionGateInert`（P3，
  「闸门开着但没有任何集群声明版本」在图上表现为**序列缺席**，而缺席不会让任何表达式变真，
  所以要单独读那个计数）。三条新序列进了 `cmd/alerts-verify` 的 `metricContract`。
- 验证：scheduler `gofmt`/`vet`/`build` 干净；单测全绿（`domain` 两个新文件、`planner` 7 条、
  `server` 4 条）；**活库套件 37 条全过**（其中 6 条本轮新增：省略即保持与标记单调性、空版本
  归一、版本闸门端到端三种状态码、闸门关闭时放行、项目亲和的 realm 隔离与活跃态范围、
  `preferred_clusters` 往返）；门禁 `cluster-registry-verify.sh` **19/0**（含 10 条反例）、
  `alerts-verify.sh` 19 条规则 + 11 条反例、`helm-verify.sh`、`compose-ports-verify.sh`、
  `edge-cors-verify.sh` 27/0、`edge-routes-verify.sh` 20/0、`probes-cluster-verify.sh` 19/0、
  `shell-portability-check.py` 21 个脚本全绿。
- **仍未验证**：① 版本闸门的端到端只走到 HTTP 放置，**drain 那条路径只有编译期保证**
  （`PreparePlacement`/`PickPrepared` 是共用入口，但没有用例真的把「HTTP 提交时带了偏好、被
  drain 接续」跑一遍）；② 偏好打分没有真实多集群数据，「更愿意留在同集群」只有构造的节点形状
  在证；③ `AffinityBound` 是上界不是调参结论，默认 0.25 是「一个可解释的小量」。

## 2026-09-17 员工设备执行链路复核与实施（队列 #12）：缺口比清单记的窄，方案 ① 当晚落地

清单原文（`cluster-development-tasks.md` 第 59 行）写「eligibility and connection checks are
present, but **dispatch transport** and end-to-end device acceptance remain open」。复核后：
前半句对，**中间那半句不准**——传输已经建好了。

- **已经建好的部分**（不是缺口）：`governance/internal/store/devices.go` 的
  `DispatchDeviceTasks`/`dispatchDeviceTask` 把 Scheduler 的 `scheduler_dispatch_outbox`
  桥成一行**不可变**的 `governance_device_commands`（`action='execute_task'`，带
  `run_id`/`attempt`/`session_ref`），且「建命令 + 认领 outbox + 置 `delivered_at` + 写审计」
  在**同一事务**内完成；`ClaimDeviceCommands` 经设备的 mTLS WebSocket 下发（每轮最多 4 条）；
  `CompleteDeviceCommand` 拥有接受与拒绝两条转移。资格与连接检查确实都在 `dispatchDeviceTask`
  的 WHERE 里（`scheduling_eligible`、活着的 `connection_expires`、`applied_revision=revision`、
  `report_error=''`、`certificate_expires>now()`、`users.status='active'`、`nodes.status='ONLINE'`、
  每设备 16 条在途上限、deadline 未过）。
- **真正缺的是最后一跳**：`registry/cmd/desktop-agent/main.go` 的命令 switch 只有
  `reconcile`/`start`/`stop`（第 765-811 行），`execute_task` 落在 switch 之外，`result`
  保持初值 `failed` + `{"error":"command_denied"}` 回给网关，于是 `CompleteDeviceCommand`
  走「本地拒绝」那条终态路径，任务以「Device did not accept the task assignment」收场。
  **这条链路今天是保证失败的**——不是「没接」，是「接到一半会稳定地失败」。
- **为这一跳写好的代码全在，但零调用方**：`taskBody`、`persistTaskInbox`、`persistTaskReceipt`、
  `taskResultPayload`、`runTaskRunner` 五个函数各自完整（不可变收件箱、run_id 绑定校验、
  结果不可变、socket 契约与 16KB/900KB 上限都在），全仓检索**没有任何调用点**；
  `-task-runner-socket` 被解析、被校验成绝对路径、然后**再没被用过**。Go 不报未使用的函数，
  所以这件事在编译期与 `vet` 下都是无声的。
- **为什么不能只把「接受」那半接上**：网关把 `completed` 读作**已接受**而不是**已完成**——
  审计事件名就是 `device_execution_accepted`，转移是 `scheduler_tasks PLACED→RUNNING`。
  而 `runTaskRunner` 是**同步**的（30s socket 期限）且返回**终态**（COMPLETED/FAILED/CANCELLED），
  `taskResultPayload` 的形状又正是 `governance_task_results.payload`。两者对不上，且**设备没有
  任何通道**能把最终结果写进 `governance_task_results`（入站只有 enroll/renew/connect/plan/blob；
  WS 上的 `result` 已被 `CompleteDeviceCommand` 的「命令结果不可变」锁死在同一 command 上）。
  只接接受半边的后果是：任务稳定地进入 `RUNNING`，而**没有任何东西能把它结束掉**——
  那是把「立刻失败」换成「永远运行」，比现状更坏。C5 那条「记了没做可对账」在这里不成立，
  因为这里写下的不是一个诚实的 `recorded`，而是一个假的 `RUNNING`。
- **所以卡点是设计决定，不是代码量**，需要在两条之间选：① 把 `completed` 定为「已接受」，
  另开一条设备侧结果上报通道（新端点或复用 WS 的新消息类型），`runTaskRunner` 改异步；
  ② 把 `completed` 定为「已完成」，那就得改 `CompleteDeviceCommand` 的转移与审计名，让接受与
  完成成为两个事件。**建议 ①**：它与既有审计名、与 `dispatchDeviceTask` 的注释
  （「Scheduler remains PLACED until the desktop confirms that the assignment was **persisted
  in its local task inbox**」）一致，且不动已经正确的那半；②要改的是控制面里已上线的接受路径。
- **口径修正**：`desktop-devices.md` 第 247 行写「设备命令只有 `reconcile`、`start`、`stop`」——
  那是**管理面能提交的动作**，不是设备实际会收到的动作；控制面内部会造出第四种 `execute_task`。
  该文件已补注，缺口清单的行与「口径差异」表也已同步。
- **仍未做**：设备侧的真实端到端验收（需要一台真实设备或一个模拟 Agent 的活体用例）。
  上面那个设计决定已于当日晚拍板为**方案 ①** 并实施，见本节末尾。
- **2026-09-17 晚：方案 ① 的设计稿已写出**（`docs/superpowers/specs/2026-09-17-device-task-result-channel-design.md`），
  待批准后实施。写稿前的侦察把这项工作从「新建一条链路」缩小成「把已有的三块接起来」，
  三个决定性事实：
  1. **设备产物已经是控制面的结果形状**：`taskResultPayload`（`main.go:240-250`）与
     `domain.TaskResult`（`domain/task_result.go:13-22`）**逐字段同构**，`Validate()` 直接可用；
  2. **结果记录逻辑已存在且已含全部围栏**：`RecordTaskResult`（`store/task_results.go:44-120`）
     有不可变重放、run/node/session 绑定、任务已关闭则拒、父任务通知；
  3. **命令行带着权威的任务身份**：`governance_device_commands` 的
     `run_id`/`attempt`/`session_ref`（`store/devices.go:41-43`）。
  所以缺的**只是「运输 + 授权绑定」**，不是数据模型、也不是业务规则。设计取「run 身份一律取自命令行、
  设备自报与之不一致即拒」——**「设备只能报自己那条 run」这条规则因此不需要新写**，
  它已经在 `RecordTaskResult` 的 `AssignedNodeID` 绑定校验里。
- **两个改变工作形态的发现**：① 设备的 WS `write` **已经过 `writeMu`**（`main.go:606-613`），
  所以异步结果上报可以安全地直接调用它，不需要新造写者；② 网关对未知入站类型是
  `default: return`——**直接关连接**（`device/gateway.go:636`），所以**上线顺序是硬约束：
  先治理面、后设备**；反过来做会表现为「设备频繁重连」，与结果通道本身无关，极易找错方向。
- **一处纠正了「先接受再报失败」的直觉**：设备**没有配 `-task-runner-socket` 时应当拒绝**
  `execute_task`，而不是「先回已接受、再异步报 FAILED」。接受一个自己做不到的任务，
  是在任务账本上写下**假的 `RUNNING`**；拒绝是一条诚实终态，可按既有重试路径重试。
  这与否掉「只接接受半」的是同一条判据。
- **顺带自查掉一个伪问题**：一度怀疑「一个 run 只能有一条结果」会吞掉重试。查 schema 后不成立——
  `governance_task_runs` 是 `id PRIMARY KEY` + `UNIQUE (task_id, attempt)`（`store/store.go:352-368`），
  **每次 attempt 是独立的 run 行**，所以 `governance_task_results.run_id PRIMARY KEY` 恰好等于
  「每个 attempt 一条结果」，语义正确，不需要改主键。
- **设计稿同时记下两处已知缺口**（实施后它们会第一次变得可观察，别当成新 bug）：
  **取消/中断**（设备命令面无对应 action、`runTaskRunner` 的 socket 契约无取消帧）、
  **重启恢复**（收件箱与回执不可变 → 重发安全，但「启动时把无回执的 run 报成 FAILED」未做，
  设备重启后该 run 停在 `RUNNING`）。
- **2026-09-17 晚：方案 ① 已实施**（三层代码 + 三套测试）。与设计稿的偏离只有下面两处，
  都写在这里：
  1. **store**：`RecordTaskResult` 的事务体提成 `recordTaskResultTx(ctx, tx, realm, *result, actor)`，
     两个入口共用；新增 `RecordDeviceTaskResult(ctx, realm, nodeID, connection, commandID, result)`。
     校验**放在共用的那个函数里**——它是唯一写结果行的地方，放调用方就有被漏掉的可能。
     实现比设计稿多一条：查询 `LEFT JOIN governance_task_runs` 取 `task_id`，
     于是设备**连 `task_id` 都不必可信**，只用于比对。
  2. **网关**：`gateway.go` 的 switch 加 `case "task_result":`（先 `AuthenticateDevice`，
     再 `Unmarshal` + `RecordDeviceTaskResult`）。**拒绝时先记日志再关连接**——这条路径的失败形态
     就是「设备频繁重连」，不记日志几乎无法归因。未知类型仍走 `default`。
  3. **设备**：`case "execute_task":` → `taskBody()` → 取执行槽 → `persistTaskInbox` →
     回 `completed`/`{"accepted":true}` → **回执写完**才起 goroutine。`taskBody` 本来就存在
     （就是设计稿 R2 说的「五个零调用方函数」之一），所以设备侧只接了调用，没新增解析器。
- **两处与设计稿伪代码不同的实现决定**：
  ① **异步 goroutine 在「已接受」那条消息真正写出去之后才启动**。设计稿把 `go` 放在 case 里，
     但共享的 `write(result)` 在循环尾部——照那样写，goroutine 可能抢在「已接受」之前发出
     `task_result`，而控制面会以「命令从未被接受」拒绝并**关掉连接**。这是顺序不变量带来的
     一条实现约束，不是风格选择。
  ② **单执行槽**（设计稿 §6 Q1 建议的那档）：容量 1 的 channel 非阻塞占用，占不到就拒绝。
     没有它，一台设备可以同时跑任意多条任务；而控制面的「每设备 16 条在途」是**投递预算**，
     不是这台机器的执行容量。
- **验证（本轮真正跑出来的）**：
  - `internal/store` 新增 5 条活库用例：未接受不得记结果、身份取自命令行、不能写别人的 run、
    连接围栏五连拒（连接号 / 连接过期 / revision 漂移 / 节点 REVOKED / 用户停用）、
    非任务命令与孤儿 run。同时断言父任务 `child_result` 通知只发一次——**这一条才证明设备路径
    真的复用了整个事务体**，而不是自己又写了一条 INSERT 绕过不可变性。
  - `internal/device` **从零建起测试夹具**（生成 CA、服务器证书、设备证书、SPIFFE SAN，
    `httptest` + mTLS + WS 客户端）。一条用例同时钉住：`task_result` 真的被路由进库、
    任务进 `VERIFYING`、审计 actor 是 `device:device-a`，以及**未知类型仍然关连接**。
    这个包此前**没有任何测试文件**。
  - `registry/cmd/desktop-agent` 新增 4 条单测，其中一条**逐字钉住 `taskResultPayload` 的键集合**
    ——那是整份设计最吃重的假设（R7），跨 Go 模块没法用类型钉，只能用线协议钉。
  - governance 与 registry 全模块回归全绿。
- **测试夹具顺带发现一处既有耦合**：`ConnectDevice` 会去重开 Scheduler 的
  `scheduler_dispatch_outbox`，而 **governance 自己的 `Init()` 不建那两张表** —— 设备通道
  **不能只靠 governance 的 schema 跑起来**，它假定与 Scheduler 共库。真实部署是共库的，
  所以不是缺陷，但它是一条**没有写下来的前提**；夹具里补了最小 DDL 才跑通。
- **仍欠（不要读成端到端已验收）**：设计稿 §5 第 4 步的**真端到端**（起 governance + registry +
  一台模拟 Agent，投一条真实 `execute_task` 并断言全链路）**没有夹具**——仓库里不存在任何
  设备链路的 e2e/验收脚本。本轮证据到「网关 WS 面 + store 面 + 设备侧纯函数」为止。

## 2026-09-17 控制台意图 / 进度 / 证据视图（队列 #13）：四层全部落地

四层核对（数据模型 / 读面 / 代理 / 视图）的结论与实施：

- **目标纠正（这条最重要）**：「控制台」**不是** `platform/console` —— 那个静态页**已被有意退役**
  （`index.html` 只剩一条迁移提示；退役原因是它在浏览器里直连控制面并发送可伪造的身份头）。
  真正在用的运维面是原生 DSH Web 的 `/lumo/ops`，实为 **302 到 `/?lumo=operations`**
  （`dsh-plugins/lumo-ui/src/index.ts`），即 DSH Web SPA 内的客户端面。
- **前三层都已存在**：意图是 `governance_delegation_tasks.intent_contract`；子任务进度是
  `GET /v1/tasks/{taskID}/collaboration`（`server/server.go:163`）；证据是
  `GET /v1/tasks/{taskID}/runs/{runID}/result`（`server/server.go:164`）；受理是既有的
  `complete`/`reject`/`archive` 事件加 `business_state` 的 VERIFYING/IN_REVIEW/DONE/REJECTED。
- **缺口只在代理层的两条路由**（已补）：`/lumo/api/tasks/{id}/collaboration` 与
  `/lumo/api/tasks/{id}/runs/{runID}/result`。补之前 `collaboration` 在
  `lumo-ui/src/index.ts` 里**一次都没出现过** —— 前端能取到的路径集与后端有的路由集，
  求差就是真实工作量，而这个差集只在这一处看得出来。
- **代理比控制面更窄**（既有行为，非本项引入）：`safeID` 只接受 `[A-Za-z0-9._-]{1,128}`，
  而 store 的 run id 还允许 `:` → **含冒号的 run id 在运维面上取不到**。它与其他任务路由共用
  同一个校验，所以行为是一致的，但这类约束平时只在生产里以 400 的形式暴露。
- **证据**：新增 `__tests__/task-evidence-proxy.spec.ts`（4 条全过）钉住两条新路由、
  **未被遮蔽**的 `/runs` 列表路由（新正则少一段，不能把列表吃掉）、以及代理拒绝的标识符。
  **本机跑 vitest 很慢**（一次 2m46s，其中 `import` 阶段就占 110s，`tests` 只有 65ms），
  另用 Node 直跑同一份逻辑做了独立复核（5 条全过）。
- **仍欠**：**视图层本身** —— 三块面板（意图契约 / 子任务进度 / 证据全文）尚未构建，
  所以运维面现在**还看不到**这两条路由能取到的东西。另注意 `client.spec.tsx` 依赖 jsdom，
  **本机根本跑不了**（见 `.workbuddy-ai/memory/local-sandbox.md` §3），视图层只能靠 CI 反馈。

### 视图层（同日晚补完）

三块面板落在 `dsh-plugins/lumo-ui/src/client/cluster-panels.tsx`，由 `index.tsx` 的
「执行详情」面板（原来叫「历史」，因为它现在装的东西比 Run 列表多得多）装配：

- **意图契约 `TaskIntentContractPanel`**：**不需要新请求**。治理面的任务读面
  （`store.go` 的 `delegationSelect`，`/v1/delegations` 与协作面共用它）本来就把
  `intent_contract` / `rationale` / 标签与技能 / `score_breakdown` / `schedule` 一起返回，
  只是客户端 `DelegatedTask` 接口从来没声明过这些列 —— 于是运维面看得见任务、看不见它
  当初承诺了什么。**这是本轮唯一一处「后端早就有、前端看不见」的缺口，加字段即可。**
  契约缺失时如实说「任务行未携带契约字段」，不拿今天的默认值补一个看起来完整的契约。
- **子任务进度 `TaskCollaborationPanel`**：吃 `summary` 的六项计数与 `children`。
  两处诚实标注：`has_more` 为真时说明列表被截断而计数是全量口径；`unresolved > 0` 时用
  error 样式再说一次「列表可能只列出其中一部分」。子任务的「查看执行」按钮**找不到对应
  任务行时明说找不到**（子任务未必在操作者的可见目录里），不做成静默无反应。
- **执行证据 `TaskEvidencePanel`**：`output` 在治理面是 `json.RawMessage`，落到客户端可能是
  对象 / 数组 / 字符串，也可能是 `0` / `false` / `""`。所以判空抽成导出的纯函数
  `readTaskOutput`，**用 null/undefined 判断而不是真值判断** —— 真值判断会把数值 0 和布尔
  false 渲染成「没有产出」，而面板的措辞是一句确定的话，操作者不会怀疑，只会以为执行真的
  没交付东西。全文放 `<details>` 里（1 MiB 上限的输出不展开就不布局）。
- **两条读面各自降级**：协作面要求 `task:delegate` 权限，缺权限时只有这一块不可用，
  Run 列表与审计照常显示。用 `optionalApi` 保留真实原因，不渲染成空列表。
- **证据**：`__tests__/task-evidence-panels.spec.ts`（3 条全过，node 环境，**本机能跑**）
  钉住 `readTaskOutput` 的判空口径与 pretty-print；`tsc -p tsconfig.json --noEmit` 干净。
- **跨语言字段名契约**：新增 `governance/internal/domain/console_contract_test.go`。
  Go 的 json tag 与 TS 面板的字段名之间**没有编译期约束** —— 改一个 tag，Go 侧照样绿，
  面板只是把值读成 `undefined` 然后显示「未记录」。该测试 marshal 一个填满的
  `CollaborationProgress` 再逐层断言键名，**并用一次真实的改名做过反向用例**
  （`has_more` → `hasMore` 确实 FAIL，还原后 PASS），确认它不是空转。
- **仍欠**：`client.spec.tsx` 依赖 jsdom，**本机跑不了**，三块面板的**渲染**没有本机证据，
  只能靠 CI；面板的交互（点「查看证据」后的实际渲染）同样只有类型检查与纯函数用例覆盖。

## 2026-09-17 connector 审计的会话归属（队列 #7 / E7b）：① 修好，③ 改判为不做

复核 E7b 时发现它不是「缺一个投影器」，而是**缺三件，投影器排在最后**。本轮修掉第一件。

- **第一件：源头根本没带会话。** `connector_invoke` 的 `execute(args, _exec)` 把执行上下文丢掉了，
  `ConnectorClient` 的身份头里也没有 `X-Lumo-Session`；而网关的 `audit.Record.SessionID` 正是
  从那个头取的（`cmd/connector-gateway/main.go:59`）。于是 **`connector_audit.session_id` 恒为 NULL**。
- **第二件因此是「队列结构性为空」。** `idx_connector_audit_pending` 的谓词是
  `projected_at IS NULL AND session_id IS NOT NULL`——该列恒 NULL 时它**零匹配**。
  也就是说：**先做投影器会得到一个永远没有活干的投影器**，它会启动、会绿、什么也不做。
  这与 D5 那个「步骤全跳过却报通过」是同一类失败，所以顺序不能颠倒。
- **顺带暴露一条同源后果**：E7（connector 审计查询面，2026-09-15 判为已闭合）里 `sessionId` 过滤与
  `idx_connector_audit_session` 也**恒不命中**。不是查询写错了，是那列从来没被写过。
  **「查询面闭合」不等于「查询能命中」**——补读面时若只验「有没有路由、有没有索引」，
  就会漏掉这一层。
- **修法（只动 TS 侧，Go 一行不用改）**：`connector_invoke` 从 `exec.agent.session.id` 取会话 ref，
  `ConnectorClient.invoke()` 带上 `X-Lumo-Session`。网关早就读这个头、缺省回落 `"system"`，
  所以这是**把一条已存在的契约接上**，不是新增协议。
- **头的取值是三态而不是两态**：有值 → 发；没有 → **不发**（让网关回落 `system`）；
  **空白串 → 也不发**。第三态是刻意的：发空串会让网关两侧的 `def(..., "system")` 拿到一个
  「看起来有会话」的值，排查时比 NULL 更难看出真相。四条用例把三态与 `webFetch` 都钉住。
- **一个上游边界要先知道**：通用 `/web/fetch` 那条路**做不到**，因为 dsh 的 `WebFetchRequest`
  只有 `{ url }`（`packages/web/web/src/types.ts:64`），provider 拿不到会话。要么接受它一直是
  `system`，要么先改上游接口——**这是上游决策，不在本仓库单方面能补的范围**，故只把参数位留出来。
- **第三件（投影器）同日改判为「不做」——不是没时间，是按构造不可实现。** 原判断写的是
  「`SessionEventMap` 可 merge-extensible、插件 `declare module` 即可，`ignorable: true` 是兼容机制，
  **不需要改 harness**」——**这段是错的**，当晚沿「声明 → 写入 → 持久化 → 重载」四段走完才发现：
  - **写不出来**：`Session.append(type, data, …opts)` 构造的封套是
    `{type, seq, time, data, ...surfaceMetadata}`，`opts` 只可能带 `surfaceOp`/`sourceEventSeqs`
    ——**没有 `ignorable` 的位置**（`packages/core/session/src/index.ts:710`；桌面运行时里同一实现见
    `desktop/dist/…/dsh-session/lib/index.js:1444`）。`declare module` 只让 TS 通过，改不了这件事。
  - **不写它会让会话永久打不开**：`KNOWN_SESSION_EVENT_TYPES` 由
    `deepseek-harness/scripts/gen-persistence-catalog.ts` 扫 `packages/*/*/src/**` **生成**，
    平台插件按构造不在其中；持久化读路径对「不认识且无 `ignorable`」的事件
    **拒绝整份日志**（`session-persistence/src/storage-contract.ts:75`）。
    即：照原设计实现，**每一个调用过连接器的会话都会在重载时失效**。
  - **登记成已知类型更坏**：那会把纯信息性事件变成 required-on-read，任何没打这个 patch 的构建
    （含上游桌面）都读不了它。上游架构笔记明说「按挂载插件登记事件名」被否决，理由是它让读取
    依赖读者的组装结果（`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`）。
  - **而且不需要**：会话侧 `connector_invoke` 的 `tool/call`+`tool/result` 本就是 surface 事件，
    结果里已带 `status`/`durationMs`/`redacted`/`error`/`code`/`retryable`；网关侧
    `GET /audit?sessionId=…` 给出权威记录（含 `Entry.ID`）。两条路都已到位。
  - **第二件随之成为无写入方**：`projected_at` 与 `idx_connector_audit_pending` 恒空。按 E6 的先例
    **保留但把边界写进代码**（删列要动已上线的表，且错的是它期待的写入方不存在，不是列本身）——
    三条否决理由 + 两条替代路径落在 `internal/audit/audit.go` 包注释，`internal/audit/query.go`
    的 `Entry` 注释也一并改掉（原文写「投影器尚未落地」，会让人以为只是还没做）。
  - **残留一处（不阻塞、需单独拍板）**：工具结果里没有审计行 id，两侧目前只能按
    `(session_id, operation, 时间)` 近似对应。要精确对应得让 `Sink.Write` 回传 INSERT 的 id
    并在调用响应里透传——那会改一个**已上线**的接口，属独立决定。
  - **教训**：上一版错在只核对了链条的一段——查了「能不能声明」（类型层）与「注释怎么说」（意图层），
    没查「写侧能不能把标记写出来」与「读侧认不认」。**判一条跨层链路通不通，四段都要走完。**
- 验证：`dsh-plugins/connector` **5 条用例全过**（1 条既有 + 4 条新增）；
  `connector-gateway` 的 `internal/audit` + `internal/server` 用例全过、`go build ./...` 干净
  （本轮只改注释与文档，Go 侧零逻辑改动）。

## 2026-09-17 顺手发现：插件测试文件从来没被类型检查过

为验证 #7 的改动跑全仓 `tsc -b --noEmit`，撞到两件事，第二件比第一件重要。

- **第一件是环境前置，不是代码错**：CI 里写着（`.github/workflows/ci.yml:65-70`）平台 typecheck
  需要先构建 host 的 `lib/types`（`tsc -b tsconfig.host.json`），否则「平台 typecheck 会全线 TS2307」。
  本机直接跑 `tsc -b` 因此**不是干净的判据**——本次的失败形态是 TS6053
  （`shared/seam-contracts/__tests__/mtls.spec.ts` 报「not found」，而该文件确实存在、可读、
  未被本次改动触碰），同属「缺 host 产物」这一类。**结论：判断某次改动是否引入类型错误，
  不能只看全仓 typecheck 的红绿。** 本次的替代判据：用一份把 `include` 收窄到
  `dsh-plugins/connector/src/**` 的临时 tsconfig 单独编译，**exit=0 且无输出**（临时文件用完已删）。
- **第二件是真缺口**：`platform/tsconfig.json` 的 `include` 里写的是
  `dsh-plugins/*/tests/**/*.ts`，而**实际约定是 `__tests__/`**——全仓 27 个插件里
  **25 个用 `__tests__/`、只有 2 个（`provenance` / `recovery`）用 `tests/`**。
  那份 glob 因此只匹配到 3 个测试文件，**其余插件的测试文件从未被任何 tsconfig 覆盖**
  （`grep __tests__ tsconfig*.json` 零命中），而 vitest 走 esbuild **不做类型检查**。
  于是「测试文件里的类型错误」在任何地方都不会被发现。
  这与 CI 那个「按模块枚举 DSN 导致 7 个模块静默跳过」是**同一种病：手写枚举腐烂**——
  写的时候是对的，约定变了以后没有人再回来看。
  **本轮不动它**：把 glob 补成 `__tests__` 会立刻让 25 个插件的测试文件进入类型检查，
  大概率一次性冒出大量既有错误，那是一件独立的、需要单独排期的工作，不是顺手能带的。

## 2026-09-16 入口网关 CORS 接线的门禁（把「能用」的错配变成可判定的）

- 补 chart 时顺带修掉的那处 CORS 错配（`compose.cluster.yml` 设了中间件读的变量、没设二进制真正读的那个）暴露出一类**没有门禁能看见**的缺陷：两层 CORS 语义不同（`gate.CORS` 按**请求的 Origin** 裁决、observability 中间件按**配置的来源**写死 ACAO），各自都对，错法只在跨文件对照上，而**症状是「能用」**——中间件那层替边缘层把 preflight 答了。修完两处接线之后，同样的错法下次仍然无人拦，所以补的是门禁（`platform/deploy/edge-cors-verify.sh` + `edge-cors-check.py`），与 `cluster-registry-verify.sh` 的「判定开着却没人自报」同源。
- **判据从代码推导，不是写死的字符串**：白名单变量名取自 `*/cmd/*/main.go` 里含 `"cors-origins"` 那一行的 `envOr(...)`，中间件变量名取自 `observability/metrics.go` 里 ACAO 写入点往上最近的 `os.Getenv(...)`。推导不出来（旗标改名/删除、ACAO 锚点漂移、锚点附近出现多个变量）一律**报错**而不是放行——「没有规则要查」与「规则全都通过」在退出码上完全一样。两条反例专门钉这件事：把代码侧旗标改名必须报 `cors-rule-not-derived`；把白名单变量改名，门禁报出的必须是**新名字**（报旧名字说明它其实在比对写死的字符串，那它在代码改名当天就已经失效了）。
- **覆盖是遍历而不是点名**：所有 `compose*.yml` 过一遍（定义了网关的必须满足接线规则，没定义的必须打印「未做网关检查」——沉默的通过与核对过的通过不是一回事），Helm 面同时看基础 profile 与配了来源的 profile。GitHub Actions 的 `production-gates` 里加了对应步骤。
- **两处判据是写这个门禁时才想清楚的**，都属于「看起来对、语义错」：① Helm 基础 profile 默认 `console.corsOrigin: ""`，渲染出的边缘白名单就是**空串**——那是「没配来源 = 不放行任何跨域」的 fail-closed 默认，**不是**缺陷，所以「必须非空」的要求绑定在「部署里确实配了来源」这个配置事实上；② 而「配了来源」的证据**只能**取自共享 ConfigMap——容器里那行 `LUMO_CORS_ORIGIN: ""` 是**覆盖**，把覆盖读成「没配来源」会让「模板丢了来源回退、渲染出空白名单而中间件那层仍开着」这种真实缺陷被判成 fail-closed 默认（实测踩到过一次，反例 8 现在钉住它）。
- **写检查器时抓到的两个解析盲区**（都是「漏看」而非「误报」，后果与「没问题」无法区分）：服务键带**尾随注释**（`  embedding:   # TEI …`）时整条被漏掉；服务写成**单行 flow mapping**（`vault: { image: … }`，`compose.cluster.yml` 里真实存在）时整条读不到 env。前者让 `compose.local.yml` 只解析出 1 个服务（真值 8），后者让 cluster 少一个服务。现在解析器认全三种形态，并有一条「形如服务键却没被收进来」的主动守卫。
- 验证：`edge-cors-verify.sh` **27 项通过 / 0 失败**（其中 12 条是必须被抓住的反例、2 条是 flow mapping 形态的正负配对、1 条是「本面不含网关时必须说明未做检查」，其余是真实拓扑上的正向核对；每条反例都断言**报出预期的那一条**文案，不是只看退出码）；`helm-verify.sh` / `edge-routes-verify.sh` / `compose-ports-verify.sh` / `cluster-registry-verify.sh` / `shell-portability-check.py` 全部保持通过；`platform/deploy/*.sh` 的 `bash -n` 全量通过。写这个脚本时又踩了一次本仓库记录过的 bash 3.2 坑（`ok "$name（…）"` → 全角括号紧贴变量展开 → 本机报 `name: unbound variable`、CI 的 bash 5 却正常），已改为 `${name}（…）`。



- 逐点核对九个接线面时发现 `edge-gateway` 与 `terminal-gateway` **只在 Helm 这一面缺席**（其余八面齐全），而 `templates/configmap.yaml` 早就为 terminal-gateway 写了 `LUMO_OPA_URL`——配置面一直在假定它存在。补进 chart 不是加两行：
- **路由表是渲染出来的，不是抄来的**（新增 `templates/edge-routes.yaml`）。上游主机名从 release 名派生、端口从各服务自己的 `port` 派生。抄一份 `edge-routes.dev.json` 是显而易见的做法，而它错两次：路由包要求白名单与 `url.Host` **精确相等**，写死的 `<name>-flows:8087` 在第二个 release（文档明写同命名空间可装 `lumo` 与 `lumo-b`）下**全数失效**；写死的端口在有人改 `services.flows.port` 后会静默指向旧端口——加载通过、启动通过、第一次匹配到该前缀的请求 502。指向未部署或已停用的服务在**渲染期**就失败。chart 的白名单由路由派生（与手写清单相比少一个拼错主机的地方），但仍被校验——「由构造保证」正是最容易腐化的那种断言。
- **挂载用目录、不用 `subPath`**：subPath 收不到 ConfigMap 更新，网关的 SIGHUP 热重载会一直读到 Pod 启动时那份字节，等于该功能在部署里是死的。
- **暴露与否仍归运维**：全局 `service.type` 保持 ClusterIP，入口服务可各自覆盖。另一个杠杆（翻全局）会把**全部 12 个**服务一起暴露，含本不该可达的内部面。是否再前置 Ingress 仍是 D3 的产品决策，本次没有替它决定。
- **签名密钥沿用与 bearer 相同的 lookup-and-reuse 铸造**：空签名密钥不会让进程退出，而是让每个敏感动作 fail-closed 且日志读起来像权限问题，所以在渲染期就要求名字；跨升级复用比 bearer 更要紧——轮换会让在途签名全部失效。
- **加进 chart 等于加一道运行期门槛**：`LUMO_REQUIRED_SERVICES` 从 `services` 键派生，每个 charted 服务必须上报心跳，否则就绪闸门永不开门。两个网关都上报（`heartbeat.StartPg`，服务名 `edge-gateway` / `terminal-gateway`）——这一点是**先核实再补**，不是假定。
- **门禁**：`helm-verify.sh` 的 chart 覆盖度检查（遍历仓库树取控制面模块全集 vs chart 的 `services` 键集）现在无豁免名单，两侧各 12，恒等；新增路由表交叉校验（每条路由的上游必须等于**同一次渲染**出的 Service 的主机与端口）+ 五个反例（端口漂移跟着走 / 指向已停用服务被拒 / 空表被拒 / 非 map 的条目被拒 / per-service 类型只暴露那一个）。`edge-routes-verify.sh` 现在也验**第二张被部署的表**——把 chart 渲染出来的路由表喂给网关自己的校验器，因为此前 chart 侧只有结构断言、而「加载」是网关启动时唯一真正做的事。
- **写这段时踩到的两个静默坑**（都记在现场注释里）：① 连字符服务键**不能用点号访问**——`{{ .Values.services.terminal-gateway.enabled }}` 被 Go 模板读成减法，报 `bad character U+002D`（点名的是列号不是键名）；此前没有模板引用过任何连字符键（都是 `range` 成 `$name`），所以这个坑一直没被触发。② `| quote` 对**大于等于 1e6 的数字**输出科学计数法——Helm 把 values 里的数字解码成 float64，默认 `maxBodyBytes: 1048576` 渲染成 `"1.048576e+06"`，Go 侧 `ParseInt` 失败后**静默回落内置默认值**，而那个默认值恰好相同，于是缺陷在有人设成 `2000000` 之前完全看不见。修法是 `{{ int ... | quote }}`。
- **顺带修掉一处注释与部署互相矛盾**：`gate.go:122-124` 明确要求部署 edge-gateway 时**不要**设 `LUMO_CORS_ORIGIN`（两套 CORS 层语义不同：中间件按配置的来源写死、边缘层按请求的 Origin 裁决），而 `compose.cluster.yml` 恰恰设了它、且**没有**设二进制真正读的 `LUMO_EDGE_CORS_ORIGINS`——于是边缘自己的白名单一直是空的、边缘层等于没管事。因为中间件那层替它把 preflight 答了，表现上「能用」，没有任何门禁能看出来。已改为只设 `LUMO_EDGE_CORS_ORIGINS`。
- **当时唯一未做的那一项已补**：真集群端到端验收。`acceptance-cluster.sh` 对 C3/C4 零探针，现已由独立的行为探针层覆盖，见下一节。

## 2026-09-16 集群行为探针：把「验收」从文档承诺变成可执行的东西

- **要解决的分工问题**：`smoke-cluster.sh` 只回答「进程活着吗」（`/healthz` 2xx）。它能通过的部署可以同时是错的——路由表没挂上、特性没装配、上游名字写错。C5 的 OPA 绑定地址就是实证：**服务全部健康、策略评估对兄弟容器一律连不上**，而当时没有任何一条探针会去看这件事。新增 `platform/deploy/probes-cluster.sh` 回答第二问：「活着的进程做的是不是它该做的事」。
- **探针目标从拓扑派生，不写名单**（`platform/deploy/lib/probes.sh`）：被测集合 = `compose.<shape>.yml` 里容器端口落在控制面段（默认 `8080-8099`）的服务。新增一个控制面服务会自动多一条探针；服务改名或从拓扑里消失会报 `probe-targets-not-derived`，而**不是静默少跑一条**。`smoke-cluster.sh` 里原本那 10 行手写的 `wait_http` 一并改为派生（现在 cluster 形态 13 条）——手写名单腐化的方向恰好就是它想防的那一个。
- **区分「服务不存在」与「服务存在但行为不对」**：前者是 curl 传输错误（exit 7/28/6），后者是 HTTP 4xx/5xx。两者退出码都非零，所以每条探针报的是**分类文案**而不是状态码。同理 `probe-feature-not-assembled` 与 `probe-service-absent` 是两条不同的结论，处置方式完全不同（看容器 vs 看那个特性有没有进这一版二进制）。
- **探的是行为**：① 端到端链 `edge-gateway → terminal-gateway`；② edge `/v1/routes` 已加载的路由非空（网关只拒绝「加载失败/校验失败」，**空表是合法输入** → 每个请求 404 而进程健康、日志干净）；③ terminal `/v1/terminals/<ref>/presence` 的形状；④⑤⑥ 三条**装配证据**指标：`lumo_flow_lineage_projector_enabled`（C7）、`lumo_scheduler_task_migrations_total`（C1 漂移）、`lumo_session_control_forced_releases_total`（C5）。指标要断言的是**序列存在**而不是取值——0 是「装配好了但还没触发」，缺席只可能是「这份二进制没带这个特性」。
- **一处判据缺陷：把「当前接线进度」写进了验收标准。** 端到端链的终态取决于 terminal-gateway 有没有事件源（`server.go:106-113` 未配时回 `503 no_event_source`；`server.go:124-127` 已配时普通 GET 在 `ws.ValidateUpgrade` 被拒为 `400`；只有带 Upgrade 头的真握手才是 101）。第一版判据只认 503，于是**事件源接线落地的当天，这条探针会对着一个正确的部署报红**——而那正是 C4 清单上排期中的下一步；遇到假警报的人通常会把探针改弱，而不是去查接线。已把两种形状都判为通过，真正抓的是第三种：**非 WS 请求拿到 2xx**（§8.2 禁止的「伪造空历史」：终端会把「我们没在采集」读成「这个会话本来就没有事件」）。
- **门禁 `platform/deploy/probes-cluster-verify.sh`：19 项通过 / 0 失败。** 用 python3 标准库起 5 个假 HTTP 服务，逐条注入「上游不可达 502 / 令牌不一致 401 / 路由缺失 404 / 终端伪造空历史 2xx / 路由表空 / presence 形状变 / 特性未装配 / 缺失令牌退出码 64」等现场，断言的是**报出来的是不是预期那一条**（只断言「非零退出」等于给「判据被换成另一条」留后门）。另有两条正向（全绿 / 已配事件源）、两条探针自身的守卫（改名要红、拓扑无控制面端口要报派生失败）与五条**派生对照**（cluster 13 / standalone 12 写死对照；容器端口挪出控制面段要跟着变；新增服务要自动多一条；长语法端口项要报「不可判定」而不是静默跳过）。
- **写门禁时真抓到两条实现缺陷**，两条都只在假服务上暴露得出来、且结论都指向反方向：① `$?` 在 `if` 之后被重置 → 所有传输失败都报成 `transport:0`（把「服务不在」误报成「连上了但状态码 0」）；② `metric_value` 只认带标签的序列行 → **无标签的 gauge 一律被判成「没装配」**（C5 的三条正是无标签 gauge）。另有两个 bash 坑沿用本仓库的既有记录：`fail` 绝不能在命令替换里调用（子 shell 里的计数加不到父 shell，会「打印 FAIL 却退出 0」），`set -e` + `pipefail` 下零匹配的 `grep | wc -l` 会静默退出（已改纯 bash `string_count`）。
- **真二进制实测（不是只有假服务）**：把 `edge-gateway` 与 `terminal-gateway` 两个真二进制跑在本机、宿主端口与 `compose.cluster.yml` 完全一致（18080 / 18091），直接对**真实拓扑文件**跑探针——探针 1/2/3 三项通过，包括端到端链与「诚实 503」的判定；事件源换成 `--mem-events` 重跑，探针 1 正确地改判为「已配事件源」那一条通过文案（**这就是上面那处判据缺陷的实证：改之前这里会红**）。另三条指标探针正确地报 `probe-service-absent`（本机没有跑 flows / scheduler / session-control）。**仍未做**：在真 compose 集群里取得一次「6 条全绿」的运行——本机 Docker 守护进程在跑，但平台服务镜像未构建，这一条与 D5 的「仍欠一次真机证据」同档。
- **接进 CI**：`production-gates` 新增 `probes-cluster-verify.sh` 一步；`bash -n` 的全量清单加上 `platform/deploy/lib/*.sh`——共享库的语法错误在检查主脚本时是看不见的，它只在被 `source` 的那一刻炸。`shell-portability-check.py` 的扫描面同步扩到 `lib/*.sh`（扩面之前它已经抓到 `lib/probes.sh` 里两处全角标点紧贴变量展开的写法：`$env_file）` / `$topology（`）。
- 验证：`probes-cluster-verify.sh` 19/0；`shell-portability-check.py --self-test` + 全仓扫描通过（21 个脚本）；`platform/deploy/*.sh` 与 `lib/*.sh` 的 `bash -n` 全量通过；`helm-verify.sh` / `edge-routes-verify.sh` / `edge-cors-verify.sh` / `compose-ports-verify.sh` / `cluster-registry-verify.sh` / `alerts-verify.sh` 保持通过。

## 2026-09-16 跨集群任务漂移（C1 剩余的下半）

- 架构 §7.4.1 的「集群失联 → suspect → down → **任务漂回全局 Task Bus 重放置**」此前只做到判定与闸门，漂移本身在 09-15 那轮被显式推迟（不可逆动作，且要先确认 fencing）。现按 `down + grace` 触发闭合：把失联集群上的活跃任务置回 `PENDING`、清空 `node_id` 与 `cluster_id`，交给既有放置路径重新落位。
- **动作是「解除绑定」而不是「挑目标集群」**：`cluster_id` 清空即回到「任意集群」的退化形态（`planner.go:42` 的过滤以非空为前提），失联集群的节点又已被放置闸门挡住，于是任务自然落到健康集群。**选哪个集群是放置的事**——偏好打分仍在范围外，在漂移里加一个目标集群参数等于让打分逻辑偷偷长在搬家逻辑里。
- **fencing 不需要新机制**：`attempt` 刻意不在漂移时推进，原节点用旧 attempt 回报终态时过不了 `CompleteTaskAttempt` 的「仍处于活跃态 **且** attempt 相等」两个条件。真库上做了**对照实验**（同一库、同一代 attempt、同一份回报：被漂移的不生效、未漂移的生效），差别只能来自漂移本身。
- **两处诚实补偿**：① `avoid_nodes` 追加原节点——上面的 fencing 只在**回报**层面成立，它拦不住原节点物理上仍在执行（判据只能确认「目录里没有它」，那不等于「它停了」），若集群随后恢复而任务被放回同一节点就是实打实的双执行；② **作废该 attempt 的未认领派发**——`ClaimDispatch` 只看 `node_id + claimed_by IS NULL + delivered_at IS NULL`，**不看任务状态**，所以未认领的旧派发行会在漂移之后把执行请求投回原节点，那是绕过 fencing 的后门（`RequeueStaleDispatch` 的 EXISTS 守卫只管得住已认领那半边的回收）。物理层面的重复副作用最终由 R2 的 turn 级恢复契约兜底。
- **五道闸门**（与 `max_stall` 收割同形状）：leader / 注册表可读 / 目录快照新鲜 / 集群越过 `down + grace` / **原节点不在快照里**；落库侧还有条件写的三个条件（状态仍可漂移、attempt 仍是那一代、集群仍是那一个），任一不成立就什么都不做——含不写台账。`CANCELLING` 被刻意排除在可漂移状态外：漂走它等于**丢掉那次取消**。
- **须记住的形态边界**：闸门「原节点不在目录里」在 Nacos 形态**恒满足**（目录只返回健康实例），在 **Pg 形态恒不满足**（`scheduler_nodes` 只增不减）→ 漂移在 local-lite 下不会动作。这是**正确**行为：Pg 形态即单集群形态，没有第二个集群可搬，与 C2/R8 的「local-lite 下 `task_lost` 恒为 0」同源。多集群必然用 Nacos。
- **一处偏离已写明**：`LUMO_MIGRATE_GRACE_MS` 默认 **300000（5min）** 而不是 0。`down` 只能回答「多久没自报」，回答不了「为什么」——集群真挂了与**自报方重启**（滚动更新 / OOM）在那一列上完全一样，而误搬家的代价远高于晚搬几分钟。`grace=0` 即回到架构字面；`LUMO_MIGRATE_MS` 为负整体关闭（关闭时必须在日志里说出来）。
- 新指标 `lumo_scheduler_task_migrations_total{outcome}`（搬了多少次、跳过了多少）与 `lumo_scheduler_voided_dispatches_total`（拦下多少条本该投给原节点的执行请求）；告警 `LumoClusterTasksMigrated`（class `node_down`，P3/info——搬家是系统按设计的正确动作，不需要叫醒值班，但它必须出现在复盘里）；同时修正 `LumoClusterStoppedReporting` 描述里已经过时的「已有任务不会被搬走」。
- 验证：活库套件 **155 PASS / 0 FAIL / 0 SKIP**（新增 16 个用例函数在真库上逐条确认执行，未被跳过计数掩盖）；时间线十点逐点断言 + 一条不变量（任意 `grace ≥ 0` 下「允许漂移」都蕴含「判定为 down」，把「在 suspect 档漂移」整个类别排除）；`gofmt`/`vet`/`build` 干净；`alerts-verify` 通过（17 条规则 / 17 段表达式 / 11 个反例全被抓住），两个新指标名因此被证明确有写入点。**单进程端到端实测通过**（真进程 + 真 PG + 真失联集群）：注册一个无人续报的集群后，其上的 `RUNNING` 任务在 `down + grace` 越过后的第一个循环内被搬走——`state→PENDING`、`cluster_id→''`、`node_id→NULL`、`attempt` 不变、`avoid_nodes` 追加原节点；台账、指标、日志三处同时留下证据（漂移发生在注册后 2088ms，阈值 2000ms）。**仍未验证**：目标端——任务被置回 `PENDING` 后落到**另一个集群**的健康节点上这一步没有覆盖（需要第二个集群有真实节点行）。

## 2026-09-15 连接器审计查询面（E7）与 E 组再复核

- `connector_audit` 此前有写入方、有三个读形状的索引，却**没有任何查询出口**（E7）——要回答「这个会话到底对外调了什么」只能上生产 `psql`。只能被写者读的审计表不算审计。现补 `GET /audit`：realm 只来自身份头（`?realm=` 被忽略，不是被采纳）、非管理员缺省只看自己的调用、`all=true` 需管理员角色（越权在触达数据层前就拒）、支持 `sessionId` / `connectorId` / `decision` / `beforeId` / `limit`。
- 三条判据值得记下：① 未知 `decision` **报 400 而不退化为「不过滤」**——`?decision=denyed` 若被静默忽略，一次「只看被拒绝的调用」的合规查询会返回全部调用，结果集被悄悄放大比报错危险；② 排序键与游标键**都是 `id`**，`created_at` 是事务开始时刻而 `id` 是 INSERT 时刻，并发下会不一致，混用会漏行；③ 读与写分成两个类型（`audit.Reader` / `audit.PgSink`）——写是权威且必须响亮失败，读带 realm 与角色过滤、失败只影响排查。
- **E2 / E3 改判为「非缺口」。** E2「对账只落账不修复」的断言抄自 doc comment，函数体 `store.go:966-976` 就是在做单调合并（高 attempt 覆盖低、同 attempt 只允许状态前进）。E3「派发 outbox 无消费者」只查了「谁调用了这个 Go 方法」，没查「谁消费了这张表」——真实消费者有两个，都在**同一事务内**完成「认领 + 准入门禁 + 置 `delivered_at`」：`subagent-host/src/governed-dispatch.ts` 的 `PgGovernedDispatch.take()`（Agent 路径）与 `governance/internal/store/devices.go` 的 `dispatchDeviceTask`（设备路径）。`ClaimDispatch` 无调用方是设计选择，**不要给它补 HTTP 认领路由**，那会造出同一张 outbox 的第二个竞争者。
- **E5 已闭合**：`session-title-gw` 从 `PLATFORM_PLUGIN_MODULES` / `PLATFORM_PLUGIN_DIRECTORIES` 两处摘除。它不是「未完成的插件」而是**验证切片**；真缺陷是登记本身——`profilePluginSpecs()` 会遍历该表，而 `isOptionalProfilePlugin('@lumo/...')` 恒为 false，安装失败会**直接抛错终止启动**而不是降级为告警。
- **新增 E7b**：`connector_audit.projected_at` 与 `idx_connector_audit_pending` 只为投影器而存在，而全树既无人写也无人读该列——§10.1「所有外部调用记 session 事件」的**时间线半边**未实现。它属 dsh 插件层的跨进程投影（参照 `knowledge/src/graph-projector.ts`），**不是**给 connector-gateway 加路由：session 存储不在该服务边界内。
- 验证：`connector-gateway` 的 `gofmt`/`build`/`vet` 干净；16 条通过、4 条 SKIP。13 条 handler 契约用例**无外部依赖**（realm 只信身份、缺省只看自己、管理员闸门、未知 decision 的 400、坏游标/坏 limit、过滤透传、未配置时 503 而非空列表、`no-store`、错误不回显、非 GET 方法），3 条纯函数用例，4 条活库用例（`WHERE` 真的生效、keyset 翻页不重不漏、按 `id` 而非 `created_at` 排序、退化输入）。`handleAudit` / `parseLimit` / `parseBeforeID` / `ParseDecision` / `NormalizeLimit` 均 100% 语句覆盖。另：`Server.New` 现在为缺失的 `Logger` 兜底（`slog.DiscardHandler`）——已有两处直接解引用 `s.log`，漏传日志本是运行期 panic。

## 2026-09-14 LLM provider 注册表管理面（E8）

- `llm_providers` 此前只有读路径（`store.Provider`），运维必须手写 SQL 才能注册模型、改费率或摘出路由。现补管理面：`GET /v1/providers`、`GET|PUT|DELETE /v1/providers/{model...}`。不需要新增鉴权——`cmd/llm-gateway` 早已把整个 mux 包在 `RequireControlPlaneToken` 里。
- 写入口径统一为「除 `model` 外全字段可选，省略即保持原值」。这对 `apiKey` 是强制要求（密钥读不回来，任何 GET-then-PUT 客户端都会清掉它；显式给空串才是清除），对 `upstreamBaseUrl` 是体验要求（`{"enabled":false}` 就能摘出模型，不必读改写）。新建行省略基址由列的 `NOT NULL` 一条语句原子判定，翻译为 400——另发存在性查询会引入「查完被删」的竞态。
- 密钥**在结构上**不可能泄露：管理面视图 `domain.ProviderConfig` 根本没有该字段（只有 `apiKeySet` 布尔），与路由面 `store.Provider`（必须携带密钥出示给上游）刻意分成两个类型。错误信息亦不含密钥。
- 路由面与管理面的 not-found 刻意不合并：路由面 `ErrUnknownModel` 还包含「有这行但被停用」，管理面必须看得见停用行，否则运维无法重新启用它。列表含停用行、按 `model` 排序；空列表编成 `[]` 而非 `null`。
- 迁移：`llm_providers` 增 `updated_at`（`Init` 内 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`——`CREATE TABLE IF NOT EXISTS` 对已有表什么都不做）。
- 验证：`gofmt`/`vet` 干净，27 条用例通过、7 条按惯例 SKIP（PG 相关）。新增用例分两层——handler 契约 12 条**无外部依赖**（路由、状态码、错误码、JSON 形状、省略字段传下去必须是 nil、密钥不回传），SQL 语义 2 条活库用例（`ON CONFLICT` + `COALESCE` 的「省略即保持」、新建行缺基址的 23502 翻译）。`domain` 包覆盖率 92.2%，provider handler 90%+。**活库用例本机未执行**（无 PostgreSQL）。

## 2026-09-14 健康派生就绪态

- 集群管理面门禁不再只看 `LUMO_CLUSTER_STATUS` 声明值。新增 `platform/control-plane/heartbeat` 模块，九个控制面服务上报心跳（实例身份、版本、状态、依赖上报），governance 以缓存快照求值：生效状态 = 声明意图 AND 派生健康。此前该声明是硬编码的，调度器已死也不会关门。
- 门禁区分两种拒绝：非集群 / 未声明就绪仍返回 403 `CLUSTER_ONLY`（配置事实）；已声明就绪但不健康改为 503 `CLUSTER_NOT_READY` + `Retry-After`，响应体带不就绪原因、未就绪服务清单与求值时刻，`/v1/features` 同时暴露声明值与生效值。
- 缓存对「查询失败」与「快照过期」双 fail-closed；一个服务至少一个副本在服务即健康，但每个副本都留在报告里。OIDC 登录与调度补偿循环刻意只看声明值——它们是修复降级集群的入口。`/healthz` 降级时仍返回 200，且不提供 `/readyz`。详见 [`architecture.md`](./architecture.md) §13.2.8 与 [`configuration.md`](./configuration.md#集群就绪health-derived-readiness)。
- 迁移 `004_service_heartbeats.sql` 把心跳表主键改为 `(service, instance)` 并新增 `dependencies` 列（001 时代的单列主键会让同一服务的两个副本互相覆盖）。Compose 为每个服务显式设置 `LUMO_INSTANCE`；Helm 由 chart 按已启用服务推导 `LUMO_REQUIRED_SERVICES`。**2026-09-15 补**：Helm 此前只给 `collaborator` 注入 `LUMO_INSTANCE`，而 scheduler 的实例名回落链是 `LUMO_INSTANCE` → 字面量 `"scheduler-0"`（`scheduler/cmd/scheduler/main.go:33`），于是 `replicaCount: 2` 会让两个副本以同一 holder 去 `Acquire`；`scheduler/internal/store/store.go:204-208` 在 holder 相同时不递增 `fencing_token` 且 `WHERE` 子句照样命中，两个进程各拿到 token=1 的租约，而 `checkFencing`（`:253`）只比 holder+token → **两个 leader 之间没有任何 fencing**。现已改为每个控制面服务都从 `metadata.name` 注入 `LUMO_INSTANCE`；用 Pod 名还让重启后的新进程拿到更高 token，把旧进程挡在外面。
- 验证范围：11 个 Go 模块 `build`/`vet`/`gofmt` 干净且既有测试全通过，新增 30 个测试（含枚举 mode × intent × health 的 fail-closed 性质测试）。**PostgreSQL 相关验证当时未做**：advisory-locked DDL、对 001 时代表的迁移、`EXTRACT(EPOCH FROM ...)` 时长换算需要真实数据库。（**2026-09-16 更正**：「本机无 PostgreSQL 与容器运行时」的表述不成立——Docker 与 PostgreSQL 都能在本机跑起来，缺的只是守护进程未启动；09-15 晚的活库套件已在真库上跑完 11 个 Go 模块 714 PASS / 12 个 TS spec 113 PASS。）

## 2026-09-08 剩余功能开发

- 受管桌面节点管理页已接通设备详情闭环：显示设备连接、证书、策略 revision、安装闭包与最近报告；Realm 管理员可提交 Registry 验签后的精确制品策略，所有者或管理员可签发仅展示一次的 5 分钟激活码，并按实时权限下发 `reconcile/start/stop` 命令、查看最近执行结果和显式重置设备身份。界面不会在设备离线、策略未收敛或进程运行策略关闭时伪造可执行入口。
- 原侧边栏底座插件已从桌面与节点运行时基线、基础插件能力目录、SkillHub 离线市场种子和预装仓库映射中移除；对应断言和桌面基线说明同步收敛，仓库不再展示或预装该插件。
- 连接器托管 OAuth 已接通管理员授权、S256 PKCE、回调、调用时自动续期、手动续期和平台侧断开；旧外部凭证模式继续可用。令牌在 Vault KV v2 按 Realm/连接器/代际隔离，PG 只保存元数据与审计；单次交换、持久化刷新状态和后台旧代际清理覆盖并发/中断边界。认证代理回调重新核对 Governance 会话和权限，管理页显示真实状态及授权记录。供应商侧应用授权撤销仍在供应商管理入口进行。
- Compose/Helm 已增加托管 OAuth 的配置和共享 Secret 引用；Helm 补上 Governance 服务、认证 Secret 注入及 DSH 公开认证入口配置。
- 按用户要求继续暂缓运行测试、浏览器验收和集群联调；目前新增 OAuth/设备链路涉及的 Go 模块 build+vet 与 Lumo UI 定向 TypeScript 编译已通过。

## 2026-09-07 集群管理开发

本次新增管理页面及 Lumo 代理入口以 `deploymentMode=cluster` 且 `clusterStatus=ready` 为前提；Local 与 Standalone 不显示这些页面。认证代理的跨节点会话检查由启动器按集群模式注入 `clusterMode`，Standalone 保留原有会话缓存行为，Local 仍不装配认证代理。接口与权限边界见 [`cluster-management.md`](./cluster-management.md)。

- 组织管理支持创建可登录用户、修改资料/部门/状态、建立及重置凭证、查询和撤销角色、设定授权期限、编辑和停用部门及角色。组织变更通过 realm 事务锁串行化，保护最后一个可登录管理员和最后一个长期管理员授权；停用用户、重置密码会撤销原会话。Bootstrap 重启不会恢复已撤销的角色。
- 技能管理支持列出、授予和删除技能授权，登记和解除显式禁用规则；验证同 realm 的有效对象、具体技能版本、有效期及部门继承范围。角色停用后不再参与技能授权计算。
- 受管桌面节点支持登记、目录筛选、排空、撤销及重新进入待激活状态。心跳不能解除排空/撤销，过期在线状态不再显示为可调度；真实激活仍依赖设备身份和制品验收，不以管理按钮伪造。
- 项目详情支持成员添加、角色调整和移除，延用项目服务的 owner 权限和最后所有者保护；归档项目关闭新增成员编辑入口。Agent 支持完整配置编辑和 revision 冲突保护；连接器支持读取/编辑 manifest，管理权限取自网关实际 `AdminRoles`。
- 流程管理增加项目内草稿、待审核及停用项目录，支持定义编辑、审核意见、退回、定向分发、历史快照读取和版本切换。发布后的修订使用独立 `flow_change_drafts`：创建/编辑/提交/退回不会改变当前执行版本；审核通过时同事务写入不可变快照、审核记录及发布指针。草稿 ID、revision、基准发布版本及父流程行锁防止旧页面覆盖、重复审核和过时基准发布。
- 企业 OIDC 登录已补齐协议校验、共享登录事务、浏览器回调、治理身份关联和会话签发。组织管理支持关联、解除及恢复企业身份；默认关闭自动建档，启用后也不自动授予角色。企业会话纳入停用、角色及撤销检查，纯企业账号隐藏本地密码和验证器设置。真实 IdP 接入仍需部署方提供身份源和客户端配置，见 [`configuration.md`](./configuration.md#企业-oidc-登录)。
- 按用户要求暂缓测试和集群联调。本次仅执行格式化、相关 TypeScript 编译检查、Go 构建与 vet、Compose 配置校验、启动器及登录脚本语法检查和差异空白检查；下方既有测试记录是此前批次的结果，不代表新增功能已经通过运行验证。

## 此前开发记录

本轮按项目评审中列出的剩余开发项补齐了可运行闭环：

- 注册表增加 `/v1/blobs/{digest}`，新增 Provisioner CLI；计划、下载、sha256 复核、原子落盘、JSONL+zstd 格式的 `install-state.jsonl.zst` 和按间隔持续 reconcile（检测缺失/篡改后自动修复）均有测试；`registry_rollouts` 现是可读写的通道期望状态，管理员可在 Lumo 市场将已发布版本设为 Stable 目标并设置 0–100% 灰度比例，市场还会按已回报节点展示确定性 target/holdback cohort 与其最近安装事实。Provisioner 可每轮读取目标版本后重新验签计划再对账。通道现保存目标与 holdback 版本，Provisioner 以稳定 node ID 确定性分桶选择版本；上调 `percent` 只扩大目标 cohort，`percent=0` 可立即回退到 holdback。配置源当前仍为 PG，保留迁移到 Nacos Config 的替换点；Bundle/安装快照共用有大小、行数、zstd window、重复键与记录顺序校验的 JSONL+zstd 流；Standalone profile 与 Helm 可选 Deployment/PVC 已接入。
- Connector Gateway 支持 Vault 凭证 Provider 和 OPA 策略 Provider，并支持管理员查看已停用连接器及恢复原 manifest（普通调用者不会发现已停用项）；Scheduler 支持 Nacos 节点目录并由 `LUMO_NACOS_ADDR` 切换，dsh 承载节点会以临时实例注册并续报。
- Connector Gateway 对高敏感外部写操作已接入 PostgreSQL 一次性人工审批：审批人必须与申请人不同，批准记录精确绑定连接器版本、操作和请求摘要，不保存请求正文或凭证；记录被消费一次后即失效。Lumo UI 可查看、批准/拒绝及按原请求执行一次。
- Governance 技能目录现在保存有内容的不可变版本：创建必须写入首个版本内容，后续版本不可覆盖并记录 SHA-256 摘要、创建者和时间；`current_version` 只表示最新治理草稿，`published_version` 则是 realm-admin 显式选择的、带摘要和发布者/时间的运行时源指针。旧数据迁移时保留其原当前版本为已发布版本；新草稿不会自动晋升。发布指针现在要求可供 DSH 加载的 `SKILL.md` frontmatter；受保护的 `governed-skill-publisher` 仅导出这些已发布源、逐项复核摘要后构建普通的签名 Registry Skill Bundle。私钥不进入 Governance/节点，Bundle 仍由 Provisioner 验签、对账并原子物化为本地快照；空目录也会发布撤回旧技能的快照。Lumo 明确区分治理运行时源与节点已安装事实。
- 知识插件支持 PG/ Milvus REST v2 向量 Provider、Nebula Graph adapter Provider；PG 源表现为版本化 source-of-truth，Lumo 的 realm 管理员可登记、查看、版本化更新、删除和安全重建来源（写入与向量/图投影意图同事务，乐观并发冲突明确返回），纯 Milvus 投影配置会明确拒绝来源管理而不伪造状态。
- 协作服务支持同镜像内的 yrs Rust 语义内核（Yjs v1 update apply/state encode/text materialize），未配置内核的本地开发才使用明确命名的确定性更新集 fallback；FlowEngine、TriggerBus、持久事件 outbox worker、自动化绑定执行、运行幂等记录和已发布快照执行 API 已加入。业务执行失败会确认原事件并保留失败账本，不会因 outbox 至少一次语义自动再跑；项目 owner/editor 可对失败记录请求一次显式重放，重放固定原事件 payload、自动化 ID 和已发布版本，重复请求幂等返回同一排队项。
- 项目控制面已开放制品/空间/自动化 CRUD 与 dashboard；自动化页可直接启停规则并执行已发布流程快照、回显本次输出（草稿和已弃用流程不可启动）；事件/Webhook 自动化的实际执行记录现由 flows 服务持久化并按项目成员权限展示（手动试运行结果仍仅在当前会话回显）。失败记录可由项目 owner/editor 从 Lumo 显式重放，并显示其父失败运行；项目成员可读取不可变的已发布流程快照，并在 Lumo 中对当前版本与其前一发布版本进行节点、算子、连线差异对比；Scheduler 的 Nacos/PG 节点目录和数据驻留硬过滤已接入。
- Milvus Provider 会校验/创建 collection，并支持配置源回放接口执行 realm 级 rebuild。
- 新增外置 `platform/dsh-plugins/lumo-ui` 平台插件包：不修改 `deepseek-harness/` 源码，通过官方 `dsh.client` 扩展机制挂载到原生 DSH AppFrame；右下角运营入口、项目/权限、流程、连接器、集群和 16 个插件能力均在同一 DSH Web 页面内展示。面板采用 React Bits 风格的渐变胶囊、Aurora/Blur Reveal/玻璃卡片与 Shiny Button 本地实现，所有上游地址和身份均由运行环境注入。控制面 CORS 由 `LUMO_CORS_ORIGIN` 环境变量注入，统一 `/metrics` 增加 HTTP 延迟 histogram。
- Passkey/WebAuthn 已在 Governance、认证代理和账户页闭环：部署必须同时配置可信 DNS RPID、RP 名称与精确 origin；注册挑战为摘要、单次消费、5 分钟过期，服务端验证 `webauthn.create/get` 的 origin、RP hash、UP/UV、none attestation、ES256/P-256 签名和凭据计数器，检测到正计数倒退时拒绝登录并写入安全审计。用户可在账户页绑定、列出及移除自己的 Passkey；登录仍须先通过一次性点选验证码与账户锁定策略。
- 连接器 OAuth 注册已形成 fail-closed manifest 契约：OAuth 连接器只能使用 Bearer access-token 引用，并提供供应商名、精确 HTTPS 授权/令牌/回调 URL、client ID/Secret 受管引用、去重 scope 与强制 PKCE。泛化网关不硬编码 SaaS 协议，也不会把凭据写进 manifest。
- 所有 HTTP 控制面入口现可选地通过 `LUMO_OTEL_COLLECTOR_URL` 向 OTLP/HTTP Collector 导出 W3C 关联的 server trace 与固定指标集。采样、指标系列硬上限和导出周期受 economy/balanced/detailed 成本策略限制；URL、查询、用户、租户和相关 ID 不作为 trace attribute 导出，超额指标/trace 均有丢弃计数。未配置时保持原有 Prometheus `/metrics` 与 W3C 传播，不猜测网络目的地。
- Seam Host/Proxy 已支持文件挂载式 mTLS：CA、节点证书与私钥均为绝对 PEM 路径；Host 强制验证客户端证书，Proxy 开启后拒绝 HTTP endpoint（包含动态发现更新）。完整 PEM bundle 默认每 30 秒检查，Host 为新连接刷新 TLS context、Proxy 为新请求刷新凭据；无效轮换保留最后一套有效 bundle，撤销/紧急回退仍需原子 Secret 更新与滚动重启。Cluster Helm 另提供默认关闭的 Istio workload mTLS：控制面、网关、DSH 子代理 start/result 通道统一 sidecar 注入、STRICT 接收和 ISTIO_MUTUAL 出站，证书由 SDS 自动签发/轮换，`denyPrincipals` 可紧急隔离受损 workload。启用仍须由实际集群提供 Istio、真实 trust domain、CA 根轮换/撤销流程和 Edge/Ingress 入口策略；HMAC runtime identity 不替代证书身份或保护已遭攻陷节点。
- 协作服务的 WAL 已改为 Redis 原子全局序列号 envelope；快照读取按状态位点过滤、裁剪按 envelope 序号执行，并修复数据库无记录与数据库故障的错误区分、文档元数据解析和 realm-scoped 权限主键。Helm 可选 DSH 节点池使用 Pod 唯一 ID + Nacos 临时注册 + HPA，支持超过两个节点/智能体。
- Helm 引用的 Secret 现有书面契约（2026-09-15）：`templates/NOTES.txt` 在安装输出里列出每个 Secret 的名字、key、消费方与内容形状——`registry-trust.json` 这个 **key 名**此前无法从 `registry.trustSecret` 推断，而卷挂载 key 写错只会挂出一个空目录、容器照常启动。`secrets.create`（默认 `false`，opt-in）可生成两个纯随机 bearer 与一个占位信任根 `{"publishers":[]}`；`lumo-vault-token` 与真实信任根**永不生成**（前者必须匹配一个 chart 并不部署的 Vault，后者是一组发布者公钥）。生成走 `lookup` 复用集群里已有的值，因此普通 `helm upgrade` 不会轮换 token；配 `helm.sh/resource-policy: keep` 使卸载不删凭据。values 里没有明文 token 入口。空 Secret 名改为整条省略——此前会渲染出 `name: ,` 的非法清单而 `helm template` 报成功。另新增集群 profile `values.cluster.yaml`（逐项决定九个默认关闭项并写明所缺外部事实）与渲染门禁 `platform/deploy/helm-verify.sh`（无集群、秒级，含四条「必须被拒绝」的反向用例）。

## 有意保留的外部集成边界

这些不是源码 TODO，而是必须由目标环境提供的适配面：

1. yrs 内核在 Docker 构建阶段从 crates.io 获取依赖并作为独立进程打包；本轮已完成联网 `cargo check` 与离线 Rust 单测，仍需在发布环境完成最终镜像构建。未配置内核的本地 fallback 不提供文本语义 materialize。
2. Nebula 通过项目约定的 graph adapter HTTP 接口访问，Milvus 需要预先建好与 embedding dimension 一致的 collection；Provider 会对 realm、角色和版本字段强制过滤。
3. TriggerBus 的消费者分发仍是进程内，但事件入口、outbox claim/requeue/ack、自动化执行、失败运行的固定快照重放和运行幂等记录已在 flows 服务内闭环；跨服务事件骨干仍应由 RocketMQ 或调用方 outbox 接入。台账明细的唯一真相源是 PG，任何派生聚合都不得反向充当明细真相源。
4. 具体 SaaS/MCP OAuth 仍需由集成方提供供应商端点、已注册回调和 Vault 客户端凭据。托管授权页跳转、回调、token 交换、刷新及平台侧断开已接通；不伪造供应商配置或宣称已完成真实供应商联调。
5. 企业 OIDC 的代码路径已经接通，启用仍需要目标身份源、精确回调、客户端凭据及建档/停用策略。当前支持单 issuer、显式用户关联或无角色自动建档，不包含 SAML、组角色同步或 IdP 后端登出；未配置时入口保持关闭，真实环境联调仍待完成。

## 尚未达到生产验收的项目级事项

- 当前项目下的 `deepseek-harness/` 源码实际存在，只是被 `.gitignore` 忽略；Compose/Standalone 已新增从该源码构建 `platform/data-plane/dsh-node/Dockerfile` 的默认路径，也支持用 `LUMO_DSH_IMAGE` 替换为发布镜像。`preflight-deployment.sh` 现可在不启动容器的前提下校验 Docker daemon、Compose 渲染、关键服务、控制面令牌和 Registry 信任根，`--strict` 还会拒绝开发默认凭据；Cluster smoke 会先执行它。当前环境的 Docker daemon 和基础预检可用，但严格预检仍正确拒绝短/缺失身份断言密钥、开发默认密码和 Vault token，以及开发 Registry trust root；在提供非开发部署凭据与生产信任根前，尚未启动完整 Cluster，也未完成跨节点 resume、失联接管、RocketMQ/Nacos/Milvus/Nebula/OPA/Vault 联合演练。
- Scheduler 已支持可选 EDF 截止时间、加权公平队列、能力值匹配、硬反亲和和安全抢占：只有同 Realm 的高优先级等待任务在兼容节点均满时，才选择低优先级活跃任务；先将 `PREEMPT` 停止意图落账、由该任务所属执行节点确认，再标为 `CANCELLING`。新任务始终保持 `PENDING`，只会在执行节点回报终态释放槽位后由 leader drain 放置，绝不伪造“已抢占/已释放”。无 leader 时仍快速失败并保留对账路径。
- OTel 的统一 trace/metric 管道、Collector URL、采样率、系列上限与成本策略已实现；Helm 现在将正式 `collectorUrl` 注入所有控制面服务的 `LUMO_OTEL_COLLECTOR_URL`。业务级 SLO、日志/trace 留存和费用上限仍由运营方决定。可选 `productionControls.enforced` 已把 SLO 文档引用、Collector URL、留存天数和月度费用上限变为渲染期门槛并发布非敏感声明，但不替代 Collector/Loki/对象存储的实际生命周期策略。
- 控制面 Go 服务已统一使用 observability TLS helper；Standalone/Compose 可通过文件挂载启用 TLS 1.3 双向认证、CA 校验、热轮换与失败关闭。Helm 侧另有 Istio SDS 方案；真实 CA/Issuer、撤销与 Secret 挂载仍需按拓扑接入。
- Helm 可选生成 OTel Collector、Loki retention、对象存储 lifecycle 和 Prometheus recording-rules ConfigMap；Collector/Loki/S3 endpoint 与正式留存值由运营方填写后开启 `productionControls.observability.enabled`。
- **全局执行监控面（§7.4.2）已落地**：`platform/deploy/prometheus-alerts.yml` 共 14 条规则，覆盖点名的六类（`task_lost`/`node_down`/`queue_backlog`/`budget_overrun`/`gateway_5xx`/`seam_circuit_open`），每条带 `class`/`tier`/`severity`；另有两条有意保留的 `instance_down`（控制面整体挂掉时其余表达式会集体静默，没有它最大的故障反而最安静）与 `latency`（P3 知会），以及 2026-09-16 为 C5 自己的域指标补的 `realm_isolation`（跨 realm 的控制尝试被拒——这类尝试**不进审计表**，见下方 C5 条目）与 `LumoSessionControlPulseForced`（控制脉冲被强制接管）。修掉了两条**结构性死规则**：`lumo_service_up == 0` 依赖一个恒为字面量 1 的指标（该指标已删除，任何再次引用都会被门禁判为无写入点），Helm 记录规则选择 `lumo_http_requests_total{status=~"5.."}` 而该计数器不带任何标签。指标层补上带标签 gauge 与**整体替换** `ReplaceGauges`（增量写入表达不了维度消失，队列清空后告警永不解除）。`max_stall`（默认 8h）停滞收割把「节点已不在目录中」的活跃任务转死信，使被卡住的任务能重新提交。新增 `platform/deploy/alerts-verify.sh` 引用完整性门禁，带 11 条必须失败的反例。**`task_lost`/`node_down` 在 Pg 目录（local-lite）下结构性不成立**（`scheduler_nodes` 只增不减、无存活信号），只有 Nacos 目录才产生这两类。
- **共享执行控制（§8.4，缺口 C5）服务端已落地**：`platform/control-plane/session-control/` 把 pause/resume/stop/abort/approve/reject/replay/degrade 做成**可审计的一等事件**——`session_control_state`（每会话一行，`realm` 首条**生效**指令写入且此后不可变，`revision` 做版本比较后交换）与 `session_control_audit`（放行与拒绝都写，键 `(session_ref, id)`，**不设**按会话的 `seq`——`SessionEvent.seq` 归 dsh，第二个序号迟早被当成真的那个）。裁决链：同会话脉冲队列（FIFO + 持有时长超`MaxHold` 可被强制接管）→ realm 隔离 → OPA（fail-closed）→ 状态机矩阵 → 库端行锁 + 版本 CAS → 落库 → 下发。控制台要的只读投影（状态 / 此刻每个按钮可不可点 / 时间线 / 队列现场）同时提供，且**对从未被控制过的会话不伪造状态**（`registered=false`、`state=null`，只老实地给出它正在派生的 `base_state`）。**两处诚实缺口**：① 生效指令向会话执行面的**下发未接线**（§8.1 suspend / `agent.inject()`），所以每条响应的 `effectuation` 恒为 `recorded`——先落库再下发是刻意的顺序（「记了没做」可对账，「做了没记」无从追溯），不是遗漏；② **Session Console 的 UI 未接线**（读投影已就绪，前端属另一项）。**三处与 §8.4.2 字面的偏离，都记录在案**：不写 `usage_ledger`（`cost_type` 是跨语言闭集，控制指令没有对应单位，写进去会污染全部成本聚合）；审计不设第二个 `seq`（同上）；并发裁决不回落 Scheduler（库端行锁 + 版本 CAS 已达同一语义，不必让调度器进入控制路径）。策略在 `platform/deploy/policies/session-control.rego`，与 Go 侧输入的对齐由 `TestInputCoversKeysReadByDeployedPolicy` 从 rego 源码里读 `input.*` 键来守住（它已经抓到过两个坑：rego 里**空字符串为真**，以及 rego 注释里提到的 `input.X` 曾被当成真实引用）。部署接线补了七处（compose ×2、Prometheus ×2、告警名单、`preflight-deployment.sh` 服务清单、CI matrix、Helm `services` + ConfigMap、`build.sh` 镜像清单），其中顺带补掉三处**同族**既有漏洞：preflight 与镜像清单各漏了 `edge-gateway`/`terminal-gateway`，Helm ConfigMap 只给了 `LUMO_OPA_ADDR` 而 session-control/terminal-gateway 读的是 `LUMO_OPA_URL`（缺它则控制指令静默全拒，而 `helm template` 照样成功）。另外修掉一个**集群形态下让三处策略评估全部失效**的既有缺陷：compose 的 OPA 用默认绑定，而 OPA 默认只听容器内 loopback，兄弟容器按容器 IP 访问一律连不上——症状长得像权限不足（fail-closed 把「引擎连不上」也变成拒绝）。已加 `--addr=0.0.0.0:8181` 并把镜像钉到 1.3.0（rego 是按这个版本逐条验过的）。
- 审批委托与 break-glass、租户密钥销毁和市场治理规则仍需要业务所有者与合规方的书面授权。`productionControls.enforced` 同样要求三项批准策略引用，避免缺审批却宣称生产就绪；角色、双人复核、留存、法务冻结、密钥层级、撤销、审计和真实执行工作流仍必须由相应的治理系统落实。
- governance/internal/breakglass 已提供策略无关的数据模型与内存实现：双人复核、请求过期、撤销、审计事件和状态查询；接入正式审批/密钥系统前不会自行赋予生产权限。
- Scheduler 抢占 PostgreSQL 端到端用例已在 `internal/integration/preemption_test.go`；它需要隔离的 `LUMO_TEST_PG_DSN`，当前未提供该 DSN，且本轮没有启动集群或活库。
- Cluster 联合验收入口 `platform/deploy/acceptance-cluster.sh` 已接入：在真实 `LUMO_TEST_PG_DSN`、
  RocketMQ mqproxy endpoint 以及 Nacos/Milvus/OPA/Vault 健康 URL 齐备后，串联 smoke、Scheduler 接管、
  Session resume/fencing、RocketMQ 传输、控制面集成与 dsh-plugins 活库用例；Nebula 自 2026-09-15 起
  改为**可选**探测（它不在任何编排里，runtime 默认空值回落 PG 递归 CTE）。
  **同日修正了一处会造成假绿的缺陷**：该脚本此前只导出 `LUMO_TEST_PG_DSN`，而 session-log 的活库 spec
  读 `SESSION_LOG_TEST_DSN ?? METERING_TEST_DSN` —— 名字对不上时 19 个用例全部跳过而退出码仍为 0，
  脚本照样打印「通过」。现由 `platform/vitest.setup.ts` 兜底，且每一步都断言真的执行了活体用例
  （计数为 0 即失败并 dump 证据）。cluster 拓扑默认不发布基础设施端口这一阻塞也已闭合：
  `compose.cluster.acceptance.yml` 是 additive 的端口暴露覆盖文件，`up.sh` 新增
  `LUMO_COMPOSE_EXTRA_FILES` 以接受它。
  **同一次复核还发现并修复了一个 P0**：`up.sh` 的 `warn_legacy_cluster_storage` 只负责警告，却在
  `set -e` 下用裸 `return` 提前返回非 0 状态，导致 `up.sh standalone` **无条件**退出 1、
  `up.sh cluster` 在首次部署时退出 1 —— README 记载的两条启动路径都到不了 `docker compose up`。
  仍未取得真实多节点通过证据——**但原因要写准**（2026-09-16 更正）：本机**有** Docker 与 PostgreSQL
  能力，缺的是**守护进程没在跑**（`docker ps` → `Cannot connect to the Docker daemon`；二进制在
  `/usr/local/bin/docker`，symlink 到 Docker.app）。先 `open -a Docker` 并轮询就绪，
  再用 `platform/deploy/test-local-pg.sh` 或 `acceptance-cluster.sh` 就能拿到活库证据。
  把「没有容器运行时」当成环境结论会让下一轮重复放弃这件事。

## 验证结果

- Lumo 外置插件的 TypeScript 类型检查与 bundle、DSH 节点 TypeScript 语法检查、Helm 默认/启用 DSH
  节点池渲染、Compose 配置、集群冒烟脚本语法和 `git diff --check` 通过。
- 十个 Go 模块已按 `go build ./...`、`go test ./...` 与 `go vet ./...` 复核；
  collaborator、flows、governance、observability、projects、registry、scheduler、usage-ledger
  全部通过。connector-gateway 与 llm-gateway 的 build/vet 通过，但当前受限沙箱禁止
  `httptest` 监听 `[::1]`，因此其网络测试无法在此环境完成。
- 全平台 `tsc -b --noEmit` 已通过（包括 Governance/Projects/附件策略修复）。Lumo UI
  的 client 与身份契约测试通过；全量 Vitest 中 subagent remote provider 的 HTTP 测试仍会因
  沙箱禁止监听 `127.0.0.1` 而失败，属于运行环境前置条件，不能作为业务断言失败。
- 任务取消已接入 Scheduler 与执行节点确认；重试和改派均创建不可变 Run、保留历史尝试，
  并在任务详情中显示 Run 历史。委派的项目成员校验、部门子树可见性与执行回报权限已收口。
- Registry 现提供 `GET /v1/artifacts?limit=` 的真实制品目录（每个制品名的最新已发布版本）；
  Lumo 插件中心读取该目录及启动器有效配置，并明确区分“可发现”“已配置”与尚未接入的
  Provisioner/Runtime 状态，不再用静态版本或“已内置”文案冒充安装事实。市场可为选定
  制品生成签名安装计划，展示依赖闭包、聚合 scope 以及目标节点能力校验；Stable 通道的
  管理员可将一个已发布版本写为期望态，Provisioner 在下一周期读取它、重新验签并对账，
  因而升级与回滚都是一次可审计的目标版本切换，而非浏览器直接安装。Provisioner 会在签名
  计划、digest 复核和原子落盘后向 Registry 回报每个节点最近一次的实际安装闭包（失败对账
  明确标为未收敛）；市场据此展示节点已安装事实。Component 现可在签名 manifest 中声明
  受限的本地 `process` runtime（固定 payload entrypoint 与参数）；节点侧 `artifact-runtime`
  仅经 mode `0600` Unix socket 提供显式启动、停止、进程健康、日志和根闭包卸载，并在启动前
  重验 manifest/payload 完整性。它不宣称为 Docker/Kubernetes 编排器，且连续 Provisioner
  的期望状态仍可在下一轮重装被本地卸载的根制品。
- 用户中心已接入服务端会话投影：可查看活跃会话、撤销指定会话、退出其他设备；撤销当前
  会话会同时清理浏览器 Cookie。自动化页按项目读取真实规则，并可通过项目服务直接启停。
- Agent 已从运行时拼接的候选字符串收敛为可管理的 preset 资产：持久化名称、所有者、项目
  范围、模型/Provider、提示引用、连接器与知识空间引用、并发/信任/驻留、预算、超时和下授
  深度；更新采用 revision 乐观并发控制。preset 配置与 Worker 执行态分离，未收到运行态
  `active` 上报的 Agent 不会进入可派发候选集。
- 用户中心增加最近 100 条个人安全事件：登录成功/失败与锁定、登出、会话撤销、改密、TOTP
  与 Passkey 的登记/移除/登录/克隆检测均会写入不含令牌或密码的审计记录，并通过认证代理与
  Lumo 页面展示。TOTP MFA 已支持手动登记、校验和停用；只有部署显式注入
  `LUMO_AUTH_MFA_KEY`（Base64 32 字节 AES-GCM 密钥）才会启用，缺失时接口明确返回不可用而
  不会以明文或临时密钥降级。企业 OIDC 本次已独立接入；本地验证码、TOTP 和 Passkey
  继续属于本地登录方式，企业 MFA 由 IdP 执行。
- realm 管理员可在账户页管理治理用户、部门与角色；本次已扩展为创建登录凭证、重置凭证、
  查询和撤销角色以及组织目录编辑。该入口仍受 Governance 的 realm-admin 校验保护；
  不包含邮件邀请；企业 OIDC 采用管理员显式关联或部署方启用的首次登录建档。
- Lumo 读取可选上游时不再把 `401/403/501/503` 统一降级为空数组：任务、人员标签和目录、
  技能/创作入口会保留“无权限 / 部署不支持 / 服务不可用 / 请求失败”的具体原因，只有成功的
  空响应才显示为空数据。

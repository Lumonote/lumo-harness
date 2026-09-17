# 多集群调度设计说明 —— 联邦注册表 + 两段式失联判定 + 放置闸门（C1 剩余）

- 日期：2026-09-15
- 评审对应：`architecture.md` §7.4.1「调度拓扑」、**铁律 19**（跨集群失联两段式判定，严禁秒级切换）
- 状态：**已实现**（§1–§7 为评审稿原文；§8 为判定/闸门/指标的实施记录与两处偏离；
  §9 为「down 后任务漂移」的实施记录，含一处偏离与一处形态差异发现）
- 服务位置：`platform/control-plane/scheduler`（沿用既有服务，本轮**不新增进程**）
- 前序：C2「全局执行监控面」已落地（集群维度的指标与告警数据源就绪），C1 的剩余因此可以开始

## 0. 决策背景

`cluster-gap-analysis.md` 对 C1 的判据补充写得很准：**`cluster_id` 落进表结构之后，「多集群」剩下的不是数据模型问题，而是调度决策问题**——谁有资格把任务放到别的集群、跨集群的资源视图从哪来、分区时以谁为准。本文只回答这三问，不重做数据模型。

同一条判据还写明了排期前提：「这三件事都需要先把 C2 的集群维度监控做出来才谈得上调参」。C2 已于同日闭合，因此本项现在可以启动；**调参前必须确认目标形态用的是哪种节点目录**（见 §3.1，这是本项最容易踩空的地方）。

## 1. 现状侦察（全部读代码取证，非推断）

| # | 事实 | 证据 |
|---|---|---|
| R1 | **今天完全不跨集群放置**：`EligibleNodes` 在 `task.ClusterID != ""` 时硬过滤 `n.ClusterID != task.ClusterID` | `scheduler/internal/planner/planner.go:42-44` |
| R2 | 但 `task.ClusterID == ""` 时**跳过**该过滤 → 空 cluster 已是「任意集群」的退化形态。缺的不是「能跨集群」，是**准入与偏好** | 同上（条件以非空为前提） |
| R3 | `cluster_id` 是 `scheduler_tasks` / `scheduler_nodes` 的一等列且 `NOT NULL` | `scheduler/internal/store/store.go:40,51,101,110` |
| R4 | 目录**没有任何存活信号**：`scheduler_nodes` 只 upsert 从不删行，`registered_at` 只在 upsert 时刷新 | `store.go:42-62`（DDL）、`catalog/catalog.go:26-46`（`List` 无健康条件） |
| R5 | Nacos 目录**只返回健康实例**（`!h.Healthy \|\| !h.Enabled` 直接 `continue`）→ 一个集群挂掉时它的节点**静默消失**，而不是变成「可疑/下线」 | `catalog/nacos.go:71-73` |
| R6 | 调度器里**不存在**任何 `cluster_health` / `suspect` / 集群注册表概念 | 全模块检索零命中 |
| R7 | 放置函数的调用面很小：`planner.Pick` 2 处生产调用、`FullEligibleNodes` 1 处，均在 `drainOnce` 与 `internal/server` | `cmd/scheduler/main.go:186`、`internal/server/server.go:185,252` |
| R8 | 「节点已不在目录中」这类判据在 Pg 目录下**结构性不成立**（C2 已记录）；`task_lost` / `node_down` 在 local-lite 下恒为 0 | `cluster-gap-analysis.md` C2 闭合块第 3 条 |

**R5 是本次最关键的一条**：它否掉了「集群存活完全从节点目录派生」这个最省事的方案。在 Nacos 形态下，一个失联集群与一个从未存在过的集群在 `List()` 的返回值上**完全一样**（都是「没有它的节点」），因此**目录本身无法回答「这个集群是挂了还是没部署过」**。这正是 §7.4.1 要求一个**联邦注册表**的原因，不是装饰。

## 2. 范围

**在范围内：**

- **联邦注册表**：集群以 `cluster_id` 注册（声明存在）+ 周期性自报（证明还活着）。PG 实现，Nacos 形态复用同一张表（注册表是控制面自己的事实，不是服务发现的副本）
- **两段式失联判定**：`healthy → suspect(30s) → down(90s)`，判定为**纯函数**，时间基准为**库端时钟**
- **放置闸门**：`suspect` 与 `down` 的集群**不接受新放置**；`suspect` 不动已有任务（§7.4.1 明文）
- **集群维度的可观测**：把每个集群的状态与「距上次自报多久」导出为带标签指标，接进 C2 的告警规则与 `alerts-verify.sh` 门禁

**不在范围内（逐条写明理由）：**

| 项 | 为什么不在本轮 |
|---|---|
| **down 后的任务漂移（迁移）** | 这是**不可逆状态变更**，且 §7.4.1 要求「迁移前必须确认 fencing」。它需要自己一组闸门（快照新鲜 + 集群确实 down + 条件写 + 审计台账），与 C2 的 `max_stall` 收割同一量级。本轮先把**判定**做对并可观测，漂移单独一轮做，避免「判定还没有证据就开始搬任务」。**→ 2026-09-16 已实现，见 §9** |
| **集群 Scheduler 的独立进程/角色分层** | §7.4.1 的分层是「全局决策 / 集群只受理」。真实分层要拆进程、拆配置面、拆部署形态，且**它与存活信号的来源互相耦合**（见 §3.1）。本轮用 `LUMO_SCHEDULER_CLUSTER_ID` 表达「本实例代表哪个集群自报」，把分层留到下一轮。<br>**2026-09-17 补：那一轮里点名要的东西已经单独做掉了——集群本地放置降级**（`architecture.md:721` 的「集群本地放置降级随集群 Scheduler 落地」）。做法不是拆进程，而是给每个集群一把**作用域更小的租约**（`scheduler_cluster_lease`）：全局调度缺席时，本集群的任务仍可本地放置，**跨集群仍 503**。设计稿 `2026-09-17-cluster-local-placement-degradation-design.md`。<br>**注意 `§3.1` 说的那个耦合因此解开了一半**：本地决策者天然就是本集群存活信号的天然上报方，所以「谁自报」这个问题在拆进程之后会自动消失——但本轮**没有**顺手把自报从 dsh-node 挪回来（那是能跑的代码，且挪动它会同时改三个拓扑的接线面）。**仍未做**：两个独立进程角色本身 |
| **跨集群偏好打分（clusterTag/region 亲和）** | 依赖 §6.2 打分公式（A4 已列 P2，scheduler 明确「不做打分公式」）。本轮只做**硬闸门**，不做偏好排序 |
| **版本一致性前置**（「同一 agent 版本先完成全集群分发才允许全局调度」） | 依赖 Provisioner 的制品分发闭环（B5 已闭合但下发是部署决策）。把它做成调度前置条件需要「制品版本 → 集群」的视图，属另一条链 |
| **Nacos 形态的自报链路** | 自报由集群侧发起（TS 的 dsh-node 或该集群的调度实例）。本轮把**服务端接口**做出来并测好，客户端接入单独一轮（否则会为了联调把半成品塞进 TS 侧） |

## 3. 关键决策

### 3.1 存活信号从哪来：**集群自报为主，节点注册为旁证**（不是目录派生）

三个候选：

| 方案 | 问题 |
|---|---|
| 从节点目录派生（「有节点列出来就是活着」） | **R5 直接否掉**：Nacos 下失联集群与未部署集群不可区分，且节点只在有放置时才刷新（`SyncNodeSnapshot` 由放置路径触发），空转集群会被误判失联 |
| 复用 `heartbeat` 包与 `lumo_service_heartbeats`（E4/D6） | 语义冲突：那张表的语义是「**控制面服务实例**存活」，governance 用它求值就绪门禁。把「集群」塞进去等于让一个字段承担两个语义——正是 E4/D6 刚花一轮拆开的东西 |
| **集群自报 + 独立注册表**（选定） | 需要集群侧有上报方（本轮只做服务端） |

**选定形态**：新增 `scheduler_clusters`，集群自报走一条显式接口；**节点注册额外 `touch` 该行**作为旁证（节点能注册说明网络确实通），但**不作为主判据**（否则空转集群会被误判失联）。

### 3.2 时间基准：**一律库端时钟**

`last_seen_at` 由**写语句在库里**取 `now()` 写入（与 `scheduler_nodes.registered_at` 现有写法一致：`(EXTRACT(EPOCH FROM now()) * 1000)::bigint`），读取时**由 SQL 算年龄**，Go 只负责把年龄映射成状态。

理由与 E4/D6 同源：自报来自多台主机，拿读取方自己的时钟相减会引入无界偏差，产出任何测试都钉不住的 flake。这样切分还有个好处——**「年龄 → 状态」是纯函数，无库可测**；时钟一致性由 SQL 单独保证。

### 3.3 阈值写法：`suspect < down` 是启动期硬约束，不静默纠正

`LUMO_CLUSTER_SUSPECT_MS`（默认 30000）/ `LUMO_CLUSTER_DOWN_MS`（默认 90000）。配置反了（suspect ≥ down）时**拒绝启动并点名变量**，不 clamp。

理由：反了的后果是 `suspect` 状态**永远不可达**，而「没有可疑集群」看起来和「一切健康」一模一样——一个静默失效的状态机比一个起不来的进程危险得多。

### 3.4 `suspect` 的语义边界：只挡新放置

`suspect` 期间**停止向其新放置，已有任务不动**（§7.4.1 明文）。理由：跨集群迁移代价远高于等待，秒级阈值会让一次网络抖动引发全量任务大迁移，反而制造故障。因此闸门加在**放置路径**（`EligibleNodes`），不加在既有放置的读写路径上。

### 3.5 闸门放在 `planner` 里，不加在上游剪枝

不改「在 `cat.List` 之后先把坏集群的节点删掉」——那会让约束可被绕过，而 `EligibleNodes` 现有注释（`planner.go:32-35`）明确写着它被放置与抢占共享，**就是为了让抢占不能绕过硬约束**。集群健康是硬约束的一种，必须走同一条路。

实现上**不给 `Pick` / `FullEligibleNodes` 加参数**（那会扩散到 4 个调用点与多份测试）：把判定结果作为**节点自身的一个字段**（`domain.Node.ClusterState`）在目录读取后填充一次。理由是「作为候选节点的当下可放置性」本就是目录视图的一部分，与 `LastSeen` 同源。

### 3.6 未注册的集群 ≠ 已注册但失联

两者在响应与日志里**必须可区分**：前者是配置事实（重试无用），后者是故障。这与 E4/D6 的 `403 CLUSTER_ONLY` / `503 CLUSTER_NOT_READY` 是同一判据：**拒绝码要分永久与临时**，否则运维会去改配置而真问题是服务挂了。

## 4. 组件与边界

| 包 / 文件 | 改动 | 依赖 |
|---|---|---|
| `internal/domain` | 新增 `ClusterState` 枚举（含只能派生、不能声明的取值）、`Cluster`、纯函数 `EvaluateCluster(ageMS, suspectMS, downMS)`、`AnnotateClusterStates` | — |
| `internal/store` | DDL `scheduler_clusters`、`UpsertCluster` / `TouchCluster` / `ClusterAges`（**年龄由 SQL 算**） | pgx/v5 |
| `internal/catalog` | `List` 填充 `registered_at` → `Node.LastSeen`（Pg 直接取列；Nacos 用查询时刻） | pgx / http |
| `internal/planner` | `EligibleNodes` 增加一行闸门；**签名不变** | — |
| `internal/server` | `PUT/GET /v1/clusters[/{clusterID}]`；冲突码分永久/临时 | 标准库 |
| `cmd/scheduler` | 装配 + `LUMO_SCHEDULER_CLUSTER_ID`（本实例代表哪个集群自报）；阈值校验 | — |
| `internal/server/metrics.go` | 集群维度带标签 gauge（复用 C2 的 `SetGaugeWithLabels` / `ReplaceGauges`） | — |

## 5. 数据与接口

```sql
CREATE TABLE IF NOT EXISTS scheduler_clusters (
  cluster_id    TEXT   PRIMARY KEY,
  realm         TEXT   NOT NULL DEFAULT '',
  namespace     TEXT   NOT NULL DEFAULT '',
  capabilities  TEXT   NOT NULL DEFAULT '[]',  -- JSON 数组文本（沿用 payload 一律 TEXT 的约定）
  version       TEXT   NOT NULL DEFAULT '',
  registered_at BIGINT NOT NULL,               -- 首次注册，库端时钟
  last_seen_at  BIGINT NOT NULL                -- 每次自报刷新，库端时钟
);
```

`ClusterAges` 返回**年龄**而不是时间戳（`(EXTRACT(EPOCH FROM now()) - last_seen_at / 1000.0) * 1000`），使 Go 侧不需要时钟。

纯函数签名（可无库测试）：

```go
func EvaluateCluster(ageMS int64, suspectMS, downMS int64) ClusterState
// 区间取半开：[0, suspect) healthy / [suspect, down) suspect / [down, ∞) down
```

## 6. 判据 / 验收

| 判据 | 验证方式 |
|---|---|
| 两段式的边界**逐点**正确（age 恰好 = 30s / 90s 时落在哪一侧） | 纯函数表驱动测试，**不碰库** |
| 阈值反了时拒绝启动并点名变量 | 装配函数单测 + 一次真实进程启动 |
| `suspect` / `down` 集群的节点**不进**新放置；`healthy` 不受影响 | `planner` 表驱动测试（含抢占路径） |
| 未注册集群与失联集群的响应**可区分** | handler 契约测试（假 store，零外部依赖） |
| 年龄由 SQL 计算（Go 侧无时钟） | 活库用例断言「改 `last_seen_at` 后年龄随之变化」；PG 门控 |
| 新指标确实有写入点 | `platform/deploy/alerts-verify.sh` 必须仍绿（它按 AST 找写入点） |

## 7. 已知空洞与风险

1. **`Node.LastSeen` 在 Nacos 形态下恒为「查询时刻」**（`List` 只返回健康实例）→ 该形态下**不能**用逗龄判集群健康，必须走自报。这一点要写在 `catalog` 的实现注释里，否则下一个人会以为它两边都成立。
2. **本轮实现完成后，若没有集群侧上报方，所有已注册集群都会走向 `down`**。因此 `LUMO_SCHEDULER_CLUSTER_ID` 未设置时应让能力**整体关闭**（不注册、不判定、闸门恒放行），而不是「注册了但没人报」——后者会立刻把所有节点挡在放置之外，是一次自伤。
3. **判定与漂移之间的时间窗**：`down` 之后到下一轮实现漂移之前，任务会**留在原集群不动**。这是安全的（宁可不动也不搬家），但要在文档里写明，避免被读成「漏了」。
   **→ 2026-09-16：窗口已按 `down + grace` 闭合（§9.7），默认 `grace=5min`。**
4. 集群自报含 `capabilities` / `version` 两个字段但本轮**无人消费**（偏好打分与版本一致性都不在范围内）。保留列是为了让注册表形状一次定对，注释须写明「当前只做记录，不做准入门槛」——否则会被当成已生效的约束。

## 8. 实施记录（2026-09-15）

实现范围与 §2 一致：联邦注册表 + 两段式判定 + 放置闸门 + 集群维度指标。文件落点：

| 文件 | 内容 |
|---|---|
| `scheduler/internal/domain/cluster.go` | `ClusterState`（含只能派生的取值说明）、`ClusterThresholds`、纯函数 `EvaluateCluster`、`AnnotateClusterStates`、`BlocksPlacement` |
| `scheduler/internal/store/cluster.go` | `RegisterCluster` / `ClusterAges` / `ClusterByID`（年龄由 SQL 算）、`ErrClusterNotRegistered` / `ErrClusterRealmConflict` |
| `scheduler/internal/store/store.go` | `scheduler_clusters` DDL（**无 state 列**，理由写在建表注释里） |
| `scheduler/internal/catalog/clusterstate.go` | `WithClusterStates` 目录装饰器 + `ClusterDirectory` 只读接口 |
| `scheduler/internal/planner/planner.go` | `EligibleNodes` 里一行闸门（§3.5） |
| `scheduler/internal/server/cluster.go` | `PUT/GET /v1/clusters[/{id}]`、`RunClusterReporter` 自报循环 |
| `scheduler/internal/server/metrics.go` | `lumo_scheduler_cluster_age_seconds`、`lumo_scheduler_cluster_state`（一簇一维）、`lumo_scheduler_cluster_registry_ok` |
| `scheduler/cmd/scheduler/main.go` | 阈值校验（拒绝启动）、目录包装、自报循环装配 |
| `platform/deploy/prometheus-alerts.yml` | `LumoClusterStoppedReporting`（class `node_down`，P2） |

### 8.1 两处与原设计不同的地方（都是「不加不可信的东西」）

1. **没有给 `Node` 加 `LastSeen`。** 原设计（§4 的 catalog 行）打算把
   `scheduler_nodes.registered_at` 读进 `Node.LastSeen`。实施时否掉了：Pg 形态下
   `registered_at` 也只在 `Upsert` 时刷新，**同样是流量驱动**，而 Nacos 形态下它恒等于
   查询时刻（§7.1 已写明）。也就是说这个字段在两种形态下都没有可信消费者，加进来只会
   诱导下一个人拿它判存活——那正是本设计要否掉的用法。**不提供比提供错的好。**

2. **没有做「节点注册时顺手 touch 集群行」的旁证**（§3.1 末段）。理由同源且更强：一个
   存活列只能有**一个写入方和一个含义**（`last_seen_at` == 「有自报说它还活着」）。
   让节点注册顺手刷新它，等于把流量驱动的信号伪装成自报贴进判定输入——而空转集群恰恰
   没有流量，判定反而更不可信。旁证的价值抵不过它带来的语义混淆。

### 8.2 实施中被实现逼出来的决定（评审稿没写到的）

- **自报循环本轮就做，且周期由阈值派生而非配置。** §2 把「客户端接入」留到下一轮，
  但 `LUMO_SCHEDULER_CLUSTER_ID` 的含义本来就是「本实例代表哪个集群自报」，所以
  本实例的自报循环属于服务端这一轮（TS / dsh-node 侧的上报链路仍留到下一轮）。
  周期固定取 `suspect/3`（默认 10s）而不是加一个环境变量：一个能配得比 suspect 还慢的
  周期会让本集群在两次自报之间被判成可疑，从而**把自己挡在放置之外**——纯配置造成的自伤，
  不值得提供一个开关。
- **`Validate` 增加了 suspect ≥ 1000ms 的下限。** 来自铁律 19「严禁秒级切换」；
  顺带也保证派生出的自报周期非零（不足 3ms 时整数除法会得到 0，退化成忙循环）。
- **闸门对「未知」放行，且这一点写进了用例。** `unregistered`（注册表里没这个集群）
  与 `unjudged`（本实例未参与判定）都不拦。把「注册表没配好」也当成拒绝，会让配置问题
  升级成整个平台无法放置——而这与 §7.2「半开的注册表是自伤」是同一条推理的两面。
- **读注册表失败时放行 + 留日志。** 见 `catalog.WithClusterStates` 的注释：读不到注册表
  多半意味着 PG 有问题，那时 `PlaceTask` 也写不进去。
- **realm 在校验上是写侧约束，不是读侧过滤。** 首次带 realm 的注册即归属，之后跨 realm
  的同名注册返回 409（`cluster-realm-conflict`）；读侧不过滤，因为集群是基础设施事实
  （被过滤掉的集群仍在全局限定放置，藏起来会让「为什么这个集群排不进去」无从查起），
  而本组端点整体在控制面令牌之后——realm 不是这里的鉴权边界，令牌才是。
- **`suspect` 不单独出告警规则。** 默认阈值下 suspect 只持续 `down-suspect` = 60s，
  任何 `for >= 1m` 的 suspect 规则都**攒不满时间**，属于本仓库反复清理的那类
  「语法合法、永远不会响」的规则。需要看这一档用 `lumo_scheduler_cluster_age_seconds`。

### 8.3 验证

- 纯函数/组件用例 **82 条通过**（`domain` / `planner` / `catalog` / `server`），
  `go test -race -count=1 ./...` 全绿、`gofmt -l` 空、`go vet` 空。
- 边界逐点：`-1 / 0 / suspect-1 / suspect / down-1 / down / down+1 / 极大` **八个点**各自
  断言到状态，且断言 `ClusterThresholds.Evaluate` 与纯函数同源。
- 闸门：`EligibleNodes` 的候选集合（suspect/down 缺席，unregistered/unjudged 在场）、
  `Pick` 不落到别的集群、`FullEligibleNodes`（抢占路径）同样绕不过。
- 真实进程启动：三种非法阈值各自**退出码 2** 并点名变量
  （`LUMO_CLUSTER_SUSPECT_MS(90000) 必须小于 LUMO_CLUSTER_DOWN_MS(30000)` 等），
  且发生在连库之前。
- 自报循环：首轮立即上报、失败后继续重试、日志只打状态跃迁（连续失败恰好一条 Error、
  恢复恰好一条 Info）、ctx 取消后退出。
- 门禁：`platform/deploy/alerts-verify.sh` 通过（14 条规则 / 14 段表达式，9 个反例全被
  抓住），新指标名因此被证明**确有写入点**。

### 8.4 未验证（必须在有 PG 的环境里补）

5 个活库用例在本机**全部跳过**（无 PostgreSQL、无容器运行时）——**（2026-09-16 更正）**「无容器运行时」
这半句是错的：本机有 Docker，当时只是**守护进程没启动**；`open -a Docker` 之后
`platform/deploy/test-local-pg.sh` 已能起 PG 并把这类用例真正跑起来。以下 5 项因此**可以在本机补测**，
不再是环境阻塞：DDL 建表幂等、
「年龄由 SQL 算」（回拨 `last_seen_at` 后年龄随之变化）、跨 realm 覆盖被拒且无半截写入、
未注册与失联可区分、以及**端到端闸门**（注册表 → 目录注解 → planner → HTTP 202）。
其中风险最高的是 `RegisterCluster` 的 `ON CONFLICT ... DO UPDATE ... WHERE`——它的
「拒绝」分支断言依赖 `RETURNING` 不返回行这个行为，只有真库能证明。该写法与
`store.Acquire` 用的是同一构造（那里有活库覆盖），但**不能因此免检**。

## 9. 实施记录：任务漂移（2026-09-16）

本节对应 §2「不在范围内」表里的第一行——**当时被显式推迟的那一项**，现在单独一轮闭合。
§8 的判定与闸门是它的前提：没有「哪些集群确实 down」这个可信输入，就不该动手搬任务。

### 9.1 范围与动作的语义

架构原文（§7.4.1）只有一句话：「集群失联 → 判定期(cluster-suspect 30s) →
确认期(cluster-down 90s) → **任务漂回全局 Task Bus 重放置**」，外加一条硬约束
「迁移前必须确认 fencing（原集群不可能仍在执行），否则违反 R2 的幂等要求」。

因此漂移的动作**不是「挑一个目标集群搬过去」，而是「解除旧的绑定」**：

| 列 | 改成 | 为什么 |
|---|---|---|
| `state` | `PENDING` | drain loop 下一轮把它当新任务放置 |
| `node_id` | `NULL` | 不再指向原节点 |
| `cluster_id` | `''` | 退回「任意集群」的退化形态（§1 的 R2：空 cluster 本来就等于任意集群），由**放置闸门**去排除失联集群 |
| `avoid_nodes` | 追加原节点 | 见 9.3 |
| `attempt` | **不动** | 下一次 `PlaceTask` 在 PENDING 上开 `attempt+1`，而 fencing 正靠这个（见 9.2） |

「选哪个集群」交给**放置**而不是漂移：偏好打分（clusterTag/region 亲和）在本轮范围外
（§2 第三行），在漂移里塞一个目标集群参数等于让打分逻辑偷偷长在搬家逻辑里。

### 9.2 fencing 靠的是 attempt，不是新机制

`CompleteTaskAttempt` 的 WHERE 是「**仍处于活跃态** 且 `attempt` 相等」。漂移之后两条
都不成立：

- 状态已回 `PENDING`（不在 `PLACED/RUNNING/CANCELLING` 里）；
- 即便任务已被重新放置成 `attempt+1`，旧节点的 `attempt` 也对不上。

于是原节点迟到的终态回报**不生效**——不释放新 attempt 的槽位、不把任务误判成终态。
这就是 §7.4.1「跨集群重放置产生新 attempt 而非并行执行」在记录层面的落点，
**不需要引入任何新的 token 或世代号**。

用真库做了**对照实验**（同一库、同一代 attempt、同一份回报）：被漂移的那条回报不生效、
没被漂移的那条生效。差别只能来自漂移本身，排除了「回报路径本来就不工作」这种解释。
用例：`TestMigratedTaskRejectsTheOldNodesResult`。

### 9.3 为什么还要追加 `avoid_nodes`（对 fencing 的诚实补偿）

上面的 fencing 只在**回报**层面成立，它阻止不了原节点在物理上仍在执行——
判据只能确认「目录里没有它」，那**不等于**「它已经停了」（集群可能只是自报中断，
任务其实在正常跑）。此时若原集群随后恢复、而任务又被放回**同一个节点**，就是实打实的
双执行。

`task.AvoidNodes` 是现成机制（`planner.EligibleNodes` 里的 `contains(task.AvoidNodes, n.NodeID)`），
追加一行就能堵掉这条路。这是承认「fencing 无法被完全确认」之后的补偿，不是锦上添花。

物理层面的重复副作用最终由 **R2 的 turn 级恢复契约**（工具幂等分类 + recovery 插件按
`(tool, args, turn)` 算幂等键）兜底——架构 §7.4.1 把 fencing 与 R2 绑在一起说的正是这件事。

### 9.4 outbox 是绕过 fencing 的后门，漂移必须自己堵

`scheduler_dispatch_outbox` 是派发的唯一真相，而 `ClaimDispatch` 只看
`node_id + claimed_by IS NULL + delivered_at IS NULL`——**它不看任务状态**。于是漂移之后，
一条**未被认领**的旧 attempt 派发行仍会被投给原节点。

`RequeueStaleDispatch` 那边有 `EXISTS (state IN ('PLACED','RUNNING'))` 守卫，但它挡的是
**已认领**那半边的**回收**；未认领这半边没有任何人管。所以 `MigrateTask` 在**同一事务内**
删掉该 `(task_id, attempt)` 的未认领行，并把条数写进日志与
`lumo_scheduler_voided_dispatches_total`。

已认领的行**不删**：那条 RPC 可能已经发出或正在发，删行只会让本地账目与实际不符；
而它的回收路径已被上面那条 EXISTS 守卫挡死（漂移后 `state=PENDING`），留着是安全的。

### 9.5 五道闸门

与 `stall.go` 共用同一套形状（不可逆动作的判据必须比「看起来像」硬得多）：

| # | 闸门 | 不成立时的行为 |
|---|---|---|
| ① | 本实例是 leader | 静默返回（每个副本都跑循环，领导权会转移） |
| ② | 注册表**可读** | Warn + 整轮不动手。读不到 ≠ 没有失联集群 |
| ③ | 目录快照**新鲜**（限 3× 刷新周期，与 stall 共用常量） | Warn + 整轮不动手。陈旧快照是真实节点集合的**子集**，偏向把活节点判成不存在 |
| ④ | 集群越过 `down + grace` 时间线 | 常态，不打日志 |
| ⑤ | **原节点不在快照里** | 跳过该任务（见 9.6） |

落库侧还有**条件写**的三个条件（状态仍可漂移、attempt 仍是观测的那一代、集群仍是观测的那个），
任一不成立就什么都不做——包括不写台账。这是「判定与落库之间隔着一次数据库往返」的必然要求。

**`CANCELLING` 被刻意排除在可漂移状态之外**：取消是用户意图，原节点收到停止请求后可能正在
走向 `ABORTED`；把它漂走等于**丢掉那次取消**（新节点并不知道有人要求它停）。卡住的
`CANCELLING` 由 `max_stall` 死信兜底，不需要漂移管。

### 9.6 【本轮最重要的发现】闸门 ⑤ 在两种目录形态下的行为完全不同

闸门 ⑤（原节点不在目录里）在两种形态下的行为必须写清楚，否则下一个人会以为它两边都成立：

- **Nacos 形态**：目录只返回健康实例（`catalog/nacos.go:71-73`），集群失联时它的节点已经
  静默消失 → 闸门 ⑤ **恒满足**。冗余，但无害，而且能抓住「Nacos 还认为某节点健康」这种
  与集群自报**矛盾**的信号（那时不搬家是对的）。
- **Pg 形态**：`scheduler_nodes` 只增不减（全仓没有任何 `DELETE`）→ 节点永远在目录里 →
  闸门 ⑤ **恒不满足** → **漂移在这个形态下不会发生任何动作**。

第二点乍看像缺陷，实际是**正确行为**：Pg 形态就是单集群形态（local-lite），
**没有第二个集群可搬**——跨集群漂移在这个形态下没有意义。多集群必然用 Nacos。
这与 C2/R8 已经记录的「`task_lost` / `node_down` 在 local-lite 下恒为 0」是同一条结构性事实，
不是新问题。**本轮把这个因果写成注释与用例，而不是留成下一个人的意外。**

### 9.7 与评审稿的偏离（一处，默认值）

**`LUMO_MIGRATE_GRACE_MS` 默认 300000（5 分钟），而不是 0。**

架构字面是「down(90s) 才漂移任务」，严格读即 `grace=0`。默认值取非零的理由：
`down` 阈值只能回答「多久没自报」，**回答不了「为什么没自报」**——集群真的挂了与
**自报方重启**（滚动更新、OOM、节点维护）在 `last_seen_at` 这一列上完全一样。而两者
的处置代价不对称：晚搬几分钟只是任务多等一会儿；误搬家要付一次跨集群迁移 + 一次
新 attempt + 一次幂等兜底。

这正是架构自己用「严禁秒级切换」表述的同一条推理（跨集群迁移代价远高于等待），
只是它没覆盖「自报方重启」这个场景。默认值取**保守档**属于同向加强，且**偏离已写明**。

参数仍然存在，`grace=0` 即可回到架构字面；`LUMO_MIGRATE_MS` 为负则整体关闭漂移
（关闭时**必须**在日志里说出来，否则「没有任务被搬走」会被读成「没有集群失联」）。

### 9.8 文件落点

| 文件 | 内容 |
|---|---|
| `scheduler/internal/domain/cluster.go` | `ClusterState.AllowsTaskMigration`（只有 down）、`ClusterThresholds.MigrateEligible`、`ValidateMigrationGrace` |
| `scheduler/internal/store/store.go` | `scheduler_task_migrations` DDL（**台账记 `from_cluster_id`**，因为任务行的 `cluster_id` 随后会被清空） |
| `scheduler/internal/store/migration.go` | `MigratableStates`（排除 CANCELLING）、`MigratableActiveTasks`、`MigrateTask`（条件写 + 作废未认领派发 + 台账）、`appendAvoidNode` |
| `scheduler/internal/server/migration.go` | `RunClusterTaskMigrator` / `migrateOnce`（五道闸门）、`migratableBy`、漂移累积器与发布 |
| `scheduler/internal/server/metrics.go` | `lumo_scheduler_task_migrations_total{outcome}`、`lumo_scheduler_voided_dispatches_total`（**无条件发布**，且在注册表块之前——注册表读不到时会 return） |
| `scheduler/cmd/scheduler/main.go` | `-migrate-ms` / `-migrate-grace-ms`、宽限校验（拒绝启动）、装配，并把**生效时间线**（`migrate_after_ms = down + grace`）打进启动日志 |
| `platform/deploy/prometheus-alerts.yml` | `LumoClusterTasksMigrated`（class `node_down`，P3/info）；同时修正 `LumoClusterStoppedReporting` 里已经过时的那句「已有任务不会被搬走」 |

### 9.9 验证

- **活库套件 155 PASS / 0 FAIL / 0 SKIP**（`platform/deploy/test-local-pg.sh scheduler`）；
  其中本轮新增 16 个用例函数在真库上**逐条确认执行**（不是被跳过计数掩盖）。
- 边界逐点：漂移时间线在 `-1 / 0 / suspect-1 / suspect / down-1 / down / down+grace-1 /
  down+grace / down+grace+1 / 极大` 十个点各自断言。
- **不变量**：任意 `grace ≥ 0` 下「允许漂移」都蕴含「判定为 down」——把「在 suspect 档
  漂移」这个类别整体排除，而不是逐点验证。
- 对照实验证明 fencing 来自漂移本身（9.2）。
- 条件写三个条件各自的正反用例；重复提交同一份观测是幂等的（台账恰好 1 行）。
- outbox：未认领的被作废、已认领的留着（各一条断言）。
- 门禁：`platform/deploy/alerts-verify.sh` 通过（**17 条规则 / 17 段表达式 / 11 个反例全被抓住**），
  两个新指标名因此被证明**确有写入点**。
- **单进程端到端实测**（真进程 + 真 PG + 真 HTTP + 真失联集群）。起调度器进程
  （`suspect=1000ms`、`down=2000ms`、`grace=0`、`migrate=1000ms`、`enforce=true`、
  本实例不自报），经 `PUT /v1/clusters/cn-east` 注册一个**没人续报**的集群，再往库里放一个
  挂在 `ghost` 节点（不在 `scheduler_nodes` 里，即闸门 ⑤ 满足）的 `RUNNING` 任务。观察到的：

  | 项 | 漂移前 | 漂移后 |
  |---|---|---|
  | `state` | `RUNNING` | **`PENDING`** |
  | `cluster_id` | `cn-east` | **`''`** |
  | `node_id` | `ghost` | **`NULL`** |
  | `attempt` | `1` | **`1`（未推进，fencing 的来源）** |
  | `avoid_nodes` | `["old-node"]` | **`["old-node","ghost"]`**（原有保留 + 原节点追加） |

  台账一行：`from_cluster_id=cn-east`、`from_node_id=ghost`、`cluster_age_ms=2063`、
  `snapshot_ms=872`；指标 `lumo_scheduler_cluster_state{state="down"}=1`、
  `lumo_scheduler_task_migrations_total{outcome="migrated"}=1`；日志恰好一条
  「任务已漂回全局队列」，含全部判据字段，之后每轮的 `candidates` 回落到 0。
  **时间线核对**：注册于 `T`，漂移发生在 `T+2088ms`，而 `down + grace = 2000ms`
  ——严格落在「越过阈值后的第一个循环」内，不是提前也不是随便某个时刻。

  > 这个实验能成立的关键设定是「任务挂在一个**不在** `scheduler_nodes` 里的节点上」。
  > 直接跑 Pg 形态是**观察不到动作的**（闸门 ⑤ 恒不满足，见 9.6）——那不是实验失败，
  > 正是那条结构性事实本身。这一条值得记住，否则下一个人会以为功能坏了。

### 9.10 未验证 / 已知边界

1. **端到端只走完了「一个集群失联」这一半，没有「任务落到另一个集群」那一半。**
   9.9 的实测证明了：判定 → 闸门 → 条件写 → 台账 → 指标 → 日志这条链在真进程上是通的。
   但它**没有验证目标端**——任务被置回 `PENDING` 之后需要真的被放到另一个集群的健康节点上，
   这要求第二个集群有**真实节点**（`scheduler_nodes` 里有行、且 `cluster_id` 是另一个值）。
   本轮所有 `MigrateTask` 用例都是直接调存储层，所以「目录 + 闸门 + 放置」三者串起来的
   完整链路仍未被覆盖。这需要在 `acceptance-cluster.sh` 那条人工链上补一步
   （与 C5 的 OPA 探针同类：本可抓住、但从没跑过）。
2. **`Pg` 形态下漂移恒不动作**（9.6）。这是正确的，但它意味着**任何只跑 local-lite 的
   回归都不会覆盖这条路径**——9.9 的端到端之所以能观察到动作，靠的是刻意把任务挂在一个
   **不在** `scheduler_nodes` 里的节点上，绕开了这条结构性事实。真实的多集群部署必须用
   Nacos，而 Nacos 形态在本机没有覆盖。
3. **`suspect` 档不告警**的既有结论不变：默认阈值下 suspect 只持续 60s，任何
   `for >= 1m` 的规则都攒不满时间（§8.2 末条）。

## 10. 实施记录：偏好打分 + 版本一致性前置（2026-09-17）

§7.4.1 里 C1 最后两件事。它们都是**准入**问题而不是存活问题，所以与 §8/§9 那套
「时间在库端、状态只能派生」的判据不重叠，各自带一组新的取舍。

### 10.1 偏好打分：A4 否掉的不是「打分」，是「没定义的打分」

评审稿 §6.2 给过一个公式 `score = w1*constraintMatch + w2*affinityGain + w3*(1-load) − w4*crossAZcost`，
design-review A4 以【P2】否掉了它，理由是**不可实现**而不是不该做：值域、归一化、
`affinityGain` 从哪来、权重怎么调，四项里三项没有定义。本轮按 A4 的建议**逐项定义**
出可实现版本，而不是绕开它：

| 项 | 决定 | 理由 |
|---|---|---|
| 值域 | 每项都归一到 `[0,1]`，加权求和；**分数只用于排序，不对外暴露** | 暴露绝对分会让它变成一个事实上的 SLO，而它只是偏好 |
| `load` | `clamp01(1 − active/capacity)` | 复用了既有 `Pick` 已经在算的负载比，不引入第二个「负载」定义 |
| `affinity` | 有**显式** `preferred_clusters` 时是 1/0（离散、优先）；否则 `项目在本集群的活跃任务数 / 该项目的峰值`；**无输入 → 0**（不是 0.5） | 「没有信息」与「打平」必须分开；给 0.5 会让一个没有会话归属的任务也参与偏好排序 |
| 硬约束 | **不参与打分**，仍在 `EligibleNodes` 里剪枝 | 打分是偏好，剪枝是正确性。把 requires 匹配放进分数里，等于让一个不匹配的节点「只要分够高」也能被选中 |
| 调参 | 只两项权重，启动时校验（`load > 0`），并打印**不变量边界** | 见下 |

**有界偏好**是这套设计唯一可验证的性质：`AffinityBound = Affinity / Load`，含义是
「亲和分最多能翻转多少负载比差」。默认 `{Load: 1, Affinity: 0.25}` → 一个亲和命中
最多压过 25% 的负载差；`Affinity = 0` 即退回纯负载最小。这条不变量有正反两侧用例
（`TestAffinityCannotFlipLoadGapBeyondBound`），比「权重看起来合理」结实。

**默认权重下与既有 `Pick` 逐字节同序**，这是「纯增量」这句话的可执行版本：
`Pick` 现在只是 `PickWeighted(..., DefaultPlacementWeights())` 的封装，而默认下
亲和分在没有输入时恒为 0，于是排序完全由负载决定——`TestPickWeightedMatchesPickUnderDefaultWeights`
在 6 种节点形状上比对了两个函数的输出。

### 10.2 版本一致性前置：判定集合就是「闸门真正允许的集群」

`EvaluateVersionConsistency(clusters, thresholds, healthGate)` 的判定集合**不是**
「所有已注册集群」，而是**放置闸门当下真正允许的集群**（已注册、且未被存活闸门挡住）。
这不是省事：一个已经 `down` 的集群本来就不接新放置，它的旧版本不该让全局任务停摆
——否则一次失联会连带把版本闸门也点着。

三档结论，其中**只有中间那档是「能判断」**：

| 情况 | 结论 | 为什么 |
|---|---|---|
| `Declared == 0`（无人声明） | **一致（放行）** | 没有信息。拦下来等于让「没人配版本」升级成全平台停摆 |
| 唯一版本 | 一致（放行） | — |
| ≥2 个不同版本 | **不一致（整体拒绝）** | 互相矛盾的信息，而矛盾正是我们能判断的那种 |

**「整体拒绝」包括那些确实等于多数版本的集群。** 这正是架构字面「先完成全集群分发
才允许全局调度」的意思：滚动升级升到一半时，全局任务落到哪一边都是错的一半。落到
「多数版本」上看起来更聪明，但那是把一个发布流程的决策偷偷换成一个调度器的启发式。

### 10.3 【本轮最重要的发现】给 version 加一个「对称的 declared 标记」是错的

§7.4.1 的前置要求是「把 capabilities 的『声明空集』与『未声明』拆成显式 declared
字段」。第一版把这个要求**按对称性**也施加到了 version 上：加了 `version_declared`
列 + `domain.Cluster.VersionDeclared` 字段。代价立刻显形，而且是两个方向的：

1. **既有调用方静默变成空操作。** 写路径改成「`declared` 为真才写值」之后，
   `RegisterCluster(Version: "v3")`（也就是**所有**不带新标记的写法）不再写入版本，
   而返回值看起来一切正常。抓到它的是 §8 之前就存在的一条活库用例
   （`TestClusterMetadataSurvivesAPureHeartbeat` 的「显式声明应覆盖」那一步）——
   它红了，而红得对。
2. **迁移把既有行判成「未声明」。** `ALTER TABLE ... DEFAULT false` 之后，所有
   迁移前就有 `version` 的行 `version_declared` 都是 false，而版本闸门读的正是它
   ——那些集群会被永久排除在全局放置之外。

判据其实是现成的，只是第一版没去用它：**「空值是不是一种有意义的声明」**。
空能力集是（这个集群没有 GPU，是一个真实约束，必须能表达）；空版本号不是
（「我声明我的版本是空字符串」不是一句话）。于是「说没说版本」与「版本是不是空」
是同一件事，`Version != ""` 就是那个标记本身，多存一列只会制造第二个真值源。

**结论：declared 标记不是对称性产物，是「空值有语义」时才需要的东西。**
version 的标记已整体移除（列、字段、配套归一函数），归一留在**写路径**上：
`CASE WHEN EXCLUDED.version = '' THEN 原值 ELSE 新值`。

### 10.4 另一处：字段名里的「事实」与「裁决」不能混

第一版把「这个集群的版本不可证明」直接叫 `BlocksGlobalPlacement`，于是
`TestVersionGateBlocksGlobalButNotPinned` 抓到一个 bug：**显式指定了 `cluster_id`
的放置也被拦了**。根因是那个字段同时装了两件事——「这个集群版本不可证明」（事实，
目录层就知道）与「要不要拦这个任务」（裁决，只有 planner 知道任务是不是全局的）。
目录层生成它时还不知道任务是什么，于是把裁决也一起固化了。

改名 `ClusterVersionUnproven`（事实），把 `task.ClusterID == ""` 这个条件移进
`planner.EligibleNodes`。与 §8.1「不加不可信的东西」同源：字段名里带上裁决，
迟早会有人在错误的地方读它。

### 10.5 与存活闸门**刻意相反**的一处

存活闸门对「未知」一律 **fail-open**（unregistered / unjudged 都不拦），因为拦下来
会把「注册表没配好」升级成全平台停摆。版本闸门对「未知」是 **fail-closed**：
fleet 有版本而某集群没声明（或压根没注册）时，该集群**不可证明**，于是被排除。

两处方向相反但不矛盾，因为防的是不同的东西：前者防「配置问题变成全平台停摆」，
后者防「版本不确定的集群混进全局放置」。放行后者等于给闸门留一个**一行配置就能绕过
的后门**——而绕过它的人不会觉得自己绕过了，只会觉得「这个集群没配上报而已」。
代价也不对称：前者的代价是全平台，后者只是单个集群被排除，而它随时可以靠声明版本、
显式指定 `cluster_id`、或关掉闸门回来。

**默认关**，三态（未设 / true / false），打错字报错并点名
`LUMO_CLUSTER_VERSION_GATE`：打开它会让「有人在滚动升级」变成「全局任务排队」，
那是产品决策而不是正确性修复，所以必须显式打开。

### 10.6 接线面（这是本轮花时间最多的地方）

判定与打分是纯增量，真正的工作量在**「让它在可部署拓扑里真的接上」**。与 §8 那次
「代码、测试、指标、告警都齐全，而开关在 compose 与 Helm 里一个都没有」是同一个坑：

- **store**：`ActiveClusterCountsByProjects`（一条 `= ANY($2)` + `GROUP BY`，
  只算 `PLACED/RUNNING/CANCELLING`，按 realm 隔离）、`preferred_clusters` 列与往返。
- **server**：`PreparePlacement` / `PickPrepared` 放在**独立文件**里，因为 HTTP 放置
  与 main 的 drain 循环都要用——两处各拼一遍 `PickWeighted` 会漂移，而漂移的方向
  恰恰是「drain 里漏掉了亲和输入」，症状在任何响应里都看不出来。
- **compose**：`LUMO_CLUSTER_VERSION` 由**承载节点**声明（不是调度器自己的版本，
  同 §8 那条「调度器还在跑 ≠ 集群还能接放置」的判据），每个集群一个变量
  （`LUMO_CLUSTER_A_VERSION` / `_B_`），于是「升到一半」能在本机复现。
- **Helm**：`dshNode.clusterVersion` + `services.scheduler.clusterVersionGate`，
  都写出来（含 false），理由与 `clusterEnforce` 一致。**刻意不默认成 `image.tag`**：
  节点池跑的是另一个镜像（`dshNode.image` 自带 tag），借用全局 tag 会在只覆盖节点
  镜像时静默报错版本，而错版本比缺版本更糟——闸门会放行它本该拦下的混合版本放置。
- **`cluster-registry-check.py`**：新增三条静态规则 —— `invalid-version-gate-value`、
  `version-gate-without-declarer`（**闸门开着而整个拓扑无人声明 = 恒放行**）、
  `version-gate-split-fleet`（闸门开着而拓扑写死两个版本 = 全局放置会一直排队，
  而它与「没有容量」同形）。门禁的反例自证从 6 条扩到 10 条（含两条 Helm 侧的
  `--set` 渲染用例：它顺带证明那三个键真的接在模板上——写错键名时 `--set` 会静默
  忽略，于是「闸门开着」的用例会因「闸门根本没开」而假绿）。
- **告警**：`LumoClusterVersionInconsistent`（P2，判据取闸门的结论而不是队列长度）
  与 `LumoClusterVersionGateInert`（P3，「闸门开着但没有任何集群声明版本」这一档
  在图上表现为**序列缺席**，缺席不会让任何表达式变真，所以要单独读那个计数）。
- **指标契约**：三条新序列进了 `cmd/alerts-verify` 的 `metricContract`。

### 10.7 验证

- 单测：`domain`（placement / version_gate 两个新文件）、`planner`（7 个用例，含
  「默认权重下与 Pick 同序」「亲和不能翻转超过边界」「版本闸门拦全局不拦固定」）、
  `server`（4 个）、`catalog`、`store` 全绿。
- 活库（`LUMO_TEST_PG_DSN` + compose 的 postgres）：`internal/integration` **37 条全过**，
  其中 6 条是本轮新增 —— 「省略即保持」与标记单调性、空版本归一、版本闸门端到端
  （注册表 → 目录注解 → planner → HTTP 三种状态码）、闸门关闭时的放行、
  项目亲和输入（按 realm 隔离 + 只算活跃态）、`preferred_clusters` 往返。
- 门禁：`cluster-registry-verify.sh` **19 项**（含 10 条反例）、`alerts-verify.sh`
  19 条规则 + 11 条反例、`helm-verify.sh`、`compose-ports-verify.sh`、
  `edge-cors-verify.sh`（27）、`edge-routes-verify.sh`（20）、
  `probes-cluster-verify.sh`（19）、`shell-portability-check.py`（21 个脚本）全绿。

### 10.8 未验证 / 已知边界

1. **版本闸门的端到端只走到「HTTP 放置」这一层，没走 drain。** `PreparePlacement` /
   `PickPrepared` 是共用入口，但 drain 那条路径只有编译期保证，没有用例真的把
   「HTTP 提交时带了偏好、被 drain 接续」跑一遍（`preferred_clusters` 的持久化
   往返用例是这条链的一半）。
2. **偏好打分没有真实多集群数据。** 亲和的输入是一条 `GROUP BY`，活库用例证明了它
   的**范围**（按 realm 隔离、只算活跃态），但「打分让任务更愿意留在同一个集群上」
   这件事只有构造出来的节点形状在证（`TestProjectAffinityKeepsWorkOnOneCluster`）。
3. **`AffinityBound` 只是上界，不是调参结论。** 默认 0.25 是「一个可解释的小量」，
   不是实测出来的最优值；真实负载下的取值需要有流量才谈得上。
4. **`version_declared` 列已从 DDL 里删掉，但已经跑过上一版 DDL 的库会留着那个空列。**
   无害（没有任何代码读它），且 `ADD COLUMN IF NOT EXISTS` 是幂等的；这里记一笔
   免得下一个人看到残留列以为还有消费者。

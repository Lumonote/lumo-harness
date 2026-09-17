# 集群收尾三件套（A 包）设计

日期：2026-09-17
状态：设计已评审通过，待实现
范围：「剩余所有功能」四包分解中的第 1 包

---

## 0. 背景：为什么拆成四包，而不是一轮做完

用户要求「修剩余所有功能」。侦察后确认剩余项跨四类**性质不同**的工作，塞进一份设计稿会同时
违反两条本仓库自己的教训——`cluster-gap-analysis.md` 写的「**同一句话里混了「已建」和「未建」
两个事实，是缺口清单最难发现的一种腐烂**」，以及「族别判断错会连带把『不可能』误判成『排期靠后』」。

分解结果：

| 包 | 内容 | 量级 | 需要活库 |
|---|---|---|---|
| **A** | 收尾三件套（gofmt / 探针接入验收链 / 文档漂移同步） | 小，无架构设计 | 否 |
| **B** | 设备通道剩余：取消 + 重启恢复 | 中 | 是 |
| **C** | C5 控制闭环剩余：Go `control.Dispatcher` 接线 + Session Console UI 视图 | 中 | 是 |
| **D** | C1 全局/集群 Scheduler 分层 | **大**，新增运行角色 | 是 |

**D 不是「补一个缺口」**：设计稿 line 45 明确将其推迟为独立轮次，它要回答的是两层各自的接口、
门禁在哪一层求值、两层各自的 leader 租约与 fencing、以及任务在两层之间的状态机与迁移路径——
量级超过 A/B/C 之和。因此 D 单独一轮、单独设计稿。

### 明确不做的三件（写下来，避免下一轮重新踩）

1. **E7b（connector 审计的 SessionEvent 投影器）——不做，判据是按构造不可实现。**
   dsh 没给平台插件留「写自定义持久事件类型」的通道：`Session.append` 的封套里没有 `ignorable`
   的位置，而持久化读路径对「不认识且无 `ignorable`」的事件**拒绝整份日志**。硬做等于让每个
   调用过连接器的会话在重载时永久打不开。替代路径已存在（会话侧 `tool/call` + `tool/result`、
   网关侧 `GET /audit?sessionId=…`）。详见 `cluster-gap-analysis.md` 的 E7b 行。
2. **D1（Nebula 进编排）——产品决策，不是代码缺口。** 血缘事实已落 PG（C7 已闭合），
   Nebula 只是可选呈现层。
3. **真集群验收证据——环境动作。** 需要整个拓扑起来，归 D5 遗留的那一类。

### 验收标准（用户 2026-09-17 决定）

**B/C/D 一律按「真库跑绿」交付**：`platform/deploy/test-local-pg.sh` 的输出必须含**非跳过用例计数**
（该脚本对每一步断言「至少执行 1 个非跳过用例」，并把跳过数与原因打出来）。

选这条的理由是本仓库的既有信条：**退出码不是证据**——`t.Skip` / `it.skip` 让退出码保持 0，
D5 那一轮实测过 19 个用例全跳过而报告 success。所以「绿」只有在活体用例真的跑了之后才算数。

A 包不需要活库。

---

## A1. gofmt

### 现状

`gofmt -l` 在 7 个文件上非空：

| 文件 | 是否本轮改动 |
|---|---|
| `control-plane/governance/internal/device/gateway.go` | **是** |
| `control-plane/governance/internal/domain/domain_test.go` | **是** |
| `control-plane/registry/cmd/desktop-agent/main.go` | **是** |
| `control-plane/governance/internal/breakglass/breakglass.go` | 否（既有） |
| `control-plane/governance/internal/breakglass/breakglass_test.go` | 否（既有） |
| `control-plane/governance/internal/server/devices.go` | 否（既有） |
| `control-plane/governance/internal/store/devices.go` | 否（既有） |

CI **没有任何 gofmt 门禁**（`.github/workflows/ci.yml:188` 只有 `go vet ./...`），所以这两组
都会一直留着。

### 决定的方案：7 个一起修 + 加 CI 门禁

只修本轮那 3 个是「把手指从洞里拿出来」——既有的 4 个仍在，规则依旧无门禁，下次照样复发。
**本仓库自己的信条反对这么做**：`cluster-gap-analysis.md` 反复写「没人调用的门禁与通过的门禁
无法区分」「手写枚举会腐烂」「期望值从现状反推的门禁在结构上抓不到集合缺员」。没有门禁的格式
规范与它们是同一类东西。

- **改动**：`gofmt -w` 这 7 个文件。纯格式化，零行为变化。
- **门禁**：`.github/workflows/ci.yml` 的 `control-plane-go` job 增加一步，对全部 15 个 Go 模块
  断言 `gofmt -l` 为空。gofmt 无网络、无 Docker、秒级，不增加 CI 的脆弱面。
- **代价**：4 个既有脏文件的 diff 会出现在本次提交里。它们是纯格式化，且**必须一起修**——
  否则门禁一加上就是红的（这正是「门禁要么全绿要么别加」）。

### 验证

`gofmt -l` 全空；`go build` / `go vet` / `go test ./...` 仍全绿（15 模块、77 包）。

---

## A2. 把 `probes-cluster.sh` 接进验收链

### 现状（这是本轮发现的、文档未记录的一处缺口）

`acceptance-cluster.sh` **通篇没有出现过 "probe"**（已用 `grep -n probe` 确认零命中）。
它只跑：`smoke-cluster.sh`（存活）+ 9 次 `go test` 集成 + 2 次 `vitest` 活库。

于是：**这条链打印 `cluster-acceptance: passed` 时，`edge-gateway` 与 `terminal-gateway` 的行为
一次都没有被碰过**。而这两个网关（C3/C4）与 C1/C5/C7 的验收证据，正是写在
`probes-cluster.sh` 里的那 6 条探针 —— 它不在链里，CI 也只跑 `probes-cluster-verify.sh`
（对**假服务**的分类门禁）。

这与 D5 那一轮的「验收脚本静默跳过而退出码为 0」是同一族：**证据存在、但不在被执行的那条路上**。

### 设计的方案

照搬既有调用形态（`acceptance-cluster.sh:89-92` 调 smoke 的写法），插在 smoke **之后**：

```sh
if [[ "${LUMO_ACCEPTANCE_SKIP_PROBES:-0}" != "1" ]]; then
  LUMO_ENV_FILE="${LUMO_ENV_FILE:-$root_dir/platform/deploy/.env}" \
    "$script_dir/probes-cluster.sh"
fi
```

三个判断，每个都有理由：

1. **顺序在 smoke 之后**：先答「服务在不在」，再答「在的那个是不是对的」。反过来的话，
   服务没起来时探针会刷一屏 `probe-service-absent`，把真正的第一因埋在噪声里。
2. **独立的 skip 开关**，不与 `LUMO_ACCEPTANCE_SKIP_SMOKE` 复用：两者失效含义不同
   （跳过存活检查 vs 跳过行为断言）。共用一个开关会让「我跳过了探针」看起来像
   「我跳过了存活检查」，而后者在读日志的人眼里是无害的。
3. **不把探针并进 `smoke-cluster.sh`**：两者的分工是刻意写进各自注释的（存活 vs 行为），
   合并会把那个区分抹掉——而那个区分正是 C5 的 OPA 绑定地址缺陷之后才被总结出来的。

拓扑文件保持默认：`probes-cluster.sh:51` 的 `LUMO_PROBE_TOPOLOGY` 缺省指向
`compose.cluster.yml`。这是对的——控制面端口（18080-18093）由**基础文件**发布，
`compose.cluster.acceptance.yml` 只给**中间件**加端口，所以探针在验收形态下够得着。

### 验证与诚实的边界

- `bash -n acceptance-cluster.sh`；`probes-cluster-verify.sh` 的 19 项仍全过（证明门禁没被削弱）。
- 断言探针**真的被调用**：`LUMO_ACCEPTANCE_SKIP_SMOKE=1` 走空壳拓扑时，输出里必须出现
  `probes:` 前缀的行。
- **本轮不产出**：真集群上 6 条探针全绿。那需要整个拓扑起来，归 B/C/D 那一档（见第 0 节的验收标准）。

---

## A3. 文档漂移同步

`docs/cluster-development-tasks.md` 有三处已被代码推翻、却仍被写成「未完成」。三处都同时是
**排期输入**——照它排期会重复开发。

| 行 | 文档现写 | 代码实况（证据） |
|---|---|---|
| C5 | 把 `dispatch()` 路由到控制面 `POST /v1/sessions/{ref}/control` 是「剩余步骤」 | 已实现：`pg-control.ts:120-135` 的 `dispatch()` → `submit()`；`:235-239` 真的 `fetch(url, {method:'POST'})`；未配置 `controlPlaneUrl` 时才抛 `ControlCommandRoutingError` |
| C5 | `agent/turn-stopping` 是「pause 不生效的真正缺口」 | 已由 `actuation.ts` 在 turn 边界闭合：`agent/pre-step` 返回 `reject`（拒之前把被 claim 的消息放回，claim 是消费，直接拒等于丢用户输入），`agent.cancel` 硬取消 abort；判据收在一张状态表的两个投影（`controlGate` 工具级 / `controlActuation` turn 级），`index.ts:203,215,248` 均已装配 |
| C1 | Nacos 形态的自报链路（TS/dsh-node 侧）「仍开放」 | 已实现：`cluster-reporter.ts:236-238` 的 `PUT /v1/clusters/{id}`（`:206` 先 `GET /v1/clusters` 读阈值派生周期），`index.ts:638-659` 已装配 |

### 改法：保留旧话并标注，而不是抹掉

沿用 `cluster-gap-analysis.md`「口径差异」表的体裁——**保留被推翻的表述 + 标注日期与判据**。
理由是该表的既有价值全部在「**怎么误判的**」这一栏：E2/E3 的误判根因（只读 doc comment、
只查「谁调了函数」而不查「谁消费了这张表」）比结论本身更有复用价值。

本次三处要记的根因是同一个：**记录实现写在一个文件、状态留在另一个文件，必然漂移**。
两份文档的 mtime 只差 1 分钟（19:43 / 19:44），说明是同一轮写的——所以这不是「忘了更新」，
是**同一个事实被写在两个地方**。

> 顺带纠正一处口径：C 行里「Nacos 形态自报链路」与 gap-analysis 的「已闭合」曾经冲突，
> 本次以**代码**为准判为已闭合。两份文档冲突时先看哪一边带了行号与用例名——
> 这条规则 `cluster-gap-analysis.md:30-32` 自己也写过。

---

## 本包不做什么

- 不动 `governance/internal/breakglass` 的任何**语义**——只格式化。它是 E1 记录的
  「有意保留的合规边界」，补全它等于替用户做产品与合规决策。
- 不新增探针、不修改既有 6 条探针的判据。A2 只做**接线**：探针的判据（含「正确不止一种形状」
  那条刻意的放宽）在 2026-09-16 那一轮已经论证过，本轮无权改。
- 不动 `deepseek-harness/`（第一铁律）。

## 验证清单

| 项 | 判据 |
|---|---|
| A1 | `gofmt -l` 在 15 个模块上全空；`go build`/`go vet`/`go test ./...` 仍全绿 |
| A1 门禁 | 故意弄脏一个文件，CI 那一步必须转红（**门禁要能自证**——本仓库对「只检查好输入的门禁」有明确判据） |
| A2 | `bash -n` 过；`probes-cluster-verify.sh` 19 项仍过；跳过 smoke 时输出含 `probes:` 行 |
| A3 | 三处文案与代码一致；旧表述保留且带日期与判据 |

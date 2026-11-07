# 团队隔离、跨节点条件写入与线程看板（2026-11-06）

开发分支为 `codex/v1.2.1`。本轮补齐团队存储的租户归属与跨实例 CAS，并把治理可见任务、Thread 注册表和会话控制态接到同一个看板。所有实现位于 `platform/`，未修改上游 dsh 跟踪源码，未使用 frontend-design。

> **后续更新**：旧团队迁移、持久委派回执、流程算子、Run 计量、跨语言矩阵与分页已继续开发，见 [团队迁移、流程委派与分页](./team-migration-and-governed-flows-2026-11-06.md)。下文的 531/244 结果属于本阶段，后续验证单独记录。

## 已交付

| 范围 | 行为与约束 |
|---|---|
| 团队身份 | `TeamState` 新增可选 `realm`、`ownerUserId`、`revision`；新团队由可信节点配置赋予归属。服务限制 realm/配置 owner，模型工具另限制真实 `exec.agent.id` 对应的 captain；异步派发与写回保留该身份 |
| 存储命名空间 | 团队 key 为 `r_<sha256(realm)>_<teamId>`；两个 realm 可以使用相同团队 id。读取时核对 key、记录 id 和 realm；无归属老记录保留但不自动认领 |
| 跨实例并发 | 创建使用 insert-only CAS，修改重读快照后条件提交，冲突最多重试 32 次；任务序号、认领、完成和删除均走该路径。进程写链负责本实例排序，PG CAS 负责跨实例原子提交 |
| 防止删除复活 | 删除写入持久墓碑；旧快照不能覆盖墓碑，同 realm 已删除团队 id 不可复用。内存实现具备相同语义；SQLite 的比较写入只承诺单进程 |
| 结果与对账 | 拒绝失效 attempt、assignee、状态的派发；写回成功提交之后才返回验收判据。对账提交时重新核对探测过的 attempt，防止旧通道状态重排新执行 |
| 会合面隔离 | mailbox 的全局 `futureId` 增加 `lumo-agent-teams:<encoded realm>:` 前缀；realm 字段不再被误当作主键隔离措施 |
| PG KV | 新增可选 `getRecord` 点读和 JSONB 语义 CAS；schema/unit 首次建表用事务 advisory lock 协调并发启动。支持上游 `compatibleVersions`：只读不升级，首次真实修改与版本戳同事务，无效删除不升级，升级后旧 writer 被拒 |
| PG 失败处理 | PG 团队存储未就绪或初始化失败时明确拒绝读写，不回落节点各自内存。schema 初始化、unit 初始化、数据写入回滚失败时丢弃连接并返回 `unknown-state`；初始化失败仍可关闭连接池 |
| 团队页面授权 | 列表和详情均检查签名身份的 realm；普通用户只看自己拥有的团队，realm 管理员可看同 realm 内、服务可见的团队；成员的 owner 绑定不授予团队访问权 |
| 控制态批量读 | 新增 `GET /v1/session-controls?session_ref=…`，必须有可信 realm/user，单次 1..100 个 refs。按 realm 与 refs 批读；未知与其他租户会话均返回 `registered:false,state:null`，不创建记录、不枚举全租户 |
| 旧控制态读面 | 单会话状态、队列现场、时间线收到可信身份头时执行 realm 隔离；跨租户与未知会话同形。时间线在数据库分页前过滤 realm，响应再次检查 realm/session。动作放行记录读取优先使用可信身份中的 realm；身份头不完整时拒绝 |
| 线程聚合 | 新增 `/lumo/api/collaboration/threads`，先取得当前签名用户可见的治理任务，再关联同 realm、同可见 task 的 Thread；控制态查询集合来自服务端关联，浏览器的 `realm/session_ref` 参数无法覆盖 |
| 看板显示 | 使用注册表的 node/session 事实；治理 `{tasks:[…]}` 与旧数组响应均可读。控制态分批读取，整批校验后才采纳；某批失败不抹掉其他批次的已知批准项。审批等待只按控制态时间计时，时间戳缺失时不猜超时 |

**计数更正及续开发**：本阶段曾把任务与线程都写为 500 条，这是错误的。治理上游默认最多返回 200 个任务，500 只是 UI 切片与线程读取上限。后续已补任务创建时间/ID 游标分页（每页最多 200）、当前授权任务内的线程 ID 分批（每批最多 500）及页面翻页；控制态仍每 100 个会话分批。页面暂时读取失败时保留上次成功页并显示原因，401/403 清除旧结果；缺席读面仍显式显示。该分页不是跨请求数据库快照，大规模容量验收尚未完成。

## 升级与兼容

本轮改变了团队 key 和 mailbox 等待项命名空间。升级前应停止旧版本团队写入与派发，备份存储，并对账在途轮次；不能把新旧 writer 混跑当作已验证的滚动升级。

- 老团队记录不会根据当前登录用户自动补 realm/owner。后续已提供 PostgreSQL 显式归属迁移工具，按可信映射与源指纹预检、逐团队原子迁移并留墓碑，默认仅预览；使用方法和停写限制见续开发记录。上线前仍必须处理已有团队，否则新读面不会展示它们。
- 新版 mailbox 不会查找或兑现旧命名空间的 pending 等待项。需在升级前排空或明确处置旧轮次；不做可能跨租户的模糊回退。
- 墓碑禁止团队 id 重用。需要新团队时使用新 id；回滚到旧代码不保证继续理解新命名空间与墓碑。
- 团队 owner 当前来自节点 `actingUserId` 配置，**尚未完成按真实多用户会话动态映射 owner**。captain 工具隔离已接线；Bot 发送者身份仍不能直接取得团队执行权限。
- 旧版单会话读 API 的无身份头调用保留可信服务契约，仍受服务入口的控制面令牌保护；有身份头时必须同时提供 realm/user。该兼容路径不等同于面向浏览器的匿名 API。新批量 API 始终要求完整身份。
- 旧单会话读面目前提供 realm 隔离；同 realm 内进一步按用户/任务授权仍由调用代理负责。新线程聚合先用治理任务可见性限制会话集合。
- 本阶段团队隔离与 KV 条件写未新增业务表或部署 DDL；这是阶段事实。随后续开发新增迁移 012（治理委派回执）、013（治理分页索引）和 014（线程任务分页索引），见最新记录。

## 验证

使用隔离的真实 PostgreSQL 16，不连接生产数据。

| 检查 | 结果 |
|---|---|
| `agent-teams`、`storage`、`lumo-ui` Vitest | **531 PASS / 0 FAIL / 0 SKIP**，47 文件，包含开启 `LUMO_AUTH_PROXY_TEST=1` 的代理用例 |
| session-control `go test -race -count=1 -json ./...` | **244 PASS / 0 FAIL / 0 SKIP**，包含子测试计数与真实 PG 存储测试 |
| session-control `go vet ./...`、`go build ./...` | 通过 |
| 平台 TypeScript 与 UI TypeScript | 均通过 |
| UI 客户端、服务端 bundle | 均通过 |
| `git diff --check` | 通过 |
| 上游洁净检查与 `assert-pristine.mjs` | 通过，检查时上游 HEAD 为 `fcc0ad46` |

关键行为验证：两个独立 PG backend/service 同时创建只有一个成功；24 次跨实例追加不丢任务或复用序号；同任务并发认领只有一个成功；并行完成保留两份结果；删除阻断旧快照，重开存储后仍不能复活；同 id 跨 realm 隔离；八个 backend 并发首次启动；上游 KV 共享契约与兼容版本行为通过。模型工具覆盖跨 captain 和匿名拒绝；HTTP 代理覆盖签名身份、伪造浏览器参数、列表/详情间归属变化与治理拒绝后停止后续查询。

本机证据在 gitignored 的 `platform/.build/team-regression/`：`ts-regression.log`、`ts-results.json`、`go-test.log`、`go-vet.log`、`go-build.log`、两份类型检查日志、`ui-bundle.log` 与 `final-summary.json`。测试用隔离 PG 与密码文件在收尾时清理。

## 仍需继续开发与验收

以下清单按随后续开发更新；本阶段原本未实现的旧团队迁移、governed Run 计量、Go/TS 矩阵与手动分页已经补齐，最终回归见最新记录。

1. Bot→agent-team 的持久授权执行桥：稳定 captain、发送者到平台用户映射和权限交集。已完成的 Flow `delegation.create` 使用流程作者授权 Worker，不等于 Bot sender 获得团队权限。
2. 按真实多用户会话确定 owner，以及任务/线程分页的大规模容量验证。迁移工具和手动分页不再列为未实现。
3. 后续已补显式本节点文本档位的固定节点、稳定会话和轮次计量，见 [Thread 稳定执行](./thread-stable-execution-2026-11-06.md)。跨节点传输、自动唤醒执行和依赖可信完整影响面的强制异构审查仍待开发。
4. 真实 LLM、飞书/企业微信等厂商协议与回复、生产故障域和长期压测。本轮未重跑 24 服务完整集群，也未部署生产。

不能据此宣称 Thread 已经支持任意节点透明续跑，或 Bot 已能按发送者授权执行团队任务。

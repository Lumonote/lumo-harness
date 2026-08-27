# Seam 远程形态设计说明 —— needs-design 13 项各自的正确归属

- 日期：2026-08-26
- 前置：`platform/shared/seam-contracts/remotability.ts`（分级表：`class`/`shape`/`belongsTo` 是**准入判据唯一真相源**，本设计不改表）
- 评审对应：R1（任意 seam 可远程化过宽 → 分级表；本设计把「needs-design」变成具体形态）
- 章节：`docs/architecture.md` §4.1（可远程化边界）/ §4.2（复制式日志）/ §6.2（调度）/ §12（网关）
- 状态：设计说明（实现随 P2 各机制批次）

**为什么 13 项不能笼统给「远程化」**：needs-design 与 never 的区别不是难度，是**存在一个正确的远程形态**——但每个形态都不是「一元代理」，而是「**把能力移到真正拥有它的位置**」：llm 的归属是网关、session 的归属是复制日志、skills 的归属是 provisioner、附件与溢出的归属是对象存储。**远程化 = 找对归属，不是加代理**。下面的 13 行与 `belongsTo` 一一对应。

## 1. 形态总表

| # | seam | 当前 shape | 远程形态（一句话） | 提供者 | 契约动作 |
|---|---|---|---|---|---|
| 1 | `ctx.llm` | server-stream | **LLM 网关作第一跳**：网关持有 providers 与费率/配额/流控，节点 `ctx.llm` 指向本集群入口；计量单截面在网关（§6.4 的「单截面」跨远程化仍然成立） | LLM 网关（Go，§12） | 无：节点消费者不变（Provider 底座换端点）；网关侧新增流控/背压/剪断契约（`llm/stream` 语义等价——chunk 与 usage 事件不得丢） |
| 2 | `ctx.sessionPersistence` | unary | **复制日志客户端**：append 走强一致复制日志（带 fencing 写者租约），node 侧日志本地投影 | 复制式 SessionEvent 日志（§4.2） | 契约升级：`write` 需携带会话写者租约 token；失败即分叉保护（`(session,seq)` 唯一即可暴露）。**已落地（2026-08-26/27）**：写路径见 `@lumo/session-log`；冷层（§4.2「热层 Redis → 冷转 MinIO」）随 `ctx.coldLog`（`PgColdLogArchiver` 经 `ctx.objectStore`）：PG 日志按 segment 幂等归档进 MinIO（`.jsonl` + `.info` 侧车，sha256+bytes 读回首验），保留期分级过期（`ctx.coldLog.sweep`）；**Redis 热层已落地（2026-08-27）**：`RedisHotLog` 每会话尾部窗口缓存（写后透传 fail-open、读未覆盖回 PG、窗口连续性校验、`ctx.sessionLogHot.head` 滞后探测）；契约 `shared/seam-contracts/{cold-log,hot-log}.ts` |
| 3 | `ctx.sessionQuery` | unary | **同一复制日志的读面**：查询永远查「已复制到本地」的段——查询面与日志复制同源，不存在查到半截 | 复制日志投影库（§4.2） | 补 `staleness` 语义：落后超阈值返回显式 `stale` 而非半截结果（§20.1 复制日志行） |
| 4 | `ctx.sessionTitle` | unary | **随 ctx.llm 走网关**：Title Provider 本质是一次 LLM 调用，单截面原则要求它也必须过 LLM 网关（含计量） | LLM 网关 | 无独立动作；接入网关时验证 title 生成的 token 计量进同一截面 |
| 5 | `ctx.subagents` | handle | **Scheduler 放置 + 跨节点 session fork**：spawn 变为「放置请求」（在哪个节点执行），执行是远端节点的 session；续跑 = 日志重放 + 写者 fencing（跨节点 fork 的公开能力见评审 A1——若 dsh 未公开则另做会话投影实现，明写） | Scheduler（§6.2）+ 复制日志 | **跨节点 fork 依赖审计**：dsh `fork` 进程内 API 的公开面决定实现形态；未公开 = 平台自实现会话投影（承担与 `deriveMessages` 漂移风险） |。**已落地（2026-08-27）**：one-shot spawn 切片——承载节点 `@lumo/subagent-host`（真 cordis 树 HTTP 放置面 POST /subagent/start|stop，child 以公开件 `ctx.agents.create` 重建、depth+1、单 turn 驱动、回调结集）+ 父节点 `@lumo/subagent-remote`（Scheduler 放置 → 承载 start → 回调结集 → 终态上报），wire 契约 `shared/seam-contracts/subagent-host.ts`；真 dsh 双进程 compose 冒烟 `dsh-plugins/subagent-remote/smoke-parent.ts` 全绿（判据：放置/终态落账、child 会话在承载 PG 日志、header meta.parentSession/delegationDepth=1、回执 completed）。ffork/continuable 的 seed 传输、预算联动放置、取消经行 6 控制通道 随后续切片
| 6 | `ctx.jobs` | handle | **句柄虚拟化**：`(job) → (session, 执行节点)`；kill/timeout/status 走**全局控制信号**（§7.4 控制命令面：下发与执行分离，执行集群以本地行动为准）；job 结果落地 = 事件流 | 控制信号通道（§7.4）+ Scheduler | **R2 恢复契约定稿后重判**：`ctx.jobs` 的恢复语义（超时重派/resume 到何节点）绑定 R2 的 turn 级恢复契约；未定稿前不开始实现（remotability.ts 已注明） |
| 7 | `ctx.lsp` | unary | **工作区整体搬迁路径**（E2B 式专用沙箱）：LSP 索引与 fs/subprocess 同机亲和不可拆分——远程化 = 把工作区目录+服务一起搬到专用运行时，三个 seam 一起换远端句柄 | ctx.e2b 派生路径（§4.1 特例） | 无独立契约；判「专用路径」而非「通用代理」。**优先级最低**：线下开发场景为主，不在 P2 前投入 |
| 8 | `ctx.web` | unary | **连接器网关**：出流量默认经网关（PII 过滤、egress 白名单、配额）；「绕开网关」是治理漏洞不是性能选择——远程 web = 网关代理的出向调用 | 连接器网关（Go，§12） | `ctx.web` 与连接器 seam 共用网关的调用链与审计；单次调用计量 `connector.call`。**已落地（2026-08-27）**：网关 `POST /web/fetch`（公网放行+全局黑名单+仅公网+配额+PII 脱敏+审计；计量 connector.call，审计同事务）；`@lumo/web-gateway` 提供 `WebFetchProvider(id=lumo-gateway)`，装配选 `web.fetchProvider`（等效 `DSH_WEB_FETCH_PROVIDER`）；connector invoke 顺带同法计量；**search 仍显式外**（各 SaaS 专用 API+密钥，后续小切片） |
| 9 | `ctx.skills` | unary | **本地化优先**：技能经 provisioner 安装到本地再读——「模型可见即日志可重放」要求技能目录在本地是既定的（远端目录状态随时间变化会破坏重放）；远程形态 = 无远程，只有「装没装好」 | 制品注册表 + provisioner（§6.1/§6.5） | 装配层方案：技能目录声明为依赖；本设计的实现责任 = provisioner 确保本地现状 |
| 10 | `ctx.attachments` | unary | **对象存储侧**：附件 = 对象（内容寻址）；模型上下文拿引用，正文按需取 | `ctx.datastore.object`（MinIO，§5.1） | 契约：附件引用一律对象键；禁止「逐次代理到某节点」——那是第二条真相源。**已落地（2026-08-26）**：`@lumo/attachments` 的 MinIO 版 `AttachmentStore`（继承 dsh `AttachmentStore` + 复用 attachment-local 归一化；save→ref 是 `<realm>/content/<sha256>` 对象键、同内容同键幂等、读回 digest 校验、缺对象 NOT_FOUND / 篡改 CORRUPT / 非法引用 INVALID / 不可达 `capabilityUnavailable`；键规则纯函数锁在 `shared/seam-contracts/attachment.ts`） |
| 11 | `ctx.spillStore` | unary | **同对象存储**：溢出内容对象化（引用 = 对象键，TLS 内取回）——跨节点 resume 需要任意节点可取回 | `ctx.datastore.object`（§5.1） | 生命周期：过期 TTL 由对象生命周期管理；与附件同桶隔离（realm 前缀）。**已落地（2026-08-26）**：`@lumo/object-store` 的 MinIO 版 SpillStore（键 `realm/spill/<session>/<sanitized>-<sha256前8>`；saveText 全文 verbatim / bytes 精确 / locator=对象键；`ctx.objectStore` 任一节点按同键取回；不可达 `capabilityUnavailable`） |
| 12 | `ctx.storage` | unary | **收敛到平台数据 seam**：非会话 KV 面划归 `ctx.datastore.sql` 语义（PG）——不设「直连存储」第二路径；组件不得直连数据库（硬规矩） | `ctx.datastore.sql`（§5.1） | 契约：dsh 的 storage API 包装为 sql 数据 seam 的 KV 子集；只读/写语义一一映射。**已落地（2026-08-26）**：`@lumo/storage` 的 PG KV 后端（`PgStorageBackend implements StorageBackend`，镜像 storage-sqlite；`ctx.storage` 收敛到 `ctx.datastore.sql`，schema 走 PG schema 版本化）；与 sqlite 跑**同一份** dsh 契约套件（`storage/storage/tests/contract.ts`），真 PG 全绿 |
| 13 | `ctx.workflowEngine` | handle | **FlowEngine 控制面 + 扇出走 subagents**：工作流引擎是控制面进程（独立 Go 服务 §9.2）；其 agent() 调用经 §1 第 5 行的 subagents 路径——引擎跨节点 = 控制面扩容，不是代理 | FlowEngine（§9.2）+ Scheduler | 无独立远程契约；实现依赖第 5 行（subagents）先行 |

## 2. 三件关键形态的设计要点

### 2.1 ctx.llm —— LLM 网关（§12 的落点之一，P2 起始项）

- **分界**：网关是「模型访问面」（协议对话、流控、背压、计量、限流），模型 Provider 由网关持有；dsh 节点不再握有自己的 Provider 配置。
- **计量单截面跨网成立**：§6.4 的「所有 token 消耗在 ctx.llm 一道截面」——远程化后该截面是**网关节点的截面**：usage 事件在网关生成，经 §6.4 事件流回台账（`llm.tokens` 发出方 = `llm-gateway`）。节点侧不再自行计量。
- **流控与背压**（remotability.ts why 行）：流式代理必须转译 chunk 顺序（`llm/stream` 瀑布语义），首 token 延迟预算见 §21.1（TTFT p50 ≤ 1.5s，网关排队 < 10%）；背压 = 网关上游队列水位，禁止无界缓冲（SLO §21 的网关排队占比就是它的量尺）。
- **接线顺序**：先网关单节点形态（standalone），再集群形态;与计量事件流（RocketMQ 传输后）一起联测。

### 2.2 ctx.subagents —— 跨节点委派（P2 复杂件）

1. **放置决策**（Scheduler）：agent 的 `agent()` 调用变为「放置请求」——Scheduler 按节点负载/亲和/预算（§6.2 调度联动读预算余量）答回「执行节点 + session 新身份」；
2. **续跑语义**（复制日志 + fencing）：跨节点 fork 以日志重放实现（同 §7.1 的 resume 语义）；写者租约 fencing 保证同一 session 单写者（§8.2）。
3. **语言非对称**：dsh 的 fork 是进程内 API——评审 A1 已挂账：**若 dsh 未公开跨节点 fork 能力，则平台在 dsh 之外重实现会话投影，并承担与 `deriveMessages()` 漂移的风险**（明写,不装不知道）。该风险在本行落实前,「跨节点委派」仅止于设计。

### 2.3 ctx.skills —— 本地化成本最小路径

「模型可见即日志可重放」直接否决「运行期取远端技能」：重放时需要当时的目录状态而远端目录会变。因此技能远程形态 = **没有远程**，只有 provisioner 的「本地已装」保证（§1 第 9 行）。装配层声明 skills 目录为 deps，provisioner reconcile 就是执行者——这条路径的**最便宜形态**也是正确形态。

## 3. 排序与依赖（实现顺序）

| 顺序 | 条目 | 理由 |
|---|---|---|
| P2a | 2/3（复制日志）、1（LLM 网关） | 复制日志是分布式的底座（§4.2 三杠杆之二）；网关是单截面与计量的外部化 |
| P2b | 8（web→连接器网关）、10/11/12（对象/数据 seam 收敛） | 网关是出向合规;对象收敛是「一条真相源」的机械动作 |
| P2c | 5/6/13（subagents/jobs/workflowEngine） | 三者互锁: engine 扇出经 subagents, jobs 恢复依赖 R2; 全部依赖前批成熟 |
| P3 | 9（skills 本地化）、7（lsp 专用路径） | 单机形态已成立, 属体验优化 |

## 4. 验收与合规

- **表约束**：本设计不得改 `SEAM_GRADES` 的 `class`/`belongsTo`（假设推理链不动——那是准入真相源）；任何一行的形态变更必须**同时改分级表并说明**（两处联动, 防止「设计说了、表里没改」）。
- **契约验证**：每个形态落地时, 对应的 seam 必须有 §19 层级的契约套件（如 ctx.llm 网关的「usage 事件完整性」、复制日志的「分叉防护」——已存在于 session-log 契约的先例照此扩展）。「跨 AZ 预算实测」是本 表的**实体前置**, 在本设计之后的下一个可接受窗口: 需要真多 AZ 环境, 不能在本机用 docker 模拟——保持记账。
- **README 同步**：`seam 可远程化边界` 行「待补 needs-design 13 项各自的远程形态」→「已设计(2026-08-26)」;「跨 AZ 预算实测」保留待补(需真环境)。

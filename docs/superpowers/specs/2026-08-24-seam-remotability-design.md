# Seam 可远程化分级设计说明 —— 未定级即拒绝，粗粒度是硬规矩

> 对应评审 **R1【P0】**「Seam 网络化缺少可远程化边界定义 —— §4.1」。
> 落地物：`platform/shared/seam-contracts/remotability.ts`（分级表 + 两道闸），
> 消费者 `platform/dsh-plugins/seam-proxy`（客户端）与 `platform/dsh-plugins/seam-host`（服务端）。

---

## 0. 决策背景

§4.1 的推理链是：dsh 文档说把 filesystem/subprocess 的 Provider 指向远程沙箱，Bash/PTY/LSP 会一并迁移且无需 provider 分叉 → 所以「**任意 seam 的 Provider 都可落在远端，Consumer 代码零改动**」。

前提是真的，结论是过度推广。远程沙箱是 dsh **专门为此设计过**的路径——`packages/e2b` 里有 `ctx.e2b` 这个显式的沙箱生命周期所有者，`fs-e2b` 与 `subprocess-e2b` 两个 Provider 共享它持有的同一个远端 Linux 运行时。也就是说：dsh 能远程化 fs 与 subprocess，恰恰因为它为这两个 seam 专门造了一个共享远端句柄的所有者，而不是因为 seam 抽象本身自带远程能力。把这条特例读成通则，是全案杠杆最高、同时最脆弱的一处。

R1 要一张分级表加一条硬规矩。但**一张只存在于文档里的表等于没有表**：真正会发生的事是某人在 `cordis.yml` 里写 `seams: ['terminals']`，插件照常加载，PTY 句柄在网络那头，直到用户第一次按 Ctrl-C 才发现。所以本项的核心决定不是「写出这张表」，而是**让这张表成为唯一的准入判据，且未定级一律拒绝**。

## 1. 范围

- 分级表：每个 seam 的类别、调用形状、逐方法幂等性、延迟预算、每 turn 调用预算、失败语义、定级理由。
- 闸 A（加载期，硬）：`seam-proxy` 要接管的 seam 不在表里、或类别不是 `remotable` → 插件加载即抛。
- 闸 B（服务端，硬）：`seam-host` 收到不可远程化 seam 的调用 → `forbidden`，不看客户端说什么。
- 闸 C（运行期，可配）：每 turn 调用次数超预算 → 默认告警、可配为拒绝。这是粗粒度硬规矩的量化执法。
- 合并现有 `IDEMPOTENT_METHODS`：幂等性并进分级表，消灭双表漂移。

**不做**：真的去远程化任何新 seam（那是各 seam 自己的工作）；改 dsh 源码；替换现有传输（仍是 JSON over HTTP）。

## 2. 三个类别，判定依据是「远程化会破坏什么」

| 类别 | 含义 | 准入 |
|---|---|---|
| `remotable` | 一元调用、无 OS 句柄、无节点亲和、不参与事件瀑布 | 可直接经 SeamProxy 过网 |
| `never` | 远程化会破坏语义正确性或安全边界，不是工程量问题 | 永久黑名单，闸 A/B 均拒 |
| `needs-design` | 远程化有价值但需要专门机制（流控、句柄虚拟化、专用通道），不能靠通用代理 | 闸 A/B 拒，直到该机制落地并把它改判为 `remotable` |

`never` 与 `needs-design` 的区别不是难度，是**是否存在一个正确的远程形态**。`ctx.sandbox` 是 `never`：沙箱强制点必须与被约束的进程同机，隔着网络的沙箱是建议不是沙箱，无论投入多少工程量都不成立。`ctx.llm` 是 `needs-design`：服务端流有正确的远程形态，只是不是一元代理。

**「Consumer 零改动」在 `handle` 形状上根本不成立**，这点要写死：句柄型 seam 交出的是一个有生命周期的引用（PTY 会话、进程树、fd、job）。远程化后这个引用可能在网络中断时失效，Consumer 必须处理「句柄突然作废」——而本地形态下这个分支不存在。零改动承诺在这里不是难以实现，是自相矛盾。

## 3. 黑名单（`never`）与理由

| seam | 形状 | 为什么永久拒绝 |
|---|---|---|
| `ctx.terminals` | handle | 长驻 PTY；`terminal` 包自述「registry 拥有 exact-Agent 会话身份与清理，backend 拥有终端机械细节」——终端机械细节就是 OS 句柄 |
| `ctx.subprocess` | handle | 进程树、stdio 处置、kill 升级都依赖同一个 OS；`bash-local`/`terminal-bash`/`lsp-stdio`/三个 out-of-process subagent 后端全部经它 spawn |
| `ctx.sandbox` / `ctx.sandboxPolicy` | handle / 本地状态 | 强制点必须与被约束进程同机。Consumer 交出「即将 spawn 的 argv」，隔网执法等于不执法 |
| `ctx.shellEnv` | 本地状态 | 每次执行收一份可信快照，executor 重建命名空间；跨节点的「可信快照」不可信 |
| `ctx.codeRuntime` | handle | 跑模型写的程序并绑定 host 侧异步 binding，binding 是进程内引用 |
| `ctx.approval` / `ctx.userQuestions` | waterfall / 人在环 | 走 `approval/request` 瀑布，缺席时 fail closed 到 `unavailable`。远程化切断 `next()` 同步链；且「远程默认拒绝」会把审批变成拒绝服务 |
| `ctx.invariants` / `ctx.systemPrompt` / `ctx.tools` | 进程内注册面 | 注册表本身不是可远程化的能力，它是装配结果。远程化注册面等于远程化插件图 |
| `ctx.webServer` / `ctx.clientModules` / `ctx.apiProxy` | 传输载体 | 它们**是**网络面，不是网络面的消费者 |
| `ctx.fs`（本地形态） | handle | fd 与 watch。远程 fs 已由 `fs-e2b` 提供，走 `ctx.e2b` 的专用共享句柄——这是特例路径，不是本表授权的通用能力 |

`ctx.fs` 这一行要读准：**它是 `never`，指的是「通用 SeamProxy 不得代理 fs」**；dsh 自己的 `fs-e2b` 依然是合法的远程 fs，因为它不走通用代理，而走 `ctx.e2b` 持有的专用远端句柄。混淆这两者正是 R1 指出的推广错误。

## 4. `needs-design` 与它们真正的归属

| seam | 缺的机制 | 正确归属 |
|---|---|---|
| `ctx.llm` | 服务端流 + 流控背压 | **LLM 网关**（§6.4 计量单截面在此，必须过网关而非 SeamProxy——否则计量与远程化各走一条路，单截面就破了） |
| `ctx.sessions` / `ctx.sessionPersistence` | 复制与一致性 | **复制日志**（§4.2），不是 seam 远程化问题 |
| `ctx.subagents` | 跨节点放置与 continuation 迁移 | **Scheduler**（§6.2） |
| `ctx.lsp` | 索引与工作区同机亲和 | 需整体搬工作区（连同 fs 与 subprocess），即 E2B 式的专用沙箱路径 |
| `ctx.jobs` | 句柄虚拟化 + 重连语义（kill 一个远端 job） | 待 R2 的 turn 级恢复契约定稿后重判 |
| `ctx.web` | 无——但它已经是外部 IO | 归 **连接器网关**：出平台流量必须过网关做 PII 与配额，绕开网关的远程 web 是治理漏洞 |

`ctx.web` 这一行值得单独说：它在技术上完全可远程化（一元、无句柄、幂等），但**判为 `needs-design` 是治理决定不是技术决定**。技术上能过 SeamProxy 不等于应该过。

## 5. `remotable` 白名单（当前只有平台自定义 seam）

| seam | 形状 | 每 turn 预算 | 延迟预算 p95 | 失败语义 |
|---|---|---|---|---|
| `knowledge` | unary | 8 | 800ms | `query`/`ingest`/`remove`/`rebuild` 契约幂等，可重试 |
| `knowledgeGraph` | unary | 8 | 800ms | 同上，upsert 为 last-wins |

**白名单里没有一个 dsh 原生 seam，这是刻意的结论而不是遗漏。** dsh 的 seam 面主要服务于「单进程内替换实现」，其中真正无句柄、无亲和、粗粒度的那几个（`ctx.skills`、`ctx.attachments`、`ctx.spillStore`、`ctx.storage`）远程化收益极低——它们的调用要么在会话开始时一次性完成，要么本就落在共享存储上，过网只增加故障面。§4.1 的杠杆真正来自**平台新增的能力 seam**（知识库、图、分析、GPU 推理），而不是来自把 dsh 原有 seam 搬到网上。这个结论应当回写 §4.1，因为原文的措辞暗示了后者。

## 6. 硬规矩 A：未定级即拒绝

新增 seam 默认**不可**远程化。判据方向是 fail closed 而不是 fail open，理由与注册表同源：默认可远程时，一个漏定级的句柄型 seam 会静默过网，故障出现在离原因很远的地方（用户按 Ctrl-C、resume 后句柄失效）；默认拒绝时，代价只是加一行定级，且失败发生在加载期，堆栈直指原因。

两道闸都必须有，因为它们防的是不同的事：闸 A（客户端加载期）防装配错误，闸 B（服务端 dispatch）防**对端不可信**——host 不能因为客户端声称某 seam 可远程就照办，那等于把准入判据交给调用方。

## 7. 硬规矩 B：粗粒度，以每 turn 调用预算量化

R1 的原话是「碎片化接口必须在 Provider 侧聚合成批量调用后才允许过网」。把它变成可执行的形式：每个 `remotable` seam 声明 `perTurnCallBudget`，SeamProxy 客户端按 turn 计数。

预算怎么定：`perTurnCallBudget × latencyBudgetMs` 应落在单 turn 可接受的网络开销内（当前定为 ≤ 6.4s，即 8 × 800ms）。这不是凭空的数字，它是评审给的算式的反向使用——评审算「几十次调用 × 20ms 跨 AZ = +600ms/turn」，这里改成先定 turn 级上限，再倒推允许的调用次数。

**执法强度分两级，且默认不是拒绝**：

- 加载期定级（闸 A/B）：**硬拒**。这是正确性与安全问题。
- 运行期超预算（闸 C）：默认 `warn`，可配 `enforce`。

默认 `warn` 是有意的：超预算是性能回归，不是安全事故。默认拒会把「某个组件写得太碎」升级成「用户的 turn 直接失败」，用可用性事故惩罚一个本该在 code review 里解决的问题。但 `warn` 必须是**结构化的、可被 CI 断言的**信号（带 seam、turn、count、budget 字段），否则它就退回成没人看的日志——那正是 R1 批评的「纸面要求」。压测环境应当开 `enforce`。

## 8. 与现有代码的合并

`remote.ts` 现有 `IDEMPOTENT_METHODS` 与 `isIdempotent()`，内容是「seam → 幂等方法集」；R1 要求的表里幂等性是一列。两处并存必然漂移：加一个方法时只改一处，另一处静默过期。因此分级表接管幂等性，`isIdempotent()` 改为从分级表读，函数签名不变（调用方 `client.ts` 不动）。

`seam-host/dispatch.ts` 的 `SeamName` 联合类型与 `METHOD_TABLE` 保留——它们管的是**方法白名单与参数校验**，与「这个 seam 能不能过网」是两件不同的事。但两者必须一致：分级表里 `remotable` 的 seam 必须在 `METHOD_TABLE` 里有条目，反之亦然，用契约测试守住。

## 9. 验收判据

1. 分级表覆盖 dsh `capability-seams.md` 里全部 `seam` 角色的服务，无一条缺项——用测试对着一份从该文档抄录的 seam 清单核对。
2. `seam-proxy` 配置里写入 `never` 或 `needs-design` 类 seam → 加载期抛错，错误信息含类别与理由。
3. `seam-proxy` 配置里写入表中不存在的 seam 名 → 加载期抛错（fail closed，不是忽略）。
4. `seam-host` 收到 `never` 类 seam 的调用 → `forbidden`，且不触碰任何 Provider。
5. 每 turn 超预算：`warn` 模式下产出结构化告警且调用照常成功；`enforce` 模式下第 N+1 次调用被拒且错误信息含 seam/count/budget。
6. `isIdempotent()` 的返回与分级表逐方法一致；`remotable` 集合与 `METHOD_TABLE` 键集合相等。
7. 分级表里每个 `never`/`needs-design` 条目都有非空 `why`。

## 10. 已知不覆盖

- 不实现任何新 seam 的远程化，不改传输（gRPC/QUIC 仍是 §12.1 的目标形态）。
- turn 边界的判定依赖调用方传入 turn 标识；`ctx.llm`/`ctx.sessions` 归 R2 与 §4.2，本项不碰。
- 延迟预算只做声明与超预算计数，不做实时 p95 采样与自动熔断降级——那需要 SLO 与容量模型（待补章节第 4 项）先定稿。
- 句柄虚拟化、流控背压两套机制均不在本项，`needs-design` 条目保持拒绝状态。

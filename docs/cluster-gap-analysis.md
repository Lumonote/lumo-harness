# 集群模式功能缺口分析（首版 2026-09-08 / 复核 2026-09-14 / 再复核 2026-09-15 / 2026-09-16 / 2026-09-17）

> **范围**：`LUMO_DEPLOYMENT_MODE=cluster` 下尚未完成的功能。Standalone / Local 的差异只在确有对比价值处提及。
> **判据**：[`architecture.md`](./architecture.md) §7.3/§7.4/§8.2/§8.4/§9.2/§12.1、[`roadmap.md`](./roadmap.md) §16–§17、[`implementation-status.md`](./implementation-status.md)。
> **方法**：三路代码审计（控制面 Go 服务 / 插件与数据面 / 部署接线），文末「口径差异」列出与既有文档自述不一致之处。
> **性质**：本文只记录**代码与装配层面的缺口**。需要目标环境提供外部依赖（真实 IdP、SaaS 端点、生产信任根、外部 DSN）的事项归 `implementation-status.md`「有意保留的外部集成边界」，不重复列出。
>
> **2026-09-14 复核说明**：首版 33 项中 **16 项已闭合、2 项部分闭合**，仍未闭合 14 项、判为有意边界 1 项。
> 复核以当前代码树为准逐项重验，闭合项移入第二节并附闭合位置（保留追溯），本文第一节只列
> **当前仍未闭合**的项——这份文档是排期输入，一份混着已完工项的清单会直接导致重复开发。
> 每条闭合项都注明了复核所依据的文件与行号；凡**未复核**的断言都显式标注（见 D5 的 CI 分项）。
>
> **2026-09-15 再复核说明**：逐项动手实现时发现首版有 **3 项是误读**（E2 / E3，以及 E5 的定性），
> 已改判为「非缺口」并移入第三节「判为误读」。同时 **E5 / E7 已闭合**，并**新增一项 E7b**。
> 教训写在文末「口径差异」：**缺口分析如果只读文档注释、不读函数体，就会把「已实现」记成「未实现」**——
> E2 的断言直接来自 `Reconcile` 的 doc comment，而函数体第 966-976 行就是在修复分歧。
> 当日后半段又动手做了 **D5**，发现它比首版记录的严重得多：验收脚本的 session-log 步骤**实测
> 19 个用例全跳过而退出码为 0**（见 D5 条目）。复核过程中还顺带发现 **`up.sh` 从未真正启动过拓扑**
> ——警告函数在 `set -e` 下返回非 0，把两条 README 记载的启动路径都杀掉了。两项均已修复，D5 **全部闭合**。
>
> **2026-09-15 第三轮（D2 + D3）**：部署完整性两项闭合，D 组只剩 D1（Nebula 进编排，已降为产品决策）。
> 做 D3 时顺带发现一个 P0：Helm 只给 `collaborator` 注入 `LUMO_INSTANCE`，而 scheduler 的实例名
> 回落链是**字面量 `"scheduler-0"`**，于是 `replicaCount: 2` 会造出两个**互相没有 fencing 的 leader**
> （见 D3 条目）。已修，并新增渲染门禁 `platform/deploy/helm-verify.sh` 把这类「渲染成功但装不上」
> 的形态挡在部署之前。
> 当前合计 **34 项：28 已闭合 / 3 部分闭合 / 0 仍未闭合 / 3 非缺口**
> （**以文末那张分组表为准**——本文件里任何一处计数与它不一致时，表是对的：这个数被
> 修正过多次，每次都因为「计数有两个来源」；**最近一次是 2026-09-17** ——E7b 改判为「不做」，
> 且核该格时发现 E6 的行早已写「已闭合」而表没跟改，两项一起从「仍未闭合」移出，
> 由 26/3/2/3 变为 **28/3/0/3**。**注意「以表为准」这条规则本身是有条件的**：
> 2026-09-17 这一次是**表错、行对**（行带着行号与用例名，表只有一个数字）——
> 冲突时先看哪一边带了证据，别无条件信表。）
>
> **2026-09-16 复核**：本轮只做两件事——把 **C8 判为已闭合**，以及**修正本文自身的计数口径**。
> ① C8（LLM 批处理网关）此前记为「`llm-gateway/internal/` 无 batch 包」，现已有
> `llm-gateway/internal/batch/coalescer.go`（窗口汇聚：批满即放行、窗口为 0 等于整体关闭、
> 有界首 token 延迟），并经 `cmd/llm-gateway/main.go:68-114` 装配（`LUMO_LLM_BATCH_WINDOW_MS` /
> `LUMO_LLM_BATCH_MAX`，非法配置在连库**之前**退出码 2）。判据：`go test ./...` 全绿、
> `gofmt -l` 与 `go vet` 干净。
> ② **计数此前自相矛盾**：本条写「21 已闭合 / 2 部分闭合 / 8 仍未闭合」，而文末的表逐组加总
> 是 22/2/7/3。以表为准——`C2` 与 `C6` 都已被记为已闭合，却只在文末表里计了一次。C8 闭合后
> 为 **23/2/6/3**。**教训与 D3 的行号漂移同源：一处人工维护的计数只要有两个来源就一定会分叉；
> 引用计数前先把它自己加一遍。**
> ③ 复核新增一项（不计入 34 项，属环境而非代码）：`minio/minio:latest` 已不可拉
> （见文末「口径差异」最后一行）。**2026-09-16 的修法（钉具体版本）已于 2026-09-20 失效**
> ——真正的问题是 Docker Hub 上那个**仓库整体下线**，不是 `latest` 标签；现已改用
> `quay.io/minio/minio`，并加了门禁 `compose-images-verify.sh` 防复发。详见该行。
>
> **2026-09-17 复核（E7b 改判，计数口径随之变化）**：E7b「connector 审计的 SessionEvent 投影器」
> 由「仍未闭合」改判为**不做**——判据是**按构造不可实现**（dsh 没给平台插件留「写自定义持久事件类型」
> 的通道），且同一信息已有两条可达路径。核这一格时**顺带发现本文件又分叉了一处**：
> E 组的「2 仍未闭合」实际是 **E6 + E7b**，而 **E6 的行文本早在 2026-09-16 就写着「已闭合」**
> ——表没跟着改。修正后 E 组 **6/0/0/3**，**合计 28 已闭合 / 3 部分闭合 / 0 仍未闭合 / 3 非缺口**，
> 即上一段那句 `2 仍未闭合` 现在应为 **0**（改动与判据见下方分组表的脚注）。
> 两次复核相隔不到一天，方向相反：白天那版结论建立在**只读类型层与注释**上，晚上沿
> 「声明 → 写入 → 持久化 → 重载」四段走完才推翻。**引用本文任何一条结论前，先看它的观测时刻与
> 它核到了链条的第几段。** 详细判据与行号见 E7b 行、下方结论段与文末「口径差异」。
>
> **2026-09-16 第四轮复核（只阅清单与接线，不改代码）**：本文第一节 C 组表里有**三行已经
> 实现，却仍写着「全仓检索零命中」**——`C3` 边缘网关、`C4` 终端网关、`C7` 流程血缘。
> 三者代码都在磁盘上、都已进编排。`C7` 判为**已闭合**；`C3`/`C4` 判为**部分闭合**——
> 当时的原因是「不在 Helm chart 里」（见下条），**那条当天就修了**，所以它们现在的残留
> 只剩**真集群端到端验收**（`acceptance-cluster.sh` 对三者都零探针）。**该残留已于当天第五轮补掉**
> （行为探针层 `probes-cluster.sh`，见下方第五轮复核块；`C3`/`C4` 因此改判为已闭合）。
> `C7` 旧记录的「零命中」是**检索范围没覆盖到**造成的假阴性——它不在
> `control-plane/` 顶层而 `flows/internal/` 下，不是「当时不存在」。
> 计数：C 组由 3/1/4 变为 **4/4/0**，合计由 23/2/6/3 变为 **24/5/2/3**
> （`C5` 的现状栏早就写着「服务端已闭合」，却没从「仍未闭合」列里挪走，
> 是同一处「表与计数两个来源」分叉）。**`C3` 与 `C4` 的行头当时一处写「已闭合」、
> 一处写「部分闭合」，而计数表把两者都算作部分闭合**——同一次复核里又犯了一次同一种
> 病，已统一为「部分闭合」。
>
> **第四轮复核顺带查出的一个新缺陷（当时 C3/C4 为何是部分闭合，不是已闭合）——当天已修**：
> `edge-gateway` 与 `terminal-gateway` **不在 Helm chart 里**。逐点核对九个接线面，
> 八个齐全、**唯独 Helm 缺席**：`compose.cluster.yml` ✓、`compose.standalone.yml` ✓、
> `prometheus.yml` ✓、`prometheus-standalone.yml` ✓、`prometheus-alerts.yml` 名单 ✓、
> `preflight-deployment.sh` ✓、CI matrix ✓、`build.sh` 镜像清单 ✓、Dockerfile ✓，
> 而 `values.yaml` 的 `services` 映射里**没有这两个服务**（全 chart 只在两处注释里
> 提到 terminal-gateway）。**这不是有意的范围裁剪**：同一 chart 的
> `templates/configmap.yaml:30-35` 写着「session-control 与 terminal-gateway 读
> `LUMO_OPA_URL`。**两条都要有**」——配置面是按「终端网关会在 chart 里运行」写的，
> 却没有人给它一个 `deployment.yaml`。
> **为什么现有门禁抓不到它**：唯一覆盖 chart 完整性的门禁 `helm-verify.sh` 把期望值
> **写死**为 `expected_instance_refs=10`（第 203 行），而 10 正好等于 `values.yaml`
> 现有服务数——**期望值是从 chart 现状反推的**，于是「某个服务根本没进 chart」这种
> 缺陷在结构上不可能被它发现。写死期望值的规则本身是对的（防止「检查由渲染结果自证」），
> 但它只防得住**值漂移**，防不住**集合缺员**；后者需要另一道判据：
> **「有 Dockerfile 的控制面模块全集」必须等于「chart 的 `services` 键集」**。
> 这两个集合现在都已写下来，差额正好是 `{edge-gateway, terminal-gateway}`：
> 仓库树里 `platform/control-plane/*/Dockerfile` 共 **12** 个，
> `values.yaml:210-224` 的 `services` 键共 **10** 个。
> **注意参照物不能用 `preflight-deployment.sh` 的集群清单（33）**——那份清单刻意含
> 中间件（postgres / redis / nacos / opa / vault / rocketmq / minio / milvus…），
> 而本 chart **有意不装中间件**，拿它比会把二十几个「设计上就不该在 chart 里」的名字
> 报成缺陷。判据必须**遍历仓库树**，与 CI matrix 那次修法同一条规则。
> **该判据已实现**：`platform/deploy/helm-verify.sh` 新增检查「遍历
> `platform/control-plane/*/Dockerfile` 得到的控制面模块全集（现 **12**）必须等于
> chart 的 `services` 键集（现 **12**）」，并配反例自证（把一个已进 chart 的服务从
> `values.yaml` 删掉，必须被抓到具体名字——实测通过）。它随既有 CI 步骤
> `Chart render gate` 进流水线，无需新接线。
> **它当场就抓到了东西**：写完之后第一次跑，报出的正是 `edge-gateway terminal-gateway`
> 两个名字——判据不是装饰，它对着真缺陷失败。（同一次里还有一个值得记的错法：第一版用
> `comm` 比对两个集合，而 `comm` 要求输入**全局**有序——「已排序的 chart 键」直接拼上
> 「已排序的豁免名单」整体并不有序，于是豁免表整张静默失效。它是先被观测到「虚报了全部
> 豁免项」才暴露的，不是靠读代码看出来的。）
> **那两个服务当天就补进了 chart**，于是这段的结论从「有人签字声明缺两个服务」变成了
> **「不再缺」**：唯一还挂着的残留只剩真集群端到端验收。三条与本项有关的决定：
> ① **入口层的暴露方式不由 chart 决定**：全局 `service.type` 保持 ClusterIP（什么都不会
> 被意外暴露），两个网关各自可用 `type:` 覆盖——若反过来把全局翻成 NodePort，会把**全部
> 12 个**服务（含本不该可达的内部面）一起暴露。是否再前置 Ingress 是产品决策，chart 刻意
> 不做；② **路由表是渲染出来的，不是抄来的**（详见 C3 行）；③ 补进 chart 让
> `LUMO_REQUIRED_SERVICES` 自动多出两个名字，而两者都真的上报心跳，所以就绪闸门不会因此
> 变成永不开门——这一条必须核实而不是假定：把服务加进 chart 等于给它加了一道**运行期**
> 门槛。
>
> **教训与 D3 的行号漂移、文末「计数互相矛盾」完全同源：清单不会随代码自动更新，
> 而「仍未闭合」这个栏目名会让读者不去复核它；同理，「接线清单」这个说法会让人
> 以为只要在每个 list 里 `grep` 到服务名就算接上了，而真正的问题是「哪个 list 从来
> 没人去核对」。** 引用本文任一行的「现状」之前，先做一次**全仓检索**并核对它是否
> 已进**每一个**接线面。

> **2026-09-16 第五轮复核（补探针，不动服务端代码）**：第四轮把 `C3`/`C4` 判为「部分闭合」时，
> 两条行都写着**同一句残留**——「唯一仍缺的一处：真集群端到端验收（`acceptance-cluster.sh` 对它零探针）」。
> 本轮把那句话变成可执行的东西，两条因此**判为已闭合**：
>
> 1. **补的是行为探针层**（`platform/deploy/probes-cluster.sh` + 共享库 `lib/probes.sh`），与
>    `smoke-cluster.sh` 分工明确：后者答「进程活着吗」，前者答「活着的进程做的是不是它该做的事」。
>    覆盖 `C3`（端到端链 + 路由表只读面）、`C4`（端到端链 + presence 面）、`C7`（血缘投影器装配指标）、
>    `C1`（漂移累计指标）、`C5`（控制面累积器装配指标）。**探针目标从拓扑派生**（容器端口落在
>    控制面段的服务），不写名单——后者腐化的方向恰好是它想防的那一个。
> 2. **判为已闭合的依据是「探针存在且已对真二进制取到正证据」**，而不是「在真集群里全绿过」。
>    与 `D5` 同一档判据：本机把 `edge-gateway` / `terminal-gateway` 两个真二进制跑在与
>    `compose.cluster.yml` 相同的宿主端口上，直接对**真实拓扑文件**跑探针，1/2/3 三项通过
>    （含端到端链与「诚实 503」判定），另三项指标探针正确报 `probe-service-absent`（本机没跑那三个服务）。
>    **仍欠**：真 compose 集群上一次「6 条全绿」的运行。这一条与 D5 的「仍欠一次真机证据」同性质，
>    是环境事件而非代码缺口。
> 3. **本轮最值钱的一条教训：验收判据不能把「当前接线进度」写死。** 端到端链的终态取决于
>    terminal-gateway 有没有事件源（未配 → `503 no_event_source`；已配 → 普通 GET 在握手处 `400`，
>    见 `server.go:106-127`），而「已配事件源」正是 `C4` 行上排期中的下一步。第一版判据只认 503，
>    于是**接线落地的当天这条探针会对着一个正确的部署报红**；遇到假警报的人会把探针改弱，而不是去查接线。
>    已改成两种形状都通过，真正抓的是第三种：非 WS 请求拿到 **2xx**（§8.2 禁止的「伪造空历史」）。
>    实测证据：同一个真二进制加 `--mem-events` 之后，探针 1 正确地改判为「已配事件源」通过——
>    改判据之前它会红。
> 4. **计数**：C 组由 4/4/0 变为 **6/2/0**（多出的是 `C3`、`C4`），合计由 24/5/2/3 变为 **26/3/2/3**。
>    以文末那张表为准。

## 复核结论（2026-09-15）

| 类别 | 项数 | 已闭合 | 部分闭合 | 仍未闭合 | 非缺口（误读或有意边界） |
|---|---|---|---|---|---|
| A. 静默 P0 | 5 | **5** | 0 | 0 | 0 |
| B. 装配缺口 | 6 | **6** | 0 | 0 | 0 |
| C. 设计能力缺失 | 8 | 6（AgentTeams、全局监控面、LLM 批处理、流程血缘、**边缘网关、终端网关**） | 2（多集群调度、共享执行控制） | 0 | 0 |
| D. 部署与验收 | 6 | 5（Prometheus 漏抓、就绪静态声明、验收链路、Helm Secret、集群 profile） | 1（Nebula 进编排） | 0 | 0 |
| E. 死代码与占位 | 9 | 6（心跳死表、provider 管理 API、session-title-gw 装配、审计读取面、`AppendOnlyMerger`、connector 审计投影器——后者 2026-09-17 改判为「不做」，见下） | 0 | 0 | 3（breakglass、对账修复、派发 outbox） |
| **合计** | **34** | **28** | **3** | **0** | **3** |

> **（2026-09-17 修正：E 组这一格此前少记了一项，同一个病第四次出现）** E7b 改判后我核了一遍 E 组，
> 发现 **E6（`AppendOnlyMerger`）的行文本早在 2026-09-16 就写着「已闭合」并给了三条边界 + 两条用例，
> 而本表仍把它计在「仍未闭合」里**——于是 E 组那「2 仍未闭合」实际是 E6 + E7b，两个都已经不是未闭合。
> 修正后 E 组为 **6/0/0/3**，合计 **28/3/0/3**（=34，自加一遍过）。
> **这就是本表第四次在同一格改动，而四次里有三次不是代码变了，是「谁没同步」**：
> 前三次是口径变了，这次是**行改了、表没改**。本文件自己的告诫是「以表为准」，
> 但这次的教训是**反过来的**：**当表与行冲突时，先看哪一边带了证据**——E6 的行带着行号与用例名，
> 表只有一个数字。**「以某处为准」这条规则本身也要标注它成立于什么条件。**

> **本表的「部分闭合」这两列在 2026-09-16 被修正过一次，且修正过程中又发现一处自身缺陷**：
> 第一次修正时把 `C3`/`C4` 直接记为「已闭合」，随后逐点核对接线面才发现二者**不在
> Helm chart 里**（见上方第四轮复核块），于是改为「部分闭合」；**当天把两个服务补进 chart
> 之后它们仍是「部分闭合」**——残留换了，从「装不上」变成「没端到端验过」，而《部分闭合》
> 这一格并没有因此空掉。**这正是本表存在的意义：它的每一格都是「某个人在某个时刻的判断」，
> 而判断会错，所以要能被复核推翻。**
>
> **（2026-09-16 第五轮再修正一次，同一个位置、同一种病）**：`C3`/`C4` 从「部分闭合」移入「已闭合」，
> 计数由 24/5/2/3 变为 **26/3/2/3**。它们留在那一格的**唯一**理由是「没有验收探针」——本轮把探针补上
> 并对真二进制取到了正证据，残留消失，所以两格同时挪动。**这也是本表第三次在同一处改动**：
> 每一次都不是代码变了，而是「判断这件事算不算闭合」的口径变了。口径必须写出来，
> 否则下一轮的人无法判断该不该再动它。

**首版的核心判断（「十个 Go 服务编译级完整，缺口全部是静默的」）在 09-08 是对的。**
但 09-08 → 09-14 之间 A、B 两组被整体补齐：**「代码完整但链路跑不通」这一类已经没有剩余项**。
当前剩下的**几乎全部是 C 组（从零开始的大工程）**；D 组只剩 D1，且它已从「阻塞验收」降为
「要不要给集群提供 Nebula 图引擎」的产品决策；E 组两处是**有意保留**的取舍。

> **E 组的性质变了**：首版把 E 组当「死代码待清理」，再复核后其中三项其实**不是缺陷**：
> `breakglass` 是有意保留的合规边界；`reconcile` **确实会修复**分歧；派发 outbox **确有消费者**。
> 真正的死代码只有 `AppendOnlyMerger` 与 `session-title-gw` 的装配引用（已摘除）。
> **E6 在 2026-09-16 又被修正了一次**：`AppendOnlyMerger` 的「诚实标注」只对了一半——
> 它确实自认非生产，但同一句里的「兼容旧状态读取与历史测试」**两句都不成立**（全仓零引用，
> 连测试也没有）。它现在被**有意保留**，理由与删除条件写成三条边界，并且规则由两条用例
> 钉住而不是由注释担保。**「已诚实标注」不等于「标注是对的」**——这也是「引用注释下结论」
> 的同一个病（见 E2/E3 的误判原因）。
> 把「我不认识这个设计」记成「这是死代码」，是这份清单最容易犯的错。

---

## 一、当前仍未闭合

### C. 设计能力缺失

| # | 能力 | 出处 | 现状 | 证据 |
|---|---|---|---|---|
| C1 | 多集群调度 | §7.4.1 | **本轮范围已闭合**（2026-09-15 实现，2026-09-16 补齐自报链路与拓扑接线）：联邦注册表（`scheduler_clusters`）、两段式失联判定（`healthy→suspect(30s)→down(90s)`，纯函数 + 库端时钟）、放置闸门（`suspect`/`down` 不接受**新**放置，抢占路径同样绕不过）、集群维度指标（年龄 / 一簇一维状态 / 注册表可读性）与告警 `LumoClusterStoppedReporting`。设计说明与实施记录：`docs/superpowers/specs/2026-09-15-multicluster-scheduling-design.md`（§8.5 记 2026-09-16 那一轮）。**仍缺**：**拆进程意义上的**全局/集群 Scheduler 分层——但设计稿点名的那件具体事已于 2026-09-17 闭合。
`architecture.md:721` 的降级曲线原本写着「无 leader 时放置一律 503；**集群本地放置降级随集群 Scheduler
落地**」，也就是说分层不只是结构偏好，它拴着「全局调度挂了时本集群还能不能接活」。现在这条走通了
（设计稿 `2026-09-17-cluster-local-placement-degradation-design.md`）：`scheduler_cluster_lease` 是
**每集群一把**的本地租约，降级路径要求「有集群身份 + 请求就是本集群 + 持有本地锁」三条同时成立，
**降级期间跨集群放置仍然 503**（那才是真正的全局决策）。围栏按租约自带的作用域选表，交叉反例
（已释放的集群租约不得授权放置）做过变异验证。**剩下的只是进程形态**：不拆进程就不需要同步那
九处接线面，而那条能力现在已经拿到了。**仍未做**：全局/集群两个独立进程角色。
  **可达性（同日补）**：写上面这段时那条路径其实**在任何拓扑里都走不到**——降级判据第一条要求
  「本实例有集群身份」，而 `compose.cluster.yml` 里一个 scheduler 都没有它（唯一一次出现是在注释里）。
  于是又是一次「代码、测试、指标、告警齐全，而闸门从未打开」。已补：compose 里加了两个每集群的
  scheduler 实例（`scheduler-cluster-a/b`），并新增门禁 `degradation-unreachable` 把这种形态挡在
  部署之前。端到端实测（两个真进程 + 真 PG）：有身份且持本地锁的实例对**本集群**请求越过闸门、
  对**跨集群**请求仍 503；无身份的实例对同样请求仍是 503——后者就是改动前的行为。
  **一处显式分歧**：Helm chart **没有**这两个实例（chart 的模型是一次 release 一个集群，
  `dshNode.clusterId` 是单值），所以那条新门禁对 Helm **显式豁免**并在输出里说明。这必须记住，
  否则「compose 有、chart 没有」会在某次真机验收上以「降级没生效」的形式出现。**跨集群偏好打分与版本一致性前置已于 2026-09-17 闭合**，见设计稿 §10：偏好打分只两项（负载 + 亲和，硬约束仍走剪枝），默认权重下与既有 `Pick` 逐字节同序（纯增量）；版本一致性前置的判定集合是「放置闸门当下真正允许的集群」，三档结论里只有「≥2 个不同版本」判为不一致且**整体拒绝**（含多数版本），只拦未指定 `cluster_id` 的全局放置，**默认关**且对未知 fail-closed（与存活闸门刻意相反）。接线面一并补齐（compose/Helm 的 `LUMO_CLUSTER_VERSION` 由承载节点声明、三条新静态门禁规则、两条新告警、指标契约）。**任务漂移（down 之后把任务漂回全局队列）已于 2026-09-16 闭合**，见设计稿 §9：`down + grace` 触发、五道闸门（leader / 注册表可读 / 快照新鲜 / 集群越线 / **原节点不在目录里**）、条件写 + `scheduler_task_migrations` 台账、fencing 靠 `attempt` 不推进（旧节点的终态回报被拒）、顺带作废未认领派发并追加 `avoid_nodes`。**两处须记住的边界**：① 闸门「原节点不在目录里」在 Nacos 形态恒满足、在 **Pg 形态恒不满足**（`scheduler_nodes` 只增不减）——后者是**正确**行为，Pg 形态即单集群形态，没有第二个集群可搬，与 C2/R8 的「local-lite 下 task_lost 恒为 0」同源；② **端到端只证了一半**：源端已证（真进程 + 真 PG + 真实失联集群，任务在 `down + grace` 越过后第一个循环内被搬走，时间线严格吻合：注册后 2088ms vs 阈值 2000ms），**目标端未验证**（置回 `PENDING` 后落到另一个集群健康节点的完整链路没跑过），见设计稿 §9.10。**第五轮补的探针只覆盖了半边，别把它读成「已验证」**：`probes-cluster.sh` 探针 5 断言的是 scheduler 的 `/metrics` 里存在 `lumo_scheduler_task_migrations_total`，即**漂移循环被装配进了这一版二进制**——它证明不了任何一次真实搬家发生过，更证明不了目标端落位。目标端仍只能靠一条需要第二个集群有真实节点行的活库用例。Nacos 形态的自报链路（TS/dsh-node 侧）**已闭合**，见下方「C1 自报链路与拓扑接线（2026-09-16）」 已有（行号为 2026-09-15 实现后**重取**，此前一轮引用的 `store.go:101,110`、`server.go:113` 已随本次改动漂移）：`scheduler/internal/store/store.go:40,51,108`（三张表的 `cluster_id`，其中 108 是注册表主键）、`scheduler/internal/domain/domain.go:48,72,80`、`scheduler/internal/server/server.go:85-87,136`、`scheduler/internal/catalog/nacos.go:83`、`scheduler/internal/planner/planner.go:42,53`（后一行是闸门本身）、`data-plane/dsh-node/src/nacos.ts:73`。**侦察新增的关键事实**：`catalog/nacos.go:71-73` 只返回健康实例 → 失联集群与未部署集群在目录视图上**完全一样**（都是「没有它的节点」），因此**集群存活不能从节点目录派生**，必须有注册表 + 自报；另 `planner.go:42-44` 在 `ClusterID` 非空时硬过滤，空值时跳过 → 「跨集群」今天已是退化默认，缺的是**准入与偏好**而不是通路 |
| C2 | 全局执行监控面 | §7.4.2 | **已闭合**（2026-09-15，2026-09-16 扩到 14 条）：14 条告警规则覆盖点名的六类 + 有意多出的 `instance_down` / `latency` / `realm_isolation`，每条带 `class`/`tier`/`severity`；引用完整性门禁带 11 个反例自证；`max_stall` 停滞收割把「节点已不在目录中」的活跃任务转死信。2026-09-16 补的两条是 C5 自己的域指标（`LumoSessionControlRealmMismatch` / `LumoSessionControlPulseForced`）——那两条指标建出来就是为了告警，没有规则消费就等于没建 | `platform/deploy/prometheus-alerts.yml`、`platform/deploy/alerts-verify.sh`、`observability/cmd/alerts-verify/`、`scheduler/internal/server/{metrics,stall}.go`、`scheduler/internal/store/{store,stall}.go` |
| C3 | 边缘网关 Edge | §12.1 | **已闭合（2026-09-16 第五轮：验收探针补齐）**：`edge-gateway` 全栈落地，南北流量由「直达各服务」改为经它进入——`internal/routing`（声明式路由表，**加载时**完成全部校验 + 上游主机白名单是边界隔离硬要求 + 灰度权重用 FNV-1a 把种子映射到 `[0,100)`）、`internal/proxy`（上游转发）、`internal/waf`（请求校验）、`internal/gate`（限流 / 请求体大小 / 连接数 / CORS，复用共享 `ratelimit` 令牌桶；`FailOpen` **缺省 false** = Redis 抖动时拒绝而非放行）、`internal/server`。**唯一仍缺的那一处已补（2026-09-16 第五轮）**：端到端验收现在有探针——`probes-cluster.sh` 探针 1（经边缘转发的整条链）+ 探针 2（`/v1/routes` 非空；抓的是「表加载了但是空的」这类静默失效：网关只拒绝加载失败与校验失败，**空表是合法输入** → 每个请求 404 而进程健康、日志干净）。目标端从拓扑派生（不写名单），门禁 `probes-cluster-verify.sh` 用假服务逐条钉住每一种分类。真二进制实测：两个网关跑在与 `compose.cluster.yml` 相同的宿主端口上，探针 1/2 通过。**仍欠**真 compose 集群里的一次全绿运行（环境事件，非代码缺口）。**「不在 Helm chart 里」已于 2026-09-16 闭合**（当天第二轮）：它进了 `services`（端口 8080），且不只是加两行——路由表由 `templates/edge-routes.yaml` 渲染成 ConfigMap，上游主机名与端口**从 chart 派生**而不是抄一份（白名单要求与 `url.Host` 精确相等，抄来的名字在多 release 拓扑下会**全数**失效；抄来的端口在有人改 `services.flows.port` 后会静默指向旧端口，症状是运行期 502 而两份配置各自看起来都对）；挂载走**目录**而非 `subPath`（subPath 收不到 ConfigMap 更新，会让 SIGHUP 热重载永远读到启动时那份内容＝该功能等于不存在）；指向未部署/已停用的服务在**渲染期**失败而不是等运行期 502；这张渲染表与 dev 表一样被 `edge-routes-verify.sh` 喂给网关自己的校验器（第二张被部署的表此前无任何门禁） | `edge-gateway/`（12 个 Go 文件，含 5 个 `_test.go`）、`compose.cluster.yml:595-603`（宿主 `18080:8080`，挂 `edge-routes.dev.json`）、`prometheus.yml:37`（抓取）、`prometheus-alerts.yml:258-276`（错误率告警的 `service=~` 名单含它）、`edge-routes-verify.sh` + `cmd/edge-gateway-check`（专用路由校验器，含反向用例） |
| C4 | 终端网关 Terminal | §8.2 | **已闭合（2026-09-16 第五轮：验收探针补齐）**：服务端与两种 compose 形态已完成，`presence` 不再只活在 mailbox 契约里——`internal/ws`（RFC6455 服务端子集）、`internal/capability`（能力协商纯函数）、`internal/events`（终端无关事件汇 + replay 游标）、`internal/presence`（**时间过期而非 TTL** + 指标替换）、`internal/policy`（签名 + OPA fail-closed）、`internal/server`。**刻意不实现状态机**：pause/resume/stop 的语义归 session-control（§8.4.3 末句），终端只渲染视图与发控制事件，不做第二处状态判断。**唯一仍缺的那一处已补（2026-09-16 第五轮）**：探针 1（经边缘转发的整条链）+ 探针 3（presence 只读面的形状：200 但响应体没有 `"presence"` 键时，调用方会静默拿到空列表）。链的终态**按事件源是否配置分两种正确的形状**——未配回 `503 no_event_source`（诚实）、已配在握手处回 `400`（`server.go:106-127`）；判据两种都放行，只把「非 WS 请求拿到 2xx」判为失败。**这条判据是写这一轮时想清楚的**：只认 503 会让探针在事件源接线落地当天对着一个正确的部署报红，而那正是本行排期中的下一步。**仍欠**真 compose 集群里的一次全绿运行。**「不在 Helm chart 里」已于 2026-09-16 闭合**（与 C3 同一处缺席，也正是 `templates/configmap.yaml:30-35` 早就为它写了 `LUMO_OPA_URL`、配置面一直在假定它存在的那处）：它进了 `services`（端口 8090），签名密钥走 `terminalGateway.signingSecret`——`secret.yaml` 在 `secrets.create=true` 时铸造并**跨升级复用**（轮换会让在途签名全部失效，所以这里刻意不每次渲染新值）。**同时诚实标注了一处未接线**：历史事件源（session/event）仍未接，所以「装起来」只等于「进程在、心跳在、能过就绪闸门」；没有事件源时 WS 面返回 503 而不是伪造空历史，`NOTES.txt` 与 `values.yaml` 都写明「pod ready ≠ 终端可看历史」。**那一处已于 2026-09-18 闭合**：`internal/events/pg.go` 的 `PgEventSource` 直接读复制式会话日志（PG 是真相源），装配为默认来源。只读消费**不违反**那张表的单写者 + fencing 约束（约束管写侧），游标取 `max(seq)` 而非 `session_log_heads`（后者可领先于已落盘的行，用它会让补上的事件永远读不到），超限**报错**而非静默截断。真二进制实测：启动打「事件源：PG 会话日志」，非 WS 的 GET 从 `503` 变 `400`——正是本行**预先**判为通过的第二种形态，所以那条探针不会对着正确的部署报红 | `terminal-gateway/`（13 个 Go 文件，含 6 个 `_test.go`）、`compose.cluster.yml:611-621`（宿主 `18091:8090`，**刻意避开 18090**：那已给可选 overlay 的设备网关，同宿主端口声明两次会让 compose 直接拒绝启动）、`prometheus.yml:39`、`compose-ports-verify.sh`（含「18090 撞车」回归反例） |
| C5 | 共享执行控制 | §8.4 | **服务端已闭合**（2026-09-16）：`session-control` 把 pause/resume/stop/abort/approve/reject/replay/degrade 做成**可审计的一等事件**（`session_control_state` + `session_control_audit`，放行与拒绝都写），裁决链 = 状态机矩阵 → OPA（fail-closed，`policy_unavailable` 与 `policy_denied` 分离）→ 同会话串行化（进程内队列 + 库端 `FOR UPDATE` + 版本比较后交换）→ 落库 → 下发，并给出控制台要的只读投影（状态 / 此刻可点的按钮 / 时间线 / 队列现场）。**两处诚实缺口**：① **Go `control.Dispatcher` 仍未接线**——2026-09-17 复核更正了口径：它**不是**「pause 不生效」的原因（插件自己读 `session_control_state`，状态行就是通道），它欠的是 §8.4.2 的「控制指令作为 `session/control` 事件**进复制日志、多端可见**」；而 `session_log` 是**单写者 + fencing** 的（`session_writer_lease` 的令牌 + `(session_ref, seq)` 主键），外部直插会破坏单写者不变式，所以那条链的正解是**节点寻址的信箱**（照 `job_control_command` 的先例：correlation_id 主键幂等 + `take`/`ack` 租约 + `FOR UPDATE SKIP LOCKED`），留作后续切面。
**2026-09-18 推翻**：那句话说错了一半 —— 单写者确实排除了「外部直插」，但**信箱并不解决真正的问题**。真正的墙在事件类型上，而不在谁去写：`session/control` 不在 `KNOWN_SESSION_EVENT_TYPES` 里（该表按构造只覆盖 `deepseek-harness/packages/*/*/src/**`），而 `Session.append` 的 `opts` 只有 `surfaceOp`/`sourceEventSeqs`、**没有 `ignorable` 的槽位**，于是持久化读路径（`validateStoredEvents`）会因「不认识且无 `ignorable`」**拒绝整份日志**——即照字面实现它，每一个收到过控制指令的会话都会**永久打不开**。换谁去写（节点、信箱消费者、任何持有租约的人）都一样，因为 `append` 造不出那个标记。所以这一项由「留作后续切面」改判为**按构造不可接线**，与 E7b 同族；代码里的措辞已从「尚未接线」改成「不可接线」并附四段判据（`session-control/internal/control/control.go` 包注释）。**§8.4.2 的意图由控制面自己的 `session_control_state` + `session_control_audit` 满足**（多端可读、放行与拒绝都入账），生效通道是状态行本身，因此 `effectuation` 恒为 `recorded` 是诚实的终态而非缺口。**不要**把 `Event.Type` 改成一个 dsh 认识的原生类型借道落库——那是拿语义不对的事件夹带平台状态。**「pause 真的停转」已于 2026-09-17 闭合**：`agent/pre-step` 返回 `reject` 停在 turn 边界（拒之前把被 claim 的消息原样放回）、`agent.cancel` 硬取消 abort、恢复后注入续跑注记并 `steer` 唤醒；判据收在**一张状态表两个投影**（`controlGate` 工具级 / `controlActuation` turn 级），词表外 fail-closed 且**不**取消。因此 `effectuation` 仍恒为 `recorded`——记了没做可对账，做了没记无从追溯，这是刻意的顺序（且与「暂停生不生效」无关）；② **Session Console 的 UI 视图未接线**（读投影已就绪，控制台前端属另一项）。**已于 2026-09-18 闭合**：`lumo-ui` 接通代理三层（读面 / 时间线 / 写面）与 `SessionControlPanel`（挂在 Run 行上，`TaskRun.session_ref` 是运维面唯一指向具体会话的句柄）。**`realm`/`role`/`actor` 由代理按已验证会话覆盖注入**——控制面自己的注释写着身份是「调用方主张 + OPA 判定」，谁转发请求体谁就在主张身份，而代理是链上唯一知道真实身份的地方。另有三处与 §8.4.2 字面的偏离，都写在给运维看的地方：不写 UsageLedger（`cost_type` 是跨语言闭集，控制指令没有对应单位，写进去会污染全部成本聚合）、审计的 `seq` 留给 dsh（`session-log.ts` 契约禁止第二个序号）、并发裁决不回落 Scheduler（库端行锁 + 版本 CAS 已达同一语义，且不必让调度器参与控制路径）。**顺带补上一条此前完全没有的探针**（2026-09-16 第五轮）：`session-control` 此前连存活探针都没有，现在既有派生的存活探针（`smoke-cluster.sh`）也有装配证据探针（探针 6：`lumo_session_control_forced_releases_total` 序列存在——它是**无标签 gauge**，门禁里专门有一条假服务用无标签形态，因为第一版 `metric_value` 只认带标签的行、会把 C5 这三条全判成「没装配」） | `platform/control-plane/session-control/`（`internal/{state,policy,queue,store,control,server}`）、`platform/deploy/policies/session-control.rego`、`platform/deploy/compose.{cluster,standalone}.yml`、`helm/lumo-platform/{values.yaml,templates/configmap.yaml}`。**接线时顺带修掉一个让三处策略评估全部失效的既有缺陷**：compose 里的 OPA 用默认绑定（容器内 loopback），兄弟容器按 IP 访问一律连不上 → connector-gateway / terminal-gateway / session-control 全部静默 fail-closed；已改为 `--addr=0.0.0.0:8181` 并钉死镜像版本（实测 000 → 200，见 `cluster-development-tasks.md` 的 C5 一节） |
| C7 | 流程血缘 → Nebula | §9.2 / §17.2 | **已闭合（2026-09-16 复核更正，本行此前写「零命中」）**：血缘事实落 `flows/internal/lineage/`（DAG → 边集合的**纯函数**，不碰 I/O）+ `flows/internal/store/lineage.go`（outbox 表 `flow_lineage_outbox`，与发布快照**同事务**写入）。**关键取舍与 A5 同源**：不引入第二个存储/查询引擎——**Nebula 只是这张 PG 事实的呈现层**，由后台投影器异步搬运，Nebula 不可用不会让发布变慢或失败。`LUMO_FLOW_NEBULA_URL` 为空时整体关闭（不写 outbox 行、不起投影器、启动日志与 `/metrics` 都说明），读查询面此时给**明确的「不可用」原因**而不是用空列表冒充「没有血缘」。**旧记录的假阴性根因**：`lineage` 不在 `control-plane/` 顶层而在 `flows/internal/` 下，检索范围没覆盖到，与「我没搜到」记成「不存在」同一类错 | `flows/internal/lineage/lineage.go`（设计取舍写在包注释）、`flows/internal/store/lineage.go`、`flows/internal/domain/domain.go` 的 `FlowEdge`、`flows/internal/integration/lineage_test.go`。**未做**：Nebula 本体仍不在任何编排里（= D1，已降为产品决策，不影响本项的 PG 事实链）。**验收探针（2026-09-16 第五轮）**：`probes-cluster.sh` 探针 4 断言 `/metrics` 里 `lumo_flow_lineage_projector_enabled` **序列存在**——0 是「装配好了但没配 Nebula」（合法部署），缺席只可能是「这一版没带投影器」；并配了「把序列换掉必须报 `probe-feature-not-assembled`」的反例 |

> **C8 已移出本节**（2026-09-16 闭合，见第二节 C/D/E 组表）。首版写「`llm-gateway` 无 batch
> 实现（README 已注明 batch 显式外）」在当时是对的；那个「显式外」是**当时的范围声明**，
> 不是架构结论，所以它没有失效，只是被做掉了。

> **C1 的判据补充**：`cluster_id` 落进表结构之后，「多集群」剩下的不是数据模型问题，而是
> **调度决策问题**——谁有资格把任务放到别的集群、跨集群的资源视图从哪来、分区时以谁为准。
> 这三件事都需要先把 C2 的集群维度监控做出来才谈得上调参，因此 C1 的剩余部分应与 C2 同批排期，
> 不要单独启动。

> **C1 自报链路与拓扑接线（2026-09-16）**——本轮补的是 09-15 那轮故意留在客户端的部分，
> 但动手时发现**比预期严重**，值得完整记录：
>
> 1. **判定在任何可部署拓扑里都是关的。** `LUMO_SCHEDULER_CLUSTER_ID` 与
>    `LUMO_CLUSTER_ENFORCE` 在 `compose.cluster.yml`、`compose.standalone.yml`、Helm
>    chart 里**一个都不存在**。也就是说 09-15 那轮的代码、测试、指标、告警全都齐全，
>    而它们描述的那条闸门**从未在任何拓扑上打开过**。这与本仓库在 CI 上踩过的
>    「没人调用的门禁与通过的门禁无法区分」是同一种病：`git grep` 能查到的「实现」
>    不等于「生效的路径」。**新增的 `cluster-registry-verify.sh` 就是为了让下一轮不必
>    靠人去发现这件事。**
> 2. **一个开关同时承担身份与意图。** `LUMO_SCHEDULER_CLUSTER_ID` 原先既表示「我代表哪个
>    集群」（身份，决定要不要自报）又表示「我判不判别人」（意图）。真实拓扑里答案不同：
>    `compose.cluster.yml` 是**一个 `scheduler-0` 服务 cluster-a 与 cluster-b 两组节点**，
>    全局调度实例不该代表其中任何一个去自报，但必须判定。绑在一起的结果是运维只有
>    **撒一个谎**（随便认领一个集群）才能把判定打开。已拆成
>    `LUMO_CLUSTER_ENFORCE`（意图，三态，留空按身份派生以保住旧用法）+
>    `LUMO_SCHEDULER_CLUSTER_ID`（身份），见 `domain.ResolveClusterEnforcement`。
> 3. **上报方必须是承载节点，不能是控制台或父节点。** `dsh-web` 与父节点
>    （`LUMO_ROLE=agent`）都配着 `LUMO_SCHEDULER_URL` 与 `LUMO_CLUSTER_ID`，按「配了地址
>    就报」推导会让它们**代报**：一个承载节点全挂、只剩控制台的集群会一直显示健康，调度器
>    把任务放进去然后卡在无人执行。自报宣称的是「这个集群还能接新放置」，这句话只有承载
>    节点能让它成真，所以客户端按 `LUMO_ROLE=node` **显式收口**（`cluster-reporter.ts`
>    文件头写了完整理由），静态门禁也按同一判据核对。
> 4. **自报周期由控制面的实际阈值派生，不在节点上再配一遍。** 节点先 `GET /v1/clusters`
>    读 `suspect_ms` 再定周期（读不到才回落本地值并只提醒一次）。这是为了让「跨服务保持
>    两个值一致」这个必然被配错的失败模式消失；同时该响应里的 `enforced=false` 会**显式
>    告警一次**——「判定关着」与「一切健康」在面板上长得一样。
> 5. **元数据列改成「省略即保持原值」。** 一个集群有多个上报方（调度实例 + 承载节点），
>    心跳远比声明频繁；原先的 upsert 会让一次空心跳把 `namespace`/`capabilities`/`version`
>    清空。与 E8 的配置面写入口径同一条判据。代价写明：**「声明空能力集」与「未声明」在
>    协议上不可区分**，将来版本一致性前置真正消费该字段时必须换成显式 `declared` 字段。
>    **这笔账已于 2026-09-17 还清，但只还了一半 —— 只给 capabilities 加了显式
>    `capabilities_declared`。** 判据是「空值是不是一种有意义的声明」：空能力集是（这个
>    集群没有 GPU），空版本号不是。第一版按对称性也给 version 加了 `version_declared`，
>    代价是既有调用方（不带新标记的写法）静默变成空操作、且迁移把所有既有行判成「未声明」
>    ——细节见设计稿 §10.3。**别再把它加回来。**
> 6. **验证**：scheduler `gofmt`/`vet`/`build`/`test` 全绿（新增 `ResolveClusterEnforcement`
>    12 条表驱动用例）；dsh-node 43 条 TS 用例全绿（新增 15 条覆盖三态门禁、周期派生、
>    失败状态跃迁日志、关闭后不再发请求）；`cluster-registry-verify.sh` **12 项通过**
>    （4 个真实拓扑 + 6 个缺陷用例 + 2 项环境检查），已接进 CI `production-gates`。
>    **仍未验证**：新增的活库用例 `TestClusterMetadataSurvivesAPureHeartbeat` 与其余 25 条
>    活库用例一样在本机跳过（Docker 守护进程未启动，`LUMO_TEST_PG_DSN` 无值），
>    「省略即保持原值」这条 SQL 语义只经过阅读与编译，未在真实 PG 上执行过。
>

> **C2 闭合明细（2026-09-15）**——留在原位是因为这一项的价值全在「原来那两条告警为什么
> 永远不可能响」这个链条上，拆进表格会把它切断：
>
> 1. **两条结构性死规则**。`LumoServiceDown` 的条件是 `lumo_service_up == 0`，而
>    `lumo_service_up` 是 `/metrics` 里写死的字面量 `1`——永远不可能为 0。Helm 里的记录规则
>    选择 `lumo_http_requests_total{status=~"5.."}`，而那个计数器**不带任何标签**，永远选不到
>    序列。两条语法都合法、Prometheus 都接受，只是永远不会响。修法是**删掉** `lumo_service_up`
>    而不是留着：删掉之后任何再次引用它的告警都会被新门禁判为「没有这个指标」。
>    实例存活的正确信号是 Prometheus 自己的 `up`——它不依赖被监控方如实上报自己的死活。
>
> 2. **指标层缺两件事**，缺了就无法表达集群维度：带标签的 gauge（`SetGaugeWithLabels`），
>    以及**整体替换**（`ReplaceGauges`）。后者是必须的：增量写入表达不了「某个维度已经消失」，
>    序列会永远停在最后一次写入的值上——某集群队列清空后排队数仍显示 100，对应告警永不解除。
>    替换按**渲染后的标签**做键，不按原始 map，否则并发调用方持有同一个 map 会互相删序列。
>
> 3. **六类的数据源逐个落实**：`queue_backlog` 取各集群最久排队时长；`task_lost` 取「挂在
>    目录中已不存在的节点上」的活跃任务数；`node_down` 取目录健康节点数；`gateway_5xx` 复用
>    既有计数器并新增 `service` 抓取标签（`job` 被所有控制面服务共用，回答不了「哪个服务 5xx」）；
>    `seam_circuit_open` 取熔断器快照；`budget_overrun` 新增一条对 `budget_trees` 的聚合。
>    **`task_lost` / `node_down` 在 Pg 目录（local-lite）下结构性不成立**：`scheduler_nodes`
>    只 upsert 从不删行，没有任何存活信号。这一条必须写在规则旁，不能靠一条永远不响的规则
>    冒充覆盖。
>
> 4. **`max_stall` 停滞收割**（§7.4.2 后半句）。三道闸门缺一不可：目录快照必须新鲜、
>    节点必须**不在**目录中、该 attempt 静默超过 8h（宽限而非主判据）。第三个尤其要紧——
>    `scheduler_tasks.updated_at` 只在**状态跃迁**时前进，正常跑 9 小时与卡死 9 小时长得一样，
>    拿它当判据会成批误杀长任务，而终态不可回退。收割是 leader-only 且**条件写**
>    （状态仍活跃 + attempt 仍是那一代），判定与落库之间任务被推进时什么都不做。
>
> 5. **门禁 `platform/deploy/alerts-verify.sh`**：把告警表达式里的指标名与 Go 侧的写入点对照，
>    并带 9 个反例自证。只检查「好输入能过」的门禁，在它保护的检查被删掉之后仍然是绿的——
>    它证明不了自己还在工作。反例断言到**具体文案**而不是退出码，因为退出码 1 可能来自任何
>    一个检查，只断言非零退出等于给「检查被换成了另一个检查」留后门。
>
> **未验证（2026-09-16 更正，原文误称「本机无 PG」）**：`LUMO_TEST_PG_DSN` 门控的活库集成用例
> 在本机**可以**跑——09-15 晚的套件已在真库上跑完 11 个 Go 模块 714 PASS / 12 个 TS spec 113 PASS。
> 本项仍未验证的只剩后半句：真实集群上的 Prometheus 是否接受这份规则文件（无 `promtool`）。规则文件按 Prometheus 的严格键集校验过——
> 规则级多一个键（例如把 `class` 写在规则级而不是 `labels` 里）会让**整个文件**加载失败，
> 而 YAML 解析成功完全看不出来。

### D. 部署与验收 —— 仅 D1 仍未闭合

> D2 / D3 / D5 已闭合，但闭合明细刻意留在本节原位：这三项的价值在于「现象 → 根因 → 修法」连着读，
> 拆进第二节的表格会把这个链条切断。第二节的 C/D/E 表因此只收录 D4 与 D6。

1. **D1（部分）Nebula 不在任何编排中**：`compose.cluster.yml` / `compose.standalone.yml` / Helm 均无该中间件。
   2026-09-15 起 `acceptance-cluster.sh` **不再要求**它（改为可选探测），本项因此与 D5 解耦：
   它变成「要不要给集群提供 Nebula 图引擎」的产品决策，不再是验收链路的阻塞项。
   （Doris 部分已按 2026-09-14 决策移除，见 A5，不再计入。）
2. **D2 Helm 无 Secret 模板 → 2026-09-15 全部闭合**：
   - ✅ **四个被引用的 Secret 从「靠猜」变成有契约**：`registry-trust.json` 这个 **key 名**无法从
     `registry.trustSecret` 推断，而卷挂载的 key 写错只会得到一个**空目录**、容器照常启动。
     新增 `templates/NOTES.txt`，把每个 Secret 的名字、key、消费方、内容形状直接印在安装输出里。
   - ✅ **默认渲染本来就装不上**：`lumo-control-plane-token` 被每个启用的服务以 `optional: false` 读取，
     而 chart 从不创建它 → 首次 `helm install` 全部 Pod 停在 `CreateContainerConfigError`。
     新增 `secrets.create`（默认 `false`，opt-in）生成**纯随机 bearer**（control-plane / subagent-host）
     与**占位信任根** `{"publishers":[]}`。**刻意不生成**的两项：`lumo-vault-token`（必须匹配一个
     chart 并不部署的真实 Vault，随机值等于一个无效凭据）与真实信任根（它是一组发布者公钥，
     `registry/internal/trust/trust.go:47-52`，随机值没有语义）。
   - ✅ **轮换安全**：生成走 `lookup` 复用集群里已有的值（`_helpers.tpl` 的
     `lumo-platform.managedSecretValue`）。没有这一步，一次普通 `helm upgrade` 会重铸 bearer token，
     把所有已持有旧值的进程踢出鉴权。另配 `helm.sh/resource-policy: keep`：卸载不删凭据，
     同 release 名重装会自动收养并复用同一个值。
   - ✅ **values 里没有明文 token 入口**（只有 Secret 名）。`helm get values` 与 release Secret
     都可读，从 values 进来的 token 在进入的那一刻就已经泄露了；这条性质值得保住。
   - ✅ **空名不再渲染成非法清单**：`vault.tokenSecret=` 曾渲染出
     `secretKeyRef: { name: , key: token, optional: true }`，而 **`helm template` 报成功**——
     只有 `kubectl apply` / GitOps 同步时才炸，报错位置离真正的原因很远。现在整条 env 省略。
     同类守卫覆盖 `registry.trustSecret`（registry 启用时必填）与 `dshNode.hostTokenSecret`
     （dshNode / dshWeb 启用时必填）；守卫是**条件式**的——九个服务全关时不触发（已实测，
     否则守卫就是恒真的，等于没有）。
3. **D3 Helm 默认关闭项 → 2026-09-15 全部闭合**：新增 `values.cluster.yaml` 集群 profile，
   逐项判定并写明理由（此前 `values.yaml` 里九个 `false` 无人判定，也没人知道该不该开）。
   - **开启**：`dshNode`（集群的定义性能力：可水平扩展的 subagent 节点池 + HPA）、`dshWeb`（运维入口）、
     `secrets.create`（让 profile 可直装，与 `compose.cluster.yml` 的开发默认值同性质）、
     `services.scheduler.replicas=2` 与 `collaborator.replicas=2`（对齐 compose 的双副本）。
     为此新增 per-service `replicas` 覆盖——单一全局 `replicaCount` 表达不了「scheduler/collaborator 成对、
     其余单个」这个非均匀形态。
   - **保持关闭且写明外部依赖**：`connectorOAuth`（需已注册的 OAuth 应用与 callbackUrl）、
     `deviceGateway`（需精确公网 HTTPS origin + 服务器证书 + 专用设备 CA）、`deviceGateway.istioIngress`
     （另需 Istio ingress controller）、`serviceMesh.istio`（chart **明确拒绝猜** trustDomain：
     「错的 SPIFFE trust domain 是鉴权 bug，不是配置偏好」）、`productionControls{,.observability}`
     （「Helm cannot make business/compliance choices」——合规引用与留存/成本数值不是我们该编的）、
     `provisioner{,.runtime}`（需一个**确实已发布**的制品）、`dshNode.governedWorker`（逐 Pod 身份特化，
     且六个字段必须事先已知）。
   - ✅ **顺带挖出并修掉一个 P0：`replicaCount: 2` 会静默造出两个 leader**。模板只给 `collaborator`
     注入 `LUMO_INSTANCE`，而 scheduler 的实例名回落链是 `LUMO_INSTANCE` → **字面量 `"scheduler-0"`**
     （`scheduler/cmd/scheduler/main.go:33`，flag 说明写着「租约 holder，重启后不得与旧进程重复」），
     **不是主机名**。两个副本于是以同一 holder 去 `Acquire`，而
     `scheduler/internal/store/store.go:204-208` 在 holder 相同时**不递增 `fencing_token`**
     且 `WHERE` 子句照样命中 → 两个进程各拿到 token=1 的租约；`checkFencing` 只比 holder+token（`:253`），
     于是**两个 leader 之间没有任何 fencing**。修法：每个控制面服务都从 `metadata.name` 注入
     `LUMO_INSTANCE`（此前只有 collaborator 有）。用 Pod 名还顺带修掉第二层问题——重启后的新进程
     会拿到更高的 token，把旧进程挡在外面；而静态名会让重启进程以同一个 token 复活。
   - ✅ **新增渲染门禁 `platform/deploy/helm-verify.sh`**（纯 helm、无集群、无 Docker，秒级）。
     它断言：每个被引用的 Secret 要么被渲染、要么在**显式写死**的运维自备清单里；不得出现空名；
     集群 profile 的 Secret 集合与 scheduler 副本数符合预期；每个控制面服务都把 `LUMO_INSTANCE`
     绑到 Pod 名；两个 profile 都要过 `helm lint`（这是离线渲染 `NOTES.txt` 的唯一途径，已用对照实验
     证明 lint 确实会渲染它）。**四条守卫另配「必须被拒绝」的反向用例**——只检查「好的渲染能过」
     的门禁，在守卫被删掉之后照样全绿。六条对照实验（逐条删守卫）全部转红，且红在对的理由上。
4. **D5 验收链路从未真正执行 → 2026-09-15 全部闭合**（含复核时顺带发现的 `up.sh` P0）：
   - ✅ **`LUMO_TEST_*` 无人设置**：新增 `platform/deploy/acceptance.env.example`（必填 / 可选清单、
     各服务的 compose 内网端口、取值注意事项）。脚本对必填项仍拒绝空值。
   - ✅ **静默跳过（本轮发现，本组最严重）**：`acceptance-cluster.sh` 只导出 `LUMO_TEST_PG_DSN`，
     而 `session-log/__tests__/pg-log.spec.ts:16` 读 `SESSION_LOG_TEST_DSN ?? METERING_TEST_DSN` ——
     名字对不上时 `it.skip` 让退出码保持 0。**实测：该文件 19 个用例全部跳过、退出码 0、报告 success**，
     而这一步的 resume/fencing 正是集群验收要拿的证据。修法：新增 `platform/vitest.setup.ts`
     （vitest `setupFiles`）把 `LUMO_TEST_PG_DSN` 兜底成各子系统名，显式设置仍优先。
     影响面覆盖 `session-log/{pg-log,hot-log,query,backfill,cold-archive}`、`job-control`、
     `metering/*`、`storage/*`。
   - ✅ **`preflight-deployment.sh:111` 服务子集过窄**：已改为按形态写死的完整期望
     （cluster 30 / standalone 18，与「默认渲染集」精确相等，已用 compose 文件比对验证），
     并排除 `profiles: [provisioner]` 的 provisioner / artifact-runtime。
   - ✅ **每一步断言「真的执行了活体用例」**：vitest 步骤读 JSON reporter 的非跳过计数，Go 步骤数
     `--- PASS`；计数为 0 即失败并 dump 证据。理由：实测 `go test -v` 全 SKIP 时退出码同样是 0，
     **退出码不足以为据**。
   - ✅ **Nebula 被误列为必需**：脚本曾 `require_value LUMO_TEST_NEBULA_HEALTH_URL`，要求一个
     **任何编排里都不存在**的外部服务；而 `cluster-runtime.env:9` 与 Helm `values.yaml:24` 都默认
     为空、knowledge 插件在空值时回落 PG 递归 CTE（`knowledge/src/index.ts:69`）—— 等于脚本自己
     宣告「不可能通过」。已改为可选（设了才探测）。
   - ✅ **Go 集成测试缺 collaborator**（原记录同时误称「缺 governance」，实际 `acceptance-cluster.sh`
     早已含 governance）：已补 `collaborator ./internal/integration`，并补入本轮新增的
     `connector-gateway ./internal/audit`。
   - ✅ **cluster 拓扑不发布任何基础设施端口**（本条闭合于同日稍后）。`compose.cluster.yml` 里只有
     prometheus / dsh-web / 11 个控制面服务（18081-18093）带 `ports:`；postgres / redis / minio /
     nacos / milvus / opa / vault / etcd / rocketmq 只在 compose 网络内可达，而验收脚本必须在宿主机
     拿到 PG DSN、五个健康 URL 与 RMQ endpoint。已补 `compose.cluster.acceptance.yml`（additive：
     只给已有服务加 `ports:`，不新增服务，故 preflight / smoke 的服务集检查不受影响；宿主端口刻意
     与 standalone 一致，使 `acceptance.env.example` 的值对两种形态都成立），并给 `up.sh` 加了
     `LUMO_COMPOSE_EXTRA_FILES`（冒号分隔，追加在 `compose.<shape>.yml` 之后）。
   - ✅ **`up.sh` 从未真正启动过拓扑**（本条为复核本项时顺带发现，性质是 P0）。`warn_legacy_cluster_storage`
     只负责**警告**，却在 `set -e` 下被当普通命令调用，而它的两处提前返回都是裸 `return`
     （`up.sh:24` 的 `[[ "$shape" == "cluster" ]] || return`、`:34` 的 `[[ -n "$postgres_container" ]] || return`），
     返回的是那次测试的**非 0** 状态 → 整个脚本被杀。后果：`up.sh standalone` **无条件**退出 1；
     `up.sh cluster` 在「还没有 postgres 容器」时（即第一次部署）退出 1。两条 README 记载的启动路径
     都到不了 `docker compose up`。已把三处提前返回改成显式 `return 0` 并在末尾补 `return 0`。
     **教训：`set -e` 下的「警告函数」必须永远返回 0，否则警告会变成致命错误。**
   - CI 的 `deploy-smoke` job 是否仍被 `if: ${{ false }}` 关闭 —— **2026-09-15 第三次复核已确认**：
     确实是 `false`（此前两轮的「该文件读取受限」不成立，该文件可读）。它**有意保持关闭**：
     本仓库没有能跑 Docker 的 runner，只删掉 `if:` 行会造出一个注定不通过的 job。
     闭合同一轮还发现 CI 里同一类缺陷尚在：见下方口径差异表「CI 的 DSN 注入」一行。

### E. 死代码与占位

| # | 项 | 现状 | 证据 |
|---|---|---|---|
| E6 | `AppendOnlyMerger` 已弃用 | **已闭合（2026-09-16：边界写成三条 + 变成可执行的反例）**。原注释「兼容旧状态读取与历史测试」**两句都不成立**——当日全仓检索（Go 源码、测试、脚本、配置、文档）零引用，它根本没有 importer。边界现写在 `collaborator/internal/crdt/merger.go` 的类型注释里：**为什么保留**（Merger 契约的负例：按到达顺序原样拼接 → 顺序敏感，即违反「同一集合无论顺序产出等价状态」）/ **谁能用**（没有任何人；`Name()` 里的「占位，非生产」是误装配时唯一能看出来的信号，它会被打进启动日志的 `kernel=` 字段）/ **什么时候删除**（契约在别处已有等价负例，或契约本身被改写；在那之前删它是删证据而非清死代码）。规则也从注释变成断言：`TestAppendOnlyMergerIsNotConvergent`（同一集合换个顺序产出不同字节，并以 `UpdateSetMerger` 做对照——没有对照就分不清「内核差异」与「我把输入构造错了」）+ `TestAppendOnlyMergerNameStaysLabelledNonProduction` | `collaborator/internal/crdt/merger.go:88-110`（三条边界）、`internal/crdt/merger_test.go`（两条用例）、装配面 `cmd/collaborator/main.go:114-130`（生产只有 `UpdateSetMerger` / `YrsProcessMerger` 两条路） |
| E7b | connector 审计的 SessionEvent 投影器从未落地 | **复核（2026-09-17）：不是缺一件，是缺三件，而投影器是最后一件。** ① **源头没带会话**：`connector_invoke` 的 `execute(args, _exec)` 忽略执行上下文，`ConnectorClient` 的身份头里没有 `X-Lumo-Session`，而网关的 `SessionID` 正是从该头取的 → `connector_audit.session_id` **恒为 NULL**；② 于是 `idx_connector_audit_pending` 的谓词 `projected_at IS NULL AND session_id IS NOT NULL` **结构性零匹配**——**单做投影器会得到一个永远没有活干的投影器**（绿而空转，与 D5 的静默跳过同族）；③ 投影器本身缺失。**同源后果一条**：E7 已「闭合」的查询面里 `sessionId` 过滤与 `idx_connector_audit_session` 也**恒不命中**——不是查询写错了，是那列从来没被写过。**① 已修（2026-09-17）**：`connector_invoke` 经 `exec.agent.session.id` 带上会话 ref，客户端按「有则发、无则不发明文」补头，四条用例钉住（含「空白串也不发」）。**③ 改判为「不做」（2026-09-17 晚复核，判据是「不可实现」而非「没时间」）**：原设计「`session.append('connector/call', …)` 落进时间线」在 dsh 侧**按构造走不通** —— `append(type, data, …opts)` 构造的封套是 `{type, seq, time, data, ...surfaceMetadata}`，`opts` 只可能带 `surfaceOp`/`sourceEventSeqs`，**没有 `ignorable` 的位置**；而平台插件的事件名**按构造**不在生成的 `KNOWN_SESSION_EVENT_TYPES` 里（该文件由 `gen-persistence-catalog.ts` 扫 `packages/*/*/src/**` 生成），持久化读路径对「不认识且无 `ignorable`」的事件**拒绝整份日志** → 写进去等于让**每一个调用过连接器的会话在重载时永久打不开**（不是缺口，是数据毁伤）；登记成已知类型同样不行 —— 那会把纯信息性事件变成 required-on-read，任何没打该 patch 的构建（含上游桌面）都读不了它。**而且不需要**：会话侧 `connector_invoke` 的 `tool/call`+`tool/result` 本就是 surface 事件、且已带 `status`/`durationMs`/`redacted`/`error`/`code`/`retryable`；网关侧 `GET /audit?sessionId=…` 给出权威记录（含 `Entry.ID`）。**② 随之成为无写入方**：`projected_at` 与 `idx_connector_audit_pending` 恒空；按 E6 的先例**保留但把边界写进代码**（删列要动已上线的表，且错的是它期待的写入方不存在，不是列本身）——边界已落在 `internal/audit/audit.go` 包注释（三条理由 + 两条替代路径）与 `internal/audit/query.go` 的 `Entry` 注释。**残留一处（不阻塞）**：工具结果里没有审计行 id，两侧目前只能按 `(session_id, operation, 时间)` 近似对应；要做精确对应需让 `Sink.Write` 回传 INSERT 的 id 并在调用响应里透传，属**改已上线接口**的独立决定 | 复核证据：`dsh-plugins/connector/src/tools.ts:114`（`_exec` 未使用，已修）、`src/client.ts`（身份头无会话项，已修）、`connector-gateway/cmd/connector-gateway/main.go:59`、`internal/audit/audit.go:46`（偏索引谓词）、`internal/audit/query.go:134`。① 的修复落点：`connector/src/{client.ts,tools.ts}` + `connector/__tests__/client.spec.ts`。③ 的否决判据：`deepseek-harness/packages/core/session/src/index.ts:710`（`append` 封套，桌面运行时同实现 `desktop/dist/…/dsh-session/lib/index.js:1444`）、`scripts/gen-persistence-catalog.ts:15,176`（`root=deepseek-harness/`、glob `packages/*/*/src/**/*.ts`）、`packages/core/session/src/known-event-types.ts:9-21`（「out-of-repo 插件事件按构造不在表里」）、`packages/session/session-persistence/src/storage-contract.ts:75`（拒绝整份日志）、`packages/core/session/src/surface.ts:245`、`.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`（「按挂载插件登记事件名」被明确否决） |

> **E1 判为「非缺口」**：`governance/internal/breakglass` 是**有意保留的合规边界**，不是遗漏。
> `implementation-status.md:72` 明确记载它只提供「策略无关的数据模型与内存实现」，
> 并且「接入正式审批/密钥系统前不会自行赋予生产权限」。补全它等于替用户做产品与合规决策，
> 因此本文不再把它列为待办。
>
> **E7b 的结论（2026-09-17 晚，第二次复核后重写）**：**③ 不做，② 保留但无写入方，只剩一处可选残留。**
> 不是排期问题，是「按构造不可实现」——**dsh 没有给平台插件留出「写一个自定义持久事件类型」的通道**。
> 三条否决理由（全文与行号在 E7b 行末证据列，代码里的落点是 `internal/audit/audit.go` 包注释）：
> ① `Session.append` 的封套里**没有 `ignorable` 的位置**；② 没有它，平台插件的事件名不在生成的
> `KNOWN_SESSION_EVENT_TYPES` 里，持久化读路径会**拒绝整份日志**（写进去 = 让每个调用过连接器的
> 会话重载时打不开）；③ 登记成已知类型会把信息性事件变成 required-on-read，比不做更坏。
> **替代路径已经存在且够用**：会话侧有 `tool/call`+`tool/result`（本就是 surface 事件，已带
> `status`/`durationMs`/`error`/`code`/`retryable`），网关侧有 `GET /audit?sessionId=…`（① 修好后
> 真的能命中）。**不要再为「把 `projected_at` 用起来」而动手**：也不要在 connector-gateway 里造一个
> 往 session 写事件的 HTTP 出口——session 存储不在该服务的边界内，且那只是把同一个不可能的写入
> 挪到另一个进程里。
>
> ⚠️ **上一版这段写反了，留在这里当教训**：原话是「`SessionEventMap` 是 merge-extensible 的，
> 插件可以 `declare module` 加自己的事件类型……兼容机制是 `ignorable: true` —— **不需要改 harness**」。
> 它错在只核实了**「能不能声明」**（类型层）与**「注释怎么说」**（意图层），
> 没核实**「写侧能不能把标记写出来」**和**「读侧认不认」**。`declare module` 只让 TS 通过，
> 既不会把名字加进**运行时生成的 Set**，也改不了 `append` 造不出 `ignorable` 这件事。
> 判「这条路通不通」必须沿**声明 → 写入 → 持久化 → 重载**四段走完，只查一段会得到相反的结论。
> 一个**上游边界**必须先知道：通用 `/web/fetch` 那条路**做不到**，因为 dsh 的 `WebFetchRequest`
> 只有 `{ url }`（`packages/web/web/src/types.ts:64`），provider 拿不到会话。要么接受它一直是
> `system`，要么先改上游接口——**这是产品/上游决策，不是本仓库单方面能补的**。

---

## 二、已闭合（追溯用）

保留首版现象描述与闭合位置，供后续追溯「当时是什么问题、怎么修的」。

### A 组：静默 P0 —— 全部闭合

| # | 首版现象 | 闭合位置 |
|---|---|---|
| A1 | 流程引擎算子目录为空（只有 identity/echo） | `flows/internal/engine/runtime.go:33-60` 的 `registerRuntime` 注册 6 个真实算子（`llm.chat` / `llm.answer` / `connector.invoke` / `tool.invoke` / `knowledge.query` / `kb.query`），并维护 `unavailable` 映射：上游未配置、URL 非法、控制面令牌缺失三种情况各自给出可读理由，而不是运行时 422 |
| A2 | cron 自动化可创建但永不执行 | 完整落地：`flows/internal/cron/`（表达式与下次触发时刻）+ `flows/internal/store/schedule.go`（`flow_cron_cursors` 游标表、`DueCronCursors`、`FireCronCursor` **同事务**推进游标并入队、`StallCronCursor`）+ `flows/internal/schedule/producer.go`（`Run`/`Cycle`/`reconcile`）；装配于 `flows/cmd/flows/main.go:136`。集成判据见 `flows/internal/integration/schedule_test.go` |
| A3 | 已发布文档快照永不进入向量检索 | `collaborator/internal/indexing/dispatcher.go:126,154`：`PendingPublishes` → 分片 → `POST /seam/knowledge/ingest` → `MarkDispatched`；判据见 `collaborator/internal/integration/outbox_test.go` |
| A4 | Agent 永远不可被派单 | `governance/internal/server/worker_runtime.go:27` 的 `reportWorkerRuntime` + 路由 `PUT /v1/workers/{workerID}/runtime`（`server.go:144`）+ `store/worker_runtime.go:58 ReportWorkerRuntime`；`Eligible` 判据见 `server.go:1059` |
| A5 | Doris 投影整包未接线 | 按决策**移除**（不接线）：`internal/doris`、`internal/projection`、`internal/analytics/doris.go` 已删除，查询面收敛为只读 PG 日聚合。决策痕迹留在 `superpowers/specs/2026-08-26-doris-aggregation-design.md` |

### B 组：装配缺口 —— 全部闭合

首版的结构性判断是「cluster 专属能力依赖的配置，启动器一个都不读」。现在启动器**全部读**：
`data-plane/dsh-node/src/cluster.ts:16` 的 `clusterWiring(env, mode, role)` 是唯一入口，
在 `index.ts:147` 被调用并逐项注入插件配置。

| # | 首版现象 | 闭合位置 |
|---|---|---|
| B1 | Seam 网络化未挂载 | `cluster.ts:18-37`（`LUMO_SEAM_MODE` 缺省按 cluster+role 推导 host/proxy、endpoints 校验、mTLS 三件套强制成组）→ `index.ts:151-153` 生成 seam 插件行，`:421` 按 proxy/host 决定注入面 |
| B2 | 计量台账仍走 local drain | `cluster.ts:38` `ledgerTransport` 缺省按模式取 `rmq`/`local` → `index.ts:445` 传给 metering |
| B3 | Milvus / Nebula / 重排未配置 | `cluster.ts:47-57` → `index.ts:424-429` 注入 knowledge（milvus、nebula、rerank 三段） |
| B4 | OPA 没进节点 | `cluster.ts:45` → `index.ts:460` 注入 control |
| B5 | 制品下发闭环缺一段 | `index.ts:184-207`：读 `PROVISIONER_ARTIFACT_NAME`，据此推导快照根与快照文件，**等待快照文件就绪**（`waitForSkillSnapshotFile`）后由 `skills.ts` 的 `localSkillSnapshotAssembly` 装配 skill-local 行并关闭文件系统覆盖。compose 中该变量默认为空属**部署决策**（要下发哪个制品必须由 operator 指定），不是代码缺口 |
| B6 | 跨节点读滞后判不出 | `dsh-plugins/session-log/src/index.ts:157`：`liveHead = Math.max(opts.liveHead ?? 0, await log.head(sessionRef))`，`undefined` 不再恒判 `fresh` |

### C / D / E 组的闭合项

> **D2 / D3 / D5 不在此表**：这三项的闭合明细留在第一节 D 组原位，因为「现象 → 根因 → 修法」
> 连着读才有价值（D5 的静默跳过、D3 的租约身份撞车都属于「结论一句话说不清、证据才说得清」的类型）。
>
> **C3 / C4 / C7 同样不在此表**（2026-09-16 复核补记）：它们各自的闭合明细与**未做的验收**
> 都留在第一节 C 组原位。这三行是本清单里**最典型的「实现已落地、清单没跟上」**——旧记录的
> 「全仓检索零命中」不是历史事实的错误，而是**检索范围**的错误（只扫了 `control-plane/`，
> 漏掉 `flows/internal/`）与**时点**的错误（写完清单之后才实现）。补一行「已闭合」比补一行
> 「怎么闭合的」便宜得多，因此这里刻意不复制明细。

| # | 首版现象 | 闭合位置 |
|---|---|---|
| C6 | `agentTeams` 零命中 | 首方插件 `dsh-plugins/agent-teams/`（`ctx.provide('agentTeams', service)`，`src/index.ts:129`），一份代码同时成立在 local / standalone / cluster 三形态。设计取舍见 `MEMORY.md` 第六节 |
| C8 | `llm-gateway` 无 batch 实现 | **已闭合（2026-09-16）**：`llm-gateway/internal/batch/coalescer.go`。§7.2 的诉求是「窗口内汇聚并发请求，合并成 MoE 需要的大 batch」，而网关是**代理**——它不能改写上游推理请求的格式（那是推理集群自己的连续批处理调度），所以它能做且必须做的只有一件事：**把随机到达的请求对齐成同时到达**。三条性质决定了实现形状：① **延迟有硬上界**，任何请求最多被延迟 `Window`，与并发数无关（加法而非乘法）；② **批满即放行**（`MaxBatch`，不必等窗口走完）；③ **窗口为 0 = 整体关闭**，直通路径不建 goroutine、不起定时器，与没有这层完全同形。默认关闭是刻意的：**拿首 token 延迟换吞吐是部署决策**，集群形态与单机形态的最优解不同。装配在 `cmd/llm-gateway/main.go:68-114`（`LUMO_LLM_BATCH_WINDOW_MS` / `LUMO_LLM_BATCH_MAX`），非法配置在**连库之前**以退出码 2 结束——否则「配错了」与「数据库连不上」在启动日志里长得一样。不做的事也写进了包注释：不合并请求体（做不到）、不跨模型混批（不同模型走不同上游，混批等于发给错误的上游）、不做背压队列（会引入无界等待，违背有界延迟） |
| D4 | Prometheus 漏抓 governance | 已加入：`deploy/prometheus.yml:10` 与 `deploy/prometheus-standalone.yml:10` 的 targets 均含 `governance:8089` |
| D6 | 集群就绪是静态声明 | 生效状态 = 意图 AND 派生健康。九个控制面服务上报心跳（`control-plane/heartbeat`），governance 用缓存快照解析门禁：非集群仍 403，已声明就绪但不健康改为 **503 + `Retry-After`**，响应体带不就绪原因、未就绪服务清单与求值时刻；`/v1/features` 同时暴露 `cluster_status_declared` / `cluster_status` / `cluster_ready`，缓存对「查询失败」与「快照过期」双 fail-closed。设备网关另为可选 overlay（`compose.cluster.devices.yml`） |
| E4 | `lumo_service_heartbeats` 死表 | 已激活：九个服务经 `heartbeat.StartPg` 写入，governance 读取求值。迁移 `deploy/migrations/004_service_heartbeats.sql`（复合主键 + `dependencies` 列） |
| E5 | `session-title-gw` 死包**且被装配表引用** | 已摘除（2026-09-15）：`data-plane/dsh-node/src/plugins.ts` 的 `PLATFORM_PLUGIN_MODULES` 与 `PLATFORM_PLUGIN_DIRECTORIES` 两处 `sessionTitleGateway` 条目删除，原位留下「不要加回来」的说明。**首版定性也不准**：它不是「未完成的插件」而是**验证切片**（无 `src/`、无 `main`/`exports`，`__tests__/title-route.spec.ts` 证明会话标题的辅助 LLM 调用**只需 Config 即可**改走网关，`title` 零改动）。**真正的缺陷是登记本身**：`profilePluginSpecs()` 会遍历该表，于是每个 profile 都要 `dsh plugin add` 一个永远加载不了的包，而 `isOptionalProfilePlugin('@lumo/...')` 恒为 false → 安装失败**直接抛错终止启动**，不是降级为 warn。登记它等于给启动路径埋一个无条件失败的闸门 |
| E7 | connector 审计只写不读 | 已补**查询面**（2026-09-15）：`GET /audit`（`connector-gateway/internal/server/audit.go` + `internal/audit/query.go`）。realm 只来自身份头、非管理员缺省只看自己的调用、`all=true` 需管理员、`decision` 未知值一律 400（**不得静默退化为不过滤**，否则「只看被拒绝的调用」会变成「全部调用」）。排序与游标都用 `id`：`created_at` 取事务开始时刻而 `id` 取 INSERT 时刻，并发下不一致，混用会漏行。**投影器那半边未实现，另立 E7b** |
| E8 | `llm_providers` 建表但无管理 API，需运维 seed | 已补管理面（2026-09-14）：`GET/PUT/DELETE /v1/providers[/{model...}]`。写入口径为「除 model 外全字段可选，省略即保持原值」——密钥读不回来，不这样设计任何 GET-then-PUT 客户端都会把密钥清掉。密钥永不回传（只有 `apiKeySet`），错误信息也不含它。路由面 `store.Provider`（只认启用行、带出密钥）与管理面 `domain.ProviderConfig`（看得见停用行、结构上无法携带密钥）**刻意分成两个类型**。详见 `configuration.md` |

---

## 三、判为误读（首版记错，不是缺口）

这三项在首版/复核版里被记成待办，逐项动手时发现**代码已经是对的**。
保留在此是为了让后续引用者不再重新踩一遍，也为了留下「怎么误判的」这个证据。

| # | 首版断言 | 实际情况 | 误判原因 |
|---|---|---|---|
| E2 | 「Scheduler 对账只落账，不修复分歧」 | **函数体会修复**：`store.go:966-976` 在写完 ledger 与 attempt 之后，按 `e.Attempt > currentAttempt \|\| (e.Attempt == currentAttempt && stateRank(e.State) > stateRank(currentState))` 判定，然后 `UPDATE scheduler_tasks SET attempt=$2, node_id=$3, state=$4, fencing_token=$5, updated_at=...`。语义是「高 attempt 覆盖低 attempt；同 attempt 只允许状态单调前进」——这是一次**单调合并**，不是无操作 | **断言直接抄了 doc comment**。`Reconcile` 的注释只描述「ledger 保留幂等审计记录」，没提合并；写清单的人读了注释就下了结论，没读函数体 |
| E3 | 「Scheduler 派发 outbox 无生产消费者；`ClaimDispatch` 唯一调用方是测试」 | **有两个生产消费者**，都在**同一事务内**完成「认领 + 准入门禁 + 置 `delivered_at`」：① `dsh-plugins/subagent-host/src/governed-dispatch.ts:61-123` 的 `PgGovernedDispatch.take()`（Agent 执行路径，`JOIN scheduler_dispatch_outbox ... AND o.delivered_at IS NULL AND o.claimed_by IS NULL`，末尾 `UPDATE ... SET delivered_at=..., claimed_by=NULL`）；② `governance/internal/store/devices.go:547-643` 的 `dispatchDeviceTask`（桌面设备路径，同法 `FOR UPDATE OF o ... SKIP LOCKED` 后置 `delivered_at`）。`ClaimDispatch` 无调用方是**设计选择**：它的「先 claim 后 ack」两段式会把这一个事务劈成两半，而消费者必须在**同一事务**里写下自己的准入回执（`lumo_governed_executions` / `governance_device_commands`），否则崩溃窗口会丢派发或重复执行 | 只查了「有没有人调这个 Go 方法」，没查「这张表有没有人消费」。**表级消费者不在 Go 侧**，在 TS 插件与另一个 Go 服务的 SQL 里 |

> **E3 的推论（重要）**：**不要**给 `ClaimDispatch` 补一个 HTTP 认领路由。那会造出同一张 outbox 的
> **第二个竞争者**：被 HTTP 认领但未 ack 的行对上面两个真实消费者不可见（它们过滤 `claimed_by IS NULL`），
> 于是任务会静默卡住，直到 `RequeueStaleDispatch`（`cmd/scheduler/main.go:93`，周期 `ttl*2`）才回收。
> `ClaimDispatch` 保留为**拉模型的参考实现**，由 `internal/integration/drain_test.go` 钉住其 FIFO 与
> SKIP LOCKED 语义；若日后确有「节点够不到 PG」的场景，先想清楚事务边界再动。

---

## 四、建议补齐顺序

1. ~~**E5 + E3 + E7 + E2（小、可判定）**~~ **已完成（2026-09-15）**：E5 已摘除装配引用、
   E7 已补查询面、E2/E3 改判为误读。原计划的四项里两项是误读、两项已闭合，本节不再保留。
2. ~~**D5（验收可执行）**~~ **已完成（2026-09-15）**：静默跳过、preflight 服务子集、活体用例计数守卫、
   Nebula 误判必需、collaborator 缺位、`LUMO_TEST_*` 模板、端口暴露覆盖文件，以及复核时顺带发现的
   `up.sh` 启动 P0，全部处理。**验收链路现在可以在 compose 上端到端跑通**；仍欠的只是在真机上取得
   一次多节点通过证据。**（2026-09-16 更正）**此项的阻碍**不是环境不具备**，而是当时 Docker 守护
   进程没启动；`open -a Docker` 之后 `platform/deploy/test-local-pg.sh` 已能跑完整活库套件。
3. ~~**D2 + D3（部署完整性）**~~ **已完成（2026-09-15）**：Helm Secret 模板（opt-in 生成 + `lookup`
   复用 + NOTES 契约）、集群 profile `values.cluster.yaml`（逐项判定并写明理由），以及做 D3 时
   顺带发现并修掉的 scheduler 租约身份撞车（`replicaCount: 2` 会造出两个无 fencing 的 leader）。
   新增 `platform/deploy/helm-verify.sh` 作为渲染门禁，含四条「必须被拒绝」的反向用例。
   （原 D1 的「Nebula 进编排」已与 D5 解耦，成为独立的产品决策，见 D1 条目。）
4. ~~**C2（集群维度监控 + 告警分级）**~~ **已完成（2026-09-15）**：两条结构性死规则修掉、
   指标层补上带标签 gauge 与整体替换、六类告警的数据源逐个落实、`max_stall` 停滞收割落地，
   并新增带反例自证的引用完整性门禁。明细见第一节 C2 闭合块。
5. **C1 剩余部分**：数据模型已经就位，缺的是决策规则（全局/集群 Scheduler 分层、联邦注册表、
   suspect 30s→down 90s 计时、跨集群重平衡），而规则要由监控数据支撑——现在那份数据有了，
   可以开始。**注意 `task_lost` / `node_down` 在 Pg 目录下结构性不成立**，调参前先确认目标形态
   用的是 Nacos 目录，否则会对着两个恒为 0 的指标调阈值。
   **2026-09-15：设计评审已出**（`docs/superpowers/specs/2026-09-15-multicluster-scheduling-design.md`），
   本轮范围 = 联邦注册表 + 两段式判定 + 放置闸门 + 集群维度指标；**明确不在本轮**的是
   down 后的事务漂移（不可逆，需新 attempt + fencing，单独一轮）、独立集群 Scheduler 进程、
   偏好打分、版本一致性前置。动手前先读那份文档的 §1（现况侦察带行号）与 §7（已知空洞：
   Nacos 下 `LastSeen` 恒为查询时刻、没有上报方时能力必须整体关闭否则自伤）。
   **2026-09-16 补**：漂移与自报链路已闭合（§9 / 下方「C1 自报链路与拓扑接线」）。
   **2026-09-17 补**：偏好打分与版本一致性前置也已闭合（§10），C1 只剩**全局/集群
   Scheduler 分层**这一项——它仍是独立的进程/角色问题，与前两项不同族。
6. ~~**E7b**（connector 审计的 SessionEvent 投影器）~~ **已处置（2026-09-17 晚）**：不是「随 C 组排期」，
   而是**不做** —— 往 session 日志写平台自定义事件类型在 dsh 侧按构造不可实现（理由见 E7b 行与上方结论段）。
   ①（源头带会话）已修，②（`projected_at` / 偏索引）保留但已注明无写入方，③ 撤销。
   此处顺带纠正一处旧判断：E7b 与 C 组的「跨进程投影」**并不同族** —— C 组的 `graph-projector`
   投影到的是**插件自己拥有的存储**（PG outbox → 图），而 E7b 要写的是**宿主的持久化词汇表**，
   后者没有留给平台插件的入口。族别判断错会连带把「不可能」误判成「排期靠后」。
7. ~~**C8（LLM 批处理网关）**~~ **已完成（2026-09-16）**：见第二节 C/D/E 组表的 C8 行。它是本组里
   唯一**不需要新进程、也不依赖新外部服务**的一项，因此被提前做掉；剩下四项的共性正是反过来：
   **C3 / C4 / C5 都要新增一个控制面进程并进入编排，C7 需要 Nebula 或等价的图 Provider 落点**
   （见 D1，仍是产品决策）。所以它们才被称为「大工程」——门槛不在代码量，在**上线面**。
8. **C3 / C4 / C5 / C7** 按业务需要单独排期，不与上面并列推进。**排序建议**：C5 先行——
   §8.4 的控制指令（pause/resume/stop/abort/approve）是**已存在语义的落地**（`architecture.md` 与
   §17.1 都把它当成既有能力在引用），而 C3/C4 是**新增的流量入口**，会把南北/东西向的信任边界
   一并放大；先把「谁有权在运行中改别人任务的状态」定清楚，再谈把流量收进统一入口。
   **（2026-09-16 状态更新）C5 已按这条建议落地**（见上表 C5 行），所以「先定控制权、再收流量」
   这一步已经走完；剩下 C3/C4/C7 的排期不受它牵制。另外这次落地**顺带暴露了一条与排序无关的事实**：
   新增控制面进程的真正成本不在服务本身，而在**七处必须同步的接线**（compose ×2、Prometheus ×2、
   告警名单、preflight 服务清单、CI matrix、Helm services、镜像清单）——其中五处是**写死的名单**，
   漏掉任何一处都各有一种独有症状（拓扑没有它 / 指标不存在 / 无告警 / 门禁不查它 / 测试永不跑 /
   发布集合缺镜像）。C3/C4 当时漏了 preflight 与镜像清单，本轮一并补齐（见
   `cluster-development-tasks.md` 的 C5 那一节）。
   **（2026-09-16 第四轮复核）这项排名已全部落地**：`C3` 边缘网关、`C4` 终端网关、`C7`
   流程血缘都已实现（见第一节对应行），因此上一条里「剩下四项……门槛在上线面」
   这句只对 `C5` 的**下发半边**仍然成立。三条与「门槛在上线面」有关的补充：
   ① **`C7` 的 Nebula 依赖被绕开了**——按 A5 的同一判据（不引入第二个存储/引擎），
   血缘事实留 PG、Nebula 降为可选呈现层，于是 `C7` 不再需要先做产品决策 `D1` 才能动，
   它也因此是本轮唯一判为**已闭合**的一项；
   ② **新增控制面进程的接线面从「七处」涨到了九处**（本轮补上 `edge-routes` 这类
   **服务专属的配置文件 + 校验器**，以及 OPA 的绑定地址），其中「服务专属配置」是新的
   一类：它不像名单那样能被静态比对，漏了只在**运行时**表现为路由 404；
   ③ **`C3`/`C4` 恰好证明了这九处必须逐点核对**：八个接线面齐全，**唯缺 Helm chart**，
   而 chart 自己的 `configmap.yaml` 却已经为 terminal-gateway 写好了 `LUMO_OPA_URL`
   ——说明缺席是漏的，不是裁剪的。两者因此判**部分闭合**，「已实现」不等于「已接线」。

---

## 口径差异（需修正的既有表述）

| 既有表述 | 实际情况 |
|---|---|
| `implementation-status.md:33`「Doris 支持日聚合 cube、Stream Load 和查询」 | 与事实不符：当时只有 HTTP 客户端、整包 0 导入（见 A5）。**已修正**——该表述已删除，Doris 投影链路于 2026-09-14 按决策移除 |
| `plugin-feature-maturity-audit.md` 称缺 `GET /effective-permissions`、`POST /permission-explain` | 已存在：`governance/internal/server/server.go:106-107`。该审计快照已过期 |
| `docs/README.md` 网关选型表列「边缘网关 / 终端网关 全栈 Go 自研」 | **已不再是差异**（2026-09-16 复核更正；此前记「两者均无实现」）：`edge-gateway` 与 `terminal-gateway` 均已落地并进编排（见 C3 / C4）。**注意这条差异的方向是反的**——别的条目是「文档写得比现实好」，这条是「文档写对了、清单记错了」 |
| `implementation-status.md:29`「Scheduler 支持 Nacos 节点目录并由 `LUMO_NACOS_ADDR` 切换」 | 属实，且**多集群调度决策已实现**（2026-09-16 复核更正；此前记「未实现」）：联邦注册表 + 两段式失联判定 + 放置闸门 + 集群维度指标 + down 后任务漂移，见 C1。偏好打分与版本一致性前置也于 2026-09-17 闭合（设计稿 §10）。**同日又闭合了分层里那件点名的事**：集群本地放置降级（见上方 C1 行与设计稿 `2026-09-17-cluster-local-placement-degradation-design.md`）。C1 至此只剩**拆进程意义上的**两个独立角色 |
| **本文首版（09-08）的 A 组与 B 组共 11 项** | **全部已闭合**（见第二节）。任何引用首版清单做排期的下游文档都应重新取数——首版把「代码完整但链路不通」列为主要风险，该风险在 09-14 已不存在 |
| **本文首版与 09-14 复核版的 E2 / E3** | **均为误读**（见第三节）。两处断言都来自 doc comment 或「谁调用了这个函数」，没有读函数体与「谁消费了这张表」。**本仓库做缺口分析时的硬性动作：凡断言「未实现」，必须同时给出「实现会出现在哪一行」的检索证据，而不是引用注释** |
| 本文 09-14 复核版称 E5「目录下只有 `package.json` 与 `__tests__/`……却仍被装配表引用」 | 前半句属实但**定性不准**（它是验证切片，不是未完成的插件），后半句才是真缺陷（登记会让启动无条件失败）。**已按新定性闭合**（见第二节 E5） |
| 本文 09-14 / 09-15 复核版 D3 条目引用的 `values.yaml` 行号 | **多处是错的**（该条目写 `productionControls`(:105)/`observability`(:120)/`dshNode`(:149)/`dshWeb`(:180)/`provisioner`(:191)，实际为 `:103`/`:105`/`:120`/`:149`/`:180`，整组错位一行）。根因是**先读文件、后改文件**：同一次会话里给 `values.yaml` 加过内容，行号就整体漂移了。**教训：引用行号前必须重取；行号只适合当「检索起点」，不适合当断言依据。** 该条目已随 D3 闭合重写，不再带行号 |
| CI 的 `LUMO_TEST_PG_DSN` 注入只覆盖 `["governance","scheduler"]` | **同一类「绿不等于证据」缺陷，2026-09-15 修掉**（D5 只修了验收脚本，CI 差一步）。该条件是 `c853dabf`(09-13) 与 PG service 一起加进来的，写时确实只有那两个模块有活库用例；到 09-15 已有 9 个模块 / 12 处门控，其余 7 个模块拿到**空串**（与未设置无法区分）→ 活库用例静默跳过而 `go test` 退 0。**不是有人把红测试关掉**，是手写枚举腐烂 —— 与本文清单本身同一种病。已改为无条件注入，并加静态守卫（DSN 不得写成 `${{ }}`、每个 Go 模块都必须在 matrix 里；`heartbeat` 此前整模块缺席，而它恰好没有 DSN 门控，所以「按症状派生」的判据抓不到它）。同时把当天新建却无人调用的 `helm-verify.sh` / `alerts-verify.sh` 接进 CI |
| 两份 compose 都写 `image: minio/minio:latest`，而本文与环境笔记此前**零记录** | **已修（2026-09-16）**：Docker Hub 已不为 `minio/minio` 提供 `latest` 标签（`pull access denied for minio/minio`）→ 对象存储起不来，而**compose 解析镜像名时不发探测请求**，所以这个错误只在 `up` 时才暴露，表现得像 MinIO 自身的配置问题。两处统一钉 `RELEASE.2025-04-22T22-12-26Z`（`test-local-pg.sh` 已实测该标签可拉）。`LUMO_LOCAL_MINIO_IMAGE` 保留，但语义从「绕开坏标签」变成「试别的版本」。**该修法已于 2026-09-20 失效，且当时的根因判断被推翻**：真正的问题从来不是 `latest` 这个标签，而是 Docker Hub 上的 `minio/minio` **仓库整体下线**（仓库 API 与 `docker pull` 双双 404）——所以「钉具体版本」只是把故障推迟了四天，同一个版本号也一起不可拉。已改为 `quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z`（MinIO 自己的分发源，实测可拉；镜像内容一致、含 cluster healthcheck 依赖的 `mc`），两处同步。**教训：`pull access denied for <repo>` 里的 `<repo>` 指的是仓库而不是标签，按「换 tag」去修等于没修——先问「这个 registry 上还有没有这个仓库」。** **同类项已于同日一并收口（2026-09-20）**：`compose.cluster.yml` 的 `hashicorp/vault:latest` 已钉 `2.1.1`——这是**逐字节冻结现状**而不是换版本（实测 `:latest`/`:2.1`/`:2.1.1` 三者 amd64 摘要同为 `sha256:8af37ae9…`），钉它的理由与上面 OPA 那条同源：`latest` 已漂到 2.1.1，相对仓库开发期的 1.x 是**跨大版本**，而凭证后端的语义漂移不报错。同批还统一了 `redis` 的跨形态漂移（standalone/local 的 `redis:7-alpine` vs cluster 的 `redis:7`，查历史是各写各的、不是取舍）。**这两类错法现在有门禁了**：`platform/deploy/compose-images-verify.sh`（同名服务跨形态必须同源 + 不得出现浮动 tag，含 11 条反例/边界，其中一条专门钉住「行内 flow 写法看不见」这个解析盲区），已接进 CI 的 `production-gates`。**顺带发现并修掉一个既有门禁的 fail-open 漏洞**：`compose-ports-check.py` 的服务名正则不认行内注释，带注释的服务名其整段 `ports:` 被当成「不在服务区内」跳过，于是**真端口冲突会被放行**（已构造实例验证：修复前退出码 0，修复后报 `port-collision`；`compose.standalone.yml` 里有 8 个这样的服务名，cluster 一个都没有） |
| 本文 09-14/09-15 两版与 `implementation-status.md:5` 的**计数互相矛盾**（21/2/8 与 18/2/11，而本文自己的表加总是 22/2/7/3） | **已修（2026-09-16）**：以**表**为准并统一为 **23/2/6/3**（C8 闭合后）。三处人工维护的计数只要有两个来源就一定会分叉——`implementation-status.md` 的 18/2/11 是把 C 组的「部分闭合」当成「未闭合」再加一次得到的。**引用计数前先把它自己加一遍**，这是本文件最便宜的一条自检 |
| 两份文档里所有「PostgreSQL integration verification pending / 本机无 PG」 | **已被推翻，且已回写（2026-09-16 复核更正；此前记「尚未回写」）**：09-15 晚的活库套件已实跑（11 个 Go 模块 714 PASS / 12 个 TS spec 113 PASS，入口 `platform/deploy/test-local-pg.sh`），09-16 又**重跑确认过一次**（scheduler **155 PASS / 0 FAIL / 0 SKIP**、TS 活库 113 PASS / 0 FAIL；`0 SKIP` 本身是断言的一部分——退出码为 0 说明不了活体用例真的跑了）。本机**有** PG 能力——它由 Docker 起，只是**Docker 守护进程默认不在跑**。所以正确的表述不是「本机跑不了」而是「需要先让守护进程起来」。**本轮实测补充**：守护进程是否在跑是**会变的**（09-16 白天 `docker ps` 报 `Cannot connect to the Docker daemon`，当晚同一条命令正常）——凡引用这个结论都要注明观测时刻 |
| 本文 `Remaining` 小节写「no Docker daemon is reachable」 | 表述不准：docker 二进制在 `/usr/local/bin/docker`（symlink 到 Docker.app），**缺的是守护进程在跑**。要按「守护进程是否启动」而不是「二进制是否存在」表述——两者混淆会让读者以为本机装的是个假 docker |
| `cluster-development-tasks.md` 第 59 行「dispatch transport and end-to-end device acceptance remain open」 | **中间那半句不准（2026-09-17 复核）**：派发**传输**已经建好——`dispatchDeviceTask` 把 Scheduler outbox 桥成不可变的 `governance_device_commands` 行（同一事务内认领 + 置 `delivered_at` + 写审计），`ClaimDeviceCommands` 经设备 mTLS WebSocket 下发，`CompleteDeviceCommand` 拥有接受/拒绝转移。真正缺的是**最后一跳**：`registry/cmd/desktop-agent/main.go:765-811` 的命令 switch 只有 `reconcile`/`start`/`stop`，`execute_task` 落到 switch 之外、以 `failed`+`command_denied` 回给网关，于是这条链路**今天保证失败**。**误判的动作是「按服务边界划缺口」**：把「控制面里有传输」与「设备端有处理器」当成同一件事，于是把已经建好的半边也算进了缺口。同一族的第二处：`desktop-devices.md:247` 写「设备命令只有 reconcile/start/stop」——那是**管理面能提交的动作**，不是设备实际会收到的动作，控制面内部会造出第四种 `execute_task`。**通则：缺口清单里凡以「服务/进程」为单位的断言，都要再问一句「这条链路的另一端那一跳谁负责」**——单侧核对会把「半边已建」误记成「整体未建」。**2026-09-17 晚：这条链路已接通**（方案 ①，设计稿 `docs/superpowers/specs/2026-09-17-device-task-result-channel-design.md`）：`completed` 仍读作「已接受」，结果走新的设备侧通道（入站类型 `task_result`），控制面新增 `RecordDeviceTaskResult` 并用命令行上的 run 身份钉死授权绑定。**本轮同时否掉了两个看起来更省事的方案**，理由值得记下来：② 把 `completed` 改读作「已完成」要动的是**已经正确、已经上线**的那半，且受 `runTaskRunner` 30s 上限牵制；只接「接受」那半则会把「立刻失败」换成「永远 RUNNING」，比现状更坏。**这条更正还带出一条方法论**：`cluster-development-tasks.md` 第 59 行此前写「dispatch transport and end-to-end device acceptance remain open」，把「传输未建」与「最后一跳未接」并成一句——**同一句话里混了「已建」和「未建」两个事实，是缺口清单最难发现的一种腐烂** |
| 本文 **2026-09-17 白天版** E7b 的排期建议称「`SessionEventMap` 是 merge-extensible 的，插件可以 `declare module` 加自己的事件类型……兼容机制是事件上的 `ignorable: true` —— **不需要改 harness**」 | **写反了（2026-09-17 晚推翻，同一日内）**。`declare module` 只让 TS 通过：它**既不会**把事件名加进**运行时生成的** `KNOWN_SESSION_EVENT_TYPES`（该文件由 `gen-persistence-catalog.ts` 扫 `deepseek-harness/packages/*/*/src/**` 生成，平台插件按构造不在其中），**也改不了** `Session.append` 造不出 `ignorable` 这件事——它的封套是 `{type, seq, time, data, ...surfaceMetadata}`，`opts` 只可能带 `surfaceOp`/`sourceEventSeqs`，**没有那个槽位**。而持久化读路径对「不认识且无 `ignorable`」的事件**拒绝整份日志**，所以照该建议实现，会让**每一个调用过连接器的会话在重载时永久打不开**。**误判的动作是只核对了链条的一段**：查了「能不能声明」（类型层）与「注释怎么说」（意图层），没查「写侧能不能把标记写出来」与「读侧认不认」。**通则：判一条跨层链路通不通，必须沿「声明 → 写入 → 持久化 → 重载」四段走完**——只查一段会得到与事实相反的结论。E7b 因此由「排期靠后」改判为**不做**（且替代路径已存在，见 E7b 行） |

# 更新日志

本文件记录本项目所有值得注意的变更。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。

## [1.0.0] - 2026-09-13

首个正式版本，收录 2026-08-23 起的全部 204 条变更。

### 版本亮点

- **分布式调度底座**：PostgreSQL fencing 租约选主（acquire/release、过期接管、并发抢占恰一胜）、
  放置事务与 outbox 原子派发、FIFO + `SKIP LOCKED` 排队认领，no-leader 时降级快速失败（503）。
- **复制式会话日志**：强一致写路径与单写者 fencing、租约生命周期、冷热分层（冷转 MinIO 段归档 +
  Redis 尾部窗口）、resume 不产生分叉、NUL 字节保真。
- **制品注册表**：内容寻址对象存储（写校验/读重校验/同 digest 幂等）、ed25519 验签与发布者 scope 上限、
  依赖闭包与安装计划（重解析原始字节执法）、MinIO/S3 适配。
- **可远程化 seam**：分级表（未定级即拒绝）与三道闸（加载期 / 服务端 / 每 turn 调用预算），
  跨节点子代理委派、`ctx.jobs` 句柄虚拟化与远程取消。
- **成本计量与台账**：`cost_type` 闭集单源化、预算三态与四态（含透支与期中调整）、
  outbox 异步削峰、RocketMQ 传输接线、Go 版 usage-ledger 服务与 Doris 聚合设计。
- **安全**：提示注入结构性防护（来源分级、工具副作用分类、污点从会话日志重算、敏感写 HITL）。
- **平台业务面**：项目工作区（并行预算树）、第五类制品 flows（状态机 + 审阅职责分离 + audience 定向）、
  知识库召回重排与离线评测、OpenAI 兼容 llm-gateway（流式背压 + 双树执法）。
- **桌面端**：Tauri 2 壳 + 自带 Node/Python 运行时，macOS（arm64/x64）与 Windows（x64）安装包，
  SkillHub 技能中心、单机版知识库（Obsidian Vault 源 + FTS5）。
- **Lumo UI**：专家 / 技能 / 市场 / 集群等 Surface，主题体系与字号刻度对齐宿主 dsh。
- **治理与部署**：control-plane（MFA/WebAuthn/破窗流程、企业 OIDC、连接器托管 OAuth）、
  Helm 模板、standalone 拓扑与 compose 冒烟、一键构建与集群验收脚本。


### 新功能（101）

- 初始化技术设计文档 (`ec0dfed3`)
- 技术架构业务产品升级 (`690b3d52`)
- scaffold platform workspace (`0c225d06`)
- **plugins**: 知识库与计量两个实际功能插件 (`c294f62d`)
- **dsh-node**: 垂直切片挂载链路打通 (`57498d2a`)
- **plugins**: embedding 接入 + 共享执行控制 + 项目工作区 (`07e2aeed`)
- **collaborator**: 知识库文档实时协作服务（§5.4.7） (`984df504`)
- **seam/connector**: SeamProxy 网络化 + 连接器网关 + GraphRAG (`2f2d3fdd`)
- **recovery**: Turn 级恢复契约与工具幂等（评审 R2） (`ba5355d0`)
- **session-log**: 复制式 SessionEvent 日志——强一致写路径 + 单写者 fencing（评审 A1） (`e3cb0dfd`)
- **mailbox**: 持久信箱与 Future/Promise seam——强制 TTL + 死信 + 对账（评审 A3） (`46b512f0`)
- **scheduler**: 设计说明——PG fencing 租约选主 + 最小放置（评审 N1） (`4a7f486c`)
- **scheduler**: 模块骨架与领域模型（domain + DDL + dispatch seam） (`08afaae2`)
- **scheduler**: PG 租约选主（acquire/release + 竞态/接管/零等待释放测试） (`79689019`)
- **scheduler**: 节点目录与过滤式放置（catalog + planner） (`52893a5a`)
- **scheduler**: 放置事务与 fencing（attempt 单飞 + outbox 原子 + 幂等重交） (`09d3cf0e`)
- **scheduler**: 排队读取与派发认领（FIFO + SKIP LOCKED） (`eee5026e`)
- **scheduler**: HTTP API 与降级快速失败（no-leader 503 + 对账占位） (`d174cd3a`)
- **scheduler**: 服务装配与双实例热备（main + Dockerfile + compose） (`caa8a5c8`)
- **provenance**: 来源分级契约与纯判决函数（评审 R5） (`1f7950fc`)
- **provenance**: 工具来源与副作用分类器（未声明 fail closed） (`b7491fca`)
- **provenance**: 污点从会话日志重算（resume 不洗白） (`530e0721`)
- **provenance**: 插件装配——tools/pre-execute 能力封闭闸 (`bec12eeb`)
- **registry**: 五类 manifest schema 与严格解析（JSON 规范格式，拒未知字段） (`9ec00144`)
- **registry**: 内容寻址对象存储——写校验、读重校验、同 digest 幂等 (`da7d33b1`)
- **registry**: ed25519 验签与发布者 scope 上限——信任根在配置不在库 (`2639ae03`)
- **registry**: PG 索引、发布事务与依赖闭包——先字节后元数据、冲突判定只留事务内一处 (`ac4f8130`)
- **registry**: 安装计划——重解析原始字节执法、身份断言、形态前移校验 (`5a994721`)
- **registry**: MinIO/S3 对象存储适配——取回时重新校验内容寻址 (`977c51e3`)
- **registry**: HTTP API 与装配——发布信封传 base64 原始字节，不重序列化 (`6d9c38fd`)
- **seam**: 可远程化分级表——未定级即拒绝，幂等性并入单一真相源 (`7ec61abf`)
- **seam-proxy**: 加载期可远程化闸——local 模式同样校验，配置放宽给运行时闸 (`1ca6aae6`)
- **seam-host**: 服务端可远程化闸——准入判据不交给调用方 (`35394282`)
- **seam-proxy**: 每 turn 调用预算——粗粒度硬规矩的执法点，默认告警可配拒绝 (`dd1c186d`)
- **metering**: cost_type 闭集与单位自洽——自由文本列撑不起「解释一次尖峰」 (`b9fce892`)
- **metering**: 成本事件单一写入者——发出方跨语言，schema 不能有第二份 (`f435f17a`)
- **metering**: 预算三态与透支——只有硬停时运维会把预算设成无穷大 (`3a23920c`)
- **metering**: 四态与期中调整进共享契约——stub 与 PG 被同一把尺子量（场景6/7） (`1b3d9ac7`)
- **metering**: PG 总额模型——旧行两态不变，新行四态可达（B2 偏离收账） (`208db789`)
- **metering**: 事件先入 usage_event_outbox——扣减与事件同事务，台账从请求路径拿掉 (`154df8a2`)
- **metering**: drainOnce 批量入账——event_key 幂等、事件时刻保真、seq 序稳定 (`cc4f0f3a`)
- **metering**: 搬运输不变式进共享契约——D1/D2 对第二个实现就位尺子 (`a268b1cf`)
- **metering**: 进程内调度器——轮询 drainOnce，失败下轮重放（sink 用例接 outbox 语义） (`baf895f7`)
- **deploy**: standalone 拓扑可启动——rocketmq namesrv+broker 单容器、nacos/minio/redis/pg + 平台服务单实例；台账列清单单源化（usage-ledger.schema.json，DDL/INSERT 同源生成） (`2cdb37a6`)
- **usage-ledger**: Go 骨架 + ledger 核心——embed 清单生成 DDL/INSERT、幂等、校验（真 PG 55432 实测 5/5 绿） (`5ce57bd6`)
- **usage-ledger**: rmq publisher+consumer——四不变式落地并真 broker 实测（e2e 3/3 绿：发布/消费/时刻保真/重放幂等/毒丸拒收）；compose 接 mqproxy gRPC；设计说明 §8 实测补记 (`1968b39b`)
- **metering**: ledgerTransport 装配开关 + usage-ledger 进 standalone 清单——published_at 列/互斥裁决/Dockerfile/topic 预建；publisher 对未建 outbox 优雅待命；e2e TestMain 清 topic（历史累积致超时的实测修正） (`9ae15b9d`)
- **contracts**: 项目工作区契约——状态机/角色能力矩阵（§11.1，N3 拍板 B） (`548f1815`)
- **projects**: §11.1 项目工作区服务——生命周期/成员角色/并行预算树种子/用量聚合；判据 1-6 真 PG 全绿（非成员 404 存在性不可泄露、最后 owner 保护、删除两层闸、台账 append-only 不因删除破例） (`7c66b9e9`)
- **deploy**: projects 进 standalone 清单（compose 冒烟全链过）；N3 拍板 B 写入 §6.4/§22/README 已定案——项目=并行预算树；metering 未初始化时创建 503（装配顺序如实暴露，不造第二 DDL） (`733a2528`)
- **contracts**: 第五类制品契约——流程状态机/DAG 防环护栏/audience 匹配（§11 后半） (`fd7da26a`)
- **flows**: 第五类制品服务——生命周期状态机/FlowReview 职责分离/audience 定向分发/版本快照回滚；防环入库护栏；面板过滤三路径 Go 统一裁决（判据 1-7 全绿） (`89772b32`)
- **deploy**: flows 进 standalone 清单（compose 冒烟全链过：建→提审→审核 v1→定向→面板过滤→自审 403）；§11 第五类制品实现注记 + README 已定案行 (`3353ce8d`)
- **llm-gateway**: 模型访问面+计量单截面跨网——OpenAI 兼容流式/非流式、费率入 provider 表、双树执法 Go 镜像（reserve 四态 402 / commit 同事务扣减+outbox）、stream_options 注入；判据 1-6 真 PG 全绿 (`e69c0247`)
- **deploy**: 网关进 standalone 清单；全链联测收账（网关→outbox→RocketMQ→台账 emitter=llm-gateway，真 broker 实测 qty=150 cost=费率精确）；§12/README 实现注记 (`72c797b5`)
- **contracts**: 对象存储 seam 契约——realm 前缀键规则(越狱拒绝)/内容寻址派生(sha256)/缺对象 undefined/能力缺失 fail-closed（§5.1） (`591f86c2`)
- **object-store**: MinIO Provider + spillStore 收敛——跨节点取回的溢出对象化（P2b 项 11）；判据 1-6 真 MinIO 全绿 (`1333f971`)
- **storage**: PG KV 后端——ctx.storage 收敛到 ctx.datastore.sql（P2b 项 12） (`3d07a3a4`)
- **attachments**: 附件 seam 契约 + MinIO Provider——ctx.attachments 对象化（P2b 项 10） (`714a79ea`)
- **session-log**: 复制日志冷链+热层——冷转 MinIO 段归档 + Redis 尾部窗口（P2a §4.2 收口，含上片滞留冷层代码） (`763ac879`)
- **web-gateway**: ctx.web 出向经连接器网关 + connector.call 计量（P2b 行 8 收口） (`4ffafb10`)
- **contracts**: 跨节点子代理委派契约——父描述/回执闭集/运行键(行 5) (`7c39a727`)
- **subagent-host**: 承载节点子代理面——公开件建子代理+单 turn 驱动+回执结集(行 5) (`4ddfe9a9`)
- **subagent-remote**: 跨节点委派 provider——Scheduler 放置+承载回执+句柄接驳(行 5) (`1ddef8a0`)
- **subagent-remote**: 行 5 切片装配与双进程冒烟——dsh-node 双角色 + 冒烟脚本(判据全绿) (`03f86f31`)
- **contracts**: ctx.jobs 句柄虚拟化契约——JobRef 映射/控制闭集/结果事件闭集(行 6) (`3b0540fc`)
- **session-log**: 构造期事件回填——session/created 补拷至 attach 边界(终审 I1) (`a3669f21`)
- **session-log**: 复制日志读面 staleness 信封——queryWithStaleness 显式 stale 不返半截(行 3) (`0632ee59`)
- **job-control**: 控制通道落地并接入远程子代理取消 (`39d413fb`)
- **workflow**: 路由 FlowEngine 扇出至远程子代理 (`e2d7211f`)
- **skills**: 校验并装配本地技能快照 (`e5c197fc`)
- **platform**: integrate clustered runtime and DSH plugins (`e26db64a`)
- **knowledge**: 兑现 §5.4.5 重排与 §5.4.4 离线召回评测 (`8b081562`)
- **platform**: Lumo 功能层落地 —— 治理鉴权、桌面壳、上游技能与 DSH 覆盖机制 (`be61708c`)
- **dsh-overrides**: 补齐上游改动的落点,并给覆盖层加回归护栏 (`b53b8b7b`)
- **control-plane**: 治理侧 MFA/WebAuthn/破窗流程、注册中心制品运行时与签名发布、观测 OTel/mTLS、连接器审批与调度抢占 (`067e006b`)
- **dsh-plugins**: 身份与 mTLS 缝合约、桌面 handoff、技能发布/灰度/流程回放代理，覆盖层与上游组件安装脚本同步 (`b4899390`)
- **deploy,desktop**: 一键构建脚本、集群验收与预检脚本、Helm mTLS/生产控制模板，桌面壳图标/DMG 打包与启动页 (`a950e8bf`)
- PPT及设计功能 (`a14430e6`)
- PPT及设计功能 (`140af3a9`)
- **desktop**: 知识库单机版（vault 源 + FTS5）与打包后启动崩溃修复 (`8ed12a24`)
- **desktop**: 单机版状态落盘修复、插件基线扩展、DeepSeek Harness 品牌与 SkillHub 真分页 (`3be60d0d`)
- **desktop**: SkillHub 安装健壮性与桌面 runtime 收尾 (`f3e9a4ab`)
- **desktop**: 完成 SkillHub 与 runtime 构建改进 (`c6aeb316`)
- **governance**: 集群设备节点治理、企业 OIDC 与连接器托管 OAuth (`2b70ae8a`)
- **cluster**: 受治理任务执行链与桌面 runtime 打包修复 (`c583cf4d`)
- 构建windows包报错 (`72f318ae`)
- 提交相关logo信息 (`3de355a1`)
- 打包功能优化 (`c81c1821`)
- 技能相关优化 (`13869df9`)
- 技能相关优化 (`f1e4e484`)
- 技能中心相关控制修改 (`7ddfe6b7`)
- 技能相关优化 (`2c90b6f6`)
- 插件市场显示错误问题 (`6911fa6a`)
- 技能相关优化 (`1cf684a2`)
- 打包处理优化 (`a747ec48`)
- windows打包失败处理 (`b7a5bb53`)
- 优化项目说明 (`47faddf7`)
- 文档说明修改 (`e558410b`)
- 集群化相关功能补充及桌面端样式优化 (`c853dabf`)
- windos构建失败处理 (`522b6534`)

### 修复（37）

- **contracts**: 控制契约断言按 correlationId 过滤——按 command 过滤会数到被拒记录 (`c36111d9`)
- **recovery**: turn 号改用 dsh 原生 turn/start——inject 会让旧计数错位致幂等键失配 (`bb392478`)
- **gitignore**: MANIFEST 锚定到根——不锚定会连带吞掉 internal/manifest 目录 (`51ce78e5`)
- **metering**: 预算扣减不再在超限时静默跳过——封顶恰在最该生效时失效 (`edb9538d`)
- **deploy**: Local-lite 换 TEI CPU 镜像、骨架补隔离项目名与 Nacos (`5cabe64c`)
- **metering**: 装配层默认预算只做种子——不再把运维配置冲回 1e9（注释与实现不符） (`7055119b`)
- **deploy**: RocketMQ topic 命名修正——真实 broker 联调发现点号非法（usage.event.* → usage-events-<cost_type>），全部引用同步；standalone 首启 chown 修复记录（卷属主 root 致 broker init 失败/日志 NPE 假象） (`22cb610d`)
- **contracts**: assert 预检 childId 运行键分隔符——runKeyOf 双封对称(评审 Important) (`4ded71fe`)
- **subagent-host**: 已结集会话重放显式 invalid + 发布前窗口语义注释锁定(评审 Important) (`48c3735f`)
- **scheduler**: domain.Placement 补 json 标签——放置回执按 API 约定输出 task_id/node_id(行 5 父侧消费面) (`f6671cd8`)
- **subagent-remote**: 回调面 per-run secret 能力段——非回环部署前的最小鉴权(评审 Important) (`04ccb811`)
- **subagent-remote**: 收账自洽——§4.1 注记不依赖在途核验 + SMOKE_KEEP 语义修正(评审 Important/Minor) (`05a875b1`)
- **subagent-remote**: 失败路径终态信号闭合(provider 回报 FAILED + host ok:false 回执)+ remote-forms 行5 收账句入格(终审 must-fix) (`3bdf52e4`)
- **contracts**: R2 turn 口径修正(turn/start 不得数 user/message)+ ctx.jobs belongsTo 重判 (`01046dd7`)
- **object-store**: spill 装配互斥显式拒绝——本地 spill 共存 fail-loud(评审遗留闭合) (`e95c7c0a`)
- **contracts**: callbackUrl 形态校验/descriptor null 拒绝/assertValidRealm 提取/空串政策统一(评审 Minor 收口) (`178678e3`)
- **subagent-host/remote**: 回执 2s 超时 + EADDRINUSE fail-fast + 测试竞态三处 + 双族注释(评审 Minor 收口) (`2d095223`)
- **subagent-remote**: smoke-parent await registerSubagentRemote——async 化回归(评审 T7 引入) (`4ec146ee`)
- **subagent-remote**: 回填写法消除 readonly 赋值 + listen 后常驻 error 监听(终审 M1/M2) (`10578347`)
- **session-log**: 首 sight 兜底补缺——firehose 首个发布事件收敛 created 时序竞态(终审 I1,冒烟判据 03 确定性 3/3)+ §4.2 注记 (`e9c127b3`)
- **session-log**: 恢复路径触发事实修正(I-1 措辞)+ created 复用 backfill() + dispose 清理 sightSeen(终审 round3) (`8756be08`)
- **session-query**: NUL 字节转义(blob 复 binary)+ stale 臂 records 夹带拒绝 + seam 守卫穿透用例 + README 枚举消歧(评审 Important/Minor) (`6c6130b6`)
- **platform**: 修平台测试套件的 19 个失败与类型检查 (`87224516`)
- **desktop**: 修复打包 runtime 插件装配并接入 fake-ip 感知 web_fetch (`6f07a577`)
- **desktop**: 注入 WKWebView toString shim 修复 dsh 内建构造函数断言 (`a2c22116`)
- **desktop**: prepare-runtime 对全新 dsh 克隆自愈构建（否则 CI 桌面 job 直接炸） (`22d74c2f`)
- **desktop**: increase dsh staging tsc heap (`96a4b76f`)
- **desktop**: 快照补齐 native/system flock binding (`60e00b7b`)
- **desktop**: Client 面类型名单补上 packages/client 之外的叶子包 (`6445b583`)
- **desktop**: 冷 dsh 树自动安装工作区依赖 (`e3b85320`)
- **desktop**: 依赖缺失时按工作区自愈重装 (`2c19a466`)
- **desktop**: 依赖自愈补上工作区状态文件 (`a06035c0`)
- **desktop**: harden Windows runtime build (`6fb6952c`)
- **desktop**: harden Windows runtime build (`8df464d2`)
- **desktop**: harden Windows runtime build (`43a64688`)
- **desktop**: harden Windows runtime build (`5ac6d37c`)
- **desktop**: harden Windows runtime build (`3375cdf6`)

### 重构（4）

- **seam**: 幂等白名单并入分级表——两张表必然漂移 (`e2f93c28`)
- **budget-policy**: limits 校验抽为 resolveLimits——判态与配置写入共用同一份 (`b15d5cb9`)
- **cost-events**: 闭集单源化——数值入 cost-types.manifest.json，TS 派生（Go 消费侧将 embed 同一文件） (`aa91cdcb`)
- **lumo-ui**: remove plugin tab from SkillHub, widen market grid (`b6d19a73`)

### 测试（3）

- **session-log**: 复制日志对真 PG 18 用例——租约生命周期(建租/续租不变 token/过期接管+1/并发抢占恰一胜)、fencing(旧持有者醒来拒/伪造 token 拒/超容差拒)、幂等与分叉(跨代重投/键序归一化)、NUL 字节保真往返、resume 端到端无分叉；raw() 测试窄口（同 pg-meter 先例） (`a589dc7c`)
- **object-store**: compose 冒烟脚本——put/get/spill 取回全链（tsx 直跑真 MinIO 19000） (`fe16b8b8`)
- **session-title**: 辅助标题调用路由收口验证——与主循环同一 ctx.llm 面(行 4) (`92678f41`)

### 文档（51）

- 分布式平台设计规范与评审意见快照 (`25e04806`)
- **scheduler**: 实现计划——8 任务 TDD 分解（评审 N1） (`28519d18`)
- **scheduler**: 选举底座决策记录与 N1 状态（§7.4.1） (`377afcba`)
- **review**: N1 落地状态——选举+fencing 闭环，降级部分闭环 (`8de112e3`)
- **security**: 提示注入防护设计——来源标记+每turn能力封闭+敏感写 HITL（评审 R5） (`006b2b7d`)
- **security**: 提示注入防护实现计划——6 任务 TDD 分解（评审 R5） (`516365b6`)
- **security**: 安全模型章节与 R5 状态（提示注入结构性防护） (`73a2d4c6`)
- **registry**: 制品注册表设计——内容寻址+签名覆盖原始字节+闭包 fail closed（评审 T1/B1） (`5b12efd6`)
- **registry**: 制品注册表 TDD 实现计划——9 个任务，核心断言是篡改 PG 不改变执法 (`29d630c2`)
- **registry**: §4.3 判定树、§6.1 职责三分修订、评审 T1/B1 落地与 Nacos 偏离记账 (`ff5175a5`)
- **registry**: 计划 9 个任务全部勾完——判据 3/4 已在活 PG 与活 MinIO 上实跑 (`cc5fffc5`)
- **seam**: 可远程化分级设计说明——未定级即拒绝，粗粒度以每 turn 预算量化（评审 R1） (`ac221455`)
- **seam**: 分级表 TDD 实现计划——三道闸，白名单里没有 dsh 原生 seam 是结论不是遗漏 (`6ef31182`)
- **seam**: §4.1 分级表与两条硬规矩、评审 R1 落地状态 (`ac8e5866`)
- **seam**: R1 计划全部勾选——三道闸与分级表已交付并核验 (`9b315e35`)
- **metering**: 成本归因设计说明与 TDD 计划——单截面是 token 的正确设计，不是成本模型 (`f1ff5c3f`)
- **metering**: §6.4 成本类型闭集与预算三态、评审 B2 落地状态 (`59672353`)
- **metering**: 总额模型设计说明与 TDD 计划——旧行两态不变，新行四态可达 (`c72591da`)
- **metering**: 总额模型落地状态——B2 偏离收账，PG 四态在执法点可达 (`230a8b97`)
- **metering**: 总额模型计划全部勾选——双模式/期初重配/期中调整已交付并核验 (`77170b22`)
- **metering**: 异步削峰设计说明 + TDD 计划——outbox 削峰、四跨传输不变式入尺子 (`9f790110`)
- **metering**: 异步削峰本地等价落地——B2 偏离①记账更新（传输仍待拓扑） (`c0dcbf66`)
- 补 §19–§22——测试验证策略/故障模式目录/SLO与容量/迁移回滚（评审 §5.3 五项待补全部收账） (`38872ee7`)
- registry 治理三件套 + seam 13 项远程形态设计——义务清单收账为设计说明 (`58ad850a`)
- **metering**: Doris 聚合设计——日分区列式 cube、PG 单向重建、桶级幂等、缺能力显式拒绝 (`f3781a13`)
- **metering**: usage-ledger Go 服务设计 + 计划——RocketMQ 传输接线（B2 偏离①收账） (`1bfe45b7`)
- **metering**: RocketMQ 传输已接线——B2 偏离①收账（Standalone 形态实测，e2e 判据 1-6 全绿；cluster HA 随 helm） (`8f846010`)
- **projects**: §11.1 项目工作区设计+计划——N3 拍板 B（项目=并行预算树）落地为项目实体/状态机/成员角色/用量聚合 (`80a73d5d`)
- **flows**: 第五类制品设计+计划——状态机/FlowReview/audience 定向分发（§11 后半，制品层不含执行） (`aea0ab5d`)
- **llm-gateway**: P2a 起始项设计+计划——模型访问面/计量单截面跨网/费率/双树执法镜像/流式背压；与 RocketMQ 计量流联测为验收判据 (`de988afd`)
- **object-store**: P2b 项 10/11 地基设计+计划——ctx.datastore.object 契约/MinIO Provider/spillStore 收敛；附件后端与 KV 收敛显式外 (`d0db7b73`)
- **object-store**: P2b 项 11 收账——spillStore 对象化 + ctx.datastore.object 落地 (`c28cb0e5`)
- **storage-pg-attachments**: P2b 项 12/10 设计+计划——PG KV 后端镜像 storage-sqlite；附件 seam 契约+MinIO Provider（真依赖 DSN 用 standalone 15432） (`e4a169ae`)
- **storage-pg-attachments**: P2b 项 10/12 收账——附件+PG KV 落地状态三处对齐 (`01cf2bdf`)
- **session-log**: P2a §4.2 冷层设计+计划——复制日志主体已落地，收冷转 MinIO 段归档 (`c7763c41`)
- **session-log/web-gateway**: 收账——architecture §4.2/§5.1/§12 + seam 远程形态行 2/8 + 冷链计划勾选 (`6a923947`)
- **subagent-remote**: 行 5 切片 1 实现计划——父描述/承载面/回执结集 (`7d6ea793`)
- **subagent-remote**: 行 5 收账——装配/冒烟/状态三处对齐 (`55a185dc`)
- **subagent-remote**: §2.2 引用补文档名(评审 Minor 5 收口) (`e8b7736e`)
- **seam-remote**: 行 6 收账——R2 状态块/A5 fork 审计/§7.1 句柄型语义/README 行 6 对齐(2026-08-27) (`712d0fe6`)
- **seam-remote**: 行 6 句管道符转义——GFM 表格裂格修复(与行 5 start|stop 同源教训) (`ced23def`)
- **session-log**: 回填切片计划——构造期事件转正(终审 I1) (`9c345dd0`)
- **p2a**: 尾巴双切片计划——行 3 staleness 信封 + 行 4 title 路由验证 (`185db7d7`)
- **seam-remote**: 行 3/行 4 收账——P2a 读面侧收官(信封装配 + title 路由验证) (`dad43ddb`)
- **knowledge**: 知识库召回质量设计 —— rerank(§5.4.5) 与离线评测(§5.4.4) (`73bbe614`)
- **build**: 一键构建入口设计 —— 12 个镜像与双架构 macOS 桌面包 (`e8eedbe7`)
- 补授权契约与插件功能成熟度审计，同步架构/配置/实施状态文档 (`f578620d`)
- **specs**: 项目切换器、左侧菜单重构与技能市场分页设计 (`a68e572e`)
- **specs**: 资料库面板缺口补齐与单机版 Obsidian Vault 知识源设计 (`405681c8`)
- **readme**: 按开源项目标准重写 README，补充赞助、许可与截图说明 (`842e0c81`)
- **readme**: 恢复六张产品推广图展示 (`0d1b3629`)

### 工程与杂项（8）

- **gitignore**: 忽略可复现装配物,未跟踪文件 13176 → 54 (`78e8154b`)
- **repo**: CI 增加生产门禁与镜像标签校验，忽略 .venv-* 目录 (`8d2e01a3`)
- **deploy**: 提交部署源脚本与 .env，修正 lib/ 误忽略 (`942b7425`)
- **repo**: README 重写、统一 MIT 协议与 push 触发自动打包 (`29703e8a`)
- build desktop packages only (`ed2f1586`)
- build desktop packages only (`40ad4537`)
- **lumo-ui**: 放大 SkillHub 市场字号与控件尺寸 (`c6d963d0`)
- Initial commit (`41dbf440`)

[1.0.0]: https://github.com/Lumonote/lumo-harness/releases/tag/v1.0.0

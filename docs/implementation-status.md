# Implementation status (2026-09-08)

配置变量与开发默认值边界见 [`configuration.md`](./configuration.md)。

> 集群模式下**代码与装配层面**的功能缺口清单见 [`cluster-gap-analysis.md`](./cluster-gap-analysis.md)（2026-09-08，含 file:line 定位）。本文记录的是外部集成边界与生产验收事项，两者互补。

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
- 知识插件支持 PG/ Milvus REST v2 向量 Provider、Nebula Graph adapter Provider；PG 源表现为版本化 source-of-truth，Lumo 的 realm 管理员可登记、查看、版本化更新、删除和安全重建来源（写入与向量/图投影意图同事务，乐观并发冲突明确返回），纯 Milvus 投影配置会明确拒绝来源管理而不伪造状态；Doris 支持日聚合 cube、Stream Load 和查询。
- 协作服务支持同镜像内的 yrs Rust 语义内核（Yjs v1 update apply/state encode/text materialize），未配置内核的本地开发才使用明确命名的确定性更新集 fallback；FlowEngine、TriggerBus、持久事件 outbox worker、自动化绑定执行、运行幂等记录和已发布快照执行 API 已加入。业务执行失败会确认原事件并保留失败账本，不会因 outbox 至少一次语义自动再跑；项目 owner/editor 可对失败记录请求一次显式重放，重放固定原事件 payload、自动化 ID 和已发布版本，重复请求幂等返回同一排队项。
- 项目控制面已开放制品/空间/自动化 CRUD 与 dashboard；自动化页可直接启停规则并执行已发布流程快照、回显本次输出（草稿和已弃用流程不可启动）；事件/Webhook 自动化的实际执行记录现由 flows 服务持久化并按项目成员权限展示（手动试运行结果仍仅在当前会话回显）。失败记录可由项目 owner/editor 从 Lumo 显式重放，并显示其父失败运行；项目成员可读取不可变的已发布流程快照，并在 Lumo 中对当前版本与其前一发布版本进行节点、算子、连线差异对比；Scheduler 的 Nacos/PG 节点目录和数据驻留硬过滤已接入。
- Milvus Provider 会校验/创建 collection，并支持配置源回放接口执行 realm 级 rebuild。
- 新增外置 `platform/dsh-plugins/lumo-ui` 平台插件包：不修改 `deepseek-harness/` 源码，通过官方 `dsh.client` 扩展机制挂载到原生 DSH AppFrame；右下角运营入口、项目/权限、流程、连接器、集群和 16 个插件能力均在同一 DSH Web 页面内展示。面板采用 React Bits 风格的渐变胶囊、Aurora/Blur Reveal/玻璃卡片与 Shiny Button 本地实现，所有上游地址和身份均由运行环境注入。控制面 CORS 由 `LUMO_CORS_ORIGIN` 环境变量注入，统一 `/metrics` 增加 HTTP 延迟 histogram。
- Passkey/WebAuthn 已在 Governance、认证代理和账户页闭环：部署必须同时配置可信 DNS RPID、RP 名称与精确 origin；注册挑战为摘要、单次消费、5 分钟过期，服务端验证 `webauthn.create/get` 的 origin、RP hash、UP/UV、none attestation、ES256/P-256 签名和凭据计数器，检测到正计数倒退时拒绝登录并写入安全审计。用户可在账户页绑定、列出及移除自己的 Passkey；登录仍须先通过一次性点选验证码与账户锁定策略。
- 连接器 OAuth 注册已形成 fail-closed manifest 契约：OAuth 连接器只能使用 Bearer access-token 引用，并提供供应商名、精确 HTTPS 授权/令牌/回调 URL、client ID/Secret 受管引用、去重 scope 与强制 PKCE。泛化网关不硬编码 SaaS 协议，也不会把凭据写进 manifest。
- 所有 HTTP 控制面入口现可选地通过 `LUMO_OTEL_COLLECTOR_URL` 向 OTLP/HTTP Collector 导出 W3C 关联的 server trace 与固定指标集。采样、指标系列硬上限和导出周期受 economy/balanced/detailed 成本策略限制；URL、查询、用户、租户和相关 ID 不作为 trace attribute 导出，超额指标/trace 均有丢弃计数。未配置时保持原有 Prometheus `/metrics` 与 W3C 传播，不猜测网络目的地。
- Seam Host/Proxy 已支持文件挂载式 mTLS：CA、节点证书与私钥均为绝对 PEM 路径；Host 强制验证客户端证书，Proxy 开启后拒绝 HTTP endpoint（包含动态发现更新）。完整 PEM bundle 默认每 30 秒检查，Host 为新连接刷新 TLS context、Proxy 为新请求刷新凭据；无效轮换保留最后一套有效 bundle，撤销/紧急回退仍需原子 Secret 更新与滚动重启。Cluster Helm 另提供默认关闭的 Istio workload mTLS：控制面、网关、DSH 子代理 start/result 通道统一 sidecar 注入、STRICT 接收和 ISTIO_MUTUAL 出站，证书由 SDS 自动签发/轮换，`denyPrincipals` 可紧急隔离受损 workload。启用仍须由实际集群提供 Istio、真实 trust domain、CA 根轮换/撤销流程和 Edge/Ingress 入口策略；HMAC runtime identity 不替代证书身份或保护已遭攻陷节点。
- 协作服务的 WAL 已改为 Redis 原子全局序列号 envelope；快照读取按状态位点过滤、裁剪按 envelope 序号执行，并修复数据库无记录与数据库故障的错误区分、文档元数据解析和 realm-scoped 权限主键。Helm 可选 DSH 节点池使用 Pod 唯一 ID + Nacos 临时注册 + HPA，支持超过两个节点/智能体。

## 有意保留的外部集成边界

这些不是源码 TODO，而是必须由目标环境提供的适配面：

1. yrs 内核在 Docker 构建阶段从 crates.io 获取依赖并作为独立进程打包；本轮已完成联网 `cargo check` 与离线 Rust 单测，仍需在发布环境完成最终镜像构建。未配置内核的本地 fallback 不提供文本语义 materialize。
2. Nebula 通过项目约定的 graph adapter HTTP 接口访问，Milvus 需要预先建好与 embedding dimension 一致的 collection；Provider 会对 realm、角色和版本字段强制过滤。
3. TriggerBus 的消费者分发仍是进程内，但事件入口、outbox claim/requeue/ack、自动化执行、失败运行的固定快照重放和运行幂等记录已在 flows 服务内闭环；跨服务事件骨干仍应由 RocketMQ 或调用方 outbox 接入。Doris 也必须由 PG replay 驱动，不能反向作为明细真相源。
4. 具体 SaaS/MCP OAuth 仍需由集成方提供供应商端点、已注册回调和 Vault 客户端凭据。托管授权页跳转、回调、token 交换、刷新及平台侧断开已接通；不伪造供应商配置或宣称已完成真实供应商联调。
5. 企业 OIDC 的代码路径已经接通，启用仍需要目标身份源、精确回调、客户端凭据及建档/停用策略。当前支持单 issuer、显式用户关联或无角色自动建档，不包含 SAML、组角色同步或 IdP 后端登出；未配置时入口保持关闭，真实环境联调仍待完成。

## 尚未达到生产验收的项目级事项

- 当前项目下的 `deepseek-harness/` 源码实际存在，只是被 `.gitignore` 忽略；Compose/Standalone 已新增从该源码构建 `platform/data-plane/dsh-node/Dockerfile` 的默认路径，也支持用 `LUMO_DSH_IMAGE` 替换为发布镜像。`preflight-deployment.sh` 现可在不启动容器的前提下校验 Docker daemon、Compose 渲染、关键服务、控制面令牌和 Registry 信任根，`--strict` 还会拒绝开发默认凭据；Cluster smoke 会先执行它。当前环境的 Docker daemon 和基础预检可用，但严格预检仍正确拒绝短/缺失身份断言密钥、开发默认密码和 Vault token，以及开发 Registry trust root；在提供非开发部署凭据与生产信任根前，尚未启动完整 Cluster，也未完成跨节点 resume、失联接管、RocketMQ/Nacos/Milvus/Nebula/OPA/Vault 联合演练。
- Scheduler 已支持可选 EDF 截止时间、加权公平队列、能力值匹配、硬反亲和和安全抢占：只有同 Realm 的高优先级等待任务在兼容节点均满时，才选择低优先级活跃任务；先将 `PREEMPT` 停止意图落账、由该任务所属执行节点确认，再标为 `CANCELLING`。新任务始终保持 `PENDING`，只会在执行节点回报终态释放槽位后由 leader drain 放置，绝不伪造“已抢占/已释放”。无 leader 时仍快速失败并保留对账路径。
- OTel 的统一 trace/metric 管道、Collector URL、采样率、系列上限与成本策略已实现；Helm 现在将正式 `collectorUrl` 注入所有控制面服务的 `LUMO_OTEL_COLLECTOR_URL`。业务级 SLO、日志/trace 留存和费用上限仍由运营方决定。可选 `productionControls.enforced` 已把 SLO 文档引用、Collector URL、留存天数和月度费用上限变为渲染期门槛并发布非敏感声明，但不替代 Collector/Loki/对象存储的实际生命周期策略。
- 控制面 Go 服务已统一使用 observability TLS helper；Standalone/Compose 可通过文件挂载启用 TLS 1.3 双向认证、CA 校验、热轮换与失败关闭。Helm 侧另有 Istio SDS 方案；真实 CA/Issuer、撤销与 Secret 挂载仍需按拓扑接入。
- Helm 可选生成 OTel Collector、Loki retention、对象存储 lifecycle 和 Prometheus recording-rules ConfigMap；Collector/Loki/S3 endpoint 与正式留存值由运营方填写后开启 `productionControls.observability.enabled`。
- 审批委托与 break-glass、租户密钥销毁和市场治理规则仍需要业务所有者与合规方的书面授权。`productionControls.enforced` 同样要求三项批准策略引用，避免缺审批却宣称生产就绪；角色、双人复核、留存、法务冻结、密钥层级、撤销、审计和真实执行工作流仍必须由相应的治理系统落实。
- governance/internal/breakglass 已提供策略无关的数据模型与内存实现：双人复核、请求过期、撤销、审计事件和状态查询；接入正式审批/密钥系统前不会自行赋予生产权限。
- Scheduler 抢占 PostgreSQL 端到端用例已在 `internal/integration/preemption_test.go`；它需要隔离的 `LUMO_TEST_PG_DSN`，当前未提供该 DSN，且本轮没有启动集群或活库。
- Cluster 联合验收入口 `platform/deploy/acceptance-cluster.sh` 已接入：它在真实 `LUMO_TEST_PG_DSN`、RocketMQ endpoint 以及 Nacos/Milvus/Nebula adapter/OPA/Vault 健康 URL 齐备后，串联 smoke、Scheduler 接管、Session resume/fencing、RocketMQ 传输与控制面集成测试；当前环境未提供这些目标依赖，故尚未取得真实多节点通过证据。

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

# 配置边界

## 读取优先级

控制面服务采用：命令行参数优先，其次是 `LUMO_*` 环境变量，最后才使用开发默认值。
产品形态必须显式选择：`local` 是 Rust 桌面单机（SQLite、无中间件），`standalone`
是服务器单例（PG/Redis/MinIO/RocketMQ/Nacos 各一份），`cluster` 是服务器集群。
Compose 和 Helm 是部署层配置，不应把生产密钥提交到仓库。

## 关键环境变量

| 范围 | 变量 | 用途 |
|---|---|---|
| 控制面 | `LUMO_PG_DSN` | PostgreSQL 连接 |
| 控制面 | `LUMO_REDIS_ADDR` / `LUMO_REDIS_URL` | Redis 地址 |
| 控制面 | `LUMO_LISTEN` | HTTP 监听地址 |
| 控制面与 DSH | `LUMO_CONTROL_PLANE_TOKEN` | 控制面 Bearer 令牌；除 `/healthz`、`/metrics` 外的接口失败关闭，DSH/Provisioner 必须使用同一 Secret |
| DSH Web | `LUMO_IDENTITY_ASSERTION_SECRET` | 身份代理 HMAC Secret（至少 32 字节）；`@lumo/user-auth` 登录成功后签发短期逐请求身份，`/lumo/api` 不回退浏览器自报身份 |
| DSH Web | `LUMO_GOVERNANCE_URL`、`LUMO_AUTH_HOST`、`LUMO_AUTH_PORT`、`LUMO_AUTH_PUBLIC_URL` | Governance 用户认证地址，以及认证代理的公开监听和规范入口地址 |
| DSH Web | `LUMO_AUTH_SECURE_COOKIE`、`LUMO_AUTH_TIMEOUT_MS` | HTTPS 部署必须启用 Secure Cookie；认证上游请求超时 |
| Governance 认证 | `LUMO_AUTH_BOOTSTRAP_USERNAME`、`LUMO_AUTH_BOOTSTRAP_PASSWORD`、`LUMO_AUTH_BOOTSTRAP_USER_ID` | 首次为 `governance_users` 用户创建本地凭据；已有凭据不会在重启时被覆盖 |
| Governance 认证 | `LUMO_AUTH_BOOTSTRAP_DISPLAY_NAME`、`LUMO_AUTH_BOOTSTRAP_DEPARTMENT`、`LUMO_AUTH_BOOTSTRAP_ROLES` | 引导用户的显示名、主部门和角色（角色逗号分隔） |
| Governance 认证 | `LUMO_AUTH_MAX_ATTEMPTS`、`LUMO_AUTH_LOCK_SECONDS`、`LUMO_AUTH_SESSION_TTL_SECONDS`、`LUMO_AUTH_CAPTCHA_TTL_SECONDS` | 连续失败锁定、会话有效期和一次性点选验证码有效期 |
| Governance MFA | `LUMO_AUTH_MFA_KEY` | 可选的 Base64 编码 32 字节 AES-GCM 密钥，用于加密保存 TOTP 密钥；生产从 Secret 注入，缺失时 MFA API 明确返回不可用，绝不回退为明文存储 |
| Governance Passkey | `LUMO_AUTH_WEBAUTHN_RP_ID`、`LUMO_AUTH_WEBAUTHN_RP_NAME`、`LUMO_AUTH_WEBAUTHN_ORIGINS` | 三项必须同时设置才启用 Passkey。`ORIGINS` 是逗号分隔的**精确** HTTPS origin，主机必须等于 RPID 或其子域；仅 localhost/127.0.0.1 开发入口允许 HTTP。缺失或不可信配置会使服务拒绝启动/接口返回不可用，绝不降级接受任意 origin。 |
| Governance Passkey | `LUMO_AUTH_WEBAUTHN_REQUIRE_USER_VERIFICATION` | 默认为 `true`；要求设备已完成本地生物识别或 PIN 用户验证。当前实现只接受 none attestation 与 ES256/P-256 凭据；需硬件证明根策略时必须在部署侧另行审批。 |
| Governance OIDC | `LUMO_AUTH_OIDC_ISSUER`、`LUMO_AUTH_OIDC_CLIENT_ID`、`LUMO_AUTH_OIDC_CLIENT_SECRET`、`LUMO_AUTH_OIDC_REDIRECT_URL`、`LUMO_AUTH_OIDC_REALM` | 必须同时设置；仅 Cluster + ready 提供企业登录。Secret 仅注入 Governance；回调固定为公开入口的 `/auth/oidc/callback`，Realm 必须与认证代理的 `LUMO_REALM` 一致。 |
| Governance OIDC | `LUMO_AUTH_OIDC_ALLOW_SIGNUP` | 默认 `false`，只允许已由管理员关联的企业身份；显式 `true` 时允许首次登录建档，不授予角色。 |
| Governance OIDC | `LUMO_AUTH_OIDC_DEPARTMENT_CLAIM`、`LUMO_AUTH_OIDC_DEFAULT_DEPARTMENT` | 可选，首次建档时读取顶层字符串声明，缺失时使用默认部门；非空部门必须已经存在于当前 Realm 且有效。后续登录不覆盖治理部门、状态或角色。 |
| Governance OIDC | `LUMO_AUTH_OIDC_ALLOW_LOOPBACK_HTTP` | 默认 `false`，要求 HTTPS；显式开启时仅允许 localhost、127.0.0.1、::1 的 HTTP 开发端点，不放宽其他地址。 |
| OTel | `LUMO_OTEL_COLLECTOR_URL` | 控制面统一的 OTLP/HTTP Collector 基址（如 `https://otel-collector.example:4318`）；设置任意 OTel 变量时此项必填，启动期校验失败关闭。 |
| OTel | `LUMO_OTEL_SAMPLE_RATIO`、`LUMO_OTEL_COST_POLICY` | 根 trace 采样率（`0..1`）与成本策略：`economy`（≤10%）、`balanced`（≤25%，默认）或 `detailed`（≤100%）。上游已采样 trace 会保留，未采样 trace 不会被本服务重新放大。 |
| OTel | `LUMO_OTEL_METRIC_CARDINALITY_MAX`、`LUMO_OTEL_METRIC_EXPORT_INTERVAL` | 全局手工 gauge 系列上限和 OTLP 指标导出周期；`balanced`/`detailed` 默认 128、30s，`economy` 为 64、1m。策略同时限制上限和最短周期；超额系列被拒绝，并输出 `lumo_observability_metric_series_dropped_total`。 |
| OTel | `LUMO_OTEL_ALLOW_INSECURE` | 仅在明确为 `true` 时允许 HTTP Collector（例如受 mTLS 保护的本机/sidecar）；默认只接受 HTTPS。 |
| 部署 | `LUMO_POSTGRES_USER`、`LUMO_POSTGRES_PASSWORD`、`LUMO_POSTGRES_DB`、`LUMO_PG_DSN` | Compose 数据库账号与连接串 |
| 本地单机 | `LUMO_DEPLOYMENT_MODE=local`、`LUMO_SQLITE_PATH` | Rust 桌面 worker 的 SQLite 文件；local 模式不会读取或连接服务器中间件 |
| 部署 | `LUMO_MINIO_ROOT_USER`、`LUMO_MINIO_ROOT_PASSWORD` | Compose 对象存储账号；Registry 使用同一组变量 |
| 部署 | `LUMO_VAULT_TOKEN`、`LUMO_CORS_ORIGIN`、`LUMO_PROMETHEUS_PORT` | 外部凭证、前端来源和观测入口 |
| 调度 | `LUMO_INSTANCE`、`LUMO_NACOS_ADDR` | 实例身份、Nacos 目录。`LUMO_INSTANCE` 同时是心跳表的实例身份；未设置时回落为 `<hostname>-<pid>`（K8s 下 hostname 即 Pod 名），Compose 各服务显式设置 |
| 调度（联邦注册表） | `LUMO_SCHEDULER_CLUSTER_ID`、`LUMO_CLUSTER_ENFORCE`、`LUMO_CLUSTER_SUSPECT_MS`、`LUMO_CLUSTER_DOWN_MS` | 本实例代表哪个集群自报存活、是否参与失联判定（三态：未设 = 由身份派生）、两段式阈值（默认 30s / 90s；`suspect < down` 是启动期硬约束，反了拒绝启动）。**没开判定就没有上报方的义务；开了则整个拓扑必须有承载节点自报**，否则闸门恒放行——`platform/deploy/cluster-registry-check.py` 专抓这个组合 |
| 调度（版本一致性前置） | `LUMO_CLUSTER_VERSION_GATE` | 三态，**默认关**（打错字报错并点名变量）。开启后**未指定 `cluster_id` 的全局放置**只落到「版本可证明一致」的集群；出现两个以上不同版本时**整体拒绝**（含等于多数版本的那些）。唯一输入是集群侧声明的 `LUMO_CLUSTER_VERSION`：无人声明时判为「无信息一致」→ 恒放行，所以开了闸门就必须有人声明 |
| 调度（偏好打分） | `LUMO_PLACEMENT_LOAD_WEIGHT`、`LUMO_PLACEMENT_AFFINITY_WEIGHT` | 两项权重，默认 `1` / `0.25`；负载项必须 > 0（0 会把放置退化成按亲和硬选）。`亲和/负载` 就是「亲和分最多能翻转多少负载比差」这条不变量的边界值，启动日志会打印。亲和项设为 0 即退回纯负载最小（也是默认权重下与旧行为的等价点） |
| dsh 节点（版本声明） | `LUMO_CLUSTER_VERSION` | 本集群节点池当前跑的组件版本——版本一致性前置的**声明方**。与存活自报同理必须是**承载节点**（说的是「跑着的那个东西是哪个版本」，调度器自己的版本是另一条发布线）。留空 = 不声明 |
| 组织治理 | `LUMO_DEPLOYMENT_MODE`、`LUMO_CLUSTER_STATUS` | `LUMO_CLUSTER_STATUS` 是**操作者意图**（「这是集群部署」），不是生效状态。仅当 `cluster` + `ready` **且**派生的健康成立时才开启用户/角色/部门、技能分发与桌面节点 API；local/standalone 返回 `CLUSTER_ONLY`（403），已声明就绪但不健康返回 `CLUSTER_NOT_READY`（503 + `Retry-After`） |
| 组织治理 | `LUMO_REQUIRED_SERVICES` | 逗号分隔的必需服务闭集，覆盖默认九个（collaborator / connector-gateway / flows / governance / llm-gateway / projects / registry / scheduler / usage-ledger）。空值表示用默认集，**不表示「什么都不要求」**；含空项或重复项会拒绝启动。Helm 由 chart 自动按已启用服务生成 |
| 组织治理 | `LUMO_HEARTBEAT_MAX_AGE_SECONDS`、`LUMO_HEARTBEAT_REFRESH_SECONDS` | 心跳过期上限（默认 45s）与就绪态重新求值周期（默认 10s）。快照超过 3 × 刷新周期即视为过期并 fail-closed |
| 组织治理 | `LUMO_HEARTBEAT_PRUNE_SECONDS` | 清理「已消失副本」心跳行的周期（默认 600s）；行按 `(service, instance)` 唯一，实例身份稳定时表是有界的 |
| 连接器 | `LUMO_OPA_ADDR`、`LUMO_OPA_POLICY`、`LUMO_VAULT_ADDR`、`LUMO_VAULT_TOKEN` | 策略与凭证 Provider |
| 连接器 OAuth | `LUMO_CONNECTOR_OAUTH_ENABLED`、`LUMO_CONNECTOR_OAUTH_CALLBACK_URL`、`LUMO_CONNECTOR_OAUTH_STATE_KEY` | 显式启用托管授权；精确 HTTPS 回调及 Base64 编码的 32 字节共享 PKCE 派生密钥，所有网关副本必须一致 |
| 连接器 OAuth | `LUMO_CONNECTOR_OAUTH_VAULT_MOUNT`、`LUMO_CONNECTOR_OAUTH_VAULT_PREFIX`、`LUMO_ADMIN_ROLES` | KV v2 挂载、令牌专用路径前缀、管理角色；默认挂载 `secret`、前缀 `lumo/connector-oauth` |
| dsh 节点 | `LUMO_ROLE`、`LUMO_NODE_ID`、`LUMO_CLUSTER_ID` | 节点角色与拓扑身份 |
| dsh 节点 | `LUMO_SUBAGENT_HOST_BIND`、`LUMO_SUBAGENT_HOST_PORT`、`LUMO_SUBAGENT_HOST_TOKEN` | 承载节点放置面 |
| dsh 节点 | `LUMO_SUBAGENT_CALLBACK_ALLOWED_ORIGINS` | 承载节点允许投递回执的精确 origin 逗号列表；回调还必须命中 `/subagent/result/{childId}/{secret}` 并与 child 同核 |
| dsh 节点 | `LUMO_SCHEDULER_URL`、`LUMO_NACOS_ADDR`、`LUMO_NACOS_SERVICE`、`LUMO_NACOS_GROUP` | 跨节点子代理路由；Nacos 优先解析自动扩容节点 |
| dsh 节点 | `LUMO_SUBAGENT_NODE_URLS`、`LUMO_SUBAGENT_HOST_TOKENS`、`LUMO_SUBAGENT_HOST_TOKEN` | 本地静态兜底/共享承载令牌；动态节点不需要重启父节点更新地址 |
| dsh 节点 | `LUMO_EMBEDDING_BASE_URL`、`LUMO_EMBEDDING_MODEL`、`LUMO_EMBEDDING_DIMENSION` | 知识库向量服务 |
| dsh 节点 | `LUMO_CONNECTOR_GATEWAY_URL` | 出站连接器网关 |
| dsh 节点 | `LUMO_REALM`、`LUMO_USER_ID`、`LUMO_PROJECT_ID`、`LUMO_USER_ROLE` | 运行身份 |
| dsh 节点 | `LUMO_SKILL_SNAPSHOT_ROOT`、`LUMO_SKILL_SNAPSHOT_FILE`、`LUMO_SKILL_SNAPSHOT_WAIT_MS` | Provisioner 已验证技能目录、快照清单和启动等待上限 |
| SkillHub 技能源 | `skillhub search/install`、`LUMO_SKILL_SNAPSHOT_ROOT`、`LUMO_SKILL_SNAPSHOT_FILE` | 通过 SkillHub 搜索、安装并验签技能，再生成 `skill-local` 启动快照；不会在运行时直接拉取远端内容 |
| DSH 基础技能 | `LUMO_ARCHIFY_ROOT` | 可选的已 provision Archify checkout；缺失时只提供 JSON-IR 工作流契约，不自动下载或执行未知 CLI；OpenDesign 的 `od` CLI 同样要求由目标工作区显式提供 |
| Provisioner | `PROVISIONER_ARTIFACT_NAME`、`PROVISIONER_ARTIFACT_VERSION` 或 `PROVISIONER_ROLLOUT_CHANNEL`、`PROVISIONER_INTERVAL`、`PROVISIONER_SHAPE`、`PROVISIONER_NODE_ID` | 要收敛的签名制品闭包及目标形态。设置通道时每轮按稳定 `node_id` 读取该制品的 0–100% 灰度目标，但仍会重新验签计划；`PROVISIONER_NODE_ID` 是向 Registry 回报实际对账状态的稳定节点标识，设置制品名后 DSH 自动读取共享快照 |
| 治理技能发布器（受保护 CI） | `GOVERNANCE_URL`、`REGISTRY_URL`、`LUMO_REALM`、`LUMO_GOVERNANCE_PUBLISHER_USER`、`LUMO_GOVERNANCE_PUBLISHER_ROLES`、`GOVERNED_SKILL_ARTIFACT_NAME`、`GOVERNED_SKILL_ARTIFACT_VERSION`、`GOVERNED_SKILL_PUBLISHER`、`GOVERNED_SKILL_PRIVATE_KEY_FILE` | `governed-skill-publisher` 仅读取 realm-admin 已发布的治理版本并构建聚合 Skill Bundle；私钥仅在此受保护发布环境出现。对应公钥和 `skills:use` scope 上限必须预先置入 `REGISTRY_TRUST_FILE`。 |
| dsh 节点 | `LUMO_NACOS_ADDR`、`LUMO_NODE_ADVERTISE_HOST`、`LUMO_NODE_CAPACITY`、`LUMO_NODE_CAPABILITIES`、`LUMO_NODE_RESIDENCY` | Nacos 临时节点注册 |
| 部署 | `LUMO_DSH_IMAGE` | Compose 使用的 dsh-node 镜像；源码来自同项目下 Git 忽略的 `deepseek-harness/` |
| Helm DSH 节点池 | `dshNode.enabled`、`dshNode.replicas` | 是否启用承载节点池、初始副本数 |
| Helm DSH HPA | `dshNode.hpa.minReplicas/maxReplicas`、`targetCPUUtilizationPercentage` | 按实际运行 CPU 负载自动扩缩节点池；可选接入队列外部指标 |
| DSH 出站代理 | `HTTP_PROXY`、`HTTPS_PROXY`（或 `ALL_PROXY`）、`NO_PROXY` | dsh CLI 在首个插件挂载前解析并安装为进程级 undici 代理策略。**只允许放在 Harness home 层 `.env`**（默认 `~/.dsh/.env`），项目目录 `.env` 会被官方拒绝并提示移入 home；`web-fetch` 走代理分支时跳过公网 IP 预检——见下方「fake-ip 代理下的 web_fetch」 |

Scheduler 的 `POST /v1/placements` 支持可选 `deadline_ms`（EDF）、`queue`/`weight`
（加权公平队列）、`requires[].value`（例如 `gpu=a100`）、`avoid_nodes`（硬反亲和）与
`preferred_clusters`（集群偏好，软约束：只在**候选排序**里加分，不会让一个不满足
`requires` 的节点被选中；未指定 `cluster_id` 时它才起作用）。不传这些字段时使用兼容
默认值；这些字段只影响调度决策，不改变多智能体 fanout 上限，
fanout 仍由请求/运行时策略决定，节点池由 Nacos + HPA 按容量动态扩展。

## fake-ip 代理下的 web_fetch（出站代理配置）

**现象**：本机代理开启 TCP 级 fake-ip（Surge 增强模式/VIF、Clash/mihomo TUN、sing-box
fake-ip）时，`web_fetch` 对一切域名失败，报
`Error: URL hostname "pi.dev" resolves to a non-public IP address`（`WEB_BLOCKED_URL`）；
harness 其余功能不受影响。上游讨论：deepseek-ai/deepseek-harness #5459。

**根因**：dsh 的 `web-fetch-http` 在连接前自行解析域名并校验每个地址均为公网单播
（SSRF 防线，`deepseek-harness/packages/web/web-fetch-http/src/network.ts` 的
`resolvePublicAddresses`/`isPublicIpAddress`，基于 ipaddr.js 的 `unicast` 判定）。fake-ip
模式由系统代理接管 DNS，按设计返回保留段应答（如 `198.18.0.0/15`、`fd00:6152::/32`），
被判为 `reserved` 而整体拒绝。插件 `Config` 只暴露尺寸/超时/UA 等字段，无放行项。

**解决（一）——出站代理（官方机制）**：dsh 为出站代理预留了校验旁路——请求经
HTTP(S) 代理时跳过本地解析与地址钉住，由代理解析源站（`web-fetch-http/src/provider.ts`
的 proxied 分支，官方注释明示「A proxied hop skips public-address resolution and
pinning: the proxy performs the origin's DNS」）。代理策略由启动环境解析：dsh CLI
在首个插件挂载前调用 `installProxyFromEnvironment`（`apps/cli/src/profile-boot.ts`），
读取 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`（来自进程环境与 home 层
`.env`）。CLI 与服务器形态沿用此机制，配置位置如下：

```dotenv
# ~/.dsh/.env  （DSH_HOME 存在时用 DSH_HOME；大小写变量均可；“幂等”于打包桌面，不设亦可）
ALL_PROXY=http://127.0.0.1:<代理的 HTTP 监听端口>
```

端点取本机代理客户端的 HTTP(S) 代理监听：Surge 需在设置中开启（默认 HTTP 6152 /
HTTPS 6153）；Clash/mihomo 混合端口默认 7890；sing-box 默认 2080。一个 `ALL_PROXY`
同时覆盖 http/https；也可分设 `HTTP_PROXY` + `HTTPS_PROXY`（https 优先取
`HTTPS_PROXY`）。注意：项目目录 `.env`（仓库内）会被官方拒绝并提示移入 home 层。

**解决（二）——打包桌面自动修复**：桌面端（local + web profile）无需用户任何配置，
由平台自动挂载 `@lumo/web-fetch-fakeip`（`platform/dsh-plugins/web-fetch-fakeip`，
dsh-node 写 patch 时装配）：

1. 复用官方公开类 `HttpFetchProvider`——其第二个构造参数正是官方公开的 resolver
   扩展点——仅替换地址预检：公网单播之外，允许可配置 CIDR 放行集（默认
   `198.18.0.0/15`（Surge/Clash 默认段）与 `fd00::/8`（sing-box ULA 段））；
2. 注册 id `lumo-fetch-fakeip`，再用官方 patch overlay 把官方 `web` 条目的
   `fetchProvider` 钉到该 id（bundle→overlay 的官方加载顺序保证覆盖生效）。

该修复只影响 web_fetch 的直连路径：回环与非公网 IP 字面量仍按上游语义拦截，
`isPublicIpAddress` 语义与上游同步；配置了出站代理时，上游 proxied 分支仍然优先。
放行段可用 `LUMO_WEB_FETCH_FAKEIP_CIDRS`（逗号分隔 CIDR）覆盖，发给只出 IPv6
fake-ip 且不在 `fd00::/8` 的客户端。服务器形态（standalone/cluster）不挂载，
保留官方严格公网预检；需要出站代理时走机制（一）。

- **CLI（开发机）**：`export ALL_PROXY=...`，或写入默认 `~/.dsh/.env`。
- `NO_PROXY` 不要写 `*`——整表豁免会把所有请求退回直连路径，再次触发同样的拦截
  （回环 `127.0.0.1`、`localhost`、`::1` 自动加入豁免，无需手工维护）。

**验证过的路由结论**（用官方策略函数实测）：`https://pi.dev` → 走代理、跳过 SSRF
预检；`http://127.0.0.1/` 与非公网 IP 字面量 → 直连路径、仍被拦截；回环自动豁免。

**边界**（如实说明）：代理之后域名解析即由可信代理完成，主机名解析到私网地址不再被
拦截——这是官方「配置了代理即信任该代理」的既定设计；回环与非公网 IP **字面量**的
拦截原样保留（直连路径仍走解析+钉住校验）。代理策略作用于整个进程（undici 全局
dispatcher），LLM 调用、搜索、MCP over HTTP 同路；需要直连的地址（如内网模型端点、
服务端内部服务）加入 `NO_PROXY` 即可。该方案是官方启动环境配置面，**升级不丢**；
相比之下修改 `isPublicIpAddress` 的临时补丁升级即被覆盖，不应采纳。

## 集群就绪（health-derived readiness）

管理面门禁不再只看声明值。`LUMO_CLUSTER_STATUS=ready` 是操作者的**意图**，实际生效状态是
「意图 AND 派生健康」。健康来自九个控制面服务写进 `lumo_service_heartbeats` 的心跳，
过期判断用数据库的 `now() - observed_at`（心跳来自多台主机，用读取方自己的时钟比会有
无界偏差）。必需服务是**闭集**：一个从未启动的服务算「缺失」，不会被静默忽略。

| 情形 | 生效状态 | 管理 API | 说明 |
|---|---|---|---|
| 非 cluster 形态 | `not_ready` | 403 `CLUSTER_ONLY` | 配置事实，重试无用 |
| cluster 但未声明 ready | `not_ready` | 403 `CLUSTER_ONLY` | 同上 |
| 已声明 ready，但必需服务缺失／心跳过期／依赖不健康 | `degraded` | **503 `CLUSTER_NOT_READY`** + `Retry-After: 15` | 会自愈；响应体带 `message`、`unready_services`、`evaluated_at` |
| 已声明 ready，且每个必需服务至少一个副本在服务 | `ready` | 放行 | 一个副本在服务即可；滚动重启不会关门 |

两个刻意的例外：**OIDC 登录**与**调度补偿循环**只看声明值。登录是修复降级集群的入口，
补偿循环是恢复机制——把它们也挂到健康上，等于在需要它们的时候先把它们关掉。

`/healthz` 在集群降级时仍返回 200：governance 正是用来诊断降级集群的服务，让它因存活探针
失败而重启循环是最糟的结果。集群就绪度通过 `/healthz` 内嵌的 `features` 块与
`GET /v1/features` 暴露（`cluster_status_declared` / `cluster_status` / `cluster_ready` /
`cluster_not_ready_reason` / `cluster_unready_services` / `cluster_readiness_evaluated_at`），
**没有** `/readyz`：把它接到负载均衡探针上会在降级期间把登录路径摘出轮转。

排障顺序：`GET /v1/features` 看 `cluster_unready_services` → 核对对应服务在
`lumo_service_heartbeats` 里的行是否过期 → 看该行 `dependencies` 的上报。
若某个服务是有意不部署的，把它从 `LUMO_REQUIRED_SERVICES` 里去掉（Helm 已自动推导）。

**UI 侧门禁仍是声明值，这是刻意的。** `lumo-ui` 的 `clusterStatus` 由启动器按
`LUMO_DEPLOYMENT_MODE` + `LUMO_CLUSTER_STATUS` 注入，回答的是「这个部署有没有集群功能」
（形态问题），不是「现在健不健康」。它因此在降级期间**比服务端宽松**：管理入口仍然可见，
点进去由服务端返回 503 并附带原因——反过来（UI 比服务端更严、把入口藏起来）会让运维
连出错原因都看不到。UI 永远不是权威，`requireCluster` 才是；`/lumo/api` 的错误路径会
透传上游状态码与响应体，所以降级原因能显示到页面上。

## LLM provider 注册表管理

`llm-gateway` 的 `llm_providers` 表决定「哪些模型可被路由、往哪转发、按什么费率计费」。
它此前只能靠运维手写 SQL 维护（E8），现在有管理面接口。**这些接口不豁免控制面鉴权**：
`cmd/llm-gateway` 把整个 mux 包在 `RequireControlPlaneToken` 里，所以除 `/healthz` 与
`/metrics` 外一律需要 `Authorization: Bearer $LUMO_CONTROL_PLANE_TOKEN`。

| 方法与路径 | 作用 | 成功 | 失败 |
|---|---|---|---|
| `GET /v1/providers` | 列出全部 provider，**含已停用行** | 200 `{"providers":[…]}` | 500 |
| `GET /v1/providers/{model}` | 读单个 | 200 | 404 `provider_not_found` |
| `PUT /v1/providers/{model}` | 建或改（幂等） | 200（回读该行） | 400 `invalid_model` / `invalid_body` / `invalid_provider` |
| `DELETE /v1/providers/{model}` | 物理删除 | 204 | 404 `provider_not_found` |

**写入语义：除 `model` 外每个字段都是可选的，省略 = 保持原值。** 一条规则覆盖全部字段。

- 对 `apiKey` 这是**强制**的：密钥读不回来（响应里只有 `apiKeySet` 布尔），任何
  「先 GET 再把读到的内容 PUT 回去」的客户端都会把它清掉。显式给 `""` 才会清除——清除有出口。
- 对 `upstreamBaseUrl` 同样是必需品：摘掉一个模型只需 `{"enabled": false}`，
  若基址必填这一步就退化成读改写。**省略只在改已有行时成立**，新建行必须给出（列是
  `NOT NULL`，由库一条语句原子判定，另发存在性查询会引入「查完被删」的竞态）。
- 路径是模型名的权威来源；body 里若也写了 `model`，必须与路径一致，否则 400。
- 模型名可以含斜杠（`openai/gpt-4`），路由用多段通配符承载。

```bash
# 注册一个新模型（含密钥与费率）。:8088 是 llm-gateway 的 LUMO_LISTEN
curl -X PUT http://llm-gateway:8088/v1/providers/gpt-4o \
  -H "Authorization: Bearer $LUMO_CONTROL_PLANE_TOKEN" \
  -d '{"upstreamBaseUrl":"https://api.example.com/v1","apiKey":"sk-…","priceInPerMtok":3,"priceOutPerMtok":15}'

# 摘出路由（保留费率与密钥，可随时恢复）
curl -X PUT http://llm-gateway:8088/v1/providers/gpt-4o \
  -H "Authorization: Bearer $LUMO_CONTROL_PLANE_TOKEN" -d '{"enabled":false}'
```

**为什么停用行必须可见**：看不见就没人能把它重新启用。`enabled` 是响应里的一个字段，
不是列表的过滤条件。注意路由面读的是「启用行」——停用的模型对 `POST /v1/chat/completions`
表现为 404 `unknown_model`，与「根本没注册过」不可区分，这是对 OpenAI 兼容客户端的既定契约。

**为什么删除是物理删除、而停用是常规手段**：停用保留费率与启用历史；删除只该用于
「这行本来就录错了」。删掉行不会让历史账目失去依据（计费事件存 `costUsd` 快照，不是
指向本表的外键），但会失去「当时按什么费率算的」这个解释——所以删除必须是显式动作。

`upstreamBaseUrl` 校验与 flows 算子上游、dsh-node seam endpoint 同一套判据：必须
`http`/`https`，不得带 userinfo、查询串或片段（带 userinfo 会把凭据写进日志；
带 query 说明作者把它当成了完整 URL，而网关是在它后面拼 `/v1/chat/completions` 的）。
只 trim 首尾空白，不做别的归一：拼接处已经 `TrimRight(BaseURL,"/")`，而 `/v1` 这类
路径前缀是上游的真实形态，替运维改写会改出错误地址。

## 连接器审计查询

`connector-gateway` 把每一次外部调用（放行与拒绝都写）落在 PG `connector_audit`。
这张表此前**只有写没有读**（E7）：要回答「这个会话到底对外调了什么」只能上生产 `psql`。
现在有查询面。与其它管理面一样，整个 mux 包在 `RequireControlPlaneToken` 里。

| 方法与路径 | 作用 |
|---|---|
| `GET /audit` | 分页读取审计，按 `id` 倒序（最新在前） |

| 查询参数 | 说明 |
|---|---|
| `sessionId` | 按会话过滤（走 `idx_connector_audit_session`） |
| `connectorId` | 按连接器过滤 |
| `decision` | `allowed` 或 `denied`；**其它取值一律 400** |
| `beforeId` | keyset 游标：只取 `id < beforeId`。用上一页返回的 `nextBeforeId` |
| `limit` | 页大小，缺省 50、上限 200（超上限收敛，不报错） |
| `all` | `true`/`1` 时看整个 realm，**需要管理员角色** |

```bash
# 我自己在这个会话里被拒绝的调用
curl -G http://connector-gateway:8081/audit \
  -H "Authorization: Bearer $LUMO_CONTROL_PLANE_TOKEN" \
  -H "X-Lumo-User: u1" -H "X-Lumo-Realm: r1" -H "X-Lumo-Roles: operator" \
  --data-urlencode sessionId=s1 --data-urlencode decision=denied

# 管理员看整个 realm，并翻到下一页
curl -G http://connector-gateway:8081/audit \
  -H "Authorization: Bearer $LUMO_CONTROL_PLANE_TOKEN" \
  -H "X-Lumo-User: admin" -H "X-Lumo-Realm: r1" -H "X-Lumo-Roles: admin" \
  --data-urlencode all=true --data-urlencode beforeId=1234
```

**realm 只来自身份头。** 请求里带 `?realm=` 会被**忽略**，不是被采纳——
realm 决定能看见哪些调用，自报即越权。这条由测试钉住，避免日后有人「顺手支持」它。

**非管理员缺省只看自己的调用**，`all=true` 需要管理员角色（与 `/approvals` 的
`approval.List(ctx, realm, requester, all)` 同一约定）。审计行带 `target_host` 与
`operation`，跨用户可见性属管理能力；越权请求在**触达数据层之前**就被拒。

**未知的 `decision` 报 400，不会退化成「不过滤」。** 这是刻意的：`?decision=denyed`
若被静默忽略，一次「只看被拒绝的调用」的合规查询会返回全部调用——结果集被悄悄放大，
比报错危险得多。审计面的过滤值一律 fail-closed。

**排序键与游标键都是 `id`，不是 `created_at`。** `created_at` 取的是事务开始时刻，
`id` 取的是 INSERT 时刻，并发下两者会不一致（先开始的事务可能后插入）。用一个排序、
拿另一个翻页会漏行或重行。翻页用 keyset（`beforeId`）而非 offset：这张表只增，
offset 窗口会被翻页期间的新写入冲掉。

**返回体**：`{"entries":[…],"nextBeforeId":0}`。`nextBeforeId` 为 0 表示已到末页。
空结果是 `[]` 而不是 `null`（`null` 会让客户端 `.map` 直接抛）。条目**不含请求体与
响应体**——表里本来就没存（§15 数据最小化），所以这里没有「要不要脱敏」的决策；
`redactions` 是脱敏**计数**，不是内容。也不含 `projected_at`：那是投影进度簿记，
而投影器尚未落地（见 `cluster-gap-analysis.md` E7b），此时暴露它只会让人以为时间线已经存在。

**未配置审计读取面时返回 503，不是空列表**——「查不到」与「没配」必须能分开。
数据层错误只回通用消息，细节进日志：SQL 错误里可能带 realm 与查询条件。

## 企业 OIDC 登录

Governance 支持 Authorization Code + S256 PKCE，验证发现文档的精确 issuer、
ID Token 的 RS256/ES256 签名、audience、azp、nonce 和时间声明。支持
`client_secret_basic` 与 `client_secret_post`。当前为每个部署配置一个身份源和 Realm，
尚不支持 SAML、多身份源选择、组到角色映射或 IdP 后端登出。

生产配置示例中的域名和 ID 必须替换为目标环境值，客户端密钥由 Secret 注入：

```dotenv
LUMO_DEPLOYMENT_MODE=cluster
LUMO_CLUSTER_STATUS=ready
LUMO_REALM=company
LUMO_AUTH_PUBLIC_URL=https://lumo.example.com
LUMO_AUTH_SECURE_COOKIE=true
LUMO_AUTH_OIDC_ISSUER=https://identity.example.com/realms/company
LUMO_AUTH_OIDC_CLIENT_ID=lumo
LUMO_AUTH_OIDC_REDIRECT_URL=https://lumo.example.com/auth/oidc/callback
LUMO_AUTH_OIDC_REALM=company
LUMO_AUTH_OIDC_ALLOW_SIGNUP=false
```

在 IdP 为该客户端登记相同的精确回调，并注入 `LUMO_AUTH_OIDC_CLIENT_SECRET`。
`LUMO_AUTH_PUBLIC_URL` 必须为根路径的完整公开 origin。Compose Cluster 已透传这些
变量；其他部署方式需给 Governance 和认证代理分别注入对应变量，保持各副本配置一致。
未配置时不显示企业登录；部分配置会使 Governance 拒绝启动。HTTPS 入口未启用
Secure Cookie，或两个服务的回调配置不一致时，也不会显示企业登录。

默认关闭自动建档。管理员可在组织管理中为已有用户关联 IdP 的不可变 `sub`；
也可先通过 `PUT /v1/users/{userID}` 建立无本地密码的治理目录用户，再调用
`PUT /v1/users/{userID}/oidc`，请求体为 `{"subject":"实际的企业用户 sub"}`。
这些接口均要求经过验证的同 Realm 管理员身份，浏览器应使用对应 `/lumo/api` 代理。
不会按邮箱或用户名自动合并账号。一个用户只关联一个企业身份，已有关联不会被隐式替换
或移给其他用户；解除后可恢复同一关联。

开启自动建档前，应在 IdP 端限制可访问该应用的人群。首次建档创建无本地密码、无角色的
独立治理用户；显示名和初始部门来自配置允许的声明，角色随后由管理员授予。
已停用用户或已解除的企业身份不会被自动重新激活。解除关联保留禁用记录，并撤销该用户的
OIDC 会话。管理员检查同时保护最后一个有效管理员、长期授权和已有本地管理员恢复入口。

登录事务在 PostgreSQL 保存 5 分钟，绑定浏览器随机 Cookie 和配置指纹，回调只能消费一次。
临时 Cookie 使用 HttpOnly + SameSite=Lax 以接收 IdP 回跳；完成后清除临时 Cookie，
签发原有 SameSite=Strict 会话。会话期限取平台 TTL 与 ID Token 到期时间的较早值。
用户停用、关联解除和会话撤销按现有集群身份检查生效；关闭或更换 issuer/Realm 后，
原 OIDC 会话也不再通过校验。

企业登录的 MFA 和登录访问策略由 IdP 执行，本地 TOTP/Passkey 不叠加到 OIDC 回调。
纯企业账号的账户页不显示本地密码和验证器设置。平台退出只撤销平台会话，不退出 IdP
的 SSO 会话；尚未接入 IdP 主动停用通知或 SCIM 同步，IdP 单侧停用不会立即撤销已签发
的平台会话，需等待到期或同步停用治理用户。

当前完成源码接入和静态检查，按既有约定暂缓运行测试与真实 IdP、数据库和浏览器联调。

## 连接器托管 OAuth

2026-09-08 新增显式托管模式。旧清单不含 `managed: true` 时继续使用外部维护的
access-token 引用。托管模式沿用 Realm 共享连接器语义，只有网关 `AdminRoles` 中的
管理员能发起授权、查看状态、手动续期或断开；令牌仅在网关向上游发起调用时使用。

网关需设置 `LUMO_CONNECTOR_OAUTH_ENABLED=true`、Vault 地址/token、32 字节 Base64
`LUMO_CONNECTOR_OAUTH_STATE_KEY`，以及 `LUMO_CONNECTOR_OAUTH_CALLBACK_URL`，例如
`https://lumo.example.com/auth/connector-oauth/callback`。公开认证代理必须配置相同 origin
的 `LUMO_AUTH_PUBLIC_URL`、`LUMO_AUTH_SECURE_COOKIE=true`，且部署为 Cluster + ready。
Compose 已透传配置；Helm 使用 `connectorOAuth`，共享密钥取自 `stateKeySecret` 的
`stateKeyKey`。Helm 的 Governance 认证配置可通过 `governance.authSecret` 注入
`LUMO_AUTH_*` 变量，DSH 入口使用 `dshWeb.publicUrl`、`secureCookie` 和 `governanceUrl`。

连接器的 `auth` 示例，供应商端点、scope 和客户端引用应替换为实际注册值：

```json
{
  "kind": "bearer",
  "credentialRef": "oauth:managed",
  "oauth": {
    "managed": true,
    "provider": "company-api",
    "authorizationUrl": "https://identity.example.com/oauth/authorize",
    "tokenUrl": "https://identity.example.com/oauth/token",
    "callbackUrl": "https://lumo.example.com/auth/connector-oauth/callback",
    "clientIdRef": "secret/data/company-client#client_id",
    "clientSecretRef": "secret/data/company-client#client_secret",
    "clientAuthMethod": "client_secret_basic",
    "scopes": ["read"],
    "pkce": true
  }
}
```

`clientAuthMethod` 支持 `client_secret_basic`（默认）和 `client_secret_post`，不会在失败后
换认证方式重试一次性授权码。可选 `authorizationParams` 只接受 `access_type`、`prompt`、
`audience`、`resource`。授权和令牌端点也须出现在连接器 `egress.allowedHosts` 中；管理者
的角色同时须满足连接器策略。OAuth 请求复用网关 DNS/私网保护、拒绝重定向和 OPA 策略。

Vault 需要预先存在 KV v2 挂载。客户端引用兼容 KV v1/v2；新令牌只写 KV v2 的
`<mount>/data/<prefix>/<realm+connector 的 SHA-256>/<generation>`，网关需该子树
`create/read` 权限及对应 `metadata` 子树的 `delete` 权限。manifest 不能指定令牌写入路径，
PostgreSQL 和审计不存 access token、refresh token 或客户端秘密。

授权事务有效期 5 分钟，绑定浏览器、当前会话、管理员及连接器版本。认证代理的临时
HttpOnly Lax Cookie 使用现有身份断言密钥派生的 AES-GCM 密钥加密，回调重新读取
Governance 的当前会话和角色；原 Strict 会话 Cookie 保持原语义。

每次交换/刷新先持久化独立操作代际，再执行一次供应商请求。令牌临近到期会在调用时续期，
旋转后的 refresh token 同 access token 一起写入新的 Vault 路径，再原子切换当前指针。
90 秒内未完成的操作、配置版本变化或供应商拒绝要求重新授权；不会重试可能已被消费的
refresh token。并发修改和断开后的旧回调不能恢复连接。

断开立即清除平台使用资格并取消未完成授权。旧 Vault 路径会由每分钟维护任务删除所有
KV 版本，首次写入保留至少 10 分钟缓冲以覆盖中断中的写请求；依赖故障时持续重试。
这里是平台侧断开，不撤销供应商账户中的应用授权；供应商侧撤销应在其授权管理入口操作。
真实供应商配置和运行联调仍由目标环境提供，本次按要求不执行运行测试。

## 治理技能运行时发布

### 从 SkillHub 搜索并安装技能

技能市场直接集成 [SkillHub](https://skillhub.cn) 的技能、专家包与插件目录。UI 中的安装操作通过以下流程实现：

1. **目录加载**：启动时从 `https://api.skillhub.cn` 拉取实时目录（技能、专家包、插件），离线或失败时回退到内置的种子目录
2. **安装流程**：
   - 优先尝试调用本地的 `skillhub` CLI（当 `skillhubCommand` 配置非空且 CLI 可执行时）
   - CLI 不可用时，执行原生安装：通过 `/api/v1/download?slug=<slug>` 下载 zip，安全解压到 `<skillhubRoot>/<slug>/`（拒绝绝对路径和 `..` 遍历），验证 `SKILL.md` 的 frontmatter `name` 与目录名一致，计算 `sha256` 摘要
   - 专家包安装：下载 `/api/v1/skillsets/<slug>/download`，解析 `manifest.json` 获取子技能列表，递归安装每个子技能
   - 插件（GitHub 仓库）仅记录已安装状态，不实际克隆到技能根目录
3. **快照更新**：每次安装后，将 `<skillhubRoot>/` 下所有技能的 `{name, sha256, description}` 写入 `skillhubSnapshotFile`（默认 `.lumo/skill-snapshot.json`），供 `skill-local` 插件启动时验证；未列入快照的目录会导致 `skill-local` 启动失败（`unpinned entry in snapshot root`）
4. **配置项**：
   - `skillhubCatalogFile`（默认 `.lumo/skillhub-catalog.json`）：缓存的目录文件
   - `skillhubInstallFile`（默认 `.lumo/skillhub-installs.json`）：已安装项目的记录
   - `skillhubRoot`（默认 `.lumo/skills`）：技能安装根目录
   - `skillhubCommand`（默认 `'skillhub'`）：SkillHub CLI 命令名或路径，留空则仅使用原生安装
   - `skillhubApiBase`（默认 `https://api.skillhub.cn`）：SkillHub API 基础 URL
   - `skillhubSnapshotFile`（默认 `.lumo/skill-snapshot.json`）：skill-local 快照文件路径

**安全约束**：UI 安装操作不允许模型或 Web 请求直接调用 `skillhub install` 命令。生产环境应由 Provisioner 将 SkillHub 内容重新包装成受信任的 Registry Bundle，通过治理流程发布后再下发到数据节点；`skill-local` 的不可变快照机制确保运行时不会加载未经验证的技能。

CLI 安装方式（仅供本地开发参考）：

```sh
# 安装 SkillHub CLI（可选；UI 不依赖它）
curl -fsSL https://skillhub-1388575217.cos.ap-guangzhou.myqcloud.com/install/install.sh | bash -s -- --cli-only

# 搜索技能
skillhub search "网页搜索"

# 安装技能到指定目录
skillhub install websearch --dir .lumo/skills

# 生成快照（skill-local 需要）
node -e "
const { readdirSync, readFileSync, writeFileSync, statSync } = require('fs');
const { join } = require('path');
const { createHash } = require('crypto');
const root = '.lumo/skills';
const entries = readdirSync(root, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .map(d => {
    const skillMdPath = join(root, d.name, 'SKILL.md');
    const content = readFileSync(skillMdPath, 'utf8');
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    const descMatch = content.match(/^description:\s*(.+)$/m);
    const sha256 = 'sha256:' + createHash('sha256').update(content, 'utf8').digest('hex');
    return { name: nameMatch[1].trim(), sha256, description: descMatch ? descMatch[1].trim() : '' };
  });
writeFileSync('.lumo/skill-snapshot.json', JSON.stringify(entries, null, 2) + '\n');
"

# 启动节点，指向快照
LUMO_SKILL_SNAPSHOT_ROOT="$PWD/.lumo/skills" \
LUMO_SKILL_SNAPSHOT_FILE="$PWD/.lumo/skill-snapshot.json" \
pnpm --filter @lumo/dsh-node start -- --profile headless
```

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
| OTel | `LUMO_OTEL_COLLECTOR_URL` | 控制面统一的 OTLP/HTTP Collector 基址（如 `https://otel-collector.example:4318`）；设置任意 OTel 变量时此项必填，启动期校验失败关闭。 |
| OTel | `LUMO_OTEL_SAMPLE_RATIO`、`LUMO_OTEL_COST_POLICY` | 根 trace 采样率（`0..1`）与成本策略：`economy`（≤10%）、`balanced`（≤25%，默认）或 `detailed`（≤100%）。上游已采样 trace 会保留，未采样 trace 不会被本服务重新放大。 |
| OTel | `LUMO_OTEL_METRIC_CARDINALITY_MAX`、`LUMO_OTEL_METRIC_EXPORT_INTERVAL` | 全局手工 gauge 系列上限和 OTLP 指标导出周期；`balanced`/`detailed` 默认 128、30s，`economy` 为 64、1m。策略同时限制上限和最短周期；超额系列被拒绝，并输出 `lumo_observability_metric_series_dropped_total`。 |
| OTel | `LUMO_OTEL_ALLOW_INSECURE` | 仅在明确为 `true` 时允许 HTTP Collector（例如受 mTLS 保护的本机/sidecar）；默认只接受 HTTPS。 |
| 部署 | `LUMO_POSTGRES_USER`、`LUMO_POSTGRES_PASSWORD`、`LUMO_POSTGRES_DB`、`LUMO_PG_DSN` | Compose 数据库账号与连接串 |
| 本地单机 | `LUMO_DEPLOYMENT_MODE=local`、`LUMO_SQLITE_PATH` | Rust 桌面 worker 的 SQLite 文件；local 模式不会读取或连接服务器中间件 |
| 部署 | `LUMO_MINIO_ROOT_USER`、`LUMO_MINIO_ROOT_PASSWORD` | Compose 对象存储账号；Registry 使用同一组变量 |
| 部署 | `LUMO_VAULT_TOKEN`、`LUMO_CORS_ORIGIN`、`LUMO_PROMETHEUS_PORT` | 外部凭证、前端来源和观测入口 |
| 调度 | `LUMO_INSTANCE`、`LUMO_NACOS_ADDR` | 实例身份、Nacos 目录 |
| 组织治理 | `LUMO_DEPLOYMENT_MODE`、`LUMO_CLUSTER_STATUS` | 仅 `cluster` + `ready` 开启用户/角色/部门、技能分发与桌面节点 API；local/standalone 显式返回 `CLUSTER_ONLY` |
| 连接器 | `LUMO_OPA_ADDR`、`LUMO_OPA_POLICY`、`LUMO_VAULT_ADDR`、`LUMO_VAULT_TOKEN` | 策略与凭证 Provider |
| dsh 节点 | `LUMO_ROLE`、`LUMO_NODE_ID`、`LUMO_CLUSTER_ID` | 节点角色与拓扑身份 |
| dsh 节点 | `LUMO_SUBAGENT_HOST_BIND`、`LUMO_SUBAGENT_HOST_PORT`、`LUMO_SUBAGENT_HOST_TOKEN` | 承载节点放置面 |
| dsh 节点 | `LUMO_SUBAGENT_CALLBACK_ALLOWED_ORIGINS` | 承载节点允许投递回执的精确 origin 逗号列表；回调还必须命中 `/subagent/result/{childId}/{secret}` 并与 child 同核 |
| dsh 节点 | `LUMO_SCHEDULER_URL`、`LUMO_NACOS_ADDR`、`LUMO_NACOS_SERVICE`、`LUMO_NACOS_GROUP` | 跨节点子代理路由；Nacos 优先解析自动扩容节点 |
| dsh 节点 | `LUMO_SUBAGENT_NODE_URLS`、`LUMO_SUBAGENT_HOST_TOKENS`、`LUMO_SUBAGENT_HOST_TOKEN` | 本地静态兜底/共享承载令牌；动态节点不需要重启父节点更新地址 |
| dsh 节点 | `LUMO_EMBEDDING_BASE_URL`、`LUMO_EMBEDDING_MODEL`、`LUMO_EMBEDDING_DIMENSION` | 知识库向量服务 |
| dsh 节点 | `LUMO_CONNECTOR_GATEWAY_URL` | 出站连接器网关 |
| dsh 节点 | `LUMO_REALM`、`LUMO_USER_ID`、`LUMO_PROJECT_ID`、`LUMO_USER_ROLE` | 运行身份 |
| dsh 节点 | `LUMO_SKILL_SNAPSHOT_ROOT`、`LUMO_SKILL_SNAPSHOT_FILE`、`LUMO_SKILL_SNAPSHOT_WAIT_MS` | Provisioner 已验证技能目录、快照清单和启动等待上限 |
| DSH 基础技能 | `LUMO_ARCHIFY_ROOT` | 可选的已 provision Archify checkout；缺失时只提供 JSON-IR 工作流契约，不自动下载或执行未知 CLI；OpenDesign 的 `od` CLI 同样要求由目标工作区显式提供 |
| Provisioner | `PROVISIONER_ARTIFACT_NAME`、`PROVISIONER_ARTIFACT_VERSION` 或 `PROVISIONER_ROLLOUT_CHANNEL`、`PROVISIONER_INTERVAL`、`PROVISIONER_SHAPE`、`PROVISIONER_NODE_ID` | 要收敛的签名制品闭包及目标形态。设置通道时每轮按稳定 `node_id` 读取该制品的 0–100% 灰度目标，但仍会重新验签计划；`PROVISIONER_NODE_ID` 是向 Registry 回报实际对账状态的稳定节点标识，设置制品名后 DSH 自动读取共享快照 |
| 治理技能发布器（受保护 CI） | `GOVERNANCE_URL`、`REGISTRY_URL`、`LUMO_REALM`、`LUMO_GOVERNANCE_PUBLISHER_USER`、`LUMO_GOVERNANCE_PUBLISHER_ROLES`、`GOVERNED_SKILL_ARTIFACT_NAME`、`GOVERNED_SKILL_ARTIFACT_VERSION`、`GOVERNED_SKILL_PUBLISHER`、`GOVERNED_SKILL_PRIVATE_KEY_FILE` | `governed-skill-publisher` 仅读取 realm-admin 已发布的治理版本并构建聚合 Skill Bundle；私钥仅在此受保护发布环境出现。对应公钥和 `skills:use` scope 上限必须预先置入 `REGISTRY_TRUST_FILE`。 |
| dsh 节点 | `LUMO_NACOS_ADDR`、`LUMO_NODE_ADVERTISE_HOST`、`LUMO_NODE_CAPACITY`、`LUMO_NODE_CAPABILITIES`、`LUMO_NODE_RESIDENCY` | Nacos 临时节点注册 |
| 部署 | `LUMO_DSH_IMAGE` | Compose 使用的 dsh-node 镜像；源码来自同项目下 Git 忽略的 `deepseek-harness/` |
| Helm DSH 节点池 | `dshNode.enabled`、`dshNode.replicas` | 是否启用承载节点池、初始副本数 |
| Helm DSH HPA | `dshNode.hpa.minReplicas/maxReplicas`、`targetCPUUtilizationPercentage` | 按实际运行 CPU 负载自动扩缩节点池；可选接入队列外部指标 |

Scheduler 的 `POST /v1/placements` 支持可选 `deadline_ms`（EDF）、`queue`/`weight`
（加权公平队列）、`requires[].value`（例如 `gpu=a100`）和 `avoid_nodes`（硬反亲和）。
不传这些字段时使用兼容默认值；这些字段只影响调度决策，不改变多智能体 fanout 上限，
fanout 仍由请求/运行时策略决定，节点池由 Nacos + HPA 按容量动态扩展。

## 治理技能运行时发布

Governance 的“发布为运行时源”只固定审核过的不可变版本；它不把未签名的数据库内容直接送到节点。受保护的 CI/发布主机使用 `governed-skill-publisher` 导出该 realm 的全部已发布版本、复核每个源摘要与 `SKILL.md` frontmatter，并生成一个普通 Registry `Skill` Bundle：

```sh
cd platform/control-plane/registry
go run ./cmd/governed-skill-publisher \
  --governance "$GOVERNANCE_URL" --registry "$REGISTRY_URL" \
  --realm "$LUMO_REALM" --user "$LUMO_GOVERNANCE_PUBLISHER_USER" --roles realm_admin \
  --artifact "$GOVERNED_SKILL_ARTIFACT_NAME" --version 0.0.1 \
  --publisher "$GOVERNED_SKILL_PUBLISHER" --private-key "$GOVERNED_SKILL_PRIVATE_KEY_FILE" \
  --scope skills:use
```

该命令的私钥必须属于 `REGISTRY_TRUST_FILE` 中已配置、且最大 scope 包含 `skills:use` 的发布者。然后像任意制品一样将该精确版本设为 Stable（或灰度）目标，并使节点以该 artifact name 和 rollout channel 持续运行 Provisioner；只有 Provisioner 验签并原子写入 `/var/lib/lumo/artifacts/skills` 与 `skill-snapshot.json` 后，DSH 才会加载它。空的已发布目录同样会生成含元数据的 Bundle，从而可在下一轮对账中撤回原有本地技能。

## 外部身份与 OAuth 注册

Passkey 的 RPID/origin 是浏览器安全边界，不从 `Host`、反向代理头或用户输入推导。部署必须先
确定公开身份域，再把相同的精确 origin 配入 `LUMO_AUTH_WEBAUTHN_ORIGINS`。用户只能在已认证的
账户页新增/删除自己的凭据；挑战仅保存摘要、5 分钟过期且单次消费，服务端检查 RP hash、UP/UV、
P-256 签名与单调计数器。

连接器的 OAuth 注册写入 Connector manifest 的 `auth.oauth`。通用网关只接受以下边界：Bearer
access-token 的受管引用、具体供应商名称、精确 HTTPS 授权/令牌/回调 URL、客户端 ID/Secret
引用、非空且去重的 scope 以及 `pkce: true`。例如：

```json
{
  "auth": {
    "kind": "bearer",
    "credentialRef": "secret/data/acme/access-token",
    "oauth": {
      "provider": "Acme SaaS",
      "authorizationUrl": "https://login.acme.example/authorize",
      "tokenUrl": "https://login.acme.example/token",
      "callbackUrl": "https://lumo.example/oauth/callback/acme",
      "clientIdRef": "secret/data/acme/client-id",
      "clientSecretRef": "secret/data/acme/client-secret",
      "scopes": ["items.read"],
      "pkce": true
    }
  }
}
```

这些字段是注册期校验契约，不会把 client secret、refresh token 或第三方令牌写入 manifest、审计或
日志。授权码回调、token 交换/轮换以及企业 IdP 登录必须绑定实际 IdP/SaaS 的 issuer、已注册回调
和受管凭据存储后才能启用；仓库不会猜测供应商或凭据生命周期。

## PostgreSQL 抢占端到端测试

Scheduler 的 `internal/integration/preemption_test.go` 已覆盖“高优先级任务只能在低优先级任务报告
终态释放名额后放置”的真实 PostgreSQL 路径。它不会自行启动数据库；提供隔离的测试库后运行：

```sh
cd platform/control-plane/scheduler
LUMO_TEST_PG_DSN='postgres://…' go test ./internal/integration -run TestPreemption -count=1
```

测试账户必须只指向可销毁的测试数据库。没有 `LUMO_TEST_PG_DSN` 时用例按设计跳过，不能把跳过视为
端到端验收通过。

## 三种形态的硬边界

| 形态 | 存储 | 允许的运行能力 | 禁止依赖 |
|---|---|---|---|
| `local` | SQLite | 本机 DSH、OpenDesign、Archify、本地技能、本机 Agent | RocketMQ、Nacos、MinIO、Redis、PostgreSQL、跨用户委派 |
| `standalone` | PostgreSQL | 单服务器控制面、单节点调度和服务器连接器 | 跨节点/桌面节点/组织委派治理，即使机器上另有 Nacos 也不自动开启 |
| `cluster` | PostgreSQL | Nacos 节点目录、跨用户委派、桌面节点、灰度与弹性调度 | — |

模式由 `LUMO_DEPLOYMENT_MODE` 决定，不能由中间件是否可连接、节点数量或 URL 是否存在推断。

## 仍存在的默认值

代码中的 `localhost`、`127.0.0.1`、`dev-*`、Legacy Local-lite PG/Redis 端口以及 Compose
中的 `${...:-dev-default}` 均是开发兜底，不是生产连接信息。生产必须在部署层覆盖，尤其是：

- `LUMO_CONTROL_PLANE_TOKEN`、`LUMO_SUBAGENT_HOST_TOKEN`、`LUMO_VAULT_TOKEN` 和 OPA/Vault 地址；
- 所有 PG/Redis/Embedding/网关地址；
- `LUMO_DSH_IMAGE` 及节点广告地址；
- Helm Secret、TLS、Nacos namespace/group 和数据驻留域。

Helm 的 `dshNode.enabled` 默认关闭，避免在未提供正式 DSH 镜像和承载令牌时误启动；
启用后每个节点以 Pod 名称注册为独立 Nacos 临时实例，副本数可以扩展到大于两个。
Scheduler 的多智能体 fanout 数量不写死为两个，HPA 只是执行节点的容量调节层。

浏览器不能覆盖 `X-Lumo-User`、`X-Lumo-Realm`、`X-Lumo-Roles` 等运行身份。公开端口由
`@lumo/user-auth` 持有；原生 DSH WebServer 只绑定容器内环回地址和随机端口。代理使用
HttpOnly + SameSite=Strict 的不透明会话 Cookie 向 Governance 校验用户，再删除浏览器
提交的身份头并为每个转发请求注入：

- `X-Lumo-Identity`：base64url 编码的 JSON，字段为 `aud: "lumo-ui"`、`exp`（Unix 秒，
  最多晚于当前时间 300 秒）、`userId`、`realm`、非空 `roles`，以及可选 `projectId`、
  `deptId`；
- `X-Lumo-Identity-Signature`：对上述编码字符串执行 HMAC-SHA256 后的 base64url 值。

断言的有效期为 60 秒；缺失、过期、超长有效期或签名错误统一返回 `401`，部署中的
`dev-user` 等静态字段不作为浏览器认证回退。Compose 未单独设置 Secret 时使用同环境的
控制面令牌作为本地开发兜底；生产必须提供独立 Secret、TLS，并启用
`LUMO_AUTH_SECURE_COOKIE=true`。Helm 启用 `dshWeb.enabled=true` 时默认要求
`dshWeb.identityAssertion.secretName`；只有明确设置
`dshWeb.identityAssertion.allowStaticIdentity=true` 才允许开发环境继续使用静态身份。

跨节点 Seam 调用应使用另一把独立密钥（不能复用上面的 `lumo-ui` 受众），在 Proxy 配置
`identityAssertionSecret` 与非空 `roles`，并在 Host 配置相同的
`identityAssertionSecret`。Proxy 会在每次请求上写入受众为 `lumo-seam-host`、有效期 60 秒的
`X-Lumo-Identity` / `X-Lumo-Identity-Signature`；Host 启用该项后拒绝普通
`X-Lumo-Realm` / `X-Lumo-User` 身份头，并拒绝查询载荷请求断言外的角色。密钥至少 32 字节，
通过 Secret 注入；生产还必须使用节点间 mTLS，HMAC 断言不防御遭攻陷节点。

Seam Host 与 Proxy 的 mTLS 配置使用相同的 `tls` 对象：`caFile`、`certFile`、`keyFile` 都必须是
Secret volume 中的**绝对** PEM 路径；Proxy 可选 `serverName` 用于 SNI/证书 DNS 校验，
`reloadIntervalMs` 可设为 1000–3600000 毫秒（默认 30000）。Host 启用后以
`requestCert + rejectUnauthorized` 强制客户端证书，Proxy 启用后只接受 `https://` 端点，连 Nacos
热更新的 endpoint 也不能降级为 HTTP。每次检查会先验证完整的新 PEM bundle；Host 为新连接更新 TLS
context，Proxy 为新请求使用新凭据。无效或不完整的轮换文件保留上一套有效凭据，Host 记错误；证书撤销、
紧急回退或部署策略要求时仍应通过原子 Secret 更新配合滚动重启完成收敛。私钥字节不进入 patch、Registry、
日志或环境变量。

## Helm workload mTLS 与生产治理门槛

### Standalone/Compose 控制面原生 TLS

除 Istio 外，所有 TCP HTTP 控制面入口都可通过同一组环境变量启用原生 TLS/mTLS：
`LUMO_TLS_CERT_FILE`、`LUMO_TLS_KEY_FILE`、`LUMO_TLS_CLIENT_CA_FILE`。三者必须同时提供，
服务端仅接受 TLS 1.3 且强制校验客户端 CA；证书/私钥文件在每次新握手前按 mtime/size 热加载，
无效轮换会失败关闭而不会回退到明文。控制面出站客户端使用 `LUMO_TLS_CA_FILE`、同名 cert/key
和可选 `LUMO_TLS_SERVER_NAME`。未配置任何 TLS 变量时才保持本地开发 HTTP 行为。

Cluster 形态的控制面、DSH Web/承载节点、子代理 start/result 回调与 Connector/LLM 网关间流量可通过
`serviceMesh.istio.enabled=true` 接入 Istio workload mTLS。Chart 会给所有这些 Pod 注入 sidecar、创建以
`lumo.dev/mesh-mtls=enabled` 为 selector 的 `PeerAuthentication: STRICT`，并为各 Lumo Service 创建
`DestinationRule: ISTIO_MUTUAL`。应用仍使用内部 `http://` Service URL；sidecar 透明地以 mTLS 连接，
因此不会出现只改一半客户端而退回明文的拓扑。

```yaml
serviceMesh:
  istio:
    enabled: true
    revision: stable             # 与集群已安装的 Istio revision 一致；不使用则留空
    trustDomain: cluster.local   # 必填，不猜测实际 SPIFFE trust domain
    denyPrincipals: []           # 紧急隔离时填被吊销的 workload SPIFFE principal
```

证书由 Istio SDS 按 Pod ServiceAccount 签发、以内存挂载并自动轮换，私钥不进入应用容器、Helm values 或
环境变量。生产 operator 必须在启用前确认 CA 根轮换窗口、工作负载证书 TTL、跨命名空间/入口网关的
trust-domain federation；紧急处置先把受影响 principal 写入 `denyPrincipals` 并滚动替换其 ServiceAccount/
证书，根 CA 泄露则按 mesh 的双根过渡和最终移除旧根执行。该 Chart 不会伪造 CRL 或把浏览器直接接到
STRICT workload；南北向流量必须先在受管 Ingress/Edge Gateway 终止浏览器 TLS，再以网格身份访问服务。

`productionControls.enforced=true` 是上线渲染门槛，而不是替业务代做决策。开启时 Helm 必须获得 SLO 文档、
正式 OTLP Collector URL、日志/trace 留存天数、月度费用上限以及 break-glass、租户密钥销毁、市场治理三份已批准策略引用，并
以 ConfigMap 发布这些非敏感声明；值缺失或非正数会使 `helm template/upgrade` 失败。策略正文、审批证据、
Go 控制面会从该 ConfigMap 的 `LUMO_OTEL_COLLECTOR_URL` 接收 Collector 地址；Loki/对象存储生命周期和
break-glass 执行流程仍须由运营与合规系统承载，当前不会把未经批准的 endpoint 猜测成真实系统。

## Cluster 联合验收

真实集群验收入口为 `platform/deploy/acceptance-cluster.sh`。它拒绝空值和开发默认，要求调用方提供
`LUMO_TEST_PG_DSN`、`LUMO_TEST_RMQ_ENDPOINT` 以及 Nacos、Milvus、Nebula adapter、OPA、Vault 的健康 URL：

```sh
LUMO_TEST_PG_DSN='postgres://...' \
LUMO_TEST_RMQ_ENDPOINT='rmq-proxy:8081' \
LUMO_TEST_NACOS_HEALTH_URL='https://nacos.example/nacos/v1/console/health/readiness' \
LUMO_TEST_MILVUS_HEALTH_URL='https://milvus.example/healthz' \
LUMO_TEST_NEBULA_HEALTH_URL='https://graph-adapter.example/healthz' \
LUMO_TEST_OPA_HEALTH_URL='https://opa.example/health' \
LUMO_TEST_VAULT_HEALTH_URL='https://vault.example/v1/sys/health' \
./platform/deploy/acceptance-cluster.sh
```

脚本先执行 Cluster smoke，再运行 Scheduler 租约接管、流程/项目/Registry、Connector/LLM、RocketMQ
真实传输和 Session-log 双写者 resume/fencing 测试。`LUMO_ACCEPTANCE_SKIP_SMOKE=1` 只适用于已由外部
编排器确认所有容器健康的场景；它不会跳过依赖健康检查或 `LUMO_TEST_PG_DSN` 闸门。健康 URL、PG schema、
RocketMQ topic、Vault token 和测试数据隔离均由验收环境负责，脚本不创建或删除生产数据。

父节点在收到 Scheduler 的 `node_id` 后，先读取显式 `LUMO_SUBAGENT_NODE_URLS`，未命中
时查询 Nacos 的健康实例并按 `node_id` 匹配；承载令牌优先取节点专属
`LUMO_SUBAGENT_HOST_TOKENS`，否则使用同环境的 `LUMO_SUBAGENT_HOST_TOKEN`。因此
扩容出来的新 Pod 会自动进入可路由集合，不需要修改父节点配置或把智能体数量写死。

测试脚本里的 `127.0.0.1` 和 `dev-*` 只用于本机测试，不参与生产启动。

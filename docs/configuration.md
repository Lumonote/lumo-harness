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
| Provisioner | `PROVISIONER_ARTIFACT_NAME`、`PROVISIONER_ARTIFACT_VERSION`、`PROVISIONER_INTERVAL`、`PROVISIONER_SHAPE` | 要收敛的签名制品闭包及目标形态；设置制品名后 DSH 自动读取共享快照 |
| dsh 节点 | `LUMO_NACOS_ADDR`、`LUMO_NODE_ADVERTISE_HOST`、`LUMO_NODE_CAPACITY`、`LUMO_NODE_CAPABILITIES`、`LUMO_NODE_RESIDENCY` | Nacos 临时节点注册 |
| 部署 | `LUMO_DSH_IMAGE` | Compose 使用的 dsh-node 镜像；源码来自同项目下 Git 忽略的 `deepseek-harness/` |
| Helm DSH 节点池 | `dshNode.enabled`、`dshNode.replicas` | 是否启用承载节点池、初始副本数 |
| Helm DSH HPA | `dshNode.hpa.minReplicas/maxReplicas`、`targetCPUUtilizationPercentage` | 按实际运行 CPU 负载自动扩缩节点池；可选接入队列外部指标 |

Scheduler 的 `POST /v1/placements` 支持可选 `deadline_ms`（EDF）、`queue`/`weight`
（加权公平队列）、`requires[].value`（例如 `gpu=a100`）和 `avoid_nodes`（硬反亲和）。
不传这些字段时使用兼容默认值；这些字段只影响调度决策，不改变多智能体 fanout 上限，
fanout 仍由请求/运行时策略决定，节点池由 Nacos + HPA 按容量动态扩展。

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

父节点在收到 Scheduler 的 `node_id` 后，先读取显式 `LUMO_SUBAGENT_NODE_URLS`，未命中
时查询 Nacos 的健康实例并按 `node_id` 匹配；承载令牌优先取节点专属
`LUMO_SUBAGENT_HOST_TOKENS`，否则使用同环境的 `LUMO_SUBAGENT_HOST_TOKEN`。因此
扩容出来的新 Pod 会自动进入可路由集合，不需要修改父节点配置或把智能体数量写死。

测试脚本里的 `127.0.0.1` 和 `dev-*` 只用于本机测试，不参与生产启动。

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
| SkillHub 技能源 | `skillhub search/install`、`LUMO_SKILL_SNAPSHOT_ROOT`、`LUMO_SKILL_SNAPSHOT_FILE` | 通过 SkillHub 搜索、安装并验签技能，再生成 `skill-local` 启动快照；不会在运行时直接拉取远端内容 |
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

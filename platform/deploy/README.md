# 部署清单

所有服务地址、连接串和运行身份均应通过 Compose environment 或 Helm values/Secret
注入；配置变量说明见 [`docs/configuration.md`](../../docs/configuration.md)。仓库内
`registry-trust.dev.json` 仅用于本地 Compose 验证，生产必须替换为真实信任根。
所有控制面非健康接口还要求 `LUMO_CONTROL_PLANE_TOKEN`；Compose 启动前必须设置，
Helm 默认从 `lumo-control-plane-token/token` 读取。
生产 DSH Web 还应设置 `dshWeb.identityAssertion.secretName/secretKey`。公开入口的
`@lumo/user-auth` 会在治理用户完成登录后按 `docs/configuration.md` 的契约签发逐请求身份；
未设置时仅适合本地开发。

Cluster 使用 Istio 时，可启用 `serviceMesh.istio.enabled=true`，使 Chart 为控制面、网关和 DSH 节点
注入 sidecar 并创建 STRICT workload mTLS 策略。该开关要求显式填写目标集群的 `trustDomain`；证书由
Istio SDS 管理，不应创建或挂载通用私钥 Secret。上线前还应启用 `productionControls.enforced=true`，以
已批准的 SLO、留存/费用和合规策略引用通过 Helm 渲染门槛。具体值与紧急吊销步骤见
[`docs/configuration.md`](../../docs/configuration.md)。

> 三档产品形态：本地单机、服务器单例、服务器集群。**本地单机不是服务器单例的缩小版**，不启动任何网络中间件，使用 SQLite；`compose.local.yml` 只是遗留的开发集成测试台。

| 文件/目录 | 形态 | 载体 | 用途 |
|------|------|------|------|
| `desktop/` | 本地单机 | Rust/Tauri 桌面包 | SQLite、本机 Agent、本地技能；无 RocketMQ/Nacos/MinIO/Redis/PostgreSQL |
| `compose.standalone.yml` | 服务器单例 | Docker Compose | PG+pgvector / Redis / MinIO / RocketMQ / Nacos + 平台 Go 服务单实例 |
| `compose.cluster.yml` | 服务器集群 | Docker Compose | **自研服务多实例 + 中间件单实例**；分布式行为与故障注入调试 |
| `helm/` | Cluster | 生产 | 控制面服务 Helm chart、健康探针和依赖配置 |
| `compose.local.yml` | Legacy Local-lite | 本地 | 仅开发/CI：PG + Redis + Embedding，不作为产品发行包 |
| `migrations/` + `migrate.sh` | — | — | 版本化平台迁移记录与执行入口 |

## 原生 DSH Web + Lumo 运营面

### 部署前置检查

在启动或做 Cluster 验收前先运行只读预检；它不会启动容器或读取 Secret 正文，只会检查
Docker daemon 可达性、Compose 渲染、必需拓扑、控制面令牌和 Registry 信任根。`--strict`
额外拒绝仓库内的开发默认凭据、开发 trust root 和过短的身份断言密钥：

```sh
./platform/deploy/preflight-deployment.sh standalone
./platform/deploy/preflight-deployment.sh cluster --strict
```

`smoke-cluster.sh` 会自动运行基础预检。因此没有 Docker socket 权限或缺失部署变量时，会在
读取容器状态之前以具体的前置条件失败，而不是将其误报为应用故障。

### 启动前自动确保 DSH 源码

优先使用包装脚本启动。根目录不存在 `deepseek-harness/` 时，它会从
`deepseek-ai/deepseek-harness` 浅克隆默认分支的最新源码；目录已存在时**绝不**执行
fetch、pull、checkout、reset 或覆盖，直接使用现有源码。

```sh
# 本地单机：不执行 docker compose
pnpm --dir platform desktop:dev

# 服务器单例
./platform/deploy/up.sh standalone -d --build

# 服务器集群
./platform/deploy/up.sh cluster -d --build
```

Cluster 全部容器启动后执行统一冒烟验收；脚本会等待长期服务进入 running/healthy、
确认 `rocketmq-topic-init` 成功退出，并检查双 Scheduler、控制面、DSH Web 与 Prometheus：

```sh
./platform/deploy/smoke-cluster.sh
```

默认读取 `platform/deploy/.env`；可用 `LUMO_ENV_FILE` 指向其它环境文件，并通过
`LUMO_SMOKE_TIMEOUT_SECONDS` 调整容器就绪等待时间。

原生 `docker compose` 本身无法运行宿主机的前置脚本；若直接运行它，仍须自行确保
`deepseek-harness/` 已存在。

集群启动后，Compose 会启动官方 DSH Web shell，并在同一 AppFrame 内挂载 Lumo 应用/运营插件。Compose 中的 DSH 节点默认
直接从当前工作区的 `deepseek-harness/` 源码构建；也可通过 `LUMO_DSH_IMAGE` 指向
已经发布的等价镜像：

```sh
docker compose -f compose.cluster.yml up -d --build
```

Web profile 首次启动会自动安装固定版本的数据分析插件，以及所有本地 Lumo 插件包。
登录不再依赖第三方认证包：本地 `@lumo/user-auth` 连接 Governance 的
`governance_users` 用户源，密码摘要、一次性交互式验证码和会话都保存在 PostgreSQL。
Standalone/Cluster Compose 默认引导以下本地账号：

- 用户名：`admin`
- 初始密码：`lumo-admin-123`

启动前应通过 `LUMO_AUTH_BOOTSTRAP_USERNAME` 和 `LUMO_AUTH_BOOTSTRAP_PASSWORD` 覆盖默认值。
引导逻辑只在账号尚无凭据时写入密码，不会在容器重启时重置现有密码。登录页始终要求
3×3 点选九宫格验证码（按提示顺序点击数字），验证码只可使用一次。登录后可在“用户中心”修改密码，修改会撤销该用户
的全部现有会话。

打开 `http://127.0.0.1:4173` 使用上述治理用户登录并验证原生 DSH 会话、模型、工具与插件交互；新建
会话后选择“数据模式”即可打开数据分析工作台。打开
`http://127.0.0.1:4173/lumo/ops` 直接进入 Lumo 运营面。Lumo API 上游地址和身份由
环境变量注入，不写死在前端；面板会读取 leader、真实 Nacos 节点、项目/流程/连接器清单，
并展示已挂载的知识库、项目、计量、连接器等插件。插件通过包名装入 profile，设置页不再
显示容器绝对路径。右下角入口和运营页使用 ReactBits 风格的渐变胶囊、玻璃面板、
状态点和轻量动效。

OpenDesign、Archify、图像风格库、PPT Master 与 Ruflo 编排适配器会装入所有 DSH profile。
OpenDesign 提供 artifact-first 的设计/原型工作流；Archify 提供可校验 JSON IR 的架构图和
任务调度视图；图像风格库与 PPT Master 提供创作 Skill；Ruflo 只负责单次 Lumo TaskRun
内部的子智能体拓扑。Lumo 仍是任务、权限、放置、取消、审计、报告和复核的唯一事实源。
固定 Skill 位于 `/workspace/platform/upstream/skills`，来源和提交哈希见
`platform/upstream/skill-sources.json`。这些适配器不会运行 `ruflo init`、修改仓库级指令文件，
也不会在服务启动时下载上游代码。

## 故障注入（compose.cluster.yml）

```sh
docker compose -f compose.cluster.yml up              # 起两集群缩微拓扑
docker compose stop cluster-a-dsh-1                  # R2: 任务重投 + resume 幂等
docker compose stop scheduler-0                       # N1: 备节点接管；无 leader 时放置快速失败
docker compose pause cluster-b                        # §7.4: suspect(30s)→down(90s) 两段式
docker compose stop collaborator-0                    # §5.4.7.4: CRDT 归属转移
# 网络分区用 toxiproxy/tc 注入（R1: SeamProxy 熔断 + 背压）
```

## RocketMQ 启动与排障

NameServer 与 Broker 已拆成独立容器。NameServer 健康检查只探测 9876 TCP 端点；不能使用
`clusterList`，因为后者需要已注册的 Broker，会产生「Broker 等 NameServer 健康、NameServer
又等 Broker」的循环。Broker 入口会以 root 修正 `/home/rocketmq/store` 卷属主后再降权运行，
因此不再需要手工 `chown`。

RocketMQ 异常退出可能留下空文件或截断的 JSON 元数据，例如 `consumerOffset.json`、
`timermetrics` 及其 `.bak`；其表象是启动日志先报 JSON EOF，随后在关机路径出现
`ScheduleMessageService.configFilePath` NPE。入口脚本会检查已知 ConfigManager 元数据的
JSON 对象边界，优先从完整备份恢复；主备都损坏时将原文件移动到卷内 `config/recovery/`
后重建，不删除 commitlog、consumequeue 或 topic 消息。偏移重建可能触发历史重放，计量
台账通过 `event_key` 幂等约束去重。

如果只需重建消息链路，使用包装脚本：

```sh
./platform/deploy/up.sh cluster -d --build --force-recreate \
  rocketmq-namesrv rocketmq rocketmq-topic-init usage-ledger
```

若仍失败，优先取 NameServer 和 Broker 的健康检查输出与日志：

```sh
docker inspect --format '{{json .State.Health}}' lumo-platform-cluster-rocketmq-namesrv-1
docker compose -f platform/deploy/compose.cluster.yml logs --tail=150 \
  rocketmq-namesrv rocketmq rocketmq-topic-init
```

**topic 命名注意**：RocketMQ 合法字符集 `^[%|a-zA-Z0-9_-]+$`，点号非法；本项目的
usage topic 统一为 `usage-events-<cost_type>`。

## 一键备份与迁移

备份入口会短暂停止当前已运行的应用写入端（PostgreSQL 保持运行以导出逻辑备份），快照完成后
只恢复原先处于运行状态的服务。输出目录权限为 `700`，清单为
`backup-manifest.jsonl.zst`，每个 payload 同时记录在 `SHA256SUMS` 中；恢复前会验证 zstd
完整性、清单格式、文件摘要和 tar 路径安全性。

```sh
# 备份当前拓扑；第二个参数可指定安全的备份目录
./platform/deploy/backup.sh cluster
./platform/deploy/backup.sh standalone /secure/backups/lumo-standalone

# 恢复到目标拓扑。--replace 是必需的明确破坏性确认：目标容器会替换，
# 目标命名卷的内容会被备份内容覆盖（不会执行 docker compose down -v）。
./platform/deploy/restore.sh cluster /secure/backups/lumo-standalone --replace

# 一键执行备份、校验并迁移；支持同形态原地迁移以及 Standalone → Cluster。
./platform/deploy/migrate-deployment.sh standalone cluster --replace
./platform/deploy/migrate-deployment.sh cluster cluster --replace
```

覆盖范围包括 PostgreSQL 逻辑数据、MinIO、Nacos、RocketMQ、Milvus（存在时）、Cluster 本地
Registry 对象目录和 Provisioner 安装目录（存在时）。Redis 是可重建的热态，故刻意不迁移。
Compose 环境变量、挂载的信任根文件和宿主机 Secret 不会被复制；但 MinIO/Nacos 内的应用数据
仍可能含敏感信息，必须按密钥材料同等级保管备份目录。

Cluster 在此改动前使用容器可写层保存 PostgreSQL、MinIO、Nacos 等数据。首次采用新命名卷前，
请先运行 `migrate-deployment.sh cluster cluster --replace`，让脚本从旧容器层导出并恢复到命名卷；
不要直接对旧集群执行一次完整的 `up --force-recreate`，否则这些未挂卷的数据会随旧容器被丢弃。
Cluster 备份若包含 Milvus，不能恢复到默认未启用 Milvus 的 Standalone，脚本会明确拒绝而不是静默丢数。

## 生产 Helm 与迁移

制品发布先把 JSONL+zstd Bundle 上传到 `POST /v1/blobs`，再把返回 digest 写入签名
manifest 的 `payload_digest`。Registry 只接受结构和 entry digest 均通过校验的 Bundle，
发布 manifest 时还会校验 Bundle header 的 name/version 与 manifest 一致。
`artifact-publisher` 会在联网前重做这些校验，随后按固定顺序上传 Bundle 和原始签名
manifest；它支持 ed25519 PKCS#8 PEM、32 字节 seed、64 字节私钥，或 CI 预先生成的
64 字节签名：

```sh
cd platform/control-plane/registry
LUMO_CONTROL_PLANE_TOKEN='replace-me' go run ./cmd/artifact-publisher \
  -registry https://registry.example.com \
  -manifest ./artifact.manifest.json \
  -bundle ./artifact.jsonl.zst \
  -private-key /run/secrets/publisher-ed25519.pem
```

签名覆盖 manifest 文件的原始字节，CLI 不会重排 JSON；Registry 重定向被禁用，避免
Bearer 令牌或发布内容被转发到其他地址。使用外部签名服务时改传
`-signature ./artifact.manifest.sig`。

制品节点的持续收敛器可在 Standalone 以 profile 启用；它从 Registry 拉取签名计划，
按 digest 校验 manifest 与 Bundle，原子物化 payload，并生成 DSH 使用的
`skills/` 与 `skill-snapshot.json`。DSH 与 Provisioner 共享命名卷，设置制品名后 DSH
启动会等待快照出现，超时则失败关闭：

```sh
PROVISIONER_ARTIFACT_NAME=my-skill \
PROVISIONER_ARTIFACT_VERSION=1.2.3 \
LUMO_CONTROL_PLANE_TOKEN='replace-me' \
docker compose -f compose.standalone.yml --profile provisioner up -d --build provisioner artifact-runtime dsh-node
```

也可以把版本选择交给 Registry 的 `stable` 通道：管理员先在 Lumo 插件市场将某个
已发布制品设为 Stable 期望版本，再配置 `PROVISIONER_ARTIFACT_NAME` 与
`PROVISIONER_ROLLOUT_CHANNEL=stable`（不设置 `PROVISIONER_ARTIFACT_VERSION`）。每个
周期会读取目标版本并重新从签名字节生成计划；当前只支持 `percent=100` 的全量收敛。

Cluster 使用相同的 `provisioner` profile；启动整个缩微集群时加入
`--profile provisioner` 即可让所有 DSH 容器只读挂载同一份快照。持续检查周期由
`PROVISIONER_INTERVAL` 配置，默认 `30s`；DSH 默认等待 `120s`，可通过
`LUMO_SKILL_SNAPSHOT_WAIT_MS` 覆盖。

### 受控 Component 本地运行时

`Component` manifest 可选地声明一个已签名的 `runtime`。当前只支持本地 `process`：
入口必须是同一份已验签 payload 内的安全相对路径，参数为固定字符串数组；不允许 shell、
环境变量、挂载、Docker 或 Kubernetes 规格。只有 Provisioner 重新校验 manifest digest、
payload digest 和所有 payload 文件后，`artifact-runtime` 才会授予入口可执行权限并启动它。

启用 `provisioner` profile 会一并启动不发布网络端口的 `artifact-runtime` 控制器。控制器
只绑定共享卷中的 mode `0600` Unix socket，且不会自动运行任何制品。使用容器内客户端显式
操作（以下以服务器单例为例）：

```sh
docker compose -f compose.standalone.yml exec artifact-runtime \
  artifact-runtime start --socket /var/lib/lumo/artifacts/artifact-runtime.sock \
  --name my-component --version 1.2.3
docker compose -f compose.standalone.yml exec artifact-runtime \
  artifact-runtime health --socket /var/lib/lumo/artifacts/artifact-runtime.sock \
  --name my-component --version 1.2.3
docker compose -f compose.standalone.yml exec artifact-runtime \
  artifact-runtime logs --socket /var/lib/lumo/artifacts/artifact-runtime.sock \
  --name my-component --version 1.2.3
```

`stop` 会优雅终止后在超时后强制结束；`uninstall` 只允许卸载当前安装闭包的根制品。持续
Provisioner 仍以 Registry 的期望状态为真相源，因此若未清除或替换该目标，下一次 reconcile
会重新安装；控制器会明确返回这一提示。Helm 需要同时设置
`provisioner.enabled=true` 与 `provisioner.runtime.enabled=true`；操作时通过同 Pod 的
`artifact-runtime` 容器执行上述客户端命令，不开放 Service。

`helm/lumo-platform` 提供八个控制面服务的 Deployment、Service、健康探针以及
PG/Nacos/OPA/Vault 配置绑定；设置 `dshNode.enabled=true` 后会部署可水平扩展的
DSH 承载节点池和 HPA，设置 `dshWeb.enabled=true` 后会部署原生 DSH Web + Lumo
运营面入口。每个 Pod 用自身名称作为 Nacos 节点 ID，Scheduler 会按实时
节点目录和容量接收任意数量的子代理任务，不把并发数固定成两个：

```sh
helm upgrade --install lumo ./helm/lumo-platform -n lumo --create-namespace
```

同时设置 `provisioner.enabled=true`、`provisioner.artifactName` 以及
`provisioner.artifactVersion` 或 `provisioner.rolloutChannel` 时，每个 DSH Pod 会先通过 init container 完成首次安装，
再由 sidecar 持续校验；主容器只读挂载 Pod 内共享卷，不会读取未验证的远端内容。

`platform/console` 的旧静态直连页面已退役，只显示迁移入口；不要再把控制面 CORS、
Bearer 令牌或身份头暴露给它。运营能力统一从原生 DSH Web 的 `/lumo/ops` 进入。

扩容策略由 `dshNode.replicas`、`dshNode.hpa.minReplicas/maxReplicas` 和节点
`capacity` 控制；必须提供 `dshNode.image` 与 `dshNode.hostTokenSecret`。HPA 需要
集群已安装 metrics-server。若需要按排队任务数扩容，可在同一 HPA 接入 Prometheus
Adapter，业务侧仍只依赖 Nacos 节点发现，不改路由契约。

生产发布前执行版本化迁移：

```sh
DATABASE_URL=postgres://... ./migrate.sh
```

Local-lite 仍保留服务自带的幂等建表；生产环境用 `lumo_schema_migrations` 记录迁移
状态。Prometheus 抓取配置分别在 `prometheus.yml`（cluster）和
`prometheus-standalone.yml`（standalone），告警规则在 `prometheus-alerts.yml`；两套
Compose 都会启动 Prometheus（端口可由 `LUMO_PROMETHEUS_PORT` 覆盖），服务需暴露
`/metrics` 后启用对应告警。

## 约定

- **同一套镜像与应用配置，只换编排清单**；禁止「本地专用镜像」或「本地专用配置项」。
- 中间件在缩微集群中一律单实例（不验证中间件自身的 HA，那是它们各自的事）。
- 每个 compose 的 CI 冒烟：起得来 → 跑一个 headless 任务 → 正常退出。

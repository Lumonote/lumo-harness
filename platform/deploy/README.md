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
| `compose.cluster.devices.yml` | Cluster 设备接入 | Compose 叠加文件 | 独立设备 TLS 监听、服务端证书和设备签发 CA 挂载 |
| `helm/` | Cluster | 生产 | 控制面服务 Helm chart、健康探针和依赖配置 |
| `compose.local.yml` | Legacy Local-lite | 本地 | 仅开发/CI：PG + Redis + Embedding，不作为产品发行包 |
| `migrations/` + `migrate.sh` | — | — | 版本化平台迁移记录与执行入口 |

## 桌面设备 TLS 接入

设备通道仅在 `Cluster ready` 中启用。Compose 使用 `compose.cluster.devices.yml`
叠加文件；Helm 使用 `deviceGateway.enabled=true`。两种方式都把设备 TLS 流量送到
Governance 的独立 `8090` 监听，原管理 API 继续使用 `8089`。公网入口必须保留客户端
TLS 握手，使用 TCP 负载均衡或 TLS passthrough，且不注入 PROXY protocol。

需要预置两套材料：匹配设备入口域名的服务端 TLS 证书与私钥，以及只签发设备客户端
证书的独立 CA 证书与私钥。Helm 分别读取 `deviceGateway.tlsSecret` 和
`deviceGateway.issuerSecret`，不会生成或把私钥下发给 Agent。所有 Governance 副本
必须共享相同的设备 CA、服务端证书、公共入口和 PostgreSQL 状态。

启用 Istio 后，管理端口仍使用 STRICT workload mTLS，设备端口从 Governance sidecar
入站捕获中排除。`deviceGateway.istioIngress.enabled=true` 可为已有 ingress controller
创建专用 PASSTHROUGH Gateway/VirtualService；也可以保留默认关闭值，由外部 TCP
入口连接独立 `device-gateway` Service。设备 Service 的 DestinationRule 只关闭该路径
上的 mesh TLS 发起，原始设备 mTLS 在 Governance 内验证。

完整的 Compose/Helm 配置、Secret 权限、滚动更新、Agent 激活与恢复流程见
[`docs/desktop-devices.md`](../../docs/desktop-devices.md)。设备管理从原生 DSH Web
的 `/lumo/ops` 进入；Agent 不需要控制面 Bearer 令牌。

## 原生 DSH Web + Lumo 运营面

### 构建镜像（发布路径）

```sh
./platform/build.sh --targets images      # 12 个控制面镜像 + provisioner + dsh-node + console
```

**构建失败的两种形态，先分清再查**（2026-09-17 实测，两者都真出现过）：

1. **可修复的装配缺陷** —— 报错长这样：
   ```
   reading /heartbeat/go.mod: no such file or directory
   ERR_PNPM_PATCH_NOT_FOUND: ... patches/@electron__osx-sign@1.3.3.patch
   spawnSync cc ENOENT
   ```
   三者是同一条规则的不同实例：**下依赖/构建那一步所需的输入，必须在那一步之前就位**。
   控制面的 Go 模块用 `replace ../<兄弟模块>` 互相引用，所以每个 Dockerfile 必须把
   **它 go.mod 里 replace 的全部兄弟模块**COPY 进来、且**排在下依赖的那一步之前**、
   且**落点与模块根一致**。这三条由 `platform/tools/check-dockerfile-modules.py` 静态检查
   （秒级，无需 Docker），`build.sh` 与 CI 都会先跑它——**别等到 docker 里下完依赖才发现**。
   dsh-node 那条链上另有两条同类：`pnpm fetch` 需要 `patches/`、原生插件需要 C 工具链。

2. **网络抖动** —— 报错长这样：`E: Failed to fetch ... 502 Bad Gateway [deb.debian.org]`。
   这是镜像源的问题，**重试即可**，不是仓库里的缺陷。区分方法很直接：看错的那一行是不是
   `502`/超时；装配缺陷的报错永远指向一个具体文件或程序。

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

Cluster 全部容器启动后执行统一冒烟验收；脚本会等待全部服务进入 running/healthy，并检查
双 Scheduler、控制面、DSH Web 与 Prometheus：

```sh
./platform/deploy/smoke-cluster.sh
```

默认读取 `platform/deploy/.env`；可用 `LUMO_ENV_FILE` 指向其它环境文件，并通过
`LUMO_SMOKE_TIMEOUT_SECONDS` 调整容器就绪等待时间。

### 行为探针（集群）

`smoke-cluster.sh` 回答「进程活着吗」（`/healthz` 2xx），`probes-cluster.sh` 回答
「活着的进程**做的是不是它该做的事**」。两者都跑真实容器，区别只在断言对象：

```sh
./platform/deploy/probes-cluster.sh
```

- **目标端从拓扑派生，不写名单。** 探针集合来自 `compose.cluster.yml` 里容器端口落在
  控制面段（默认 `8080-8099`）的服务。新增一个控制面服务会自动多一条探针，删掉/改名会
  报 `probe-targets-not-derived` 而不是静默少跑一条。`probes-cluster-verify.sh` 会用
  写死的期望条数（cluster 13 / standalone 12）与它对照，并验证「容器端口挪出控制面段
  就跟着少一条」。
- **区分「服务没起来」与「服务起来了但行为不对」。** 前者是 curl 传输错误
  （exit 7/28/6），后者是 HTTP 2xx/4xx/5xx。两者退出码都非零，所以报出来的是**分类文案**
  而不是状态码本身——这是「容器 up 但接口答得不对」这类故障唯一能被看见的地方。
- **探的是行为，不是存在性。** `edge-gateway → terminal-gateway` 端到端链路、
  `/v1/routes` 路由表非空、`/v1/terminals/<ref>/presence` 返回 `presence` 键、以及
  三个「装配证据」指标（`lumo_flow_lineage_projector_enabled` /
  `lumo_scheduler_task_migrations_total` / `lumo_session_control_forced_releases_total`）。
  指标要断言的是**序列存在**而不是取值——取值为 0 也可能是装配好了但还没触发，而不存在
  只可能是这份二进制没带上这个特性。
- **「正确」可能不止一种形状，判据要写全。** 端到端链的终态取决于 terminal-gateway
  有没有事件源：未配时回 `503 no_event_source`（诚实，不伪造空历史），已配时普通 GET
  在 WebSocket 握手处被正确地拒为 `400`。两种都算通过；真正要抓的是**非 WS 请求拿到
  2xx**——那才是 §8.2 禁止的「伪造空历史」。把判据写成「必须是 503」会让探针在**接线
  推进的那一刻**对着一个正确的部署报红，而下一个人通常会把探针改坏而不是去查接线。

  同一类「诚实不可用不算缺陷」还出现在 flows：未配血缘时读查询面回
  `503 lineage_not_configured` 而不是用空列表冒充「没有血缘」——探针对此查的是
  `/metrics` 里那条投影器序列在不在，而不是去要求它可用。

可用 `LUMO_PROBE_TOPOLOGY` / `LUMO_PROBE_TIMEOUT_SECONDS` / `LUMO_PROBE_METRIC_ATTEMPTS`
调整被测拓扑与等待。缺 `LUMO_CONTROL_PLANE_TOKEN` 时以退出码 64 点名缺失变量。

所有探针都带 `curl --noproxy '*'`：开发机上常设 `HTTP_PROXY=http://127.0.0.1:...`，
走代理访问 `127.0.0.1` 会被代理回一个 502，症状与「上游不可达」完全一样。

### Cluster 验收链路

`smoke-cluster.sh` 只证明「容器起来了、健康端点通了」。**多节点恢复与接管**要靠
`acceptance-cluster.sh`：它在真实依赖上串联 smoke、Scheduler 租约接管、Session
resume/fencing、RocketMQ 传输、控制面集成与 dsh-plugins 的活库用例。

```sh
set -a; . platform/deploy/acceptance.env; set +a
./platform/deploy/acceptance-cluster.sh
```

必填变量的完整清单、取值来源与注意事项见
[`acceptance.env.example`](./acceptance.env.example)。两条最容易踩的：

- **它拒绝空值**。缺任何一个 `LUMO_TEST_*` 都会立刻失败并点名该变量，而不是降级跑一半。
- **它拒绝「零证据通过」**。每一步都断言真的执行了活体用例：`it.skip` /
  `describe.skipIf` / `t.Skip` 会让退出码保持 0，所以「脚本绿了」不足以证明有证据。
  计数为 0 即失败，并在日志里打出跳过数，让部分覆盖至少是可见的。

⚠️ 仓库自带的 cluster 拓扑**不发布任何基础设施端口**（只有 prometheus、dsh-web 与
11 个控制面服务暴露到宿主机）。要对着 compose 跑验收，用仓库自带的验收覆盖文件把
需要的端口暴露出来——它只给已有服务加 `ports:`，不新增服务，所以 preflight / smoke
的服务集检查不受影响：

```sh
LUMO_COMPOSE_EXTRA_FILES=platform/deploy/compose.cluster.acceptance.yml \
  ./platform/deploy/up.sh cluster -d --build
```

`LUMO_COMPOSE_EXTRA_FILES` 接受冒号分隔的多个文件，追加在 `compose.<shape>.yml` 之后。
standalone 拓扑本身就发布这些端口，本地验证不需要覆盖文件。

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
  rocketmq-namesrv rocketmq usage-ledger
```

若仍失败，优先取 NameServer 和 Broker 的健康检查输出与日志：

```sh
docker inspect --format '{{json .State.Health}}' lumo-platform-cluster-rocketmq-namesrv-1
docker compose -f platform/deploy/compose.cluster.yml logs --tail=150 \
  rocketmq-namesrv rocketmq
```

**topic 命名注意**：RocketMQ 合法字符集 `^[%|a-zA-Z0-9_-]+$`，点号非法；本项目的
usage topic 统一为 `usage-events-<cost_type>`。

## OPA（策略引擎）启动与排障

`compose.cluster.yml` 里的 OPA 必须显式绑到 `0.0.0.0`：

```yaml
    command: ["run", "--server", "--addr=0.0.0.0:8181", "/policies"]
```

**OPA 默认只监听容器内的 loopback**（`run --server` 的启动日志写着 `"addrs":["localhost:8181"]`），
而 compose 网络里兄弟容器解析到的是**容器 IP**、不是 `lo`——于是 `http://opa:8181` 一律连接失败，
宿主机侧的 `18181:8181` 端口发布也到不了。2026-09-16 实测：同一条 command 在自定义网络上做
容器间 `curl /health`，默认绑定 → `000`，加 `--addr` → `200`。

这件事的症状很有欺骗性，因为它**长得像权限问题**：三个消费方全部 fail-closed——
connector-gateway（`LUMO_OPA_ADDR`）的外部调用全拒、terminal-gateway 的 presence 全拒、
session-control 的每条控制指令都返回 `policy_unavailable`。fail-closed 是设计，所以「引擎连不上」
与「引擎说不」在别的服务里几乎同形；session-control 把两者分成了不同的 code。

排查顺序：① `docker compose logs opa | head`，看 `addrs` 是不是 `localhost:8181`；② 在另一
容器里 `curl http://opa:8181/health`（不是从宿主机）；③ 看消费方日志里的「策略引擎不可用」
是连接错误还是决策缺失。

镜像是**钉死的**（`openpolicyagent/opa:1.3.0`）而不是 `latest`：策略文件的语义跟着 OPA 主版本走
（本仓库 rego 用 1.x 的 `if` 规则体语法），而 `session-control.rego` 是用 1.3.0 逐条验过的——
浮动 tag 会让「验过的策略」与「在跑的引擎」不再对应同一件事。

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

### Helm 的 Secret 契约

chart **默认不创建任何 Secret**（`secrets.create: false`），它只引用四个，每个都必须由
运维自备。装之前先按这张表建好；安装输出（`NOTES.txt`）也会把同一份清单打出来：

| Secret（值名） | key | 消费方 | 内容 |
| --- | --- | --- | --- |
| `controlPlaneAuth.tokenSecret` | `controlPlaneAuth.tokenKey` | 每个启用的控制面服务 → `LUMO_CONTROL_PLANE_TOKEN` | 随机 bearer，必填 |
| `dshNode.hostTokenSecret` | `dshNode.hostTokenKey` | dsh-node、dsh-web → `LUMO_SUBAGENT_HOST_TOKEN` | 随机 bearer，启用 dshNode/dshWeb 时必填 |
| `registry.trustSecret` | **`registry-trust.json`** | registry 只读卷 → `/etc/lumo/trust/registry-trust.json` | `{"publishers":[{"id","public_key","max_scopes"}]}`，**key 名不能推断，写错只会挂出一个空目录** |
| `vault.tokenSecret` | `vault.tokenKey` | `LUMO_VAULT_TOKEN`（`optional: true`） | 必须匹配真实 Vault；把名字设为空则整条 env 省略 |

另外三处在对应能力打开时才需要：`governance.authSecret`（`envFrom`，装 `LUMO_AUTH_*`）、
`deviceGateway.tlsSecret` / `issuerSecret`（服务器证书与设备 CA）、
`dshWeb.identityAssertion.secretName`（认证代理签名用的 HMAC）。

本地/预发集群可以 `--set secrets.create=true` 让 chart 生成其中两项随机 bearer 与一个
**占位信任根**（`{"publishers":[]}`：registry 起得来，但任何制品校验都 fail-closed）。
`lumo-vault-token` 与真实信任根**永远不会被生成**——前者必须匹配一个 chart 并不部署的
Vault，后者是一组发布者公钥而非凭据。生成走 `lookup` 复用集群里已有的值，所以普通
`helm upgrade` 不会轮换 token；`helm.sh/resource-policy: keep` 保证卸载不删凭据。

**不要把 values 当成 token 的入口**：chart 只接受 Secret 名，不接受明文值。
`helm get values` 与 release Secret 都可读，从 values 进来的 token 在进入的那一刻就已经泄露。

### 集群形态：`values.cluster.yaml`

`values.yaml` 是基线（引用上面的 Secret，所有可选能力关闭）；`values.cluster.yaml` 是把它
变成**集群形态**的覆盖层，与 `compose.cluster.yml` 描述同一个系统：

```sh
helm upgrade --install lumo ./helm/lumo-platform -n lumo --create-namespace \
  -f ./helm/lumo-platform/values.cluster.yaml
```

它开启 `dshNode` / `dshWeb` / `secrets.create`，并让 scheduler 与 collaborator 各跑两个副本
（集群的租约/热备路径只有在两个 scheduler 下才存在）。其余开关保持关闭且逐条写明所缺的
外部事实：`connectorOAuth`（需已注册的 OAuth 应用）、`deviceGateway`（需精确公网 HTTPS origin
与设备 CA）、`serviceMesh.istio`（需 mesh 的 trustDomain，chart 明确拒绝猜）、
`productionControls`（需合规引用与留存/成本数值）、`provisioner`（需已发布制品）。

chart 一个 release 只建模一个节点池，第二个集群用第二个 release 表达：

```sh
helm upgrade --install lumo-b ./helm/lumo-platform -n lumo \
  -f ./helm/lumo-platform/values.cluster.yaml \
  --set nameOverride=lumo-platform-b --set dshNode.clusterId=cluster-b
```

### Helm 渲染门禁

```sh
./platform/deploy/helm-verify.sh
```

纯 helm、不需要集群与 Docker daemon，秒级。它断言两个 profile 都能渲染且过 `helm lint`；
每个被引用的 Secret 要么被渲染、要么在显式写死的运维自备清单里；没有 Secret 引用渲染成空名；
集群 profile 的 Secret 集合、scheduler 副本数与 `LUMO_INSTANCE` 绑定（现 **12** 个服务）符合预期。

三处 2026-09-16 补的检查：

- **chart 覆盖度**：**遍历仓库树**取 `platform/control-plane/*/Dockerfile` 得到的控制面模块全集
  （12）必须等于 chart 的 `services` 键集（12）——**没有豁免名单**。上面那些写死的期望值只防
  「值漂移」，防不住**集合缺员**：某个服务根本没进 chart 时，期望值从来没为它提高过，
  检查照样绿。这条就是为此存在的（它当场报出了 `edge-gateway` / `terminal-gateway`，
  二者当天补进 chart，豁免名单随之删除）。
- **路由表由 chart 派生**：`templates/edge-routes.yaml` 渲染出的每条路由，其上游主机与端口
  必须等于**同一次渲染**出的那个 Service 的名字与端口；路由覆盖的前缀集合**写死**比对。
  抄一份表在这里错两次：白名单要求与 `url.Host` 精确相等（写死名字在第二个 release 下全数失效），
  写死端口在有人改 `services.*.port` 后静默指向旧端口（加载与启动都成功，第一次匹配的请求 502）。
- **入口层的暴露是 per-service 的**：全局 `service.type` 保持 ClusterIP，需要对外时只覆盖那一个
  （反例断言「恰好只有一个 Service 变了类型」）。

反向用例现在共 **7 条**：四条原有的 `render_rejected`（缺 Secret 的四种形态）+ 三条
`render_rejected_saying`（指向已停用服务的路由 / 服务开着但路由表为空 / 路由条目不是 map）——
后者断言的是**报出预期的那一句**，因为「非零退出」也可能是被另一个检查拦下的。
另有 3 条非拒绝型反例自证：把一个模块从 chart 删掉必须被点名、改 `services.flows.port`
必须让路由上游跟着走、per-service 类型覆盖必须**只**影响那一个服务。只检查「好的渲染能过」的
门禁，在守卫被删掉之后照样全绿，所以反向用例不是可选项。

生产发布前执行版本化迁移：

```sh
DATABASE_URL=postgres://... ./migrate.sh
```

Local-lite 仍保留服务自带的幂等建表；生产环境用 `lumo_schema_migrations` 记录迁移
状态。Prometheus 抓取配置分别在 `prometheus.yml`（cluster）和
`prometheus-standalone.yml`（standalone），告警规则在 `prometheus-alerts.yml`；两套
Compose 都会启动 Prometheus（端口可由 `LUMO_PROMETHEUS_PORT` 覆盖），服务需暴露
`/metrics` 后启用对应告警。

### 入口网关 CORS 接线门禁

```sh
./platform/deploy/edge-cors-verify.sh
```

纯静态 + `helm template`，不需要集群与 Docker daemon。它守的是 `edge-gateway` 上那**两层语义
不同的 CORS**：`gate.CORS`（边缘自己的白名单，按**请求的 Origin** 裁决）与 observability
中间件（按**配置的来源**把 ACAO 写死）。两层各自都对，错法只在**跨文件对照**上，而且
**症状是「能用」**：

> 2026-09-16 实测：`compose.cluster.yml` 与 `compose.standalone.yml` 给 edge-gateway 设的
> 正是中间件读的那个变量（`LUMO_CORS_ORIGIN`），于是**边缘白名单一直是空的、边缘层根本
> 没在管事**——中间件那一层替它把 preflight 答了。curl、浏览器手测、面板全都正常，没有任何
> 静态检查能看出来。这正是 `cluster-registry-verify.sh` 那次「判定开着却没人自报」的同一个
> 病：配置看起来对、语义是错的。

判据的两个变量名（边缘白名单、中间件来源）**从 Go 源码推导**，不是写死的字符串：
`*/cmd/*/main.go` 里含 `"cors-origins"` 的那行上的 `envOr(...)`、以及 `observability/metrics.go`
里写 `Access-Control-Allow-Origin` 的那处往上最近的 `os.Getenv(...)`。推导不出来时**报错**
（`cors-rule-not-derived`）而不是放行——「没有规则要查」与「规则全都通过」在退出码上一样。

覆盖是**遍历**而不是点名：所有 `compose*.yml` 都过一遍（定义了网关的必须满足接线规则，
没定义的必须打印「未做网关检查」——沉默的通过与核对过的通过不是一回事），Helm 面同时看
基础 profile 与配了来源的 profile。两个形态差异是刻意的：

- **compose 的 dev 拓扑**显式钉了开发来源，所以白名单必须非空；
- **Helm 基础 profile** 默认 `console.corsOrigin: ""`，渲染出的白名单是空串——那是
  「没配来源 = 不放行任何跨域」的 **fail-closed 默认，不是缺陷**（因此这一条断言的不是
  退出码，而是它把「允许为空」的理由说出来了）；一旦部署里确实配了来源，空白名单就是
  接线断了。Helm 面还多一条 `envFrom` 规则：共享 ConfigMap 会把中间件那个变量注入**每个**
  服务，容器必须用空值覆盖它——判据是「ConfigMap 非空 **且** 容器没覆盖成空」，单看容器
  会漏掉「覆盖被删掉」，单看 ConfigMap 会把正确的覆盖判成违规。

反向用例共 **15 条**，每条都断言检查器报出的是**预期的那一条**：白名单变量被换回中间件
读的名字（就是上面那个真实缺陷形态）、被清空、被整行删掉、网关被改名/被顶出 `services:`
段、Helm 侧容器把中间件那层又打开、Helm 侧空值覆盖被整块删掉、模板丢了来源回退（渲染后
才判得出来）、以及把**代码侧**三个锚点分别改掉（旗标改名 → 必须报 `cors-rule-not-derived`；
白名单变量改名 → 报出的必须是**新名字**，那才证明判据不是写死的字符串；ACAO 头改名 →
锚点漂移必须喊，否则规则会退化成「找不到变量所以没人违规」）。另有 flow mapping 形态的
正负配对，钉住「服务写成 `svc: { image: ... }` 时 env 也必须读到」——真实拓扑里就有这个
形态，而它此前会被整条漏掉。

### 告警门禁

```sh
./platform/deploy/alerts-verify.sh
```

纯 Go、不需要集群与 Prometheus，秒级。它把 `prometheus-alerts.yml` 与 Helm 里那份
记录规则中的每个指标名、标签名拿回 Go 源码核对「真的有人写」，并检查每条告警的
`class`/`tier`/`severity` 三件套是否齐全、`tier` 与 `severity` 是否自洽、§7.4.2
点名的六类是否都有覆盖。

配了**11 条必须失败**的反例（指标名拼错、标签不存在、分组标签不存在、缺 `class`、
缺 `severity`、分级不自洽、规则级出现非法键、少一类覆盖、文件格式变了导致零条规则、
网关正负两张名单漂移、名单里的服务没人抓取）。
反例不是可选项：只检查「好的输入能过」的门禁，在它保护的那个检查被删掉之后仍然是
绿的。断言到**具体文案**而不是退出码——退出码 1 可能来自任何一个检查。

两条历史教训写在该文件的注释里，改动前值得先读：`lumo_service_up == 0` 与
`lumo_http_requests_total{status=~"5.."}` 都语法合法、Prometheus 都接受，只是永远
不可能选中任何序列。**结构性死规则不会报错，它只是不响。**

> **`task_lost` / `node_down` 在 Pg 目录（local-lite）下结构性不成立。** `scheduler_nodes`
> 只 upsert、从不删行，没有任何存活信号，所以孤儿数与健康节点数恒为 0。只有 Nacos 目录
> （实例按心跳判活，停止续报即被过滤）才产生这两类告警。对着本机形态调这两个阈值是白费。

### 脚本可移植性门禁

```sh
python3 platform/deploy/shell-portability-check.py --root .
python3 platform/deploy/shell-portability-check.py --self-test
```

抓一种**在 bash 上语法完全合法**的写法：变量展开之后紧贴全角标点（`"$name：..."`）。
它不可移植的方向很具体——bash 3.2（macOS 自带的 `/bin/bash`）会把 `name：` 当成一个变量名，
`set -u` 下报 unbound variable；而当这行落在**函数内部**时，bash 3.2 既不让脚本退出、
也不置非零状态，函数静默返回、脚本继续跑并**退 0**。

2026-09-16 实测到的后果：`compose-ports-verify.sh` / `edge-routes-verify.sh` /
`cluster-registry-verify.sh` 三个「反例自证」门禁在本机打印完正向用例的 OK 之后，**一个反例都没跑**、
连汇总行都没打，而退出码是 0——即本机假绿。CI（ubuntu 的 bash 5）不受影响，所以两边结论相反。
修法一律是写成 `${name}：`。`--self-test` 断言坏样本必报、好样本不报；CI 里两者都跑，
否则一个只扫真实文件的检查在它自己失效之后仍然是绿的。
（`edge-cors-verify.sh` 也是同一类门禁，写它时又在同一个坑里踩了一次——`ok "$name（给出：…）"`
让本机在第一个正向用例上就报 `name�: unbound variable`，所以新门禁一律先过这条检查。）

### 停滞任务收割

Scheduler 的两个开关：

| 开关 | 环境变量 | 默认 | 说明 |
|---|---|---|---|
| `-max-stall-ms` | `LUMO_MAX_STALL_MS` | `28800000`（8h） | 停滞判定宽限期。**负值 = 关闭收割** |
| `-stall-reap-ms` | `LUMO_STALL_REAP_MS` | `300000`（5m） | 收割周期 |

收割把「所属节点已不在目录中、且该 attempt 静默超过宽限期」的活跃任务转成死信
（`state = FAILED` + `scheduler_dead_letters` 台账），这样被卡住的任务才能重新提交——
在此之前，重新提交会因为「已有活跃 attempt」而被幂等地拒掉。

三道闸门缺一不可：目录快照必须新鲜、节点必须不在目录中、静默时长必须超界。**判据里没有
「任务跑了多久」这一项**，因为控制面的 `updated_at` 只在状态跃迁时前进，长任务与卡死任务
在它眼里一样。宽限期是宽限，不是主判据。

关掉收割（`LUMO_MAX_STALL_MS=-1`）时会在启动日志里显式警告：一个静默不工作的收割循环，
会让「没有任何死信」被读成「没有卡死的任务」。关掉之后 `LumoTaskLost` 仍然会响，只是没有
自动兜底。

## 约定

- **同一套镜像与应用配置，只换编排清单**；禁止「本地专用镜像」或「本地专用配置项」。
- **镜像引用有两个自由度（registry 与 tag），两个都要钉**。只钉 tag 会踩「仓库整体下线」
  （2026-09-16→09-20 的 `minio/minio`：先换 tag 只撑了四天，因为整个仓库从 Docker Hub 下架，
  现已改用 `quay.io/minio/minio`）；只钉 registry 会踩 `latest` 漂移。**两份 compose 的同名
  服务必须同源**——否则 standalone 能起的拓扑在 cluster 里起不来，反之亦然。门禁
  `./platform/deploy/compose-images-verify.sh`（含 11 条反例/边界）。
- 中间件在缩微集群中一律单实例（不验证中间件自身的 HA，那是它们各自的事）。
- **计量闭集 topic 的预建在 rocketmq 入口脚本里，不在独立容器里**（2026-09-20 合并；原先是
  一次性容器 `rocketmq-topic-init`）。顺序即契约：注册断言 → 建 topic → 才 `sh mqproxy`，
  于是「8081 在监听」蕴含「topic 已就绪」，healthcheck 天然成了闸门。别把这个顺序挪掉——
  挪到 `sh mqproxy` 之后一切照常工作，只是闸门没了、竞态窗口回来（v5 producer 启动期的
  路由查询不等 `autoCreateTopicEnable`，撞上就是起不来）。门禁
  `./platform/deploy/rocketmq-entrypoint-verify.sh`（用 mqbroker / mqproxy / mqadmin 替身
  读**真实发生顺序**，并有一条把顺序倒过来的反例证明断言不是恒真）。
- **行级解析器必须把「键名后的行内注释」当一等公民**。`  postgres:   # 注释` 是合法且常见的
  写法，但 `^  ([a-z0-9-]+):\s*$` 这类正则认不出它——而后果不是「跳过该服务」，是把它**整段
  并进前一个服务**，方向 fail-open。2026-09-20 在 `compose-ports-check.py`（真端口冲突被放行，
  standalone 解析到的端口项 20→24）与 `cluster-registry-check.py`（cluster-b 缺上报方被漏掉，
  standalone 解析到的服务 14→22）各踩到一次。四处已统一成 `(?:#.*)?$`；`edge-cors-check.py`
  另有一条「看到像服务却解析不了就喊」的兜底。
- 每个 compose 的 CI 冒烟：起得来 → 跑一个 headless 任务 → 正常退出。

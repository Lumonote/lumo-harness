# 桌面设备接入与运行

本文对应 Governance 设备网关与 `desktop-agent` 的源码实现。设备管理要求
`LUMO_DEPLOYMENT_MODE=cluster`、`LUMO_CLUSTER_STATUS=ready`，并显式启用设备网关。
管理界面位于原生 DSH Web 的 `/lumo/ops`；本地单机与服务器单例不开放此通道。

本轮已完成源码、管理界面、部署模板和文档核对，并通过 Governance/Registry 等相关 Go
模块的 build+vet 与 Lumo UI 定向 TypeScript 编译。以下命令供后续部署使用；运行测试、
浏览器验收、Compose/Helm 实际渲染和端到端联调仍按当前安排暂缓，待验证项目见文末。

## 入口与信任材料

设备主动向外建立 HTTPS/WSS 连接，不要求在设备上开放入站端口。默认网络路径为：

```text
desktop-agent
  -> devices.example.com:443 (TCP / TLS passthrough)
  -> device-gateway Service / Compose 18090
  -> Governance device-tls :8090

DSH Web -> Governance management :8089
Governance -> internal Registry :8084 / PostgreSQL
```

网关要求 TLS 1.3。激活请求可以没有客户端证书；续期、WebSocket 和制品读取接口要求
设备客户端证书。因此入口不能提前终止 TLS、强制所有请求先带客户端证书、改写为 HTTP，
或附加 PROXY protocol。`X-Forwarded-Client-Cert` 等请求头不能替代真实的 TLS 证书验证。

| 材料 | 保存位置 | 用途 |
| --- | --- | --- |
| 网关服务端证书与私钥 | Governance 的服务端 TLS 挂载 | 证书 SAN 匹配设备入口域名，Agent 验证服务器身份 |
| 设备签发 CA 证书与私钥 | Governance 的独立 issuer 挂载 | CA 必须具有 `IsCA` 与 `keyCertSign`，当前有效且至少剩余 1 小时 |
| 网关服务端 CA 证书 | 设备系统信任库，或 `-server-ca` 文件 | 只在使用私有服务端 CA 时显式配置 |
| 制品发布者信任文件 | 设备上的独立 `-trust-file` | 验证 Registry 签名，不从设备网关下发 |
| 设备私钥与客户端证书 | `-state-dir/identity.json` | Agent 本地生成 P-256 私钥并保存证书，网关只接收 CSR |

`-server-ca` 设置后使用该 PEM 文件中的信任根；文件需要包含实际服务端证书链的根。
设备签发 CA、网关服务端 CA 和制品发布者信任文件有不同职责，不能互相替代。
issuer 私钥始终留在服务端。客户端证书包含唯一的
`spiffe://lumo-device/realm/{realm}/node/{node_id}` URI，并与数据库中的公钥摘要和序列号绑定。

## Compose 入口

以仓库根目录为工作目录，准备一个已存在的绝对路径目录，其中包含
`server.crt`、`server.key`、`issuer.crt`、`issuer.key` 四个 PEM 文件。
Governance 镜像使用 UID 10001；目录遍历权限与文件读取权限必须允许该 UID，私钥应只允许
该服务账号读取。叠加文件只读挂载该目录，且不会自动创建空目录或生成证书。

在部署环境文件中增加以下值，原有 PostgreSQL、控制面令牌与 Registry 配置仍需保留：

```dotenv
LUMO_DESKTOP_GATEWAY_PUBLIC_URL=https://devices.example.com
LUMO_DESKTOP_TLS_DIR=/srv/lumo/device-tls
LUMO_DESKTOP_GATEWAY_BIND=127.0.0.1
LUMO_DESKTOP_GATEWAY_PORT=18090
LUMO_DESKTOP_ALLOWED_SCOPES=skills:use,kb:query
LUMO_DESKTOP_PROCESS_RUNTIME=false
```

`PUBLIC_URL` 应填写无路径、查询参数和片段的精确 HTTPS origin。使用非默认公网端口时
必须包含该端口，例如 `https://devices.example.com:18443`。默认宿主绑定为 loopback，
适用于本机 TCP 入口；独立负载均衡器需要把 `BIND` 改成它能访问的专用地址，并限制来源。
公网入口将 TCP 443 透传到宿主 18090。原管理端口 18089 只供受信任的控制面访问，
不能用作设备接入的目标端口。

已有镜像和基础集群就绪后，部署命令为：

```sh
docker compose --env-file platform/deploy/.env \
  -f platform/deploy/compose.cluster.yml \
  -f platform/deploy/compose.cluster.devices.yml \
  up -d --no-build governance
```

叠加顺序不能反转。后续更新 Governance 时也应携带这两个 `-f` 参数；通用 `up.sh`
目前只选择基础拓扑，不能用于保留此叠加配置。Compose 示例仍是单个 Governance 容器，
固定宿主端口不支持直接用 `--scale governance=2` 扩容。

## Helm 入口

在 release namespace 中预置两个 Secret。标准服务端 TLS Secret 包含 `tls.crt` 和
`tls.key`；独立 issuer Secret 包含 `ca.crt` 和 `ca.key`。已由证书管理系统创建这些
Secret 时直接引用其名称；手工导入现有材料的命令为：

```sh
kubectl -n lumo create secret tls lumo-device-server \
  --cert=/secure/device-server.crt --key=/secure/device-server.key
kubectl -n lumo create secret generic lumo-device-issuer \
  --from-file=ca.crt=/secure/device-issuer.crt \
  --from-file=ca.key=/secure/device-issuer.key
```

在现有生产 values 上叠加：

```yaml
service:
  type: ClusterIP
deviceGateway:
  enabled: true
  port: 8090
  publicUrl: https://devices.example.com
  tlsSecret: lumo-device-server
  issuerSecret: lumo-device-issuer
  allowedScopes: ["skills:use", "kb:query"]
  processRuntime: false
  service:
    type: ClusterIP
    port: 8090
```

`tlsCertKey`、`tlsKeyKey`、`issuerCertKey`、`issuerKeyKey` 可覆盖上述默认键名。
Chart 以 `0440` 挂载证书，并为启用设备网关的 Governance Pod 设置 `fsGroup: 10001`，
使镜像中的服务用户可读。设备 Secret 只挂载到 Governance，普通配置映射不包含私钥。
`registryUrl` 留空时使用本 release 的 Registry Service；关闭内置 Registry 时必须指定
可供 Governance 访问的内部 Registry URL，控制面令牌由现有 Secret 提供。

选择四层负载均衡器直接透传时，可以把 `deviceGateway.service.type` 改为
`LoadBalancer`、`deviceGateway.service.port` 改为 `443`，并通过
`deviceGateway.service.annotations` 配置云厂商的 TCP 监听。证书仍由 Governance 提供；
不要在负载均衡器上配置 HTTPS 终止或 PROXY protocol。主 `service.type` 保持 `ClusterIP`，
只公开专用设备 Service。

### Istio TLS passthrough

已安装 Istio ingress controller 时，在上述设备 values 上启用以下配置：

```yaml
serviceMesh:
  istio:
    enabled: true
    trustDomain: cluster.local
deviceGateway:
  service:
    type: ClusterIP
    port: 8090
  istioIngress:
    enabled: true
    port: 443
    selector:
      istio: ingressgateway
```

`trustDomain` 必须替换为实际 mesh trust domain；`selector` 必须匹配已有 ingress
workload。Chart 创建 `networking.istio.io/v1` 的 Gateway 和 VirtualService，不安装
ingress controller，也不为它新增 Service 端口。Ingress 的对外 Service 需要已开放
`istioIngress.port`，DNS 指向该入口。此模式按 SNI 路由，因此 `publicUrl` 必须使用 DNS
域名，并且公网端口与 `istioIngress.port` 一致，默认都是 443。

Gateway 资源创建在 release namespace。若 ingress controller 开启了
`PILOT_SCOPE_GATEWAY_TO_NAMESPACE`，其 workload 也必须位于同一 namespace；否则应关闭
Chart 的 `istioIngress.enabled`，由现有入口管理方式创建适配该集群的透传路由。

设备流量只匹配专用域名和 `device-gateway` Service 的设备端口。Governance 的设备
容器端口从 sidecar 入站捕获中排除，专用 DestinationRule 对设备 Service 设置
`tls.mode: DISABLE` 并导出到其他 namespace，避免跨 namespace ingress 发起额外的 mesh
TLS。这里关闭的是 mesh TLS 发起，原始客户端 TLS 始终保留；管理端口仍由现有 STRICT
workload mTLS 与控制面 Bearer 令牌保护。Ingress 无需持有设备 issuer 或服务端私钥。

### 多副本与证书更新

所有 Governance 副本必须共享 PostgreSQL、issuer 证书与私钥、网关服务端证书、公共
origin、Registry 地址、scope 白名单和进程策略配置。连接所有权、租约、策略 revision、
激活码摘要和命令状态保存在 PostgreSQL；WebSocket 只保存在当前连接所在的进程内。
负载均衡器无需粘性会话，但同一设备只能运行一个 Agent，不能把同一 `state-dir`
复制到另一台机器同时使用。

`replicaCount` 当前影响所有控制面服务。提升它之前还需满足各服务自身的共享存储要求，
尤其是 Registry 的制品对象存储；不能仅凭这个值宣称整个集群具备高可用能力。入口应允许
长时间 WebSocket，空闲超时应大于 30 秒。Pod 退出会断开当前连接，Agent 重连后重新验签
和收敛，原命令不会跨连接自动重放。

服务端 TLS 和 issuer 材料在 Governance 启动时读取，更新挂载文件或 Secret 后需要
重启对应容器或滚动重启 Governance Deployment。主健康探针仍访问管理端口的 `/healthz`，
它不能代替设备 TLS 握手、证书链或外部路由检查。

客户端证书最长有效 24 小时，且不晚于 issuer 到期时间。提前维护 issuer 有效期，
不能等到剩余不足 1 小时才续签。当前实现只加载一个设备签发 CA，不提供新旧 issuer
并行信任或无感 CA 轮换；更换 CA 需要安排维护窗口、统一更新所有副本并重新激活设备。
只更新同一受信任 CA 签发的网关服务端证书不会改变设备身份。

## 登记、策略与激活

1. 设备所有者登录运营面登记设备，填写真实 OS、架构和客户端版本。Agent 心跳报告
   `runtime.GOOS/GOARCH`，其中 `darwin` 映射为 `macos`；架构使用 `amd64`、`arm64` 等
   Go 值。重复登记会重置该设备的策略和身份，应通过设备详情管理日常状态。
2. Realm 管理员在设备详情中选择已发布制品的精确名称和版本，填写目标 Agent 版本及
   可用能力 `shape`。服务端从 Registry 解析整个依赖闭包，保存 manifest 与 payload 摘要，
   并检查所有 scopes 都在网关白名单内。`shape` 只接受 `olap`、`graph`、`vector`、
   `object`、`gpu` 布尔项。
3. 保存策略时携带详情中的当前 `revision`，首次通常为 0；成功后 revision 增加。
   发生 409 时重新读取详情后再修改。策略变化会中断旧连接与未完成命令，并使旧激活码失效。
4. 设备处于 `PENDING_ACTIVATION` 且已有非空策略时，所有者或 Realm 管理员签发激活码。
   返回的 `code` 仅展示一次，有效 300 秒；重新签发会替换旧码。通过受控方式把该值写入
   设备上只允许当前用户读取的文件，不放入 URL、日志或进程参数。
5. 用 Agent 完成首次激活与收敛。确认成功后移除激活码文件，常驻启动配置也应去掉
   `-enrollment-code-file`，后续使用保存的身份续期。

使用已分发、与设备策略版本一致的 `desktop-agent` 可执行文件，Linux 示例为：

```sh
desktop-agent \
  -gateway https://devices.example.com \
  -realm team-a \
  -node workstation-01 \
  -state-dir /home/operator/.local/state/lumo-device \
  -install-dir /home/operator/.local/share/lumo-artifacts \
  -trust-file /etc/lumo/publisher-trust.json \
  -shape '{"object":true}' \
  -client-version 0.1.0 \
  -enrollment-code-file /home/operator/.local/state/lumo-enrollment-code
```

私有服务端 CA 另加 `-server-ca /etc/lumo/device-server-ca.pem`。`state-dir`、
`install-dir` 和 `trust-file` 必须使用绝对路径，身份目录与安装目录不可重叠，信任文件
不能放入安装目录。身份目录不得是符号链接；Agent 将它设置为 `0700`，身份文件原子
写入并设为 `0600`。`shape` 应反映本机实际能力，且不能请求超出已批准策略的能力。
`client-version` 默认 `0.1.0`，它必须与设备策略一致。

Agent 不携带 `LUMO_CONTROL_PLANE_TOKEN`。它仅通过受设备策略约束的网关路径读取签名
计划及批准闭包的 blobs，在本机独立验证发布者信任、manifest 签名、摘要和 payload。
只有活跃连接、正确 OS/架构/客户端版本以及完整安装摘要共同满足当前策略时，设备才为
`ONLINE`。设备在线本身不会赋予通用 Scheduler 调度资格。

## 租约、续期与断线恢复

Agent 每 10 秒发送心跳；每次被接受的心跳将连接租约延长到 30 秒。网关每 2 秒发送
状态并核对连接所有权、证书与策略 revision。没有状态数据或心跳超过读取期限时连接
会结束。重新连接会取得新的连接标识、清空已应用 revision，并重新收敛制品；本地私钥
和安装目录保留。

Agent 在客户端证书剩余不超过 1 小时时结束当前连接，用同一私钥生成 CSR 发起
`POST /device/renew`，保存返回证书后重新建立 WSS。更新证书会使旧连接失效。若续期
响应丢失，服务端允许用上一张证书在最多 5 分钟内重取同一张新证书，且不能超过旧证书
本身的到期时间；旧证书仅能用于这个续期重试，不能用于命令或制品读取。

断线、策略改变、证书切换或 Agent 退出时，本轮受控进程会被停止。恢复后不会自动重启
此前的进程；设备所有者应核对命令结果后明确重新下发。Agent 保留本地命令领取记录，
避免同一个命令 ID 再次执行。

证书已经过期、设备身份文件丢失或激活响应丢失而无法恢复时，由管理员将设备置为
`PENDING_ACTIVATION`、确认策略后重新签发激活码。保持原身份文件时也需要显式带上新
`-enrollment-code-file` 才会再次激活。`DRAINING` 禁止新的启动操作；`REVOKED` 为不可恢复
状态，恢复使用需要登记新的设备 ID 和身份。用户被停用后，其设备同样无法继续通过认证。

## 命令与本地进程

设备命令只有 `reconcile`、`start`、`stop`，请求必须带当前策略 `revision`；后两者还需
提供已批准闭包中的精确 `name` 和 `version`。命令绑定当时的连接与 revision，有效
5 分钟，每台设备最多 16 条未完成且未过期命令。重连、租约结束、策略变化或吊销会
中断旧命令，不跨连接重放。命令记录显示最近 50 条，包含动作、revision、创建和到期
时间、状态与返回结果。`completed` 表示该动作完成；`start` 完成并不表示进程会永久运行。

进程运行默认关闭。启用时需要同时满足：

- 网关 `processRuntime=true`，并填写 `policyUrl` 指向明确的 OPA 布尔决策端点。
- 请求人是设备所有者，设备已经按当前策略收敛且为 `ONLINE`。
- OPA 对 `desktop.runtime.start` 返回 HTTP 200 与 `{"result":true}`，输入包含 actor、
  realm、node_id、制品摘要、scopes 和 revision。
- Agent 通过 `-allow-runtime-digests` 明确列出允许执行的完整 manifest 摘要。
- 制品是已验签的 Component，入口、参数与 runtime 声明来自签名 manifest。

`-allow-runtime-digests` 接受逗号分隔的 `sha256:` 摘要；制品升级改变摘要后必须重新取得
本地许可。`-max-runtime` 默认 `1m`，最大 `5m`。进程只执行固定的本地 manifest 入口，
接口不接受任意 shell、环境变量、挂载或容器规格。`reconcile` 不启动进程；`stop` 用于
结束指定已批准制品的受控进程。

## 接口边界

运营面代理的前缀为 `/lumo/api/desktop-nodes/{nodeID}`，由登录会话验证身份并在服务端
调用 Governance。下表列出对应的内部 API；这些路径不由设备 TLS 监听提供。

| 内部管理 API | 内容 |
| --- | --- |
| `GET /v1/desktop-nodes/{nodeID}/device` | 设备、策略、租约、证书时间、网关地址和当前操作权限 |
| `PUT /v1/desktop-nodes/{nodeID}/device/policy` | 管理员提交 `revision/name/version/client_version/shape` |
| `POST /v1/desktop-nodes/{nodeID}/device/enrollment` | 签发一次性激活码，返回 `expires_in/realm/node_id/gateway_url` |
| `GET /v1/desktop-nodes/{nodeID}/device/commands` | 最近命令与执行结果 |
| `POST /v1/desktop-nodes/{nodeID}/device/commands` | 提交 `revision/action`，按动作附带 `name/version` |
| `PUT /v1/desktop-nodes/{nodeID}/state` | 管理员提交 `PENDING_ACTIVATION`、`DRAINING` 或 `REVOKED` |

设备 TLS 接口为 `POST /device/enroll`、`POST /device/renew`、
`GET /device/connect`（WebSocket）、`POST /device/registry/v1/plan` 和
`GET /device/registry/v1/blobs/{digest}`。连接接口拒绝带浏览器 `Origin` 的请求；浏览器
管理面始终通过正常的登录会话和运营面代理操作。

## 待验证项目

- Compose 叠加与不同 Helm 开关组合的实际渲染，包括缺少 Secret、端口冲突和错误 origin。
- 外部 DNS、完整 TLS 证书链、首次无客户端证书激活、后续 mTLS 与 WebSocket 长连接。
- Istio 跨 namespace ingress、SNI、DISABLE DestinationRule 与管理端口 STRICT mTLS 隔离。
- UID 10001 对 Compose 绑定目录、Kubernetes Secret 的真实读取权限，以及证书更新后的滚动重连。
- 多 Governance 副本、Pod 异常退出、30 秒租约失效、跨副本接管与数据库异常恢复。
- 续期临界时间、响应丢失后的重放窗口、证书到期重新激活、CA 更换维护流程。
- 命令到期、旧 revision、断线时结果不确定、设备吊销、本地许可与 OPA 拒绝行为。
- 不同 OS/架构的 Agent 制品安装、文件权限和进程退出行为，以及管理界面在真实设备上的浏览器验收。

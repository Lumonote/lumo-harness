# 持久恢复审批与密钥执行协议

Governance 的正式管理 API 使用 PostgreSQL 持久工作流；旧 `internal/breakglass.Store` 仍是独立的内存合同，没有任何生产执行权限。迁移 `026_governance_recovery_workflow.sql` 与服务启动 DDL 同步创建请求和独立审计表，重启与多副本共享状态。

## 授权与状态

管理入口仅在健康、明确声明 ready 的 Cluster 开放。请求人、审批人、执行人都必须是当前 Realm 的活动目录用户，并持有未过期、活动的**直接** `platform_admin`、`realm_admin` 或 `admin` 授权。外部请求头的旧管理员名称和继承管理员均不能替代事务内目录复验。Realm 组织锁串行化审批、执行 claim 与组织撤权。

一次请求需要两位不同管理员：提出人不能审批，审批人不能执行；提出人可以执行。执行开始时重新验证提出人、审批人、执行人当前直接授权。回执查询不触发外部执行，因此当前直接管理员（包括原审批人）可核对已发出的操作，不要求历史参与者仍在职；原执行人归因不变，核对人另写审计。

创建后，Realm、操作、目标命名空间、目标 ID、恢复点、原因、提出人、有效期、执行服务、部署策略摘要及稳定执行 ID 均没有修改 API。`request_digest` 为这些事实的 SHA-256 摘要。审批、撤销、执行与回执请求必须携带所见摘要和 `expected_revision`，防止审批错误目标或覆盖并行状态。审批有效期为创建时一分钟至 24 小时；页面使用 2 至 1440 分钟。

```text
pending → approved → executing → succeeded
   ↓          ↓          ↓
revoked     revoked    failed / uncertain
expired     expired       ↓
                        retry / receipt
```

只有受信服务签名的 `rejected` 回执表示确定未执行，落 `failed`；可在有效期内重试或撤销。HTTP 超时、非 200、无效/伪造/不匹配回执、服务错误、`pending` 或 `not_found` 均落 `uncertain`，不会伪装为未执行或完成。`executing` 和 `uncertain` 不能宣称已撤销。到期后的未知操作只可查回执，不能发出新的 execute。未分发的 pending/approved/failed 请求在读取或操作时持久转为 expired，并写一次审计。

Claim 持有 45 秒租约、随机 claim token 的 SHA-256 与递增 `fencing_token`，token 不返回管理 API。外部 HTTP 最多 10 秒，断开浏览器仍在有限时间内持久化结果。崩溃导致 claim 无结果时，租约到期后可重新 claim；旧 claim 的完成写入会被 fencing/token/lease CAS 拒绝。`execution_id` 与 `Idempotency-Key` 始终不变。已完成请求重放直接返回数据库回执，不再调用执行服务。

这些机制**不承诺 HTTP 副作用恰好一次**。生产执行服务必须按稳定幂等键持久去重、按 fencing token 拒绝旧请求，并支持结果查询；网络超时可能发生在实际操作已完成之后。新 fencing token 只防旧调用覆盖结果，不能单独撤销已经发往 KMS 或备份系统的动作。

## 部署配置

全部默认空，未配置时创建/执行返回 503，历史记录仍可查。任一部分配置非空而其余缺失，或配置不合法，Governance 拒绝启动。

| 环境变量 | 内容 |
| --- | --- |
| `LUMO_RECOVERY_PROVIDER_ID` | 固定服务 ID，例如 `tenant-recovery` |
| `LUMO_RECOVERY_PROVIDER_URL` | 固定可信 HTTPS 基础地址，例如 `https://recovery.internal/v1/recovery`；仅本机协议测试可用 literal loopback IP 的 HTTP 地址；不允许内嵌凭据、query、fragment、路径遍历或末尾斜线 |
| `LUMO_RECOVERY_PROVIDER_TOKEN` | 独立服务 Bearer 凭据；通过 Secret 注入 |
| `LUMO_RECOVERY_RECEIPT_KEY` | 至少 32 字节的 Base64 HMAC-SHA256 回执校验密钥；通过 Secret 注入 |
| `LUMO_RECOVERY_OPERATIONS` | 明确允许的 `restore`、`key_destroy` 逗号列表；只配置 restore 不会启用密钥销毁 |
| `LUMO_RECOVERY_TARGET_SCOPES` | JSON 数组，如 `[{"operation":"restore","realm":"tenant-a","namespace":"backups","prefix":"tenant-a/"}]`；每项绑定 operation、精确 Realm/命名空间及非空目标前缀；不能跨操作套用范围 |

`compose.control-plane.bundle.yml` 将上述宿主环境变量传入 Governance 子进程，未设置时保持空值。Helm 使用 `governance.recoveryProvider`，默认 `enabled: false`；启用时须配置 `id`、`url`、非空 `operations`/`scopes` 及已存在的 `credentialsSecret`。服务 token 和回执密钥分别由该 Secret 的 `tokenKey`（默认 `token`）和 `receiptKeyKey`（默认 `receipt-key`）读取，不写入 values 或 ConfigMap。Chart schema 在渲染时拒绝空白必填项、未知 operation 与 scope 字段，服务启动时再次执行精确策略校验。

目标和恢复点为有限长度 opaque ID，不接受密钥材料或连接凭据。接口不接收 provider URL、token、回执密钥或任意回调地址。执行服务 ID、endpoint、操作和目标范围构成部署策略摘要；更换范围或地址会使旧请求无法继续执行，须新建审批。凭据轮换不改变策略摘要，但旧请求的回执仍须通过当前校验密钥。

密钥销毁必须单独明确列入 operations，同时为 `operation: key_destroy` 配置对应 Realm、密钥命名空间和 prefix，不能套用恢复操作的目标范围，也不能仅靠 Realm 管理员输入任意 key ID。生产服务仍须验证 opaque ID 的真实租户归属、目标白名单、法务冻结、保留策略、恢复点有效性，以及目标 KMS 的原生授权。此版本提供受限协议；没有附带默认生产执行服务，也未执行真实密钥销毁。

## HTTP 协议 v2

Governance 仅向固定基础地址发送 `POST {base}/execute` 或 `POST {base}/receipt`。两者 `Content-Type: application/json`，带独立 Bearer 服务凭据与稳定 `Idempotency-Key: lumo-recovery:{execution_id}`。重定向被拒绝。`receipt` 必须是无副作用查询，不得在找不到结果时启动执行。

```json
{
  "version": "lumo.recovery.v2",
  "provider_id": "tenant-recovery",
  "request_id": "recovery_...",
  "realm": "tenant-a",
  "operation": "restore",
  "namespace": "backups",
  "target_id": "tenant-a/database-1",
  "recovery_point": "snapshot-20261107",
  "request_digest": "<64 hex>",
  "execution_id": "execution_...",
  "idempotency_key": "lumo-recovery:execution_...",
  "fencing_token": 1,
  "mode": "execute",
  "expires_at": "2026-11-09T13:00:00Z"
}
```

执行服务返回 HTTP 200，直接返回 JSON receipt；最大 32 KiB。receipt 包含原请求所有字段，字段必须逐项匹配当前 claim，再增加：

```json
{
  "outcome": "succeeded",
  "receipt_id": "opaque-durable-receipt-id",
  "completed_at": "2026-11-07T05:00:00Z",
  "signature": "<base64url without padding>"
}
```

`outcome` 闭集为 `succeeded / rejected / pending / not_found`。所有响应都要签名，包括未知/未找到状态。`completed_at` 为回执生成时刻，不能为空或超前超过一分钟。`rejected` 必须保证该稳定 execution 没有发生副作用；服务对已经完成的 execution 不能随后返回 rejected。

签名为 HMAC-SHA256，密钥由 Base64 标准编码配置值解码。签名字节为 `breakglass.Receipt` 定型 JSON 的编码，先将 `signature` 设为空字符串。实现以 `encoding/json.Marshal` 保持以下**字段顺序**：

1. `version, provider_id, request_id, realm, operation, namespace, target_id`；
2. 非空时的 `recovery_point`（key_destroy 应省略）；
3. `request_digest, execution_id, idempotency_key, fencing_token, mode, expires_at`；
4. `outcome, receipt_id, completed_at, signature`（此时为空字符串）。

时间使用 UTC RFC3339Nano，JSON 字符串采用 Go `encoding/json` 默认转义（包括 `< > &`；可直接复用 `breakglass.SignReceipt` 作为参考实现）。签名结果为不带 padding 的 Base64URL。管理服务拒绝未知字段、多段 JSON、无签名、错误签名、其他 Realm/目标/摘要/执行 ID/fence/mode 的回执，错误内容不会原样进入状态或日志。

生产服务收到同幂等键的更高 fence 时，若操作已发生，应重新签发绑定当前请求 fence/mode 的回执，返回同一个持久操作结果；不得重新执行副作用。完成回执证明的是受信服务的声明，实际 KMS/备份结果证明与生产验收必须由所接入的服务保证。

## 管理 API 与页面

| 接口 | 功能 |
| --- | --- |
| `GET /v1/recovery-requests` | 当前 Realm 最近 100 条请求及当前服务能力，不返回 URL/凭据 |
| `POST /v1/recovery-requests` | 创建请求；body 为 operation、namespace、target_id、可选 recovery_point、reason、expires_at |
| `GET /v1/recovery-requests/{id}` | 当前状态与最近最多 500 条审批/执行审计 |
| `POST /v1/recovery-requests/{id}/approve` | 另一位当前直接管理员审批 |
| `POST /v1/recovery-requests/{id}/revoke` | 撤销尚未执行或已明确拒绝的请求 |
| `POST /v1/recovery-requests/{id}/execute` | 领取执行、调用受信服务、保存已验证回执 |
| `POST /v1/recovery-requests/{id}/receipt` | 对已领取的执行查询回执，不产生新操作 |

四个动作 body 均为 `{ "expected_revision": 2, "request_digest": "..." }`。跨 Realm 请求无法读取或修改。API 不授予临时管理员凭据，也不提供任意恢复命令执行。UI 入口位于集群管理的“恢复审批”，可按请求 ID 查找历史记录，展示不可变目标/摘要、版本、审批记录、回执；审批人无法执行，自审批按钮隐藏，密钥执行另要求输入完整目标 ID。版本冲突或未知错误后必须刷新再操作。

## 验收边界

测试使用独立 PostgreSQL schema 和本机 `httptest` 假服务，覆盖双人、CAS、撤权等待锁、过期/撤销、租约回收、旧 executor fencing、稳定幂等 ID、签名错误/范围错配/超大响应/重定向拒绝、超时未知结果与回执恢复。假服务只生成签名测试回执，没有真实 KMS 或备份执行能力。

正式目标 KMS、真实备份恢复、法务留存策略、服务端幂等/fencing 的原生实现，以及审批有效期/租约的生产参数，仍需指定目标环境后单独验收；不能从假服务测试推断生产完成。


## v2 执行期限与历史回执

恢复 Provider 协议现为 `lumo.recovery.v2`：请求与签名回执携带已批准的 `expires_at`（UTC RFC3339），适配器在执行前使用自己的权威时间复验。`receipt` 是只读核对，允许过期后查询，不能重做动作。

迁移 046 与服务启动 DDL 为历史记录增加 `provider_protocol='lumo.recovery.v1'`；新请求明确写 v2。旧 v1 请求不能重新 execute，也不悄悄升级批准。旧已执行/未知请求仍可通过原 v1 协议、原策略摘要、原 HMAC 正文做 receipt 核对；目标与部署 allowlist 变化仍拒绝。旧尚未执行请求应撤销后创建并重新双人批准 v2 请求。参考 frozen snapshot clone Provider 仅接受 v2，不伪造其未执行过的 v1 回执。

可运行的有限参考实现和真实环境边界见[冻结快照克隆 Provider](frozen-snapshot-provider.md)。

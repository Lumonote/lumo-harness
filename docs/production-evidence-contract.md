# 生产验收证据合同

`platform/deploy/production-evidence.py` 是只读的版本、范围、完整性和时效门禁。
它不执行故障、恢复或密钥销毁，也不把操作人员填写的观察认证为真实事实。
生产 preflight 现在要求该门禁通过后才读取目标集群的 Secret 和执行 API dry-run。

## 策略

策略与目标部署一起审核，固定 platform/upstream 两个完整 Git SHA；更新平台、上游或
基础环境后重新收集证据。preflight 从当前仓库和 `deepseek-harness` checkout 读取实际
HEAD，与策略逐项比较，并拒绝已跟踪源码的本地修改。示例中的 SHA 必须替换，阈值由业务确定。
策略还固定目标集群 `kube-system` Namespace 的 `metadata.uid`（`cluster_uid`）。
preflight 捕获一次当前 kubectl context，后续所有 API 操作显式使用该 context；
实际 UID 必须匹配策略，才允许读取部署 Secret 或执行服务端 dry-run。
镜像摘要与构建出处仍须由运维核对；源码版本一致不自动证明远端镜像或已运行工作负载一致。

```json
{
  "schema_version": "lumo-production-evidence-policy/v1",
  "environment_id": "production-cn",
  "cluster_uid": "11111111-2222-3333-4444-555555555555",
  "namespace": "lumo",
  "release": "lumo",
  "platform_commit": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "upstream_commit": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "max_age_days": 7,
  "max_rpo_ms": 1000,
  "max_rto_ms": 60000,
  "require_idp": true,
  "require_kms": false
}
```

`require_kms: false` 只表示该部署未交付密钥销毁能力；不能用于启用了密钥销毁的生产环境。
`require_idp` 同理。证据策略须与实际部署能力由运维审核配对。
`cluster_uid` 示例也必须替换为经运维确认的目标值；可用
`kubectl --context "$KUBE_CONTEXT" get namespace kube-system -o jsonpath='{.metadata.uid}'`
读取。重建该 Namespace 后应更新策略并重新取证，不能仅凭相同 namespace/release 名称复用旧证据。

## 观察文件

顶层精确包含 `schema_version: lumo-production-observations/v1`、策略中的六个身份字段
`environment_id/cluster_uid/namespace/release/platform_commit/upstream_commit`、`hosts` 和 `checks`。

`hosts` 至少两个，包含唯一 `host_id`、实际 `failure_domain`、独立 `volume_id`。
同一 Docker daemon 下不同容器不能填写成不同物理故障域。观察与证据不应包含 DSN、令牌、
密钥或用户内容；使用只含必要状态、摘要和计数的经过脱敏的服务端回执。

每项 check 的精确结构：

```json
{
  "scenario": "lease_fencing",
  "status": "blocked",
  "started_at": "2026-11-09T00:00:00.000Z",
  "finished_at": "2026-11-09T00:00:01.000Z",
  "host_ids": ["node-a", "node-b"],
  "observed": { "stale_writer_rejected": false, "duplicate_execution": false },
  "evidence": [{ "path": "fencing/receipt.json", "sha256": "填写文件字节的64位SHA256" }]
}
```

示例明确为 blocked，不能通过。真实通过须来自实际环境；保留所有失败与不确定结果。
时间使用含三位毫秒的 UTC 格式。证据文件必须位于显式 bundle 根目录，非空、至多16 MiB，
所有路径组件禁止符号链接、绝对路径和 `..`；整次验证读取至多64 MiB。
验证器不读取远程链接或执行文件。

## 必验矩阵

| scenario | observed 必须具有的字段及通过值 |
| --- | --- |
| lease_fencing | stale_writer_rejected=true, duplicate_execution=false |
| session_migration | history_equal=true, attachments_equal=true, old_owner_rejected=true, input_replayed=false |
| network_partition | stale_writer_rejected=true, split_brain=false, recovered=true |
| database_failover | acknowledged_writes_preserved=true, reconnected=true |
| pitr_restore | snapshot_verified=true, independent_target=true, rpo_ms/rto_ms 为实际测量的非负整数且不超过策略 |
| application_recovery | login/conversation/attachments/permissions/metering 均为 true |
| certificate_rotation | new_certificate_accepted=true, retired_certificate_rejected=true |
| capacity_slo | error_budget_met/latency_slo_met/capacity_met 均为 true |
| oidc_login（策略启用时） | login/revocation/key_rotation/replica_consistency 均为 true |
| kms_key_destroy（策略启用时） | two_person_approval/exact_target/signed_receipt_verified/readback_absent 均为 true |

前五项中的每个场景均要求至少两个主机身份，且这些主机实际覆盖至少两个故障域和独立卷。
未知字段、重复场景、缺少文件、摘要不一致、过期、不完整或
非 passed 状态拒绝通过。不能把快照克隆、模拟服务或本地 Docker 演练称为生产 PITR/HA。

```sh
python3 platform/deploy/production-evidence.py --policy ops/evidence-policy.json \
  --observations ops/observations.json --root ops/evidence-bundle > ops/evidence-report.json
```

退出码：0 表示合同及证据完整性满足，2 表示观察未达门禁，1 表示输入无效。输出只包含摘要、
文件名和错误码，不反射文件正文。保留 `operator-observations-not-independently-attested` 标识，
不得将其改写为自动完成生产认证。

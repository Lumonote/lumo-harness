# 冻结快照克隆参考 Provider

`platform/control-plane/governance/cmd/recovery-provider` 是显式启用的独立 Go 服务，经 `lumo.recovery.v2` 接收 Governance 已双人批准的恢复请求，并返回相同执行身份的 HMAC 回执。它只把同一 PostgreSQL 实例中由操作者预先冻结的快照库克隆到指定的新库；不执行 PITR、不替换原库、不跨实例复制、不删除目标，也不会终止其他会话。部署清单默认不启动它。

## 配置与运行

服务启动必须指定配置文件，不从请求或环境推断生产目标：

```json
{
  "id": "reference",
  "system_identifier": "从目标实例 pg_control_system() 取得的值",
  "routes": [
    {
      "realm": "tenant-a",
      "namespace": "snapshots",
      "target_id": "tenant-a/recovery-20261109",
      "recovery_point": "snapshot-20261109",
      "source_database": "frozen_snapshot_20261109",
      "source_oid": 123456,
      "source_marker": "操作者生成并登记的64位小写十六进制快照标识",
      "target_database": "recovery_20261109"
    }
  ]
}
```

每条逻辑路由（Realm、namespace、target、recovery point）和每个物理目标库都必须唯一。数据库名仅允许小写字母、数字和下划线，最长 63 字节。源库 OID、marker 和 frozen 状态在创建前后核对，数据库集群 system identifier 在每次处理时匹配配置；回执使用持久化的目标 OID 和执行 marker 核对。配置变更不能借旧执行获得新目标。

操作者先完成快照内容验证、记录来源和冻结点，再将来源库的 `ALLOW_CONNECTIONS` 设为 false，并登记库注释 `lumo-frozen-snapshot:<source_marker>`。marker 是操作者的来源声明，不是平台自动计算的全库校验和；Provider 不替操作者冻结活库。源库有遗留连接时 PostgreSQL 可以拒绝克隆，Provider 不强制踢出连接。来源实例/快照的管理员必须保证冻结身份期间不修改、删除或重新开放源库；该参考实现不防御拥有同等 PostgreSQL 管理权限的对手。

使用独立的 ledger 数据库配置 `LUMO_RECOVERY_ADAPTER_PG_DSN`；该数据库不能是任一路由的源或目标。凭据需要连接 ledger、创建目标库、以 frozen source 为 template、设置新库注释及读取 `pg_control_system()` 的能力，应由部署方按 PostgreSQL 版本配置最小权限。

```sh
# 在 platform/control-plane/governance 下
go build -o /path/recovery-provider ./cmd/recovery-provider
# 通过受保护的环境注入以下变量，文件/日志不放真实凭据：
# LUMO_RECOVERY_ADAPTER_PG_DSN, LUMO_RECOVERY_PROVIDER_TOKEN (至少32字符),
# LUMO_RECOVERY_RECEIPT_KEY (至少32字节的base64密钥)
/path/recovery-provider --config /path/approved-routes.json --listen 127.0.0.1:8098
```

非回环监听要求完整 mTLS 配置，使用现有 `LUMO_TLS_CERT_FILE`、`LUMO_TLS_KEY_FILE`、`LUMO_TLS_CLIENT_CA_FILE`。Governance Provider endpoint 指向此服务的基础地址，其 operation 仅配置 `restore`，scope 与路由的 Realm/namespace/target 前缀一致。客户端不能提供 SQL、命令、DSN、URL 或文件路径。

## 执行、期限与结果未知

1. 服务校验精确请求身份、v2 期限、部署路由与集群身份，取得目标名的 PostgreSQL session advisory lock。
2. 在独立 ledger 持久写入 execution、请求与路由摘要、target、fence 和 claimed 后，才可能发起 `CREATE DATABASE ... TEMPLATE ...`。
3. claim 落库后再次读取数据库时钟、源 OID、marker 和 frozen 状态。执行剩余时间作为数据库 `lock_timeout` 和 `statement_timeout` 上限（另限制 25 秒）。所有 DDL 使用固定语句和严格标识符。
4. 克隆完成后再次检查来源身份，写入绑定 execution/route 摘要的新库 marker，重新连接目标验证可读，再持久完成回执。

`CREATE DATABASE` 不能和 ledger 写入处于同一事务，因此不能宣称跨系统原子恢复。批准期限约束执行发起，数据库执行时限按发起前剩余时间限制；网络与调度边界不能被描述为严格零时差。claim 后进程崩溃、响应丢失、DDL 超时、既有目标无执行 marker、OID 变化等均保留 `pending`。同一 execution 再次 execute 只核对，不自动创建、覆盖或补写 marker。人工处理必须先核对 PostgreSQL 事实与审计，不删除 claim 来重放。

`receipt` 不执行 CREATE/DROP/ALTER/COMMENT，不因查不到结果而恢复。它只读目标/marker 并更新 ledger 的 fence/核对状态；允许批准期限过后查询。低 fence、请求摘要变化或路由变更被拒绝。不同执行争抢同一目标只能有一个持久 claim，未标记的既有目标永不接管。

历史 v1 协议只供原 Provider 对旧执行进行回执核对，本参考 Provider 仅接受 v2；详见[恢复协议升级](recovery-workflow-provider-2026-11-07.md)。

## Vault transit 只读核对

同一二进制提供独立的只读工具：

```sh
# target.json: {"endpoint":"https://vault.example","mount":"transit","key":"tenant_key"}
# token只经 LUMO_VAULT_READBACK_TOKEN 注入
/path/recovery-provider --vault-readback /path/target.json
```

该命令只向精确 HTTPS endpoint 发一次 GET `/v1/<mount>/keys/<key>`，拒绝重定向、凭据 URL、路径注入与过大回执。输出精确目标、观测时间、present/absent 和版本事实；404 只表示 absent，不能证明已销毁。它不配置删除、不开启 deletion_allowed、不发 DELETE/POST，也不产生可使 `key_destroy` 工作流完成的签名成功回执。真实 Vault/KMS、生产租户销毁仍需独立审批与目标适配。

## 验证范围

真实 PostgreSQL 测试使用每项独立的 source、ledger、target 库，验证实际数据克隆、HTTP/HMAC、claim 后崩溃、已创建无 marker、并发执行、source OID/marker/frozen 与路由变更、claim 等待后过期、低 fence 和 receipt 无 DDL。测试销毁的仅是自行创建的 fixture 数据库。Vault 协议测试为 HTTP fixture，只证明 GET-only 合同，不是生产 Vault 验收。

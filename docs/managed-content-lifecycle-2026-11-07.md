# 托管内容生命周期（2026-11-07）

## 2026-11-09 任务产物与冷日志扩展

`managed-content/v1` 现在覆盖新知识文件、任务产物与冷日志段三类生产者，引用种类分别为 `knowledge-file`、`task-artifact` 和 `cold-log-segment`，迁移 036 同步升级共享词表。

任务产物由服务端预留 ID，完成时在 Governance 的原事务内校验对象、计入配额并 pin；按当前摘要撤回时，同事务写审计、释放配额和引用。撤回不是直接删除 MinIO 对象，未知完成结果也不会绕过活动引用回收。

冷日志每页最多 1,000 条，同一会话的参与进程用 PostgreSQL advisory lock 串行决定段范围。迁移 042 的冻结计划在外部上传前独立提交，上传成功但归档元数据提交失败时，重启先恢复同一计划；新增事件或改变分页大小不能重新分配原范围。归档元数据与引用 pin 同事务提交。

迁移 039 增加持久退役墓碑。托管段过期时同事务 release，实际删除继续遵守托管 GC 的独立保留期、宽限和显式开关；旧段保留既有对象删除协议。两种段都不能从仍存在的热日志自动复活。读取始终要求已提交 PG 元数据，并核对完整字节、哈希、会话、范围和条数；旧段正文或侧车丢失会返回完整性错误，不能静默当作空历史。

Session 附件、Spill、备份和旧共享 `content/` 的完整引用历史仍不在这套自动物理回收范围。下方保留最初知识文件合同，后续扩展不改变未知引用必须保留的原则。

服务器形态的知识资料新上传使用独立命名空间
`<realm>/managed-content/v1/<object UUID>/<sha256>`。每次上传创建独立对象，内容哈希用于校验身份；相同字节不会隐式合并到旧 `content/` 对象。旧对象没有完整引用历史，始终不参与这套物理回收。

## 持久真源与事务边界

迁移 `025_managed_content_lifecycle.sql` 创建 `managed_content_objects` 和 `managed_content_references`。对象存储 Provider 也会在受 advisory lock 保护的启动事务中幂等建表。PG 是唯一生命周期真源，MinIO 不通过扫描推断引用数。

上传先提交 `uploading` 保留，再执行 MinIO 写入，明确成功后才提交 `ready`。知识文件元数据创建与引用 pin 在同一 PG 事务提交；文件删除、资料源清理、索引 outbox 和引用 release 同事务完成。上传来源创建失败时，内部补偿先清理已创建的资料元数据并释放引用，再尝试放弃上传保留。补偿遇到已有活动引用会保留对象。

资料 Provider 必须声明支持原子托管事务。对象存储已启用托管能力而资料 Provider 不支持时，上传明确返回不可用，避免创建没有可靠引用的对象。未装配托管对象存储的旧接口继续兼容旧内容路径。

普通对象存储 `put/delete` 拒绝 `managed-content/` 保留前缀，只有生命周期内部写入和删除路径可修改该命名空间。浏览器资料响应不返回原始对象键，也没有面向浏览器的 GC 接口。

## 状态与故障行为

| 状态 | 含义 | 自动处理 |
|---|---|---|
| `uploading` | 外部写入尚未确认，包括失败、超时、进程退出或提交结果不明 | 保留对象及上传保留，不自动过期；同一上传标识不能再次写入 |
| `ready` 且有活动引用或上传保留 | 资料正在使用，或尚未完成元数据落库 | 不回收 |
| `ready` 且零引用、无上传保留 | 已释放或明确放弃的上传 | 超过最小保留期及释放宽限期后成为候选 |
| `deleting` | 删除栅栏已经持久提交 | 拒绝所有新 pin；外部删除失败、超时或最终提交结果不明时，只允许相同对象键幂等重试 |
| `deleted` | MinIO 删除已经返回成功且 PG 完成终态提交 | 不复用对象键、上传标识或已释放的引用标识 |

超时并不代表 MinIO 请求已取消。禁止重写 pending 对象可避免第一次请求迟到，在后续上传完成并回收后重新生成对象。pending 对象需要运维核对外部结果；当前没有自动恢复为 ready 或自动删除 pending 的入口，新的业务上传应使用新的服务端上传标识。

回收先锁定对象、检查 revision、存储身份、保留期和活动引用，再提交 `deleting` 状态及有时限的删除租约，之后才调用 MinIO。pin 与 release 也锁同一对象行；并发 pin 被跳过或看到已持久的删除栅栏。外部删除成功但 PG 提交结果不明，不会让对象重新进入 ready。多副本通过行锁、`SKIP LOCKED`、revision 和租约协调，同一不可变键的重复删除可安全重试。

## 配置与启用

物理删除默认关闭。节点每 60 秒调用托管 collector，关闭删除时仅计算候选；host seam 的 `candidates()` 与 `collect()` 可用于内部运维，未开放通用 HTTP 删除接口。

| 配置 | 默认值 | 范围 |
|---|---|---|
| `LUMO_MANAGED_CONTENT_STORE_ID` | `minio:<endpoint>:<port>/<bucket>`；Compose 为 `lumo-compose-objects` | 非空，最长 256 字符；同一存储所有副本相同，独立存储必须不同 |
| `LUMO_MANAGED_CONTENT_GC_ENABLED` | `false` | 只有精确 `true` 开启物理删除 |
| `LUMO_MANAGED_CONTENT_RETENTION_MS` | `604800000`（7 天） | 0 到 3650 天 |
| `LUMO_MANAGED_CONTENT_GRACE_MS` | `86400000`（1 天） | 0 到 3650 天 |
| `LUMO_MANAGED_CONTENT_IO_TIMEOUT_MS` | `30000` | 100 到 120000 毫秒 |
| `LUMO_MANAGED_CONTENT_GC_INTERVAL_MS` | `60000` | 1000 到 2147483647 毫秒 |

保留期和宽限期写入每个对象，不会因部署参数变短而缩短已有对象的保护时间。Helm 位于 `objectStore.managedContent`，字段分别是 `storageId`、`deleteEnabled`、`retentionMs`、`graceMs`、`ioTimeoutMs`、`gcIntervalMs`；Compose standalone 和 cluster 已透传对应环境变量。

同一个桶通过不同 DNS 别名访问时，必须显式设置相同稳定 `storageId`；默认派生值不同会拒绝复用该上传标识并使另一存储身份的对象不被回收。将对象迁往另一个桶前，需要单独设计并核对持久身份迁移，不应只复用旧 `storageId` 使新 Provider 对另一存储执行回收。多个独立 Compose 部署若共用数据库，也必须覆盖默认存储身份。

启用前可通过 PG 只读检查候选，例如为当前 realm 和 store 绑定参数执行：

```sql
SELECT object_id, object_key, state, collect_after
FROM managed_content_objects o
WHERE realm = $1 AND storage_id = $2
  AND reservation_active = false AND state IN ('ready', 'deleting')
  AND unreferenced_at IS NOT NULL AND collect_after <= now() AND retain_until <= now()
  AND NOT EXISTS (
    SELECT 1 FROM managed_content_references r
    WHERE r.realm = o.realm AND r.object_id = o.object_id AND r.released_at IS NULL
  );
```

保留期需覆盖部署的资料恢复与备份策略。恢复旧 PG 快照时，已经越过保留期并物理删除的对象不会因恢复引用行而重新出现；回收不保证任意历史快照都可恢复。

## 当前覆盖与边界

已覆盖知识资料上传、文件删除与内部失败补偿，并保留跨资料共享同一新对象的引用能力；2026-11-09 继续覆盖新任务产物和冷日志段，准确范围见上方扩展合同。热会话日志中的附件、Spill、历史备份、旧内容地址和其他生产者没有被假定为已登记，不进入这套回收。后续生产者必须在自身权威 PG 事务中接入 pin/release，扩展封闭的引用类型后才能使用托管命名空间。

验收文件 `platform/dsh-plugins/object-store/__tests__/managed-content.spec.ts` 使用真实 PostgreSQL 与 MinIO，覆盖事务 pin/release、共享引用、删除默认关闭、跨存储隔离、旧对象保护、幂等身份、双重时间保护、pending 上传、失败补偿、pin/GC 并发和持久删除栅栏。测试是否通过以本次执行报告为准；缺少外部依赖时显式 skip，不计为生产故障验收。

### Session 附件退役补充（2026-11-09）

Session 附件新增显式逻辑退役，合同见[动态会话附件](dynamic-session-attachments-2026-11-07.md#附件逻辑退役2026-11-09)。退役会阻止新消息再选用该回执，保留历史读取、分支继承与逻辑存储 charge；旧共享内容依然不进入物理 GC。当前没有将附件退役等同于解除所有历史引用。

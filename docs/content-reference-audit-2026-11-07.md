# 共享 content 对象的只读引用审计

`platform/tools/audit-content-references.mjs` 汇总共享 `<realm>/content/<sha256>`
空间中已知的正向引用，输出 JSON 报告。它不创建表、不修改数据库、不读取对象正文，
也没有物理删除入口。数据库扫描在 `REPEATABLE READ READ ONLY` 事务中执行；MinIO
入口只列出指定 Realm 的 `content/` 前缀。

## 使用

在仓库根目录运行。数据库连接只从环境变量读取，命令行不接受 DSN：

```sh
node platform/tools/audit-content-references.mjs --realm example --minio > /tmp/content-audit.json
```

先在当前进程环境设置 `LUMO_CONTENT_AUDIT_PG_DSN`。三个数据面可独立覆盖：

| 变量 | 扫描来源 |
| --- | --- |
| `LUMO_CONTENT_AUDIT_KNOWLEDGE_DSN` | `knowledge_library_files.realm/doc_id/object_key` |
| `LUMO_CONTENT_AUDIT_GOVERNANCE_DSN` | `governance_task_artifacts.realm/id/storage_key` |
| `LUMO_CONTENT_AUDIT_SESSION_LOG_DSN` | `session_log.session_ref/seq/payload` |

未设置单独变量时回退到 `LUMO_CONTENT_AUDIT_PG_DSN`；全部未设置时可仅核对对象库存，
数据库来源明确记录 `not_configured`。建议给审计进程使用仅有表读取权限的凭据。
工具不会输出连接串、原始事件或驱动错误正文。

`--minio` 沿用部署变量 `LUMO_MINIO_ENDPOINT`、`LUMO_MINIO_ACCESS_KEY`、
`LUMO_MINIO_SECRET_KEY`、`LUMO_MINIO_BUCKET`；可选 `LUMO_MINIO_PORT`、
`LUMO_MINIO_SSL`、`LUMO_MINIO_REGION`。不会自动创建桶。列表连续 30 秒没有数据时
中止并在报告中记录失败，已有结果保留。

也可以使用运维导出的 JSONL 库存，不连接对象存储：

```sh
node platform/tools/audit-content-references.mjs --realm example \
  --inventory /tmp/content-inventory.jsonl > /tmp/content-audit.json
```

每行是完整对象键的 JSON 字符串，或带可选字节数的对象：

```json
{"key":"example/content/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","size":123}
```

默认每页读取 500 行，每个数据库来源最多扫描 100000 行，库存最多观察 100000 个条目，
报告最多保留 100000 个不同对象。`--page-size`（最大 1000）、`--max-rows` 和
`--max-objects`（最大 1000000）可调整。达到限制时报告 `truncated`；超过报告容量的
观察次数记录为 `omittedObjectObservations`。每个对象最多保留 20 个引用样本，
`knownReferences` 仍累计全部已观察引用。

退出码 0 表示报告正常生成；2 表示配置的数据库或库存来源读取失败，标准输出仍有部分
报告；1 表示参数、依赖或初始化错误。`not_configured`、`partial`、`truncated` 也表示
存在扫描缺口，应同时查看报告内的来源状态。

## 报告含义

`referenced` 证明本次扫描发现至少一条正向引用。`protected` 表示库存中看到了对象，
但没有足够信息证明其完整引用历史。**零条已知引用不表示孤立对象，也不表示可删除。**
顶层和每个对象的 `deletionAllowed` 永远是 `false`，`historyCoverage` 永远是 `partial`。

知识库完整键和治理制品的 `content/<sha256>` 相对键，按数据库行所属 Realm 归一化。
会话表没有 Realm 列，因此扫描所选会话数据库的事件，只识别 JSON 内精确匹配当前
Realm 完整对象键的字符串；同一事件内重复出现的同一对象只计一次。旧式裸哈希、
`sha256:`、相对引用及其他 Realm 不会被猜测归属。非 JSON、超过 8 MiB 或遍历节点数
超限的事件记录为扫描缺口。序号按数据库 BIGINT 排序和翻页，避免字符串序号 10 越过 2。

`inventorySeen=false` 只表示没有在本次库存输入中观察到该引用对象。库存可能截断，
数据库与对象列表也不是同一时刻的全局快照，因此它不能单独证明对象缺失。

以下历史仍未覆盖：冷归档分段、本地或旧版日志、其他数据库、备份，以及尚未落入这些
表的在途上传。当前 `saveImage` 的输入没有会话/owner 身份和释放生命周期；资料、制品
及附件又共享旧 `content/` 空间，因此即使三个表都扫描完，也不能进行自动零引用回收。
`spill/<session>/` 属于其他命名空间，其桶生命周期不由该工具调整。

后续物理 GC 需要先统一写路径的 pin/release，封住旧写入者并完成历史引用迁移；也可以
另建受管理的命名空间，只对具有完整引用事实的新对象建立回收机制。旧 `content/`
对象继续保留。这份报告可以帮助定位已知消费者及评估迁移规模。

## 验证

`platform/tools/content-reference-audit.spec.ts` 覆盖跨来源聚合、Realm 隔离、分页与容量
上限、损坏事件、查询/库存失败、错误脱敏和真实离线 CLI。设置 `LUMO_TEST_PG_DSN`
还会运行真实 PostgreSQL 用例，在独立 `content_reference_audit_test` schema 内验证
三张表的查询、数字序号分页、只读事务和保留未知历史的行为。

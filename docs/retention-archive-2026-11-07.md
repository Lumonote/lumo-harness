# Governance 历史结果审计归档（2026-11-07）

本轮新增 `platform/tools/archive-governance-results.mjs`。它从一致的 PostgreSQL 只读快照导出终态任务及其受控交付证据，并支持脱离数据库的本地完整性检查。工具不删除记录、不修改业务状态、不回收存储配额，也不是数据库备份、恢复或 PITR 工具。

## 使用

数据库连接仅通过 `LUMO_GOVERNANCE_ARCHIVE_DSN` 环境变量传入；不要把 DSN 写在命令参数、日志或文档中。工具从 `platform/dsh-plugins/session-log/package.json` 的安装上下文解析 `pg`，无需新增驱动依赖。使用现有凭据管理方式注入 DSN，生产环境推荐使用只有所需表 SELECT 权限的专用角色。

先执行默认预览：

```sh
node platform/tools/archive-governance-results.mjs \
  --realm acceptance \
  --cutoff 2026-11-07T00:00:00Z \
  --limit 100
```

预览只输出候选数量、各证据表数量和字节估算，不打印任务标识、正文或原始数据库错误。`database_json_text_bytes` 是所选数据库记录 JSONB 文本表示的字节总和；`controlled_file_body_bytes` 是受控文件 BYTEA 正文的精确字节数。JSONB 的空格、归档路径元数据、JSONL 换行及文件系统开销会导致最终归档大小与预览不同；该指标不是 PostgreSQL 物理占用或可回收空间。

执行导出必须指定绝对且尚不存在的目录：

```sh
node platform/tools/archive-governance-results.mjs \
  --realm acceptance \
  --cutoff 2026-11-07T00:00:00Z \
  --limit 100 \
  --execute \
  --output /private/tmp/governance-audit-20261107

node platform/tools/archive-governance-results.mjs \
  --verify /private/tmp/governance-audit-20261107
```

输出目录及子目录为 `0700`，文件为 `0600`。路径必须规范化，祖先目录、输出目录及载荷均拒绝符号链接；本地校验同时拒绝硬链接、非私有文件、目录逃逸、多余或缺失载荷。文件正文使用工具生成的数字路径，数据库文件名不会参与本地路径拼接。已有目录不会覆盖。某些系统的 `/tmp` 是符号链接，此时使用其真实路径（例如 macOS 的 `/private/tmp`）。

成功输出包含 `manifest.json`、九个 `tables/*.jsonl` 和 `blobs/*.bin`。工具先写 `manifest.partial.json`，完成全部离线校验后才改名为 `manifest.json`；中途失败保留的目录不是完成归档，不会自动删除，也不能在原路径重试覆盖。根据本地数据留存政策处置后，使用新的目录重试。

## 选择与一致性

候选条件为指定 `realm`、`business_state IN ('DONE','REJECTED','ARCHIVED')` 且 `updated_at <= cutoff`，按 `updated_at,id` 从旧到新选择，单次 `limit` 为 1..100。`cutoff` 必须是带 `Z` 的严格 UTC 时间；旧任务 `business_state IS NULL` 不会被推定为终态。分页/导出记录不会改变数据库，因此使用相同参数再次运行仍可能选到相同任务；这不是删除式批处理。

预览和导出均使用 `REPEATABLE READ READ ONLY` 事务，并设置语句、锁等待和事务空闲超时。所有选择与读取使用同一事务快照，数据库端再次确认隔离级别与只读设置。代码没有 DDL、DELETE、UPDATE、INSERT、配额操作或临时表。导出预算为数据库 JSON 文本和文件正文合计 512 MiB、总证据记录 1,000,000 条，完成清单的载荷也受 512 MiB 限制；超过预算应减少 `limit`。

导出范围包括：

- 所选终态任务的完整行与全部运行尝试。
- 运行的不可变结果、执行快照、输出 manifest、受控文件完整正文。
- 与所选任务运行直接相连的 producer/reviewer 绑定，以及这些直接依赖运行的结果、快照、manifest 和文件；不会递归展开所有相关任务。
- 依赖任务只导出 ID、realm、project ID 和业务状态，单独放在 `dependency_tasks.jsonl`；这些任务可能尚未结束，不属于终态候选。
- 所导出审核绑定的文件读取元数据与数据库计算的 `result_receipt_matches`，用于说明历史执行结果中的回执是否匹配当时保存的读取记录。未完成审核可能没有全部读取证据；已完成文件审核缺少任一匹配证据会拒绝导出。

外部上传附件正文、对象存储正文、连接器副作用、完整依赖任务历史及授权目录不在范围内。审计结果不会证明一个外部动作已经完成，也不会把失败或未封存的结果升级为可信交付。清单统计分别列出 `sealed_manifests` 和 `unsealed_results`；业务状态按数据库原值保存。

## 摘要、回执与本地验证

数据库 JSONB 会重排属性，不能直接用 `JSON.stringify(JSONB)` 验证原 Go manifest。工具按当前 `RunOutputManifest` / `RunOutputEntry` / `RunFileEntry` 的字段顺序重建类型，保留 Go `encoding/json` 的 HTML 和 U+2028/U+2029 转义、`files,omitempty` 语义，再验证原 manifest SHA-256。未知 profile、字段或不受支持的 manifest 结构会拒绝，而不会默认宣称兼容。独立 Go fixture 已验证相关转义与摘要一致。

每个文本 entry 再核 SHA-256；每个 manifest 的文件 ID、名称、媒体类型、字节数和 SHA-256 必须与数据库 blob 完整集合一一对应。文件正文另校验 UTF-8（保留 BOM）、格式/名称约束、大小、SHA-256，并与结果正文对齐。遗漏、额外、孤立或损坏文件都不能形成成功归档。

`governance_review_file_reads.receipt` 和 `TaskResult.review_file_receipts` 的原始回执不会被取回；前者在 SQL 中剔除，后者仅在数据库内比较。导出时递归移除结构化 `receipt`、`review_file_receipts`、`reviewFileReceipts` 键，离线验证发现这些键则拒绝。归档仅保留数据库计算的匹配布尔值，不包含可重放回执，也不提供回放或恢复接口。

业务文本仍可能包含用户主动写入的敏感信息，本工具不承担通用内容脱敏。整个归档按敏感业务数据保管。本地 manifest 和载荷摘要证明的是归档内部一致性；没有外部签名、可信时间戳或独立保管的摘要时，它们不构成对源数据库真实性的独立证明。

`--verify` 不需要 DSN、数据库服务或 `pg` 驱动，它会检查所有声明的 payload SHA/bytes、实际文件集合、JSONL 行数、任务/运行/审核关系及文件完整集合，再核统计与证据声明。即使手动重算了某个载荷哈希，破坏了证据之间的关系仍会失败。

## 验证记录

离线验证命令：

```sh
node --check platform/tools/archive-governance-results.mjs
node --test platform/tools/archive-governance-results.test.mjs
# 可选真实数据库测试；只针对显式提供的测试 PG，创建/清理随机独立 schema。
# 通过已有凭据注入方式设置 LUMO_TEST_PG_DSN，不在命令行填写连接串。
node --test platform/tools/archive-governance-results.pg.test.mjs
```

12 个 Node 测试覆盖严格参数与时间、原始回执剔除、独立 Go digest fixture、完整文件集、未封存失败结果、BOM 保真、私有目录往返、已有目录拒绝、正文篡改、路径逃逸、符号链接、权限、多余/缺失/未完成归档、重新计算局部哈希后的关系破坏，以及不支持的证据声明。

2026-11-07 已针对现有自有测试 PostgreSQL 完成一次真实演练，`archive-governance-results.pg.test.mjs` 为 1/1 PASS（非 SKIP）。测试凭据从本地 ignored 验收配置注入，未打印 DSN、密码或回执；使用随机 `archive_accept_*` schema，从当前 Go 源码提取实际 task/run/result/review/file DDL，并在 `finally` 清理本次 schema 与临时目录，未停止容器或修改其他 schema。

真实样本包含 3 个终态任务（DONE、REJECTED、ARCHIVED）、1 个仍在执行的直接审核依赖、3 个运行结果（2 个封存 manifest、1 个未封存失败结果）、2 个完整文件（含 UTF-8 BOM/中文/HTML/分隔符的 Markdown 和 JSON）、2 条有效读取证据。dry-run、export 和离线 verify 的数量、正文和回执匹配结果均符合预期，所有落盘文件均不包含原始回执。对全部源表的内容指纹在这些操作前后保持不变。

测试还确认：空集合可导出/校验；`limit=1` 仍保留其直接审核依赖；不同 realm、活跃态、legacy NULL 和 cutoff 之后任务不会混入；第一次候选计数后由第二连接提交的新终态任务在本次全部预览及正文查询中不可见，而下一次预览可见。修改本次 fixture 的 blob SHA、manifest digest 或审核回执均导致导出拒绝，恢复 fixture 后源表指纹再次与基线一致。

无独立只读数据库角色的权限验收、生产数据规模评估、长期保留/删除、存储回收和跨主机恢复仍未由本次脚本覆盖。工具本身已在真实连接中确认 `REPEATABLE READ` / `READ ONLY` 事务设置；这不等于已经验证独立 SELECT-only 角色或生产保留/恢复流程。

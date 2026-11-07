# PostgreSQL 隔离逻辑恢复演练（2026-11-07）

新增 `platform/deploy/recovery-drill.py`，验证一个受控 PostgreSQL 逻辑快照在独立新库的
恢复一致性，并记录该范围内的 RPO/RTO。它不操作现有 Compose 项目或生产数据库，
不改变 `backup.sh`、`restore.sh` 的兼容性，也不是生产 PITR、主从切换或应用恢复验收。

## 启动与资源边界

默认、`--check` 或 `--dry-run` 仅输出计划，不调用 Docker、不创建临时凭据、容器或卷：

```sh
python3 -B platform/deploy/recovery-drill.py --check
```

真实执行必须显式指定 `--execute`，需要本机 Docker 和已有的 `pgvector/pgvector:pg16`
镜像；不会自动 pull。统一验收可在仓库根执行：

```sh
python3 -B platform/deploy/recovery-drill.py --execute --rows 64 --timeout 120 \
  > /private/tmp/lumo-recovery-drill-20261107.json
```

`--rows` 为基线文档数，范围 1..1000；`--timeout` 为单命令或就绪阶段超时秒数，范围
1..600。脚本没有 DSN、现有容器、现有卷、故障目标、镜像或清理目标参数。

每次生成 96-bit 随机 run ID，为 source/target 分别新建一个具名卷与容器。容器使用
`--network none`、无发布端口、`--restart no`，不读取现有应用环境和凭据。两库独立
初始化，不共享数据卷或数据库连接。使用 `docker exec --user postgres` 经本地 Unix
socket 执行 `psql`、`pg_dump` 和 `pg_restore`，命令参数中没有口令。

两个独立随机口令通过只读文件挂入容器。宿主临时目录权限为 0700；文件须允许镜像
降权后的 postgres UID 读取，权限为 0644，但不放宽宿主父目录。口令、dump 字节及
SQL 数据均不写入报告，临时目录退出时删除。Docker/psql 原始 stderr、命令参数和异常
文本不会直接回显，报告只给固定阶段与错误码。报告仍应按运维记录保管。

清理注册表只接收本次脚本得到成功创建回执的资源。每个 stop/kill/remove 前重新检查
原容器 ID、随机名称及本次 run/owner/role 标签。预先存在的同名卷拒绝使用；注册表外
的对象和目标恢复容器不能成为故障注入目标。容器先删除、卷后删除，不执行 prune、
Compose down、通配匹配或按名字批量清理。

如果创建命令超时而无法取得成功回执，可能已产生资源；这类名字列入
`cleanup.unconfirmed_creates_retained`，脚本不推断所有权后强删。标签或 ID 不匹配
同样保留并记为 `retained_or_unverified`。任一清理未完成时退出非零，即使数据恢复成功
也不报告整轮通过。SIGINT/SIGTERM 会进入清理；SIGKILL、宿主崩溃或 Docker 不可用
仍可能留下资源，需凭本轮报告与标签人工核对，脚本不提供跨运行接管清理。

## 受控故障与一致性验证

流程如下：

1. 新建源库，启用 `track_commit_timestamp`，建立事务标记、文档和引用表。两层 FK
   分别绑定文档→标记、引用→文档，文档 CHECK 约束校验完整 BYTEA 的 SHA-256。
2. 同一基线事务提交 `baseline` 标记、指定数量的完整文档及引用。每条文档的正文与
   SHA 都进入验证投影，不能仅比较行数或摘要字段。
3. 在保持打开的 REPEATABLE READ 只读事务中调用 `pg_export_snapshot()`，记录导出
   观测时间、MVCC snapshot、WAL LSN 和该快照下的完整数据投影。然后另开连接提交
   `post-snapshot` 事务。
4. `pg_dump --format=custom --snapshot=<exported>` 在上述事务仍打开时取备份。
   故意把 `post-snapshot` 放在 pg_dump 开始之前，验证同一已导出快照确实被使用，
   不能把“dump 前已经提交”误算为恢复中应有数据。记录 dump 起止、字节数与 SHA。
5. 备份完成后记录“故障声明”时间，再提交 `post-fault-declared` 事务，查询三个标记
   的真实 `pg_xact_commit_timestamp(xmin)` 和源库截止观测时间，随后 SIGKILL 本次源
   容器。这笔晚提交发生于故障声明后、硬停止前；脚本不声称源已停止后还能成功写入。
6. 故障后才新建目标卷/容器，等待 PostgreSQL 可用，将备份通过 stdin 导入
   `pg_restore --exit-on-error --no-owner --no-privileges`，从不覆盖现有库。
7. 恢复后实际尝试孤立文档、孤立引用、错误 SHA 插入，要求数据库分别以 FK/CHECK
   违例拒绝。再用 SQL 检查已验证 FK 数量、孤立记录和正文 SHA，并在宿主独立重算
   正文哈希/引用归属和完整投影 fingerprint。恢复结果必须精确等于导出快照：仅含
   baseline，两笔后续确认事务必须缺失。
8. 只有完整验证成功才记录恢复完成时间；最后清理本次创建的容器、卷及临时文件。

整个恢复数据集由脚本生成，不包含业务数据。`snapshot.fingerprint_sha256` 与
`recovered.fingerprint_sha256` 绑定所有表的完整排序投影，包括原始正文、SHA、主外键
和原始插入时间；不能通过只改 SHA 字段掩盖正文损坏。

## RPO/RTO 口径

不把“快照时间”或“源恢复可访问”直接当作业务恢复成功。报告同时保留以下事实：

| 字段 | 准确定义 |
| --- | --- |
| `exported_snapshot.snapshot_export_observed_at` | 在固定快照语句中，源库观察导出操作的时间；不冒充每一行的实际提交时间。 |
| `stage_offsets_ms` | 宿主 monotonic 时钟测量的阶段相对起点，用于分解备份、故障、目标启动、导入与验证耗时。 |
| `source_acknowledged_transactions` | 源库在硬停止前能证实的真实事务提交时刻，不采用事务内生成的插入时间冒充 commit。 |
| `rpo.recoverable_point_age_at_cutoff_ms` | 源库截止观测时间−恢复数据中最新一笔原始源提交时间。表示这份逻辑恢复点在故障截止处的数据年龄。 |
| `rpo.acknowledged_data_loss_window_ms` | 若存在缺失事务，为最新源已确认提交−恢复数据中最新原始提交；没有缺失则为 0。与上面的恢复点年龄分别显示，不能混为同一个时间。 |
| `rpo.missing_transaction_markers` | 截止时源已确认但恢复快照没有的事务集合；本场景必须精确为 post-snapshot、post-fault-declared。 |
| `rto.measured_ms` | 从故障声明开始，到恢复库完成实际 SQL、FK/SHA、完整 fingerprint 核对的 monotonic 耗时。包含受控晚提交、源 kill、目标新建与就绪、导入及验证。 |

RTO 不包含基线初始化、备份制作、清理、外部服务就绪、流量切换、对象存储、身份系统或
应用业务冒烟。没有恢复验证成功就不产生 RTO 成功读数。数据库时间若出现反向顺序会
失败，不能用负数或绝对值修饰。当前 workload 只有明确标记的三个受控提交，结果不得
外推为生产的持续写入恢复窗口。

快照外事务丢失在这个逻辑备份场景是预期证据；通过意味着“恢复精确符合既定快照且
损失已被正确识别”，不意味着零数据损失或已满足生产 RPO。没有 WAL 归档/PITR、
物理复制、在线备份、密钥恢复或物理多主机故障验证。

## 本批验证状态

本子任务按统一验收分工**未执行 Docker**。已完成：

```sh
python3 -B -m unittest discover -s platform/deploy/tests -p test_recovery_drill.py -v
python3 -B platform/deploy/recovery-drill.py --check
```

专属 unittest **13 PASS / 0 FAIL**，全部使用 FakeDocker 或 mock，不调用 Docker/PG；
覆盖默认只读、参数边界、源目标隔离、原始 ID 与标签核验、既有/结果不明资源不接管、
清理失败继续处理、口令不入参数/报告、快照绑定、晚提交缺失、FK/内容 SHA、时钟和
RPO 计算。AST 语法校验通过，check 报告为 `executed=false`。

真实容器启动、导出快照、pg_dump/pg_restore 兼容性和测量值交根任务统一运行上述
`--execute` 命令核验。未取得真实报告前，不将这些单测或 dry-run 当作已完成恢复演练，
也不预填 RPO/RTO 数值。

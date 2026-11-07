# 六项优化交付与验收（2026-11-07）

当前开发分支为 `v1.2.1`，接续前 `932672d` 已推送到 `origin/v1.2.1`。
本批通过公开插件、服务和 seam 扩展，上游 `deepseek-harness/` 源码与锁文件保持只读。

## 性能与取消

- Session 后台 heartbeat 使用 8 路并发、1750–2250ms 调度抖动，不重叠执行；
  合并同一在途 node renewal，跳过本轮排队期间已由前台真实续租的相同 lease。
  单周期 5 秒预算，超时或失租仍永久 fence，不延长租约，不缓存授权。
- 文件审核先验证完整 manifest，再最多 4 路独立全文读取，保持原序；任一失败取消全部，
  完整校验后原子公布正文和 read receipts。单请求 5 秒、整体最多 30 秒，且受执行期限、
  preset timeout 和上级取消共同约束。
- 512 Session、固定模拟 5ms RTT 的调度基准为 64 波、320ms、最多 8 在途；这不是数据库吞吐。
  真实容量仍需按目标库锁等待、heartbeat p95/p99、模型并发与业务撤权时延压测。

## 存储配额与保留

迁移 `031_storage_ledger.sql` 和 Go/TS 启动 DDL 一致，`032_storage_quota_audit.sql`
扩展现有审计 CHECK；保留已发布的 021 迁移，DDL 门禁按后续同名 DROP/ADD CHECK 的
最终词表检查，服务重启不会重新施加旧词表而拒绝已有配额审计。配额按 realm 与 project 的
**活动逻辑引用字节**统计：一个不可变引用占一次，fork 继承产生新引用，占用也单独统计。
不按对象去重后的物理字节计量，不代表 PG/WAL/对象存储总量。

- 覆盖 Session attachment receipts、受控 run-file blobs、完成的 task artifacts 和资料库文件。
  每个生产者与自己的权威写入同一事务登记，配额失败则元数据/文件 blob 一起回滚。
- realm 行锁先于 project 行锁；跨副本和不同项目共享 realm 上限，配额变更使用同一锁。
  immutable reference 的幂等重放不重复计费，内容/项目/大小不同或已释放引用不能复活。
- 启动按 1000 条页回填已有权威引用；历史超额仍如实登记，不删除已有证据。
  配置限额后，当前存在的生产者表必须完成事务回填屏障，才接受新增计费引用。
  元数据 DDL、台账 DDL、纯回填各自提交，回填期间不持有索引或元数据 DDL 锁；
  避免副本启动与已持 realm 配额锁的在线上传形成锁环。
- 知识资料删除与引用释放同事务；PG run-file、Task artifact 与 Session receipt 本批不做物理删除。
  日志、Spill、备份及未登记历史对象仍不在覆盖内，缺少登记不等于可删除。
- 管理 API：`GET/PUT /v1/storage/quota?project_id=...`，空 project_id 为 realm。
  PUT 必须 `expected_revision` 和 `limit_bytes`（null 不限额、0 拒新增、非负整数字节）。
  当前直接管理员在 organization 锁和 ledger 锁后复验，CAS、审计同事务。
  HTTP 拒绝畸形查询、尾随 JSON、未知字段及超出 JavaScript 精确整数范围的配置，
  避免项目参数解析失败时改写租户配额或前端数值失真。
- 用户代理保留容量失败 `507/storage_quota_exceeded`；回填未就绪为 503。
- 管理页面提供租户/项目上限、精确字节用量及分类；切换范围隔离请求，409 保留草稿，
  读取最新 revision 后须显式保存，支持 null/0 与非整 MiB 旧配置。

升级须先暂停旧版本文件写入，升级全部生产者并完成回填后再开放流量；旧版本二进制不会登记
新台账，混合旧写者期间不能承诺配额严格。覆盖标记不是物理对象完整性或自动 GC 授权。
大历史库首次回填应安排维护窗口，并观察事务时长与 WAL 增长。

## 业务评测与运维

Agent Team 新增 16 个任务（8 业务、8 抗干扰，三种拓扑），严格导入逐次执行、交付、审核、
成本证据，计算成功、误批/误拒、返工、成本和延迟。fixture 与实际导入分组，无数据返回空分母，
没有真实供应商记录时不产出模型质量分数。见 [业务评测](agent-team-quality-2026-11-07.md)。

新增执行租约、附件、文件审核、owned connector 的真实业务入口指标；operation/outcome 使用
固定枚举，不使用用户、Session、realm、项目或 receipt 标识作为标签。告警覆盖失租、审核不可用和
外部连接器结果未知；unknown 不允许自动重放，需核对外部系统与持久 receipt。
Helm 不部署 Prometheus/Alertmanager；canonical `prometheus-alerts.yml` 仍需监控系统外部加载，
见 [业务监控](business-observability-2026-11-07.md)。

新增默认 dry-run 的终态任务只读审计归档：一致快照导出完整运行、清单、文件和直接审核依赖，
验证 Go 摘要编码、SHA、全文集合及回执匹配，排除可重放回执，使用私有新目录并支持离线校验。
真实 PostgreSQL 已完成 3 个终态任务、1 个审核依赖、3 结果、2 个文件的导出和校验，
并验证并发快照、损坏拒绝及源数据库指纹不变；不删除数据库记录、不回收配额，也不是恢复备份。
见 [只读归档](retention-archive-2026-11-07.md)。

## 页面与故障分型

- owned chat 支持取消上传，切换会话取消旧请求并拒绝旧响应回写；短等待刷新审批、空态、
  读取重试、保留模型草稿、长附件名及窄屏布局已改进。
- 项目名称保存冲突保留草稿，读取最新名称后显式采用或按新 revision 再提交。
- 附件区分 400/413/415/429/403/503/507，429 返回有界 Retry-After；跨副本代理保留安全固定 code。
  连接器 execute 断网/解析失败/执行后失权按结果未知处理，不反射原始凭据/下游报错。
- 组件测试、类型检查和 bundle 不代表真实浏览器视觉验收；本批仍无逐页视觉通过结论。

## 恢复与外部验收边界

新隔离恢复脚本仅创建并清理自己的随机 Docker PG 容器与卷，无端口、无网络、无生产目标。
真实 exported snapshot + pg_dump + SIGKILL + 全新目标恢复已通过；64 文档和 64 关联的
行数、FK、内容 SHA、整体 fingerprint 完全一致，快照外两笔已确认事务按预期缺失。
此次 RTO=1545.049ms（到 SQL 一致性验证完成，不含应用流量恢复），快照恢复点年龄 472.277ms，
已确认数据损失跨度 403.435ms。报告：`/private/tmp/lumo-recovery-drill-20261107.json`。
这是隔离逻辑恢复演练，不能称生产 PITR、PG HA 或零 RPO。详见 [恢复演练](recovery-drill-2026-11-07.md)。

本机没有 SSH config 或 kubeconfig，Docker 双节点不构成物理跨主机验收。本批真实供应商
探测因自动权限审批审核未在期限内结束而未执行，未取得本次 API 响应；这不代表调用被判定不安全。
此前的 `AUTH/access-denied` 仍仅是此前版本的响应。已有环境仅有 Anthropic 兼容端点身份，
不能使用聊天模型会话代替 API 凭据；无真实业务记录的评测不报供应商质量分数。

## 最终验证

最终整合使用本批自有 PostgreSQL、Redis、MinIO（非 mock），以及实际 HTTP 和 AgentLoop：

- 完整平台 Vitest：**2141 PASS / 0 FAIL / 0 SKIP**，250 个测试文件。
  报告：`/private/tmp/lumo-six-final-platform-20261107.json`。
  其中 DDL 收敛/真实结构 34 项、知识配额/启动并发 2 项全部实际执行。
- 五个 Go 模块完整 `go test -race -count=1 -json ./...`：Governance **316**、
  Session-control **264**、Storageledger **5**、Connector-gateway **71**、Observability **40**，
  合计 **696 PASS / 0 FAIL / 0 SKIP**（含子测试）。包含实际 PG、HTTP 监听、
  管理员等待锁期间到期、严格 HTTP 输入、CAS/审计、失败事务回滚和启动锁顺序回归。
  报告：`/private/tmp/lumo-six-final-{module}-20261107.jsonl`。
- 平台、UI 与独立评测 TypeScript 检查、UI bundle 通过；评测 CLI validate 确认
  16 场景、0 已评测试验，不把语料验证计为模型通过。
- 归档离线 12 项及真实 PG 演练 1 项、恢复脚本 13 项通过；隔离恢复实跑证据见上文。
- 告警 24 条真实规则与 14 个反例、Helm 渲染/配置正反例、构建模块接线门禁通过。
- 五个 Go 模块 vet/build 通过；CI 已接入新 Go 模块、知识配额/启动并发、真实 PG
  DDL/归档及恢复脚本离线合同。工作流 YAML 校验通过，远程 CI 以推送后结果为准。

早先 Docker 停机、MinIO 测试配置格式和初版配额测试 fixture 造成的失败已分别修正并由
本次完整回归覆盖；不将受这些环境故障影响的中间结果记为通过。上游源码与锁文件保持
干净，revision `fcc0ad46`。三个专用测试容器及匿名卷已按精确名称、ID 和本任务标签清理，
确认无本任务残余容器；ignored 临时测试凭据文件已删除，保留脱敏验收报告。

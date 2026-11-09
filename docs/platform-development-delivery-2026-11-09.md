# 发布、附件、评测与生产验收能力交付

本批按[实施计划](plans/2026-11-09-remaining-platform-development.md)的八项顺序集成，
基于 `920116fab1ddc59f9d70b868b222c2709b2c49e8`，变更保留在 `v1.2.1` 工作区供审阅。
全部通过 platform 扩展实现；上游 DeepSeek Harness 源码与锁文件保持只读。

最终验证日期：**2026-11-10（Asia/Shanghai）**。

## 实现范围

| 顺序 | 本批结果 | 操作说明 |
| --- | --- | --- |
| 1 | 正式标签必须匹配 package、Tauri、Chart version/appVersion；基础 CI、集群验收、桌面包共用一次解析的 upstream SHA，全部成功后才发布 | [发布合同](ci-release-contract.md) |
| 2 | 100 项限制改为活跃可发送附件；退役释放名额、保留历史与逻辑配额；提供状态筛选、分页、容量和历史下载；超过100条的历史按批继承，失败只清理未激活子会话的引用 | [附件合同](dynamic-session-attachments-2026-11-07.md) |
| 3 | Mac Developer ID、hardened runtime、公证/staple/Gatekeeper，Windows 签名与验证；缺正式凭据失败；Windows 部分导入失败可按持久回执清理证书和私钥 | [桌面说明](../platform/desktop/README.md) |
| 4 | Agent Team 录入观察的质量门禁绑定语料/配置摘要、均衡重复、成本完整性和基线；知识评测接受自定义 corpus/suite/config，隔离文档身份、重算基线排名并输出 JSON/Markdown | [团队评测](../platform/dsh-plugins/agent-teams/eval/README.md)、[知识评测](../platform/dsh-plugins/knowledge/eval/README.md) |
| 5 | 生产证据覆盖跨故障域、迁移、分区、HA/PITR、RPO/RTO、应用恢复、证书、容量和可选 IdP/KMS；preflight 绑定源码、集群 UID 与 namespace/release，固定 kubectl context，优化模式仍执行 Secret/TLS 检查；恢复协议 v2 携带期限，新增冻结快照克隆 Provider 和 Vault 只读核对 | [生产证据](production-evidence-contract.md)、[参考 Provider](frozen-snapshot-provider.md) |
| 6 | Go 活依赖接通 PG/Redis/MinIO/RocketMQ；逐包 JSONL 验证拒绝 skip、重复终态、缺包与不完整执行，关键模块开启 race；集群精选验收复用同一验证器 | [CI 合同](ci-release-contract.md) |
| 7 | 桌面运行时按组件记录字节、文件数、链接和来源，执行绝对预算及已有基线10%增长限制；Python 默认拒绝包外链接，Mac 保留安全内部相对链接，Windows 实体化 | [桌面说明](../platform/desktop/README.md) |
| 8 | 按账户、知识、目录、导航、请求和共享 shell 拆分 UI；加入宽窄屏、键盘焦点、命令菜单、关闭恢复焦点及读取失败恢复的 Chromium 验收，CI 使用固定 Playwright | [UI 验收](ui-workbench-acceptance-2026-11-09.md) |

在线升级需要按部署流程应用迁移 `045_session_attachment_inventory.sql` 和
`046_recovery_provider_protocol.sql`。046 为旧记录保留 v1 回执核对；未执行的旧批准
不能自动升级为 v2 执行。新 Provider 默认不部署，必须单独配置独立 ledger 和精确路由。
生产证据 policy/observations 均须填写目标集群 `kube-system` Namespace 的 UID，
同名 namespace/release 不能跨集群复用证据；本批未访问生产集群。

## 已执行验证

最终全平台活依赖回归：**310 文件、2892 PASS / 0 FAIL / 0 SKIP / 0 TODO**，
使用隔离 PostgreSQL/pgvector、Redis、MinIO、本机 HTTP 与完整文档 Python 依赖。
JSON 报告再次经 `verify-platform-test-report.mjs` 校验，跳过不计作通过。

Go 控制面 **16 模块、121 包、2022 PASS / 0 FAIL / 0 SKIP**；所有模块 build/vet 通过，
逐包 JSONL 与 `go list` 的发现集合完全一致。Governance 全包 race **436 PASS**，
Session-control 全包 race **307 PASS**，Registry 全包 race **126 PASS**，
Usage-ledger 真实 PG/RocketMQ 全包 race **42 PASS**。
冻结克隆实际验证了数据、并发、崩溃、过期、路由/source/target OID、marker、fence 与只核对不重放。
RocketMQ 回归精确核对本次事件与 broker Ack，验证毒消息后的正常入账及同一批消息的重放去重；
历史毒消息或旧台账行不能再形成假通过。完整汇总和报告摘要见
[验证清单](verification/platform-development-2026-11-10.json)。

发布与证据工具 Node 测试 **27 PASS**；部署 Python 测试 **37 PASS**，包括集群身份不匹配、
context 切换后仍固定 API 目标，以及 `python -O` 不能关闭生产检查的负例。
平台、客户端、两套 eval TypeScript 均通过。
三个工作流 YAML 及71个 shell 块语法通过，部署/DMG shell 语法通过。

Chromium 源码 fixture 分别在可见和 headless 模式完成 **10/10** 检查，页面异常与
写入/跨源请求均为零；这两次来自本机 macOS，GitHub Ubuntu 执行结果仍待远端运行。
Host/Client bundle 构建通过。客户端包 **1,347,970 B**、gzip **263,525 B**，较拆分前
分别增长0.10%和0.74%；本批没有测得加载性能提升。实际 CPython 搬迁至含空格和括号路径后，
保留9个内部链接，`ssl/json/sqlite3/ctypes` 导入成功。

## 仍需真实环境提供的验收

- 真实模型/TEI 与有代表性的业务语料：工具和门禁已就绪，本批没有生成真实模型质量分数。
- Mac/Windows 正式证书、公证及安装后的原生交互：本批验证合同、失败路径和本机 Python，
  没有把 fixture 作为正式签名、PowerShell Certificate Provider 或系统操作证明。
- 独立物理主机/卷、生产 HA/PITR、IdP/KMS 和容量演练：本批没有向生产注入故障、恢复原库
  或销毁密钥。冻结快照克隆不是 PITR；Vault absent 不是销毁成功回执。
- 新工作流的 GitHub hosted run 和完整集群发行验收：本地合同及分模块活依赖回归不能代替它们。

当前产品元数据仍为 `1.1.1`；分支名 `v1.2.1` 不会自动改变安装包版本。
后续正式发布前须统一更新产品版本并使用匹配标签，不能用不同标签包装旧版本安装器。

验证清单保留各模块计数和原始报告 SHA256；JSONL/浏览器截图等原始日志目前位于本机临时目录，
未作为持久发布证据归档。本次四个隔离 Docker 测试容器已核对任务标签并清理。
发布流水线会分别保存运行时、签名、浏览器和测试报告。上述验证在提交前工作区完成，
提交与推送状态以 Git 记录为准；本批未发布安装器。

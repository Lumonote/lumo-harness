# 剩余实现收尾（2026-11-09）

本批在已有未提交实现上继续开发，保留此前改动，通过公开插件、Provider、工具、事件和持久化接口接线。没有修改 `deepseek-harness/` 源码或锁文件。

## 已提交批次：972bc71

| 能力 | 当前行为 |
| --- | --- |
| Windows 电脑操作 | 固定版本 SDK、隔离 worker、Job Object supervisor、观察/输入限制、取消和安装包 receipt。原生依赖缺失、目标架构或摘要不符时拒绝打包。 |
| 远程电脑请求 | Bot/Flow 固定设备、项目、Session、能力和意图，Governance 保存不可变计划；本机 owner 逐次批准后才执行，逐动作检查当前设备、权限与期限，结果未知不自动重放。 |
| 会话迁移 | 空闲检查点、完整原生日志与有界工作区快照、对象读回校验、固定目标恢复、owner/fence 原子切换。旧输入不重发，旧写者不能重新取得执行身份。 |
| 文档附件 | PDF/DOCX/XLSX/PPTX 有界文本预览；Office 按 manifest 及内部关系读取真实顺序，忽略孤立 part、拒绝外部内容链接。预览明确不代表文档完整视觉内容。 |
| 受控仓库交付 | 从批准的不可变 Git 提交读取完整文件集合，服务端计算修改前后正文与 patch，独立审核逐项全文读取；精确 manifest 的一次发布许可只创建新分支和草稿 PR。 |
| 任务产物与冷日志 | 新对象使用托管命名空间，元数据与引用同事务 pin/release；产物撤回保留审计，冷日志持久冻结归档计划、退役范围不复活，物理 GC 遵守显式开关与保留策略。 |
| 桌宠发送 | SQLite 持久回执及跨进程 CAS 在创建/发送前建立围栏，准备失败可核对后恢复；派发结果不明不自动重发。 |

配置和详细合同分别见[电脑操作](computer-use-2026-11-08.md)、[会话迁移](session-migration-2026-11-08.md)、[受控仓库审核](controlled-repository-review.md)及[托管内容生命周期](managed-content-lifecycle-2026-11-07.md)。

## 本轮发现并修复的问题

- 不同远程请求并发批准会同时通过空闲检查。现在先取得全局批准位，批准等待期间的停止、撤销、卸载和授权变化均使旧请求失效，不启动 Agent。
- Governance 在项目/grant 行锁前检查有效期，等锁时到期仍可能返回授权。现在创建尾部、批准及动作检查均使用数据库当前时间重新校验请求、设备与证书。
- Helm 和 Compose 只向 Governance 传递远程开关，Flow 生产者始终关闭。现在两端接收同一个默认关闭的显式配置，渲染门禁逐工作负载验证。
- 老数据库的输出 CHECK 不接受受控仓库模式。启动 DDL 与迁移 040 统一升级词表，保留旧预设和 revision，并检验重复升级顺序。
- Office 预览按 ZIP 文件名字典序读取，可能混入孤立内容。现在按文档内部 manifest/relationships 确定顺序和引用范围。
- 会话迁移 mutation 返回成功状态但回执畸形时，事务可能已经提交。现在保持 `session_migration_unknown`，查询持久状态后再操作。
- 桌宠准备失败会使发送队列永久失败；提交围栏失败还可能留下乐观待发送项。现在恢复权威回执，并在尚未派发时清理乐观项。
- 已提交的旧冷归档正文丢失时曾返回空数组。现在返回完整性错误，不能将对象丢失解释为空历史。

## 验证与环境边界

972bc71 提交前冻结代码后的统一验证如下。Go 计数包含子测试，未把“包中无测试”的 skip 计为测试跳过；Windows 专用原生测试单列。

| 检查范围 | 通过 | 失败 | 跳过 | 本机报告 |
| --- | ---: | ---: | ---: | --- |
| 完整平台（298 文件） | 2767 | 0 | 0 | `/private/tmp/lumo-continuation-platform-final-v3.json` |
| Governance 全包真实 PG race | 407 | 0 | 0 | `/private/tmp/lumo-continuation-governance-v3-final.log` |
| Flows 全包真实 PG/HTTP race | 251 | 0 | 0 | `/private/tmp/lumo-continuation-flows-final.log` |
| Session-control 全包真实 PG race | 300 | 0 | 0 | `/private/tmp/lumo-session-control-final-20261109.jsonl` |
| Registry computerbridge 与 desktop-agent race | 17 | 0 | 0 | `/private/tmp/lumo-desktop-agent-race-unsandboxed-20261109.jsonl` |
| Windows 专用 Job Object 原生测试 | 0 | 0 | 2 | macOS 开发机无法执行，明确不计为 Windows 通过 |

完整平台使用已有隔离 PostgreSQL、Redis、MinIO、真实本机 HTTP 与公开 AgentLoop/JSONL；设置 `LUMO_AUTH_PROXY_TEST=1` 后认证代理和实际连接取消用例全部执行。文档解析使用已有完整 Python runtime。初轮并发构建造成两项进程 fixture 超时，拆开复跑 13 项通过；最终全量使用两路 worker、30 秒单测期限，包含所有修复，没有排除用例。

Governance 回归包含 8 项等锁期间过期场景，以及旧库约束从迁移/启动两条路径交叉幂等升级。迁移检查器只识别精确、无其他写入的历史条件 CHECK 包装，新的 DROP/ADD 同名 CHECK 可以替换旧词表，不再要求新服务重新施加旧约束。

平台及客户端 TypeScript、Host/Client bundle、四个变更 Go 模块的 vet/build 均通过。Helm 基础/集群正反例共 80 项通过，覆盖远程开关同时到达 Flow 生产者和 Governance。完整 desktop-agent 本机及 Windows amd64/arm64 交叉构建通过。最终 `git diff --check` 无输出，上游 porcelain 无输出，`describe --always --dirty` 为 `fcc0ad4621`，无 dirty；上游无 tag，因此没有使用 tag 描述作为版本验收。

Windows Job Object 的真实进程终止、已安装桌面的权限与输入闭环，以及多主机独立卷、网络分区和原生文件锁需要对应实机。macOS 上的模拟测试、交叉编译和本机 HTTP 不替代这些验收。

真实模型供应商、实际 IdP、生产 PITR/HA/SLO 与 KMS 仍需要目标环境。没有执行真实租户密钥销毁、发布外部草稿 PR或修改生产部署。Session 附件、Spill、备份和旧共享内容没有完整生命周期权威，继续保留，不按未登记推断无引用。

受控仓库档位不运行代码测试，草稿 PR 不自动合并；任意宿主操作、历史未知附件及连接器副作用也不因此获得完整影响证明。真实部署逐页视觉验收仍需另行核对。


## 后续推进：仓库核对、附件退役与原生验收

本节为 `972bc71` 之后的增量。主机重启后重新建立隔离 PostgreSQL 16/pgvector、Redis 7、MinIO，重新准备 Go 1.25.5 与 Python 文档运行时；没有复用已清除的旧 `/private/tmp` 报告作为本轮测试证据。

| 增量 | 已实现的行为 |
| --- | --- |
| 仓库发布结果核对 | 证据面板显示持久发布状态，显式“核对”只读查询 Git 分支、单父提交、完整 Git tree 与唯一未合并草稿 PR。由批准 manifest 重建目标 tree，保留未修改子树和文件 mode；再读分支与 PR 检查观察期间是否变化。核对前后重新授权，CAS revision 阻止旧观察覆盖新结果；confirmed/unknown 持久化，不释放发布围栏、不重试外部发布。 |
| Session 附件逻辑退役 | 管理已上传附件、重新加入待发送或显式退役；退役阻止后续消息选用，保留历史下载、模型按历史 marker 读取与分支继承。精确执行租约和锁后/提交前重验仍生效，发送与退役在当前执行节点互斥。退役保持共享内容及配额，结果不明可重新读取可用列表核对。 |
| Mac 原生验收 | 新工具通过官方稳定 helper 身份和独立 runtime/socket 做只读 catalog，或在已授权条件下操作自己创建的 Swift 测试窗口；核对准确 PID、窗口与 executable，独立记录点击和文字效果。缺权限直接 blocked；SIGINT/SIGTERM、连接中止与正常完成均清理自建进程。 |
| 常规 CI 活依赖 | push/PR 的完整平台发现统一接通 PG、Redis、源码固定版本 MinIO、HTTP 认证代理与固定约束的 Python 文档依赖。每个文件的实际 assertion 和总计数必须全部通过，任何 skipped/todo、空报告、重复文件或计数不一致都会失败；保留 JSON 报告并清理测试容器。 |

迁移 `043_repository_publication_reconciliation.sql` 和 `044_session_attachment_retirement.sql` 与服务启动 DDL 对齐，真实 PG 共表结构检查已覆盖两条升级路径。详细合同见[受控仓库审核](controlled-repository-review.md)、[动态会话附件](dynamic-session-attachments-2026-11-07.md)及[电脑操作](computer-use-2026-11-08.md)。

### 本轮冻结后的验证

| 检查 | 通过 | 失败 | 用例跳过 | 本机报告 |
| --- | ---: | ---: | ---: | --- |
| 完整平台（302 文件） | 2836 | 0 | 0 | `/private/tmp/lumo-validation/platform-final.json` |
| Governance 全包真实 PG race | 417 | 0 | 0 | `/private/tmp/lumo-validation/governance-full.jsonl` |
| Session-control 全包真实 PG race | 302 | 0 | 0 | `/private/tmp/lumo-validation/session-control-full.jsonl` |

完整平台开启所有当前活依赖门控，以两路 worker、30 秒 test/hook 期限运行；文档用 PyMuPDF 1.27.2、openpyxl 与 python-pptx，包括真实导出 XLSX/PPTX。初轮缺 openpyxl 导致两项明确跳过，零跳过校验器确实拒绝该报告；补齐后最终报告 2836/0/0，校验器 CLI 通过。完整运行包含仓库核对、实际 AgentLoop/JSONL 附件退役/历史/分支/并发、浏览器 DOM 交互、原生验收工具和 CI 报告正反例。

平台及客户端 TypeScript、Host/Client bundle、两个变更 Go 模块的 vet/build 通过。Go 计数包含子测试，“无测试文件”的两个包不作为用例 skip。上游 Git porcelain 为空，`describe --always --dirty` 为 `fcc0ad4621`；`deepseek-harness/` 源码及锁文件没有修改。

Mac 官方 arm64 release helper 实编译、签名/receipt 校验及原生 catalog 均通过，helper 清理得到实际确认。当前稳定 helper 的 Accessibility/Screen Recording 均未授权，因此桌面实机验收实际返回 blocked，没有创建测试输入窗口，没有申请权限或输入。Swift fixture 真编译和工具契约测试不替代实际桌面点击、输入、产品授权 UI 或模型视觉验收。

常规 CI 工作流和报告守卫已本地验证，尚未取得本次 GitHub hosted run 结果；GitHub CLI 当前未登录。Windows 实机、物理多主机、真实供应商/IdP、生产恢复/HA/KMS、公证安装，以及 Session 快照、Spill、备份与旧共享内容的完整物理生命周期，仍需要对应环境或独立权威设计。本轮附件退役不宣称释放容量。

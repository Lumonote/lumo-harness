# 剩余实现收尾（2026-11-09）

本批在已有未提交实现上继续开发，保留此前改动，通过公开插件、Provider、工具、事件和持久化接口接线。没有修改 `deepseek-harness/` 源码或锁文件。

## 本批实现范围

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

最终冻结代码后的统一验证如下。Go 计数包含子测试，未把“包中无测试”的 skip 计为测试跳过；Windows 专用原生测试单列。

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

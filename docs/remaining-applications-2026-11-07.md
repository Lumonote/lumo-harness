# 会话应用流程与文件审核续开发（2026-11-07）

本批接续 `4742722`，在 `codex/v1.2.1` 补齐此前尚缺的会话附件、当前 owner 连接器交互审批，以及封闭文件交付的独立异构审核。上游 DeepSeek Harness 仍作为只读依赖，接线通过公开插件、AttachmentStore、工具和 userQuestions 服务完成。

## 已接通的流程

### 当前 owner 附件

独立有界二进制接口保留普通 JSON 入口的原大小限制。每项上传取得 PG receipt，绑定当前 realm、project、owner、Session 和活跃执行代；浏览器仅得到 opaque receipt，不得到对象键、宿主路径或任意 URL。目标副本独立认证登录凭据、精确目的节点和当前 owner，转发沿用固定原节点路由。

文本限定安全 UTF-8，图片使用原生 PNG/JPEG/WebP/GIF 内容。模型只接收实际发送的 receipt，文本只读工具须在当前会话真实 user/message 中找到服务端标记，下载先有界读完并验证完整 SHA-256。文件名与用户文本均禁止伪造保留标记。重启从 PG 恢复授权；分支只复制已完成历史前缀实际使用的 receipt，不能复制未消费上传。页面提供上传进度、待发送附件和安全下载。

迁移 `028_session_attachment_receipts.sql` 与启动 DDL 保持一致。默认关闭，详细配置见[动态会话附件](dynamic-session-attachments-2026-11-07.md)。附件对象仍使用非托管命名空间，不能据此启用历史附件自动 GC。

### 当前 owner 连接器与一次审批

部署端和数据面分别配置 connector/action 白名单；Gateway 独立从 Governance 复验真实登录、当前项目权限和持久 owner/执行代。凭据只通过即时认证通道传递，不落入业务 payload、会话日志或模型提示。读调用保留既有策略、限流和响应脱敏。

每个写请求先持久保存精确的业务 payload、连接器版本、摘要、revision 和五分钟有效期。原生 userQuestions 绑定当前 Agent，页面以纯文本展示待批内容；owner 的答案必须精确匹配 question、receipt、digest 和 revision，模型没有批准工具。先原子 consume，再调用冻结请求；并发答案和重复执行拒绝。锁等待后重验库端时间、owner 和租约。失租或撤权取消在途 I/O，外部结果不明记为 unknown，不恢复重放权。高敏写继续走独立管理员流程。

迁移 `030_owned_connector_receipts.sql` 持久化审批事实，过期和已完成 payload 会清除。每个会话最多 8 个有效待批/已批请求，跨副本事务仲裁；过期清理使用仅覆盖仍保留 payload 行的索引。网关还独立绑定精确 Session fencing token，不能用相同 process/writer 下的旧代请求通过。此能力默认关闭，不授予任意 URL、header、shell 或宿主文件操作，详细配置见[连接器与原生审批](dynamic-session-connectors-2026-11-07.md)。

### 有界文本文件的异构审核

新增 `platform-closed-text-files-v1`，仅允许本次执行的 `generate_text_artifact`。支持 TXT、Markdown、CSV 和 JSON，最多 16 项、每项 32 KiB、合计 256 KiB，禁止覆盖及路径引用。文件档位不能同时挂系统提示引用、连接器或知识空间。

可信执行器封闭私有文件集合后，由 Governance 在结果事务内写完整 PG BYTEA 和精确 manifest。独立审核 Agent 必须从专用读面逐项读取全部正文，重新校验字节与 SHA，并附上绑定该 review Run 的私有随机读取回执；模型布尔值、人为查看或摘要均不能替代证据。签发回执前复验锁等待后的账号、预设修订、当前运行和心跳。业务完成继续拒绝历史 unknown、普通附件、仓库修改和外部副作用。

专家创建/编辑页面加入产出类型、资源冲突提示；结果页显示不可变文件正文。本地专家目录不提供文件审核语义，显式返回不支持。迁移为 `029_governance_controlled_files.sql`，详见[受控文件审核](controlled-file-review-2026-11-07.md)。

## 验收与外部边界

本批使用独立本机 PostgreSQL、Redis、MinIO 与真实 HTTP，冻结代码后统一验收如下。Go 计数包含子测试，平台文件数按 JSON 报告的 `testResults` 计。

| 范围 | 通过 | 失败 | 跳过 | 本机报告 |
| --- | ---: | ---: | ---: | --- |
| 完整平台，242 文件 | 2043 | 0 | 0 | `/private/tmp/lumo-applications-platform-final-20261107.json` |
| Governance 全包 race | 272 | 0 | 0 | `/private/tmp/lumo-applications-governance-final-20261107.jsonl` |
| Session-control 全包 race | 262 | 0 | 0 | `/private/tmp/lumo-applications-session-control-20261107.jsonl` |
| Connector-gateway 全包 race | 70 | 0 | 0 | `/private/tmp/lumo-applications-connector-fenced-final-20261107.jsonl` |

完整平台套件包含三个新增迁移的真实 PG DDL shape、附件二进制 HTTP 入站与目标独立认证、真实 AgentLoop/JSONL 重启和分支、原生审批服务与页面纯文本交互、完整文件独立读取与回执门禁。复核中修复了文件名保留标记注入、预取消 Provider Promise 未观察、锁等待后授权过期以及缺少精确 Session 代次的问题；中文与 emoji 文件名按完整 Unicode 字符和 UTF-8 字节上限处理。

三个 Go 模块 vet/build、平台与 UI 类型检查、UI bundle 均通过。Helm 全门禁及部署组合验证通过，包含附件与连接器新增正反例；日志分别为 `/private/tmp/lumo-applications-helm-final-20261107.log` 和 `/private/tmp/lumo-applications-helm-combinations-final-20261107.log`。本轮三个临时容器、匿名测试卷和三份凭据文件已清理；共享旧环境未纳入清理。组件与构建检查不能替代实际部署逐页视觉验收。

真实供应商此前返回访问拒绝，没有新的供应商成功回执；本轮 AgentLoop 使用确定性 adapter。实际 IdP、KMS/恢复目标、物理多主机故障和生产 HA/SLO 仍需要相应目标环境。任意宿主操作、离线工作区迁移和历史对象全量 GC 未在本批开放。

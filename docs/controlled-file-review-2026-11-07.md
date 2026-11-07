# 受控文本文件的强制异构审核

本批将可证明的交付范围从封闭文本扩展到**封闭生成的 UTF-8 文件**。不覆盖任意附件、仓库修改或连接器外部副作用，也不接收浏览器、模型自报的 `proven` 或影响数量。

## 预设与执行边界

AgentPreset 的 `output_profile` 有两种选择：

| 配置 | 执行能力 |
| --- | --- |
| `platform-closed-text-v1` | 缺省值，保留原封闭文本交付行为 |
| `platform-closed-text-files-v1` | 只允许本次执行的 `generate_text_artifact`，必须实际生成至少一个受控文件 |

文件档位不能同时配置 `connector_ids`、`knowledge_space_ids` 或 `system_prompt_ref`。API 创建/更新会拒绝该组合；若数据库历史或其他可信写入者绕过预设校验，执行前快照仍将带外部能力的预设记为 `unknown`，不会给其可证明标记。预设选择在服务端冻结为不可变执行快照，数据面必须精确匹配该快照与实际预设版本后才创建 Agent。

受控工具只接收 `name`、`media_type`、`text`：

- 名称是受限 ASCII 叶文件名，只支持 `.txt`、`.md`、`.csv`、`.json`，不接受路径或 `..`；媒体类型与后缀精确匹配，JSON 必须有效。
- 正文必须是有效 UTF-8，不允许 NUL。每项 1–32 KiB，最多 16 项，总计不超过 256 KiB；名称不区分大小写去重，不允许覆盖。
- 工具把正文写入本次执行的私有集合，不能引用宿主文件、对象键、URL、已有附件或任何外部可执行操作。结束时可信执行器封闭并枚举整个集合。
- 全局工具被限制，单调 guard 再次拒绝除本次受控生成工具外的所有调用。审核者保持无工具文本档位。

文件内容作为数据保存和展示，不在服务器执行。工具返回文件名与字节数，完整正文由执行器保存；模型最终文本中自报的文件列表不能替代真实工具集合。未生成文件、产生非文本最终输出或预设/快照不匹配均失败关闭。

## 不可变产物和完整清单

可信运行回执包含执行器枚举的 `files`。Governance 复验文件格式、数量、字节上限和名称唯一性，在记录不可变 TaskResult 的**同一数据库事务**中写入 `governance_run_file_blobs` 的完整 BYTEA 字节与 `governance_run_output_manifests`。这里使用有界 PostgreSQL blob，避免把对象上传与业务提交之间的空窗当成已交付；当前不声称支持大文件或任意二进制文件。

新清单 scope 为 `platform-closed-text-files-v1`，同时保留完整最终文本和 summary，并逐项枚举文件的固定 entry ID、名称、媒体类型、长度和 SHA-256。每个字节、元数据、条目顺序和 summary 都进入精确清单摘要。不存在更改 blob 的应用接口，重放同一回执幂等，改变已提交回执冲突。

普通上传的 `governance_task_artifacts` 仍不属于该集合，文件档位也不能后追加普通附件；当前或历史存在任何这类产物都继续阻止业务完成。历史 `unknown`、旧运行缺失快照、执行后无有效清单及未登记影响同样不能被一次新的受控文件交付覆盖。

## 独立读取与异构审核

审核任务仍通过原子 `review-tasks` 接口创建并绑定精确生产 Run 与清单摘要。审核者必须使用不同 Worker，实际执行快照还必须满足已有预设、模型和节点的异构矩阵；计划中的预设不能替代运行事实。

准备审核后，可信审核执行器逐项调用：

`GET /v1/runtime/task-runs/{reviewRunID}/review-files/{entryID}`

该接口只接受服务凭据和 Realm，并强制精确的 reviewer Run、assigned node、Session、当前 RUNNING 尝试、已冻结文本档位、当前预设版本、活跃 owner 和活跃心跳。生产者不能作为自己的 reviewer 读取产物并签发证据。绑定过期、生产运行已重试或条目未登记都会拒绝。

服务器从独立 blob 表读取每个文件**完整字节**，重新核对长度、SHA-256、媒体和名称，然后签发随机读取 receipt，绑定 reviewer Run、生产 Run、清单摘要、entry、node 和 Session。读取重试返回同一凭据；它只能随该审核执行的不可变结果使用，不能跨 Run、节点或清单重放。

审核执行器对响应完整流读取并再次检查字节长度与 SHA-256，全部成功后才把每个完整正文和原始任务契约放入审核上下文。读取凭据保留在可信执行器中，不进入模型提示。模型只输出原有严格 JSON verdict，不能创建读取证据或改写 receipt。缺少任一正文、读取错误、元数据不符或错误字节都会在模型运行前拒绝。

审核结果由可信执行器附上服务器读取凭据。结果提交和业务 `complete` 事务都要求每个清单文件恰有一份有效凭据，并重新检查完整 blob 集合。最终还校验精确摘要、不可变结果、独立实际执行快照、未过期绑定、最新生产与审核 Run、历史影响以及已有组合验收规则。缺项、伪造、重复、过期、篡改、额外 blob 或普通附件均保持冲突，不能放行。

## 用户查看与持久化

TaskResult GET 沿用当前任务 viewer 权限，完整文件正文从清单和不可变 blob 复核后返回，页面以纯文本展示。用户读取不会生成审核执行凭据，也不能代替独立审核；普通用户结果视图不返回 `review_file_receipts`。失败运行的原始回执可供排查，不因此取得可验收清单。

迁移 `029_governance_controlled_files.sql` 与启动 DDL 收敛，新增 preset 输出档位、`governance_run_file_blobs` 和 `governance_review_file_reads`。默认档位为原文本。只有可信运行结果接口为转义后的有界文本文件提供 4 MiB 请求上限，其他认证 JSON 入口保留原限制。

## 回归入口

- Governance domain：完整清单摘要、文件类型、UTF-8、逐项和聚合大小。
- Governance store `TestControlledFiles*`：完整异构审核通过；未读取/伪造凭据拒绝；跨 Realm、node、Session、生产者自读及失活运行拒绝；blob 篡改、额外 blob 和普通附件继续阻止验收；无快照、错误档位及人工自报拒绝。
- Governance server：可信接口认证与严格有界结果解码。
- `subagent-host/__tests__/controlled-files.spec.ts`：真实 AgentLoop 中禁止宿主工具、生成工具实际枚举、封闭集合上限、逐项独立全文读取、哈希检查和凭据不进模型上下文。
- 原 RunReview、TaskResult、DDL ownership 与生产完成门禁测试继续回归。真实 PostgreSQL/race 验收结果由本批统一报告记录；未配置外部服务时的 skip 不作为通过。

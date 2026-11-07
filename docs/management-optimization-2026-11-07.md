# 知识库、用户与项目管理优化（2026-11-07）

按要求先提交优化前代码：分支 `codex/v1.2.1`，提交 `43366c7`（`feat(platform): complete governed distributed execution and native model deployment`）。该提交未推送。本记录对应随后继续开发的管理功能改动。

## 知识库

- 文件列表返回 `sha256` 与当前身份的 `canEdit`，保留对象存储 key 在服务端。目录同样返回 `canEdit`；文件和目录的继承 ACL 在批量 SQL 中计算，替代逐条权限查询。
- 新增 `DELETE /lumo/api/knowledge/library/files/:docId`，要求提交列表读取的 `expectedSha256`。身份来自可信会话；Provider 在事务中重新校验编辑权限与版本，原子删除文件元数据、直接分享、权威来源和向量分片，同时记录墓碑、图投影和远端向量清理 outbox。
- 删除在页面二次确认；只读分享仅显示可用的查看与下载操作。删除成功后移除预览、命中和来源详情；冲突保留文件并提示刷新。空目录删除接入既有 API，非空目录返回冲突。
- 私有父目录下单独分享的子目录、文件以根目录共享入口显示，避免已授权内容无法导航。面包屑遇不可见父级止步。
- 最终检索按权威来源版本、墓碑和 ACL 重新过滤，防止候选读取与删除交错时把消失的私有文件误当成公开手工来源。
- 上传在 embedding 期间被删除时，迟到的 `ingest/upsert` 不能恢复来源。墓碑新增幂等的 `library_file` 列，防止丢掉文件元数据标签后复用已删除文件 ID；重新上传生成新 ID。手工来源的正常新建和恢复行为保留。
- 分享修改在 Realm ACL 事务锁内重新鉴权；直接授权或祖先目录授权被撤回后，旧分享请求不能重新授权自身。该锁也用于文件、目录删除，避免删除鉴权使用旧快照。
- 图投影仅领取每个文档最早未完成的操作，防止不同副本通过 `SKIP LOCKED` 越过旧 upsert 执行 remove 后又复活图节点；数据库连接失败后允许下一轮重试。
- 页面为目录、预览和分享请求增加过期响应保护；原授权未读完时禁止保存，避免空列表覆盖现有分享。

原始对象采用内容寻址，可能被多个文件引用。本批删除不物理移除共享 blob；引用感知 GC 仍为后续存储维护项。远端图与向量清理由持久 outbox 最终完成，权威库中的删除及检索过滤立即生效。

## 用户管理

- `GET /v1/users` 支持 `q/status/department_id/limit/offset`，返回 `users/total/limit/offset/has_more`。筛选先于分页，计数和当前页共享只读 repeatable-read 快照。
- 搜索为 ID 或名称的字面子串，`%` 和 `_` 不扩大匹配；校验重复参数、无效状态及分页。默认及最大每页 200，保持旧调用兼容；管理页面每页 50。
- 页面接入部门与状态全库筛选、防抖搜索、分页统计、失败重试、目录缩减后的有效页回退。创建后按新 ID 定位用户，较晚返回的旧筛选响应不能覆盖新结果。
- 用户资料、凭证、企业身份、角色、部门及角色目录沿用现有管理权限；同步 pending ref 防止同一批重复提交。筛选与分页布局支持窄屏折行。

## 项目管理

- 项目父行锁串行化 owner 变更与生命周期、资源操作，防止并发移除或降级最后两个 owner 后项目无人管理。
- 空间和自动化全局 ID 冲突不能覆盖其他项目的数据；归档项目拒绝内容及资源写入。归档项目的 owner 仍可管理成员或恢复项目。
- 新增 `PATCH /v1/projects/:id`，请求 `{name, expectedName}`，使用读取时名称作为并发前置条件。页面保存草稿、冲突显式重读，并区分保存失败和保存成功但刷新失败。
- 项目详情按 owner/editor/viewer 与归档状态显示操作；补齐自动化编辑、保留配置的启停、删除确认，以及生命周期与资源操作的重复提交保护。
- 项目父组件不再吞掉刷新或归档/恢复错误，失败保留详情并展示原因。
- 任务报告根据治理任务的权威 `project_id` 校验归属，写报告要求 edit 权限；读取计量同时限定项目，避免同 realm 下伪造查询项目或复用 session_ref 访问其他项目报告与成本。

## 剩余功能续开发

本批后续补充以下能力；最终回归证据见本文末，前一阶段的结果不替代新增代码验收。

- 资料库文件与目录整理：重命名、移动、revision CAS、防环以及源/目标权限的事务内重验。
  删除同时比较内容 SHA 和元数据 revision；上传落库前重新检查当前角色及目录编辑权限。
- 项目空间编辑/删除、自动化配置 revision、跨页用户选择器，以及 Go/TS 两个共表写面的
  项目父锁、Realm 隔离、归档写保护和全局资源 ID 冲突检查。针对已有项目的 Projects HTTP 写入口
  在锁定项目后重新检查当前成员权限，覆盖慢请求体与等待项目锁期间的撤权。
- 项目预算管理：由 metering 唯一写入配置及账本；owner 可初始化、期中调整或明确确认后
  重置本期预算。调整保留已用额度，配置有 revision CAS 和事务审计；余额中间计算采用
  BigInt，拒绝超出安全整数范围。项目详情按需展开预算面板，归档及只读成员保留只读视图。
- 角色动作策略：Realm 内单父继承、最多 32 层、环检测、停用截断及 deny 优先；可配置
  `task:delegate` 与 `task:execution:update`，未设置规则时保持内置兼容默认。
  管理界面提供策略和父角色编辑，写入使用版本前置条件、Realm 锁和审计。
  直接管理员身份与继承角色分开，任务动作授权不能提升组织管理权限。可选 OPA 使用同一
  事实进一步收窄，异常拒绝；具体合同见 [授权判定契约](authorization-contract.md)。
- 协作 Space 授权：Governance 根据 Projects 的权威归属解析项目，再逐次读取
  Collaborator 当前 grant。项目 owner 可管理 read/edit/comment/publish 四个独立权限；
  CAS、用户状态、成员资格、项目状态和审计在事务中校验。WebSocket 输入、输出和空闲期
  都检查撤权；Space 实例使用 incarnation，删除后复用 ID 必须显式重新授权。
- 动态 owner 会话分支：从最新完整轮次继承公开历史，authority 分配新会话 ID 和独立
  工作目录；创建及激活前检查当前用户、项目、节点和 owner。分支不会共享父会话后续消息。
  另提供显式开启的当前用户只读知识查询，本地与远程均绑定每次查询的登录身份和项目，
  远程身份独立签名，不切换共享 proxy 的部署身份。见 [动态 Session owner](dynamic-session-owner-2026-11-06.md)。
- 共享内容引用只读审计 CLI：扫描知识资料、治理附件和会话日志的正向引用，记录缺席、
  失败和截断覆盖；任何零已知引用对象仍受保护，工具不执行物理删除。见
  [引用审计说明](content-reference-audit-2026-11-07.md)。
- 桌面 SkillHub 测试夹具兼容仅安装带版本号 Python 的 Framework/Homebrew 布局，继续
  验证应用迁移到中文、空格和特殊字符路径后可运行，以及外部 Python 环境不能污染内置 CLI。

## 初批验证

| 检查 | 结果 |
| --- | --- |
| 知识库与 knowledge seam 契约 | 11 文件，63 通过，0 失败，0 跳过；其中 18 项使用真实 PostgreSQL/pgvector |
| Lumo UI API、组件与父子集成 | 37 文件，283 通过，0 失败，0 跳过 |
| Projects `go test -race -count=1 ./...` | 3 个测试包通过；43 个顶层测试，真实 PG；`go vet ./...` 通过 |
| Governance `go test -race -count=1 ./...` | 7 个有测试包通过，真实 PG；新目录 4 项单独实际执行通过；不估算未以 verbose/json 记录的用例总数 |
| 全平台 `tsc -b --noEmit` | 通过 |
| Lumo UI 服务端及浏览器 bundle | 通过 |
| `git diff --check`、上游源树检查 | 通过；`deepseek-harness` 源码及锁文件未修改 |

真实 PG 使用任务专用 `pgvector/pgvector:pg16` 容器，knowledge/users/projects 分库，临时凭据仅保存在本机受限文件，完成后清理。测试 helper 固定将数据库级 vector 扩展装在 public，避免并行 spec 的私有 schema 隐藏扩展类型。

以上是本批管理功能验证。未在本批重做外部模型供应商、物理跨主机生产故障或浏览器视觉验收；此前结果见 `model-and-docker-acceptance-2026-11-07.md`。

## 续开发最终验收与边界

| 检查 | 当前版本结果 |
| --- | --- |
| 平台完整 Vitest | 216 文件，1873 PASS / 0 FAIL / 36 SKIP，真实 PG/Redis/HTTP；未排除测试文件 |
| 认证代理显式 HTTP 套件 | 3 文件，14 PASS / 0 FAIL / 0 SKIP；补跑上行 36 个跳过项中的 14 个，使用 `LUMO_AUTH_PROXY_TEST=1` |
| Projects 全包 race | 72 PASS / 0 FAIL / 0 SKIP，50 个顶层测试、3 个测试包，真实 PG/HTTP |
| Governance 全包 race | 234 PASS / 0 FAIL / 0 SKIP，121 个顶层测试、7 个测试包，真实 PG/HTTP，包含 OPA 传输与旧审计约束升级 |
| Collaborator 全包 race | 114 PASS / 0 FAIL / 0 SKIP，99 个顶层测试、7 个测试包，真实 PG/Redis/HTTP/WebSocket，包含旧 Redis WAL 导入 |
| Go 静态检查 | 三模块 `go vet ./...`、`go build ./...` 通过 |
| 平台及 UI TypeScript | `tsc -b --noEmit`、UI 客户端独立检查通过 |
| UI bundle | 服务端与浏览器 bundle 通过 |
| DDL 门禁 | 8 项静态与 17 项真实 PG shape 检查均通过，已包含在平台通过总数内 |
| OPA 示例 Rego | 使用缓存 `openpolicyagent/opa:1.3.0` 镜像、断网只读挂载，7/7 通过 |
| SkillHub | 9 项通过，已包含在平台通过总数内 |
| `git diff --check` 与上游源树 | 通过；上游 `fcc0ad46`，跟踪源码及锁文件无修改 |
| 浏览器视觉 | **未完成**；没有可作为验收证据的页面截图或逐页实机结果 |

完整平台报告：`/private/tmp/lumo-platform-complete-final.json`；认证 HTTP 报告：
`/private/tmp/lumo-auth-optin-complete-final.json`；Go 报告：
`/private/tmp/lumo-{projects,governance,collaborator}-complete-final.jsonl`。
Go 通过数包含子测试，另列顶层数量，不能把两者相加。平台与认证专项去重后共 1887 项
通过，仍有 22 项 MinIO 附件、对象、spill 和冷归档测试因缺少对应服务而未执行。

本批新增预算、引用审计、慢请求体/等待锁撤权、角色 CAS/审计/锁内管理员复验、项目
Realm/归档边界、Space 实例/历史认领、WebSocket 撤权及当前用户知识项目/ACL 最终过滤
均已实际执行。验收发现并修复角色策略事件不在旧审计 CHECK 枚举内的问题；启动 DDL 与
迁移 021 均扩展枚举，回归确认旧登录历史保留、重复启动/迁移不缩窄枚举、未知事件仍拒绝。

仍待开发及外部验收的能力以 [剩余功能复核](remaining-development-2026-11-07.md) 为准；
本批没有宣称共享内容物理 GC、完整动态会话副作用能力或生产 HA 已完成。

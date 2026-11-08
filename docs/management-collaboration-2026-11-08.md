# 管理与员工智能体协作交付（2026-11-08）

本批在 `v1.2.1` 上补齐员工安全管理、项目目录及员工/智能体进度汇报和监督视图，
并修复管理操作与进度写入在等待数据库锁期间发生撤权后的权限检查。
已有用户、部门、角色、项目资源和角色继承功能继续复用；这里记录本批新增行为，
不把历史计划的空复选框视为未开发功能。桌宠附加开发另记。

## 员工、角色和权限管理

用户管理详情新增“安全与权限”入口，展示当前直接角色、继承角色、每个动作的允许/拒绝
结果，以及匹配的策略来源。继承到管理员名称不会获得组织管理身份；组织管理仍要求
当前有效的直接 `platform_admin`、`realm_admin` 或 `admin` 授权。

管理员可分页查看指定员工的有效登录会话和安全事件，并附理由撤销单个或全部会话。
会话只返回撤销用 ID、客户端 IP 和时间，不返回 token、token hash 或认证材料。
撤销与审计在同一事务内完成；审计写入失败会回滚撤销。响应使用 `Cache-Control: no-store`。

| Governance API | 行为 |
| --- | --- |
| `GET /v1/users/{userID}/security` | 账号状态、当前角色解析、动作说明、直接组织管理员身份 |
| `GET /v1/users/{userID}/sessions?limit=25&offset=0` | 有效会话分页，返回 `total/limit/offset/has_more` |
| `GET /v1/users/{userID}/security-events?limit=25&offset=0` | 安全事件分页 |
| `DELETE /v1/users/{userID}/sessions/{sessionID}` | JSON `{ "reason": "…" }`，撤销指定会话 |
| `DELETE /v1/users/{userID}/sessions` | 同样要求理由，撤销该员工全部会话 |

上述接口由 `/lumo/api/users/…` 代理接入页面。分页上限 100；服务端验证用户、realm、
当前直接管理员授权和输入范围。敏感读取也在组织锁内复验管理员，不能依赖请求头里的
旧角色继续访问。创建/修改用户、重置凭据、分配/撤销角色、创建/修改角色与部门、
OIDC 绑定/解绑同样补上事务内管理员复验。角色与部门创建现在记录审计事件。

角色动作、继承层级和 deny 优先仍使用原有 `ResolveRolePolicy`，不另建可编辑策略源。
角色策略修改沿用 revision CAS；授权说明与执行判定共用解析器。

## 项目目录

新增 `GET /v1/projects/directory`，页面代理为 `/lumo/api/projects/directory`。
旧 `GET /v1/projects` 保留，兼容已有项目选择器。

| 参数 | 取值和含义 |
| --- | --- |
| `q` | 名称或 ID 的不区分大小写子串；最多 200 字符，`%`、`_` 按字面搜索 |
| `status` | `active` / `archived`；省略表示全部 |
| `role` | `owner` / `editor` / `viewer`；省略表示全部 |
| `sort` | `recent`（默认）/ `name`；相同时间有 ID 排序兜底 |
| `limit` / `offset` | 默认 20 / 0；每页 1–100，offset 不超过 100000 |

响应包含 `projects`、每项的 `yourRole/memberCount`、过滤后 `total`、分页信息，以及
当前用户所有可见项目的 `summary.total/active/archived`。统计与当前页在一条 SQL 的
同一快照中查询；跨 realm 和非成员项目都不计入。超出末页仍返回真实总数和空数组。

页面提供搜索、状态和角色过滤、排序、翻页及进入项目详情。项目或成员变化导致末页
为空时退回剩余末页。取消旧请求并忽略晚到响应；服务异常、畸形 200 响应均显示可重试
错误，不将失败伪装为空项目，也不使整个项目管理页面崩溃。

## 员工和智能体进度管控

新增“员工与智能体进度”视图，按与我相关、部门、全组织查看可见任务，支持当前页搜索、
阻塞/逾期/待更新/待验收/风险过滤、进入任务协作与运行详情，以及进度历史和人工汇报。
部门范围要求部门管理角色，全组织范围要求直接管理员；范围选择只筛选候选任务，
普通监督者仍须满足任务 ACL 和当前项目权限。服务异常会明确显示，不返回假空列表。

| Governance API | 行为 |
| --- | --- |
| `GET /v1/workforce/progress?scope=mine&limit=50&cursor=…` | 已授权任务、当前 Run、当前进度和健康状态；`scope` 可为 `mine/department/all`，limit 最大 200 |
| `GET /v1/tasks/{taskID}/progress` | 当前 Run、全任务最新 revision、当前检查点、最近 30 条历史和 `can_update` |
| `PUT /v1/tasks/{taskID}/progress` | 写入带 Run 和 revision 前置条件的检查点 |
| `GET/PUT /v1/runtime/task-runs/{runID}/progress` | 受信运行时按持久节点/Session 绑定读取和汇报，不对普通浏览器开放 |

Web 页面使用对应 `/lumo/api/workforce/progress`、`/lumo/api/tasks/{taskID}/progress` 代理。
列表返回 `summary_scope: "page"`：数字是当前页获授权任务的统计，不声称全组织总量。
游标绑定 realm、用户和任务范围；当前页更新不会改变游标使用的创建时间和 ID。

检查点包括 `run_id`、`expected_revision`、`status`、`percent`、`summary`、`next_step`、
可选截止时间和阻塞原因。状态闭集为 `on_track/at_risk/blocked`，进度为 0–100 整数；
阻塞状态必须填写原因，其他状态不接受阻塞原因。每次写入追加新 revision、操作审计和
父任务的子任务进展通知，不覆盖历史记录。状态为 100% 也不会推进执行或验收状态机。

任务行锁串行化写入，revision CAS 冲突返回 409；界面保留冲突提示并要求重新读取后核对。
重试创建新 Run 后旧尝试的进度仍在历史中，但其百分比、阻塞和截止时间不算作当前进度。
旧 Run、终态执行或已验收/归档任务拒绝新写入。健康状态按当前尝试计算：执行阻塞或
当前检查点阻塞、超过目标截止时间、活跃任务 24 小时未更新，以及处于业务验收阶段。
已验收或归档任务不继续触发阻塞/逾期/停滞提醒。

### 人工代报的角色边界

人工汇报同时要求任务 contributor（或当前直接管理员）、`task:delegate` 和
`task:execution:update`。`manager/dept_manager/owner` 的原有默认角色只允许委派，
可查看获授权任务、监督进展；代员工汇报必须显式配置执行更新权限，不能因“是管理者”
或“是 contributor”自动扩大权限。界面的 `can_update` 与这一规则一致。

写事务先取得组织锁，再锁任务行，重新读取活跃用户、当前任务参与权、未过期的直接角色
和角色继承策略。协作者移除、用户停用、grant 撤销/过期、角色停用、直接或继承 deny
发生在等待锁期间，写入都会被拒绝；旧请求头不能恢复已撤销的授权。原有项目范围和
外部 OPA 判定仍在请求接入层执行；本批不宣称所有跨服务权限事实已经获得分布式事务锁。

### 运行时汇报

普通受治理 Agent 新增本 Session 的 `report_task_progress` 工具。模型不能选择 task、
Run、realm、node、Session、actor 或 revision；运行时使用固定执行身份并获取权威版本。
控制面同时验证持久 Run 的节点、Session 和调度绑定。冲突不自动覆盖重试。

运行时自动记录实际准入/启动阶段及已产出交付物、等待验收阶段，不凭时间推算中间百分比。
自动阶段只替换本 reporter 自己先前的自动记录，保留人工和模型显式报告，包括尚未解决的
阻塞、风险及未完成工作。最终回复文本不证明阻塞已解除。封闭文本/文件执行档位继续
保持原有工具边界，不向模型开放额外进度工具；运行时阶段记录本身不构成交付验收。

## 数据库迁移

- [033_task_progress.sql](../platform/deploy/migrations/033_task_progress.sql) 创建追加式
  `governance_task_progress` 和按 Run 查询最新检查点的索引；主键为 realm/task/revision，
  任务和 Run 外键绑定现有治理实体。与 `Store.Init` 的 DDL 同步，不回填虚构进度。
- [034_user_security_audit.sql](../platform/deploy/migrations/034_user_security_audit.sql)
  增加用户会话分页索引，扩展安全审计事件 CHECK，保留旧事件；允许角色/部门创建和
  管理员会话撤销审计。真实 PG 回归覆盖旧 032 约束下的历史、应用 034、重复应用和
  再次 `Store.Init`，并确认未知事件仍被拒绝。

新接口应与对应控制面和 UI 一起部署。旧控制面返回不兼容响应时页面报告错误；不静默
回退到无权威版本的写入。迁移不代表生产备份、滚动升级或回滚演练已完成。

## 本批验证证据和范围

使用官方 PostgreSQL 17.6 的独立本机测试实例，数据位于 `/tmp`，仅绑定 loopback。
Docker Desktop 本次启动发生自身 panic，测试改用独立编译的 PostgreSQL；这不是 Docker
多节点、物理跨主机或生产 HA 验收。各 Go 测试使用独立 schema。

| 验证 | 已确认结果与范围 |
| --- | --- |
| Projects 全包真实 PG `go test -race -count=1 -json ./...` | 86 PASS（含子测试），0 FAIL、0 测试 SKIP；日志 `/tmp/lumo-projects-go-test.json`。覆盖项目目录及原资源/成员/归档/报告授权回归 |
| 角色/进度最终定向真实 PG race | `./internal/store ./internal/server ./internal/domain -run 'TestTaskProgress\|TestRuntimeProgress\|TestProgress\|TestRolePolicy\|TestResolveRole'`，34 PASS、0 FAIL、0 SKIP；日志 `/tmp/lumo-progress-role-review.json`。包含等锁撤权与 manager 显式授权/deny/撤权 HTTP 链路 |
| Governance 最终全包真实 PG race | 最后补丁之后再次执行 `go test -race -count=1 ./internal/...`，auth、breakglass、device、domain、readiness、server、store 共 7 包全部通过，包含当前角色锁内复验与员工安全管理实现 |
| 员工安全与迁移回归 | 真实 PG 已通过用户范围隔离、会话不泄密、审计失败回滚、组织写入等锁撤管理员及 034 历史/重复迁移/启动兼容用例；具体用例见 `internal/store/user_security_test.go` |
| Runtime 最终自动阶段修复回归 | `subagent-host/__tests__/{task-progress,governed-run,controlled-files}.spec.ts` 共 3 文件、40 项通过（14:04:45）；真实 AgentLoop 读取持久检查点，显式 `on_track/at_risk/blocked` 均保留 40%，纯自动阶段为 0→100，封闭文件边界同时回归 |
| 相关 UI／runtime 整组回归 | 64 文件、544 项通过（15:12:13），包含桌宠回执／取消修复与新增用例；覆盖本批管理界面、代理、运行时和旧页面兼容，不等于整个 platform 全量，也不表示全部 544 项均为本批新增 |
| 桌宠桥接最后定向回归 | 整组之后补充原始 IPC 附件引用释放，38 项桥接测试再次通过（15:14），UI bundle 再次通过；未将此次小补丁冒充为又一次 544 项整组运行 |
| 项目目录组件 | 9 项通过，包含非法 200 响应、重试、筛选翻页、乱序响应及失去成员资格后的空页恢复 |
| 静态与构建验证 | 最终 platform `tsc -b --noEmit`、UI `tsdown` bundle 均通过；另已完成 lumo-ui TypeScript 检查、Go 编译和格式、`git diff --check`；`deepseek-harness/` 上游保持 clean |

033 的同形 DDL 已随真实 PG 的重复 `Store.Init` 验证幂等；本记录没有将此写成独立
033 文件的部署演练。034 则由测试实际读取迁移文件、重复应用并保留审计历史。

真实供应商/IdP 登录、生产员工账号、物理跨主机故障、生产升级容量和 SLO 不在本批
完成声明中。组件测试和本机 HTTP/PG 行为验证也不等于全部真实部署页面已逐页完成
视觉验收。桌宠附加功能与浏览器模拟验收边界见
[桌宠开发记录](./desktop-pet-2026-11-08.md)，安装应用内真实上传及模型执行不由上述测试计数证明。

# 旧团队迁移、流程委派与分页续开发（2026-11-06）

本轮继续在 `codex/v1.2.1` 开发。后续 Thread 本节点稳定执行、逐轮计量和迁移 015 的变化见 [Thread 稳定执行](./thread-stable-execution-2026-11-06.md)；下文验证数字保留为本阶段记录。交付位于 `platform/` 的公开插件扩展、共享契约与 Go 服务；未修改上游 dsh 跟踪源码，未使用 frontend-design。本记录更新 [团队隔离与线程看板](./team-isolation-and-thread-fleet-2026-11-06.md) 和 [页面、Bot 与智能体团队](./ui-and-agent-capability-2026-11-06.md) 中已变化的边界。

## 旧团队显式归属迁移

新增 `platform/tools/migrate-agent-teams.mjs` 与 `agent-teams/src/migration.ts`，仅支持 PostgreSQL。连接串从 `LUMO_TEAM_MIGRATION_DSN` 读取，不通过命令行传递或输出。

```sh
node platform/tools/migrate-agent-teams.mjs --inventory
node platform/tools/migrate-agent-teams.mjs --mapping /absolute/mapping.json
node platform/tools/migrate-agent-teams.mjs --mapping /absolute/mapping.json --apply --writers-stopped
```

第二条默认只预览团队迁移计划；打开 PG 后端可能执行 schema 初始化，因此不承诺数据库严格只读。正式迁移前备份存储、停止旧 writer 和派发，并排空或对账旧轮次；`--writers-stopped` 是操作方的显式声明，工具不会替代停写。

映射是 1..500 项数组，每项显式给出可信的团队归属与 inventory 指纹：

```json
[{"id":"old-team","realm":"tenant-a","ownerUserId":"owner-a","captainSessionId":"captain-a","sourceHash":"inventory 输出的 64 位 SHA256"}]
```

工具只认旧键等于记录 `id` 的 legacy 团队，跳过已带租户命名空间的键和墓碑。整批预检核对 captain、已有 realm/owner、源指纹、在途任务和目标冲突。每个团队使用单 SQL 原子写入新租户键并将旧键改为带映射的墓碑，保留未知 JSON 字段。整批不是一个事务：已完成项保留，同一映射可以重试；合法删除后的目标不会被复活，目标缺失或身份不一致会拒绝。新版 mailbox 不会模糊回退到旧 pending 等待项。

这项迁移没有实现真实多用户会话到 owner 的动态映射；新团队 owner 仍来自可信节点 `actingUserId` 配置。

## 治理委派与流程算子

Governance 的 `POST /v1/delegations` 接受可选 `Idempotency-Key`，限制为 1..200 个 ASCII 字母、数字或 `_ . : -`。持久回执以可信 `(realm, requester_user_id, request_key)` 为作用域，摘要取规范化请求、在意图补全和匹配之前计算。权限和项目访问检查先于回执读取；撤权后重试不会依靠旧回执继续取得访问。

同键同请求首次创建返回 201，重试返回 200、当前任务和首次 Run；同键改请求返回 409。并发竞争通过事务 advisory lock 协调，Task、Run、调度记录和回执同事务提交。后续任务改派不改变首次 Run 的事实。回执没有自动 TTL，随意删除回执会重新允许创建副作用。旧的无键请求保留兼容语义。

新增 `delegation.create` Flow 算子。流程必须经过现有提交与独立审核后发布；目标和权限参数只从已审核节点配置读取：

```json
{
  "nodes": [{
    "id": "delegate",
    "operator": "delegation.create",
    "config": {
      "projectId": "project-a",
      "assigneeWorkerId": "user:worker-a",
      "intent": "生成事件分析报告",
      "requiredTags": ["report"],
      "requiredSkills": []
    }
  }],
  "edges": []
}
```

`projectId` 必须等于可信流程项目，`assigneeWorkerId` 和 `intent` 必填；可选 requirements 必须为非空字符串组成的数组。该算子固定 `auto_assign:false`。事件内容作为不可信 JSON 附加到意图，不允许覆盖项目、用户、角色、Worker 或 requirements。输入最多 256 KiB，合并后的意图最多 8000 字符，请求和响应各最多 1 MiB；不跟随重定向，返回体还要核对 Task/Run 的身份与关联。

事件自动化的执行身份取流程作者当前有效的角色、用户状态与项目 owner/editor 成员关系；手工运行使用当前经认证并通过项目成员检查的调用者。消息发送者不是执行用户。手工 `POST /v1/flows/{id}/run` 使用委派算子时必须提供合法 `Idempotency-Key`；流程和发布版本与键共同限定执行。事件执行使用触发 ID、自动化 ID、流程 ID 和版本生成稳定作用域，再结合 realm、user 和节点 ID 派生治理键。显式重放会创建新的业务尝试，不能与同次投递重试混为一谈。

页面试运行和派单会为同一 path/body 保留 pending key：失败后重试沿用，确认成功后清除。该状态只存在当前页面挂载期间，刷新或关闭后不持久化；代理仅在相关创建路由转发校验后的键。

Compose Standalone、Cluster compact/full 的 flows 服务地址已接到 bundle 前缀环境变量；Standalone knowledge seam 指向 dsh-node，Cluster 指向 dsh-web。Helm 从本 release 已启用服务派生 flows 地址，并使用同源身份断言 Secret。算子需要 `LUMO_GOVERNANCE_URL`；未配置时不可用。治理委派 API 仍受就绪 Cluster 门禁保护，Standalone 的服务地址接线不表示该形态已开放治理委派。Bot 渠道仍默认关闭，原生厂商协议与回复不在本轮范围。完整使用约束见 [Bot 事件接入](./bot-ingress.md)。

## 实际计量与跨语言判据

Metering 已使用上游现行 `GenerateOptions.sessionId`、`TokenUsage.inputTokens/outputTokens`，并兼容旧字段。初始化、预算种子、模型准入与 cap API 共用 ready；预算允许后才调用模型。生成器提前结束或 adapter 失败时仍在 finally 等待已报告 usage 的 commit。

可信 governed Run 创建 Agent 前绑定 session 到 owner/project/agent/feature 和 `run:<runId>` trace，dispose 成功后释放绑定。预算缺行时拒绝调用；一次未知用量的调用仍可能越界，尚非精确 token 预留。provider 未报告的断网消耗不能据此补造账。本阶段 Thread 轮次计量尚未接线；后续已在显式本节点文本档位实现，见上方续开发记录。

§24.7/§24.8 新增同一 fixture 的 Go/TS 矩阵：2164 项 reviewer 判据、4 项 integration 判据。覆盖空白主体、缺省维度、三维异构、影响面边界与超 JS 安全整数；TS 校验 fixture 新鲜度，Go 读取同一份数据。强制异构审核仍需要可信完整影响面来源，不能把上传产物数当成完整影响面。

## 任务与线程分页

更正上一阶段“任务与线程各 500 条”的说法：旧治理接口实际最多返回 200 个任务，500 只是 UI 切片与线程读取上限，不能据此认定读到了完整舰队。

现有无分页参数的治理调用保留按更新时间读取最近 200 条。携带 `limit` 或 `cursor` 时按不可变 `(created_at DESC,id DESC)` 翻页，每页最多 200 条，并返回 `next_cursor`。每次查询都重查当前任务可见性；游标绑定 realm、user 与可见性模式，不授予权限。更新业务状态不会移动创建排序键；跨请求不是数据库快照，新任务通过刷新首页读取。

线程注册表按稳定 ID 使用 `after` 翻页，每批最多 500 条；聚合服务先取得治理授权任务页，再把 task IDs 作为过滤条件发给注册表。会话控制态仍按每 100 个 refs 批读。页面支持上一页、首页、下一批线程和下一页任务；成功后才提交页码，暂时读取失败保留上次成功内容并提示原因，401/403 则清除旧结果。陈旧响应不能覆盖较新请求。页面明确展示“当前页”，没有将分页结果宣称为全局实时快照或完成容量验收。

本轮真实 PG 测试还修复了普通列表与 `TaskAccess` 递归查询引用不存在 `parent_task_id` 列的问题，改从 `intent_contract` JSON 读取。列表与详情均采用祖先任务的直接参与者和显式协作授权；循环引用有界，跨 realm 父关系不授予权限。旧委派详情接口现可读取已授权协作者与继承参与者，仍检查当前项目权限；viewer 不因可读详情获得取消或状态变更权限。

新增迁移：012 为治理委派回执，013 为治理 `(realm,created_at DESC,id DESC)` 分页索引，014 为协作线程 `(realm,task_id,id)` 索引。服务启动 DDL 同时确保这些结构，适用于未主动执行集中迁移的部署；已有数据库执行迁移前仍需相应服务基础表。

## 验证范围与证据

使用隔离 PostgreSQL 16，不连接生产数据。以下为包含最终分页及授权修复的回归结果：

| 检查 | 已取得的证据 |
|---|---|
| TS 受影响套件 | 995 PASS / 0 FAIL / 0 SKIP，94 文件；包含团队、storage、UI、metering、subagent-host、共享契约和 DDL |
| governance 全模块 race | 102 PASS / 0 FAIL / 0 SKIP，含并发回执、分页、详情授权与真实 PG |
| collaborator 全模块 race | 84 PASS / 0 FAIL / 1 SKIP；唯一旧 Redis WAL 迁移用例因缺少 Redis 跳过，随后使用独立真实 PG + Redis 补跑 1 PASS / 0 FAIL / 0 SKIP |
| flows 全模块 race | 239 PASS / 0 FAIL / 0 SKIP，含算子与手工运行授权 |
| 迁移专项 | 7 项真实 PG，含独立 CLI 进程、并发和失败回滚 |
| governed Run 计量专项 | 4 项真实上游 Agent + PG |
| 真实进程联测 | Bot → 已审核发布 Flow → Governance → PG 创建 Task/Run；伪造发送者身份无效，重复消息复用触发，两个服务重启后 Bot 与手工调用复用原回执 |
| 部署检查 | Compose 三种合并配置、7 种 Helm 组合、第二 release 名和反例门禁通过；未安装 kubeconform，没有声称完成 K8s schema 检查 |
| 静态与构建检查 | 平台/UI 类型检查、UI bundle 构建、governance/collaborator/flows vet 与 build、git diff --check 均通过 |
| 上游洁净 | `assert-pristine.mjs` 通过，`git status --porcelain -uno` 为空；无可用 tag 时使用 `describe --always --dirty` 得到 `fcc0ad46`，没有 dirty 后缀 |

真实进程联测只验证到 Task/Run 创建，没有执行 Scheduler 或真实模型。此前 [页面记录](./ui-and-agent-capability-2026-11-06.md) 中的截图属于前一阶段；本轮新增分页的浏览器视觉验收被自动审批拒绝，因为本机预览 `http://127.0.0.1:4317` 缺少指定 origin 授权。本轮没有获取新截图，也没有绕过该限制；组件交互测试、类型检查与构建不受此项阻断。

本机日志在 gitignored 的 `platform/.build/team-continuation/`：`final-ts.log`、`final-ts-results.json`、`governance-test.log`、`collaborator-test.log`、`collaborator-redis-migration-test.log`、`flows-test.log`、`governed-bot-process-smoke.json`、`helm-combinations.log`、`compose-flow-wiring.json`、类型检查和 `ui-build.log`。全套测试之后只补充文档，不将更早阶段的数量混为本轮结果。测试用 PG、补跑 Redis 与本机预览服务均已停止，临时 PG 密码文件已删除，保留不含凭证的验证日志。

## 未闭合事项

- 后续已补本节点文本档位的 node/session 强绑定；跨节点路由、自动唤醒执行仍未接线。
- 真实多用户 session owner、Bot sender 到平台用户与持久 captain/team 授权、权限交集仍需开发。
- 后续已补显式 Thread 轮次计量；可信完整影响面、历史执行快照与 reviewer Run 绑定仍是强制异构审核的前置缺口。
- 大规模分页容量、真实 LLM、厂商 Bot 原生协议与回复、生产故障域和长期压测仍需验收。

本轮没有外部“最新技术”调研，没有更换已定案的调度、会合、消息或存储架构；也没有重跑 24 服务完整集群或部署生产。

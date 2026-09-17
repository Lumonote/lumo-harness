# 插件新增功能成熟度审计

> 审计日期：2026-08-31  
> 复核日期：2026-08-31（独立复跑全部可检验断言，见「复核结论」）  
> 审计范围：新增插件能力、多 Agent 管理、用户中心、上下游权限、项目与自动化、技能、连接器、资料库、开放设计与 PPT 入口，以及相关测试与工程质量。

## 结论

目前多数新增能力停留在“能看到、能触发”，还没有达到“可管理、可授权、可追踪、可恢复”。问题不只是界面粗糙，而是功能命名跑在真实能力前面。

## 状态更新（2026-09-02）

本文件的主体是 2026-08-31 的历史审计快照，不能再当作当前验收结论。下面三项当时的
P0 已完成收口：

- **构建链路**：Governance 与 Projects 均已通过 `go build ./...` 和 `go test ./...`；平台
  TypeScript 的 `tsc -b --noEmit` 也已通过，原列出的三处编译错误不再存在。
- **真实取消**：Scheduler 已有 `POST /v1/tasks/{taskId}/cancel`，先持久化控制意图、请求实际
  执行节点确认，才进入 `CANCELLING`；只有执行端终态报告才标为 `ABORTED` 并释放槽位。
  对应 PostgreSQL 集成用例 `TestCancelIntentAndTerminal` 锁定了这条状态机。
- **委派权限的直接漏洞**：项目成员校验、部门子树可见性和执行回报字段权限均已收口。Realm /
  Project / Space 的通用组合策略、临时授权和 break-glass 仍是产品与合规决策，不能用一组代码
  默认值假装已经定案。

当前尚未达到生产验收的主要事项见 `implementation-status.md`：真实多节点 resume/失联接管与
RocketMQ、Nacos、Milvus、Nebula、OPA、Vault 联合演练；目标企业 IdP/SaaS 的已批准外部配置；以及
受目标环境约束的证书、密钥轮换和 mTLS 部署。它们需要环境或业务所有者输入，不是仓库内可凭空
实现的 TODO。

## 复核结论

本文所有可检验断言已在同日独立复跑一遍。**P0 三条全部属实，引用行号精确命中**；分功能审计表抽查项全部命中。复核同时修正了 3 处数据、补充了 2 个原审计遗漏的问题：

| 项 | 复核结果 |
|---|---|
| P0-1 编译失败（3 处） | 属实，行号精确 |
| P0-2 取消只改状态 | 属实，且 Scheduler 侧根本没有 cancel 端点 |
| P0-3 权限未闭合（4 条） | 全部属实 |
| 分功能审计表 | 抽查 6 项全部命中 |
| `useState` 56 处 | **修正为 85 处**，问题比原文更重 |
| 插件版本展示 | **比原文更严重**：四个包实际全为 `0.1.0`，且同一包名挂了两个版本 |
| 测试数据 | **修正为全量口径**；`connector-gateway` 实际通过，原沙箱限制不成立 |
| CI 缺 Go 步骤 | **原审计遗漏**，见「CI 缺口」 |
| CI 第一铁律断言写错 | **原审计遗漏**，见「CI 缺口」 |

复核方法：`go build ./...` + `go test ./...` 逐模块跑满 10 个 Go 模块；`tsc -b --noEmit` 与 `vitest run` 跑全量；UI 断言逐条回源码定位。

## P0：必须优先处理

### 1. 核心服务当前无法完整编译

- Governance 多 Agent 画像构造错误：`platform/control-plane/governance/internal/store/store.go:536`。
- Projects 使用了未定义的 `ErrConflict`：`platform/control-plane/projects/internal/store/store.go:677`、`:758`。
- 全平台 TypeScript 类型检查存在附件策略缺少 `maxPixels`：`platform/dsh-plugins/attachments/src/minio-attachment-store.ts:92`。

这意味着“多 Agent、项目中心”等关键能力现在不是体验不完整，而是发布链路本身不成立。

复核实测输出：

```text
governance  internal/store/store.go:536:56  unknown field DisplayName in struct literal of type domain.UserProfile
            internal/store/store.go:536:80  unknown field Status
projects    internal/store/store.go:677:31  undefined: ErrConflict
            internal/store/store.go:758:31  undefined: ErrConflict
attachments minio-attachment-store.ts(92,5) error TS2741: Property 'maxPixels' is missing in type
            'Readonly<{ maxDimension: number; maxBytes: number; }>' but required in type
            'Readonly<NormalizationPolicy>'
```

影响面精确到这两个模块：10 个 Go 模块中 8 个 `go build` 与 `go test` 全绿，只有 governance、projects 失败；全量 `tsc -b --noEmit` 也只有这一个错误。三处都是独立的小改动，不是结构性返工。

### 2. “取消任务”只改状态，不一定停止真实执行

UI 调用委派状态接口把任务写成 `CANCELLED`，后端也只是更新任务记录，没有接通 Scheduler 取消、JobControl 或子 Agent 停止链路。

需要改为：

```text
取消意图
  → 持久控制命令
  → 执行节点确认
  → Run 终态
  → Task 状态归并
```

超时或执行节点失联时，应显示“取消中”或“取消失败”，不能直接显示“已取消”。

复核证据链，四跳全部落在同一处死胡同：

| 环节 | 位置 | 实际行为 |
|---|---|---|
| UI 取消 | `lumo-ui/src/client/index.tsx:993` | `cancelTask` → `updateTaskStatus(task, 'CANCELLED')` |
| 网关转发 | `lumo-ui/src/index.ts:408` | 透传 `POST /v1/delegations/{id}/status` |
| 后端处理 | `governance/internal/server/server.go:808` | 校验状态机后只有一句 `store.UpdateDelegationTask(...)`，随即 200 |
| 执行面 | `platform/control-plane/scheduler/` | **没有任何 cancel 端点**，全模块只有 `context.WithCancel` 这类进程内用法 |

值得注意的是能力其实已经存在，只是没接线：`platform/dsh-plugins/job-control/src/executor.ts:110` 有可用的 `external.cancel(command.reason)` 执行器，`subagent-host/src/run.ts:64` 也已经按 job-control 的控制意图设计。但 governance 是 Go 服务，两侧没有任何桥接代码——`platform/control-plane/` 全树搜不到 job-control 的引用。所以这不是要从零造取消机制，而是要把已有的 JobControl 通路接到控制面上。

### 3. 权限模型尚未闭合

当前 `task:delegate` 实际是硬编码角色白名单，而不是统一的权限判定。还存在以下问题：

- `dept_manager` 可以列出整个 realm 的任务，没有部门子树约束。
- 委派绑定 `project_id` 前没有明确验证发起者的项目成员权限。
- 任务参与者可通过同一接口修改技术状态、节点和 Scheduler 字段。
- 项目、Realm、Space 三层权限如何合成仍未定案；`docs/design-review.md:388` 已将其标为未解决问题。

复核逐条命中：

| 断言 | 证据 |
|---|---|
| `task:delegate` 是硬编码白名单 | `governance/internal/server/server.go:199-201`，`canDelegate` 是七个 `c.roles["..."]` 的或运算 |
| `dept_manager` 可列全 realm | 同文件 `:508` `all := isRealmAdmin(c) \|\| ... \|\| c.roles["dept_manager"] \|\| ...`，随后 `ListDelegationTasks(ctx, realm, userID, all)` 无部门过滤 |
| 绑定 `project_id` 不验成员权限 | 同文件 `:465` `ProjectID: req.ProjectID` 从请求体直接落库，`createDelegation` 全程无项目成员校验 |
| 参与者可改技术字段 | 同文件 `:709-728`（`updateTaskRun`）与 `:837`（`updateDelegationStatus`），过了 `taskParticipant` 即可写 `State`、`SchedulerTaskID`、`AssignedNodeID`、`FailureKind` |

三层权限合成确实仍未定案：`design-review.md` 的 N4 是该文件里**唯一没有「收账」批注的相邻条目**（紧邻其上的 N3 已于 2026-08-26 拍板收账），可作为“未解决”的直接佐证。

## 分功能审计

| 模块 | 当前本质 | 必须补齐 |
|---|---|---|
| 多 Agent 管理 | 委派表单、前 8 条任务的合成拓扑、Ruflo 技能提示词 | Agent preset/制品管理、所有者、模型与技能、权限范围、并发/驻留/健康；Task→Run→子 Agent 树；日志、费用、重试、改派、真实取消、报告与复核；SSE 实时状态 |
| 用户中心 | 当前身份展示、改密码、退出 | 拆成“个人中心”和“组织管理”；会话/设备列表与撤销、登录历史、MFA/Passkey、个人偏好；用户启停、部门树、角色分配、邀请、服务账号和 Agent 身份 |
| 上下游权限 | 角色白名单和零散项目 RBAC | 统一 `actor/resource/action/context` 判定；Realm∩Project∩Space 取最小权限；父 Agent 只能下授自身权限子集，并限制深度、预算、时长、连接器和数据驻留；授权申请、到期、撤销、break-glass、权限解释与审计 |
| 插件中心 | 静态 `BASE_PLUGIN_CATALOG`，全部显示“已内置” | 从 Registry/Provisioner/运行时读取真实状态；安装、升级、启停、卸载、回滚；依赖冲突、配置 Schema、密钥绑定、scope 差异确认、签名/摘要/发布者信任、健康与日志 |
| 技能中心 | 列表加“创建名称” | 技能正文编辑、版本、测试运行、审核发布、授权/撤销、适用对象、依赖、历史版本和回滚 |
| 项目/自动化 | 服务健康、原始调度表单、只读自动化列表 | 分离项目概览、成员、任务、流程、资源、用量；流程可视化编辑、版本 diff、审核；触发器校验、启停、试运行、运行历史、失败重放 |
| 连接器 | 可调用、停用、Web 诊断 | 注册/编辑/恢复、凭证状态、OAuth、Schema 驱动参数表单、调用审计；高敏感写操作的批准流程，而不只是返回 `approval_required` |
| 资料库 | 查询已发布片段 | 空间/数据源管理、采集进度、权限、版本、索引健康、来源详情和打开原文；当前“查看来源详情”只是文字 |
| 开放设计/PPT | 把提示词交给原生技能 | 附件/工作目录选择、实际任务进度、产物历史、预览、继续编辑和导出；当前“＋”、设计系统、演示大纲等不少元素仍是静态占位 |

### 复核抽查证据

抽查 6 项，全部命中。以下均在 `platform/dsh-plugins/lumo-ui/src/client/index.tsx`，除非另行标注：

- **子 Agent 拓扑是合成的**：`:857` 与 `:897` 两处 `const visible = tasks.slice(0, 8)`，数据源是委派任务列表，不存在父子 Run/child 关系。
- **插件中心是静态目录**：`lumo-ui/src/base-plugins.ts` 全文 88 行的字面量数组；`:760` 的卡片模板硬编码 `<i>已内置</i>`，可用动作只有「复制安装命令」与「查看上游仓库 ↗」。
  - **后续处置（已修）**：该静态面板与其目录已整体移除。`lumo-ui/src/base-plugins.ts` 零 importer，已删除；
    工作台插件目录改由 `data-plane/dsh-node/src/index.ts` 的 `basePluginRows` 提供（按 local/server 形态区分、
    带 surface 路由与中文名），基线 pin 与版本则由 `shared/manifests/plugin-baseline.manifest.json` 唯一承载。
- **资料库「查看来源详情 ↗」不可点**：`:670` 它是个 `<span>`，既不是链接也不是按钮，右侧检查面板只回显 docId、源版本和相关度三个已有字段。
- **用户中心只有三件事**：`:1058-1062` 身份概览、修改密码、退出登录。无会话/设备列表、无登录历史、无 MFA/Passkey。
- **自动化是只读的**：`:1066` `AutomationSurface` 每个列表项的 `onClick` 都只是 `openSurface('operations')`，无启停、试运行、运行历史。
- **连接器审批只是个状态码**：`connector-gateway/internal/server/server.go:246` 返回 `428 approval_required`，`dsh-plugins/connector/src/client.ts:64` 有对应类型，但两侧都没有审批流实现。

## 功能定位需要纠正

Ruflo 和 OpenDesign 当前主要是注册技能说明，并不是完整管理运行时：

- `platform/dsh-plugins/ruflo-orchestration/src/index.ts:23`
- `platform/dsh-plugins/open-design/src/index.ts:52`

在运行、资产和状态闭环完成前，产品名称应使用“技能入口”或“工作流启动器”，不宜直接称为“管理中心”。

插件版本展示也需要拆分：

- Lumo 包装插件自身版本；
- 被包装的上游项目或技能版本；
- 当前实际安装和运行的版本。

复核后这条要加重：实情不只是“容易让用户误以为”，而是**目录里的版本号没有一个对得上**，且同一包名挂了两个互相矛盾的版本。四个 Lumo 插件的 `package.json` 全部是 `0.1.0`，而 `base-plugins.ts` 展示的是：

| 目录展示的 packageName | 目录展示版本 | `package.json` 实际版本 |
|---|---|---|
| `@lumo/creative-skills` | `1.0.4` | `0.1.0` |
| `@lumo/creative-skills` | `5.1.0` | `0.1.0` |
| `@lumo/ruflo-orchestration` | `3.38.20` | `0.1.0` |
| `@lumo/archify` | `2.16.0` | `0.1.0` |
| `@lumo/open-design` | `0.1.0` | `0.1.0` |

`@lumo/creative-skills` 出现两次、两个不同版本，这已经不是口径歧义，而是同一份静态目录内部自相矛盾。拆分三层版本之前，至少应先让展示值有明确出处。

## 多 Agent 管理应形成的产品闭环

### Agent 资产

- Agent preset/制品引用，而不是新建重复的 Worker 真相表。
- 名称、说明、所有者、所属项目、状态和版本。
- 模型、Provider、系统提示、技能、连接器、知识空间。
- 最大并发、信任等级、数据驻留、预算和超时。
- 当前有效权限及其来源。

### 任务与 Run

- 业务 Task 与技术 Run 分开展示。
- 每次重试、改派生成新的 attempt，保留旧 Run。
- 展示节点、Worker、开始/结束时间、失败类型、日志、费用和证据。
- 任务支持取消、暂停、重试、改派、打回、复核和归档。
- 所有操作均记录操作者、理由和策略判定。

### 子 Agent 拓扑

- 拓扑必须来自真实父子 Run/child 数据，而不是根据任务列表合成。
- 展示委派深度、继承范围、预算消耗、每个子节点状态和汇总规则。
- 父任务取消时应向所有活动子任务传播控制命令。
- 子 Agent 不得自动获得父 Agent 的全部权限，只能获得显式下授的子集。

## 用户中心与组织管理

### 个人中心

- 基本资料与个人偏好。
- 修改密码与密码强度提示。
- 活跃会话、登录设备、单个会话撤销和全部登出。
- 登录历史与安全事件。
- MFA、Passkey 或企业身份提供方状态。
- 当前角色、项目、部门和权限摘要。

### 组织管理

- 用户搜索、创建、邀请、启停和离职处理。
- 部门树、负责人和子部门范围。
- 角色、权限及用户角色分配。
- 服务账号和 Agent 身份。
- 临时授权、到期授权和批量撤销。

人员画像和标签不应继续混在项目运营大页中，应移入组织/Worker 管理，并根据权限区分“编辑自己”和“管理他人”。

## 权限体系建议

### 统一判定模型

```text
PolicyDecision(
  actor,
  resource,
  action,
  context
) -> allow | deny + reason + matchedPolicies
```

主体至少包括：

- 用户；
- Agent；
- 服务账号；
- 角色；
- 部门；
- 项目成员。

资源至少包括：

- Realm；
- Project；
- Space；
- Task/Run；
- Agent；
- Skill；
- Connector；
- Knowledge source；
- Artifact。

### 合成原则

- Realm、Project、Space 权限取交集，任一层拒绝即拒绝。
- 项目角色不能提升 Realm 权限。
- 显式拒绝优先于继承允许。
- 父 Agent 只能下授自身拥有权限的子集。
- 委派权限应带有效期、深度、预算、驻留域和资源范围。
- 权限撤销需要传播到活动任务和子 Agent。

### 产品和 API

- `GET /effective-permissions`：返回当前有效权限和来源。
- `POST /permission-explain`：解释某次允许或拒绝。
- 权限矩阵、主体详情、资源详情和授权历史。
- 授权前影响预览：将新增、扩大或撤销哪些权限。
- 临时授权、审批、break-glass 和事后复核。

## 插件生命周期中心

插件中心不应继续依赖硬编码静态目录。应以 Registry manifest、Provisioner 期望态和运行时实际状态为三个数据源，明确显示：

```text
可发现版本
  → 计划安装版本
  → 已安装版本
  → 已启用版本
  → 实际运行版本
```

需要支持：

- 搜索和分类；
- 安装计划与依赖解析；
- scope 差异和权限确认；
- 发布者信任、签名和 digest；
- 安装、启用、停用、升级、回滚和卸载；
- 配置 Schema、敏感配置与 Vault 引用；
- 兼容性和部署形态检查；
- 健康状态、启动错误、日志和重启；
- 操作审计和失败恢复。

Skill、Component、Connector、Flow、Agent 需要按制品类型展示不同的管理动作，不能全部抽象成同一种“插件卡片”。

## 共性工程问题

### 1. 前端文件过度集中

当前主要文件规模：

- `platform/dsh-plugins/lumo-ui/src/client/index.tsx`：1282 行；
- `platform/dsh-plugins/lumo-ui/src/client/lumo.css`：986 行；
- `platform/dsh-plugins/lumo-ui/src/index.ts`：567 行；
- React `useState`：85 处（复核修正，原文记为 56 处）。

建议按领域拆分：

```text
features/
  agents/
  tasks/
  permissions/
  plugins/
  account/
  organization/
  projects/
  automations/
  skills/
  connectors/
  knowledge/
  creative/
```

API 类型应从共享契约生成或复用，减少宽泛的 `Row` 和 `unknown[]`。

### 2. 错误被吞成空数据

`optionalApi()` 会把 401、403、503 和网络故障全部吞成默认空值。必须区分：

- 没有数据；
- 没有权限；
- 当前部署形态不支持；
- 服务暂不可用；
- 数据只加载了一部分；
- 请求可重试。

复核确认，`index.tsx:339-341` 全文就是一行 `catch`：

```ts
async function optionalApi<T>(path: string, fallback: T): Promise<T> {
  try { return await api<T>(path) } catch { return fallback }
}
```

调用点有 5 处（`:526` 技能、`:937` 委派、`:938` 用户目录、`:950` 用户标签、`:1069` 总览）——也就是说“集群没就绪”“无权限”“服务挂了”在界面上全部呈现为同一个空列表。

### 3. 路由与状态恢复不足

- 功能以模态覆盖层承载，浏览器返回/前进语义不完整。
- 关闭后表单和选择状态丢失。
- 缺少可分享的任务、插件、Agent、项目详情地址。
- 长任务没有实时事件流，项目大页每 30 秒全量轮询多个服务。

建议为主要资源提供稳定路由，并使用 SSE/WebSocket 推送任务和运行状态。

复核确认轮询：`index.tsx:945` `window.setInterval(() => void load(), 30_000)`，`load` 一次并发拉取委派、用户目录等多个上游；界面上 `:1021` 还把「30 秒同步」直接写给了用户看。

### 4. 可访问性和视觉层级

- Workbench 缺少焦点锁定和关闭后的焦点恢复。
- 多处使用 8–10px 字号，长时间阅读和高密度操作困难。
- “项目”页面同时放置服务、调度、流程、委派、人员画像和拓扑，信息架构过载。
- 按钮、链接和静态说明的视觉形态相近，存在误操作风险。

每个功能都应具备 loading、empty、error、forbidden、cluster-only、offline 和 partial-success 状态。

复核补充两处量化：

- **焦点管理**：`index.tsx:1220-1222` 的 `Workbench` 已有 `role="dialog"` 与 `aria-modal="true"`，`:1242` 也处理了 Escape——但全组件没有任何 focus trap，也没有记录或恢复打开前的 `activeElement`。`autoFocus` 只出现在命令面板（`:583`）和 PPT 输入框（`:1202`）。声明了模态语义却不实现模态行为，比不声明更容易误导读屏。
- **字号**：`lumo.css` 中 8–10px 的 `font-size` 规则共 **93 处**，其中 8px 用于 `.lumo-table-list small`、`.lumo-service-card small`、`.lumo-boundary-list small` 等信息密度最高的位置。

## 测试与验证结果

本次审计执行了以下验证（下列为初审的分包抽样口径，全量结果见其后的复核）：

- Lumo UI：4 个测试文件、17 个测试通过。
- User Auth、Connector、Ruflo、Archify、OpenDesign、Creative Skills：6 个测试文件、8 个测试通过。
- Lumo UI 独立 TypeScript 类型检查通过。
- Registry 全套 Go 测试通过。
- Governance Go 构建失败：`UserProfile` 构造字段错误。
- Projects Go 构建失败：`ErrConflict` 未定义。
- 全平台 TypeScript 类型检查失败：附件策略缺少 `maxPixels`。
- Connector Gateway 测试因审计沙箱禁止监听本地端口而无法完整执行，这一项不能判定为业务失败。

### 复核全量口径

上面的测试条目是分包抽样，容易被读成“总共只有 25 个测试”。全量复跑结果：

| 项 | 结果 |
|---|---|
| `vitest run`（全平台） | 56 文件通过 / 11 跳过（共 67）；410 断言通过 / 104 跳过（共 514） |
| `tsc -b --noEmit`（全平台） | 失败，唯一错误是 `minio-attachment-store.ts:92` |
| `go build ./...` × 10 模块 | 8 通过；governance、projects 失败 |
| `go test ./...` × 8 个可构建模块 | 全部通过 |

两处修正：

- **Connector Gateway 实际通过。** 复核环境下 `go build` 与 `go test ./...` 均通过，原文的沙箱限制不成立。初审已正确标注“不能判定为业务失败”，此处只是给出确定结论。
- **104 个跳过项不是覆盖漏洞。** 它们全部是需要真实 PG/MinIO 的集成测试（`METERING_TEST_DSN`、`SESSION_LOG_TEST_DSN`、`JOB_CONTROL_TEST_DSN`、`OBJECT_STORE_TEST_ENDPOINT` 等），测试名里明写“当前未设置 → 跳过，非通过”。这个自我标注是对的，应保持；但也意味着计量、会话日志、job-control 的持久化行为在 CI 中从未被真正执行过。

当前测试主要覆盖“技能能注册、页面能挂载、验证码能渲染”，尚未充分覆盖：

- 委派权限和项目边界；
- 父子 Agent 权限下授；
- 真实取消、重试和改派；
- 用户中心会话安全；
- 插件安装、升级、回滚和权限确认；
- 权限拒绝与解释；
- 集群故障和恢复；
- 端到端主要用户流程。

## CI 缺口（复核新增）

这一节是原审计遗漏的，但它解释了为什么 P0-1 那三个编译错误能一路留到今天。

### 1. CI 里没有任何 Go 步骤

`.github/workflows/ci.yml` 的 `platform` job 只有四步：`pnpm install`、`pnpm run typecheck`、`pnpm run test`、以及第一铁律校验。**10 个 Go 模块一个都没有 build 或 test。**

也就是说 governance 与 projects 编译不过这件事，CI 在结构上就不可能发现——它不是“CI 没跑到”，而是这条链路根本不存在。TypeScript 那个错误 CI 倒是能抓到，这意味着 `main` 上的 CI 现在应当是红的。

补 CI 时至少需要：对 `platform/control-plane/*` 每个模块跑 `go build ./...` 与 `go test ./...`，并把 `go vet` 一并纳入。

### 2. 第一铁律校验的断言写法是错的

同文件的合规步骤是：

```yaml
git -C deepseek-harness describe --tags --dirty
test "$(git -C deepseek-harness describe --tags --dirty)" = "dsh-v0.1.1-rc.2"
test -z "$(git -C deepseek-harness status --porcelain -uno)"
```

第二行有两个问题：

- **它必然失败。** 当前实测值是 `dsh-v0.1.1-rc.2-1079-gcd5ef81481`，落后上游 1079 个提交，与等号右边永远不等。
- **它断言错了东西。** `CLAUDE.md` 明确写着：不变量是**没有本地修改**，不是某个特定版本；该 checkout 跟随 `master` 且预期会移动，`describe` 打印什么 `<tag>-<n>-g<sha>` 都正常，**只有 `-dirty` 后缀才是违规**。把版本号钉死既会误报，也把铁律的语义讲反了。

正确写法应当只校验两件事：`status --porcelain -uno` 为空，且 `describe --tags --dirty` 不以 `-dirty` 结尾。

另外，`deepseek-harness/` 是被 `.gitignore` 忽略的独立仓库，不是 submodule（仓库根没有 `.gitmodules`）。CI 的 `actions/checkout` 不会把它拉下来，所以这一步在 CI runner 上还面临目录根本不存在的问题——需要先决定是改用 submodule、还是在 CI 里显式 clone，再谈断言内容。

### 3. `implementation-status.md` 的验证结论已过期

具体是这两处：

- `implementation-status.md:39-41` 称“十个 Go 模块均已执行 `go test ./...`；collaborator、flows、**governance**、observability、**projects**、registry、scheduler、usage-ledger 通过”——governance 与 projects 现在连编译都不过。
- `implementation-status.md:45` 称“全量 `tsc -b --noEmit` 已通过”——现在失败。

修完 P0-1 后应连同这两处一起更新，否则文档会继续为已失效的验证背书。

## 推荐实施顺序

### 第一阶段：恢复产品真实性

1. 修复 Governance、Projects 和全平台 TypeScript 编译。
2. 给 CI 补上 `platform/control-plane/*` 的 `go build` / `go test` / `go vet`，并改正第一铁律校验的断言写法（校验 `-dirty` 与 porcelain，而不是钉死版本号）。
3. 把真实取消、重试和改派接到执行控制面。
4. 清除或禁用没有实际行为的按钮、状态和宣传文案。
5. 更新 `implementation-status.md:39-41` 与 `:45`，避免文档继续声称已通过失效的验证。

第 2 步应紧跟第 1 步：先补 CI，才能保证这三个编译错误不会再次悄悄回归。

### 第二阶段：定案权限与契约

1. 定义 Realm、Project、Space 权限取交集规则。
2. 建立统一的权限动作闭集。
3. 增加有效权限和权限解释 API。
4. 分离业务任务迁移、执行 Run 更新和 Scheduler 回报权限。
5. 增加父子 Agent 的权限、预算、深度和驻留约束。

### 第三阶段：完成三个核心管理中心

1. Agent 与任务中心。
2. 组织、用户与权限中心。
3. 插件生命周期中心。

### 第四阶段：补齐业务工作流

1. 项目和自动化。
2. 技能治理。
3. 连接器和审批。
4. 资料库。
5. 开放设计和 PPT 产物管理。

### 第五阶段：统一质量

1. 拆分前端领域模块和共享契约。
2. 增加资源级路由、草稿恢复和实时事件。
3. 补齐加载、空、错、权限和离线状态。
4. 完成键盘、焦点、字号、响应式和无障碍优化。
5. 为核心用户流程增加端到端测试和故障演练。

## 新增插件统一验收门槛

以后每个新增插件或能力在标记“完成”前，至少应满足：

- 有明确的产品对象和用户任务，不只是菜单入口。
- 有真实数据源，不以硬编码目录冒充运行状态。
- 有安装、配置、启停、升级、回滚或适合该类型的完整生命周期。
- 有显式权限、权限来源和拒绝原因。
- 有 loading、empty、error、forbidden、offline 状态。
- 有审计、指标、日志和健康状态。
- 长任务有进度、取消、失败恢复和幂等机制。
- 有契约测试、权限测试、失败测试和至少一条端到端主流程。
- 该能力所在的语言栈已被 CI 覆盖（构建 + 测试），而不是只靠本地跑过一次。
- 文案、版本和状态与实际运行事实一致；展示的版本号能指回一个确定的出处。
- 文档、迁移和发布验证同步更新。

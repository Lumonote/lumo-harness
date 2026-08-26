# 用户自定义流程（第五类制品）设计说明 —— §11 后半：状态机、FlowReview、audience 定向分发

- 日期：2026-08-26
- 前置：`architecture.md` §11（第五类制品三段）、§9.2（算子目录/DAG 护栏）、§10.2（RBAC）；
  §11.1 项目工作区已落地（`2026-08-26-project-workspace-design.md`——流程「默认项目私有」依赖它）
- 状态：设计说明（实现同步进行——本切片）

## 1. 定位与边界

流程是继组件/技能/智能体/连接器之后的**第五类制品**。本切片交付**制品层**：manifest 存储、
生命周期状态机、FlowReview 审核队列、audience 定向分发的可见性过滤。**执行不在内**——
FlowEngine（DAG 编译/断点续跑/TriggerBus）是 §9.2/§13 独立 P2 件；「LLM 生成流程」与
拖拽编辑器是前端 P2 面。本切片守住的承诺是：**能定义、能审核、能定向、能版本回滚、
护栏在入库前跑**（schema + 防环；OPA scope 与限流护栏随 §6.3 P2）。

## 2. 数据模型

```sql
CREATE TABLE IF NOT EXISTS flows (
  id           TEXT PRIMARY KEY,           -- flow_<hex>
  project_id   TEXT NOT NULL,             -- §11：流程在项目内定义，默认项目私有
  realm        TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'draft',   -- 闭集见 §3
  visibility   TEXT NOT NULL DEFAULT 'private', -- private | targeted | global
  author       TEXT NOT NULL,
  version      INT  NOT NULL DEFAULT 0,    -- 当前指向的已发布版本（0=未发布过）
  audience     JSONB,                      -- {roles:[], depts:[], users:[]}（targeted 时非空）
  definition   JSONB NOT NULL,             -- 工作副本（draft/submitted 阶段可改；发布快照进 flow_versions）
  review_comment TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_at TIMESTAMPTZ, published_at TIMESTAMPTZ, deprecated_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS flows_project_name_uq ON flows (project_id, name);

CREATE TABLE IF NOT EXISTS flow_versions (          -- 发布快照：版本化 + 回滚靶点
  flow_id    TEXT NOT NULL,
  version    INT  NOT NULL,
  definition JSONB NOT NULL,
  reviewer   TEXT NOT NULL,
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (flow_id, version)
);

CREATE TABLE IF NOT EXISTS flow_reviews (           -- 审计轨迹（append-only）
  id BIGSERIAL PRIMARY KEY,
  flow_id TEXT NOT NULL,
  reviewer TEXT NOT NULL,
  decision TEXT NOT NULL,                           -- approve | reject
  comment TEXT,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**为什么 definition 两处**：工作副本（可改）与发布快照（不可变）是两件事——published 的
流程被引用时必须拿到稳定字节，作者继续改草稿不得影响在跑引用。回滚即「重指版本」：
`flows.version` 指向 `flow_versions` 的某行，发布快照永不改写。

## 3. 契约（TS，`shared/seam-contracts/flows.ts`）

- `FLOW_STATUSES = [draft, submitted, published, targeted, deprecated]`
- `FLOW_EVENTS = [submit, approve, reject, target, deprecate]`
- `VISIBILITIES = [private, targeted, global]`
- `transitionFlow(status, event)`：
  - `draft --submit--> submitted`；`draft --deprecate--> deprecated`（放弃草稿）
  - `submitted --approve--> published`；`submitted --reject--> draft`
  - `published --target--> targeted`（定向分发）；`published --deprecate--> deprecated`
  - `targeted --target--> targeted`（重定 audience，幂等）；`targeted --deprecate--> deprecated`
  - `deprecated` 终态；闭集外即抛
- `validateFlowDefinition(def)`（§9.2 入库护栏的可执行子集）：
  `{nodes: [{id, operator}], edges: [{from, to}]}`——节点非空、id 唯一、operator 非空、
  边引用存在节点、**DAG 无环**（Kahn 拓扑）。防环是本切片的硬护栏：环会让 FlowEngine
  的断点续跑永不出活，入库前拦比运行时炸便宜一个数量级。
- `audienceMatches(audience, {roles, depts, user})`：定向分发的可见性判据纯函数。

## 4. 服务（`control-plane/flows`，8087）

身份头同 projects（X-Lumo-User/Realm/Roles + 可选 X-Lumo-Dept——组织树未建，dept 经
网关头透传，§6.4 组织树 P2 后改查权威源）。**与 projects 服务的关系**：flows 不重复
实现项目成员判定——跨服务查 PG（project_members 表，只读）。

| 端点 | 语义 | 执法 |
|---|---|---|
| `POST /v1/projects/{pid}/flows` `{name, definition}` | 建草稿（definition 必过防环校验） | 项目 editor+；草稿仅作者可见 |
| `GET /v1/projects/{pid}/flows` | 项目内清单（draft 只列本人） | 项目 viewer+ |
| `GET /v1/flows/{id}` | 详情 | draft/submitted 仅作者；published+ 按可见性 |
| `PUT /v1/flows/{id}/definition` | 改草稿（重新过护栏） | 仅作者、仅 draft 态 |
| `POST /v1/flows/{id}/submit` | 提审 | 仅作者、仅 draft |
| `POST /v1/flows/{id}/review` `{approve, comment}` | 审：approve→published（同事务写 flow_versions v+1）；reject→draft | **审核人须 manager/admin 且非作者**（职责分离） |
| `POST /v1/flows/{id}/target` `{audience, visibility}` | 定向分发（published/targeted 态） | 项目 owner（分发是治理动作） |
| `POST /v1/flows/{id}/deprecate` | 弃用 | 项目 owner 或 admin |
| `POST /v1/flows/{id}/rollback` `{version}` | 重指版本 | 项目 owner；版本必须存在于 flow_versions |
| `GET /v1/flows` | **流程面板**：按身份过滤——global ∪ targeted(命中 audience) ∪ private(本人是项目成员) | caller 身份 |

**审核权限的诚实边界**：§11 要求「manager 仅审本 dept 下属、admin 审全局」，依赖组织树
（§6.4，SSO 同步，P2）。本切片落「manager/admin 角色 + 非作者」两条件，dept 归属
约束列为显式待补（组织树落地后补 `reviewer.dept ⊇ author.dept` 判定）。

## 5. 与既有的接线

- 计量：运行消耗记 `feature=flow:<id>`——发生在 FlowEngine 执行时（P2），本切片只保证
  flow id 存在且可被引用；
- Nacos 热下发：audience 规则存 PG（manifest 的一部分），「热下发」依赖 §8.3 P2 接线；
  流程面板过滤走本服务 API（实时查 PG），语义等价、路径不同；
- canary 灰度：随 Nacos/灰度（§10.3）P2。

## 6. 验收判据

1. 建草稿：防环护栏（含环 definition 400 拒绝）、项目内重名 409、非成员 404；
2. 状态机全转移：合法路径逐条可走、非法路径 409、deprecated 终态；
3. 审核：非 manager/admin 403；**作者自审 403**（职责分离）；approve 产生
   flow_versions v1 且 flows.version=1；reject 回 draft 带 comment 进审计表；
4. 定向分发：published→targeted 后 audience 落库；targeted 重复 target 幂等重定；
5. 流程面板过滤：global 全员可见；targeted 命中 audience（role/dept/user 任一）者可见、
   未命中者不可见；private 仅项目成员可见；
6. 版本回滚：二次发布 v2 后回滚 v1——version 重指、快照字节不变；
7. 契约双实现：TS 纯函数（状态机/防环/audience 匹配）与 Go 单测同矩阵。

## 7. 不做的事（显式外）

- **FlowEngine 执行**（DAG 编译、断点续跑、cron/事件触发）——P2 主件；
- **LLM 生成流程 + 拖拽编辑器**——前端 P2；OPA scope/限流护栏随 §6.3；
- **Nacos 热下发与 canary**——§8.3/§10.3 P2（本切片 PG 即时过滤语义等价）；
- **manager 审本 dept 下属的归属校验**——组织树 P2（本切片 manager/admin + 非作者）；
- **跨项目引用/提升到全局目录的提级审批流**——依赖 OPA 跨项目节点（§6.3 P2）。

## 8. 风险与取舍

- **跨服务读 project_members**：flows 直查表而非调 projects API——两个 Go 服务同库不同
  表，服务间 HTTP 调用会在 standalone 单机拓扑里引入无谓故障面。取舍：表属 projects
  DDL 真相源，flows 只读；漂移由 flows 集成测试的依赖表同构断言逮。
- **definition 大小**：JSONB 无上限——首切片 1MB 请求体上限（同 projects 惯例），
  超大 DAG 的分片加载列 FlowEngine 阶段再议。
- **弃用后的引用**：deprecated 流程在面板消失但 id 仍可读（引用方需要知道它死了，
  而不是 404）——可见性过滤放行 `GET /v1/flows/{id}` 的 deprecated 详情，只从列表剔除。

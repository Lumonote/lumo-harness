# 项目工作区设计说明 —— §11.1 首切片：项目实体、生命周期、成员角色与并行预算树（拍板 B 落地）

- 日期：2026-08-26
- 前置：`architecture.md` §11.1 / §6.4 / §10.2；评审 N3（`design-review.md`）；计量既有事实
  （`budget_trees` kind='project' 双树同事务扣减、`usage_ledger.project_id` 归因列均已在产）
- 状态：设计说明（实现同步进行——本切片）

## 1. 拍板：项目 = 并行预算树（N3 选项 B，2026-08-26 定案）

一次调用同时扣「用户树」与「项目树」，任一超限即拒。这不是新代码，是**口径升格**：
TS 侧 `commit()` 已在同 PG 事务无条件扣双树（允许负数使封顶可判，commit 84d4378 之前的
既有实现），`reserve()` 已前置双树预检。本切片补的是缺的那半边——**项目树由谁治理**：

- 项目创建即种子 `budget_trees (kind='project', id=project_id)` 行（缺省额度，运维可期初重配）；
- 项目删除**不删账**：`usage_ledger` 是 append-only（§6.4），历史成本分摊不可毁；删除只让
  组织实体消失，报表对悬空 `project_id` 解析为「已删除项目」。

超限归因提示（N3 提出的另一半）：`reserve` 拒绝信息里已带 tree 标识（`user:u1` /
`project:p1`），无需新增机制。

## 2. 数据模型（两张新表，零新执法路径）

```sql
CREATE TABLE IF NOT EXISTS projects (
  id          TEXT PRIMARY KEY,           -- proj_<uuid 前缀>，发出方可读
  realm       TEXT NOT NULL,              -- 隔离边界（§10.2：realm 是首要边界）
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'active',  -- 闭集：active | archived
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  archived_at TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS projects_realm_name_uq ON projects (realm, name);

CREATE TABLE IF NOT EXISTS project_members (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL,               -- 闭集：owner | editor | viewer
  added_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
```

预算零新表：`budget_trees` 既有 `kind='project'` 即项目树（同表同键，§6.4 总额模型
`budget_total`/`soft_limit`/`overdraft` 全部继承）。

## 3. 契约（TS，`shared/seam-contracts/projects.ts`）

闭集 + 纯函数（与 cost-events/budget-policy 同风格——语义可测、双语言消费）：

- `PROJECT_STATUSES = { active, archived }`；`PROJECT_ROLES = { owner, editor, viewer }`
- `PROJECT_ACTIONS`：`project.read` / `project.edit`（改引用与配置）/ `members.manage` /
  `project.archive` / `project.delete` / `budget.configure`
- `canProject(role, action)`：能力矩阵纯函数——owner 全权；editor = read+edit；
  viewer = read。**跨项目引用需 OPA 显式节点**（§11.1）不在此矩阵内，属 P2 的 OPA 面。
- `transitionProject(status, event)`：`active --archive--> archived`、
  `archived --unarchive--> active`、**删除只接受 `archived` 态**（归档是常态，删除是异常，
  且必须两步走——这是「显式授权」的第一层）；非法转移即抛（闭集外拒绝同 §6.4 哲学）。

语义注释留 TS（为什么闭集、为什么删除两步），数值不两处。

## 4. Go 服务（`control-plane/projects`，与 scheduler/connector-gateway 同惯例）

身份：`X-Lumo-User` / `X-Lumo-Realm` 头注入（**不自签身份**，自报 realm 即越权——同
connector-gateway 包注释）。HTTP + pgxpool，端口 8086。

| 端点 | 语义 | 执法 |
|---|---|---|
| `POST /v1/projects` `{name}` | 创建：creator=owner + 种子预算行 | realm 内可创建（角色层 P2 接 OPA） |
| `GET /v1/projects` | 列表：**本人是成员的项目**（成员视角） | 非成员不可见 |
| `GET /v1/projects/{id}` | 详情（含本人角色） | `project.read` |
| `POST /v1/projects/{id}/members` `{userId,role}` | 加成员 | `members.manage`；role 闭集校验 |
| `PATCH /v1/projects/{id}/members/{userId}` `{role}` | 改角色 | `members.manage`；**最后一个 owner 不可降级/移除** |
| `DELETE /v1/projects/{id}/members/{userId}` | 移成员 | `members.manage`；同上 |
| `POST /v1/projects/{id}/archive` `/unarchive` | 生命周期 | `project.archive` |
| `DELETE /v1/projects/{id}` | 删除：需 `archived` 态 **且** 请求头 `X-Lumo-Confirm: <project_id>` | `project.delete` + 两层显式授权（先归档、再确认头） |
| `GET /v1/projects/{id}/usage` | 项目仪表板最小后端：`usage_ledger` 按 cost_type 聚合（qty/cost_usd）+ 项目树预算四态 | `project.read` |

归档语义：archived 项目拒绝 `project.edit` 类写操作（成员管理保留——owner 解散路径必须
通畅），计量照常入账（账期门按事件时刻判，不因组织状态漂移）。

## 5. 与计量的接线（本切片不写一行新执法代码）

1. 创建项目 → `seedDefaultBudget('project', projectId, default)`（与 TS 侧
   `seedDefaultBudget` 同语义：仅无行时插入）；
2. dsh-node 装配层把 `projectId` 传给 metering 插件配置（既有 `MeterContext.projectId`）；
3. 此后 `reserve`/`commit`/`balance` 对项目树全部生效——双树同事务扣减、四态预算、
   软限额/透支/硬停，全部是已落地已测的既有行为。

## 6. 验收判据

1. 创建项目 → 成员表有 owner 行、budget_trees 有 project 行、realm 内重名拒绝；
2. 角色矩阵：editor 加成员被拒、viewer 改配置被拒、owner 全通（契约纯函数 + API 双层）；
3. 状态机：active 直接删除被拒（须先归档）；归档后编辑类操作被拒、账照记；
4. 最后一个 owner 不可被移除/降级（项目不可成为无主孤儿）；
5. 删除：无 `X-Lumo-Confirm` 头拒绝；确认后 projects/members 行消失、
   **usage_ledger 历史行原样保留**（append-only 不因删除破例）；
6. usage 聚合：按 cost_type 的 qty/cost_usd 与台账行一致；预算四态来自 budget_trees；
7. 契约双实现：TS 纯函数测试与 Go 单测同一矩阵（状态机/角色）各跑各的，语义同源。

## 7. 不做的事（首切片显式外）

- **模板创建**（§11.1「含模板」）——模板=预制引用集，等引用挂载（组件/知识库空间）落地
  再做，否则模板是空壳；
- **知识库空间/会话/自动化挂载**——§5.4.7 空间接线是独立切片（「项目内成员默认持有空间
  权限」依赖 Space 授权模型）；
- **跨项目引用 OPA 节点**——§6.3 OPA 面的 P2 项；
- **多集群视角/环境（demo/试产/生产）**——等 §7.4 全局监控与 §10.3 分发面；
- **项目预算的期初重配 API**——运维直连 `setBudget`（TS 侧已落地）或后续管理台；本切片
  只保证**树存在且可扣**。
- **第五类制品（用户流程）**——下一切片，依赖本切片的项目实体（「默认项目私有」）。

## 8. 风险与取舍

- **realm 内重名唯一约束**：`(realm, name)` 唯一是产品直觉（同名项目在列表里不可辨）；
  若将来允许同名需改为软提示，唯一索引是**可逆迁移**（§22 schema 演进规则）。
- **成员视角列表**而非 realm 全量列表：admin 全量视角等 OPA 角色面（P2），先立「成员
  可见性」这条更紧的边界——放松比收紧容易。
- **删除=真删行**：项目不是 append-only 台账，组织实体允许消失；账的归因历史用悬空
  project_id 保留。若未来需要「已删除项目名」出现在报表，需在删除前快照项目名进
  归档表——列为显式待补，不静默。

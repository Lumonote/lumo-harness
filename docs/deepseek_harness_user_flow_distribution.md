# 基于 DeepSeek Harness 的用户自定义流程与定向分发体系（Addendum 10）

> **【已整合 · 以 V2 为准】** 本文内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§11，请以 V2 为权威版本。

> 配套文档体系第 10 篇。前序：① 总体架构 ② 数据层 ③ 调度面 ④ 异步+多端 ⑤ 注册+流程化 ⑥ 连接器+RBAC+分发 ⑦ 总纲 ⑧ Nacos+自动安装+RocketMQ A2A ⑨ Token 计量·归因·配额。
> 本篇定位：**流程制品的生命周期与权限层**——用户级自定义流程，经管理员/上级审核提升为通用流程，再定向分发到指定角色/部门/人员。复用 addendum 5 的 DAG 流程引擎与算子目录、addendum 6/8 的制品分发与 Nacos、addendum 9 的 RBAC 维度与计量。

---

## 0. 一句话核心

> **流程是继组件/技能/智能体/连接器之后的「第五类制品」。用户在自己空间低代码定义私有流程；管理员或上级角色审核通过后将其提升为通用流程并写入流程目录；再通过 `audience`（role/dept/user）定向分发——普通用户在其终端只能看到被分发给自己的那部分流程。** 全程走 dsh 原生扩展点与既有分发/注册/RBAC 体系，零侵入内核。

---

## 1. 设计原则（钉死的判断）

| 原则 | 含义 | 反模式 |
|------|------|--------|
| **流程即制品** | 与组件/技能/智能体平级，带 manifest+版本+签名+依赖 | 把流程写死在某个用户脚本里，无法复用分发 |
| **创作与治理分离** | 用户自由创作私有草稿；提升/分发是独立审批动作 | 用户能直接把草稿塞给全公司 |
| **受众即策略** | 分发靠 `audience` 规则（role/dept/user），不是广播 | 通用流程一刀切全员可见 |
| **上级按管辖审批** | manager 只审本 dept 用户，admin 审全局 | 任意用户能审他人流程 |
| **审核必过护栏** | 提升时重跑 schema+防环+OPA+限流校验 | 带坏 pipeline 的流程变通用后拖垮 Doris |
| **分发靠既有通道** | audience 存 Nacos Config，终端按身份过滤 | 另造一套推送系统 |

---

## 2. 流程制品模型（Flow Manifest）

流程 = 第五类制品，manifest 与组件/技能/智能体同构（呼应 addendum 6 制品模型）：

```yaml
# flow.manifest.yaml
kind: flow
id: "flow.data-weekly-report"
name: "周经营分析报告"
version: "1.3.0"
owner: "user:zhang3"            # 作者
visibility: "targeted"          # private | targeted | global
audience:                       # 定向分发的受众（visibility=targeted 时生效）
  roles: ["analyst", "manager"]
  depts: ["sales", "marketing"]
  users: ["li4", "wang5"]
state: "published"              # draft | submitted | published | deprecated
deps:                           # 依赖的组件/技能/算子（走注册表）
  components: ["comp.data-analysis"]
  skills: ["skill.report-gen"]
  operators: ["op.doris-agg", "op.nebula-lineage"]
guardrails:
  maxTokensPerRun: 200000
  requireHITL: ["comp.data-analysis.export"]
signature: "<owner+registry 签名>"
```

> `audience` 直接复用 addendum 9 的**人/部门/角色三维**，与计量归因同源——运行某流程的 token 自然记到运行者的 user/dept/role 上（见 §8）。

---

## 3. 流程生命周期状态机

```
        ┌─────────── 用户创作（私有，仅作者可见/可运行）──────────┐
        │                                                          │
        ▼                                                          │
   [draft] ──submit──► [submitted] ──approve(管理员/上级)──► [published]
        ▲                                                              │
        │                                                          set audience
        │                                                              ▼
   [deprecated] ◄──deprecate/rollback──  [published/targeted] ──► [targeted]
                                          （写入流程目录 + 推 audience）
```

| 状态 | 可见性 | 谁可运行 | 进入条件 |
|------|--------|----------|----------|
| `draft` | 仅作者 | 仅作者 | 用户新建 |
| `submitted` | 作者 + 审核人 | 仅作者（仍私有） | 作者提交审核 |
| `published` | 流程目录（通用） | 按 audience | 审核通过 |
| `targeted` | 受众终端可见 | audience 内 | 配置 audience 并分发 |
| `deprecated` | 目录标记弃用 | 禁止新运行，旧可归档 | 管理员弃用/回滚 |

- **版本化**：每次 `publish` 产生新版本；回滚 = 把 `version` 指针指回旧版（呼应 addendum 8 分发生命周期）。
- **灰度**：`audience.roles` 可先填子集做 canary（呼应 addendum 8 灰度/联邦）。

---

## 4. 用户级自定义（创作 UX）

复用 addendum 5 的 **DAG FlowEngine + Operator Catalog**，但面向终端用户低代码：

- **可视化拖拽**：web 端用 `ConversationNodeDefinition` 画 DAG，节点 = 已注册算子（进注册表目录，可发现复用）。
- **LLM 辅助生成**：用户自然语言描述 → Agent 生成 DAG（呼应 addendum 5「LLM 即编排者」）→ **必过护栏**（schema 校验 + 防环 + OPA scope + Seam 限流，呼应全局硬规矩 8）。
- **私有运行**：草稿阶段仅在作者空间运行，消耗记 `feature=flow:<id>`（呼应 addendum 9 计量），作者自己可见成本。
- **多端一致性**：流程编辑/运行状态经 session 事件汇（addendum 4），web/CLI/IDE 一致。

---

## 5. 提升为通用流程（审核 / HITL）

这是治理动作，复用 addendum 6 的 **RBAC + OPA 单一策略点 + HITL**：

```
作者 submit ──► FlowReview 队列
                  │
                  ▼
   审核人(管理员/上级) 打开 ──► 重跑护栏(Ø schema/防环/OPA/限流)
                  │
        ┌─────────┴──────────┐
      approve                reject
        │                      │
        ▼                      ▼
   写 flow catalog      退回作者(draft) + 批注
   + 进 Operator Catalog
```

- **权限（OPA 策略点）**：
  - `flow.create` / `flow.run.private`：任何已认证用户（realm 内）。
  - `flow.submit`：作者。
  - `flow.review` / `flow.approve`：**管理员或上级角色**，且 manager 仅能审**本 dept 下属**（需 addendum 9 组织树支撑「上级看下级」）。
  - `flow.deprecate` / `flow.rollback`：管理员。
- **审核内容**：护栏重跑 + 依赖完整性（组件/技能/算子是否齐全且签名可信）+ scope 是否越权（OPA）+ 质量/命名规范。

---

## 6. 定向分发（audience → 终端）

通用流程不广播，按 `audience` 定向——复用 addendum 8 的 **Nacos + Provisioner** 与 addendum 6 分发体系：

```
published 通用流程
   │ set audience {roles, depts, users}
   ▼
Nacos Config:  flow.{id}.audience = {...}   ← 热下发（addListener）
   │
   ▼
终端「流程面板」订阅 audience 规则 + 自身身份(user/dept/role)
   │
   ▼
按身份过滤 → 仅展示分发给"我"的流程列表（多端事件汇，addendum 4）
   │
   ▼
audience 内用户可运行 → 运行消耗记 feature=flow:<id>（addendum 9 计量）
```

- **三种受众粒度**：
  - `roles`：某角色（如 analyst）全员可见。
  - `depts`：某部门（如 sales）全员可见。
  - `users`：指定个人（白名单）。
  - 三者取并集；空 audience 且 `visibility=global` 则全员可见。
- **灰度**：先填 `roles: [analyst-canary]` 小范围验证，再扩到全量。
- **离线/弱网兜底**：audience 规则可经 Provisioner 把流程 bundle 推到目标 realm/节点缓存（呼应 addendum 8 自动安装 reconcile），断网也能跑。

---

## 7. 权限模型总表（OPA）

| 动作 | 允许角色 | 范围约束 |
|------|----------|----------|
| `flow.create` | 任意已认证用户 | realm 内 |
| `flow.run.private` | 作者 | 仅自己 draft |
| `flow.submit` | 作者 | 自己的 draft |
| `flow.review` | admin / manager | manager 限本 dept |
| `flow.approve` | admin / manager | 同上；通过即 published |
| `flow.distribute` | admin / manager | 设置 audience |
| `flow.run.shared` | audience 内用户 | 仅 targeted 流程 |
| `flow.deprecate` / `flow.rollback` | admin | 全局 |

> 与 addendum 9 联动：`flow.run.*` 同时受**限流/额度**约束（按 user/dept/role/feature 维度），管理员可看通用流程的成本分布。

---

## 8. 存储

| 存储 | 内容 |
|------|------|
| **PG** | `flow_manifest`（版本/签名/owner/visibility/audience/state）、`flow_review`（审核记录）、`flow_run`（运行实例） |
| **Nacos Config** | `flow.{id}.audience`、`flow.{id}.config`（流程运行参数/灰度规则），热下发 |
| **注册表（Nacos Naming）** | 流程目录（flow catalog 服务），全局可发现复用 |
| **Doris** | 流程运行报表：谁（user/dept/role）跑了哪个流程、花多少 token（呼应 addendum 9 `feature=flow:<id>` 聚合） |

---

## 9. 与既有体系的咬合

| 体系 | 本篇如何衔接 |
|------|--------------|
| **大数据流程化（5）** | 复用 DAG FlowEngine + Operator Catalog；用户流程 = 同一引擎的低代码入口 |
| **分发体系（6）** | 流程 = 第五类制品，走发布/发现/部署/联邦/灰度；OPA 评估各阶段 |
| **Nacos+自动安装（8）** | audience 规则存 Config 热下发；Provisioner 可把流程 bundle 推到目标节点 |
| **RBAC（6）+ 组织树（9）** | 创作/审核/分发/运行权限 = OPA 策略点；manager 按 dept 管辖 |
| **计量（9）** | 流程运行消耗记 `feature=flow:<id>`，按 user/dept/role 溯源；管理员看成本分布 |
| **异步+多端（4）** | 流程编/运行状态经 session 事件汇一致；可后台跑、suspend/resume |
| **注册表（5/8）** | 流程进 flow catalog，与组件/技能/算子同目录可发现 |

---

## 10. 代码骨架（Cordis / TS 风格，零侵入内核）

```ts
// ---- 流程 manifest（第五类制品）----
interface FlowManifest {
  kind: 'flow'; id: string; name: string; version: string;
  owner: string;                       // user:xxx
  visibility: 'private' | 'targeted' | 'global';
  audience?: { roles: string[]; depts: string[]; users: string[] };
  state: 'draft' | 'submitted' | 'published' | 'deprecated';
  deps: { components: string[]; skills: string[]; operators: string[] };
  guardrails: { maxTokensPerRun: number; requireHITL: string[] };
  signature: string;
}

// ---- 提升为通用流程：审核（OPA + 护栏重跑）----
async function promoteToGeneral(flow: FlowManifest, reviewer: Identity) {
  await opa.assert('flow.approve', reviewer, { ownerDept: orgTree.deptOf(flow.owner) });
  await guardrails.recheck(flow);      // schema + 防环 + OPA scope + 限流
  flow.state = 'published';
  registry.publish('flow', flow);      // 进 flow catalog（Nacos Naming）
  metering.featureIndex.set(flow.id);  // feature=flow:<id> 可计量
}

// ---- 定向分发：audience 经 Nacos 热下发 ----
async function distribute(flow: FlowManifest, audience: Audience, by: Identity) {
  await opa.assert('flow.distribute', by, {});
  flow.visibility = 'targeted'; flow.audience = audience; flow.state = 'targeted';
  await nacos.publishConfig(`flow.${flow.id}.audience`, JSON.stringify(audience));
  provisioner.reconcile(flow);         // 可选：把 bundle 推到目标 realm/节点
}

// ---- 终端流程面板：按身份过滤可见流程（多端事件汇）----
async function visibleFlows(me: Identity): Promise<FlowManifest[]> {
  const all = await registry.list('flow');          // flow catalog
  return all.filter(f => f.state !== 'deprecated' && (
    f.visibility === 'global' ||
    (f.audience && (
      f.audience.users.includes(me.userId) ||
      f.audience.depts.includes(me.deptId) ||
      f.audience.roles.some(r => me.roles.includes(r))
    ))
  ));
}

// ---- 运行：计量走 feature=flow:<id>（呼应 addendum 9）----
async function runFlow(flow: FlowManifest, me: Identity, ctx: TraceCtx) {
  await opa.assert('flow.run.shared', me, { audience: flow.audience });
  metering.emit({ ...ctx, feature: `flow:${flow.id}` });  // token 归因到运行者
  return flowEngine.execute(flow, ctx);
}
```

> 全部只依赖 dsh 稳定语义（registry / ctx / session 事件 / OPA 策略点 / Nacos Config），不碰 Cordis 内核。

---

## 11. 硬规矩（Opinionated，收口到本篇）

1. **流程是第五类制品**，与组件/技能/智能体平级带 manifest，不写死在用户脚本。
2. **创作自由、治理独立**：用户可建私有草稿，但提升/分发必须是独立审批动作。
3. **audience 定向而非广播**：通用流程靠 role/dept/user 受众规则分发，不一刀切全员。
4. **上级按管辖审批**：manager 只审本 dept，admin 审全局，靠组织树支撑。
5. **提升必过重护栏**：坏 pipeline 变通用前先 schema+防环+OPA+限流校验。
6. **audience 走 Nacos 热下发**，终端按身份过滤，不另造推送系统。
7. **运行消耗记 `feature=flow:<id>`**，与计量/溯源体系同源，管理员可见成本分布。
8. **灰度先行**：新通用流程先小范围 canary 再扩量。

---

## 12. 体系位置（十篇闭环）

| 文档 | scope |
|------|-------|
| 1 总体架构 | 分层 + Seam 网络化 + 组件化/分发 |
| 2 数据层 | PG/Doris/Nebula/Redis/分布式DB |
| 3 调度面 | 高并发协同调度 |
| 4 异步+多端 | suspend/resume、future、终端事件汇 |
| 5 注册+流程化 | 注册表 + DAG 流程引擎 + 算子目录 |
| 6 连接器+RBAC+分发 | 外部连通 + 角色权限 + 分发体系 |
| 7 技术架构总纲 | 统一分层 / 模块分解 / 蓝图 |
| 8 Nacos+自动安装+RocketMQ A2A | 注册配置中心 + 自动装配 + 多 agent 可靠协同 |
| 9 Token 计量·归因·配额 | 功能级计数 + 人/部门/角色归因 + 平台溯源 + 限流/限额度 |
| **10 用户流程+定向分发（新）** | **用户自定义流程 → 审核提升通用 → audience 定向分发到角色/部门/人** |

至此平台形成完整的「**创作民主化 + 治理集中化**」闭环：终端用户低代码定义私有流程，管理员/上级审核提升为通用流程并写入目录，再按角色/部门/人员定向分发——创作、治理、分发、运行、计量全部走既有组件化/注册/Nacos/RBAC/计量体系，零侵入 dsh 内核。

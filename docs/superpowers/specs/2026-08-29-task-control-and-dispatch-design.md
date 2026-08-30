# 任务管控与统一派单设计说明 —— 业务控制面（§23）：统一 Worker、五维派单、证据链汇报

- 日期：2026-08-29
- 前置：`architecture.md` §4.2（复制式 SessionEvent 日志）/ §6.4（计量与预算树）/ §7（调度面）/
  §10.2（用户角色权限）/ §11.1（项目工作区）/ §22.3（schema 演进规范）；
  已在产事实：`control-plane/governance`（用户·部门·角色·技能授权·委派雏形）、
  `control-plane/scheduler`（放置/租约/EDF/加权公平/驻留硬过滤）、
  `control-plane/flows`（FlowEngine + TriggerBus + 持久 outbox + 运行幂等）、
  `control-plane/usage-ledger`（`cost_type` 闭集台账 + Doris 日 cube）、
  `dsh-plugins/session-log`（append-only 复制日志 + `queryWithStaleness`）
- 外部输入：知识库《2026 多智能体任务管控与协作分发平台——架构设计与产品设计》（下称**研究稿**）
- 状态：P5a–P5e 已落地：评分归一化、统一 Worker、任务/Run、报告、集群派单与本机多智能体入口已接入；报告的 `sessionLogQuery` 新鲜度闸门由宿主读面负责。本轮按要求未运行测试、构建或打包。

---

## 0. 定位：这一层补的是什么

Lumo 已建成 L0–L4 的运行时与基础设施：能力可远程化、日志可复制、跨节点可委派、调用可计量、
制品可分发。但控制台面板全部是**能力导向**的（运营管理 / 知识库 / 专家技能 / 连接器 /
调度与运营 / 技能与治理），没有一个面板回答业务问题：

> 「这件事派给谁？做到哪一步了？做完了拿什么证明？」

研究稿通篇假设存在一个「能可靠执行、有轨迹、能跨节点、能计量」的底座，而对底座本身只给到
选型建议——**那正是 Lumo 已经付过账的部分**。两者是互补的上下半身，不是重叠。本篇把研究稿的
业务与产品结论，收敛成 Lumo 编号体系下的 **§23 业务控制面**。

三条设计立场，先于一切细节：

1. **不重建执行面。** 派单的出口是既有 `scheduler` 放置与 `subagent-remote` 委派；汇报的进料
   是既有 `session-log`；成本是既有 `usage_ledger`。本层只新增「业务语义」，不新增执行机制。
2. **第一铁律不动摇。** 全部新增落在 `control-plane/*` 独立 Go 服务与 `shared/seam-contracts`；
   读会话事实一律经 `ctx.sessionLogQuery` seam。不改 `deepseek-harness/` 一行。
3. **诚实优于完整。** 没有的数据不发明（见 §23.2.4 人力成本维的显式降级、§23.4 无证据结论的
   强制标注）。研究稿自身也采用这个口径，本篇继承。

---

## 1. 选型映射（本节优先级最高，先读再读别的）

研究稿的选型表（其 §11.1）与 Lumo 已定案栈**方向相反**。直接引用整章会重演当年 15 篇 addendum
因口径冲突被删的事故。融入时研究稿只作**能力清单**引用，选型一律以 `architecture.md` §13 为准：

| 领域 | 研究稿原选型（**不采纳**） | Lumo 已定案 | 依据 |
|---|---|---|---|
| 事件总线 | Kafka / NATS | **RocketMQ** | §8.3；NATS 属已推翻术语 |
| 模型网关 | LiteLLM | **全栈 Go 自研 `llm-gateway`** | §12；计量单截面已落在此 |
| 注册配置 | （未收敛） | **Nacos** | §6.1；etcd 属已推翻术语 |
| 网关 | （隐含外部网关） | **全 Go 自研，零外部网关中间件** | §12；APISIX/Envoy 属已推翻术语 |
| 向量 | pgvector 起步 → Milvus | **直接 Milvus** | §5.4 |
| 集群调度 | Volcano + Kueue/MultiKueue | **自研 `scheduler`** | §7；研究稿自标 MultiKueue 未 GA |
| Agent 运行时 | dsh + `AgentRuntime` 抽象层 | **dsh 零侵入，不做抽象层** | 见 §5 风险 R1 |

> **执行纪律**：本篇及后续实现中，`Kafka` / `NATS` / `etcd` / `LiteLLM` / `APISIX` / `Envoy` /
> `Volcano` / `Kueue` 只允许出现在「未采纳备选」语境。任何把它们写成现行口径的文本都是缺陷。

**编号归位**：研究稿用 L0=接入层→L5=基础设施，Lumo 用 L0 资源→L6 业务应用 + 三平面。
两套编号不混用。研究稿章节到本篇的映射：其 §3.3→§23.1，§4.2/§7→§23.2，§4.2 任务模型→§23.3，
§4.2 汇报/§9.3⑤→§23.4，§6.2→§23.5，§9→§23.6。其 §8（跨集群深化）与 §4.1 评测中心
**显式不在本篇**（见 §7）。

---

## 2. §23.1 统一 Worker 模型

### 2.1 拍板：Worker 是投影，不是新实体

研究稿的核心命题是「人与 Agent 是同一抽象的两类实例」。Lumo 今天有两套互不相干的 worker 概念：
`governance.UserProfile`（人，技能来自授权优先级链）与 `scheduler.Node` / `DesktopNode`
（机器，capabilities 是不透明字符串）。

**不新建 `workers` 表**（沿用 §11.1「复用现有，不新建第四层治理」的既有立场）。Worker 是派单
候选的**读模型**，`worker_id` 为带类型前缀的稳定标识：

```
worker_id ::= "user:" <governance_users.id>       # Human Worker
            | "agent:" <agent preset artifact ref> # AI Worker（第三类制品）
```

两类实例各自的画像来源：

| 维度 | Human | AI Agent |
|---|---|---|
| 技能集 `S` | `ResolveEffectiveSkills`（既有优先级链） | 同一函数，主体换成 `agent`（见 §2.3） |
| 熟练度/置信度 `C` | `governance_skill_proficiency`（新表，§4.1） | 同表 |
| 质量分 `Q` | 派单结果回流（§2.5） | 派单结果回流；评测门禁接入后升级（§7） |
| 负载 `L` | 在办任务计数（**既有**：`store.go` 按 `ASSIGNED/QUEUED/RUNNING` 计数） | `governance_worker_runtime.max_concurrency` 对比在办 |
| 成本/信任 `R` | **不可比，按显式降级处理**（§4.4） | `usage_ledger` 近 N 次 run 的 `cost_usd` 中位数 + 驻留信任等级 |

### 2.2 授权与熟练度必须分表（硬约束）

Lumo 的 `Skill` + `SkillGrant` + `ResolveEffectiveSkills` 是**授权模型**：优先级
用户(50) > 项目(40) > 角色(30) > 部门(20) > 继承部门(10)，同优先级版本冲突 **fail-closed 抛错**
（`domain.go:390`，「不能让授权成为升级的副作用」）。

研究稿要的 0–5 熟练度 + 置信度 `C` + 质量分 `Q` **必须落在独立表**。把绩效并进 grant 会让授权
随表现漂移，直接破坏上述 fail-closed 规则。

> **一句话边界：grant 回答「可以用」，proficiency 回答「用得好」。两者永不合表、永不互相推导。**
> 派单硬约束读 grant（无授权即出局），打分读 proficiency（有授权才谈熟不熟）。

### 2.3 必须闭掉的既有缺陷：Agent 授权是死路径

`subject_type` 闭集在 DDL CHECK（`store.go:140`、`:154`）与 `SubjectType.Valid()`
（`domain.go:333`）中**均已包含 `'agent'`**，但解析路径是用户中心的：

- `matchesGrant`（`store.go:626`）没有 agent 分支，落 `default:` 返回 `false`；
- `matchesRevocation`（`store.go:1007`）对 `SubjectAgent` **显式 `return false`**；
- `domain.Priority*` 常量里没有 `PriorityAgent`。

后果：**今天给 Agent 授一个技能会被静默接受、写入成功、且永不生效**；撤销同样永不命中
（方向是 fail-open）。这不是本设计新增的风险，是既有的静默失效路径，统一 Worker 必须一并闭掉：

1. 新增 `domain.PriorityAgent = 45`（介于项目 40 与用户 50 之间：Agent 是被点授的具体主体，
   强于项目普授，弱于对人的直授——人对自己账号的授权不应被 Agent 侧配置盖掉）；
2. `matchesGrant` / `matchesRevocation` 补 `SubjectAgent` 分支，按 `subjectID == agentRef` 匹配；
3. 解析入口从 `ResolveEffectiveSkills(userID)` 泛化为按 `worker_id` 解析；
4. **锁测试先红**：断言「给 agent 授技能 → 该 agent 的有效技能包含它」与「撤销后消失」，
   保证这条路径以后不会再无声退化。

---

## 3. §23.2 五维派单打分

### 3.1 现状与三处缺陷

`RankDelegationCandidates`（`domain.go:145`）已实现三层路由的骨架：硬约束过滤（`Eligible`）+
打分排序 + `Rationale` 可解释 + `SchedulerTaskID` 桥接调度器。对照研究稿 §7.2 有三处缺陷：

| 现状 | 缺陷 | 后果 |
|---|---|---|
| `Score = 标签×35 + 技能×50 − 在办×3`（`domain.go:218`） | **无界整数** | 无法分档。90/70 置信度分档的前提是分数归一化——不归一化就没有「自动/建议/人工」三档 |
| 仅技能 `S` 与负载 `L` 两维 | 缺 `C`/`Q`/`R` | 无质量分则无反馈闭环；无成本维则 Agent 候选无法排序 |
| `termInText` 是 `strings.Contains` 字面子串（`domain.go:246`） | 无语义 | 「SQL 调优」匹配不到「数据库优化」 |

### 3.2 归一化打分模型

各分量取值域强制 `[0,1]`，权重和为 1，最终 `φ = round(100 × Σ)`，落 `INTEGER`（不引入浮点列，
避免跨语言测试的尾数漂移）：

```
φ = 100 × ( w1·M + w2·M·C + w3·(1−L) + w4·Q + w5·(1−cost_norm) )

w1 = 0.35  M        技能匹配度：任务所需技能 ∩ Worker 有效技能，按熟练度加权
w2 = 0.10  M·C      匹配度 × 证据置信度（防「高熟练度、零证据」的虚假匹配）
w3 = 0.20  1−L      剩余产能（Least-Busy 的连续版）
w4 = 0.25  Q        历史质量分
w5 = 0.10  1−cost   成本归一化（同档候选的打破项）
```

权重取自研究稿 §7.2，其技能第一权重的方向对齐 Jira Skill widget 的线性回归基线。

**硬约束先过滤再评分**（研究稿 §7.2）。过滤项全部复用既有事实，不新增执法路径：

- 授权：所需技能 ⊄ Worker 有效技能 → 出局（读 grant，见 §2.2）；
- 状态：`status != 'active'` → 出局（既有）；
- 负载：`L > 0.8` → 出局；
- 数据驻留与信任等级：复用 `scheduler` 既有 `Residency` 硬过滤语义，Worker 侧同义。

### 3.3 置信度分档与权重快照

闭集 `confidence_band`：

| 档 | 区间 | 行为 |
|---|---|---|
| `AUTO` | φ ≥ 90 | 自动派发 |
| `SUGGESTED` | 70 ≤ φ < 90 | 建议，人一键确认 |
| `MANUAL` | φ < 70 | 人工派单，附任务拆分建议 |

> **权重快照是必须项，不是可选项。** 研究稿 §7.4 要求每周离线重校准 `w1~w5`。权重一变，历史
> 派单就不可复现，`Rationale` 会变成一句无法验证的话。因此每条派单记录必须同事务快照当时的
> 权重与各分量值（`score_weights` / `score_breakdown`）。这与 §11 flow 发布「approve 同事务写
> 快照」是同一条纪律。

**冷启动数学性质（设计意图，非缺陷）**：新 Worker 的 `C=0`、`Q` 取先验中位数 0.5，即使技能全中
且完全空闲，φ 上限为 `100×(0.35+0+0.20+0.125+0.10) = 78` → 落 `SUGGESTED`。**新 Worker 在数学上
不可能进入自动派档**，必须由人确认前若干次——这正是研究稿 §7.3「先跑后证」的新员工策略，
不需要额外写一条规则去实现它。

### 3.4 人力成本维的显式降级

Lumo 没有职级成本数据，也不应当有（HR 数据不进本平台）。**不发明人力单价**。

Human 候选按「`R` 维不可比」处理：从分母剔除该权重并对剩余权重重新归一化——

```
φ_human = 100 × ( w1·M + w2·M·C + w3·(1−L) + w4·Q ) / (1 − w5)
```

于是人机同尺（上限同为 100），且没有一个数字是编出来的。若将来客户接入绩效/人力 SaaS，
在源头取数后再启用 `w5`，公式无需改动——只是分母恢复为 1。

### 3.5 语义回退（接线活，非新建）

研究稿 §7.3 的冷启动路径要 embedding 近邻回退。Lumo 已有 `ctx.knowledge.vector`（Milvus），
本项是接线：字面匹配无结果时，用任务意图向量召回近邻技能标签，**结果标注来源为 `semantic`
并对 `M` 施加折减系数**（语义命中弱于显式声明命中，不能等价计分）。召回必须带 realm 过滤
（§5.4 Provider 层 realm 强制过滤的既有义务）。

### 3.6 反馈闭环

研究稿 §7.4：结果必须回流。新增 `governance_dispatch_outcomes`（§4.1），记录闭集
`outcome ∈ {ACCEPTED, REASSIGNED, REWORKED, REJECTED, FIRST_PASS}` 与改派原因闭集
`{SKILL_MISMATCH, OVERLOADED, ERROR, OTHER}`。

- `Q` 在线修正；`C` 随证据量增长；
- 改派率 > 15% 的 worker×技能组合标注「画像失真」，触发人工复核；
- **样本量 < 50 不参与权重调权**（研究稿 §7.4 门槛），未达门槛时权重保持默认值且如实标注。

---

## 4. §23.3 业务任务态机：任务与 Run 必须拆分

### 4.1 既有模型的表达力缺陷

`governance_delegation_tasks` 一张表同时承载了任务身份与**单次**执行态：`state` 闭集
（`ASSIGNED/QUEUED/RUNNING/COMPLETED/FAILED/CANCELLED/BLOCKED`）、单个 `scheduler_task_id`、
单个 `assigned_node_id`、单个 `last_error`。

这是单次尝试假设。它无法表达重试与重派——而研究稿 §8.4 的容灾语义明确要求
「**重派 = 新 Run 对象，旧 Run 标记 `failed_by_cluster`**，故障恢复是任务级不是进程级」。
今天一次重派会覆盖掉上一次的节点与错误，历史就此丢失。

### 4.2 两个正交状态机

| 机 | 归属 | 闭集 |
|---|---|---|
| **业务态** | 任务（一条业务事实） | `DRAFT → ROUTING → ASSIGNED → EXECUTING → VERIFYING → IN_REVIEW → DONE \| REJECTED \| ARCHIVED` |
| **执行态** | Run（一次尝试） | 沿用既有 7 值闭集，**一字不改** |

关键收益是研究稿 §4.2 要的评审闸门（`VERIFYING` / `IN_REVIEW` / `REJECTED`）终于有地方落：
`IN_REVIEW` 打回时业务态回 `ROUTING` 并**创建带反馈的新 Run**，旧 Run 完整留痕。

### 4.3 迁移：显式物化，不静默

遵 §22.3 规则 1 与规则 3（加列 nullable + `ADD COLUMN IF NOT EXISTS`；新列上线后旧代码仍能
正确解释，新代码显式识别旧模式行）：

- 旧行 `business_state IS NULL` = **本切片前创建的派单**，语义为「无业务态」，**不回填假数据**
  （§22.3 规则 2）；
- 新代码读到「无 run 行但 `scheduler_task_id != ''`」的旧行时，**显式物化为 attempt=1 并写审计**，
  而不是静默迁移——与预算 `adjustBudget` 对旧行抛「先重配」是同一范例。

---

## 5. §23.4 证据链汇报

研究稿把「结论→证据一级跳转」定为 P0 唯一不可妥协的品质线。**Lumo 的底座已经就位**：
`session-log` 的 append-only 复制日志、`(session,seq)` 幂等、冷热分层、子代理只回压缩摘要而
完整轨迹留子 Run（研究稿 §6.4 的「黄金准则」在 Lumo 是已实现行为）。缺的只是折叠器。

**六段式报告**（研究稿 §4.2）：做了什么 / 产出（Proof of Work）/ 验证结果 / 耗时 / 成本 /
风险与遗留。每段挂 `evidence[]`，元素为 `(session_ref, seq)`。

三条硬规矩：

1. **stale 即拒绝生成，不生成半截报告。** 读面经 `ctx.sessionLogQuery.queryWithStaleness`，
   契约本身就承诺「显式 stale 不返半截」。报告生成对滞后 **fail-closed**：宁可没有报告，
   不可有一份漏了尾部事件却看起来完整的报告。
2. **无证据的结论强制标注「未验证」，且不进周报。** 研究稿 §9.5②。「推进了相关工作」这类
   无事实结构的条目自动折叠并提示补录。
3. **未确认的报告不进入周报**（研究稿 §9.4）。`report.status` 闭集 `draft | confirmed | archived`。

**成本段零新代码**：按 run 聚合既有 `usage_ledger`，`cost_type` 走既有 6 值闭集
（`llm.tokens` / `connector.call` / `seam.query` / `job.compute` / `storage.bytes` /
`inference.gpu`）。该闭集在 §22.5 不可逆清单内——**只加不删，本设计不扩集**。

---

## 6. §23.5 板驱动循环：复用，不新建

研究稿 §2.3 的 Symphony 模式（看板=控制平面、持续监控、有界并发、stall 重启、指数退避）
在 Lumo 已有完整执行器，**不新增调度机制**：

| 研究稿要件 | Lumo 既有落点 |
|---|---|
| 持续监控看板 | `flows` 的 TriggerBus + 持久 outbox worker（claim/requeue/ack） |
| 有界并发派发 | `scheduler` 并发闸 + 项目并行预算树（§6.4/§11.1） |
| 重试幂等 | `flows` 既有运行幂等记录 |
| 指数退避 `min(10000×2^(attempt-1), max_backoff)` | outbox worker 退避参数化即可 |
| 崩溃不丢消息 | 复制日志 + `mailbox` 投影（研究稿 §6.2 与 Lumo §4.2 是同一不变量） |

研究稿 §6.2 的四投影（任务状态机 / Agent Inbox / 派单候选池 / 汇报材料）中，Inbox 投影
**Lumo 已有**；其余三项是本篇新增的折叠，机制复用。

> **结论：研究稿第六章对 Lumo 不产生新机制需求，只产生新投影需求。** 这是它性价比最高的一章。

---

## 7. 数据模型

全部遵 §22.3：加列 nullable + `ADD COLUMN IF NOT EXISTS`、一次一条语句、`init()` 幂等、
索引 `IF NOT EXISTS`、待处理尾用部分索引。

```sql
-- ① 既有表加列（NULL = 本切片前的旧模式，不回填）
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS business_state     TEXT;
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS confidence_band    TEXT;
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS assignee_worker_id TEXT;
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS score_breakdown    JSONB;
ALTER TABLE governance_delegation_tasks ADD COLUMN IF NOT EXISTS score_weights      JSONB;

-- ② Run = 一次执行尝试（研究稿 §8.1 的调度单元）
CREATE TABLE IF NOT EXISTS governance_task_runs (
  id                TEXT PRIMARY KEY,          -- run_<uuid 前缀>
  realm             TEXT NOT NULL,
  task_id           TEXT NOT NULL REFERENCES governance_delegation_tasks(id) ON DELETE CASCADE,
  attempt           INTEGER NOT NULL,          -- 单调递增，(task_id, attempt) 唯一
  worker_id         TEXT NOT NULL,             -- user:<id> | agent:<ref>
  session_ref       TEXT NOT NULL DEFAULT '',  -- 证据锚点：复制日志的会话标识
  scheduler_task_id TEXT NOT NULL DEFAULT '',
  assigned_node_id  TEXT NOT NULL DEFAULT '',
  state             TEXT NOT NULL              -- 执行态闭集，与既有一字不差
    CHECK (state IN ('ASSIGNED','QUEUED','RUNNING','COMPLETED','FAILED','CANCELLED','BLOCKED')),
  failure_kind      TEXT,                      -- NULL=未失败；failed_by_cluster 等（研究稿 §8.4）
  last_error        TEXT NOT NULL DEFAULT '',
  started_at        TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS governance_task_runs_attempt_uq
  ON governance_task_runs (task_id, attempt);

-- ③ 熟练度：与授权分表（§2.2 硬约束）
CREATE TABLE IF NOT EXISTS governance_skill_proficiency (
  realm       TEXT NOT NULL,
  worker_id   TEXT NOT NULL,
  skill_id    TEXT NOT NULL,
  level       SMALLINT NOT NULL CHECK (level BETWEEN 0 AND 5),
  confidence  NUMERIC(4,3) NOT NULL DEFAULT 0 CHECK (confidence BETWEEN 0 AND 1),
  source      TEXT NOT NULL                    -- 闭集，权重递减：产出证据 > 评测 > 自评
    CHECK (source IN ('outcome','eval','self')),
  evidence_n  INTEGER NOT NULL DEFAULT 0,      -- 近 90 天证据量，驱动 confidence
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (realm, worker_id, skill_id, source)
);

-- ④ Worker 运行属性（仅 Agent 有；Human 的并发由在办计数推导，不建行）
CREATE TABLE IF NOT EXISTS governance_worker_runtime (
  realm           TEXT NOT NULL,
  worker_id       TEXT NOT NULL,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  trust_level     TEXT NOT NULL DEFAULT 'standard',
  residency       TEXT NOT NULL DEFAULT '',    -- 空 = 未约束，与 scheduler 同义
  status          TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (realm, worker_id)
);

-- ⑤ 反馈闭环（§3.6）
CREATE TABLE IF NOT EXISTS governance_dispatch_outcomes (
  id          TEXT PRIMARY KEY,
  realm       TEXT NOT NULL,
  task_id     TEXT NOT NULL,
  worker_id   TEXT NOT NULL,
  outcome     TEXT NOT NULL
    CHECK (outcome IN ('ACCEPTED','REASSIGNED','REWORKED','REJECTED','FIRST_PASS')),
  reason      TEXT                             -- NULL 合法：仅改派类需要原因
    CHECK (reason IS NULL OR reason IN ('SKILL_MISMATCH','OVERLOADED','ERROR','OTHER')),
  recorded_by TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS governance_dispatch_outcomes_worker_idx
  ON governance_dispatch_outcomes (realm, worker_id, created_at DESC);

-- ⑥ 证据链报告（§5）
CREATE TABLE IF NOT EXISTS task_reports (
  id           TEXT PRIMARY KEY,
  realm        TEXT NOT NULL,
  task_id      TEXT NOT NULL,
  run_id       TEXT,                           -- NULL = 任务级汇总报告（多 Run 归并）
  sections     JSONB NOT NULL,                 -- 六段式；每段 {conclusion, evidence[], verified}
  status       TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','confirmed','archived')),
  confirmed_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- 待确认尾用部分索引（§22.3 规则 5）：已确认的历史行不拖慢轮询
CREATE INDEX IF NOT EXISTS task_reports_pending_idx
  ON task_reports (realm, created_at DESC) WHERE status = 'draft';
```

`evidence[]` 元素形状固定为 `{session_ref, seq}`——**证据是日志坐标，不是文本副本**。
复制文本会让报告在日志裁剪后变成孤证，坐标则永远可回溯（§4.2 的既有承诺）。

---

## 8. 契约（TS，`shared/seam-contracts/`）

沿用既有闭集 + 纯函数风格（与 `cost-events` / `budget-policy` / `projects` 同构，语义可测、
双语言消费；数值单一真相源，语义注释留 TS）：

**`dispatch.ts`（新）**
- `DISPATCH_WEIGHTS`：默认权重（w1..w5），**导出为可覆盖常量而非硬编码**；
- `CONFIDENCE_BANDS = { AUTO: 90, SUGGESTED: 70 }` 与 `bandOf(score)` 纯函数；
- `scoreCandidate(input, weights)`：五维打分纯函数，返回 `{score, breakdown}`；
  **Human 走 §3.4 的重归一化分支**，同一函数两条路径，避免两处实现漂移；
- `DISPATCH_OUTCOMES` / `REASSIGN_REASONS` 闭集。

**`tasks.ts`（新）**
- `BUSINESS_STATES` 闭集 + `transitionTask(state, event)`：非法转移即抛（同 `projects.ts` 哲学）；
- `RUN_STATES`：**从既有 Go 闭集镜像而来，不新造取值**。

**`reports.ts`（新）**
- `REPORT_SECTIONS` 六段闭集；`REPORT_STATUSES`；
- `assertEvidence(section)`：无 `evidence[]` 的段强制 `verified=false`（§5 规矩 2 的机器判据）。

Go 侧消费同一份闭集：`cost-types.manifest.json` 已确立「闭集数值单一文件、两语言各自 embed、
锁测试先红」的先例，本篇闭集照此办理。

---

## 9. Go 服务与端点

**不新建服务。** 派单与任务落在既有 `control-plane/governance`（用户/技能/委派已在此），
报告落在既有 `control-plane/projects`（项目是计量与仪表板的承载体，§11.1）。理由是研究稿
§3.1「控制面薄」——为一层业务语义再起一个进程是反向操作。

身份沿用既有约定：`X-Lumo-User` / `X-Lumo-Realm` 头注入，**服务不自签身份**。

| 端点 | 语义 | 执法 |
|---|---|---|
| `POST /v1/delegations/preview` | **既有**，扩为返回五维 `breakdown` + `band` | 既有 |
| `POST /v1/delegations` | **既有**，扩为写 `score_weights` 快照 + 建 attempt=1 的 run | 既有 |
| `GET /v1/workers` | 统一候选列表（人 + Agent），含五维画像 | realm 内 |
| `GET /v1/workers/{workerId}/profile` | 单个画像：有效技能 + 熟练度 + Q/C/L | realm 内 |
| `POST /v1/tasks/{taskId}/transition` | 业务态迁移（闭集校验，非法即拒） | 任务参与者 |
| `POST /v1/tasks/{taskId}/runs` | 开新 attempt（重试/重派/打回重做） | 任务参与者 |
| `POST /v1/tasks/{taskId}/outcome` | 记录派单结果 + 改派原因 | 派单人或负责人 |
| `GET /v1/tasks/{taskId}/report` | 六段式报告（stale 时 **503 + 显式 stale 理由**，不返半截） | `project.read` |
| `POST /v1/reports/{id}/confirm` | 确认归档；未确认不进周报 | 任务负责人 |

---

## 10. 实施切片

按依赖排序。每片独立可验收，前片不依赖后片：

| 片 | 内容 | 依赖 |
|---|---|---|
| **P5a** | 打分归一化 + 五维骨架 + 分档闭集 + 权重快照 | 无（纯 `domain.go` 改造 + 加列） |
| **P5b** | 熟练度表 + 反馈闭环 + Agent 授权路径闭合（§2.3） | P5a（喂 `C`/`Q` 维） |
| **P5c** | 任务/Run 拆分 + 业务态机 + 评审闸门 | P5a |
| **P5d** | 证据链报告生成器（六段式 + stale fail-closed + 成本聚合） | P5c |
| **P5e** | 统一 Worker：AI Worker 进候选池 | P5b + P5c |

语义回退（§3.5）不占片，可在 P5a 后任意时点接入 Milvus。

**P5a 先行的理由**：归一化是分档的前提，分档是产品形态（自动/建议/人工三档）的前提。它同时是
改动面最小的一片——不动数据模型主键、不动执行面、不动任何既有闭集取值。

---

## 11. 验收判据

1. **归一化**：任意候选 φ ∈ [0,100]；人机同尺（Human 走重归一化分支，上限同为 100）；
   TS 纯函数与 Go 实现对同一输入矩阵产出同一 `breakdown`（契约双实现，同 `projects` 惯例）。
2. **分档**：φ=90 判 `AUTO`、φ=89 判 `SUGGESTED`、φ=69 判 `MANUAL`（边界值三点必测）。
3. **冷启动性质**：`C=0` 且 `Q` 取先验的候选，技能全中且零负载时 φ ≤ 89——**数学上进不了自动派档**。
4. **权重快照**：改默认权重后重读历史派单，`score_breakdown` 与 `score_weights` 不变，
   `Rationale` 仍可复算。
5. **授权与熟练度分离**：熟练度写入不影响 `ResolveEffectiveSkills` 结果；同优先级版本冲突
   仍 fail-closed 抛错（既有行为不回归）。
6. **Agent 授权闭合**：给 agent 授技能 → 该 agent 有效技能含它；撤销 → 消失。
   （此项在本设计前**恒失败**，是缺陷闭合的证据。）
7. **任务/Run 拆分**：一次重派后旧 run 保留 `failure_kind` 与 `assigned_node_id`，
   新 run `attempt=2`；`(task_id, attempt)` 唯一约束生效。
8. **旧行兼容**：`business_state IS NULL` 的旧行可读可列；首次开新 attempt 时显式物化
   attempt=1 并写审计，不静默改写。
9. **报告 fail-closed**：注入复制滞后 → 报告端点返 503 且带显式 stale 理由，**不产出报告**。
10. **无证据强制标注**：构造一个无 `evidence[]` 的段 → `verified=false`；该报告未确认时
    不出现在周报聚合结果中。
11. **成本段一致**：报告成本段与 `usage_ledger` 按 run 聚合逐 `cost_type` 相等；闭集未扩集。
12. **schema 幂等**：`init()` 连跑两次不报错（§22.3 规则 1 的每列必测项）。

---

## 12. 不做的事（显式外）

- **禅道/Jira 全量数据模型**（研究稿 §4.2 的产品→需求→迭代→任务→子任务 + Bug/用例/发布 +
  追溯矩阵）。研究稿自估 4–6 人月，且它自己在 §10.3 给了更便宜的路：**双向同步，平台为内部
  状态事实源、外部系统为对外同步面**。Lumo 走 §10.3。本篇只建解锁其余能力的最小模型
  `task + dispatch + run + report + review`。
- **评测中心与四层评测门禁**（研究稿 §4.1）。它是 `Q` 维的理想来源，但本篇的 `Q` 先由派单结果
  回流供给，可独立成立。评测是独立切片。
- **Hub-Spoke 多集群与动态评分**（研究稿 §8.2/§8.3）。`architecture.md` §7.4 已有设计未实现，
  与本层正交——业务控制面不关心 Run 落在哪个集群。
- **A2A 端点适配器**（研究稿 §6.1/§10.3）。注意研究稿自身主张「平台内部消息一律不走 A2A，
  直接走事件总线」——这与 Lumo 用 RocketMQ 做内部 A2A 的既有决策一致，因此只欠一个**对外**
  适配器，不欠内部机制。独立切片。
- **`AgentRuntime` 抽象层**（研究稿 D1）。见风险 R1。
- **IM 卡片与外部工单双向同步**（研究稿 §10.2/§10.3）。依赖本篇的事件目录先稳定。
- **计费与商业化**（研究稿 §9.8 的 TEU/席位/隔离分档）。Lumo 的 `cost_type` 闭集与预算树已能
  支撑核算，售卖口径是产品决策不是架构决策。
- **前端页面**（研究稿 §9.3 七页）。本篇只交付后端语义与端点；`lumo-ui` 面板是独立切片。

---

## 13. 风险与取舍

**R1 —— `AgentRuntime` 抽象层：不做，但登记。**
研究稿 D1 主张「dsh 为参考 + `AgentRuntime` 适配层，可切 LangGraph/CrewAI」，理由是 dsh 处于
Developer Preview。这与 Lumo 的核心赌注正面相对：零侵入铁律 + 整个插件层是 Cordis 专属。
**建议不做**——铁律本身已提供升级路径（升级 dsh 无需 rebase 任何补丁；删除平台代码后 dsh 原样
可跑），再造一层适配的成本远超对冲收益。但这是一个**有意承担的集中风险**，登记在案而非默默忽略。

**R2 —— 权重是产品旋钮，不是常量。**
`w1..w5` 一旦进入运营调参，就会有人想「调高质量权重让老员工多接活」。快照机制（§3.3）保证历史
可复现，但**权重变更本身必须走审计**，否则派单公平性无法事后追责。建议权重变更复用 flows 的
FlowReview 式职责分离（改权重的人不能是自己受益方）——本篇不实现，登记为约束。

**R3 —— `Q` 的冷启动偏置。**
`w4=0.25` 是第二大权重，而新 Worker 的 `Q` 取先验中位数。这在设计上等价于「新人先当二等候选」。
研究稿的补偿是发展机会加分（`bonus +2~5`），本篇**未采纳**——加分项会破坏 φ 的 [0,100] 闭区间
与分档语义。替代方案是探针任务走独立通道（不与正式任务竞价），列为后续切片。

**R4 —— 语义回退的假阳性。**
embedding 近邻会把「Kafka 运维」召回给「消息队列」标签持有者。折减系数（§3.5）只降低分值，
不阻止命中。缓解靠 §3.6 的改派原因回流：`SKILL_MISMATCH` 集中出现的标签对进入人工复核。
**不建议**用提高阈值来解决——那会同时压制真阳性。

**R5 —— 一张表承载任务与 Run 的历史债。**
§4.3 的显式物化方案要求新代码永远记得处理旧行。这条分支会长期存在（不设删除期限，因为不回填
假数据）。取舍是：宁可留一条有测试覆盖的显式分支，也不做一次性回填——回填即伪造历史，违反
§22.3 规则 2。

**R6 —— 报告 fail-closed 的可用性代价。**
复制滞后时报告不可用（返 503）。这是刻意的：一份看起来完整、实际漏了尾部事件的报告，比没有
报告危险得多（研究稿 §13 风险 7：不可审计的黑箱汇报导致信任崩塌）。缓解是把 stale 理由与
预计可用时间一并返回，而不是放宽判据。

---

## 14. 对既有待决事项的影响

`docs/README.md` §四「仍待拍板」第 1 条（**落地首切顺序**：规范的「Nacos → 自研网关 →
连接器 + DAG」 vs 评审 §5.2 的「先单节点垂直切片」）。

研究稿**站评审那边**：其 P0 定义为「任务→派单→执行→轨迹→报告 证据链闭环」，是典型垂直切片，
且明确写「P0 的目标不是功能全，而是证据链闭环跑通」。

但需要如实指出：**这条分歧在基础设施层已经消解**——Nacos、自研网关、连接器、DAG 四项 Lumo
均已建成，规范侧顺序事实上已执行完毕。研究稿的真正贡献不是给这条旧分歧投票，而是**重新定义
了下一个切片该是什么**：从「再建一层基础设施」转向「把已建成的基础设施接成一条用户可见的
业务闭环」。

**建议**：该待决项不按原表述「二选一」结案，改为记录「基础设施顺序已完成，后续切片按垂直
闭环组织」，并把本篇 §10 的 P5a–P5e 作为首个垂直闭环的分解。此项属于文档口径变更，
**需人拍板，本篇不代为结案**。

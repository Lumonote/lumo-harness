# 基于 DeepSeek Harness 的 Token 计量、归因与配额控制体系（Addendum 9）

> **【已整合 · 以 V2 为准】** 本文内容已并入 [`deepseek_harness_architecture_v2.md`](./deepseek_harness_architecture_v2.md)（V2 优化整合版）§6.4，请以 V2 为权威版本。

> 配套文档体系第 9 篇。前序：① 总体架构 ② 数据层 ③ 调度面 ④ 异步+多端 ⑤ 注册+流程化 ⑥ 连接器+RBAC+分发 ⑦ 技术架构总纲 ⑧ Nacos+自动安装+RocketMQ A2A。
> 本篇定位：**控制面的「计量与配额」子面**——功能级 token 计数、按人/部门/角色多维归因、平台级溯源，以及限流（rate limit）与限额度（quota）的闭环控制。

---

## 0. 一句话核心

> **所有 token 消耗只在 `ctx.llm` 网关这一道截面被计量；每笔消耗都带一段从 request 透传到底层的 trace context（user / dept / role / agent / component / session），明细落 PG、聚合进 Doris、限流走 Redis、规则由 Nacos 下发——于是「谁、在哪个功能、花了多少、是否被限」全程可溯源、可治理。**

dsh 的「一切皆插件 / 一切走 seam」在这里是唯一优势：因为 LLM 调用、工具调用、seam 调用都被收口在固定 Provider/事件瀑布上，**计量点不需要侵入业务代码，只挂在控制面的几个固定截面**。

---

## 1. 设计原则（钉死的判断）

| 原则 | 含义 | 反模式 |
|------|------|--------|
| **单一计量截面** | token 只在 LLM 网关（含批处理网关）计量 | 在各组件里各自 `count()`，口径永远对不齐 |
| **明细事务化、聚合最终一致** | 溯源明细进 PG（强一致），报表聚合进 Doris（最终一致） | 把明细和聚合混在一张表，或把 PG 当分析库 |
| **归因随请求透传** | trace context 从 API 入口一路 baggage 到每次 LLM/seam 调用 | 组件自己 guess 用户/部门，身份错乱 |
| **限流/额度前置** | 在 LLM/Seam/连接器网关**拦截**，不事后追缴 | 超限后才发现，产生计费纠纷与成本黑洞 |
| **异步削峰** | 计量事件走 RocketMQ，落库不阻塞推理 | 同步写 PG，推理被计量拖慢 |
| **额度树单向耗尽** | 平台→部门→角色→用户，上级耗尽下级全停 | 各层独立额度，部门超了用户还能花 |
| **规则动态下发** | 限流/额度/单价规则存 Nacos Config，热加载 | 改限额要重启节点 |

---

## 2. 计量模型（Metering Model）

### 2.1 计量维度（Dimensions / 归因轴）

每次消耗事件携带以下维度，组合成多维立方体（cube）：

| 维度 | 来源 | 说明 |
|------|------|------|
| `tenant` (realm) | dsh `CredentialKey` → realm | 首要隔离边界（前篇 RBAC） |
| `user_id` | OIDC/SSO 断言 | 自然人 |
| `dept_id` | **组织树（Org Hierarchy）** | 部门，支持多级（dept → sub-dept） |
| `role` | RBAC 角色 | 角色标签（多角色取并集/主角色） |
| `agent_id` | `ctx.agentTeams` / agent preset | 哪个业务智能体 |
| `component_id` / `skill_id` | 组件/skill manifest | 哪个能力组件触发 |
| `feature` | **功能标签** | 功能级计数键（见 2.3） |
| `seam` | `ctx.llm` / `ctx.datastore.*` / `ctx.tools` | 走了哪个能力接缝 |
| `model` | LLM Provider 参数 | 模型名（单价不同） |
| `session_id` / `request_id` | dsh SessionEvent | 平台级溯源主键 |
| `ts` | 事件时间 | 周期窗口依据 |

> `dept_id` / `role` 不是各组件自己填的，而是从入口 request 的 **trace context** 透传下来的（类比 W3C `traceparent` / OpenTelemetry `baggage`），保证整条链路身份一致。

### 2.2 计量对象（Metrics）

| 指标 | 含义 | 采集点 |
|------|------|--------|
| `prompt_tokens` | 输入 token | `ctx.llm` 返回 usage |
| `completion_tokens` | 输出 token | `ctx.llm` 返回 usage |
| `total_tokens` | 合计 | 派生 |
| `embedding_tokens` | 向量化 token（KB 组件） | `ctx.knowledge` 子调用 |
| `tool_calls` | 工具调用次数 | `tools/post-execute` |
| `external_api_calls` | 外部连接器调用 | 连接器网关 |
| `image/audio_tokens` | 多模态 token | 对应 seam |

> **关键：所有指标只在 `ctx.llm` 网关 + 几个 seam 网关被采集**，组件本身不感知计量。

### 2.3 功能级计数（Per-Feature）

「功能 token 计数」= 给每次 LLM 调用打一个 **`feature` 标签**，从 manifest 或调用上下文解析：

- 组件/skill manifest 声明 `feature: "data-analysis"` / `"knowledge-qa"` / `"report-gen"`；
- agent preset 声明 `feature: "agent:<name>"`；
- 系统调用（如 HITL 提示、编排规划）标注 `feature: "system.orchestration"`；
- 未声明则回退到 `seam` 名。

于是可回答："**知识库问答这个功能，本周各部门各花了多少 token**"——这是功能级计量的核心价值。

---

## 3. 采集点（Collection Points，挂在 dsh 原生扩展）

```
                         ┌─────────────────────────────────────┐
 request (user/dept/role) │  Terminal/Connector Gateway          │
        │ 注入 trace ctx   └───────────────┬─────────────────────┘
                                            │ baggage 透传
   ┌────────────────────────────────────────┼───────────────────────────┐
   │  dsh Agent Loop (agent/*, tools/* 瀑布)  │                            │
   │                                        │                            │
   │   ctx.tools  ──post-execute──► MeteringHook(tool_calls)             │
   │   ctx.knowledge ──► MeteringHook(embedding_tokens)                  │
   │                                        │                            │
   │            ctx.llm  ───────────────────┼──►  LLM Batching Gateway   │
   │                                        │      (所有 token 唯一截面)  │
   └────────────────────────────────────────┼───────────────────────────┘
                                            │ usage + trace ctx
                                            ▼
                                  Metering Service (emit event)
                                            │
                                  RocketMQ (usage.event.*)
                                            │
                              ┌─────────────┴──────────────┐
                          PG (明细 ledger)            Doris (聚合/报表)
                          append-only + 签名         部门/角色/周期 cube
```

对应 dsh 扩展点：
- **`ctx.llm` Provider（含 §3 调度面的批处理网关）**：包裹原生 Provider，`onUsage` 回调里读 trace context + 记 token。
- **`tools/post-execute` 事件**：hook 记 `tool_calls` 与外部调用。
- **seam 子调用**（`ctx.knowledge` / `ctx.datastore.*`）：Provider 内部记 embedding/查询 token。
- **session 事件**：计量事件同时作为 session 事件广播（前篇多端可见），保证"用量"也是可观测事件。

---

## 4. 存储与数据分层

| 存储 | 角色 | 内容 |
|------|------|------|
| **PG（事务）** | 溯源明细真相源 | `usage_ledger`（每行一笔消耗：全维度 + token + 单价 + 签名）；`org_tree`、`quota_policy`、`rate_policy` |
| **Doris（OLAP）** | 聚合/报表 | 按 `tenant/dept/role/feature/model/周期` 预聚合的 cube；供多端用量看板 |
| **Redis** | 限流/额度高速层 | 令牌桶、滑动窗口计数、周期额度余量（TTL 对齐周期） |
| **Nacos Config** | 规则源 | 限流阈值、额度预算、单价、告警线（热加载） |

> 呼应数据层 addendum：PG=元数据主库、Doris=分析算力、Redis=热态——计量把这三者的分工用到了极致。

---

## 5. 归因与组织树（Attribution）

```
用户 ──SSO/OIDC──► 角色(RBAC) ──┐
                                ├──► trace context ──► 透传 baggage ──► 每次 LLM/seam 调用
部门(Org Tree) ─────────────────┘
```

- **Org Tree** 是部门维度的权威来源，同步自 SSO/HR 系统（如 LDAP/飞书/企业微信），存 PG，不允各组件自建。
- **trace context** 在 API 入口构造（`user_id/dept_id/role/tenant/request_id`），经 dsh 调用链 baggage 透传；`agent.inject()` / RocketMQ A2A 信封（前篇）把 context 一并带过去，保证跨 agent、跨节点、跨异步唤醒后身份不丢。
- **角色**支持多角色：计量取"主角色 + 角色并集"双写，额度按最严的角色策略生效。

---

## 6. 限流（Rate Limiting）

### 6.1 限流维度与层级

| 层级 | key 例 | 算法 | 存储介质 |
|------|--------|------|----------|
| 全局 | `global:llm` | 滑动窗口 | Redis |
| 租户(realm) | `realm:{rid}:llm` | 令牌桶 | Redis |
| 部门 | `dept:{did}:llm` | 令牌桶 | Redis |
| 角色 | `role:{rid}:llm` | 令牌桶 | Redis |
| 用户 | `user:{uid}:llm` | 令牌桶 + 突发 | Redis |
| 功能 | `feature:{f}:llm` | 令牌桶 | Redis |
| 连接器 | `connector:{c}:egress` | 令牌桶 | Redis |

### 6.2 挂接位置（前置拦截）

- **LLM 网关**：每次 `ctx.llm` 调用前，按 `tenant/dept/role/user/feature` 逐级扣令牌，任一超限即 **429 + 退避**，不进入推理。
- **Seam Proxy / 连接器网关**：Doris、PG、外部 API 的速率熔断（呼应数据层/连接器 addendum）。
- **调度面**：放置算法里把"目标节点/租户预算余量"作为得分项，预算将尽的租户任务排到低位或 suspend。

### 6.3 规则热加载

限流阈值存 **Nacos Config**，`rate-policy.json` 变更经 `addListener` 推到所有网关节点，无需重启。

---

## 7. 限额度（Quota / Budget）

### 7.1 额度树（单向耗尽）

```
平台总额度 (platform)
   └─ 部门额度 (dept A / dept B / ...)
        └─ 角色额度 (role X / role Y)
             └─ 用户额度 (user 1 / user 2 / ...)
```

- 上层额度是下层的**硬上限**：部门耗尽 → 其下所有角色/用户立即停权（返回 `quota_exceeded`，可降级到 HITL 或轻量模型）。
- 周期：日 / 周 / 月 / 自定义窗口，Redis 计数带 TTL 对齐周期边界；PG 存预算定义。

### 7.2 核对与执行流程

```
LLM 调用前:
  1. 取 trace context (tenant/dept/role/user/feature)
  2. Redis 取各层余量 = budget - consumed(window)
  3. 若任一层 <= 0 → 拒（quota_exceeded）/ 降级
  4. 通过 → 进入推理 → usage 事件 → Doris 实时聚合 → 余量刷新
  5. 软阈值告警（达 80%）→ 通知 + 可临时提额（Nacos 审批流）
```

- **实时性**：Doris 周期聚合 + Redis 高速余量双轨；强一致核对以 Redis 为准（防超花），Doris 做报表。
- **降级策略**：超预算可降级到便宜模型、转 HITL、或排队到下一周期——由 Nacos 策略配置。

---

## 8. 平台级溯源（Traceability / Audit）

一笔 token 消耗的可溯源链：

```
usage_ledger 一行:
  request_id → session_id → user_id → dept_id → role
             → agent_id → component_id/skill_id → feature
             → seam/model → prompt/completion tokens → 单价 → 成本
             → ts → 签名
```

- 与**连接器审计**（addendum 6）、**session 事件**（addendum 4）、**Auditor** 打通：任何外部调用、任何 agent 动作都能关联到同一 `request_id` / `session_id`，形成端到端溯源。
- **防篡改**：ledger 行 append-only + 摘要签名，对账可验。
- **多端看板**：部门管理员看本部门 cube，平台管理员看全局 cube（呼应 addendum 4 多端事件汇）。

### 8.1 典型溯源查询

| 问题 | 取数 |
|------|------|
| 张三月花了多少、花在哪 | `user_id=张三` → ledger 明细 |
| 知识库功能各部门的成本 | `feature=knowledge-qa` → Doris 按 `dept` 聚合 |
| 哪个 agent 最烧钱 | `agent_id` 聚合 → Doris top |
| 一次异常高账单的根因 | `request_id` 拉全链路 |

---

## 9. 与既有体系的咬合

| 体系 | 本篇如何衔接 |
|------|--------------|
| **RBAC（6）** | `tenant/role` 直接作为限流/额度维度；OPA 策略点同时评估"是否超预算" |
| **Nacos（8）** | 限流阈值、额度预算、单价、告警线全存 Nacos Config，热加载 |
| **RocketMQ（8）** | 计量事件走 `usage.event.*` 主题异步削峰落库；不阻塞推理 |
| **数据层（2）** | PG=明细、Doris=聚合、Redis=限流，三者分工到位 |
| **调度面（3）** | 放置算法读预算余量；超限任务 suspend/降优先级 |
| **异步+多端（4）** | trace context 经 A2A 信封/`agent.inject()` 透传；用量看板多端一致 |
| **连接器（6）** | 连接器网关叠加 egress 限流；外部调用计入 `external_api_calls` |
| **注册表（5）** | 计量服务自身注册到 Nacos，配额策略按 realm 灰度 |

---

## 10. 代码骨架（Cordis / TS 风格，零侵入内核）

```ts
// ---- trace context：随请求透传的身份/归因 baggage ----
interface TraceCtx {
  requestId: string; sessionId: string;
  tenant: string; userId: string; deptId: string;
  role: string; agentId?: string; componentId?: string;
  feature: string;
}

// ---- 单一计量截面：包裹 ctx.llm Provider ----
const meteringLlmProvider: LlmProvider = {
  id: 'llm.metered',
  async complete(req: LlmRequest, ctx: TraceCtx) {
    const rl = await rateLimiter.acquire(ctx);      // ① 前置限流
    if (!rl.ok) throw new QuotaError('rate_limited', rl.retryAfter);
    const quota = await quotaManager.check(ctx);    // ② 前置额度
    if (!quota.ok) return quota.degrade ?? deny();

    const r = await upstream.complete(req);          // ③ 真实推理
    const usage = r.usage;                           // {prompt, completion}
    metering.emit({ ...ctx, model: req.model,
      promptTokens: usage.prompt, completionTokens: usage.completion,
      unitCost: priceBook.get(req.model) });         // ④ 发事件（RocketMQ）
    return r;
  }
};

// ---- 限流：Redis 令牌桶（多层级 key）----
class RateLimiter {
  async acquire(ctx: TraceCtx) {
    for (const key of [
      `g:llm`, `r:${ctx.tenant}`, `d:${ctx.deptId}`,
      `role:${ctx.role}`, `u:${ctx.userId}`, `f:${ctx.feature}`,
    ]) {
      const ok = await redisTokenBucket(key, policyFor(key));
      if (!ok) return { ok: false, retryAfter: await ttl(key) };
    }
    return { ok: true };
  }
}

// ---- 额度：Redis 余量 + PG 预算 ----
class QuotaManager {
  async check(ctx: TraceCtx) {
    for (const layer of ['tenant','dept','role','user'] as const) {
      const key = `${layer}:${ctx[layerKey(layer)]}`;
      const budget = await policyBudget(key);          // PG/Nacos
      const used = await redisIncrBy(key, 0, window(budget.period));
      if (used >= budget.limit) {
        const degrade = await nacosGet(`degrade.${key}`);
        return { ok: false, err: 'quota_exceeded', degrade };
      }
    }
    return { ok: true };
  }
}

// ---- 计量服务：事件异步落库（不阻塞推理）----
class Metering {
  emit(e: UsageEvent) {
    rocketmq.publish('usage.event.detail', e);        // → PG 明细 (消费者)
    rocketmq.publish('usage.event.agg', e);           // → Doris 聚合 (消费者)
  }
}

// ---- 工具调用计量 hook（dsh tools/post-execute）----
ctx.on('tools/post-execute', (e, ctx: TraceCtx) => {
  metering.emit({ ...ctx, feature: e.tool.feature ?? 'tool',
    toolCalls: 1, externalApiCalls: e.tool.isExternal ? 1 : 0 });
});
```

> 全部只依赖 dsh 稳定语义（`ctx.llm`、`ctx.on`、`TraceCtx` baggage、session 事件），不碰 Cordis 内核。

---

## 11. 硬规矩（Opinionated，收口到本篇）

1. **计量只在 LLM 网关单截面**，组件不各自计数——否则口径永不对齐。
2. **明细进 PG、聚合进 Doris、限流走 Redis**，三者分工不可混淆。
3. **限流/额度必须前置拦截**，不事后追缴，避免成本黑洞与纠纷。
4. **部门/角色映射用权威组织树（SSO 同步）**，禁止组件自建身份。
5. **计量事件走 RocketMQ 异步削峰**，落库绝不阻塞推理。
6. **额度树单向耗尽**：上级空、下级停，预算必须分层收敛。
7. **trace context 跨 agent / 跨节点 / 跨异步唤醒透传**，否则溯源断链。
8. **ledger append-only + 签名**，防篡改、可对账。
9. **限流/额度规则存 Nacos 热加载**，改阈值不重启。
10. **单价透明可配**，功能级成本可解释（给管理层看报表）。

---

## 12. 体系位置（九篇闭环）

| 文档 | scope |
|------|-------|
| 1 总体架构 | 分层 + Seam 网络化 + 组件化/分发 |
| 2 数据层 | PG/Doris/Nebula/Redis/分布式DB |
| 3 调度面 | 高并发协同调度 |
| 4 异步+多端 | suspend/resume、future、终端事件汇 |
| 5 注册+流程化 | 注册表 + DAG 流程引擎 |
| 6 连接器+RBAC+分发 | 外部连通 + 角色权限 + 分发体系 |
| 7 技术架构总纲 | 统一分层 / 模块分解 / 蓝图 |
| 8 Nacos+自动安装+RocketMQ A2A | 注册配置中心 + 自动装配 + 多 agent 可靠协同 |
| **9 Token 计量·归因·配额（新）** | **功能级计数 + 人/部门/角色归因 + 平台溯源 + 限流/限额度** |

至此控制面「计量与配额子面」闭合：从一次 LLM 调用，可直溯到具体的人、部门、角色、功能、agent，并进行限流与限额度控制；明细/聚合/限流三层存储分工明确，规则由 Nacos 动态下发，事件经 RocketMQ 削峰，看板多端一致。

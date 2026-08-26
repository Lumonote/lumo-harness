# LLM 网关设计说明 —— P2a 起始项：模型访问面 + 计量单截面跨网 + 流式背压

- 日期：2026-08-26
- 前置：`architecture.md` §12（网关全栈 Go 自研）/ §6.4（计量单截面）；seam 远程形态设计
  §2.1（ctx.llm 第一跳，P2a 起始项）；RocketMQ 计量传输已落地（`2026-08-26-ledger-rmq-transport-design.md`）
- 状态：设计说明（实现同步进行——本切片）

## 1. 定位与首切片边界

LLM 网关是「模型访问面」的门（§12.1）：协议对话、流控、计量、配额、模型路由。
dsh 节点不再握自己的 Provider 配置——`ctx.llm` 指向本集群网关入口。

**首切片交付**（单节点 standalone 形态，§2.1「接线顺序」第一格）：

1. OpenAI 兼容 `POST /v1/chat/completions`（流式 SSE + 非流式）；
2. Provider 注册表（PG）：model → upstream base URL + key + **费率**（网关持有费率，
   §2.1 原文）；
3. **计量单截面在网关**：归因从 X-Lumo-* 头取，usage 从上游响应取，一次调用恰好
   产生一条 `llm.tokens` 事件（emitter=`llm-gateway`，costUsd 按费率算）；
4. **预算执法镜像**：reserve 前置双树四态检查 + commit 双树同事务扣减——Go 侧逐语义
   镜像 TS `pg-meter.ts`（单截面跨网成立的前提是执法语义不因语言分叉）；
5. 流式背压：逐 chunk 转发 + 有界扫描缓冲（禁止无界缓冲，§2.1）。

**显式外**（各有归属）：Redis 令牌桶限流（§12.2，随限流库接入）、batch API、模型
fallback 链、Vault 托管 key（dev 形态 key 落 PG，Vault P2）、OTel 指标、集群形态。

## 2. 数据模型

```sql
CREATE TABLE IF NOT EXISTS llm_providers (
  model              TEXT PRIMARY KEY,   -- 对外模型名（路由键）
  upstream_base_url  TEXT NOT NULL,     -- OpenAI 兼容上游
  api_key            TEXT NOT NULL DEFAULT '',
  price_in_per_mtok  NUMERIC(20,6) NOT NULL DEFAULT 0,   -- 输入费率（$/1M tokens）
  price_out_per_mtok NUMERIC(20,6) NOT NULL DEFAULT 0,   -- 输出费率
  enabled            BOOLEAN NOT NULL DEFAULT true,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**零新计量表**：预算执法读写既有 `budget_trees` / `usage_event_outbox`（DDL 真相源在
TS `pg-meter.ts`——网关不建表不迁表，表缺失时启动报「metering 未初始化」同 projects
哲学）。网关是这两个表的**第二个写入方**（第一个是 TS metering 插件）——两写入方写
同一 outbox、扣同一批树，行级原子性由 PG 事务保证；语义一致性由「Go 镜像 TS 的集成
测试同断言」锁定（§5 判据 6）。

## 3. 归因与计量截面

- 头：`X-Lumo-User/Realm/Dept/Role/Project` **必填**（缺 400——归因不完整的账是脏账，
  宁可拒）；`X-Lumo-Agent`（缺省 `system`）、`X-Lumo-Component`（缺省 `llm-gateway`）、
  `X-Lumo-Feature`（缺省 `llm.chat`）、`X-Lumo-Session`（缺省 `system`）、`X-Lumo-Trace`
  （缺省网关铸 `gw-<hex>`）。
- usage 提取：非流式从响应 JSON `usage`；流式由网关**给上游注入**
  `stream_options.include_usage=true`（客户端没带也注入——计量截面不能依赖调用方的
  善意），从末 chunk 取 `usage`。上游仍不给 usage → 计 0 并告警（可见缺口，不是静默
  跳过——「一次调用一条事件」的完整性优先于数值准确，缺口靠日志暴露）。
- costUsd = (input_tokens × price_in + output_tokens × price_out) / 1e6，费率四舍五入
  到 1e-6（NUMERIC(20,6) 精度对齐）。
- qty = tokens = input + output（与 TS commit 的 token 截面同口径）。

## 4. 请求生命周期（一条流的全路径）

```text
client ──chat/completions──▶ 网关
  ① 归因头解析（缺必填 400）
  ② reserve：双树 FOR UPDATE 四态，worst=hard → 402 denied-{user,project}-budget
  ③ 路由：model → llm_providers（缺/停用 404 unknown-model）
  ④ 注入 stream_options → 转发上游（SSE 或 JSON）
  ⑤ 流式：逐 chunk 转发（有界缓冲扫描 usage）；非流式：收全量再转发
  ⑥ 流结束：commit（单事务：双树无条件扣减 + outbox INSERT event_key=gen_random_uuid()）
  ⑦ 上游失败：已见 usage 则照计（部分输出的钱也是钱）；usage 缺失计 0 + warn
```

commit 的扣减语义与 TS 完全一致：**无条件、允许负数**（封顶可判的既定决策）；事件
幂等键由 PG 生成；`ts` 用事件时刻（outbox 列缺省 now()）。

## 5. 验收判据

1. 非流式：一次调用 → 恰好 1 条 outbox 事件（归因全维度、qty=tokens、costUsd=费率
   算出值、emitter=llm-gateway）+ 双树各扣 tokens；
2. 流式：chunk 顺序透传（首 chunk 不因计量延迟——TTFT 预算 §21.1）+ 末尾 usage
   提取 → 1 条事件 + 双树扣减；客户端不带 stream_options 时网关注入；
3. reserve：任一树 hard → 402 且 reason 区分树；双树取更严者；
4. 上游无 usage → 事件计 0 + 告警日志（不静默）；
5. 缺归因头 400；未知模型 404；
6. **语义镜像**：Go 四态/worseOf 与 TS budget-policy 同矩阵（Go 单测逐格对照 TS spec
   的判序：within < soft < overdraft < hard，used 左闭）；commit 扣减语义 = TS
   outbox.spec 已断言的「事件与扣减同事务」在 Go 侧重演；
7. **全链联测**（§2.1 点名的与计量事件流联测）：compose 上 gateway 写 outbox →
   usage-ledger 服务 publisher → RocketMQ → consumer → `usage_ledger` 行
   （emitter=llm-gateway）——真 broker 真库端到端。

## 6. 不做的事（显式外）

- **限流（Redis 令牌桶）**：§12.2 的多层级限流是独立切片（依赖限流库选型与 Redis
  Cluster 装配）；本切片 budget 四态已是额度闸，速率闸缺席记为已知缺口；
- **batch API / 模型路由 fallback / 负载均衡**：sub2api 同构能力，随集群形态；
- **Vault key 托管**：dev 形态 key 落 PG（llm_providers 表）；Vault 接线后迁移列；
- **OTel 指标 / Prometheus**：§21 观测切片统一挂；
- **集群形态 / 多实例**：helm 阶段。

## 7. 风险与取舍

- **双写入方语义漂移**（最大风险）：TS 与 Go 都在写 outbox/扣树。防线三层——Go
  reserve/commit 集成测试直接复用 TS spec 的断言形状（判据 6）；`event_key` 全部由
  PG 生成（两侧不各自造键格式）；长期正解是把执法收敛成共享 SQL 模块（PG 函数），
  列为显式待补不静默。
- **流式中间态计量**：上游断流时 tokens 计 0——比「估个数」诚实（估计值进账是
  审计污染），缺口由告警日志承担。
- **key 落 PG（dev）**：生产禁——Vault 落地前 standalone 形态限定。compose 的
  llm_providers 种子不含真实 key（指向本地假上游）。

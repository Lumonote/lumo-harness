# 计量台账 RocketMQ 传输设计说明 —— usage-ledger Go 服务:发布与消费都进 Go,B2 偏离①收账

- 日期:2026-08-26
- 前置:`2026-08-26-metering-outbox-design.md`(管线四不变式)、`platform/shared/manifests/usage-ledger.schema.json`(台账列单一真相源)、`2026-08-26` Standalone 拓扑 RocketMQ SEND_OK 实测
- 章节:`docs/architecture.md` §6.4(异步削峰)、§8.3(RocketMQ A2A)
- 状态:设计说明(实现同步进行——本切片)

## 1. 前面两个结论(不可再绕)

1. **TS 侧没有可用的 RocketMQ 客户端**(`rocketmq-client-js` 在 npm 不存在,2026-08-26 实证)。
   因此「计量事件走 RocketMQ」这条链**发布侧与消费侧都落在 Go**。
2. **本地等价形态先于传输存在是刻意的**(B2 偏离①记账):Local-lite 的 `drainOnce`(PG 直搬)
   与 Standalone+/Cluster 的 Go 传输是**两条装配差异路径**,不是两条真相源——台账
   `usage_ledger` 永远只有一个写入者,按形态二选一,绝不并存。

## 2. 拓扑:usage-ledger Go 服务内外三通道

```text
Local-lite(1 二进制):    outbox →(TS drainOnce,按期)/ → ledger            [现状,不动]
Standalone+/Cluster:      outbox →(publisher 发布)/ → RocketMQ(topic: usage-events-<cost_type>)
                          →(consumer 消费)/ → usage_ledger(幂等 event_key)
```

- **publisher**:轮询 `usage_event_outbox WHERE published_at IS NULL ORDER BY seq LIMIT n FOR UPDATE SKIP LOCKED`
  →逐条发消息(顺序按 seq)→ 整批标记 `published_at`。失败整批回滚(不标记),下一轮重放。
- **consumer**:订阅 6 个 topic(闭集)与 retry topic(延时退避语义在 broker 侧,同步/异步 pull 推由服务端配置)→逐事件**校验**→
  INSERT `usage_ledger` ON CONFLICT(event_key) DO NOTHING(`ts` 用事件时刻,由 payload 字段)。
- **同一进程双 goroutine**(Standalone);集群形态도록同镜像多实例(消费组自动分摊,SKIP LOCKED
  保证发布不重)。两者与 TS 侧 `drainOnce` 是**互斥装配**:metering 插件 config 显式
  `ledgerTransport: "local" | "rmq"`,rmq 时 TS 不再起 drain 轮询。

## 3. 四个不变式在 Go 的实现承诺(与 2026-08-26 outbox 设计 §3 同表)

| 不变式 | 本地(TS drain) | RocketMQ(Go) | 尺子 |
|---|---|---|---|
| ①一次事件一账 | ON CONFLICT event_key DO NOTHING | 同左;外加至少一次投递重复消费兜底 | 重放不重复 |
| ②事件时刻保真 | ts←outbox.ts | payload.ts 透传,消费端**不许再取 now()** | 账期不因传输漂移 |
| ③顺序稳定 | ORDER BY seq 搬运 | 发布按 seq;消费按 broker offset 序(同 topic 均序);入库后 (ts,id) 语义不变 | byTrace 两读一致 |
| ④原子配套 | 扣减+outbox 同 PG 事务(已有) | 不变——发布/消费只挪「outbox→ledger」这一段 | 不与扣减掺和 |

## 4. Go 服务内部(目录/状态/错误面)

```
control-plane/usage-ledger/
  cmd/usage-ledger/main.go          flags/env:schema DS、rmq endpoints、topic 前缀、组
  internal/manifest/manifest.go     同一册 ledger 列清单(shared/manifests/usage-ledger.schema.json)go:embed 生成 DDL/INSERT
  internal/ledger/ledger.go         校验(pgxl/极简) + 批量 INSERT(ON CONFLICT)
  internal/rmqpublish/publisher.go  outbox→RocketMQ,SKIP LOCKED 批处理 + published_at 标记
  internal/rmqconsume/consumer.go   push 消费者,解密→校验→ledger;重试策略:至少一次+幂等
  集成测试:integration/*_test.go(真 PG 55432 + 真 namesrv 群)
```

- **状态**:`usage_event_outbox` 加一列 `published_at TIMESTAMPTZ NULL`(与 `projected_at`
  平行;local 用 projected_at,rmq 用 published_at——同一行双通道各自推进,互不清零)。
- **错误面**:校验失败(闭集外/缺归因)→**拒绝入账并告警**——不静默跳过;连续失败退避(指数)
  后将 event 放入 dead 队列;DLX 行为列在本设计「不做的事」。PG 不可写 → 消费重试(幂等使
  安全);RocketMQ 不可写 → publisher 不标记自然积压(§20 表已立)。
- **返回钩子**:`/healthz`、`/v1/metrics/pending`(outbox 未发布/已发布未消费,即仪表化积压)。

## 5. 闭集单源(已踩的第二个跨语言)

6 个 cost_type 的闭集住在 `cost-events.ts`(TS);Go 若抄一遍就成了**第二真相源**,与账本列清单同一个
罪。解法同 outbox 设计:闭集进 `shared/manifests/cost-types.manifest.json`(type/unit),TS 侧
`COST_TYPES`**改由 manifest 派生**,Go 侧 embed 同一文件做校验。TS 语义注释(为什么是闭集等)
留在 TS 文档注释里,数值不再两处。

## 6. 验收判据

1. 发 1 个事件(经 TS 写 outbox 或 direct insert)→ publisher 落 broker 单条消息;consumer 落 ledger 1 行,event_key 幂等(重放 broker 后行数不变)
2. 消费两遍(broker 侧重放同一批)→ 账目仍 1 行(判据 1 幂等)
3. 事件时刻保真跨链:outbox.ts = 消息 payload.ts = ledger.ts(整链透传)
4. 归因字段完整入库(user/dept/role/project/agent/component/feature/session_ref 全维度)
5. publisher 批量 + 失败回滚:发一条 doc 中途失败(网络/不可达)不标记 published_at,重试可恢复
6. consumer 校验:闭集外 cost_type 拒绝+告警不落库;缺归因拒绝
7. 两个装配路径互斥:metering config ledgerTransport=rmq 时 TS 不再 drain(测试:装配测试);local 时现状不动
8. 文档同步:B2 偏离①标记「传输已接线(Standalone 拓扑实测)」;§6.4 异步削峰补 Go 服务形态;README 计量行更新

## 7. 不做的事

- **不做 DLQ 持久化**——死信只告警不落库(下批加阅用表);连续失败仅重试若干次后告警。
- **不做消费侧顺序事务**——broker 顺 offset 消费,已够;跨 topic 序不承诺(每 topic 顺序)。
- **不做 rocketmq 全 cluster 规模化调优/HA**——那就是 §13.2 自己的事,本切片 Standalone 单 broker。
- **不做 Go 侧限流/预算执法**——执法留在 PG 树与 Redis(§6.4),ledger 只是账。
## 8. 实测补记（2026-08-26 实现，真 broker 逮出的偏差）

落地时真机验证推翻/补正了本设计的三处假设，全部已在代码注释中固化：

1. **`mqbroker --enable-proxy`（LOCAL 模式）走不通**：ProxyStartup 不接受 broker
   conf 的 `namesrvAddr`，启动即「NamesrvAddr is not configured」退出。改为同容器
   独立 `mqproxy -n localhost:9876`（CLUSTER 模式），compose 映射 8081。
2. **v5 客户端（golang v5.1.4）两个坑**：① producer 必须以 `WithTopics`（全闭集
   topic）构造——零 topic 的生产者 `Start()` 永远卡在 wait for sync settings
   （telemetry 目标集来自 topic 路由表）；② topic 必须先于 `Start()` 存在——
   `autoCreateTopicEnable` 只救发送，不救启动期路由查询（TOPIC_NOT_FOUND）。
   因此 6 个 topic 是**部署期预建物**（mqadmin），不靠运行时自建。
3. **消费组语义**：新消费组会**重放全部保留历史**（实测）；空批次有两种错误形态
   （`MESSAGE_NOT_FOUND` 与 awaitDuration 到期的 `DEADLINE_EXCEEDED`），都不是
   故障。e2e 测试的隔离因此改为：独立 schema + 独立消费组 + 断言按本运行唯一
   event_key 前缀过滤（历史重放的外键事件属预期噪音）。

验收判据 1–6 已由 `internal/integration/rmq_e2e_test.go` 在真 PG（15432）+ 真
broker/proxy（8081）上全绿；判据 7（装配互斥）与判据 8（文档同步）在 Task 4/5。

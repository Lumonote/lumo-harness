# SessionEvent 日志冷层（冷转 MinIO）—— TDD 实现计划（P2a §4.2 收口）

**设计依据**：`architecture.md` §4.2（复制式日志）镜头 + §4.2 bucket 表（`session-log-{realm}`，
热层 Redis → 冷转 MinIO，保留期分级过期）；seam 远程形态设计 2026-08-26 §1 第 2/3 行；
`shared/seam-contracts/session-log.ts`（真相源是 PG、Redis 只读热缓存、Doris/MinIO 冷归档）。
上切片已就位：`@lumo/session-log`（PG 真源 + fencing 写者租约 + 分叉防护，18 用例绿）、
`@lumo/object-store`（`ctx.objectStore`，MinIO，写后可读强一致）。

## 定位与边界

复制式日志的**主体已落地**（PG 真源写路径）。本切片收 §4.2 的冷层：把已提交的
**PG 日志按 segment 归档进 MinIO**（对象存储 seam 的新消费方），并做**保留期分级过期**。

- **真相源仍是 PG**（契约已锁）：冷层是**归档副本**，不是第二个写入口、不是真相源。
- 冷层只读 PG 真源、只写 MinIO（经 `ctx.objectStore`）；不做回溯写回。
- **本切片外**：Redis 热缓存（§13.1：只读热缓存，读路径的缓存层，非本切片）；
  Doris 冷档（OLAP，随 Doris 进拓扑，显式外）；按 realm 建桶（`session-log-{realm}`）
  是生产部署配置（同 standalone 单桶先例），本切片在配置桶内经 realm 前缀键隔离。

## 关键设计决策

**① segment 固化为「seq 区间上的事件组」**：段对象键 `<realm>/#/session-log/<session>/
<startSeq>-<endSeq>.jsonl`（`#` 视作固定层级注记——用 `joinRealmKey(realm, ...)` 拼，越狱
段仍拒绝）。一行为一条 LogRecord 的 JSON（按 seq 有序）。**段边界纯函数可导**（给定会话的
有序事件 + 最大段长 → 段区间列表）。

**② 内容寻址保幂等与完整性**：段对象键**不含内容指纹**，但每段附 `<sha256>.info` 侧车
（{sha256,bytes,startSeq,endSeq,items,archivedAt}）。归档**幂等**：同 `(session,startSeq,
endSeq)` 只写一次（先 stat，已存在且同尺寸/同摘要则跳过）。重放不会重复归档、不会漂移。
读侧取回首验 sha256 + bytes（与附件同套 digest 校验——弄错内容是审计事故，不是功能 bug）。

**③ 归档推进记录在 PG（`session_log_archive` 表）**：`(session_ref, start_seq, end_seq,
object_key, sha256, bytes, items, archived_at)`。作用：
- 推进水位——下次扫描只处理未归档段；
- 保留期过期的依据（`archived_at`）；
- 与交付侧对拍（对象在 MinIO，行在 PG——两侧可核对）。

**④ 保留期分级过期**：`Hot → 保留在 PG`；`Cold = 已归档且仍在保留期 → 保留在 MinIO`；
`Expired = 超过保留期 → 删 MinIO 对象`。过期决策是纯函数（`retentionOf(tier, now)` 依
`archived_at` 判段当前 tier）。MinIO 生命周期策略是部署向的加速，平台侧至少给出可调用的
过期清理 seam（列出已过期段对象 → 删对象 → 清 PG 归档行）。

**⑤ 最小写入面**：本切片交付**契约 + archiver（PG→MinIO）+ 过期清理 seam**，接
`ctx.objectStore`。不碰 `session/event` 事件线（那是写路径，已落地）；archiver 面向已提交
数据，独立触发（进程内调度器扫末归档段——镜像 metering-outbox 先例，不做新调度器）。

## 判据（红→绿）

1. 段边界纯函数：有序事件 + 段长 → 段区间列表（首尾正确、无缝、唯一）。
2. 段序列化：`serializeSegment` / `parseSegment` 往返；JSONL 逐行；坏行拒（段损坏）。
3. 归档幂等：归档一遍后重跑，扫描水位不重复写同对象（stat 跳过）；MinIO 上对象唯一。
4. 完整性侧车：读出段对象 → sha256 + bytes 与 `.info` 对拍；对象字节被改 → CORRUPT。
5. 保留期决策纯函数：`hot / cold / expired` 三分正确（临界时刻边界用例）。
6. 过期清理：过期段对象被删、PG 归档行被清；未过期/在保留期不动。
7. 后端不可达 fail closed（铁律 21）：MinIO 不可达 → 归档/清理抛 `capabilityUnavailable`，
   不静默当成功。
8. compose 冒烟：真 MinIO + 真 PG 全链（写入→归档→读回首验→过期清理）。

## 测试命令（真依赖）

```bash
cd platform
# 契约（纯函数，无依赖）
npx vitest run shared/seam-contracts/__tests__/cold-log.spec.ts
# archiver + 过期（需真 PG 15432 + 真 MinIO 19000）
STORAGE_TEST_DSN='postgresql://lumo:lumo@127.0.0.1:15432/lumo' \
OBJECT_STORE_TEST_ENDPOINT=127.0.0.1:19000 \
OBJECT_STORE_TEST_CREDS=lumo:lumo-minio-123 \
npx vitest run shared/seam-contracts/__tests__/cold-log.spec.ts dsh-plugins/session-log/__tests__/cold-archive.spec.ts
```

## Files

- 契约：`platform/shared/seam-contracts/cold-log.ts` + `__tests__/cold-log.spec.ts`
- 实现：`platform/dsh-plugins/session-log/src/{cold-log.ts,archive.ts}` + 扩展 `index.ts`
  （提供 `ctx.coldLog` 归档/过接口——注意 readonly 读 PG、写 MinIO，不占写者租约）
- 测试：`platform/dsh-plugins/session-log/__tests__/cold-archive.spec.ts`（真 PG + 真 MinIO）

## Task 拆分

- [ ] Task A：设计+计划提交（本文件）
- [ ] Task B：契约 红→绿（段边界/序列化/保留期纯函数）
- [ ] Task C：archiver + 过期 红→绿（PG→MinIO 幂等归档、侧车校验、过期清理；fail closed）
- [ ] Task D：compose 冒烟 + 文档收账（architecture §4.2 实现注记 + README + seam 设计第 2/3 行 + 计划勾）
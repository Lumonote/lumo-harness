# PG KV 后端 + 附件 MinIO Provider —— TDD 实现计划（P2b 项 12 / 项 10）

**设计依据**：`docs/superpowers/specs/2026-08-26-object-store-design.md` §1（项 10/12 显式外，
独立切片）；seam 远程形态设计 §1 第 10/12 行；`architecture.md` §5.1（PG→`ctx.datastore.sql`、
MinIO→`ctx.datastore.object`）。
**排序依据**：seam 远程形态设计 §3 P2b——「对象/数据 seam 收敛是『一条真相源』的机械动作」。
**前置切片**：对象存储 seam（项 11）已落地——`ctx.objectStore`（`@lumo/object-store`）与
`shared/seam-contracts/object-store.ts` 的键规则/内容寻址派生可复用。

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读。本切片两项都走「继承公开接口，不改源码」：
- 项 12 镜像 dsh 的 `@deepseek-ai/dsh-storage` 接口（`StorageBackend`/`KvFacet`/`KvUnit`），
  在平台侧给出 PostgreSQL 实现（对应 dsh 的 `storage-sqlite`，同一套共享契约语义）。
- 项 10 继承 dsh 的 `AttachmentStore` 抽象类 + 复用 `@deepseek-ai/dsh-attachment-local`
  的**纯件**（`prepareImageFile`/`validateImageFile`，负责校验/归一化，不触存储），只换存储底座。

**真依赖测试**：
- 项 12：`STORAGE_TEST_DSN`（standalone PG 15432，同行所述真依赖惯例）未设置则 skip 且
  skip 可见；按 schema 隔离（镜像 `metering/__tests__/pg-schema.ts`——五条共享契约各有独立
  schema，`reopen` 同一 schema 模拟进程重启）。
- 项 10：`OBJECT_STORE_TEST_ENDPOINT` / `OBJECT_STORE_TEST_CREDS`（standalone MinIO 19000）未设置
  则 skip；按 run 独立 realm（复用对象存储 seam 的共桶前缀隔离）。

测试命令：
- 项 12：`cd platform && STORAGE_TEST_DSN=postgres://lumo:lumo@127.0.0.1:15432/lumo ./node_modules/.bin/vitest run dsh-plugins/storage`
- 项 10：`cd platform && OBJECT_STORE_TEST_ENDPOINT=127.0.0.1:19000 OBJECT_STORE_TEST_CREDS=lumo:lumo-minio-123 ./node_modules/.bin/vitest run dsh-plugins/attachments`

---

## Task 1: 设计 + 计划（本文件）→ 提交

## Task 2: 项 12 —— PG KV backend（红 → 绿）

**Files**：Create
`platform/dsh-plugins/storage/{package.json,src/{schema.ts,unit.ts,index.ts}}`；
Create `platform/dsh-plugins/storage/__tests__/{pg-schema.ts,pg-backend.spec.ts}`

- [ ] `schema.ts`：`STORAGE_PG_SCHEMA_VERSION` + `storage_meta`（单行版本戳，PG 无
  `PRAGMA user_version`）+ `units`/`unit_globals` 元数据表 + `recordTableName`（`u_<unit>_<table>`）。
- [ ] `unit.ts`：`PgKvUnit implements KvUnit`——每原语单语句（upsert/delete/select 原子）；
  值存 `TEXT` JSON，读回 `JSON.parse`（坏 JSON → `malformed-medium`，与 sqlite 逐语义一致）。
- [ ] `index.ts`：`PgStorageBackend implements StorageBackend`（`kv` facet）+ `apply`
  注册 `ctx.storage.backend` 为 `'pg'`（`inject=['storage']`，镜像 storage-sqlite）。
- [ ] 判据：共享契约 5 条（空单元/耐久往返/覆盖删除幂等/版本不匹配拒/close 后拒）+ PG 特有
  （非法名/双开/重开/原型污染键/malformed-medium/注册+dispose）。
- [ ] 提交：`feat(storage): PG KV 后端——ctx.storage 收敛到 ctx.datastore.sql（P2b 项 12）`

## Task 3: 项 10 —— 附件 seam 契约 + MinIO Provider（红 → 绿）

**Files**：Create `platform/shared/seam-contracts/attachment.ts` + `__tests__/attachment.spec.ts`；
Create `platform/dsh-plugins/attachments/{package.json,src/{minio-attachment-store.ts,index.ts}}`；
Create `platform/dsh-plugins/attachments/__tests__/{minio-helper.ts,attachment-store.spec.ts}`

- [ ] `attachment.ts` 契约纯函数：附件引用 `sha256:<64hex>` 校验 + `attachmentObjectKey`
  （= `joinRealmKey(realm, content/<hex>)`，复用对象存储键规则）——引用一律对象键，禁止代理。
- [ ] `minio-attachment-store.ts`：`MinioAttachmentStore extends AttachmentStore`——复用
  `prepareImageFile`/`validateImageFile` 校验+归一化；写走 `ctx.objectStore.put`（内容寻址键）；
  读走 `ctx.objectStore.get` + digest 校验 + byteLength 校验；缺对象 `ATTACHMENT_NOT_FOUND`、
  digest 不符 `ATTACHMENT_CORRUPT`、不可达穿透 `capabilityUnavailable`（铁律 21，不降级）。
- [ ] 判据：save→ref 是对象键/同内容同键幂等；read 取回并 digest 校验；realm 隔离；缺对象
  undefined→NOT_FOUND；不可达 fail closed。
- [ ] 提交：`feat(attachments): 附件 seam 契约 + MinIO Provider——ctx.attachments 对象化（P2b 项 10）`

## 收尾

- [ ] dsh 合规；TS 全量 + tsc；真依赖测试两处全绿记录
- [ ] 文档收账：architecture §5.1 实现注记 + README 已定案表两行 + seam 远形态第 10/12 行状态
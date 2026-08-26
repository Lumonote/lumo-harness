# 对象存储 seam + spillStore 收敛 —— TDD 实现计划

**设计说明**：`docs/superpowers/specs/2026-08-26-object-store-design.md`
**规范章节**：`architecture.md` §5.1（MinIO→ctx.datastore.object）
**排序依据**：seam 远程形态设计 §3 P2b（10/11 行的共同地基）

---

## Global Constraints

**第一铁律**：`deepseek-harness/` 只读（本切片实现 dsh 的 `SpillStore` 抽象类——
继承公开接口不改源码，合规）。

**真依赖测试**：`OBJECT_STORE_TEST_ENDPOINT`（standalone MinIO 19000）未设置 skip 且
skip 可见。测试桶每 run 独立前缀（realm 带 nanoid），不共享不清理。

测试命令：
- `cd platform && OBJECT_STORE_TEST_ENDPOINT=127.0.0.1:19000 OBJECT_STORE_TEST_CREDS=lumo:lumo-minio-123 ./node_modules/.bin/vitest run dsh-plugins/object-store`

---

## Task 1: 设计 + 计划（本文件）→ 提交

## Task 2: 契约（红 → 绿）

**Files**：Create `platform/shared/seam-contracts/object-store.ts`；Create
`platform/shared/seam-contracts/__tests__/object-store.spec.ts`

- [ ] 契约纯函数：键校验（相对键形状、realm 段越狱拒绝、非法字符）；sha256 键派生。
  （put/get 本体是 IO——契约层锁的是键规则与派生函数。）
- [ ] 提交：`feat(contracts): 对象存储 seam 契约——realm 键规则/内容寻址派生/能力缺失语义（§5.1）`

## Task 3: MinIO Provider + spill 收敛（红 → 绿）

**Files**：Create `platform/dsh-plugins/object-store/{package.json,src/{minio-store.ts,minio-spill.ts,index.ts}}`；
Create `platform/dsh-plugins/object-store/__tests__/{object-store.spec.ts,spill.spec.ts}`
（+ pg-schema 风格的 minio 测试助手）

- [ ] MinioObjectStore implements ObjectStoreSeam；realm 拼接与越狱拒绝；capabilityUnavailable。
- [ ] MinioSpillStore extends SpillStore：键派生/verbatim/bytes/locator/hint。
- [ ] 判据 1-6 对真 MinIO。
- [ ] 提交：`feat(object-store): MinIO Provider + spillStore 收敛——跨节点取回的溢出对象化（P2b 项 11）`

## Task 4: compose 冒烟 + 文档收账

- [ ] tsx 冒烟脚本对 compose MinIO（19000）全链：put/get/spill 取回。
- [ ] docs 三处：architecture §5.1 实现注记；README 已定案表（对象存储行）；seam 远形态
  设计第 11 行实现状态（不改 belongsTo——表约束）。
- [ ] 提交：`docs(object-store): P2b 项 11 收账——spillStore 对象化 + ctx.datastore.object 落地`

## 收尾

- [ ] dsh 合规；TS 全量 + tsc；compose 冒烟记录
- [ ] 设计说明 §5 判据 1-7 指到用例

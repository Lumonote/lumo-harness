# 对象存储 seam 设计说明 —— P2b 项 10/11 的地基：ctx.datastore.object（MinIO）+ spillStore 收敛

- 日期：2026-08-26
- 前置：`architecture.md` §5.1（MinIO→ctx.datastore.object，写后可读强一致）；seam 远程形态
  设计 §1 第 10/11 行（附件与溢出的归属是对象存储）+ §3 P2b 排序；铁律 21（能力缺失显式拒绝）
- 状态：设计说明（实现同步进行——本切片）

## 1. 定位与边界

P2b 的对象/数据 seam 收敛里，**`ctx.datastore.object` 是两行收敛（附件/溢出）的共同归属**——
先立 seam 本体，再接最小收敛件。本切片交付：

1. **契约**（`shared/seam-contracts/object-store.ts`）：realm 隔离的对象读写面；
2. **MinIO Provider 插件**（`dsh-plugins/object-store`）：注册 `ctx.objectStore`；
3. **spillStore 收敛**（远形态第 11 行全量）：MinIO 版 `SpillStore`——溢出内容对象化，
   跨节点 resume 任意节点可取回（本地 FS 版 `dsh-spill-local` 的平台替代）；
4. 真 MinIO 测试（standalone 拓扑 19000）+ compose 冒烟。

**显式外**：
- **AttachmentStore 的 MinIO 后端**（第 10 行）：dsh 的附件抽象是完整图像管线（校验/
  归一化/请求策略），直接换底座要重实现 dsh 内部件——先落 seam 与溢出收敛，附件后端
  待确认 dsh 可复用件后单独切片；
- **第 12 行（storage→datastore.sql KV）**：另一件机械收敛，独立切片；
- **第 8 行（web→连接器网关）**：connector-gateway 服务已在（2196 行），ctx.web 装配接线
  随 dsh-node 形态（P2）；
- 制品 bundle 存储（registry 已有自己的对象存储用法）——不改动。

## 2. 契约（TS）

```ts
interface ObjectStoreSeam {
  /** 命名对象写入。key 是 realm 内相对键（不得含 realm 段——Provider 负责拼接与校验）。 */
  put(realm: string, key: string, body: Buffer | string, contentType?: string): Promise<void>
  /** 内容寻址写入：key 由 sha256 派生（十六进制），同内容幂等同键。返回完整对象键。 */
  putContent(realm: string, body: Buffer | string, contentType?: string): Promise<string>
  get(realm: string, key: string): Promise<{ body: Buffer; contentType?: string } | undefined>
  delete(realm: string, key: string): Promise<void>   // 幂等
  stat(realm: string, key: string): Promise<{ bytes: number; etag?: string } | undefined>
}
```

- **realm 隔离在 Provider 执法**：调用方只给 realm 与相对键，Provider 拼 `realm + '/' + key`
  并**拒绝 key 里出现 realm 段越狱**（`../`、绝对路径、带斜杠前缀）。 realm 不是调用方
  可以「顺路」指定别人 realm 的自由文本——它是身份的一部分，装配层注入。
- **写后可读**（§5.1 MinIO 强一致）：put 返回即可 get——不需要 read-your-writes 之外的
  任何一致性话术。
- **缺对象 = undefined**（get/stat）：内容寻址键缺对象是完整性事故（调用方告警），命名
  对象缺对象是正常状态——契约不替调用方区分，但**不抛 404 异常**（undefined 让调用方
  用类型系统处理，异常留给真故障）。
- **能力缺失 fail closed**（铁律 21）：MinIO 不可达/未配置 → `capabilityUnavailable()`，
  绝不静默降级成本地临时文件——那是第二条真相源。

## 3. MinIO Provider（`dsh-plugins/object-store`）

- SDK：`minio` npm 包；单 bucket（`lumo-objects`，dev 由 compose MinIO 承载），realm 前缀
  分区（远形态设计原文：「与附件同桶隔离（realm 前缀）」）。
- 配置：endpoint/accessKey/secretKey/bucket/region + 可选 `realmOverride`（测试用）。
- **TTL 由桶生命周期管理**（远形态设计原文：「过期 TTL 由对象生命周期管理」）：溢出键
  带 `spill/` 前缀，部署期对前缀配 lifecycle 规则（compose dev 不配——保留期不限）；
  **不做每对象 TTL API**（MinIO 无此语义，伪造它会撒谎）。

## 4. spillStore 收敛（远形态第 11 行）

`MinioSpillStore extends SpillStore`（dsh 抽象类的平台实现）：

- 键：`<realm>/spill/<sessionId>/<sanitized>-<sha256 前 8>`——会话作用域分组（SpillOwner
  语义）+ 防碰撞后缀；**名字从 suggestedName 派生但不等于它**（dsh 契约原文：hint 非路径）。
- `saveText` 全文 verbatim 落对象（UTF-8）；`bytes` = Buffer 字节长度；`retrievalHint`
  指向对象 seam 取回方式；locator = 完整对象键（跨节点 resume 时任意节点经同一 seam 取回）。
- **存储失败即 reject**（dsh 契约原文）：MinIO 不可达时 saveText 抛 capabilityUnavailable，
  由 spill policy 决定降级（保持 inline 结果）——语义链完整。
- realm 来自插件配置（SpillOwner 无 realm 字段——装配层注入，同 metering 归因头哲学）。

## 5. 验收判据

1. put/get 往返（二进制与文本）；contentType 保留；
2. **realm 隔离**：realm-a 写的键，realm-b 读不到（undefined）；键含越狱段（`../`、
   绝对路径）被拒（invalid）；
3. putContent：同内容两次写同键（幂等）；键 = sha256 派生；
4. delete 幂等；get 缺对象 undefined；
5. **spill 收敛**：saveText → locator 是对象键、bytes 精确、内容 verbatim（含 NUL 与
   非 ASCII）、名字派生自 suggestedName 但不等、同 suggestedName 两次保存不碰撞；
   locator 经 objectStore.get 可取回（跨节点取回性的最小等价验证）；
6. MinIO 不可达 → put/saveText 抛 capabilityUnavailable（fail closed），不静默降级；
7. compose MinIO 冒烟：真实 19000 端点全链跑通。

> **判据 → 用例**：1—`__tests__/object-store.spec.ts`「put/get 往返」；2—「realm 隔离」+「键含越狱段被拒」；
> 3—「putContent：同内容同键幂等」；4—「delete 幂等；get/stat 缺对象 undefined」；5—`__tests__/spill.spec.ts`
> 「saveText…经 objectStore 可取回」；6—两文件「后端不可达」；7—`smoke.ts`（compose 冒烟全链）。

## 6. 风险与取舍

- **`minio` SDK 是新依赖**：平台首个对象存储客户端。选官方 SDK 而非裸 S3 REST：签名/
  分片/重试自担风险不值。版本锁进插件 package.json。
- **单桶 realm 前缀 vs 桶/realm**：远形态设计原文点名「同桶隔离（realm 前缀）」——
  单桶少管理面；越权防线在前缀执法（判据 2）而非桶边界。若将来要物理隔离，迁桶是
  可逆迁移（§22）。
- **SpillLocator 跨节点含义**：locator 是对象键的前提是「所有节点装配同一 objectStore
  配置」——standalone 单节点天然成立；cluster 形态该前提写进部署清单（helm 阶段）。

# 剩余能力续开发与验收（2026-11-07）

本记录接续 `62a43a7`，以当前代码和实际执行报告区分实现范围与外部验收。
本机专用 PostgreSQL、Redis、MinIO 及双 HTTP 节点只提供本地集成证据，
不替代真实供应商、物理多主机、外部身份源或生产密钥系统验收。

## 本批实现

### 新内容命名空间与引用生命周期

新增 `managed-content/v1` 隔离命名空间和 PG 对象、引用事实。
知识文件元数据与引用 pin/release 在同一事务提交，上传失败可显式补偿。
删除需同时满足保留期和释放宽限，默认仅 dry-run；显式启用后先持久化 deleting，
再调用对象存储。提交结果不明、迟到上传和未完成上传均不视为可安全重建或回收。
旧共享 `content/` 历史引用覆盖不足，继续禁止自动物理 GC。
配置严格接受范围内的非负整数，显式零保留值生效，错误配置不会静默使用默认值。
迁移为 025，详细合同见 [内容生命周期](managed-content-lifecycle-2026-11-07.md)。

### 持久恢复审批与执行回执

新增直接管理员双人审批、请求摘要、revision CAS、执行租约和递增 fence，
并接通管理页面、部署配置和受信 Provider 协议。执行前在事务锁内重验当前用户。
部署范围按 operation、realm、namespace、prefix 绑定；远端执行要求 HTTPS，
仅字面 loopback 地址允许 HTTP 本地协议测试。超时、签名错误和缺失回执记为 uncertain，
后续只核对原执行，不重新发起未知结果的操作。
迁移为 026，详见 [恢复协议](recovery-workflow-provider-2026-11-07.md)。
本批使用本地签名 Provider 替身，没有执行真实恢复或密钥销毁。

### 动态用户会话的执行代与跨副本路由

新增 PG 节点进程租约和会话执行租约。失租会永久封闭当前运行时并取消 Agent，
旧进程无法取得新代后继续使用旧内存状态。PG 日志提交同时校验进程、会话代和
writer，取得所有锁后以及可能等待的写入后再次读取库端时钟，过期整笔回滚。
跨 Web 副本只向静态批准且与当前权威事实精确匹配的 origin 转发；目标端独立验证
当前登录、项目、owner 和执行代，流与等待期间持续撤权检查。
迁移为 027，详见 [动态会话路由](dynamic-session-routing-2026-11-07.md)。
owner 与本地工作区仍固定在原节点，离线时不伪造自动迁移。

### 批准模型选择与计费准入

动态会话可显式配置最多 32 个批准的原生 provider/model 选择，浏览器只提交 choice ID、
策略摘要与日志序号。真空闲 maintenance 内二次 CAS、授权和费率校验后写入原生
model/selection 并 flush。运行时逐轮冻结选择，重启与完成轮次分支从日志恢复并复验
当前 allowlist。每次 provider 调用前，按服务器绑定的精确 route 取得启用费率快照，
未知、停用与缺预算均拒绝，结算继续归因真实 owner/project。
详见 [动态模型选择](dynamic-session-model-selection-2026-11-07.md)。

### 附件 Provider 的公开能力

MinIO 已补通用文件流保存/读取与图片请求变体。文件经受限临时 spool 计算完整 SHA，
按独立 file-content 键存储；读取检查 realm、声明长度和完整哈希。
图片复用上游公开转换函数，核对实际格式和尺寸，并执行请求像素/字节限制。
这些能力不返回宿主路径，也没有开放动态 owner 附件入口；该入口仍需持久上传授权和
分支引用的完整管线。file-content 未登记托管 GC，不能假定无引用后删除。
流接口使用官方 MinIO transport 传递取消信号，关闭实际 HTTP 请求；迟到响应流会销毁，
默认期限 60 秒，取消不承诺回滚已完成的对象写入。详细限额与边界见
[附件 Provider 合同](attachment-provider-capabilities-2026-11-07.md)。

## 验收记录

当前已取得两项真实 PG 全包 race 证据（均包含子测试）：

| 范围 | 通过 | 失败 | 跳过 | 本机报告 |
| --- | ---: | ---: | ---: | --- |
| Governance | 257 | 0 | 0 | `/private/tmp/lumo-governance-recovery-final-v2.jsonl` |
| Session-control | 257 | 0 | 0 | `/private/tmp/lumo-session-control-execution-final.jsonl` |
| 最终完整平台套件（233 文件） | 1998 | 0 | 0 | `/private/tmp/lumo-remaining-completion-final-20261107.json` |

平台套件使用真实 PG、Redis、MinIO 与 HTTP，包含真实 AgentLoop 恢复/分支、费率准入、
MinIO multipart 和图片请求变体。最终冻结版本还覆盖 7 项流取消单元回归及 4 项真实
HTTP stat/put/GET headers/GET body 取消与连接关闭，最终全量零跳过。
两个 Go 服务 vet/build、平台与 UI 类型检查、
UI bundle 和 Helm 具名工作负载/路由正反例门禁已通过。

## 保留的外部边界

真实模型供应商此前拒绝访问，尚无新的成功调用证据；实际 IdP、物理多主机故障、
生产数据库 HA/SLO、真实恢复目标与 KMS 均需相应目标环境。
页面组件/API 和构建验证不等于逐页浏览器视觉验收。
任意宿主工具、连接器副作用与历史未知交付物仍不能被封闭文本审核合同证明完整影响。

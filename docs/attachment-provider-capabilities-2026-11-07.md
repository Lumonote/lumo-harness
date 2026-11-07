# 附件 Provider 能力与动态 owner 接入边界

本批只补齐平台 `MinioAttachmentStore` 对上游公开 `AttachmentStore` 的存储能力，并收紧 Realm、资源和完整性检查。`deepseek-harness/` 源码只读，未补丁、未复制内部实现，也未开放新的浏览器上传或原始对象读取路由。

## 已实现的 Provider 能力

| 能力 | 当前行为 |
| --- | --- |
| `saveFile` / `saveFileStream` | 原始文件字节保留；按流计算 SHA-256；私有临时文件完成有界分段写入后上传 MinIO，不在内存中收集完整文件 |
| `readFileStream` | 校验当前 Realm、opaque 引用、显示名和大小；流式计数与 SHA-256 校验，完整消费至 EOF 才证明全部内容完整 |
| `saveImage` / `validateImage` | 复用上游公开图片准入与归一化 helper；与其他附件操作共用并发限额 |
| `readImage` | 强制当前 Realm，先限制引用的字节、尺寸和像素；按流检查字节与 SHA，使用上游公开 reader 核对实际媒体类型、宽高 |
| `readImageRequest` | 使用上游公开 `readRequestImageFile` 执行 exact target 的请求变体、variant identity、颜色空间、位深和 alpha 验证；临时派生缓存可重建 |
| Host 路径 | `fileHostPath` / `imageHostPath` 保持 `undefined`；临时路径不返回调用方或 Agent |
| Spill 辅助读取 | `MinioSpillStore.readBack` 只接受本 Provider 的 Realm 和 `spill/` 前缀 |

图片引用仍为 `<realm>/content/<sha256>`；泛文件引用为 `<realm>/file-content/<sha256>`。它们是 opaque 存储标识，既不是文件路径，也不是持有即可越权读取的 URL。显示名剥离两种平台的路径分隔符，不参与磁盘或对象键寻址。Provider 的 Realm 来自可信装配，不能由上传调用方选取。

泛文件默认最大 50 MiB，可配置 `maxFileBytes`，硬上限 1 GiB。附件默认同时执行 4 个操作，可配置 `maxConcurrentTransfers`，硬上限 16；单次默认 60 秒，可配置 `transferTimeoutMs`，硬上限 300 秒。所有准入配置必须为正的安全整数，错误配置直接失败。MinIO streamed object API 另有固定 60 秒操作上限，实际网络传输同时服从两层中较短的期限。

对象流接入为可选 seam：`putStream` / `getStream`。Provider 必须验证声明大小并支持取消，且 `getStream.body` 在首次消费前不能打开响应连接；调用方因元数据不符拒绝时不会遗留未消费连接。取消或提前结束消费要销毁已打开的连接。直接流式修改 `managed-content/v1/` 被拒绝，不能绕过托管内容生命周期。

## 取消、超时与内存边界

MinIO SDK 的 `init`、`statObject`、`putObject` 和 `getObject` 等等待均由平台约束。除结束调用方的等待外，平台通过 SDK 官方 `transport` 选项装配原生 HTTP(S)，将该操作的 `AbortSignal` 传到所有派生网络请求，使取消会销毁请求与连接。迟到返回的读取响应也会被销毁。平台自有 `Readable` 向 SDK 的 multipart pipe 目标转发源错误，防止已失败的输入留下等待中的分块消费者。

MinIO multipart 分块为 8 MiB，平台临时文件与网络源以 64 KiB 为默认读取粒度。原始图片受编码字节、边长和像素限制，归一化图片默认最多 4 MiB。图片 native codec 在有限像素内工作，无法在任意 CPU 指令处中断；槽位会保留到 native 工作真正结束，避免取消后仍并发启动无限编码工作。

取消不等于回滚。远端对象可能已经写入，或者服务端已经接受提交而本地尚未收到确认；超时后不返回有效附件引用，但不能据此断言对象不存在。私有临时文件会在操作结束清理。新泛文件与原图片 namespace 没有自动登记为托管内容，不能套用知识文件 GC 的删除承诺，也不能通过桶扫描推断引用关系。

## 尚未开放的动态 owner 上传流程

动态 owner 的 Session 入口仍只接受其当前已支持的文本动作。不能仅放宽 `textOnly()` 就宣称具备跨副本附件能力；尚需以下完整授权链：

1. 由平台持久保存上传 receipt、Realm、当前用户、项目、Session owner 与附件 opaque ID 的绑定。上游 `FileUploads.stagedFiles` 是 `WeakMap<Session,...>`，不能作为跨进程或重启后的授权记录。
2. 上传与下载都复验当前登录、项目访问、owner 和 Session 历史归属。上游 `session.attachment` 不保证任意传入 ref 属于该 Session，不能直接暴露给动态 owner 路由。
3. 使用独立、有限流量的上传入口与受信跨副本转发；当前认证 JSON 请求体上限 16 KiB，不应通过扩大所有认证请求或嵌入 base64 文件绕过。
4. fork 仅复制 completedPrefix 中已经消费的附件引用，与新 owner 和 seed 激活边界一致；不复制未消费 receipt 或在途上传。旧 owner 的不可见数据不得进入分支。
5. 无 hostPath 的泛文件不会自动成为模型可读内容。需要受限只读工具，参数只能引用当前 Session 已登记的 opaque ID，并在调用前后复验权限；不接受宿主路径、任意 URL 或执行上传内容。
6. 为新入口增加可审计、按文件类型受限的文本提取和独立生命周期登记。现有知识库 PDF/OCR/Office 提取尚不能直接当作所有 Agent 上传类型的通用隔离执行环境。

这些属于后续独立的应用授权与持久化开发，本批 Provider 能力验收不替代这部分验收。

## 验证入口

- `dsh-plugins/attachments/__tests__/file-transfer.spec.ts`：无外部依赖的字节、限制、取消、挂起源、并发、Realm 与损坏检查。
- `dsh-plugins/attachments/__tests__/attachment-capabilities.spec.ts`：真 MinIO，覆盖空文件、跨实例读取、9 MiB multipart、声明大小不符、缺失/篡改、请求图片 target、alpha、variant 与无 hostPath。
- `dsh-plugins/attachments/__tests__/attachment-store.spec.ts`、`object-store/__tests__/spill.spec.ts`：原图片与 Spill 回归，含跨 Realm 拒绝。
- `dsh-plugins/object-store/__tests__/stream-cancellation.spec.ts`：SDK 永不响应、迟到响应、默认期限、已打开 body 取消和提前结束消费。
- `dsh-plugins/object-store/__tests__/stream-cancellation-http.spec.ts`：实际 HTTP 的 stat、put、GET headers、GET body 等待时取消，观察远端连接关闭；通过现有 `LUMO_AUTH_PROXY_TEST=1` 门禁启用。

真 MinIO spec 缺少 `OBJECT_STORE_TEST_ENDPOINT` / `OBJECT_STORE_TEST_CREDS` 时明确 skip，不能将未运行当作通过。测试 `sharp` 版本与上游依赖版本可能发出 libvips 诊断警告；该警告本身不代表 Provider 故障，最终以测试断言与进程退出结果为准。

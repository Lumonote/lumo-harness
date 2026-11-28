# Lumo Desktop

这是 Lumo 的真实“本地单机”打包入口，不是服务器 `standalone` 的缩小版。

## 运行边界

桌面应用由 Rust/Tauri 壳启动本地 DSH Web worker，数据保存在系统应用数据目录：
`lumo.sqlite` 保存平台状态，`dsh/sessions` 保存对话日志，`runtime/skills` 保存安装的技能。
它明确设置 `LUMO_DEPLOYMENT_MODE=local`，并移除 PostgreSQL、Redis、
Nacos、MinIO 和连接器网关地址；因此本地模式不会因为机器上恰好运行了某个中间件而
偷偷切换成分布式模式。

启动页等待 Loader 装配完成后，由平台 UI 插件通过上游 `webserver/entry-url` 事件取得
允许自动打开的浏览器登录入口，再以 `0600` 权限原子写入壳指定的 `web-url` 握手文件。
入口由鉴权插件提供；没有浏览器入口或装配失败时不发布握手文件。升级 DSH 后需验证
这条握手链路；新版已将入口发布从 `connection.authenticatedUrl()` 移至上述事件。

**工作台打开后只有原生菜单。** 如果插件页点名 `@lumo/dsh-platform-ui`，并提示
`cannot get property "root" without inject`，失败的是当前页面的客户端激活。旧版 UI 用
`ctx.root ?? ctx` 取得根上下文，新版 Cordis 在读取左侧时就会抛错，后面的导航、工作台和主题都没有注册。
重新启用服务端插件或清理 SQLite 不会更新这个脚本。安装包含修复的新构建，完全退出旧进程后重新打开。
排查重复安装时，对照实际启动路径下 `runtime/node_modules/@lumo/dsh-platform-ui/lib/client.js`；
新构建的 `runtime-manifest.json` 记录 `workbenchClient.sha256`。生成安装包前会执行已复制的客户端脚本，检查导航、工作台、主题和样式。

| 形态 | 打包入口 | 存储 | 中间件 | 适用范围 |
| --- | --- | --- | --- | --- |
| 本地单机 | 本目录 Tauri | SQLite | 无 | 个人工作台、本机 Agent、离线技能 |
| 服务器单例 | `deploy/compose.standalone.yml` | PostgreSQL | Redis / MinIO / RocketMQ / Nacos | 单服务器团队服务 |
| 服务器集群 | `deploy/compose.cluster.yml` + Helm | PostgreSQL | Redis / MinIO / RocketMQ / Nacos | 跨用户委派、桌面节点、弹性调度 |

## 构建

在当前仓库查看已打包的本地版，可直接执行：

```sh
cd platform/upstream
./install-components.sh
cd platform/desktop
./preview-local.sh
```

`preview-local.sh` 会使用仓库内的 DSH 运行时启动本地应用，并将 SQLite 放到
`~/Library/Application Support/Lumo/lumo.sqlite`；如果 Web 前端产物不存在，它会先自动构建
`deepseek-harness/apps/web/dist/index.html`。也可以只构建应用包：

```sh
cd platform/desktop
cargo tauri build --debug --bundles app
```

macOS 构建结果位于 `target/debug/bundle/macos/Lumo.app`。Tauri 构建前会自动执行
`desktop/build-runtime.mjs`，把自包含 Node、DSH CLI、Web 前端、SQLite 后端和 Lumo 本地
插件放进 `Lumo.app/Contents/Resources/runtime`；因此解压后双击应用即可看到实际工作台，
不依赖当前 checkout、pnpm 或开发机上的 Node。应用数据和 SQLite 文件仍保存在系统应用
数据目录，且不连接服务器中间件。

隔离构建会排除覆盖层包的旧 `lib/`，并在每个 tsdown 阶段前重新编译对应的 TypeScript
产物。新增覆盖层包需登记到 `dsh-overrides/apply.mjs` 的 `overriddenPackageDirectories`；
同时包含主机与客户端代码的包使用 `tsconfig.host.json` 和 `tsconfig.client.json`，
桌面构建会分别编译两个配置，避免全新快照缺少 `lib/types/index.js`。

同一 checkout 的 runtime 构建共用 `platform/.build/desktop-runtime.lock`，从准备快照到
产物落盘期间只允许一个构建进程运行。重复启动会显示持锁进程的 PID 并退出，避免同时
清理、复制 `lumo-runtime/` 导致 `ENOTEMPTY` 或产物缺失。正常退出及可处理的中断会
释放锁；强制结束进程后若有残留锁，确认所有构建已停止，再删除该锁目录并重新构建。

Windows 使用同一个总入口，在 Git Bash 中执行：

```sh
./platform/build.sh --targets win-x64
```

也可以在 Windows 构建机的 `platform` 目录执行 `pnpm run desktop:win`。构建需要 Rust
MSVC 工具链、Node.js、Python 3.10+、Corepack 和 WebView2；产物位于
`platform/desktop/target/release/bundle/nsis`。Windows 只出 NSIS：runtime 约 1.3GB，
WiX `light.exe` 生成 CAB 会失败，NSIS 可正常打包同一份 payload。
这两个 Windows 入口共用 `build-windows.mjs`：先由 `tauri build --no-bundle` 准备
runtime 并编译，再由 `tauri bundle --bundles nsis` 生成安装包。官方下载遇到
HTTP 408/429/500/502/503/504 时，仅重试打包，最多三次，间隔 5 秒和 15 秒；
编译错误、摘要校验失败及 NSIS 脚本错误直接退出。工具仍由 Tauri 官方下载和校验，
保存在 `target/.tauri/`，release 按 Windows 架构及实际 Tauri CLI 版本缓存该目录。
Windows 包内使用 `runtime/lumo-runtime.cmd`、`node.exe` 和 `python/python.exe`，运行时不依赖
当前 checkout 或开发机上的 Node。

下载体积与安装占用需分开核对：DMG/NSIS 压缩运行时，展开后还包含 Node、Python、插件与技能素材，
大量小文件也会产生额外分配开销。可用 `python3 platform/desktop/audit-runtime-size.py /path/to/runtime`
从仓库根目录只读统计；加 `--hash-duplicates` 核对大文件副本。跨平台原因、历史样本和优化边界见
[安装体积排查](../../docs/desktop-installation-size-audit-2026-11-09.md)。

### 有证书与无证书打包

两种方式均可生成完整桌面安装器。无发行证书包的文件名及 artifact 名带 `unsigned`；
macOS 使用本地 ad-hoc 签名，包含 CUA helper，不执行 Developer ID 签名或 Apple 公证；
Windows 不执行 Authenticode 签名。系统可能提示无法验证开发者或未识别的发行者。

本机构建默认 `LUMO_RELEASE_SIGNING_REQUIRED=0`，不要求发行凭据。
要明确生成无证书包并隔离继承的 Apple/CUA 签名配置，在仓库根目录指定：

```sh
LUMO_RELEASE_SIGNING_MODE=unsigned LUMO_RELEASE_SIGNING_REQUIRED=0 ./platform/build.sh --targets darwin-arm64
# Windows 构建机的 Git Bash 使用相同入口
LUMO_RELEASE_SIGNING_MODE=unsigned LUMO_RELEASE_SIGNING_REQUIRED=0 ./platform/build.sh --targets win-x64
```

GitHub Actions 的 `release` 工作流提供 `signing_mode`：`auto`（默认）按每个平台的输入独立选择，
没有该平台的任何签名输入时构建无证书包，全部完整且有效时签名，只配置部分或输入无效时失败；
`signed` 强制完整凭据；`unsigned` 明确忽略证书并构建无证书包。
推送正式 tag 时通过 Repository variable `LUMO_RELEASE_SIGNING_MODE` 选择相同三种模式，未配置时为 `auto`。
无证书模式同样执行正式 tag 的完整基础 CI、集群验收和三平台桌面构建，统一使用本次选定的 upstream SHA。
CI 的证书获取方式、Secret 字段和临时凭据清理见[CI 发布合同](../../docs/ci-release-contract.md#桌面签名模式与凭据)。

### 有证书签名与公证

本机有证书构建设置 `LUMO_RELEASE_SIGNING_MODE=signed` 和 `LUMO_RELEASE_SIGNING_REQUIRED=1`，
`before-build.mjs` 在昂贵构建前校验凭据，缺失时明确失败。

Mac 使用已有、已解锁 Keychain 内的 Developer ID Application 证书与 notarytool profile：

```sh
export LUMO_RELEASE_SIGNING_MODE=signed
export LUMO_RELEASE_SIGNING_REQUIRED=1
export LUMO_MACOS_SIGNING_IDENTITY='Developer ID Application: Your Company (TEAMID1234)'
export LUMO_CUA_SIGNING_IDENTITY="$LUMO_MACOS_SIGNING_IDENTITY"
export LUMO_MACOS_NOTARY_PROFILE='lumo-release'
# 使用独立 keychain 时，两处必须指向同一个绝对路径
export LUMO_MACOS_SIGNING_KEYCHAIN='/absolute/path/release.keychain-db'
export LUMO_CUA_SIGNING_KEYCHAIN="$LUMO_MACOS_SIGNING_KEYCHAIN"
./platform/build.sh --targets darwin-arm64
```

`make-dmg.sh` 自动从内到外签名 Mach-O 与嵌套 bundle，验证 helper 的 Developer ID、Team ID、
hardened runtime 和时间戳；helper 已在其官方构建器中签名，不再改动内容寻址包。
随后提交应用 ZIP 公证、只接受明确 `Accepted` 回执、staple 应用并做 Gatekeeper 校验，
生成 DMG 后再签名、公证、staple 和校验。Node 的 JIT/原生扩展所需 entitlements 单独提供，
没有给所有宿主二进制统一放宽。失败的命令不会输出签名/公证凭据诊断。

Windows 使用 `CurrentUser\\My` 内已导入、有效且含私钥和代码签名用途的证书：
设置 `LUMO_RELEASE_SIGNING_MODE=signed`、`LUMO_RELEASE_SIGNING_REQUIRED=1`、`LUMO_WINDOWS_CERT_THUMBPRINT` 和
`LUMO_WINDOWS_TIMESTAMP_URL`，可通过 `LUMO_WINDOWS_SIGNTOOL` 指定工具路径。
构建验证唯一当前 NSIS 产物，使用 SHA-256 摘要与 RFC3161 时间戳签名，再运行 Authenticode
验证。不接受 argv 上的 PFX 密码，也不会把本机证书导出到仓库。

有证书构建的应用公证/尺寸证据输出至 `target/release/release-evidence/<target>.json`。
两种安装器旁均有 `*.release.json`，记录实际签名状态、最终 SHA-256、下载字节、runtime 大小与版本，
以及平台/upstream 提交身份。无证书包记录 `signing.status: "unsigned"`、`signing.certificate: false`；
Mac 另记录 `notarization.status: "not-performed"`。有证书构建包含公证或签名回执。
这些脚本提供发行门禁；没有真实证书、Apple 服务及全新系统安装的成功证据时，不能宣称已完成实机验收。

### 运行时尺寸门禁与 Python 去重

每次 runtime 构建都会生成 `target/runtime-size/<target>.json`，记录版本、当前仓库与上游 SHA、
文件数、链接数、内容/独占 inode 字节、可用时分配字节和顶层组件占用。它不跟随链接统计，
也不把 APFS clone 共享块当作已证实的可回收空间。
`runtime-size-budgets.json` 提供三平台的 2 GiB内容上限和组件上限；文件上限按2026-11-10
首次暂存产物各加10%余量校准：Windows 99,561、Mac ARM64 98,626、Mac Intel 97,911。
来源与原始报告见[CI合同](../../docs/ci-release-contract.md#三平台文件数预算的实测校准2026-11-10)。
该测量不证明安装器成功，也不承诺瘦身。设置 `LUMO_RUNTIME_SIZE_BASELINE=/path/previous.json`
可对同平台历史报告执行内容和文件数至多增长 10% 的门禁；目标不一致或报告畸形会失败。
需要调整绝对预算时，显式指定 `LUMO_RUNTIME_SIZE_BUDGET` 或审阅提交默认预算修改。
失败报告仍保留，CI 应上传，不以删除报告消除失败。

Python 复制只在 Mac 保留目标仍在包内、会被复制的相对文件链接；包内绝对链接和目录链接
实体化，包外链接、循环和包外残留链接拒绝。复制工具仅在调用者显式提供 `externalRoots` 时允许对应
外部树并实体化；桌面构建不开放任何外部树，嵌套链接仍检查边界。Windows 为 NSIS 兼容继续实体化。复制结果验证相对链接可重定位，
搬迁后执行入口已用独立进程 fixture 验证；实际 Tauri/DMG 搬迁保留链接、PPT/PDF 导入与签名仍需
三平台安装产物核对。PPT 图标和本地推理继续完整交付，未在没有消费支持时自动归档或删除。

## 桌面基础插件

### 电脑操作

本地侧边栏「电脑操作」管理当前对话的桌面控制授权、占用状态和立即停止。先在插件页面
启用官方 Computer Use，使用 PTC 对话，再允许当前对话操作电脑。系统权限和逐应用授权
继续使用官方界面；打开状态面板不会触发系统授权。授权默认关闭，重启后重新确认。

目前原生 Provider 支持 macOS 14 及以上。macOS 构建会使用官方 Swift 脚本准备 release helper，并验证
架构、内容摘要和签名；构建机需要 Xcode/Swift 和 Python 3，最终用户无需安装开发工具。
默认 ad-hoc 签名，可设置 `LUMO_CUA_SIGNING_IDENTITY` 和可选的
`LUMO_CUA_SIGNING_KEYCHAIN`；有证书发行模式完成 Developer ID 签名与公证，
无证书发行模式保留 ad-hoc。系统权限与实际电脑操作仍须各自验收。
Windows 可通过 `LUMO_WINDOWS_CUA=1` 显式加载隔离 Provider，仍需在面板授权当前会话；
构建使用 Rust Job Object supervisor 与固定版本原生 SDK，跳过 Swift。原生桌面输入与截图
仍需在已登录的 Windows 设备上按[验收说明](../dsh-plugins/computer-use/README.md#windows-原生桌面验收)实测。

同一轮 Agent 独占桌面，停止时等待原生调用结束后才释放，不自动重放动作。详细配置、
验证范围与远程 Bot 边界见 [本机电脑操作记录](../../docs/computer-use-2026-11-08.md)。

### 鲸鱼悬浮窗

桌面伙伴是与主窗口同时运行的独立透明悬浮窗，显示在操作系统桌面上。主窗口最小化后，
仍可点击鲸鱼打开助手、拖动改变位置；菜单栏／系统托盘的「显示桌面伙伴」可找回隐藏的桌宠。
默认置顶并在应用启动时显示，可在桌宠设置中调整；这里的「启动时显示」指随应用启动，
不修改操作系统的登录启动项。关闭整个应用会同时退出桌宠和本地 runtime。

收起时只显示对话首页同款的官方鲸鱼跃海动效，保留原始帧、比例和时序，使用清晰的蓝色点阵。
遵循系统的减少动态效果偏好。助手提供新建对话、
查看任务、打开工作台和消息草稿入口。草稿交接会创建独立会话，不覆盖已有会话的输入；
工作台确认接收后才清空桌宠输入框，失败则保留。发送仍在工作台中完成。

桌宠资源通过壳内置的 `lumo-pet` 协议加载，不依赖本地 Web 服务先启动。状态标签展示本地
runtime 的启动、就绪或失败；运行失败时可定位日志。位置与显示偏好保存在应用数据目录的
`desktop-pet.json`，重新连接显示器后会把窗口约束到可见工作区。

桌宠命令仅接受本地桌宠窗口调用，工作台无需远程 IPC 权限；草稿通过壳内存中的交接协议
传递，不写入 URL、桌宠偏好文件或日志。任务入口读取本机会话运行状态，支持搜索和继续对话，
不要求集群服务。开发与验收记录见
[桌面伙伴开发记录](../../docs/desktop-pet-2026-11-08.md)。

**自建云工作台。** 在「桌宠 → 设置 → 云工作台」保存团队已部署的 HTTPS 地址，例如
`https://lumo.example.com:8443`。每台机器最多保存 12 个入口，支持改名和移除。选择后点
「在浏览器打开」，使用该服务器自己的账户登录。这个入口不依赖本地 runtime 就绪，
也不转发本机的登录令牌、工作区或项目记忆；实际部署步骤见[集群部署说明](../deploy/README.md)。

**开发工具与项目记忆。** 展开桌宠，选择工作空间，进入「开发工具」。macOS 可以在系统终端
新建或继续本机已安装的 Claude Code、Codex 和 Gemini CLI。Claude Code 新建时自动关联 ID；
Codex 用 `/status`、Gemini CLI 用 `/stats` 查看完整会话 UUID，再点「关联已有会话」。同一项目可关联多个
会话，恢复时按工具和所选 UUID 打开；首次输入、工具审批及原生对话历史均由相应 CLI 管理。
终端接受打开请求不代表 CLI 已登录或开发任务已完成。

进入面板会检查本机标准安装目录，也可点「重新检测工具」。未找到程序或当前平台不支持时，
只禁用对应启动操作，仍可关联会话、保存目标和导入记录。「筛选关联会话」可按备注名或部分 UUID 查找，
也可查看已归档会话。置顶和归档仅作用于此项目下所选工具的会话；归档保留导入历史，不停止原生终端，恢复后可继续同一 UUID。

项目目标、补记、会话关联和工具操作历史都保存在应用数据目录的 `development-memory` 下，
按工作区 ID 分开，重启后可继续读取。选择一个已关联会话，可导入它的 UTF-8 `.md` 或 `.txt`
记录（单文件最多 256 KiB）；全文及其来源会保留，重复导入相同版本不会增加条目。Lumo 不自动扫描
原生 CLI 的私有对话。「复制项目上下文」包含当前目标、全部长期记忆、最近 12 条记录摘要、最近一次开发笔记全文，
以及每个编码助手各自最近导入的一份交接全文。更早的记录仍可在项目历史中查看。

需要只带出部分内容时，展开「选择内容并交接」，勾选已保存的目标、长期记忆条目，或当前
所选会话最近一次导入的记录。点击「预览交接内容」核对完整 Markdown，再点「复制已预览内容」。
复制时会重新核对所选内容；目标、记忆或导入记录有变化时需重新预览。改变选择或切换项目会
清空预览。未勾选的记忆、补记、编辑器笔记和其他会话记录不会被带入这个交接内容。

「长期记忆」按项目保存协作偏好、反馈、项目约定和参考资料。每条可改名、编辑或移除；
下次复制上下文或向编辑器交接时使用当前内容。每个项目最多 64 条，每条正文最多 4000 字节。
「会话备注名」只改变 Lumo 的显示名称，清空即可恢复显示 UUID；搜索项目历史可匹配正文、
工具名和会话备注名，包括尚未展开的旧记录。分类和命名交互参考了 Gugu 的
[`assistantMemory.ts`](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/packages/core/src/shared/assistantMemory.ts)
和 [`renameSession.ts`](https://github.com/GUYI-AI/gugu/blob/474319f38d9bc0cb80e90c08833d38c3f81f479b/apps/desktop/electron/session/main/core/sessions/renameSession.ts)。

编辑器支持打开工作区、交接开发笔记或定位项目内已有文件的行号。可选 VS Code、VS Code Insiders、Cursor，
macOS 还可选择 Trae CN 和 Zed。编辑器保存的「开发笔记.md」会在下次读取或刷新项目记忆时导入；
同目录的「项目上下文.md」由 Lumo 在交接时生成。工具需安装在本机标准位置。

**跨设备长期记忆同步。** 在「开发工具 → 跨设备同步」填写云工作台地址、该账户的访问令牌，
并启用同步。每个本机工作区都有可复制的 64 位「同步项目标识」；在另一台设备选择对应工作区，
填写相同标识，并使用同一云端账户，即可合并两端的长期记忆卡片。本机工作区 UUID 和磁盘路径
可以不同。标识用于配对项目，不代替账户授权；目标、补记和原生 CLI 对话记录暂不参与同步。

每轮同步先通过服务器的 `/v1/memory-sync/identity` 核验账户。服务器、realm、账户、项目标识
分别隔离同步进度、冲突及待接收队列；同一账户换发令牌不会清空基线。切换范围保留各自状态，
本机记忆不会被清空，当前内容会与新范围合并。更换服务器且未重新填写令牌时会清除旧令牌，
避免把它自动发往新地址。旧服务器缺少账户验证接口时会明确要求升级。

本机最多保存 64 条卡片；超出容量或暂时不能解析的云端内容会进入持久待接收队列，界面显示
「待接收」，释放容量后下一轮会重试。重启保留队列，新版本和删除墓碑优先于旧排队内容。
同步期间修改配置会终止旧轮次，已发出的远端请求可能已完成，但迟到响应不会写入新范围。

普通同步采用增量游标；首次验证的新范围会完整对齐，其后每 24 小时在下一次成功同步时再次完整
对齐，也可点击「完整对齐」立即发起。界面显示上次完整对齐时间。此机制可以发现同一服务器地址
恢复旧数据库后丢失的记录，不依赖序号是否降低：缺失的本机卡片会重新提交，删除意图会重建墓碑；
同 ID 的不同内容保留为冲突，不自动覆盖本机。原冲突或待接收记录与恢复后的云端不同时，旧内容
转存为冲突中的「已保留版本」，可选择本机、当前云端或某个已保留版本；选择后需再次同步提交。
待提交的选择和已确认的云端内容指纹会持久保存；重启、增量重拉或完整对齐不会撤回已作出的选择，
云端内容再次变化时才会要求重新处理冲突。

完整对齐从游标 0 分页读取，单次最多 20 页（服务器每页上限 500 条）；未收齐时本轮不应用内容、
不判定记录缺失，也不更新完整对齐时间。达到上限需缩小云端项目数据量后重试。服务器恢复后的
修复保证发生在下一次成功的完整对齐，前提是应用运行且服务器可访问；关闭应用、网络故障或扫描
未完成时不会检测恢复。正常令牌换发不会触发额外全量扫描。
旧版 `sync.json` 原样保留；首次升级从零核对远端，不把缺少账户信息的旧游标视为可信基线，
本机此前删除但云端仍存在的条目进入冲突确认。

原生「自动化任务」来自 `@deepseek-ai/dsh-experimental-schedule-bundle`，随 DSH 打包，
在「扩展」中启用后由 `ui-schedule` 注册侧边栏菜单；它是可选扩展，默认关闭。
原生「智能体团队」同样可按需启用。平台团队使用 `lumoAgentTeams` 服务，
原生团队使用 `agentTeams` 服务；两者分别注册，平台协作页面读取前者。

历史对话支持「全部对话」和「按工作区」两个直接入口。全部对话展开跨工作区的会话列表；
归档规则保持不变。切换工作区或视图不会移动、删除会话文件。旧版 `session.jsonl.zstd`
和新版 `session.v2.jsonl.zstd` 可以并存，读取时由 DSH 格式迁移链恢复；诊断日志必须读取
完整的多帧 Zstandard 数据，单次解压得到的首帧只有会话头部，不能据此判断内容丢失。

专家包安装后只提供一个「用于对话」命令。入口保留专家名称、职责和构成技能路径，
按任务选择相关技能。打开技能市场时会从本地已安装技能自动修复旧版多命令安装记录，
不要求重新下载；所有构成技能安装失败时，不再显示专家包安装成功。

可选插件装配失败时，启动器隔离出错插件后重试，并清除上一进程的工作台入口。
桌面启动页等待本次装配完成后取得鉴权入口；等待期间显示进度，失败时显示原因与日志位置，
不会再因入口等待超时跳到未鉴权页面。

技能中心依赖的 SkillHub CLI 在每次桌面构建中自动准备并打入应用包，用户无需另外安装
CLI 或设置 `LUMO_SKILLHUB_COMMAND`。构建从 [SkillHub 官方安装源](https://skillhub.cn/install/skillhub.md)
下载 `skillhub-pin.json` 固定的版本归档，校验预期 SHA-256 后缓存到
`platform/.build/skillhub/skillhub-<sha256>.tar.gz`，将 CLI 文件和
`runtime/bin/skillhub.mjs` 一起打包，复用包内 Node 和 Python。构建会在裁剪完成后执行
`--version` 和 `install --help` 校验；缺少任一依赖即构建失败。

归档默认依次尝试两个同源地址（`cos.ap-guangzhou` 与 `cos.accelerate`）：只试一个地址时，
共享 CI runner 偶发的 DNS 解析超时会直接判成构建失败。对应的连接类重试预算约 4 分钟，
404 一类永久性错误则立即换下一个地址。可用 `LUMO_SKILLHUB_ARCHIVE_URLS`（逗号分隔，
优先在前）整体替换源列表。

离线构建可以设置 `LUMO_SKILLHUB_ARCHIVE` 指向预先下载的同版本归档，仍执行摘要校验。
升级应同时更新 `skillhub-pin.json` 的版本、地址和经过核实的摘要；删除缓存不会自动升级。
自建归档需显式提供 `LUMO_SKILLHUB_ARCHIVE_SHA256`（64 位十六进制），缓存与解包前均校验。
实际打入的 CLI 版本、归档 SHA-256 和**真正取到归档的地址**
记录在 `runtime/runtime-manifest.json` 的 `skillhub` 字段。技能下载仍需联网，安装目录继续使用
应用的数据目录。旧安装包缺少 CLI 时需要重新构建并替换应用，修改源码不会修复已安装的副本。

桌面 Rust 单测使用 `node platform/desktop/test.mjs`（仓库根目录）；离线可追加 `--offline`。
该入口加载 `tauri.test.conf.json`，使用受版本控制的静态资源并移除仅打包需要的 runtime 资源。
macOS/Windows 的普通 CI 都执行此入口；测试配置不参与正式打包。

桌面版在构建阶段固定并打包以下 DSH 基础插件，打开应用时直接从包内 runtime 加载，
不会在首次启动时访问插件仓库或依赖当前项目目录：

未发布 npm 的源码插件由 `tools/prepare-source-plugins.mjs` 在独立暂存目录构建。
Git DNS、连接中断和临时 HTTP 故障最多尝试三次，间隔 5 秒、15 秒；每次仍拉取同一
完整提交号，检出后再次核对 SHA。认证、缺失提交和编译错误直接失败。
release 按系统、架构、完整 Node 版本及构建输入缓存完整产物；命中后仍检查 fingerprint、
入口、生产依赖和资源目录，缺件则重建，失败不会将暂存目录标记为成功产物。

| 中文入口 | 上游包 | 版本 | 用途 |
| --- | --- | --- | --- |
| 插件市场 | `dshmarket` | `1.66.6` | 浏览和管理 DSH 插件 |
| 视觉理解 | `@liustack/modlens` | `3.26.5` | 图片读取、OCR 与视觉证据 |
| 上下文洞察 | `dsh-context` | `0.60.0` | 上下文组成、趋势与事件 |
| 费用统计 | `dsh-cost-meter` | `1.7.45` | 会话、预算、价格和历史费用 |
| 梦幻皮肤 | `dsh-dream-skin` | `9.29.0` | 主题、弥散光壁纸与每用户强调色（原生 `--dsw-*` 实现） |
| 任务看板（社区版） | `@linxin666/dsh-client-ui-task-board` | 基线未收录 | 旧版因等待 `settingsScope` 移出基线；外置版已更新到 `0.4.4`，移除了该直接依赖 |
| 多智能体团队 | `@nanmicoder/dsh-agent-teams` | `0.1.15` | 自然语言编排多智能体团队：船长/成员、带依赖任务与消息，Web 树状监控 |
| Univer 办公文档（社区版） | `dsh-univer-office` | `0.2.14` | 基线未收录：客户端半边与 master 代差过大，会在 web 启动期失败；可从市场自行安装 |

> 浏览器自动化（`@anweat/dsh-browser` 0.1.10）因依赖已被 dsh 现行版本移除的
> dsh-settings 旧导出，且上游无适配版本，暂不固定进桌面基线——市场页面也不展示。
>
> Univer 办公文档（`dsh-univer-office` 0.2.14）的 peer 只声明到 0.1.2-rc.1，曾在
> 0.1.6-alpha.2 的**浏览器半边**激活失败，boot 页停在
> `web boot: 1 entry did not activate / dsh-univer-office: failed`——整块工作台打不开。
> 这类失效构建期查不出来，故从桌面基线移除（依赖仍留可自行安装）。同时客户端启动已改为
> 尽力而为：单个插件导入失败、激活失败或缺少服务时跳过并在控制台记录原因，
> 不再把一个社区插件升级成整站停摆（见 `dsh-overrides/apply.mjs` 的 `LUMO_BEST_EFFORT_BOOT`）。
> 判断依据是 Loader 最终状态，包含没有发出状态变化事件的 `pending` 插件。失败条目保留，
> 服务恢复或插件重试后仍可激活；引导失败或界面渲染服务不可用时仍报告启动错误。
> 2026-09-30 查询到的办公插件 `0.3.5` 也未声明兼容当前 `0.2.0-rc.2`，因此没有升级外置办公插件。
>
> 任务看板（`@linxin666/dsh-client-ui-task-board`）旧版客户端把 `settingsScope` 写进了
> **硬 inject 列表**（`lib/client.js` 的
> `inject = ['slots','sessions','workspaces','connection','settingsScope','locale','remote']`）。
> 实测该条目在 web 装配里永远停在 `pending`，boot 页报
> `web boot: 1 entry did not activate / @linxin666/dsh-client-ui-task-board: pending
> (waiting for service: settingsScope)`。0.3.14（原 pin）与 0.3.20 形状相同，故移出基线。
> 2026-09-30 外置任务看板与远程 Web UI 已更新到 `0.4.4`，客户端代码不再直接引用
> `settingsScope`；任务看板暂未重新纳入基线。旧版提供 `settingsScope` 的
> `@deepseek-ai/dsh-client-ui-settings`（loader id `ui-settings`）自己 inject
> `remote` + `remote.settings`，且**只在 `apply()` 里**才构造该 Service —— 整条链是
> 「宿主 settings 域 → `remote.settings` → `ui-settings.apply()` → `settingsScope` → 任务看板」，
> 哪一环断的尚未定论，排查时别只看末端。

## 创作与多智能体组件

下列上游能力同样固定进项目，运行时使用中文名称，不会执行上游的全局初始化命令：

| 中文入口 | 上游组件 | 固定版本 | Lumo 内的边界 |
| --- | --- | --- | --- |
| 图像风格库 | `awesome-gpt-image-2` | Skill `1.0.4` | 在当前项目/空间内选择风格、模板和提示词结构 |
| 演示文稿生成 | `ppt-master` | Skill `5.1.0` | 生成、编辑和增强原生 PPTX；仓库预览使用隔离 Python 环境 |
| 多智能体编排 | `ruflo` | npm `3.38.20` | 仅编排单次 Lumo TaskRun 内的子智能体，不接管业务任务状态 |
| 架构与调度图 | `archify` | Skill `2.16.0` | 导出可验证任务、执行者、节点和运行状态图；图是只读视图 |

仓库运行时从 `platform/upstream/skills` 读取固定 Skill，并将 PPT 解释器指向
`platform/upstream/skills/ppt-master/.venv/bin/python`。桌面发布包会复制 Skill、Ruflo
依赖以及可重定位的 Python/PPT 依赖，并把解释器固定为包内
macOS 使用 `runtime/python/bin/python3`，Windows 使用 `runtime/python/python.exe`；如果构建环境没有准备 PPT `.venv`，打包会直接失败而不是生成
一个缺少实际功能的应用。所有组件的仓库、提交哈希和许可证记录在
`platform/upstream/skill-sources.json`。

OpenDesign 仍作为输入框下方的嵌入式创作面板提供；项目和空间选择器会把当前作用域
同步到该面板。桌面版浏览器插件默认不在构建时下载 Chromium，避免安装包被浏览器二进制
放大；首次真正执行浏览器自动化时，可由插件的浏览器安装入口准备本机浏览器缓存。

## 主题

界面皮肤优先由标准换肤插件 `dsh-dream-skin`（`9.29.0`）提供：高质感主题、弥散光壁纸与每用户强调色，走 DSH 原生 `--dsw-*` token 系统。
工作台右上角的界面主题选择器读取**主题服务当前注册的全部主题**（含该插件），因此
切到它的任何一个主题都会驱动整套 Lumo 工作台外观。

工作台自身另内置四套 Lumo 产品主题（`Obsidian Signal`、`Ember Foundry`、
`Orbital Glass`、`Infrared Grid`）作为兜底，它们都以深色中性底为基础，分别使用
信号橙、炉芯橙、冰蓝和红珊瑚作为单一强调色。这些主题与 `dsh-dream-skin` 共用同一
token 契约，可并存而不冲突；不依赖服务器中间件，也不会把本地模式变成集群模式。

调试版和正式包都优先使用包内对应平台的 `runtime/lumo-runtime.sh` 或
`runtime/lumo-runtime.cmd`；只有开发预览才回退到 checkout 中的 `local-runtime.sh` 或
`local-runtime.cmd`。如果包内资源损坏或缺失，诊断页会明确显示启动错误。
正式安装包会把本地 runtime 的 stdout/stderr 追加写入系统应用数据目录的 `runtime.log`；
如果双击后出现白屏，可先查看该文件（通常位于 `~/Library/Application Support/io.lumo.desktop/`），
再根据其中的架构、端口或前端加载错误处理，而不必从 Finder 猜测原因。

## 启动过程与菜单栏

### 本机接入分布式服务器

从「环境与连接」进入「本机接入」，点击加号，填写设备网关、Realm、设备 ID、一次激活码与本机发布者信任文件路径。网关必须是 HTTPS origin；信任文件须由管理员通过独立渠道提供，格式与 Registry 的 `publishers` 信任表相同。设备策略和制品集合仍由服务器批准，向导不会从网关自动导入发布者公钥。

「运行器与证书」可填写私有网关 CA、已配置的任务运行器 Unix socket、策略批准的客户端版本，以及允许启动的精确 `sha256:` 制品摘要。摘要列表默认为空；没有单独配置运行器时不会接受 `execute_task`。连接后，仍应到服务器工作台「协作执行」通过受管任务委派使用设备，不能把任意 ACP shell、环境变量或模型参数当作设备任务发送。

激活由现有可信本地桥调用桌面原生确认框（macOS/Windows），受管 `desktop-agent` 使用出站 HTTPS/WSS 和设备证书连接网关。浏览器不会得到设备私钥、证书正文或桥接 token；远端工作台始终在隔离的系统浏览器中打开。网关地址与工作台地址可以不同。

状态由受管进程、匹配 PID 的状态文件、30 秒内的网关回报与有效证书共同判定。进程刚启动不会显示已连接；断线、过期证书、应用重启遗留的状态也不会显示在线。证书续签由现有 agent 执行。激活失败后可在进程停止时「更新激活码」重试同一设备。

- 「暂停接单」先写私有控制文件，设备立即拒绝新的执行类命令；下一次心跳（最多约 10 秒）撤下可调度状态。已接任务继续完成，取消命令仍可处理。
- 「恢复接单」恢复控制文件；进程停止时重新启动，等待网关确认后才显示在线。
- 「退出本机接入」经本机确认后停止进程并删除本机设备私钥与接入配置，保留任务回执。它不冒充服务器撤销；服务器设备记录仍需管理员在设备管理中撤销。
- 关闭桌面应用也会停止受管设备进程。重开应用后从环境页明确重新连接。

接入配置在应用数据目录 `managed-device/connection.json`；每个网关/Realm/设备组合使用独立目录保存私有身份、状态和日志。一次激活码仅作为私有输入文件交给 agent，身份加载完成后删除，不写入持久配置或日志。

环境页与桌宠统一读写应用数据目录 `server-book.json`。首次使用时合并原浏览器地址簿与旧桌宠地址；相同 origin 保留原生记录，保存成功后才清理浏览器旧记录。普通浏览器仍使用自己的 localStorage。地址簿仅保存名称与 origin，HTTPS 或回环 HTTP，损坏文件不会被空列表覆盖。

桌面打包会由 `build-device-agent.mjs` 将已有 Registry `cmd/desktop-agent` 编译进 `runtime/bin/lumo-desktop-agent`（Windows 为 `.exe`），构建机需要 Go 1.25，用户机器无需 Go。开发模式可先运行：

```sh
node platform/desktop/build-device-agent.mjs
```

开发输出在 `platform/.build/lumo-desktop-agent`；可用 `LUMO_GO_BINARY` 指定构建工具链绝对路径。发布打包按 `darwin-arm64`、`darwin-x64`、`win-x64` 选择目标。代码和本机故障测试不代表真实服务器已部署或批准该设备；远端验收需要实际网关证书、设备策略与一次激活码。

窗口在壳启动的瞬间就会出现，先显示内置的启动页（`desktop-assets/boot.html`），
runtime 在后台线程里拉起；本地 Web 端口一应答，窗口就切到真实工作台。启动页会实时
显示已等待秒数和 `runtime.log` 的路径。runtime 在 120 秒内没有就绪或提前退出时，启动页
会原地切换成失败态，把具体原因（例如 `本地 DSH runtime 提前退出：exit status: 1`）显示出来，
不再是一个黑窗口。

`lumo-runtime.sh` 启用了 Node 的磁盘编译缓存（`NODE_COMPILE_CACHE`，落在应用数据目录的
`runtime/compile-cache`），第二次以后的启动直接复用字节码。

应用在菜单栏有一个模板图标（亮/暗菜单栏自动着色），菜单项为「显示 DeepSeek Harness」
「查看运行时日志」「退出 DeepSeek Harness」。关闭主窗口、菜单栏的「退出 DeepSeek Harness」
或 ⌘Q 都会退出应用，并一并结束本地 runtime；若只想重新打开窗口，可重新启动应用。

## 图标

图标源是 DeepSeek 原生鱼形标志（上游 `packages/client/ui-primitives` 的 FishLogo 路径），
`icons/deepseek-logo.svg` 是唯一品牌源：既画应用图标也画菜单栏剪影与启动页徽章。

macOS 的 `make-icons.sh`（`beforeBuildCommand` 里会先跑它）用宿主自带的 `swiftc` 与 `iconutil` 生成。
Windows 直接使用仓库中的 PNG 图标，不依赖 bash、Swift 或 macOS 工具。
生成器解析 SVG 里的 `d` 路径（ImageIO 不解码 SVG，CoreGraphics 只认 CGPath），同一路径既画应用图标
也画菜单栏剪影：

- `icons/icon.png`：1024×1024，内容占 824×824 的圆角矩形（圆角约 22.5%），四周透明，
  与 macOS 系统图标同一规范——直接拿方图当图标就是 Dock 里那个“太正方体”的效果；
- `icons/Lumo.icns`：完整尺寸集，bundler 原样使用；
- `icons/icon.ico`：Windows NSIS 使用的 ICO，构建前由 `before-build.mjs` 从同一 PNG 源生成；
- `icons/tray.png`：44×44 单色模板图标，供菜单栏使用；
- `desktop-assets/lumo-logo.png`：512×512 品牌蓝圆盘徽章，供启动页 `boot.html` 使用，
  同时被 `dsh-overrides/brand-web.mjs` 拷成 `/branding/logo.png`（favicon 与工作台品牌标）。

## 构建期护栏

平台团队服务使用 `ctx.lumoAgentTeams`，原生 DSH 团队插件独占 `ctx.agentTeams`。
旧安装包若在发送对话后新建会话时报 `ctx.agentTeams.tryMembership is not a function`，
需重新构建并替换应用；工作区源码的改名不会更新 `/Applications` 内的 runtime。
`agent-teams/__tests__/runtime-compat.spec.ts` 使用真实 DSH AgentLoop、原生团队插件和
本地模拟回复，覆盖两种插件加载顺序下「回复完成后连续新建会话」。
PPT 和开放设计页面共用创作工具栏及主题控件样式，示例分类栏与内容网格分别布局。

`build-runtime.mjs` 在拷贝依赖闭包前会检查两类只在运行时才暴露的回归：

- `@deepseek-ai/*` 只能来自本地 dsh 快照。上游 npm 插件（如 `dsh-cost-meter`）会把
  `@deepseek-ai/dsh-credentials` 声明成普通依赖，pnpm 便从 registry 拉一份只导出两个符号的
  老版本；一旦它混进闭包，dsh-credentials-local、dsh-llm-pi-ai 等包会在 import 时直接失败。
- 体积裁剪只在包根一层删 `doc/docs/test/tests/example(s)`；`dist`、`lib` 里的同名目录往往是
  真代码（`yaml/dist/doc` 是 Document 的实现）。
- 第三方依赖按来源目录分别遍历，冲突版本放在使用方自己的 `node_modules` 中，保留其
  传递依赖和循环引用。例如 `proper-lockfile@4` 必须使用 `signal-exit@3`，不能被其他包
  需要的 `signal-exit@4` 覆盖，否则安装后会报 `onExit is not a function`。旧安装包需
  重新构建并替换应用，修改源码不会更新已安装的副本。

# Lumo Desktop

这是 Lumo 的真实“本地单机”打包入口，不是服务器 `standalone` 的缩小版。

## 运行边界

桌面应用由 Rust/Tauri 壳启动本地 DSH Web worker，数据保存在系统应用数据目录：
`lumo.sqlite` 保存平台状态，`dsh/sessions` 保存对话日志，`runtime/skills` 保存安装的技能。
它明确设置 `LUMO_DEPLOYMENT_MODE=local`，并移除 PostgreSQL、Redis、
Nacos、MinIO 和连接器网关地址；因此本地模式不会因为机器上恰好运行了某个中间件而
偷偷切换成分布式模式。

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
清理、复制 `target/lumo-runtime` 导致 `ENOTEMPTY` 或产物缺失。正常退出及可处理的中断会
释放锁；强制结束进程后若有残留锁，确认所有构建已停止，再删除该锁目录并重新构建。

Windows 使用同一个总入口，在 Git Bash 中执行：

```sh
./platform/build.sh --targets win-x64
```

也可以在 Windows 构建机的 `platform` 目录执行 `pnpm run desktop:win`。构建需要 Rust
MSVC 工具链、Node.js、Python 3.10+、Corepack 和 WebView2；产物位于
`platform/desktop/target/release/bundle/msi` 与 `platform/desktop/target/release/bundle/nsis`。
Windows 包内使用 `runtime/lumo-runtime.cmd`、`node.exe` 和 `python/python.exe`，运行时不依赖
当前 checkout 或开发机上的 Node。

## 桌面基础插件

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
下载 CLI 归档，缓存到 `platform/.build/skillhub/latest.tar.gz`，将 CLI 文件和
`runtime/bin/skillhub.mjs` 一起打包，复用包内 Node 和 Python。构建会在裁剪完成后执行
`--version` 和 `install --help` 校验；缺少任一依赖即构建失败。

离线构建可以设置 `LUMO_SKILLHUB_ARCHIVE` 指向预先下载的官方 `latest.tar.gz`。
删除缓存归档可获取新版本；实际打入的 CLI 版本、归档 SHA-256 和来源记录在
`runtime/runtime-manifest.json` 的 `skillhub` 字段。技能下载仍需联网，安装目录继续使用
应用的数据目录。旧安装包缺少 CLI 时需要重新构建并替换应用，修改源码不会修复已安装的副本。

桌面版在构建阶段固定并打包以下 DSH 基础插件，打开应用时直接从包内 runtime 加载，
不会在首次启动时访问插件仓库或依赖当前项目目录：

| 中文入口 | 上游包 | 版本 | 用途 |
| --- | --- | --- | --- |
| 插件市场 | `dshmarket` | `1.41.0` | 浏览和管理 DSH 插件 |
| 视觉理解 | `@liustack/modlens` | `3.25.2` | 图片读取、OCR 与视觉证据 |
| 上下文洞察 | `dsh-context` | `0.41.3` | 上下文组成、趋势与事件 |
| 费用统计 | `dsh-cost-meter` | `1.6.7` | 会话、预算、价格和历史费用 |
| 梦幻皮肤 | `dsh-dream-skin` | `8.30.1` | 8 套高质感主题、弥散光壁纸与每用户强调色（原生 `--dsw-*` 实现） |
| 任务看板 | `@linxin666/dsh-client-ui-task-board` | `0.3.14` | Host 权威任务台帐：看板任务、真实 DSH 会话执行、定时调度与执行历史（替换左侧菜单原「自动化」入口） |
| 多智能体团队 | `@nanmicoder/dsh-agent-teams` | `0.1.15` | 自然语言编排多智能体团队：船长/成员、带依赖任务与消息，Web 树状监控 |
| Univer 办公文档 | `dsh-univer-office` | `0.2.14` | DSH × Univer 协作网关与查看器：内联预览、浮动工作台与会话结束审阅 |

> 浏览器自动化（`@anweat/dsh-browser` 0.1.10）因依赖已被 dsh 现行版本移除的
> dsh-settings 旧导出，且上游无适配版本，暂不固定进桌面基线——市场页面也不展示。

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

界面皮肤优先由标准换肤插件 `dsh-dream-skin`（`8.30.1`）提供：8 套 iOS / Linear 式
清透冷调高质感主题、弥散光壁纸与每用户强调色，走 DSH 原生 `--dsw-*` token 系统。
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
- `icons/icon.ico`：Windows MSI/NSIS 使用的 ICO，构建前由 `before-build.mjs` 从同一 PNG 源生成；
- `icons/tray.png`：44×44 单色模板图标，供菜单栏使用；
- `desktop-assets/lumo-logo.png`：512×512 品牌蓝圆盘徽章，供启动页 `boot.html` 使用，
  同时被 `dsh-overrides/brand-web.mjs` 拷成 `/branding/logo.png`（favicon 与工作台品牌标）。

## 构建期护栏

`build-runtime.mjs` 在拷贝依赖闭包前会检查两类只在运行时才暴露的回归：

- `@deepseek-ai/*` 只能来自本地 dsh 快照。上游 npm 插件（如 `dsh-cost-meter`）会把
  `@deepseek-ai/dsh-credentials` 声明成普通依赖，pnpm 便从 registry 拉一份只导出两个符号的
  老版本；一旦它混进闭包，dsh-credentials-local、dsh-llm-pi-ai 等包会在 import 时直接失败。
- 体积裁剪只在包根一层删 `doc/docs/test/tests/example(s)`；`dist`、`lib` 里的同名目录往往是
  真代码（`yaml/dist/doc` 是 Document 的实现）。

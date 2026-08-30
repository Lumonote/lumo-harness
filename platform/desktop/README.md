# Lumo Desktop

这是 Lumo 的真实“本地单机”打包入口，不是服务器 `standalone` 的缩小版。

## 运行边界

桌面应用由 Rust/Tauri 壳启动本地 DSH Web worker，数据只落在系统应用数据目录的
`lumo.sqlite`。它明确设置 `LUMO_DEPLOYMENT_MODE=local`，并移除 PostgreSQL、Redis、
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

`preview-local.sh` 会使用仓库内的 DSH 运行时启动 `Lumo.app`，并将 SQLite 放到
`~/Library/Application Support/Lumo/lumo.sqlite`；如果 Web 前端产物不存在，它会先自动构建
`deepseek-harness/apps/web/dist/index.html`。也可以只构建应用包：

```sh
cd platform/desktop
cargo tauri build --debug --bundles app
```

构建结果位于 `target/debug/bundle/macos/Lumo.app`。Tauri 构建前会自动执行
`desktop/build-runtime.mjs`，把自包含 Node、DSH CLI、Web 前端、SQLite 后端和 Lumo 本地
插件放进 `Lumo.app/Contents/Resources/runtime`；因此解压后双击应用即可看到实际工作台，
不依赖当前 checkout、pnpm 或开发机上的 Node。应用数据和 SQLite 文件仍保存在系统应用
数据目录，且不连接服务器中间件。

## 桌面基础插件

桌面版在构建阶段固定并打包以下 DSH 基础插件，打开应用时直接从包内 runtime 加载，
不会在首次启动时访问插件仓库或依赖当前项目目录：

| 中文入口 | 上游包 | 版本 | 用途 |
| --- | --- | --- | --- |
| 插件市场 | `dshmarket` | `1.36.0` | 浏览和管理 DSH 插件 |
| 视觉理解 | `@liustack/modlens` | `3.25.2` | 图片读取、OCR 与视觉证据 |
| 浏览器自动化 | `@anweat/dsh-browser` | `0.1.10` | Playwright 浏览、点击、输入和截图 |
| 上下文洞察 | `dsh-context` | `0.38.1` | 上下文组成、趋势与事件 |
| 费用统计 | `dsh-cost-meter` | `1.6.7` | 会话、预算、价格和历史费用 |

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
`runtime/python/bin/python3`；如果构建环境没有准备 PPT `.venv`，打包会直接失败而不是生成
一个缺少实际功能的应用。所有组件的仓库、提交哈希和许可证记录在
`platform/upstream/skill-sources.json`。

OpenDesign 仍作为输入框下方的嵌入式创作面板提供；项目和空间选择器会把当前作用域
同步到该面板。桌面版浏览器插件默认不在构建时下载 Chromium，避免安装包被浏览器二进制
放大；首次真正执行浏览器自动化时，可由插件的浏览器安装入口准备本机浏览器缓存。

## 主题

Web 工作台默认使用 `Obsidian Signal`，设置页提供四套产品主题：`Obsidian Signal`、
`Ember Foundry`、`Orbital Glass` 和 `Infrared Grid`。它们都以深色中性底为基础，分别使用
信号橙、炉芯橙、冰蓝和红珊瑚作为单一强调色，不依赖服务器中间件，也不会把本地模式
变成集群模式。

调试版和正式 `.app` 都优先使用包内 `runtime/lumo-runtime.sh`；只有开发预览才回退到
checkout 中的 `local-runtime.sh`。如果包内资源损坏或缺失，诊断页会明确显示启动错误。

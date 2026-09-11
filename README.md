# lumo-harness

> 在开源 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（Cordis 驱动的「一切皆插件」智能体框架）之上，**零侵入地**构建组件化、可分发、多智能体协同的分布式平台。

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![CI](https://github.com/Lumonote/lumo-harness/actions/workflows/ci.yml/badge.svg)](https://github.com/Lumonote/lumo-harness/actions/workflows/ci.yml)
[![Release](https://github.com/Lumonote/lumo-harness/actions/workflows/release.yml/badge.svg)](https://github.com/Lumonote/lumo-harness/actions/workflows/release.yml)

## 这是什么

dsh 是「一切皆插件」的智能体框架，本仓库在它之上补上分布式平台缺的那一层：控制面（调度、注册表、网关、治理、计量）、数据面（dsh 承载节点）、协同面（复制的 SessionEvent 日志 + 事件总线）。业务能力以 Cordis 插件形态挂载，基础设施是独立的 Go 服务——两者不互相塞进对方的进程。

> ### ⛔ 第一铁律：绝不修改 dsh 源码
>
> 全部能力只经 dsh 原生扩展点实现：Cordis plugin / bundle / `cordis.patch.yml` / seam / event / profile。dsh 始终以依赖引入，**绝不 fork / vendor / monkey-patch**。
>
> **验证判据**：升级 dsh 版本无需 rebase 任何补丁；删除本平台全部代码后，dsh 仍可原样独立运行。
>
> 源码目录 `deepseek-harness/` 保留在当前工作区但按约定不提交 Git（`.gitignore` 首行忽略），它是上游 `master` 的只读 checkout，构建时按需克隆。设计结论见 [`docs/architecture.md`](./docs/architecture.md)。

## 三档产品形态

**本地单机不是服务器单例的缩小版**——它不启动任何网络中间件，使用 SQLite。

| 形态 | 载体 | 存储 | 中间件 | 适用范围 |
| --- | --- | --- | --- | --- |
| 本地单机 | Rust/Tauri 桌面包（`platform/desktop`） | SQLite | 无 | 个人工作台、本机 Agent、离线技能 |
| 服务器单例 | Docker Compose（`platform/deploy/compose.standalone.yml`） | PostgreSQL | Redis / MinIO / RocketMQ / Nacos | 单服务器团队服务 |
| 服务器集群 | Compose + Helm（`platform/deploy/compose.cluster.yml`、`helm/lumo-platform`） | PostgreSQL | Redis / MinIO / RocketMQ / Nacos | 跨用户委派、桌面节点、弹性调度 |

## 快速开始

### 本地单机（桌面应用）

```sh
cd platform/upstream && ./install-components.sh
cd ../desktop && ./preview-local.sh
```

`preview-local.sh` 用仓库内的 DSH 运行时启动本地应用，数据写入 `~/Library/Application Support/Lumo/`。只想产出应用包：`cargo tauri build --debug --bundles app`。

### 服务器单例 / 集群

```sh
./platform/deploy/up.sh standalone -d --build     # 单例
./platform/deploy/up.sh cluster -d --build        # 集群（自研服务多实例）
```

启动后打开 <http://127.0.0.1:4173>；Lumo 插件会在 DSH 原生页面内提供右下角「Lumo 运营面」，运营入口为 <http://127.0.0.1:4173/lumo/ops>。生产用 Helm：`helm template lumo platform/deploy/helm/lumo-platform`。

启动前建议先跑只读预检（不启动容器、不读取 Secret 正文）：

```sh
./platform/deploy/preflight-deployment.sh cluster --strict
```

## 仓库结构

| 路径 | 内容 |
| --- | --- |
| `platform/control-plane/` | Go 控制面服务：scheduler、registry、llm-gateway、connector-gateway、governance、usage-ledger、flows、projects、collaborator（`observability` 是共享库） |
| `platform/data-plane/dsh-node/` | dsh 承载节点 |
| `platform/dsh-plugins/` | 以 Cordis 插件形态挂载的业务能力（技能、连接器、知识库、计量、Lumo 运营面……） |
| `platform/desktop/` | Rust/Tauri 本地单机壳与 runtime 装配 |
| `platform/dsh-overrides/` | 运行时覆盖层（不修改 dsh 源码的装配入口） |
| `platform/deploy/` | Compose 拓扑、Helm chart、迁移与预检脚本 |
| `platform/shared/`、`platform/upstream/` | seam 契约/清单，与上游组件快照安装 |
| `docs/` | 中文设计文档：架构、路线图、评审、编号专题规格 |
| `deepseek-harness/` | 上游 dsh 只读 checkout，**不提交 Git** |

## 构建与发布

### 一键构建：`platform/build.sh`

本地与 CI 共用这一份脚本，避免「本地能跑、CI 产出不一样」。

```sh
./platform/build.sh                            # 12 个 Docker 镜像（默认）
./platform/build.sh --targets darwin-arm64     # macOS 桌面包（dmg）
./platform/build.sh --targets win-x64          # Windows NSIS 安装包
./platform/build.sh --targets all              # 镜像 + 宿主架构桌面包
./platform/build.sh --dry-run --targets all    # 只打印将执行的命令
```

`--push` 需配合 `--registry`，推送前会校验 `platform/package.json`、`Chart.yaml`、`tauri.conf.json` 三处版本一致，不一致直接拒绝。桌面包必须在同平台同架构宿主上构建（native wheel 与 Rust 壳都不可跨架构）。

### 手动打包：`.github/workflows/release.yml`

打包**只支持手动触发**：push / tag 不再自动运行。在 GitHub Actions 页面选择 `release`
→ **Run workflow**，再选择要构建的分支或 tag。

| 手动选择的分支 / tag | 产物 |
| --- | --- |
| `main` 或 tag `v*` | macOS / Windows 安装包上传为 Actions artifact |
| 其他分支 | 桌面**测试包**（artifact 名带 `-test` 后缀） |
| tag `v*` | 除 artifact 外，安装包附到 GitHub Release |

门禁（typecheck / 测试 / `go vet` / 第一铁律校验）由 [`.github/workflows/ci.yml`](./.github/workflows/ci.yml) 单独负责，与产物职责分离。发布前需保证 tag 名（如 `v0.1.0`）与 `platform/package.json`、`Chart.yaml`、`tauri.conf.json` 三处版本号一致。

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/README.md`](./docs/README.md) | 文档地图与阅读路径（**从这里开始**） |
| [`docs/architecture.md`](./docs/architecture.md) | 唯一权威技术规范（§0–§15） |
| [`docs/roadmap.md`](./docs/roadmap.md) | 实施蓝图与端到端流程（§16–§17） |
| [`docs/design-review.md`](./docs/design-review.md) | 独立评审：P0 风险与替代落地顺序 |
| [`platform/deploy/README.md`](./platform/deploy/README.md) | 部署清单、三档形态、设备 TLS 接入 |
| [`platform/desktop/README.md`](./platform/desktop/README.md) | 桌面打包边界与构建细节 |
| [`docs/configuration.md`](./docs/configuration.md) | 全部环境变量与配置契约 |
| [`docs/implementation-status.md`](./docs/implementation-status.md) | 已落地能力与外部集成边界 |

## 许可证

本项目采用 [MIT 许可证](./LICENSE)。

`platform/dsh-plugins/open-design/` 例外：它封装的上游 [OpenDesign](https://github.com/nexu-io/open-design) 项目为 Apache-2.0，该插件保持 Apache-2.0 以保留其来源归属。上游 `deepseek-harness` 自身亦为 MIT。

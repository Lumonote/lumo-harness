# 一键构建入口设计说明 —— 12 个镜像与双架构 macOS 桌面包的单一产出口

- 日期：2026-09-02
- 前置：`platform/deploy/README.md`（三形态部署）/ `platform/desktop/README.md`（本地单机打包）/
  已在产事实：`platform/deploy/up.sh`（compose 启动 + `ensure_dsh_source`）、
  11 个服务 Dockerfile + `console/Dockerfile`、`platform/desktop/build-runtime.mjs`（runtime 装配）、
  `platform/desktop/make-dmg.sh`、`platform/upstream/install-components.sh`、
  `.github/workflows/ci.yml`（门禁，不产物）
- 状态：设计已评审通过，未实现

---

## 0. 定位：缺的不是构建能力，是产出口

各个产物今天都能构建，但**没有一个地方能把它们一次产出**，且其中一条链根本没有自动化：

| 产物 | 现状入口 | 缺口 |
|------|---------|------|
| 12 个 Docker 镜像 | `up.sh <shape> -d --build`（compose 顺带构建） | 构建与启动耦合；没有单独构建、没有 push、没有多架构 |
| macOS 桌面包 | `pnpm --dir platform desktop:dmg` | 只能产出**构建机架构**；Intel 与 M 无法分别产出 |
| ghcr 上的发布镜像 | 无 | `helm/lumo-platform/values.yaml` 引用 `ghcr.io/lumo-harness/*:0.1.0`，**没有任何产线在生产这些 tag** |

第三行是最严重的：Helm chart 引用了一组不存在的镜像。要上 K8s 只能手工 build & push，而手工推
就意味着没人能复现某个 tag 到底是从哪个 commit 出来的。

**本篇交付两件事**：一个本地脚本 `platform/build.sh`，和一个调用同一脚本的 CI workflow。
两者共用同一份构建逻辑，避免「本地能跑、CI 产出不一样」这类双份维护的经典故障。

---

## 1. 边界：这一轮是「脚本」，不是「跨平台移植」

调研中确认了一个会决定方案形状的事实：**桌面打包链从头到尾假设「macOS + 构建机架构」**。

| 位置 | 硬编码 | 后果 |
|------|--------|------|
| `desktop/build-runtime.mjs:314-317` | `keepOnly(..., 'darwin')`，注释写明「app 只发 macOS」 | 主动删除 `onnxruntime-node` / `node-pty` / vendored ripgrep 的所有非 darwin 原生二进制 |
| `desktop/build-runtime.mjs:585` | `isPortableDarwinBinary` 调 `/usr/bin/otool` | Mach-O 专用工具，是 Node（`:564,573,578`）**和** Python（`:257`）的唯一可移植性闸门 |
| `desktop/build-runtime.mjs:570-582` | 扫构建机 `~/.nvm/versions/node/*`，兜底 `process.execPath` | **无 target arch 概念**；M 芯片上构建必然打进 arm64 Node |
| `upstream/install-components.sh:26-29` | 宿主 `python3 -m venv` → `bin/python` | Python 亦为宿主架构；Windows venv 是 `Scripts/python.exe` |
| `desktop/lumo-runtime.sh` | `#!/bin/sh`、`~/Library/Application Support`、`exec .../node` | Windows 无 POSIX shell，路径与后缀均不成立 |
| `desktop/src/main.rs:21-45` | 候选路径全部 `lumo-runtime.sh` + `Contents/Resources` | 启动器只认 macOS `.app` 布局 |
| `desktop/make-dmg.sh` | `hdiutil` | macOS 专用 |

据此划定边界：

- **本轮做**：脚本 + CI + `build-runtime.mjs` 的 target-aware 改造（仅「按 target 选二进制」这一件事）。
- **本轮不做**：Windows 移植。它要改上表后三行 + Python venv 布局 + otool 分派，是一次独立的
  移植工作，不是给脚本加一个 flag。脚本对 `--targets win-x64` **显式报错并打印上表**，
  而不是静默跳过或产出一个起不来的包。

**这条边界的收益**：一键构建今天可用，Intel/M 立刻落地，Windows 的接口位置已经留好且不假装支持。

**代价也说清**：`--targets win-x64` 在相当一段时间内是一条只会报错的路径。这是刻意的——
让「不支持」出现在错误信息里，比让它藏在文档某一段里更难被忽略。

---

## 2. 入口契约

`platform/build.sh`，唯一入口：

```sh
./platform/build.sh                        # 默认 = --targets images
./platform/build.sh --targets images
./platform/build.sh --targets darwin-arm64
./platform/build.sh --targets darwin-x64
./platform/build.sh --targets all          # 镜像 + 本机架构桌面包
./platform/build.sh --targets images --push --registry ghcr.io/lumo-harness
./platform/build.sh --dry-run --targets all
```

| 参数 | 默认 | 说明 |
|------|------|------|
| `--targets` | `images` | 逗号分隔：`images`、`darwin-arm64`、`darwin-x64`、`all`、`win-x64`（报错） |
| | | `all` 在 macOS 上 = 镜像 + 宿主架构桌面包；在非 macOS 上 = 仅镜像，并打印一行说明。<br>显式请求 `darwin-*` 而宿主非 macOS 则是硬失败——`all` 是「尽力而为」，具名 target 是「必须产出」 |
| `--registry` | 无（本地 tag） | 设置后 tag 为 `<registry>/<name>:<version>` |
| `--version` | 读 `platform/package.json` | |
| `--push` | 关 | 需配合 `--registry` |
| `--platform` | 宿主架构 | 多架构仅在 `--push` 时可用，见 §3 |
| `--jobs` | CPU 数 | Go 镜像并行度 |
| `--dry-run` | 关 | 打印每条将执行的 docker/cargo 命令而不执行 |

**默认不含桌面**是刻意的：桌面构建耗时以十分钟计，不应由一条无参数命令意外触发。

---

## 3. 镜像构建（12 个）

| 镜像 | context | dockerfile |
|------|---------|-----------|
| `collaborator` `connector-gateway` `flows` `governance` `llm-gateway` `projects` `registry` `scheduler` `usage-ledger` | `platform/control-plane` | `<svc>/Dockerfile` |
| `provisioner` | `platform/control-plane` | `registry/Dockerfile.provisioner` |
| `dsh-node` | 仓库根 | `platform/data-plane/dsh-node/Dockerfile` |
| `console` | 仓库根 | `platform/console/Dockerfile` |

不在清单内且各有原因：`control-plane/observability` 是共享库、无 `cmd`、无 Dockerfile；
`data-plane/dsh-node/Dockerfile.resume` 是 dev-loop 加速变体，不进发布；
`artifact-runtime` 复用 `provisioner` 镜像，不是独立镜像。

Go 服务的 context 是 `platform/control-plane` 而非各服务目录，因为 Dockerfile 需要
`COPY observability /observability`（见 `governance/Dockerfile:4`）——脚本必须照此设置，
否则构建在 `go mod download` 前就失败。

### 3.1 tag 与版本

- 无 `--registry` 时 tag 为 `lumo/<name>:dev`。**与 compose 现状一致**，构建完执行
  `up.sh standalone -d`（不带 `--build`）即可直接起。
- `--push` 前校验三处版本一致：`platform/package.json`、`deploy/helm/lumo-platform/Chart.yaml`
  （`version` 与 `appVersion`）、`desktop/tauri.conf.json`。不一致直接拒绝并列出差异。

  **为什么是硬失败而不是警告**：这三处当前都是 `0.1.0`，靠人工同步。一旦漂移，推上去的 tag 与
  Helm 引用的 tag 静默错开，故障现场是「K8s 拉不到镜像」，排查路径离真正的原因很远。
  本轮不引入单一版本源（YAGNI，三处手改成本尚可），但把漂移挡在推送之前。

### 3.2 多架构

`--platform linux/amd64,linux/arm64` 走 buildx，且**仅在 `--push` 时启用**：buildx 多平台产物
无法 `--load` 进本地 daemon，这是 docker 的硬限制，不是本设计的取舍。本地构建始终单架构。

### 3.3 dsh 源与并发

- `dsh-node` 的 context 是仓库根，构建前须确认 `deepseek-harness/` 存在。把 `up.sh:21` 的
  `ensure_dsh_source` 抽成 `deploy/lib/dsh-source.sh`，由 `up.sh` 与 `build.sh` 共用——
  **抽取而非复制**，两处对「已存在的 checkout 绝不 fetch/reset」这条语义必须永远一致。
- 9 个 Go 镜像互不依赖，按 `--jobs` 并行；`dsh-node` 串行执行（构建最重，且 pnpm store 有写竞争）。

---

## 4. 桌面构建：`build-runtime.mjs` 的 target-aware 改造

本轮唯一的代码改动，严格限定在「按 target 选二进制」：

1. **新增 `--target darwin-arm64|darwin-x64`**，默认宿主架构。
2. **Node 改为按 target 从 nodejs.org 下载官方 tarball** 到 `platform/.build/node/<version>-<target>/`，
   带 SHASUMS 校验；`LUMO_RUNTIME_NODE` 保留为覆盖。

   这同时偿还 `:579` 自己标注的技术债——「版本随构建环境漂移」的根因是 Node 来自扫 nvm 的偶然
   结果；改为显式声明后，构建机上装了什么 Node 不再影响产物。
3. **`isPortableDarwinBinary` 增加架构断言**：`otool -L` 之外再用 `lipo -archs` 确认二进制架构
   等于 target，不符即失败。

   **这是整个双架构支持的关键闸门**。没有它，在 M 上构建 `darwin-x64` 会产出一个内含 arm64 Node
   的「x64 包」——它能打包成功、能分发、在 Intel 机器上直接起不来，且错误信息不会指向架构。
4. **PPT venv 按 target 分目录**（`.venv-darwin-arm64` / `.venv-darwin-x64`），
   `install-components.sh` 加 `--target`。

   约束：**x64 venv 必须在 x64 环境里建**（native wheel）。因此在 M 上本地构建 `darwin-x64`
   会失败并提示走 CI；CI 的 `macos-13` runner 天然是 x64。已确认接受此限制——绕开它需要在 x64
   容器里建 venv，复杂度明显上一个台阶，收益仅是省去一次 CI 往返。
5. `keepOnly(..., 'darwin')` **保持不变**（仍只发 macOS），补注释说明 target 模型。

**不动**：`lumo-runtime.sh`、`src/main.rs`、`make-dmg.sh`。三者对两个 mac 架构完全通用，
`make-dmg.sh` 已在文件名里带 `$(uname -m)` 映射的 arch 后缀，无需改动。

---

## 5. CI

新增 `.github/workflows/release.yml`，**调用同一个 `build.sh`**：

| job | runner | 命令 |
|-----|--------|------|
| `images` | `ubuntu-latest` | `--targets images --push --registry ghcr.io/lumo-harness --platform linux/amd64,linux/arm64` |
| `desktop` | matrix `macos-14`(arm64) / `macos-13`(x64) | `--targets darwin-<arch>`，dmg 走 `upload-artifact` |

- 触发：tag `v*` 推正式版本，另加 `workflow_dispatch` 手动。
- ghcr 登录用 `GITHUB_TOKEN`，无需额外 secret。
- **现有 `ci.yml` 不动**。它是门禁（typecheck / test / vet / 第一铁律校验），不产物；
  发布与门禁职责分离，避免一个 workflow 同时对两件事负责。

---

## 6. 验证

| 对象 | 手段 |
|------|------|
| 脚本本身 | `--dry-run` 打印全部将执行命令；对每种 `--targets` 组合断言命令序列 |
| 镜像 | 构建后 `docker compose -f compose.standalone.yml config` 校验 tag 可解析 |
| 桌面包 | `lipo -archs "$app/Contents/Resources/runtime/node"` 断言 == 目标架构 |
| 第一铁律 | 收尾执行 `git -C deepseek-harness status --porcelain -uno` 与 `describe --tags --dirty` |

第三行是本设计里唯一能**证明** intel 包真是 intel 包的检查，不可省略——理由见 §4 第 3 条。

第四行必须有：`dsh-node` 镜像会把 `deepseek-harness/` 整棵 COPY 进构建上下文并在镜像内执行
`dsh-overrides/apply.mjs`。改动只应发生在镜像内，宿主 checkout 必须保持洁净，而这需要证明。

---

## 7. 明确不做

| 不做 | 理由 |
|------|------|
| Windows 打包 | §1 的移植清单，独立工作项 |
| Linux 桌面包 | 无人提出需求；`keepOnly` 的 darwin 假设同样阻挡 |
| 单一版本源（version 收敛到一处） | 三处手改成本尚可；§3.1 的推送前校验已挡住实际故障 |
| 镜像签名 / SBOM | 供应链加固是独立议题，不与「产出口」混做 |
| 替换 compose 的 `--build` 路径 | `up.sh <shape> -d --build` 继续可用；`build.sh` 是增量入口，不是替代 |

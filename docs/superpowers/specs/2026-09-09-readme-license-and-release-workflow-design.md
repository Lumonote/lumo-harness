# README 重写、MIT 协议落地与 Git Push 触发自动打包设计说明

- 日期：2026-09-09
- 前置：`platform/build.sh`（一键构建入口）、`.github/workflows/ci.yml`（门禁，不产物）、
  [`2026-09-02-one-click-build-design.md`](./2026-09-02-one-click-build-design.md) §5（`release.yml` 的原始设计，未实现）
- 状态：已实现；**触发方式已变更**：由 push/tag 自动触发改为仅 `workflow_dispatch` 手动触发（见 §3.1）。

---

## 0. 定位：三件各自独立的事，合成一次交付

| 诉求 | 现状 | 本设计做什么 |
|------|------|-------------|
| 优化 README | 根 `README.md` 只有 10 行，读者拿不到形态、入口和文档地图 | 重写为分节中文 README，补徽章、形态表、快速开始、构建发布与文档索引 |
| 改成 MIT 开源协议 | `LICENSE` **已经是 MIT**（`Copyright (c) 2026 Lumonote`），但 26 个 `package.json` 没有 `license` 字段，另有 1 个声明 Apache-2.0 | 补齐字段、统一为 MIT，README 加 License 章节与徽章 |
| Git Push 触发自动打包 | `build.sh` 头部已引用 `.github/workflows/release.yml`，但**该文件不存在**；`ci.yml` 只跑门禁不产物 | 新增 `release.yml`，push 到 `main` 出可下载产物，打 `v*` tag 才推 ghcr 与建 Release |

三者共用同一批文件（README 要写清构建与发布，发布流程要引用 LICENSE 与版本号），所以合成一篇设计。

---

## 1. README 重写

### 1.1 结构

```text
# lumo-harness
> 一句话定位
[![License: MIT](...)][![CI](...)][![Release](...)]

## 这是什么            —— 三平面 + 第一铁律，2–3 句
## 三档产品形态         —— 本地单机 / 服务器单例 / 服务器集群 表格
## 快速开始            —— 桌面（本地单机）与服务器两条路径
## 仓库结构            —— platform/ 子目录职责 + docs/ + deepseek-harness/（不提交、只读）
## 构建与发布          —— build.sh 用法 + release.yml 触发规则
## 文档                —— 指向 docs/README.md 与三份子系统 README
## 许可证              —— MIT，链接 LICENSE
```

### 1.2 内容约束

- **语言**：中文，与 `docs/` 一致。
- **不重复 `docs/` 的设计细节**：README 只做入口，设计结论一律指向 `docs/architecture.md`。
  判据：README 里任何一句「为什么这样选」都应能被替换成一个链接。
- **第一铁律必须出现**：`deepseek-harness/` 只读、不提交，且写明验证命令。
- **三档形态表**直接取自 `platform/deploy/README.md` 的既有表述，不另造术语。
- **徽章**：License MIT / CI（`ci.yml`）/ Release（`release.yml`），三枚都指向真实存在的目标；
  Release 徽章在首个 tag 前会显示 "no releases"，这是可接受的。
- **可复制粘贴**：快速开始里的每条命令都必须与仓库现状一致（`preview-local.sh`、`up.sh standalone -d`），
  不写「以后会有」的入口。

### 1.3 明确不写

- 不写英文 README（无此需求，双语维护成本高）。
- 不写架构图（`docs/architecture.md` 已承载，README 复制会漂移）。
- 不写「Roadmap」章节（`docs/roadmap.md` 是唯一来源）。

---

## 2. MIT 协议落地

### 2.1 事实核对

| 对象 | 现状 | 动作 |
|------|------|------|
| `LICENSE` | 已是 MIT，`Copyright (c) 2026 Lumonote` | **不改** |
| 上游 `deepseek-harness/` | MIT，`Copyright (c) 2026 DeepSeek` | 不改（只读，且已是 MIT） |
| `platform/package.json`、`platform/console/package.json`、`platform/data-plane/dsh-node/package.json`、`platform/obsidian-vault-source/package.json` | 无 `license` 字段 | 补 `"license": "MIT"` |
| `platform/dsh-plugins/*/package.json`（共 28 个） | 4 个 MIT、1 个 Apache-2.0、**23 个无字段** | 23 个补 MIT；`open-design` **保持 Apache-2.0**（见 §2.2） |
| `platform/desktop/Cargo.toml` | `license = "Apache-2.0"` | 改 `"MIT"`（自有 Rust 壳，无第三方派生） |

合计：**新增 27 个 `"license": "MIT"`**（23 个插件 + 4 个非插件 `package.json`），另改写 `Cargo.toml` 一处。

注：`platform/desktop/` 没有 `package.json`（只有 `Cargo.toml` + `tauri.conf.json`）；`platform/desktop/runtime-stubs/fs-ext/package.json` 已是 MIT，无需改动。

### 2.2 `open-design` 保持 Apache-2.0（实施中修正）

原计划把它一并改为 MIT。实施时发现不能改：

- `platform/dsh-plugins/open-design/src/index.ts:11-14` 显式声明
  `upstream = { repository: 'https://github.com/nexu-io/open-design', license: 'Apache-2.0' }`，
  且 `__tests__/index.spec.ts` 断言了该来源；
- 上游 OpenDesign 项目为 Apache-2.0，并自带 `SKILL.md` 技能体系；
- 该插件的 `package.json` 是 28 个插件中唯一声明 Apache-2.0 的——这是刻意的来源归属，不是遗漏。

单方面改为 MIT 会抹掉上游归属。因此保持 Apache-2.0，并在 README 的「许可证」章节写明这一例外。
这正是本节原有的护栏（「若含第三方 Apache-2.0 代码则不能改」）命中的情形。

### 2.3 不做

- **不加源码文件头版权注释**：上游 dsh 不做，本仓库既有文件也没有，加了只会制造 300+ 文件噪声。
- **不新增 `NOTICE` / `COPYING`**：MIT 不要求。
- **不引入 SPDX 校验工具**：本轮目标是声明一致，不是供应链合规（与一键构建设计 §7 的「不做」保持一致）。

---

## 3. `.github/workflows/release.yml`

### 3.1 触发与产物矩阵

```yaml
on:
  workflow_dispatch:   # 仅手动；push / tag 不自动触发
```

| job | runner | 手动选非 `main` 分支 | 手动选 `main` | 手动选 tag `v*` |
|-----|--------|---------------|----------------------|-------------|
| `images` | `ubuntu-latest` | 不运行 | `build.sh --targets images`（单架构，**不推**，验证 Dockerfile 可构建） | `--targets images --push --registry ghcr.io/lumonote --platform linux/amd64,linux/arm64 --version ${tag#v}` |
| `desktop` | matrix `macos-14` → `darwin-arm64`<br>`macos-15-intel` → `darwin-x64`<br>`windows-latest` → `win-x64` | `build.sh --targets <t>` → artifact 名带 `-test` 后缀 | `build.sh --targets <t>` → `upload-artifact` | 同上，artifact 另附到 Release |
| `release` | `ubuntu-latest` | — | — | 下载全部 artifact，创建 GitHub Release |

**设计要点：**

0. **非 `main` 分支自动打测试包**。`branches: ['**']` 覆盖所有分支，桌面安装包照常产出，
   artifact 名加 `-test` 后缀与正式产物区分；`images` 用 job 级 `if` 挡在 `main`/tag 之外——
   每次 push 构建 12 个镜像代价过高，且镜像无法作为可下载 artifact，非 `main` 分支拿不到任何东西。
1. **artifact 与 registry 推送分离**。push 到 `main` 只产出可下载的构建产物，不向任何外部仓库写入；
   只有 tag 才推 ghcr。这样「日常提交」不会污染镜像仓库，符合「发布才动外部」的直觉。
2. **`--push` 只在 tag 上出现**，且必须带 `--version`。`build.sh:199` 的 `check_version_consistency`
   会校验 `platform/package.json` / `Chart.yaml` / `tauri.conf.json` 三处一致；tag 名与版本不一致时
   workflow 在推送前就失败，而不是推出一组与 Helm 引用错开的 tag。
3. **`desktop` 三个 target 各自独立 runner**。`build.sh:276` 的 `build_desktop` 硬性要求
   `target == host_desktop_target`（native Python wheel 与 Rust 壳都要求宿主一致），
   所以不能在一个 runner 上跨架构产出，矩阵是唯一正确形状。
4. **`ci.yml` 的职责与结构不动**。门禁（typecheck / test / vet / 第一铁律）与产物职责分离，避免一个
   workflow 同时对两件事负责。唯一的例外是 §4 的 registry 字面量替换——那是引用一致性修正，
   不改变它作为门禁的定位。
5. **PPT 解释器统一到 3.13**。workflow 用 `uv python install 3.13`，并把
   `platform/upstream/install-components.sh:92` 的 uv 候选顺序由 `3.12 3.11 3.10 3.13`
   改为 `3.13 3.12 3.11 3.10`，使 CI 与本地构建取到同一版本。

   原先 3.12 优先的理由是「wheel 最全」，但该注释已过时：在 3.13.14 上实测
   `pip install -r requirements.txt` 全部装成 wheel，16 个模块（含 PyMuPDF、skia-pathops、
   uharfbuzz、cryptography、numpy 等原生包）import 全部通过，无需源码编译。

   **注意生效条件**：`install-components.sh` 只在 venv 缺失时才创建它，因此已存在的
   `skills/ppt-master/.venv-<target>` 不会被自动重建。要让本地构建真正切到 3.13，
   必须删掉旧 venv 目录（它是 gitignored 的构建产物）。

### 3.2 公共前置步骤

每个 job 都按 `ci.yml` 的既有写法准备：

- `actions/checkout@v4` 检出本仓库；
- 第二次 `actions/checkout@v4` 把 `deepseek-ai/deepseek-harness@master` 拉到 `deepseek-harness/`
  （`build.sh` 经 `deploy/lib/dsh-source.sh` 复用已存在的 checkout，**绝不 fetch/reset**）；
- `images` job 另需 `docker/setup-buildx-action`（多平台）与 `docker/login-action`（ghcr，
  `GITHUB_TOKEN` + `permissions: packages: write`，无需额外 secret）；
- `desktop` job 需 Rust 工具链与 Python 3.10+（`install-components.sh` 会自行挑选可重定位解释器）。

### 3.3 版本来源

tag `v0.1.0` → `--version 0.1.0`。**不引入单一版本源**（沿用一键构建设计 §7 的结论）：
三处手改的成本仍可接受，而 `--push` 前的硬校验已经挡住了漂移导致的实际故障。

---

## 4. 实施中必须修正的两个既有事实

| 事实 | 影响 | 处理 |
|------|------|------|
| 设计稿 §5 写的 `macos-13` **已于 2025-12 被 GitHub 下线** | 照抄会导致 x64 job 直接失败 | 改用 `macos-15-intel`（GitHub 官方 Intel 替代标签，也是最后一个，2027-08 退役） |
| `ghcr.io/lumo-harness` **命名空间不存在**（`github.com/lumo-harness` → 404），仓库属于 `Lumonote`；`GITHUB_TOKEN` 只能推自己 owner 的命名空间 | 照抄会在 `docker push` 阶段 `denied` | 全量改为 `ghcr.io/lumonote`：`platform/deploy/helm/lumo-platform/values.yaml`（`repository` + 3 处 `image`）、`platform/build.sh` 头部示例、`.github/workflows/ci.yml` 的 `--registry`、一键构建设计稿 §5 |

第二项是**跨文件的引用一致性改动**，属于本次范围：不改则新 workflow 推不动，改了不同步 Helm 则
Chart 引用的 tag 依旧不存在（正是一键构建设计 §0 点出的「最严重的缺口」）。

---

## 5. 风险

| 风险 | 说明 | 缓解 |
|------|------|------|
| 桌面打包在 CI 上从未跑过 | `ci.yml` 不构建桌面，`install-components.sh` + `build-runtime.mjs` 在 GitHub runner 上是首次执行 | workflow 显式安装 Rust/Python/Node 工具链；首次运行后按失败点修，不改 `build.sh` 的既有契约 |
| `macos-15-intel` 2027-08 退役 | Intel 桌面包将失去 CI 产出能力 | 本轮不处理；在 workflow 里加注释标明退役时间 |
| push 到 `main` 每次都构建 12 个镜像 | 约 15 分钟 ubuntu 分钟/次 | 单架构不推送，与 `ci.yml` 的 Go 矩阵并行；如仍嫌贵可改为仅 tag 触发，但那样 Dockerfile 只在发布时才被验证 |
| 三处版本号手工同步 | 漂移会让 `--push` 硬失败 | 这是刻意保留的失败：失败信息明确指向三处差异，比推出错 tag 好 |
| 第一铁律 | `dsh-node` 镜像把 `deepseek-harness/` 整棵 COPY 进构建上下文 | `build.sh:320` 的 `assert_dsh_pristine` 已在收尾断言；`ci.yml` 的独立校验保持不变 |

---

## 6. 验证

| 对象 | 手段 |
|------|------|
| `release.yml` 语法与触发 | `actionlint`（若本机可用）或 push 到分支后看 GitHub Actions 运行结果 |
| 工作流未跑偏 | 首次 push 后逐 job 核对：非 `main` 分支只出 `-test` artifact 且 `images` 被跳过、`main` 上 `images` 单架构不推送、tag 路径才出现 `--push` |
| README | 逐条核对快速开始命令与仓库现状一致；徽章链接可达 |
| license 字段 | 遍历 `git ls-files '*/package.json' 'package.json'` 去掉 `deepseek-harness/` 后的 33 个文件，逐个断言 `license == "MIT"`，唯一例外是 `open-design`（Apache-2.0）；另断言 `platform/desktop/Cargo.toml` 为 MIT |
| ghcr 引用一致性 | `grep -rn "ghcr.io/lumo-harness" . --exclude-dir=deepseek-harness --exclude-dir=.git --exclude-dir=node_modules` 应为空 |
| 第一铁律 | `git -C deepseek-harness status --porcelain -uno` 为空且 `describe --tags --dirty` 不带 `-dirty` |

---

## 7. 明确不做

| 不做 | 理由 |
|------|------|
| 英文 README | 无需求；双语会立刻漂移 |
| 源码文件头版权注释 | 上游不这么做，会制造数百文件噪声 |
| 单一版本源（版本收敛到一处） | 一键构建设计 §7 已否决，本轮不重开 |
| 镜像签名 / SBOM | 供应链加固是独立议题 |
| 桌面 Linux 包 | 无人提出需求，`keepOnly(..., 'darwin')` 同样阻挡 |
| 修改 `ci.yml` 的门禁职责 | 门禁与产物分离是本设计的结构前提 |

# 桌面安装体积排查（2026-11-09）

排查基线：`v1.2.1` / `a0a8c202b921d40390d16466da4c3ce68e0f1e36`。范围为 Mac ARM、Mac Intel、Windows x64 的构建、安装与首次运行链路。用户说明该问题存在于多个平台，并非要求诊断本机旧应用。

## 结论与证据边界

安装包小、安装目录大，主要由**压缩展开 + 完整离线运行时 + 小文件分配开销**叠加造成；使用后的增长另包括缓存、用户安装的插件/技能和业务数据。安装器并没有把“小程序”变成“大程序”：大部分运行时字节在下载时已经存在，只是被压缩了。

同时确有可优化的冗余。旧样本确认了跨平台原生包、Python 入口实体副本；当前源码仍存在符号链接实体化、仅裁剪部分顶层原生包的行为。但当前 pnpm 已使用宿主平台过滤，不能把旧样本全部浪费直接计入新版，也不能承诺新版固定节省几百 MB。

本轮未重建/安装应用。当前 checkout 没有可用于测量的 `desktop/lumo-runtime` 或对应 HEAD 的安装产物，因此**没有同一新版安装包与安装目录的精确展开比**。下面分别标注公开发布记录、当前代码证据、当前技能源目录与历史样本；不混用版本计算比例。

## 1. 安装器为什么能小很多

2026-11-09 读取[公开 Release API](https://api.github.com/repos/Lumonote/lumo-harness/releases?per_page=6)，最新公开版本为 [v1.1.1](https://github.com/Lumonote/lumo-harness/releases/tag/v1.1.1)，发布于 2026-10-01。其下载大小为：

| 产物 | 字节 | MiB |
| --- | ---: | ---: |
| `DeepSeek-Harness_1.1.1_aarch64.dmg` | 540,079,329 | 515.06 |
| `DeepSeek-Harness_1.1.1_x64.dmg` | 548,655,077 | 523.24 |
| `DeepSeek.Harness_1.1.1_x64-setup.exe` | 295,218,445 | 281.54 |

这些是下载尺寸，**不是安装占用**，也不是当前分支的构建结果。Windows 与 Mac 的下载大小不能仅按压缩算法直接换算，因为平台二进制与文件布局也不同。

- Mac：[`make-dmg.sh:29`](../platform/desktop/make-dmg.sh#L29) 明确使用 `hdiutil ... -format UDZO`，生成压缩镜像。拖入 Applications 后是展开的普通 `.app`。
- Windows：[`build-windows.mjs:43`](../platform/desktop/build-windows.mjs#L43) 先编译再生成标准 NSIS。当前 Tauri 配置未覆盖 NSIS 压缩设置，继承 LZMA 默认值。依据为本机 `tauri-utils 2.9.3` 的 `config.rs:806–813`（`Lzma` 标为 default）和 `894–898`（配置使用 serde default）。CI 采用 `cargo install tauri-cli --version "^2.0.0"` 并缓存，未固定精确 CLI 版本；这里证明默认配置语义，不宣称已检查某个公开 exe 内的实际 NSIS 脚本。
- [`tauri.conf.json:30`](../platform/desktop/tauri.conf.json#L30) 将整个 `lumo-runtime` 作为 `runtime` 资源交付。安装时展开这棵文件树。

流式 Deflate level 6 实验（只计输出字节，不生成大归档）：历史 Node 可执行文件 115.69 MiB → 37.22 MiB，Python 可执行文件 17.24 MiB → 7.12 MiB；当前 PPT templates 文件内容串联后 23.46 MiB → 10.45 MiB。这说明相同字节可产生约 2–3 倍差异。**实验不包含容器和文件系统元数据，不代表实测 DMG/NSIS 整包压缩比**。

Windows 还有条件性增量：配置未选择 fixed WebView2 runtime，Tauri 默认采用 `DownloadBootstrapper { silent: true }`（同一 crate `config.rs:998–1001、1053–1055`）。若系统缺少 WebView2，安装期间可另行下载安装共享运行时。其大小没有包含在本项目安装目录统计中；已预装的机器不会因此再增加同一份运行时。Mac 使用系统 WebKit。不能把本项目主要包体简单归因于“捆绑 Chromium”。

## 2. 真正占空间的是运行时和素材

当前打包行为：

| 内容 | 当前代码行为 | 对占用的含义 |
| --- | --- | --- |
| Node、CLI、Web、插件 | [`build-runtime.mjs:479`](../platform/desktop/build-runtime.mjs#L479) 遍历 dependencies / optionalDependencies / peerDependencies；已安装的可选依赖也纳入闭包 | 离线可运行，但不等于只打入最小 UI |
| Python 与 PPT 依赖 | [`build-runtime.mjs:638`](../platform/desktop/build-runtime.mjs#L638) 拷贝可重定位 Python，再拷贝 PPT venv 的 site-packages | 包含解释器、标准库、PDF/图片/表格处理等二进制依赖；基础 site-packages 已排除，不能说全部第三方库复制了两遍 |
| 技能资源 | [`build-runtime.mjs:538`](../platform/desktop/build-runtime.mjs#L538) 全量拷贝技能目录，排除 `.git`、`.venv*`、`__pycache__` | 模板、图标、预览图、参考资料、音频都随包交付 |
| 包管理工具 | [`build-runtime.mjs:561`](../platform/desktop/build-runtime.mjs#L561) 交付 corepack/npm 等 | 支持安装后的市场更新，也产生固定开销 |

当前依赖链还有两代推理库：

```text
@lumo/ruflo-orchestration → ruflo → @claude-flow/cli
  → agentic-flow → @xenova/transformers → ONNX 1.14 / Sharp 0.32
  → neural → memory → agentdb → @huggingface/transformers
                                  → ONNX 1.24 / web 1.26 / Sharp 0.34
```

入口是 [`ruflo-orchestration/package.json:21`](../platform/dsh-plugins/ruflo-orchestration/package.json#L21)，版本链可核对 `platform/pnpm-lock.yaml:5020、5081、5096、5274、6741、6799、6831、8616`。某些边为 optional，只有构建时存在才入闭包，不能从 lockfile 推断每个产物必有全部内容；但仅删除 CLI 的 optional agentdb 条目也不够，因为 neural → memory 还有必需依赖路径。多个版本不能不经兼容验证就强制合并。

### 当前技能源目录的实测

统计遵循现有打包排除规则，不含 venv、`.git`、`__pycache__`；分配占用是本机文件系统测量，其他文件系统/簇大小会不同。

| 内容 | 文件内容 | 本机文件分配占用 | 文件数 |
| --- | ---: | ---: | ---: |
| 全部 bundled skills | 84.68 MiB | 124.02 MiB | 13,114 |
| PPT Master | 76.19 MiB | 115.14 MiB | 12,933 |
| 其中 templates | 23.46 MiB | 61.45 MiB | 12,438 |
| 其中 references | 44.18 MiB | 44.47 MiB | 163 |

PPT 中 12,193 个 SVG 的内容仅约 10.37 MiB，分配占用约 49.21 MiB。这解释了为什么文件内容之和、Finder/资源管理器的“占用空间”、下载大小是三个不同数值。比如 100 字节文件可能分配一个 4 KiB 块；安装包则可以连续压缩大量小文件。

模板和预览图有运行期引用，例如 `ppt-master/scripts/confirm_ui/server.py` 的预览路径及 PPT 工作流。不能仅因目录叫 references/templates 就全部删除。归档索引或按需提取可以降低小文件开销，但需适配这些访问路径。

## 3. 历史样本证实的冗余，以及当前是否还会发生

辅助样本 `/Applications/DeepSeek Harness.app` 的 Info.plist 为 0.1.0，runtime manifest 生成于 **2026-09-10**、包含 1,010 个包。它早于最新公开版本及当前分支，仅用于验证机制。

| 部分 | 文件内容 | 文件分配占用 |
| --- | ---: | ---: |
| 完整旧 `.app` | 1,572.93 MiB | 1,703.24 MiB |
| `runtime/node_modules` | 1,085.64 MiB | 1,158.64 MiB |
| `runtime/python` | 261.74 MiB | 273.52 MiB |
| `runtime/skills` | 84.70 MiB | 125.36 MiB |
| Node 可执行文件 | 115.69 MiB | 115.69 MiB |
| Rust 壳 | 12.53 MiB | 12.54 MiB |

全 app 共 48,531 个普通文件，其中 35,308 个不足 4 KiB；文件分配比内容多约 130.31 MiB。这里不把 APFS clone 的共享块当作已知可回收空间，文件统计也不包含目录与全部扩展属性。

### A. 跨平台原生依赖混入

旧样本中，仅 `@img` 约 230.89 MiB；按包清单的 os/cpu，约 **204.96 MiB** 与 darwin-arm64 不匹配，包括其他 Mac 架构、Windows DLL、Linux glibc/musl 等。新统计工具还发现其他不匹配候选：`@vscode/ripgrep-*` 约 50.98 MiB、`@koromix/koffi-*` 约 18.34 MiB；全部清单候选约 276.72 MiB。候选是审核线索，不能据此自动删除 WASM fallback 或未知运行期资源。

当前状态：[`pnpm-workspace.yaml:6`](../platform/pnpm-workspace.yaml#L6) 已明确依赖 pnpm 默认宿主过滤并禁止跨架构预装；当前本机 platform store 的 `@img` 也只见 darwin-arm64。因此**这不是已证实的新版必现浪费**。

仍有防回归缺口：闭包复制不检查 os/cpu/libc；[`pruneStagedRuntime:695`](../platform/desktop/build-runtime.mjs#L695) 只处理顶层 ONNX、node-pty、Claude SDK 内 ripgrep，没有覆盖独立 `@vscode/ripgrep-*`、`@img/*`、Koffi 等，也没有按全部已布局实例逐一检查。若构建环境/依赖包自带异平台文件，它们仍可能进入产物。

### B. Python 符号链接实体化

当前 base 和 site-packages 拷贝均使用 `dereference: true`。历史样本的 `bin/python`、`bin/python3`、`bin/python3.12` 是三个不同 inode 的普通文件，SHA-256 完全相同，每份 18,073,984 字节；多余两份合计 **34.47 MiB**。

这是已经发生过的真实重复，当前复制策略仍允许此行为；当前发布采用 Python 3.13，别名布局/单文件大小不同，不能直接把旧版 34.47 MiB 当作新版固定节省值。应保留包内可重定位的相对链接或其他经打包器验证的去重方式，并分别验证 Windows 与 Mac。

### C. 历史办公插件不应重复计算

旧包包含约 166 MiB 的 `dsh-univer-office`，以及相关 Univer 资源。当前 [`plugin-baseline.manifest.json:51`](../platform/shared/manifests/plugin-baseline.manifest.json#L51) 已排除 office 和 task-board，不能把删除它们列为本轮新优化，或认定当前默认包仍携带它们。

## 4. 安装后首次运行与后续增长

当前 [`main.rs:343`](../platform/desktop/src/main.rs#L343) 从安装资源目录启动 launcher，状态文件落在 app_data_dir。两平台 launcher 都设置 `LUMO_PACKAGED_RUNTIME=1` 和 `LUMO_AUTO_INSTALL_PLUGINS=0`。

已沿代码确认：

- [`plugins.ts:218`](../platform/data-plane/dsh-node/src/plugins.ts#L218) 的 packaged 分支直接进入挂载逻辑；[`plugins.ts:343`](../platform/data-plane/dsh-node/src/plugins.ts#L343) 创建 symlink/junction。profile 初始化只写 package.json、patch、workspace 三类小配置；没有复制整个 node_modules，也不执行 pnpm install。
- creative-skills、archify、skill-local 读取/注册原技能目录；没有发现首启再复制整棵 bundled skills 的路径。
- Node compile-cache 放在用户 runtime 状态目录。Mac 还会在 Corepack 没有默认版本记录时预缓存 pnpm（[`lumo-runtime.sh:49`](../platform/desktop/lumo-runtime.sh#L49)）；Windows 当前 launcher 未执行这一步。缓存大小依赖实际运行，历史辅助样本的 Corepack 约 37 MiB，不能解释整个 GB 级包体。
- 显式安装技能会把内容放到用户状态目录的 `skills`；显式更新内置插件可在 profile 安装新版，包内原版本仍存在。这属于用户扩展/覆盖，可能产生双份依赖占用。
- 对话、附件、生成文件、SQLite、日志和 WebView 用户缓存还会随使用增长，不能和安装目录混为一个数字。

为避免误判，额外在 `/tmp` 用 **pnpm 11.25.0、离线小包 fixture** 做了两项实验：安装其他插件保留已有 baseline symlink；显式更新 baseline 到另一 tarball 会将该链接替换为实体目录，原 bundled 目录保留。该实验解释更新后的两份内容机制，**不等于用项目 pin 11.7.0 完成了真实市场端到端复现**。不能推断“装任意一个插件都会重装整套基线”。

## 5. 建议优化顺序与验证条件

| 优先级 | 动作 | 价值与验证条件 |
| --- | --- | --- |
| 1 | 每个平台产物记录总内容、文件数、各组件大小、目标不匹配候选，并与安装器字节关联 | 先获得同版本证据；当前 manifest 只有 packageCount、prunedBytes 等，无法看出净总量和增长归属 |
| 2 | 对全部已布局原生包做目标筛选/校验，涵盖嵌套版本和包内 vendor | 防止开发机状态污染；需保留可用的 fallback，不能只按名字删目录 |
| 3 | 避免 Python 内部别名实体化 | 历史已测多余 34.47 MiB；新产物重新统计，并验证重定位、签名和 PPT/PDF/SkillHub 导入 |
| 4 | 分别检查各版本 ONNX native/WASM | 当前只检查顶层 binding，不能拿 A 版本 native 可用来断言 B 版本 WASM 可删；需按版本验证推理与降级路径 |
| 5 | 对 PPT 图标使用归档/索引/按需提取 | 降低大量小 SVG 的文件分配和安装耗时；保持模板、预览、生成工作流可用 |
| 6 | 评估 Ruflo/本地推理作为按需能力包 | 减少默认重依赖，属于交付模式选择；需保证离线功能承诺、版本固定、完整性与恢复，不宜在调查中直接移除 |

提高压缩级别主要减小下载，不能解决展开占用。单纯换 Electron/Tauri 壳也碰不到当前主要空间来源。建议前 1–4 项先保留现有功能行为，再评估按需交付。

## 6. 可复用的只读审计工具

新增 [`audit-runtime-size.py`](../platform/desktop/audit-runtime-size.py)，使用 Python 标准库，不启动应用、不安装依赖、不删除输入，不跟随 symlink/junction：

```sh
# Mac：传 .app 或其中 runtime；target 默认来自 runtime-manifest.json
python3 platform/desktop/audit-runtime-size.py '/path/DeepSeek Harness.app' --hash-duplicates > size-mac.json

# Windows：传展开的安装目录；不需要运行 exe
python platform/desktop/audit-runtime-size.py 'C:\path\DeepSeek Harness' --target win-x64 --hash-duplicates > size-win.json
```

输出内容字节、按 inode 去重的字节/可用时的分配占用、组件、最大文件、os/cpu 不匹配包、至少 1 MiB 同内容副本。Windows 不提供 st_blocks 时分配占用返回 null，不以 4 KiB 假设冒充测量；可结合资源管理器“占用空间”。候选不作为自动裁剪清单，APFS clone 的真实共享/可回收块也不在本工具证明范围。

本轮验证包括小 fixture 的目标过滤、符号链接循环跳过、相同文件与硬链接区分；旧 `.app` 全量只读扫描与独立 os.walk/du 统计核对；运行时启动/技能/profile 路径审查；公开 Release 元数据核对。未改运行时裁剪规则，未安装或删除用户内容。未运行完整构建，未提供未经测量的新版安装尺寸或瘦身承诺。

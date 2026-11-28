# DSH 历史覆盖层与退出计划

`deepseek-harness/` 是只读的（[第一铁律](../../CLAUDE.md)）。新产品能力优先使用公开插件、服务、插槽和构建装配扩展。本目录记录已有隔离副本源码覆盖的兼容债务；不把“没有直接改原树”当作任意新增源码覆盖的授权。

本文件同时是一份迁移账本：曾经直接改在上游树里的 20 个文件，各自搬到了哪。

## 构建与检查脚本

| 脚本 | 作用 | 谁调用 |
|---|---|---|
| `assert-pristine.mjs` | 上游洁净度闸门。已跟踪文件有改动，或 `apps/`、`packages/` 下出现未跟踪且未被 gitignore 排除的文件，立即失败 | `prepare-runtime.mjs`（构建前）、`build-runtime.mjs` 与 `local-runtime.sh`（构建后） |
| `prepare-runtime.mjs` | 把 `git ls-files` 列出的文件复制成隔离副本（`platform/.build/deepseek-harness`），软链 workspace 的 `node_modules`，再对**副本**打 `apply.mjs` 的补丁 | `desktop/build-runtime.mjs`、`desktop/local-runtime.sh` |
| `apply.mjs` | 处理 9 个包的覆盖/兼容分支和根 `tsdown.config.ts`；包括插槽、资料预览、分组、模型目录、传输恢复与旧版启动隔离。**仅作用于隔离副本** | `prepare-runtime.mjs` |
| `brand-web.mjs` | 在 `apps/web/dist/` 构建产物上覆盖 Lumo 品牌（图标、标题、PWA manifest） | 同上 |
| `check-compatibility.mjs` | 在一次性副本检查全部锚点，并比对实际文件变化与 `inventory.json`，不修改源工作区 | CI、pin 升级与本地诊断 |

## 当前范围与退出顺序

机器可读清单是 [`inventory.json`](inventory.json)：每项含具体文件、目的、替代机制、退出优先级和验收门槛。`inventory.mjs` 将清单与 `apply.mjs` 的 9 个构建包范围比对，并对临时副本的前后文件字节做审计；新增未登记变化、漏掉声明文件、或已不再需要的必改覆盖都会使检查失败。

2026-11-28 对上游提交 `4b399c39a6d1479cd84ca591b4d7c88e24d38a96` 的实测为 **9 个登记包范围 + 1 个根配置，实际变化 16 个文件**。`client/modules` 与 `client/web` 在该提交复用原生启动审计，仅验证锚点，不改字节；保留在构建清单是旧版本兼容范围，不能把登记数量等同于每个版本实际改写数量。

| 顺序 | 范围 | 退出条件 |
|---|---|---|
| 0 | `client/modules`、`client/web` 的旧启动分支 | 最低支持版本和发布 pin 均具备原生必需插件审计、可选失败隔离后，删除旧分支及不必要的重建例外，保留黑盒回归 |
| 0 | 根 `tsdown.config.ts` | 上游构建或平台独立构建配置可完整生成 host/client/typert 产物后移除根入口替换 |
| 1 | `api/gateway`、`api/session-controller`、`client/ui-model-selection` | 上游原生版本通过慢消费者、断线恢复、历史保留和模型目录先后到达测试后，删除对应修复 |
| 2 | `client/ui-conversation`、`client/ui-sidebar`、`client/ui-workspace`、`client/ui-sidebar-documentpreview` | 迁移到公开插槽、分组菜单和文件预览导出，完成原生界面回归后删除组件复制与源码注入 |

这里的顺序是迁移计划，不宣称上游已提供尚不存在的 API。每次移除都应同时收紧 `overriddenPackageDirectories`、机器清单和相关缓存/重建范围。新功能不得借此扩大覆盖层。

隔离副本会为 workspace 包明确导出的 `./src/*` 补齐 TypeScript 路径映射，并保留上游已有
映射。这样源码子路径与公开入口都解析到同一份副本，避免共享 `node_modules` 软链把
部分源码带回原树，导致 `ISessions` 重复声明或 `SessionRetainFacetMap` 扩展失效。
此调整只写副本的 `tsconfig.base.json`；准备脚本与映射逻辑共同参与缓存指纹。

构建**前后**各查一次洁净度：暂存副本的 `node_modules` 是软链回源树的，pnpm 有可能顺着
workspace 链接把编译产物写回 `deepseek-harness/packages`——仓库里那批 345 个
`.js`/`.d.ts`/`.map` 正是这么来的。只查前不查后，等于把这条路留着。

## 迁移账本

| 上游文件 | 落点 | 机制 |
|---|---|---|
| `apps/cli/src/plugin.ts` | `platform/data-plane/dsh-node/src/plugins.ts` `profileManagerEnv()` | 在 PATH 前置一个转发到 Corepack 的 `pnpm` shim，并置 `COREPACK_ENABLE_PROJECT_SPEC=0`。上游 CLI 那句裸 `pnpm` 因此可用，且不会误取父级 `package.json` 的 `packageManager` |
| `apps/web/index.html` | `brand-web.mjs` | 改 dist 产物的 icon link 与 `<title>` |
| `apps/web/public/favicon.svg` | `brand-web.mjs` | 把 `desktop-assets/lumo-logo.png` 拷进 `dist/branding/logo.png` |
| `apps/web/public/manifest.webmanifest` | `brand-web.mjs` | 改 dist 产物的 `name`/`short_name`/`icons` |
| `apps/web/tests/pwa-manifest.e2e.ts` | `__tests__/overlay.spec.ts` | 该用例当时被就地改成断言 Lumo 品牌。还原成上游版本后，品牌契约由本目录的用例承担 |
| `packages/client/ui-conversation/src/client/apply.ts` | `apply.mjs` | 在 `conversation.content` factory 的 children 里声明 `conversation.hero.input.left` / `conversation.hero.composer.dock` 两个 root 作用域槽 |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | `apply.mjs` | 两个槽的类型契约（全局 `SlotMap` + factory children 两个面）+ `HeroComposerOwnerProps` |
| `packages/client/ui-conversation/src/client/skeleton/ConversationContent.tsx` | `apply.mjs` | 无会话时渲染 hero 变体的左槽与 dock。**2026-09（e62587c163）前落点是 `ConversationRoot.tsx`**——那次重构把 `heroWorkspaceRow` / `inputBar` 搬进了本文件，前者退化成 13 行转发壳 |
| `packages/client/ui-theme/src/client/index.ts`（四套主题） | `platform/dsh-plugins/lumo-ui/src/client/themes.ts` | `ctx.theme.register(definition)` —— 上游原生的公开扩展点 |
| `packages/client/ui-theme/src/client/index.ts`（主题 cookie） | 同上 `persistLumoTheme()` | 登录页等预壳层读同名 cookie（`user-auth/src/html.ts`） |
| `packages/client/ui-theme/src/theme-settings.ts` | `lumo-ui/src/theme-catalog.ts` | 产品主题走 localStorage，不进上游 settings 文档，因此不需要扩上游的 `THEME_PREFERENCES` 枚举 |
| `packages/client/ui-theme/src/client/AppearanceRow.tsx` + `.module.css` | `lumo-ui/src/client/index.tsx` 的主题选择器 | 自有 UI，不改上游那一行 |
| `packages/client/ui-theme/src/client/locales.ts` | `lumo-ui/src/theme-catalog.ts` `LUMO_THEME_OPTIONS` | 主题名与顺序 |
| `packages/client/ui-theme/src/client/settings-store.ts` | `lumo-ui/src/theme-catalog.ts` `LUMO_DEFAULT_THEME` | 默认主题 |
| `packages/client/ui-theme/src/boot-theme.ts` | `lumo-ui/src/boot-theme.ts` | 在 `webserver/index-inject` 事件上再推一条 body 脚本。body 行按 table 顺序拼接，本插件晚于 ui-theme 注册，后写的 DOM 字段赢 |
| `packages/client/ui-theme/tests/*.spec`（5 个） | —— | 上述上游改动的配套用例，随之还原 |
| `packages/client/web/src/boot.ts`、`boot-client.ts` | `apply.mjs` | `fcc0ad46` 起复用上游原生启动审计，源码保持原样：可选插件失败记录警告，关键插件失败阻断启动。旧版仍兼容原有 `ClientActivationError` 降级；未知启动布局由锚点检查拒绝 |
| `packages/client/modules/src/client/entries.ts` | `apply.mjs` | `fcc0ad46` 起保留上游原生逐条创建错误隔离和重试身份；旧版由覆盖层补齐。两种布局都等待其余插件完成，避免单个可选插件创建失败提前终止启动审计 |

主题 id、标签、配色模式的唯一真相源是 `lumo-ui/src/theme-catalog.ts`：宿主侧的引导脚本
和浏览器侧的注册都读它。将来加一套浅色主题，引导脚本会自动跟着变，而不是继续硬编码
`dark`。

## 上游树已还原,并改为跟随 master

迁移已完成，上游那 20 个改动已还原：20 个已跟踪文件 `checkout`，345 个未跟踪残留（344 个
tsc 泄漏的 `.js`/`.d.ts`/`.map`，外加一张 `apps/web/public/branding/logo.png`——它的真相源是
`platform/desktop-assets/lumo-logo.png`，由 `brand-web.mjs` 在 dist 上重新落地）一并 `clean` 掉。
随后 checkout 曾从 `dsh-v0.1.1-rc.2` 快进到 `origin/master`。当前发布与 CI 使用
`platform/dsh-pin.json` 固定提交；nightly 才跟踪 master，更新 pin 前先跑兼容检查。

复核用的三条命令，任何时候都应当全绿：

```sh
git -C deepseek-harness status --porcelain -uno   # 无输出
git -C deepseek-harness describe --tags --dirty   # 不以 -dirty 结尾（版本号本来就会动）
node platform/dsh-overrides/assert-pristine.mjs deepseek-harness
```

`clean` 千万不要加 `-x`：`node_modules` 和 `lib` 是 gitignore 的，加了会连它们一起删，得重跑
`pnpm install`。

## 跟随 master 的代价落在哪

第一次快进（1079 个提交，上游包数 236 → 256）暴露了两类成本，值得先知道找哪：

| 类别 | 这次的实例 | 谁兜住 |
|---|---|---|
| **锚点漂移** | `InputZone.session` 的类型从 `ConversationSnapshot` 改回 `SessionSnapshot`，把整块当锚的写法失配。改成锚在稳定的 `export interface InputZone {` 声明行上并插到它之前 | `__tests__/overlay.spec.ts`（对着 `git show HEAD:` 的原文跑） |
| **锚点漂移（构建入口）** | 根 `tsdown.config.ts` 的 host 入口从 `{index,invariant,startup}` 改为 `{index,startup}`，旧锚点导致桌面打包在准备隔离副本时失败。`apply.mjs` 兼容两种已知布局，继续改为 `index` 单入口；未知布局仍拒绝并报告失配 | 同上，另固定测试两代入口的兼容与幂等 |
| **锚点漂移（座位搬家）** | `e62587c163` 把 hero composer 的渲染点从 `ConversationRoot.tsx` 搬进 `ConversationContent.tsx`（前者退化成 13 行转发壳），同时把 hero 座位从 `ConversationSlotProps` 的 `PropsRenderSlots` 联合挪进 `SlotFactoryMap.children`、把 `hero.agentPreset` 的 scope 从 `root` 改成 `session-maybe` | 同上。**锚点一律只锚座位名、不锚 scope**：带 scope 的整行锚每次 scope 调整都会失配 |
| **上游删包** | `be531688f3` 移除了整个 `@deepseek-ai/dsh-client-runtime`，`ctx.slots`(`SlotRegistry`) 迁到 `@deepseek-ai/dsh-client-ui-renderer`。lumo-ui 跟着改了 5 个声明面：两处 `ClientContext` 类型导入改走 `import type { Context as ClientContext } from '@deepseek-ai/cordis'`（上游 `ui-theme` 的同款写法）、`package.json` 的 `dependencies` 与 `dsh.client.inject`、`tsconfig.json` 的 `references`、`tsdown.config.ts` 的 `external` | `pnpm test` |
| **锚点漂移（流韧性）** | 2026-10 上游把 gateway `stream-server.ts` 的 `send()` 回调体从 `if (error) reject(error) / else resolve()` 改成 early-return + `alive()` 活跃度记账（并在 send 前后加 `queued` 判定）。`LUMO_STREAM_BACKPRESSURE` 原先把整块（含回调体）当锚 → 桌面打包在 `beforeBuildCommand` 上失配 | `__tests__/overlay.spec.ts` 的「两代回调体」用例。补丁改为**只锚 send() 的结构骨架**（`delivery = this.writes.then(...)`、readyState 守卫、`socket.send(text, cb)` 调用行、`writes = delivery.catch(...)`），销表从回调内挪到 promise 的 `finally` —— 语义等价，且不再需要知道回调体长什么样 |

一次重构常同时漂移多处锚点，而 `replaceExactlyOnce` 在第一个失配处就抛错——逐个修要跑
N 遍完整桌面构建才知道下一个卡在哪。`apply.mjs` 的 `diagnoseOverlayAnchors()` 把清单一次
报全，`__tests__/overlay.spec.ts` 的第一条用例就是它的常驻版本：

```sh
corepack pnpm -C platform test dsh-overrides/__tests__/overlay.spec.ts
```

锚点一漂，这条用例当场红，失败信息里直接给出文件、锚点文本与失配形态（`missing` /
`ambiguous`），不必等到打桌面包。它跟其余用例一样对着 `git show HEAD:` 的原文跑，所以
`git pull` 之后先跑它，比 `cargo tauri build` 快几个数量级。

检查针对传入 checkout 的 HEAD；发布和 CI 使用 `platform/dsh-pin.json` 固定提交，nightly 才跟踪 master。2026-10 曾因本地与 CI 的提交不同造成“本机全绿、打包失败”。因此升级时必须对准拟发布提交检查，不能用旧 HEAD 的通过代替目标 pin 的证据。master 的一次性诊断可以额外检查前向兼容：

```sh
curl -sSL -o /tmp/dsh-master.tar.gz https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/refs/heads/master
mkdir -p /tmp/dsh-master && tar -xzf /tmp/dsh-master.tar.gz -C /tmp/dsh-master --strip-components=1
node -e "import('./platform/dsh-overrides/apply.mjs').then(m => console.log(m.diagnoseOverlayAnchors('/tmp/dsh-master')))"
```

诊断会就地改坏传进去的那棵树（收集模式照常落盘），所以每次都重新解包一份，别复用。

上游工作区保持洁净不等于覆盖层“零 rebase”。这些字符串锚点仍需要升级适配，隔离副本也不是已兑现零源码覆盖的证明。上面的退出计划用于逐步归还这些兼容成本；本轮仅补清单、真实审计和文档，没有新增覆盖行为。

**快进之后必须在 dsh 树里重跑装配**，否则平台套件会撞上过期产物：

```sh
corepack pnpm -C deepseek-harness install     # 新的依赖边需要新的 workspace 软链
corepack pnpm -C deepseek-harness run build   # lib/types 的 .d.ts 也得跟着重出
```

两条都是 CLAUDE.md 明确允许的「读与跑」——它们只写 `node_modules/` 和 `lib/`（都被 gitignore）。
跑完照例查一遍上面那三条洁净度命令；`pnpm-lock.yaml` 若被改动，按「意外」处理并还原。

覆盖层的锚点回归由 `pnpm test` 覆盖：`__tests__/overlay.spec.ts` 直接对着 `git show HEAD:`
的上游原文跑，锚点漂移会当场变红，而不是等到打包时才炸。

`platform/vitest.config.ts` 排除了 `.build/**`：暂存副本带着上游自己的用例，且
`node_modules` 是软链回源树的，不排除就会把上游测试拖进平台套件里大面积失败。

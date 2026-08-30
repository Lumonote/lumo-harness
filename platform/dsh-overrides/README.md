# DSH 覆盖层 —— 上游改动的合法落点

`deepseek-harness/` 是只读的（[第一铁律](../../CLAUDE.md)）。产品需要的每一处上游行为
变更，都必须落在本目录或某个 platform 插件里，**不能落在那棵树上**。

本文件同时是一份迁移账本：曾经直接改在上游树里的 20 个文件，各自搬到了哪。

## 三个脚本

| 脚本 | 作用 | 谁调用 |
|---|---|---|
| `assert-pristine.mjs` | 上游洁净度闸门。已跟踪文件有改动，或 `apps/`、`packages/` 下出现未跟踪且未被 gitignore 排除的文件，立即失败 | `prepare-runtime.mjs`（构建前）、`build-runtime.mjs` 与 `local-runtime.sh`（构建后） |
| `prepare-runtime.mjs` | 把 `git ls-files` 列出的文件复制成隔离副本（`platform/.build/deepseek-harness`），软链 workspace 的 `node_modules`，再对**副本**打 `apply.mjs` 的补丁 | `desktop/build-runtime.mjs`、`desktop/local-runtime.sh` |
| `apply.mjs` | 给副本加两个首页 composer 扩展位。**只允许作用于隔离副本，永不作用于上游工作区** | `prepare-runtime.mjs` |
| `brand-web.mjs` | 在 `apps/web/dist/` 构建产物上覆盖 Lumo 品牌（图标、标题、PWA manifest） | 同上 |

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
| `packages/client/ui-conversation/src/client/apply.ts` | `apply.mjs` | 声明 `conversation.hero.input.left` / `conversation.hero.composer.dock` 两个 root 作用域槽 |
| `packages/client/ui-conversation/src/client/contract/slots.ts` | `apply.mjs` | 两个槽的类型契约 + `HeroComposerOwnerProps` |
| `packages/client/ui-conversation/src/client/skeleton/ConversationRoot.tsx` | `apply.mjs` | 无会话时渲染 hero 变体的左槽与 dock |
| `packages/client/ui-theme/src/client/index.ts`（四套主题） | `platform/dsh-plugins/lumo-ui/src/client/themes.ts` | `ctx.theme.register(definition)` —— 上游原生的公开扩展点 |
| `packages/client/ui-theme/src/client/index.ts`（主题 cookie） | 同上 `persistLumoTheme()` | 登录页等预壳层读同名 cookie（`user-auth/src/html.ts`） |
| `packages/client/ui-theme/src/theme-settings.ts` | `lumo-ui/src/theme-catalog.ts` | 产品主题走 localStorage，不进上游 settings 文档，因此不需要扩上游的 `THEME_PREFERENCES` 枚举 |
| `packages/client/ui-theme/src/client/AppearanceRow.tsx` + `.module.css` | `lumo-ui/src/client/index.tsx` 的主题选择器 | 自有 UI，不改上游那一行 |
| `packages/client/ui-theme/src/client/locales.ts` | `lumo-ui/src/theme-catalog.ts` `LUMO_THEME_OPTIONS` | 主题名与顺序 |
| `packages/client/ui-theme/src/client/settings-store.ts` | `lumo-ui/src/theme-catalog.ts` `LUMO_DEFAULT_THEME` | 默认主题 |
| `packages/client/ui-theme/src/boot-theme.ts` | `lumo-ui/src/boot-theme.ts` | 在 `webserver/index-inject` 事件上再推一条 body 脚本。body 行按 table 顺序拼接，本插件晚于 ui-theme 注册，后写的 DOM 字段赢 |
| `packages/client/ui-theme/tests/*.spec`（5 个） | —— | 上述上游改动的配套用例，随之还原 |

主题 id、标签、配色模式的唯一真相源是 `lumo-ui/src/theme-catalog.ts`：宿主侧的引导脚本
和浏览器侧的注册都读它。将来加一套浅色主题，引导脚本会自动跟着变，而不是继续硬编码
`dark`。

## 还原上游树

迁移已经完成，上游那 20 个改动可以还原了。**这几条命令会写 `deepseek-harness/`，按第一铁律
须由你本人执行**：

```sh
# 1. 还原 20 个已跟踪文件
git -C deepseek-harness checkout -- .

# 2. 删掉 345 个编译产物与品牌资源（-x 千万不要加：node_modules 和 lib 是 gitignore 的，
#    加了 -x 会连它们一起删，得重跑 pnpm install）
git -C deepseek-harness clean -fd apps packages

# 3. 验证
git -C deepseek-harness describe --tags --dirty   # 须为 dsh-v0.1.1-rc.2，无 -dirty
git -C deepseek-harness status --porcelain -uno   # 须无输出
node platform/dsh-overrides/assert-pristine.mjs deepseek-harness
```

第 3 步全部通过之后，跑一次 `pnpm test` 与桌面预览（`platform/desktop/local-runtime.sh`）
确认功能没丢。覆盖层的锚点回归由 `pnpm test` 覆盖：`__tests__/overlay.spec.ts` 直接对着
`git show HEAD:` 的上游原文跑，锚点漂移会当场变红，而不是等到打包时才炸。

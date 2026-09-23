# Build the official dsh source and the Lumo adapter from this repository.
# deepseek-harness is intentionally git-ignored in the host repository, but it
# is part of this build context and is the authoritative local source.
FROM node:22-bookworm-slim

# `node` 基镜像不带 C 工具链，而 dsh 的构建要编一个原生插件
# （`native/system/scripts/build.ts --host-addon-only` 直接用 `cc`）。少了它，
# 构建在第 14 步以 `spawnSync cc ENOENT` 失败——错误里只说「找不到 cc」，
# 看不出是哪一步需要它，所以在这里写明。python3 同理：`node-gyp` 依赖它。
#
# 重试与 `go mod download` 那一步同源：deb.debian.org 会间歇性返回 502
# （2026-09-17 实测连续两次，每次换一批包），而镜像源抖动不该让整个构建失败。
#
# **最后一次尝试必须显式 `exit 1`**：`for` 循环的退出码是循环体最后一条命令的，
# 而最后一条是 `sleep`/`echo`（成功）——不显式退出的话，五次全失败也会以 0 收尾，
# `&& rm -rf …` 照常执行，镜像带着**没装上的工具链**被标记为构建成功。
# 这与本仓库反复记的「静默成功」是同一个形态。
RUN set -e; \
    for attempt in 1 2 3 4 5; do \
      if apt-get update \
         && apt-get install -y --no-install-recommends \
            ca-certificates build-essential python3 python3-pip python3-venv; then \
        break; \
      fi; \
      if [ "$attempt" = 5 ]; then echo "apt-get 五次均失败，放弃" >&2; exit 1; fi; \
      echo "apt-get 第 ${attempt} 次失败，重试" >&2; \
      sleep 5; \
    done; \
    rm -rf /var/lib/apt/lists/*; \
    corepack enable
WORKDIR /workspace

COPY deepseek-harness/pnpm-lock.yaml /workspace/deepseek-harness/pnpm-lock.yaml
COPY deepseek-harness/pnpm-workspace.yaml /workspace/deepseek-harness/pnpm-workspace.yaml
COPY deepseek-harness/package.json /workspace/deepseek-harness/package.json
# 补丁也必须在 fetch **之前**进来：`pnpm-workspace.yaml` 的 patchedDependencies 指向
# `patches/@electron__osx-sign@1.3.3.patch`（还有两个），少了它 pnpm 直接以
# `ERR_PNPM_PATCH_NOT_FOUND` 失败——镜像根本建不出来。原先 patches/ 跟着下面第 21 行的
# 整树 COPY 一起进来，那已经太晚了。
#
# 放在这一层是对的、不是权宜：补丁与 lockfile 同属「决定下载什么」的输入。改补丁本来就
# 该让这一层失效，而改源码不该——这条分层规则本身没变。
COPY deepseek-harness/patches /workspace/deepseek-harness/patches
# Fetch the official harness dependencies before copying its source. This
# layer is keyed on the lockfile alone, so a source-only change to
# deepseek-harness never re-downloads the ~935 packages — the install below
# relinks them from the pre-populated store instead.
RUN cd /workspace/deepseek-harness && pnpm fetch

COPY deepseek-harness /workspace/deepseek-harness
# 清掉「不在 git 里、也没有 package.json」的残留包目录。它们是上游删掉或搬走的包
# 留在开发工作区里的残骸（源与 manifest 都没了，只剩旧 `lib/`），所以上游自己的冷
# checkout 里根本不存在，只有「拿工作区当构建上下文」的这里会被带进来。
#
# 为什么必须清：tsdown 的 workspace glob（`vendor/*`、`packages/*/*`）不看 manifest，
# 只看目录存在；命中这种空壳后它向上回退到根 package.json，于是拿根配置的 entry
# `lib/types/{index,invariant,startup}.js` 去那个目录下面解析 —— 必然解析不到。报错
# 形态随命中的文件数变化：一个都没命中报 `Cannot find entry`（花括号原文保留），
# 只命中 `index.js` 时报 `[UNRESOLVED_ENTRY] Cannot resolve entry module
# lib/types/index.js`。后者就是本构建此前失败的样子，而且两个形态都会让
# `build:lib` 非零退出、`build:lib:client` 永不执行。
#
# 上面 `**/node_modules` 只把它们里的依赖目录排掉了，剩下的旧 `lib/` 恰好够让 glob
# 认为「这是个能构建的包」——所以不能指望 .dockerignore 解决；直接把目录删掉。
# 也不能靠「先跑两面 tsc」：这些目录不在任何 tsconfig 的引用图里，tsc 不会给它们
# 补上缺失的入口，冷热树上都会失败。
RUN cd /workspace/deepseek-harness \
    && for d in vendor/* packages/*/* apps/*; do \
         if [ -d "$d" ] && [ ! -f "$d/package.json" ]; then \
           echo "移除无 package.json 的残留包目录: $d" >&2; \
           rm -rf "$d"; \
         fi; \
       done
COPY platform/dsh-overrides /workspace/platform/dsh-overrides
COPY platform/desktop-assets/lumo-logo.png /workspace/platform/desktop-assets/lumo-logo.png
RUN node /workspace/platform/dsh-overrides/apply.mjs /workspace/deepseek-harness
RUN cd /workspace/deepseek-harness && pnpm install --frozen-lockfile --prefer-offline
# The source checkout can carry ignored lib/ bundles from an older dsh commit.
# Clear those generated outputs after install so the image builds from current
# source and never resolves an old package entry during the workspace bundle.
RUN cd /workspace/deepseek-harness && pnpm clean
# Build the official host/client packages plus the isolated Lumo conversation
# extension overlay in the image. The host checkout is never modified.
#
# 让上游构建脚本依次构建 host 和 client：host tsc + tsdown 先生成 Remote 声明，
# 随后 client tsc 才能消费它们。预先单独运行两个 tsc 聚合会跳过 host tsdown，
# client 编译读到缺失或过期的声明。
#
# 归因更正（2026-09-20 实测）：这里原先记的失败源是「49 个只有浏览器半边的包
# （packages/client/ui-*）的主机入口不在 tsconfig.host.json 的引用图里，冷树上 host 序
# 走不到它们的 lib/types/index.js」——**这个归因不成立**。`clientBundle()` 在 host face
# 下返回 `SKIP_WORKSPACE_BUILD`（见 packages/client/tsdown.client.ts），host 序的 tsdown
# 根本不会去解析这些包的主机入口，缺不缺都不影响它。同一个 `SKIP_WORKSPACE_BUILD`
# 也说明：host 序失败与「client 产物在不在」无关，预跑 client tsc 治不了这件事。
#
# 真正的失败源是上面那步清掉的「没有 package.json 的残留包目录」：glob 命中它 →
# tsdown 向上回退到根 package.json → 拿根配置的 entry
# `lib/types/{index,invariant,startup}.js` 去它下面解析。命中不全时两种报错形态
# （`Cannot find entry` / `[UNRESOLVED_ENTRY] Cannot resolve entry module
# lib/types/index.js`）都指向同一件事。命中数随工作区里残骸的数量漂移，所以
# 「走到第 N 个配置」里的 N 会变（实测 38 与 45 都出现过），不能拿它当定位依据；
# 唯一可靠的判据是报错里的包名 `@deepseek-ai/dsh-root` —— 根包的 name 出现在一个
# 明明不是根包的构建单元上，就说明是这种空壳目录在被构建。
RUN cd /workspace/deepseek-harness \
    && if grep -q '^ref: ' .git/HEAD; then \
         dsh_commit_ref="$(sed 's/^ref: //' .git/HEAD)"; \
         if [ -f ".git/$dsh_commit_ref" ]; then \
           dsh_commit_hash="$(cat ".git/$dsh_commit_ref")"; \
         else \
           dsh_commit_hash="$(awk -v ref="$dsh_commit_ref" '$2 == ref { print $1; exit }' .git/packed-refs)"; \
         fi; \
       else \
         dsh_commit_hash="$(cat .git/HEAD)"; \
       fi \
    && DSH_CLIENT_COMMIT_HASH="$dsh_commit_hash" pnpm build \
    && node /workspace/platform/dsh-overrides/brand-web.mjs /workspace/deepseek-harness

COPY platform/pnpm-lock.yaml /workspace/platform/pnpm-lock.yaml
COPY platform/pnpm-workspace.yaml /workspace/platform/pnpm-workspace.yaml
COPY platform/package.json /workspace/platform/package.json
RUN cd /workspace/platform && pnpm fetch

COPY platform /workspace/platform
RUN cd /workspace/platform && pnpm install --frozen-lockfile --prefer-offline
RUN cd /workspace/platform && pnpm --filter @lumo/dsh-platform-ui run bundle
RUN python3 -m venv /opt/lumo-ppt \
    && /opt/lumo-ppt/bin/python -m pip install --no-cache-dir \
      -r /workspace/platform/upstream/skills/ppt-master/requirements.txt
# Profile plugin management follows the pnpm version pinned by the platform
# workspace. Pre-warm it so first boot can install local link: plugins without
# a runtime package-manager download.
#
# 必须用 `install --global`，不能再用 `prepare`：corepack 0.3x 起 `prepare` 只把版本
# 下载进缓存、**不再设默认版本**，而 `profileManagerEnv` 在启动时导出
# `COREPACK_ENABLE_PROJECT_SPEC=0`（见 src/plugins.ts），corepack 于是既不读项目 pin、
# 也没有默认版本可用，只能去下载 **latest**。2026-09-20 实测下载到 pnpm 12.5.1，
# 它随即拿 dsh 根的 `packageManager: pnpm@11.7.0` 做校验并以 ERR_PNPM_BAD_PM_VERSION
# 退出——`dsh plugin add` 失败、dsh-node exit 1、容器无限重启。`install --global`
# 才真正写默认版本（同时同样预热缓存），使解析结果恒等于工作区 pin。
RUN corepack install --global pnpm@11.7.0

WORKDIR /workspace/platform
ENV NODE_ENV=production
ENV LUMO_BUNDLED_SKILLS_ROOT=/workspace/platform/upstream/skills
ENV LUMO_RUFLO_BIN=/workspace/platform/dsh-plugins/ruflo-orchestration/node_modules/ruflo/bin/ruflo.js
ENV LUMO_PPT_PYTHON=/opt/lumo-ppt/bin/python
CMD ["pnpm", "--filter", "@lumo/dsh-node", "start"]

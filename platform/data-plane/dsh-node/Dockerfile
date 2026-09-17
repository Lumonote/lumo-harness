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
COPY platform/dsh-overrides /workspace/platform/dsh-overrides
COPY platform/desktop-assets/lumo-logo.png /workspace/platform/desktop-assets/lumo-logo.png
RUN node /workspace/platform/dsh-overrides/apply.mjs /workspace/deepseek-harness
RUN cd /workspace/deepseek-harness && pnpm install --frozen-lockfile --prefer-offline
# Build the official host/client packages plus the isolated Lumo conversation
# extension overlay in the image. The host checkout is never modified.
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
RUN python3 -m venv /opt/lumo-ppt \
    && /opt/lumo-ppt/bin/python -m pip install --no-cache-dir \
      -r /workspace/platform/upstream/skills/ppt-master/requirements.txt
RUN cd /workspace/platform && pnpm --filter @lumo/dsh-platform-ui run bundle
# Profile plugin management follows the pnpm version pinned by the platform
# workspace. Pre-warm it so first boot can install local link: plugins without
# a runtime package-manager download.
RUN corepack prepare pnpm@11.7.0

WORKDIR /workspace/platform
ENV NODE_ENV=production
ENV LUMO_BUNDLED_SKILLS_ROOT=/workspace/platform/upstream/skills
ENV LUMO_RUFLO_BIN=/workspace/platform/dsh-plugins/ruflo-orchestration/node_modules/ruflo/bin/ruflo.js
ENV LUMO_PPT_PYTHON=/opt/lumo-ppt/bin/python
CMD ["pnpm", "--filter", "@lumo/dsh-node", "start"]

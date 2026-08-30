# Build the official dsh source and the Lumo adapter from this repository.
# deepseek-harness is intentionally git-ignored in the host repository, but it
# is part of this build context and is the authoritative local source.
FROM node:22-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable
WORKDIR /workspace

COPY deepseek-harness/pnpm-lock.yaml /workspace/deepseek-harness/pnpm-lock.yaml
COPY deepseek-harness/pnpm-workspace.yaml /workspace/deepseek-harness/pnpm-workspace.yaml
COPY deepseek-harness/package.json /workspace/deepseek-harness/package.json
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

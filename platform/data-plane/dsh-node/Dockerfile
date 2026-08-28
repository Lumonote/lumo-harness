# Build the official dsh source and the Lumo adapter from this repository.
# deepseek-harness is intentionally git-ignored in the host repository, but it
# is part of this build context and is the authoritative local source.
FROM node:22-bookworm-slim

RUN corepack enable
WORKDIR /workspace

COPY deepseek-harness /workspace/deepseek-harness
RUN cd /workspace/deepseek-harness && pnpm install --frozen-lockfile
# Build the untouched official host/client packages and Web static assets in
# the image. Some lib directories are intentionally ignored build artifacts in
# the source checkout and are not guaranteed to exist in a clean context.
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
    && DSH_CLIENT_COMMIT_HASH="$dsh_commit_hash" pnpm build

COPY platform /workspace/platform
RUN cd /workspace/platform && pnpm install --frozen-lockfile
RUN cd /workspace/platform && pnpm --filter @lumo/dsh-platform-ui run bundle
# Profile plugin management follows the pnpm version pinned by the official
# Harness checkout. Pre-warm it so first boot can install local link: plugins
# without a runtime package-manager download.
RUN corepack prepare pnpm@11.24.0

WORKDIR /workspace/platform
ENV NODE_ENV=production
CMD ["pnpm", "--filter", "@lumo/dsh-node", "start"]

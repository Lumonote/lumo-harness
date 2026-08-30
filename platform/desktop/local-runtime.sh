#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
platform_root="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
deepseek_source_root="${repo_root}/deepseek-harness"
deepseek_root="${platform_root}/.build/deepseek-harness"

# Preview and packaged builds share one source-isolation rule: copy only files
# tracked by the official nested repository, then apply Lumo's small extension
# overlay to the copy. Nothing below is allowed to compile in the source tree.
node "${platform_root}/dsh-overrides/prepare-runtime.mjs" "${deepseek_source_root}" "${deepseek_root}"

# The DSH Web host serves the built frontend package, not the source
# apps/web/index.html. Build it on a repository preview when a fresh checkout
# has no dist yet; a signed release runtime can set LUMO_AUTO_BUILD_WEB=0.
web_index="${deepseek_root}/apps/web/dist/index.html"
if [[ ! -f "${web_index}" ]]; then
  if [[ "${LUMO_AUTO_BUILD_WEB:-1}" != "1" ]]; then
    echo "Lumo: missing DSH Web frontend: ${web_index}" >&2
    exit 1
  fi
  if ! command -v corepack >/dev/null 2>&1; then
    echo "Lumo: missing corepack; cannot build DSH Web frontend" >&2
    exit 1
  fi
  echo "Lumo: building DSH Web frontend..." >&2
  (cd "${deepseek_root}" && corepack pnpm --filter @deepseek-ai/dsh-client-ui-conversation run bundle)
  (cd "${deepseek_root}" && corepack pnpm --filter @deepseek-ai/dsh-web-frontend run build)
fi
node "${platform_root}/dsh-overrides/brand-web.mjs" "${deepseek_root}"

# This wrapper is for the repository-built desktop preview. A release build
# can replace it with a signed/bundled DSH runtime without changing the Rust
# shell contract.
export LUMO_DEPLOYMENT_MODE=local
export LUMO_DSH_PROFILE=web
export LUMO_DSH_ROOT="${deepseek_root}"
export LUMO_WEB_PORT="${LUMO_WEB_PORT:-3080}"
# Repository-backed creative and orchestration components are installed once
# in the platform workspace. Point the runtime at those exact bytes so a DSH
# profile symlink never changes how their resource roots are resolved.
export LUMO_BUNDLED_SKILLS_ROOT="${LUMO_BUNDLED_SKILLS_ROOT:-${platform_root}/upstream/skills}"
export LUMO_RUFLO_BIN="${LUMO_RUFLO_BIN:-${platform_root}/dsh-plugins/ruflo-orchestration/node_modules/ruflo/bin/ruflo.js}"
ppt_python="${platform_root}/upstream/skills/ppt-master/.venv/bin/python"
if [[ -x "${ppt_python}" ]]; then
  export LUMO_PPT_PYTHON="${LUMO_PPT_PYTHON:-${ppt_python}}"
fi
# A first launch must be self-starting. The installer links the local-mode
# plugins into the user's DSH profile; it never installs server
# middleware or contacts RocketMQ, Nacos, MinIO, Redis, or PostgreSQL.
export LUMO_AUTO_INSTALL_PLUGINS="${LUMO_AUTO_INSTALL_PLUGINS:-1}"
export DSH_HOME="${DSH_HOME:-${HOME}/Library/Application Support/Lumo/dsh}"

cd "${platform_root}/data-plane/dsh-node"
exec node --import tsx src/index.ts

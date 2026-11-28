#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
platform_root="$(cd "${script_dir}/.." && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
deepseek_source_root="${repo_root}/deepseek-harness"
deepseek_root="${platform_root}/.build/deepseek-harness"

# Preview and packaged builds share one source-isolation rule: copy only files
# tracked by the official nested repository, then apply Lumo's small extension
# overlay to the copy. Only ignored generated artifacts may be projected back.
# A preview needs the complete native graph (Host, Client and static manifests).
# Running one conversation package leaves the shell's worker/assets incomplete.
if [[ "${LUMO_AUTO_BUILD_WEB:-1}" == "1" ]]; then
  node "${script_dir}/build-preview.mjs"
else
  node "${platform_root}/dsh-overrides/prepare-runtime.mjs" "${deepseek_source_root}" "${deepseek_root}"
  web_index="${deepseek_root}/apps/web/dist/index.html"
  if [[ ! -f "${web_index}" ]]; then
    echo "Lumo: missing DSH Web frontend: ${web_index}" >&2
    exit 1
  fi
fi
node "${platform_root}/dsh-overrides/brand-web.mjs" "${deepseek_root}"

# The Web build above runs inside the staged copy, whose node_modules are
# symlinked back to the source checkout. Invoke the installed tools directly
# so pnpm cannot relink source dependencies into this snapshot. Re-verify before the
# runtime starts, so a write-back is reported here rather than discovered as
# untracked .js/.d.ts files days later.
node "${platform_root}/dsh-overrides/assert-pristine.mjs" "${deepseek_source_root}"

# This wrapper is for the repository-built desktop preview. A release build
# can replace it with a signed/bundled DSH runtime without changing the Rust
# shell contract.
export LUMO_DEPLOYMENT_MODE=local
export LUMO_DSH_PROFILE=web
export LUMO_DSH_ROOT="${deepseek_root}"
export LUMO_DSH_CLI="${deepseek_root}/apps/cli/lib/bin.js"
export LUMO_WEB_PORT="${LUMO_WEB_PORT:-3080}"
# Repository-backed creative and orchestration components are installed once
# in the platform workspace. Point the runtime at those exact bytes so a DSH
# profile symlink never changes how their resource roots are resolved.
export LUMO_BUNDLED_SKILLS_ROOT="${LUMO_BUNDLED_SKILLS_ROOT:-${platform_root}/upstream/skills}"
export LUMO_RUFLO_BIN="${LUMO_RUFLO_BIN:-${platform_root}/dsh-plugins/ruflo-orchestration/node_modules/ruflo/bin/ruflo.js}"
# install-components.sh 按 target 建 venv；仓库预览取宿主架构那份。
host_arch="$(uname -m)"
[[ "${host_arch}" = "arm64" ]] && host_arch="arm64" || host_arch="x64"
ppt_python="${platform_root}/upstream/skills/ppt-master/.venv-darwin-${host_arch}/bin/python"
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

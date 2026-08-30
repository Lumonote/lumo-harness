#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "${script_dir}/../.." && pwd)"
app="${script_dir}/target/debug/bundle/macos/Lumo.app/Contents/MacOS/lumo-desktop"
web_index="${repo_root}/deepseek-harness/apps/web/dist/index.html"

if [[ ! -x "${app}" ]]; then
  echo "Lumo.app 不存在，请先在 platform/desktop 执行：cargo tauri build --debug --bundles app" >&2
  exit 1
fi

if [[ ! -f "${web_index}" ]]; then
  echo "构建 DSH Web 前端资源..."
  (cd "${repo_root}/deepseek-harness" && corepack pnpm --filter @deepseek-ai/dsh-web-frontend run build)
fi

export LUMO_LOCAL_RUNTIME="${script_dir}/local-runtime.sh"
export LUMO_LOCAL_WEB_PORT="${LUMO_LOCAL_WEB_PORT:-3080}"
export LUMO_SQLITE_PATH="${LUMO_SQLITE_PATH:-${HOME}/Library/Application Support/Lumo/lumo.sqlite}"
export DSH_HOME="${DSH_HOME:-${HOME}/Library/Application Support/Lumo/dsh}"

echo "Lumo 本地单机预览"
echo "SQLite: ${LUMO_SQLITE_PATH}"
echo "运行时: ${repo_root}/platform/data-plane/dsh-node"
exec "${app}"

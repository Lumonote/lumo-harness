#!/usr/bin/env bash
set -euo pipefail

# 用法：install-components.sh [--target darwin-arm64|darwin-x64|win-x64]
# PPT venv 按 target 分目录（skills/ppt-master/.venv-<target>）；native wheel 决定了
# 它只能在同平台同架构宿主上建，跨平台会直接报错。默认宿主架构。
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
platform_root="$(cd "${script_dir}/.." && pwd)"
dsh_root="$(cd "${platform_root}/.." && pwd)/deepseek-harness"
ppt_root="${script_dir}/skills/ppt-master"
bootstrap_python="${LUMO_PPT_BOOTSTRAP_PYTHON:-}"

raw_host_os="$(uname -s)"
case "${raw_host_os}" in
  Darwin) host_os="Darwin" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT) host_os="Windows" ;;
  *) host_os="${raw_host_os}" ;;
esac
host_arch="$(uname -m)"
case "${host_arch}" in
  arm64|aarch64|ARM64) host_arch="arm64" ;;
  x86_64|amd64|AMD64|x64) host_arch="x64" ;;
esac
if [[ "${host_os}" == "Windows" ]]; then
  host_target="win-${host_arch}"
  native_platform="win32"
  native_pty_target="win32-${host_arch}"
else
  host_target="darwin-${host_arch}"
  native_platform="darwin"
  native_pty_target="darwin-${host_arch}"
fi
target="${LUMO_DESKTOP_TARGET:-}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) [[ $# -ge 2 ]] || { echo "--target 需要参数" >&2; exit 64; }; target="$2"; shift 2 ;;
    --target=*) target="${1#*=}"; shift ;;
    *) echo "usage: $0 [--target darwin-arm64|darwin-x64|win-x64]" >&2; exit 64 ;;
  esac
done
[[ -n "${target}" ]] || target="${host_target}"
case "${target}" in
  darwin-arm64|darwin-x64|win-x64) ;;
  *) echo "Lumo: 不支持的 target：${target}（可用：darwin-arm64, darwin-x64, win-x64）" >&2; exit 64 ;;
esac
if [[ ( "${host_os}" != "Darwin" && "${host_os}" != "Windows" ) || "${target}" != "${host_target}" ]]; then
  echo "Lumo: ${target} 的 PPT venv 必须在同平台同架构宿主上建（当前 ${host_os} ${host_target}）：native wheel 无法跨平台安装。" >&2
  exit 1
fi
ppt_venv="${ppt_root}/.venv-${target}"
if [[ "${target}" == "win-x64" && "${host_arch}" != "x64" ]]; then
  echo "Lumo: Windows 桌面包目前只支持 x64 构建机（当前架构：${host_arch}）。" >&2
  exit 1
fi

if [[ -z "${bootstrap_python}" ]]; then
  bootstrap_python="$(command -v python3 || command -v python || command -v py || true)"
fi
if [[ -z "${bootstrap_python}" || ! -x "${bootstrap_python}" ]]; then
  echo "Lumo: 安装 PPT Master 需要 Python 3.10+；也可设置 LUMO_PPT_BOOTSTRAP_PYTHON。" >&2
  exit 1
fi
"${bootstrap_python}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
  echo "Lumo: PPT Master 要求 Python 3.10+。" >&2
  exit 1
}
if [[ ! -f "${ppt_root}/requirements.txt" ]]; then
  echo "Lumo: 找不到固定的 PPT Master Skill：${ppt_root}" >&2
  exit 1
fi

if [[ "${host_os}" == "Windows" ]]; then
  venv_python="${ppt_venv}/Scripts/python.exe"
else
  venv_python="${ppt_venv}/bin/python"
fi
if [[ ! -x "${venv_python}" ]]; then
  "${bootstrap_python}" -m venv "${ppt_venv}"
fi
"${venv_python}" -m pip install -r "${ppt_root}/requirements.txt"

cd "${platform_root}"

# Optional native packages are split across the platform and upstream DSH
# workspaces. They are commonly left stale when a developer switches between
# Rosetta/x64 and arm64, so inspect both dependency trees independently.
native_path_exists() {
  local pattern="$1"
  local root
  for root in "${platform_root}/node_modules" "${platform_root}/data-plane/dsh-node/node_modules" "${dsh_root}/node_modules"; do
    [[ -d "${root}" ]] || continue
    if find "${root}" -path "${pattern}" -print -quit 2>/dev/null | grep -q .; then
      return 0
    fi
  done
  return 1
}

native_target_ready() {
  local arch="$1"
  native_path_exists "*/onnxruntime-node/bin/napi-v6/${native_platform}/${arch}" \
    && native_path_exists "*/node-pty/prebuilds/${native_pty_target}/pty.node"
}

keep_only_directory() {
  local directory="$1"
  local keep="$2"
  local entry
  [[ -d "${directory}" ]] || return 0
  for entry in "${directory}"/*; do
    [[ -e "${entry}" ]] || continue
    [[ "$(basename "${entry}")" == "${keep}" ]] || rm -rf -- "${entry}"
  done
}

prune_non_target_native_payloads() {
  local root
  local napi_root
  local pty_root
  for root in "${platform_root}/node_modules" "${platform_root}/data-plane/dsh-node/node_modules" "${dsh_root}/node_modules"; do
    [[ -d "${root}" ]] || continue
    while IFS= read -r -d '' napi_root; do
      keep_only_directory "${napi_root}" "${native_platform}"
      keep_only_directory "${napi_root}/${native_platform}" "${host_arch}"
    done < <(find "${root}" -path '*/onnxruntime-node/bin/napi-*' -type d -print0 2>/dev/null)
    while IFS= read -r -d '' pty_root; do
      keep_only_directory "${pty_root}" "${native_pty_target}"
    done < <(find "${root}" -path '*/node-pty/prebuilds' -type d -print0 2>/dev/null)
  done
}

corepack_bin="$(command -v corepack || command -v corepack.cmd || true)"
if [[ -z "${corepack_bin}" ]]; then
  echo "Lumo: 安装桌面组件需要 corepack（随 Node.js 提供）。" >&2
  exit 1
fi

run_pnpm() {
  "${corepack_bin}" pnpm "$@"
}

run_pnpm_install() {
  # Network flags are install options; pnpm rebuild rejects them.
  run_pnpm --registry "${LUMO_NPM_REGISTRY:-https://registry.npmjs.org}" \
    --network-concurrency=8 --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=10000 "$@"
}

refresh_native=0
if [[ "${LUMO_FORCE_NATIVE_INSTALL:-0}" == "1" ]] || ! native_target_ready "${host_arch}"; then
  echo "Lumo: ${host_target} 原生 optional 依赖缺失，定向刷新 onnxruntime-node/node-pty。"
  refresh_native=1
fi
run_pnpm_install --config.confirmModulesPurge=false install --frozen-lockfile

if [[ ${refresh_native} -eq 1 ]]; then
  # node-pty belongs to the upstream DSH workspace, not the platform workspace.
  # `rebuild` alone reuses the already-installed store: a scoped
  # `pnpm --filter <pkg> install` would PRUNE the shared .pnpm store down to
  # that single package's dependency graph, deleting vite/onnxruntime-node and
  # hundreds of other packages the web shell build needs next (see the
  # "Cannot find module vite" desktop build failures). Never run a filtered
  # install here — the developer checkout's node_modules is the source of truth.
  # Rebuilding onnxruntime-node explicitly reruns its downloader even when the
  # regular platform install reports "Already up to date".
  if [[ -f "${dsh_root}/pnpm-lock.yaml" ]]; then
    if ! (
      cd "${dsh_root}"
      run_pnpm --filter @deepseek-ai/dsh-subprocess-local rebuild node-pty
    ); then
      echo "Lumo: [WARN] node-pty 定向刷新失败，将继续构建（PTY 能力不可用）。" >&2
    fi
  else
    echo "Lumo: [WARN] 找不到 deepseek-harness 工作区，跳过 node-pty 刷新：${dsh_root}" >&2
  fi
  if ! run_pnpm rebuild onnxruntime-node; then
    echo "Lumo: [WARN] onnxruntime-node 定向刷新失败，将继续构建（原生推理不可用）。" >&2
  fi
fi

prune_non_target_native_payloads
echo "Lumo: 已清理非 ${host_target} 的 onnxruntime-node/node-pty 原生载荷。"

if ! native_target_ready "${host_arch}"; then
  echo "Lumo: [WARN] 仍缺少 ${host_target} 的部分 onnxruntime-node/node-pty 原生 optional 依赖。" >&2
  echo "Lumo: [WARN] 桌面构建继续；对应的原生推理或 PTY 能力将在运行时降级。" >&2
fi

echo "Lumo: 图像风格库、Archify、PPT Master（${target}，${ppt_venv}）与 Ruflo 组件已安装。"

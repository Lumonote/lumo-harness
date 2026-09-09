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

# 打包器要求 PPT 解释器可重定位（build-runtime.mjs bundlePptPython：otool -L 只许系统库，
# 复制进 app 资源后要在没有该开发机路径的机器上运行）。Homebrew 的 python 链接 Cellar
# 绝对路径，会走到打包阶段才失败——这里提前校验并给正确指引（python.org 官方安装包或
# uv 管理的 standalone Python 都是 @rpath/系统库依赖，可重定位）。
python_is_portable() {
  local binary="$1" dep
  while IFS= read -r dep; do
    [[ -n "${dep}" ]] || continue
    [[ "${dep}" == *: ]] && continue # otool 头部行（二进制路径:），非依赖
    [[ "${dep}" == /usr/lib/* ]] && continue
    [[ "${dep}" == /System/Library/* ]] && continue
    [[ "${dep}" == /Library/Apple/* ]] && continue
    [[ "${dep}" != /* ]] && continue
    return 1
  done < <(otool -L "${binary}" 2>/dev/null | sed -n 's/^[[:space:]]*\([^ ]*\).*/\1/p')
  return 0
}

# 候选解释器能否当 bootstrap：可执行、>=3.10、且（Darwin 上）可重定位。
bootstrap_python_usable() {
  local candidate="$1" resolved
  [[ -n "${candidate}" && -x "${candidate}" ]] || return 1
  resolved="$("${candidate}" -c 'import sys; print(sys.executable)' 2>/dev/null)" || return 1
  [[ -n "${resolved}" ]] || return 1
  "${resolved}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null || return 1
  [[ "${host_os}" != "Darwin" ]] || python_is_portable "${resolved}"
}

# 未显式指定 LUMO_PPT_BOOTSTRAP_PYTHON 时，自动挑一个本机可重定位的解释器，而不是盲取
# PATH 上的 python3——开发机上 Homebrew python 常排在最前，必然过不了可重定位校验。
# 顺序：uv 管理的 standalone → python.org 官方安装包 → PATH（由下面的校验兜底报错）。
resolve_bootstrap_python() {
  local candidate minor
  local -a candidates=()
  if command -v uv >/dev/null 2>&1; then
    # 3.13 优先：与 CI（uv python install 3.13）及开发环境的系统 python3 对齐。
    # PPT Master 的 requirements 在 3.13 上已实测可全部装成 wheel（含 PyMuPDF /
    # skia-pathops / uharfbuzz 等原生包），不再需要回退到 3.12。
    for minor in 3.13 3.12 3.11 3.10; do
      candidate="$(uv python find "${minor}" 2>/dev/null || true)"
      [[ -n "${candidate}" ]] && candidates+=("${candidate}")
    done
  fi
  for candidate in /Library/Frameworks/Python.framework/Versions/*/bin/python3; do
    [[ -x "${candidate}" ]] && candidates+=("${candidate}")
  done
  candidates+=("$(command -v python3 || true)" "$(command -v python || true)" "$(command -v py || true)")
  for candidate in "${candidates[@]}"; do
    if bootstrap_python_usable "${candidate}"; then
      printf '%s' "${candidate}"
      return 0
    fi
  done
  return 1
}

if [[ -z "${bootstrap_python}" ]]; then
  bootstrap_python="$(resolve_bootstrap_python || true)"
  if [[ -n "${bootstrap_python}" ]]; then
    echo "Lumo: 自动选用可重定位解释器：${bootstrap_python}" >&2
  else
    # 本机一个可重定位的都没有：退回 PATH，让下面的校验按原样报错并给指引。
    bootstrap_python="$(command -v python3 || command -v python || command -v py || true)"
  fi
fi
if [[ -z "${bootstrap_python}" || ! -x "${bootstrap_python}" ]]; then
  echo "Lumo: 安装 PPT Master 需要 Python 3.10+；也可设置 LUMO_PPT_BOOTSTRAP_PYTHON。" >&2
  exit 1
fi
"${bootstrap_python}" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
  echo "Lumo: PPT Master 要求 Python 3.10+。" >&2
  exit 1
}
if [[ "${host_os}" == "Darwin" ]] && ! bootstrap_python_usable "${bootstrap_python}"; then
  portable_python="$("${bootstrap_python}" -c 'import sys; print(sys.executable)' 2>/dev/null || true)"
  echo "Lumo: 解释器不可重定位：${portable_python}（链接了 Homebrew/其他绝对路径动态库）。" >&2
  echo "Lumo: 桌面包要求可重定位解释器。请改用 python.org 官方安装包或 uv 管理的 standalone Python：" >&2
  echo "Lumo:   uv python install 3.12 && LUMO_PPT_BOOTSTRAP_PYTHON=\"\$(uv python find 3.12)\" \\" >&2
  echo "Lumo:   ./platform/upstream/install-components.sh --target ${target}" >&2
  exit 1
fi

# ---- 上游快照自愈 ----
# `platform/upstream/skills/` 不入库（.gitignore：快照不留 git，留给本脚本按
# skill-sources.json 的 pin 提交装出）。新 checkout 里它必然是空的，直接对
# 缺失/不完整的快照自动拉取，而不是像以前那样报「找不到固定 PPT Master」硬退。
# 语义与 deploy/lib/dsh-source.sh 的 ensure_dsh_source 一致：可用快照一律不动。
skill_tmp_dir=""
cleanup_skill_tmp() {
  [[ -z "${skill_tmp_dir}" ]] || rm -rf -- "${skill_tmp_dir}"
}
trap cleanup_skill_tmp EXIT

# 快照是否可用：SKILL.md 是三者共有的入口标记；PPT Master 额外需要 requirements.txt
# （脚本后续要 pip install 它，缺失即与旧报错「找不到固定 PPT Master Skill」同因）。
snapshot_usable() {
  local name="$1"
  [[ -f "${script_dir}/skills/${name}/SKILL.md" ]] || return 1
  if [[ "${name}" == "ppt-master" ]]; then
    [[ -f "${script_dir}/skills/ppt-master/requirements.txt" ]] || return 1
  fi
  return 0
}

# 按 skill-sources.json 逐行输出 name / repository / path / commit（tab 分隔）。
list_skill_sources() {
  "${bootstrap_python}" - "${script_dir}/skill-sources.json" <<'PY'
import json
import sys
with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)
for entry in data.get("skills", []):
    print("%s\t%s\t%s\t%s" % (entry["name"], entry["repository"], entry["path"], entry["commit"]))
PY
}

fetch_skill_snapshot() {
  local name="$1" repository="$2" subpath="$3" commit="$4"
  local work="${skill_tmp_dir}/${name}" stale="${skill_tmp_dir}/${name}-stale"
  local target="${script_dir}/skills/${name}" commit_abbr
  commit_abbr="$(printf '%.12s' "${commit}")"
  echo "Lumo: 快照 ${name} 缺失，按固定提交 ${commit_abbr} 拉取自 ${repository} ..." >&2
  if ! git clone --no-checkout --filter=blob:none "${repository}" "${work}"; then
    echo "Lumo: 克隆 ${repository} 失败。请检查网络后重试，或按 platform/upstream/README.md 手动放置快照。" >&2
    exit 1
  fi
  git -C "${work}" sparse-checkout init --cone
  git -C "${work}" sparse-checkout set "${subpath}"
  if ! git -C "${work}" checkout --detach "${commit}"; then
    echo "Lumo: 检出固定提交 ${commit} 失败（${repository}#${commit} 未被克隆到）。" >&2
    exit 1
  fi
  if [[ ! -e "${work}/${subpath}" ]]; then
    echo "Lumo: 仓库 ${repository} 中不存在 ${subpath}（skill-sources.json 的 path 过时？）。" >&2
    exit 1
  fi
  # 快照目录里混放着本机构建产物 .venv-<target>：换新快照前先保全它们。
  rm -rf -- "${stale}"
  if [[ -d "${target}" ]]; then
    mv -- "${target}" "${stale}"
  fi
  mkdir -p -- "${script_dir}/skills"
  cp -R -- "${work}/${subpath}" "${target}"
  local venv_dir
  for venv_dir in "${stale}"/.venv-*; do
    [[ -e "${venv_dir}" ]] || continue
    mv -- "${venv_dir}" "${target}/"
  done
  rm -rf -- "${stale}"
  if ! snapshot_usable "${name}"; then
    echo "Lumo: 已从 ${repository}@${commit} 拉取 ${name}，但内容仍不完整（缺 SKILL.md/requirements.txt）。" >&2
    exit 1
  fi
  echo "Lumo: 快照 ${name} 已就位（${subpath}@${commit_abbr}）。" >&2
}

ensure_skill_snapshots() {
  if [[ ! -f "${script_dir}/skill-sources.json" ]]; then
    echo "Lumo: 找不到来源清单 ${script_dir}/skill-sources.json（它应随仓库入库）。" >&2
    exit 1
  fi
  if ! command -v git >/dev/null 2>&1; then
    echo "Lumo: 快照自愈需要 git，但 PATH 中没有 git。" >&2
    exit 1
  fi
  skill_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumo-skills.XXXXXX")" || {
    echo "Lumo: 无法创建临时目录。" >&2
    exit 1
  }
  local name repository subpath commit skipped=1
  while IFS=$'\t' read -r name repository subpath commit; do
    [[ -n "${name}" ]] || continue
    if snapshot_usable "${name}"; then
      continue
    fi
    skipped=0
    fetch_skill_snapshot "${name}" "${repository}" "${subpath}" "${commit}"
  done < <(list_skill_sources)
  [[ ${skipped} -eq 0 ]] || echo "Lumo: 三个上游快照均已就位，无需自愈。" >&2
}

ensure_skill_snapshots

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

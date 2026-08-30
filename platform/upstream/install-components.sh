#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
platform_root="$(cd "${script_dir}/.." && pwd)"
ppt_root="${script_dir}/skills/ppt-master"
ppt_venv="${ppt_root}/.venv"
bootstrap_python="${LUMO_PPT_BOOTSTRAP_PYTHON:-}"

if [[ -z "${bootstrap_python}" ]]; then
  bootstrap_python="$(command -v python3 || true)"
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

if [[ ! -x "${ppt_venv}/bin/python" ]]; then
  "${bootstrap_python}" -m venv "${ppt_venv}"
fi
"${ppt_venv}/bin/python" -m pip install -r "${ppt_root}/requirements.txt"

cd "${platform_root}"
corepack pnpm --config.confirmModulesPurge=false install --frozen-lockfile

echo "Lumo: 图像风格库、Archify、PPT Master 与 Ruflo 组件已安装。"

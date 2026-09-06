#!/bin/sh
set -eu

runtime_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
state_dir="${LUMO_RUNTIME_STATE_DIR:-${DSH_HOME:-${HOME}/Library/Application Support/Lumo/dsh}/runtime}"
mkdir -p "$state_dir"

export LUMO_PACKAGED_RUNTIME=1
export LUMO_RUNTIME_ROOT="$runtime_root"
export LUMO_RUNTIME_NODE_MODULES="$runtime_root/node_modules"
export LUMO_BUNDLED_SKILLS_ROOT="$runtime_root/skills"
export LUMO_SKILLHUB_COMMAND="${LUMO_SKILLHUB_COMMAND:-$runtime_root/bin/skillhub.mjs}"
export LUMO_RUFLO_BIN="$runtime_root/node_modules/ruflo/bin/ruflo.js"
if [ -x "$runtime_root/python/bin/python3" ]; then
  export LUMO_PPT_PYTHON="${LUMO_PPT_PYTHON:-$runtime_root/python/bin/python3}"
  export PYTHONHOME="${PYTHONHOME:-$runtime_root/python}"
  export PYTHONNOUSERSITE=1
  export PYTHONDONTWRITEBYTECODE=1
fi
export LUMO_DSH_ROOT="$runtime_root"
export LUMO_DSH_CLI="$runtime_root/node_modules/@deepseek-ai/dsh/lib/bin.js"
export LUMO_PATCH_PATH="${LUMO_PATCH_PATH:-$state_dir/lumo.patch.yml}"
export LUMO_AUTO_INSTALL_PLUGINS=0
export DSH_HOME="${DSH_HOME:-${HOME}/Library/Application Support/Lumo/dsh}"
export LUMO_DEPLOYMENT_MODE="${LUMO_DEPLOYMENT_MODE:-local}"
export LUMO_DSH_PROFILE="${LUMO_DSH_PROFILE:-web}"
export LUMO_WEB_PORT="${LUMO_WEB_PORT:-3080}"
# 启动要加载 800+ 个包的模块图，V8 编译占了冷启动的大头。Node 22.1+ 的磁盘编译缓存
# 让第二次起动直接复用字节码；缓存放在 runtime 状态目录，随 DSH_HOME 走，卸载即清。
export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-$state_dir/compile-cache}"
mkdir -p "$NODE_COMPILE_CACHE"

# 插件市场更新插件时需要 pnpm/corepack/npx——它们随 Node 一起打包进 runtime/bin，置入 PATH。
# corepack 下载/缓存 pnpm 到 state 目录，避免写进只读的应用包。
export PATH="$runtime_root/bin:$PATH"
export COREPACK_HOME="${COREPACK_HOME:-$state_dir/corepack}"
export COREPACK_ENABLE_PROJECT_SPEC=0
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
mkdir -p "$COREPACK_HOME"

exec "$runtime_root/node" --experimental-strip-types "$runtime_root/dsh-node/src/index.ts"

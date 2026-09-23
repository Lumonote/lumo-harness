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

# `PROJECT_SPEC=0` 之下 corepack 不读项目 pin，于是**默认版本就是唯一的版本来源**；而没有
# 默认版本时它会去下 **latest**——2026-09-20 容器上实测：latest 漂到 pin 之外后，插件安装
# 直接以 `ERR_PNPM_BAD_PM_VERSION` 失败（dsh-node 无限重启）。这里把默认版本显式装上，
# 版本号与 platform/package.json 的 packageManager 必须一致（门禁
# platform/tools/check-corepack-pin.py 盯着这条链路）。
#
# 只做一次：`lastKnownGood.json` 是 corepack 记录默认版本的地方，装过就跳过，不给每次冷启动
# 加一次网络往返。失败也不拦住启动——没网时插件市场本来就更新不了，让整个 App 起不来更糟。
if [ ! -f "$COREPACK_HOME/lastKnownGood.json" ]; then
  corepack install --global pnpm@11.7.0 >/dev/null 2>&1 ||
    echo "lumo: 未能预装 pnpm 默认版本（离线？）——插件市场更新时会退回到下载最新版" >&2
fi

exec "$runtime_root/node" --experimental-strip-types "$runtime_root/dsh-node/src/index.ts"

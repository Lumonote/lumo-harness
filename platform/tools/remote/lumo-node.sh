#!/bin/sh
# lumo 服务端安装包的启动入口（打包时复制为 <包根>/bin/lumo-node）。POSIX sh。
#   lumo-node run            前台启动 dsh-node（systemd ExecStart / nohup 使用）
#   lumo-node --version      输出 VERSION 中的 version 与 dsh_sha，用于安装自检
#   lumo-node --healthcheck  本机 HTTP 探活：127.0.0.1:$LUMO_WEB_PORT 有响应（状态码 <500）即健康
# 环境变量（可写在 <root>/lumo.env）：LUMO_WEB_PORT（默认 7420，与 SSH 隧道 LUMO_REMOTE_PORT 一致）、
# LUMO_DSH_PROFILE（默认 web）、LUMO_NODE_BIN（默认 PATH 中的 node）。
set -eu
here="$(cd "$(dirname "$0")/.." && pwd -P)"
app="$here/app"
port="${LUMO_WEB_PORT:-7420}"
node_bin="${LUMO_NODE_BIN:-node}"

case "${1:-run}" in
  --version)
    v="$(sed -n 's/^version=//p' "$here/VERSION")"; d="$(sed -n 's/^dsh_sha=//p' "$here/VERSION")"
    [ -n "$v" ] && [ -n "$d" ] || exit 1
    command -v "$node_bin" >/dev/null 2>&1 || { echo "node not found" >&2; exit 1; }
    [ -f "$app/platform/data-plane/dsh-node/src/index.ts" ] || { echo "dsh-node missing" >&2; exit 1; }
    echo "lumo-server $v dsh $d"
    ;;
  --healthcheck)
    if command -v curl >/dev/null 2>&1; then
      code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' "http://127.0.0.1:$port/" || true)"
    else
      code="$("$node_bin" -e "fetch('http://127.0.0.1:$port/',{signal:AbortSignal.timeout(3000)}).then(r=>console.log(r.status),()=>console.log('000'))" 2>/dev/null || echo 000)"
    fi
    case "$code" in ''|000|5??) exit 1 ;; *) exit 0 ;; esac
    ;;
  run)
    export LUMO_WEB_PORT="$port"
    export LUMO_DSH_PROFILE="${LUMO_DSH_PROFILE:-web}"
    export NODE_ENV="${NODE_ENV:-production}"
    export LUMO_BUNDLED_SKILLS_ROOT="${LUMO_BUNDLED_SKILLS_ROOT:-$app/platform/upstream/skills}"
    cd "$app/platform/data-plane/dsh-node"
    exec "$node_bin" "$app/platform/data-plane/dsh-node/node_modules/tsx/dist/cli.mjs" src/index.ts
    ;;
  *) echo "usage: lumo-node run|--version|--healthcheck" >&2; exit 2 ;;
esac

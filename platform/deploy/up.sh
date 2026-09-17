#!/usr/bin/env bash
# Start a Lumo Compose topology after ensuring the read-only DSH source exists.
#
# Deliberately do not fetch, pull, reset, or checkout an existing tree: it may
# be a developer's checkout.  Only an absent directory is bootstrapped from
# the latest commit on the public upstream default branch.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"
dsh_root="$repo_root/deepseek-harness"
# shellcheck source=lib/dsh-source.sh
source "$script_dir/lib/dsh-source.sh"

usage() {
  echo "usage: $0 {cluster|standalone} [docker compose up options]" >&2
  echo "local is the Rust desktop shape; run: pnpm --dir platform desktop:dev" >&2
  echo "example: $0 cluster -d --build" >&2
  echo "extra additive compose files: LUMO_COMPOSE_EXTRA_FILES=a.yml:b.yml $0 cluster -d" >&2
  exit 64
}

warn_legacy_cluster_storage() {
  # 本函数只**警告**，必须永远返回 0。它在 `set -e` 下被当普通命令调用，所以任何一个
  # 非 0 返回都会把整个脚本杀掉。2026-09-15 前正是如此，两条 README 记载的启动路径
  # 都到不了 `docker compose up`：
  #   - `[[ "$shape" == "cluster" ]] || return` 让 `up.sh standalone` **无条件**退出 1；
  #   - `[[ -n "$postgres_container" ]] || return` 让 `up.sh cluster` 在「还没有 postgres
  #     容器」时（即第一次部署）退出 1。
  # 故所有提前返回都显式写 `return 0`，末尾也补 `return 0`。
  [[ "$shape" == "cluster" ]] || return 0

  # Older cluster compose files kept PostgreSQL in the container writable
  # layer. A full Compose recreate with the persistent-volume topology would
  # otherwise initialise an empty pgdata volume. This is only a warning so a
  # focused repair (for example RocketMQ alone) remains possible; the explicit
  # migration command is the safe path before recreating the full topology.
  local compose_file="$script_dir/compose.cluster.yml"
  local postgres_container mount_type
  postgres_container="$(docker compose -f "$compose_file" ps -aq postgres 2>/dev/null | sed -n '1p' || true)"
  # 没有容器 = 还没部署过，不是错误。
  [[ -n "$postgres_container" ]] || return 0
  mount_type="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}{{end}}{{end}}' "$postgres_container" 2>/dev/null || true)"
  [[ "$mount_type" == "volume" ]] && return 0

  echo "warning: legacy Cluster PostgreSQL data is still in the container layer." >&2
  echo "Run ./platform/deploy/migrate-deployment.sh cluster cluster --replace before a full Cluster recreate." >&2
  return 0
}

[[ $# -ge 1 ]] || usage
shape="$1"
shift
case "$shape" in
  cluster|standalone) ;;
  local)
    echo "local 不使用 Docker Compose、RocketMQ、Nacos、MinIO、Redis 或 PostgreSQL。" >&2
    echo "请使用 pnpm --dir platform desktop:dev（SQLite 由 Rust 桌面壳管理）。" >&2
    exit 64
    ;;
  *) usage ;;
esac

ensure_dsh_source "$dsh_root"
warn_legacy_cluster_storage

# 额外的 compose 覆盖文件（冒号分隔），用于本地 / 验收场景——例如把基础设施端口暴露到
# 宿主机（见 compose.cluster.acceptance.yml）。additive：只加不删，所以 preflight 与
# smoke 的服务集检查不受影响。
compose_args=(-f "$script_dir/compose.$shape.yml")
if [[ -n "${LUMO_COMPOSE_EXTRA_FILES:-}" ]]; then
  IFS=':' read -r -a extra_files <<< "$LUMO_COMPOSE_EXTRA_FILES"
  for extra_file in "${extra_files[@]}"; do
    [[ -r "$extra_file" ]] || {
      echo "error: LUMO_COMPOSE_EXTRA_FILES 里的文件不可读: $extra_file" >&2
      exit 66
    }
    compose_args+=(-f "$extra_file")
  done
fi

exec docker compose "${compose_args[@]}" up "$@"

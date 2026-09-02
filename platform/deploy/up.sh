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
  exit 64
}

warn_legacy_cluster_storage() {
  [[ "$shape" == "cluster" ]] || return

  # Older cluster compose files kept PostgreSQL in the container writable
  # layer. A full Compose recreate with the persistent-volume topology would
  # otherwise initialise an empty pgdata volume. This is only a warning so a
  # focused repair (for example RocketMQ alone) remains possible; the explicit
  # migration command is the safe path before recreating the full topology.
  local compose_file="$script_dir/compose.cluster.yml"
  local postgres_container mount_type
  postgres_container="$(docker compose -f "$compose_file" ps -aq postgres 2>/dev/null | sed -n '1p' || true)"
  [[ -n "$postgres_container" ]] || return
  mount_type="$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Type}}{{end}}{{end}}' "$postgres_container" 2>/dev/null || true)"
  [[ "$mount_type" == "volume" ]] && return

  echo "warning: legacy Cluster PostgreSQL data is still in the container layer." >&2
  echo "Run ./platform/deploy/migrate-deployment.sh cluster cluster --replace before a full Cluster recreate." >&2
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
exec docker compose -f "$script_dir/compose.$shape.yml" up "$@"

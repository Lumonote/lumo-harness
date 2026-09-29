#!/usr/bin/env bash
# One command for backup + verified replacement restore.  It supports an
# in-place legacy-to-volume migration as well as Standalone <-> Cluster moves.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"

usage() {
  echo "usage: $0 {cluster|standalone} {cluster|standalone} --replace [backup-directory]" >&2
  exit 64
}

[[ $# -ge 3 && $# -le 4 && "$3" == "--replace" ]] || usage
source_shape="$1"
target_shape="$2"
case "$source_shape:$target_shape" in
  cluster:cluster|cluster:standalone|standalone:cluster|standalone:standalone) ;;
  *) usage ;;
esac

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${4:-$repo_root/backups/lumo-migration-$source_shape-to-$target_shape-$timestamp}"

source_project="${COMPOSE_PROJECT_NAME:-}"
if [[ -z "$source_project" ]]; then
  for candidate in lumo-platform "lumo-platform-$source_shape"; do
    if docker ps -aq \
      --filter "label=com.docker.compose.project=$candidate" \
      --filter label=com.docker.compose.service=postgres | grep -q .; then
      source_project="$candidate"
      break
    fi
  done
fi
source_project="${source_project:-lumo-platform}"

COMPOSE_PROJECT_NAME="$source_project" "$script_dir/backup.sh" "$source_shape" "$backup_dir"

# Old releases used one Compose project per shape. Once the source has a
# verified backup, remove only those old containers so their published ports
# cannot collide with the unified target project. Named volumes are preserved.
if [[ "$source_project" != "lumo-platform" ]]; then
  legacy_compose=(docker compose -p "$source_project"
    -f "$script_dir/compose.shared.yml"
    -f "$script_dir/compose.control-plane.bundle.yml"
    -f "$script_dir/compose.$source_shape.yml")
  if [[ "$source_shape" == "cluster" ]]; then
    legacy_compose+=(-f "$script_dir/compose.cluster.compact.yml"
      --profile cluster-compact --profile cluster-full)
  fi
  legacy_compose+=(--profile provisioner)
  "${legacy_compose[@]}" down --remove-orphans
fi

COMPOSE_PROJECT_NAME=lumo-platform "$script_dir/restore.sh" \
  "$target_shape" "$backup_dir" --replace

echo "migration backup retained at: $backup_dir"

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

"$script_dir/backup.sh" "$source_shape" "$backup_dir"
"$script_dir/restore.sh" "$target_shape" "$backup_dir" --replace

echo "migration backup retained at: $backup_dir"

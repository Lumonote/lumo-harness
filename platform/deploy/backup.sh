#!/usr/bin/env bash
# Create a portable Lumo deployment backup.  The manifest is JSONL compressed
# with zstd; payloads are checksummed before the manifest is sealed.
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/../.." && pwd)"

usage() {
  echo "usage: $0 {cluster|standalone} [backup-directory]" >&2
  exit 64
}

die() {
  echo "backup: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

[[ $# -ge 1 && $# -le 2 ]] || usage
shape="$1"
case "$shape" in
  cluster|standalone) ;;
  *) usage ;;
esac

compose_file="$script_dir/compose.$shape.yml"
[[ -f "$compose_file" ]] || die "Compose file not found: $compose_file"
compose=(docker compose -f "$compose_file")

for command_name in docker zstd shasum tar awk; do
  require_command "$command_name"
done

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup_dir="${2:-$repo_root/backups/lumo-$shape-$timestamp}"
[[ ! -e "$backup_dir" ]] || die "backup destination already exists: $backup_dir"
mkdir -p -- "$(dirname -- "$backup_dir")"
mkdir -m 700 -- "$backup_dir"

stage_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumo-backup.XXXXXX")"
chmod 700 "$stage_dir"
manifest="$stage_dir/backup-manifest.jsonl"
checksums="$backup_dir/SHA256SUMS"
file_count=0
stopped_services=()
quiesced=0

cleanup() {
  local status=$?
  trap - EXIT INT TERM
  if [[ "$quiesced" -eq 1 && "${#stopped_services[@]}" -gt 0 ]]; then
    "${compose[@]}" start "${stopped_services[@]}" >&2 || true
  fi
  rm -rf -- "$stage_dir"
  exit "$status"
}
trap cleanup EXIT INT TERM

container_id() {
  "${compose[@]}" ps -aq "$1" | sed -n '1p'
}

record_file() {
  local relative_path="$1"
  local kind="$2"
  local full_path="$backup_dir/$relative_path"
  local checksum bytes
  checksum="$(shasum -a 256 "$full_path" | awk '{print $1}')"
  bytes="$(wc -c < "$full_path" | tr -d '[:space:]')"
  printf '%s  %s\n' "$checksum" "$relative_path" >> "$checksums"
  printf '{"record":"file","path":"%s","kind":"%s","sha256":"%s","bytes":%s}\n' \
    "$relative_path" "$kind" "$checksum" "$bytes" >> "$manifest"
  file_count=$((file_count + 1))
}

archive_component() {
  local service="$1"
  local container_path="$2"
  local kind="$3"
  local archive_name="$4"
  local container payload_dir
  container="$(container_id "$service")"
  [[ -n "$container" ]] || return 0

  payload_dir="$stage_dir/$service"
  mkdir -p -- "$payload_dir"
  # docker cp works for both named volumes and legacy container-layer data.
  # A private staging directory makes the archive layout unambiguous: the tar
  # always contains the contents of the service data directory, not its name.
  docker cp "$container:$container_path/." "$payload_dir"
  tar -C "$payload_dir" -cf - . | zstd -q -T0 -19 > "$backup_dir/$archive_name"
  rm -rf -- "$payload_dir"
  record_file "$archive_name" "$kind"
}

postgres_container="$(container_id postgres)"
[[ -n "$postgres_container" ]] || die "postgres container does not exist; start the $shape topology first"
[[ "$(docker inspect -f '{{.State.Running}}' "$postgres_container")" == "true" ]] || \
  die "postgres is not running; start it before creating a backup"

# Stop only services that were already running, preserving the caller's
# selected topology. PostgreSQL remains available for a consistent logical
# dump after writers have been quiesced.
while IFS= read -r service; do
  [[ -n "$service" && "$service" != "postgres" ]] || continue
  stopped_services+=("$service")
done < <("${compose[@]}" ps --status running --services || true)
if [[ "${#stopped_services[@]}" -gt 0 ]]; then
  "${compose[@]}" stop --timeout 30 "${stopped_services[@]}"
  quiesced=1
fi

created_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
printf '{"record":"header","format":"lumo-backup","version":1,"shape":"%s","created_at":"%s","manifest_encoding":"jsonl+zstd","checksum":"sha256"}\n' \
  "$shape" "$created_at" > "$manifest"

pg_user="${LUMO_POSTGRES_USER:-lumo}"
pg_database="${LUMO_POSTGRES_DB:-lumo}"
"${compose[@]}" exec -T postgres pg_dump -U "$pg_user" -d "$pg_database" \
  --no-owner --no-privileges | zstd -q -T0 -19 > "$backup_dir/postgres.sql.zst"
record_file "postgres.sql.zst" "postgres-logical"

# Redis is intentionally omitted: it is a rebuildable cache/limit state.
# The remaining directories retain user data, broker state, configuration and
# installed artifacts. Missing optional service containers are simply omitted.
archive_component minio /data minio-data minio.tar.zst
archive_component nacos /home/nacos/data nacos-data nacos.tar.zst
archive_component rocketmq /home/rocketmq/store rocketmq-data rocketmq.tar.zst
archive_component milvus /var/lib/milvus milvus-data milvus.tar.zst
archive_component registry /var/lib/registry/objects registry-objects registry.tar.zst
archive_component provisioner /var/lib/lumo/artifacts provisioner-artifacts provisioner.tar.zst

"${compose[@]}" config --images > "$backup_dir/runtime-images.txt"
record_file "runtime-images.txt" "runtime-images"

printf '{"record":"footer","files":%s,"status":"complete"}\n' "$file_count" >> "$manifest"
zstd -q -T0 -19 "$manifest" -o "$backup_dir/backup-manifest.jsonl.zst"
zstd -tq "$backup_dir/backup-manifest.jsonl.zst"

echo "backup created: $backup_dir"
echo "manifest: $backup_dir/backup-manifest.jsonl.zst"

#!/usr/bin/env bash
# Restore a Lumo backup into a Compose topology.  This is deliberately an
# explicit replacement operation: it removes target containers, never volumes,
# then verifies payload checksums before replacing their contents.
set -euo pipefail
umask 077

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

usage() {
  echo "usage: $0 {cluster|standalone} BACKUP_DIRECTORY --replace" >&2
  exit 64
}

die() {
  echo "restore: $*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

[[ $# -eq 3 && "$3" == "--replace" ]] || usage
shape="$1"
case "$shape" in
  cluster|standalone) ;;
  *) usage ;;
esac
[[ -d "$2" ]] || die "backup directory does not exist: $2"
backup_dir="$(cd -- "$2" && pwd -P)"
compose_file="$script_dir/compose.$shape.yml"
compose=(docker compose -f "$compose_file")

for command_name in docker zstd shasum tar awk; do
  require_command "$command_name"
done
[[ -f "$backup_dir/backup-manifest.jsonl.zst" ]] || die "missing backup manifest"
[[ -f "$backup_dir/SHA256SUMS" ]] || die "missing SHA256SUMS"
zstd -tq "$backup_dir/backup-manifest.jsonl.zst" || die "manifest zstd integrity check failed"

header="$(zstd -dc "$backup_dir/backup-manifest.jsonl.zst" | sed -n '1p')"
[[ "$header" == *'"record":"header"'* && "$header" == *'"format":"lumo-backup"'* && "$header" == *'"manifest_encoding":"jsonl+zstd"'* ]] || \
  die "manifest header is not a supported Lumo JSONL+zstd backup"
source_shape="$(printf '%s\n' "$header" | sed -n 's/.*"shape":"\([a-z]*\)".*/\1/p')"
[[ "$source_shape" == "cluster" || "$source_shape" == "standalone" ]] || die "manifest shape is invalid"

while IFS='  ' read -r expected relative_path; do
  [[ -n "$expected" && -n "$relative_path" ]] || die "malformed SHA256SUMS"
  [[ "$relative_path" != /* && "$relative_path" != *".."* && "$relative_path" != */* ]] || \
    die "unsafe payload path in SHA256SUMS: $relative_path"
  [[ -f "$backup_dir/$relative_path" ]] || die "missing payload: $relative_path"
done < "$backup_dir/SHA256SUMS"
(cd "$backup_dir" && shasum -a 256 -c SHA256SUMS) || die "payload checksum verification failed"

validate_archive_paths() {
  local archive="$1"
  local unsafe_path
  unsafe_path="$(zstd -dc "$archive" | tar -tf - | awk '
    /^\// || /(^|\/)\.\.($|\/)/ { print; exit 1 }
  ')" || die "archive cannot be read safely: $(basename -- "$archive")"
  [[ -z "$unsafe_path" ]] || die "archive contains unsafe path: $unsafe_path"
}

service_exists() {
  "${compose[@]}" config --services | awk -v wanted="$1" '$0 == wanted { found = 1 } END { exit !found }'
}

container_id() {
  "${compose[@]}" ps -aq "$1" | sed -n '1p'
}

volume_for_path() {
  local container="$1"
  local container_path="$2"
  docker inspect --format "{{range .Mounts}}{{if and (eq .Type \"volume\") (eq .Destination \"$container_path\")}}{{.Name}}{{end}}{{end}}" "$container"
}

restore_components=()
component_specs=(
  "minio|/data|minio.tar.zst"
  "nacos|/home/nacos/data|nacos.tar.zst"
  "rocketmq|/home/rocketmq/store|rocketmq.tar.zst"
  "milvus|/var/lib/milvus|milvus.tar.zst"
  "registry|/var/lib/registry/objects|registry.tar.zst"
  "provisioner|/var/lib/lumo/artifacts|provisioner.tar.zst"
)
for spec in "${component_specs[@]}"; do
  IFS='|' read -r service container_path archive_name <<< "$spec"
  [[ -f "$backup_dir/$archive_name" ]] || continue
  service_exists "$service" || die "backup contains $service data, but target $shape has no $service service"
  validate_archive_paths "$backup_dir/$archive_name"
  restore_components+=("$spec")
done

[[ -f "$backup_dir/postgres.sql.zst" ]] || die "backup is missing postgres.sql.zst"

echo "restoring $source_shape backup into $shape; target containers and data volumes will be replaced"
# This is the destructive boundary confirmed by --replace.  Volumes are kept
# because their contents are restored below; no `down -v` is ever issued.
"${compose[@]}" down --remove-orphans

create_services=(postgres)
for spec in "${restore_components[@]}"; do
  IFS='|' read -r service _ <<< "$spec"
  create_services+=("$service")
done
"${compose[@]}" create "${create_services[@]}"

for spec in "${restore_components[@]}"; do
  IFS='|' read -r service container_path archive_name <<< "$spec"
  target_container="$(container_id "$service")"
  [[ -n "$target_container" ]] || die "failed to create target container for $service"
  target_volume="$(volume_for_path "$target_container" "$container_path")"
  [[ -n "$target_volume" ]] || die "$service data path is not backed by a named volume: $container_path"
  docker run --rm -v "$target_volume:/payload" alpine:3.20 \
    sh -ec 'find /payload -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +'
  zstd -dc "$backup_dir/$archive_name" | \
    docker run --rm -i -v "$target_volume:/payload" alpine:3.20 tar -C /payload -xpf -
done

pg_user="${LUMO_POSTGRES_USER:-lumo}"
pg_database="${LUMO_POSTGRES_DB:-lumo}"
[[ "$pg_user" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || die "unsupported PostgreSQL user name: $pg_user"
[[ "$pg_database" =~ ^[A-Za-z_][A-Za-z0-9_]*$ && "$pg_database" != "postgres" ]] || \
  die "LUMO_POSTGRES_DB must be a non-postgres identifier for replacement restore"

"${compose[@]}" up -d postgres
postgres_ready=0
for _ in $(seq 1 60); do
  if "${compose[@]}" exec -T postgres pg_isready -U "$pg_user" -d postgres >/dev/null 2>&1; then
    postgres_ready=1
    break
  fi
  sleep 2
done
[[ "$postgres_ready" -eq 1 ]] || die "postgres did not become ready"

"${compose[@]}" exec -T postgres psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
  -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$pg_database' AND pid <> pg_backend_pid();"
"${compose[@]}" exec -T postgres psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
  -c "DROP DATABASE IF EXISTS \"$pg_database\";"
"${compose[@]}" exec -T postgres psql -U "$pg_user" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE \"$pg_database\" OWNER \"$pg_user\";"
zstd -dc "$backup_dir/postgres.sql.zst" | \
  "${compose[@]}" exec -T postgres psql -U "$pg_user" -d "$pg_database" -v ON_ERROR_STOP=1

# Bring a restored database forward when the target checkout contains newer
# versioned migrations. This mirrors migrate.sh without requiring host psql.
for migration in "$script_dir"/migrations/*.sql; do
  version="$(basename "$migration" .sql)"
  applied="$("${compose[@]}" exec -T postgres psql -U "$pg_user" -d "$pg_database" -tAc \
    "SELECT 1 FROM lumo_schema_migrations WHERE version = '$version'" 2>/dev/null || true)"
  [[ "$applied" == "1" ]] && continue
  "${compose[@]}" exec -T postgres psql -U "$pg_user" -d "$pg_database" -v ON_ERROR_STOP=1 < "$migration"
  "${compose[@]}" exec -T postgres psql -U "$pg_user" -d "$pg_database" -v ON_ERROR_STOP=1 \
    -c "INSERT INTO lumo_schema_migrations(version) VALUES ('$version') ON CONFLICT DO NOTHING;"
done

"$script_dir/up.sh" "$shape" -d --build
echo "restore complete: $source_shape -> $shape"

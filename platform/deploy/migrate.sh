#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
for migration in "$script_dir"/migrations/*.sql; do
  version="$(basename "$migration" .sql)"
  applied="$(psql "$DATABASE_URL" -tAc "SELECT 1 FROM lumo_schema_migrations WHERE version = '$version'" 2>/dev/null || true)"
  if [ "$applied" = "1" ]; then continue; fi
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$migration"
  psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "INSERT INTO lumo_schema_migrations(version) VALUES ('$version') ON CONFLICT DO NOTHING"
done

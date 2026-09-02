#!/usr/bin/env bash
# Run the real Cluster acceptance gate against operator-owned dependencies.
# This script deliberately refuses to use localhost/dev defaults: a green
# in-memory test is not evidence of multi-node resume or failover safety.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd -- "$script_dir/../.." && pwd)"
timeout_seconds="${LUMO_ACCEPTANCE_TIMEOUT_SECONDS:-5}"

fail() { echo "cluster-acceptance: FAIL: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "需要命令 $1"; }
require_value() { [[ -n "${!1:-}" ]] || fail "$1 必须指向目标环境，不接受空值或开发默认"; }

require_command curl
require_command go
require_value LUMO_TEST_PG_DSN
require_value LUMO_TEST_RMQ_ENDPOINT
require_value LUMO_TEST_NACOS_HEALTH_URL
require_value LUMO_TEST_MILVUS_HEALTH_URL
require_value LUMO_TEST_NEBULA_HEALTH_URL
require_value LUMO_TEST_OPA_HEALTH_URL
require_value LUMO_TEST_VAULT_HEALTH_URL

check_http() {
  local name="$1" url="$2"
  curl --fail --silent --show-error --max-time "$timeout_seconds" "$url" >/dev/null \
    || fail "$name 健康检查失败: $url"
  echo "cluster-acceptance: $name healthy"
}

check_http "Nacos" "$LUMO_TEST_NACOS_HEALTH_URL"
check_http "Milvus" "$LUMO_TEST_MILVUS_HEALTH_URL"
check_http "Nebula adapter" "$LUMO_TEST_NEBULA_HEALTH_URL"
check_http "OPA" "$LUMO_TEST_OPA_HEALTH_URL"
check_http "Vault" "$LUMO_TEST_VAULT_HEALTH_URL"

if [[ "${LUMO_ACCEPTANCE_SKIP_SMOKE:-0}" != "1" ]]; then
  LUMO_ENV_FILE="${LUMO_ENV_FILE:-$root_dir/platform/deploy/.env}" \
    "$script_dir/smoke-cluster.sh"
fi

run_go_integration() {
  local module="$1" package="$2"
  echo "cluster-acceptance: go test $module $package"
  (cd "$root_dir/platform/control-plane/$module" && go test "$package" -count=1)
}

# Scheduler lease expiry is the real fencing/takeover check; the session-log
# suite exercises two writer identities against the same PG log for resume.
run_go_integration scheduler ./internal/integration
run_go_integration flows ./internal/integration
run_go_integration projects ./internal/integration
run_go_integration registry ./internal/integration
run_go_integration connector-gateway ./internal/server
run_go_integration llm-gateway ./internal/server
run_go_integration usage-ledger ./internal/integration

echo "cluster-acceptance: running real PG session resume/fencing tests"
(cd "$root_dir/platform" && pnpm exec vitest run dsh-plugins/session-log/__tests__/pg-log.spec.ts)

echo "cluster-acceptance: passed (real dependencies and isolated PG schema)"

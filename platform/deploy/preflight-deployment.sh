#!/usr/bin/env bash
# Validate the deployment prerequisites that source code cannot supply: a
# usable Docker daemon, a renderable topology, required secrets, and (when
# requested) non-development credentials. It performs no mutation.
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
shape="${1:-}"
strict="${2:-}"
env_file="${LUMO_ENV_FILE:-$script_dir/.env}"

usage() {
  echo "usage: $0 {cluster|standalone} [--strict]" >&2
  echo "  --strict rejects development defaults before a production deployment." >&2
  exit 64
}

[[ "$shape" == "cluster" || "$shape" == "standalone" ]] || usage
[[ -z "$strict" || "$strict" == "--strict" ]] || usage

failures=0

fail() {
  echo "preflight: FAIL: $*" >&2
  failures=$((failures + 1))
}

pass() { echo "preflight: OK: $*"; }

require_command() {
  if command -v "$1" >/dev/null 2>&1; then
    pass "command $1"
  else
    fail "required command $1 is unavailable"
  fi
}

# Read a simple KEY=value entry without sourcing an operator-owned file. An
# explicit environment variable wins, matching docker compose precedence.
env_value() {
  local key="$1" value=""
  value="${!key:-}"
  if [[ -z "$value" && -r "$env_file" ]]; then
    value="$(sed -n "s/^${key}=//p" "$env_file" | sed -n '1p')"
  fi
  printf '%s' "$value"
}

is_known_dev_secret() {
  case "$1" in
    ""|replace-me|lumo|lumo-admin-123|lumo-minio-123|dev-root-token|dev-subagent-token) return 0 ;;
  esac
  return 1
}

require_command docker
require_command curl

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    pass "Docker daemon is reachable"
  else
    fail "Docker daemon is not reachable (check the socket permission and that Docker is running)"
  fi
fi

compose_file="$script_dir/compose.$shape.yml"
[[ -r "$compose_file" ]] && pass "topology file $compose_file" || fail "missing topology file $compose_file"

compose=(docker compose -f "$compose_file")
if [[ -r "$env_file" ]]; then
  compose=(docker compose --env-file "$env_file" -f "$compose_file")
  pass "using environment file $env_file"
else
  echo "preflight: INFO: no environment file at $env_file; shell environment/defaults will be used"
fi

control_token="$(env_value LUMO_CONTROL_PLANE_TOKEN)"
if [[ -n "$control_token" ]]; then
  pass "LUMO_CONTROL_PLANE_TOKEN is set"
else
  fail "LUMO_CONTROL_PLANE_TOKEN is required"
fi

trust_file="$(env_value REGISTRY_TRUST_FILE)"
trust_file="${trust_file:-$script_dir/registry-trust.dev.json}"
if [[ "$trust_file" != /* ]]; then
  trust_file="$script_dir/$trust_file"
fi
[[ -r "$trust_file" ]] && pass "registry trust file is readable" || fail "registry trust file is unreadable: $trust_file"

if [[ "$strict" == "--strict" ]]; then
  identity_secret="$(env_value LUMO_IDENTITY_ASSERTION_SECRET)"
  bootstrap_password="$(env_value LUMO_AUTH_BOOTSTRAP_PASSWORD)"
  minio_password="$(env_value LUMO_MINIO_ROOT_PASSWORD)"
  vault_token="$(env_value LUMO_VAULT_TOKEN)"
  if [[ ${#identity_secret} -ge 32 ]]; then pass "identity assertion secret has production length"; else fail "LUMO_IDENTITY_ASSERTION_SECRET must contain at least 32 characters"; fi
  if ! is_known_dev_secret "$control_token" && [[ ${#control_token} -ge 20 ]]; then pass "control-plane token is not a development default"; else fail "LUMO_CONTROL_PLANE_TOKEN is empty, short, or a known development value"; fi
  if ! is_known_dev_secret "$bootstrap_password" && [[ ${#bootstrap_password} -ge 12 ]]; then pass "bootstrap password is not a development default"; else fail "LUMO_AUTH_BOOTSTRAP_PASSWORD is empty, short, or a known development value"; fi
  if ! is_known_dev_secret "$minio_password" && [[ ${#minio_password} -ge 12 ]]; then pass "MinIO password is not a development default"; else fail "LUMO_MINIO_ROOT_PASSWORD is empty, short, or a known development value"; fi
  if ! is_known_dev_secret "$vault_token" && [[ ${#vault_token} -ge 20 ]]; then pass "Vault token is not a development default"; else fail "LUMO_VAULT_TOKEN is empty, short, or a known development value"; fi
  if [[ "$trust_file" == "$script_dir/registry-trust.dev.json" ]]; then fail "strict mode rejects registry-trust.dev.json"; fi
fi

if command -v docker >/dev/null 2>&1 && [[ -r "$compose_file" ]]; then
  if "${compose[@]}" config -q >/dev/null 2>&1; then
    pass "Compose topology renders"
    services="$("${compose[@]}" config --services)"
    dsh_service="dsh-web"
    [[ "$shape" == "standalone" ]] && dsh_service="dsh-node"
    for service in postgres redis minio rocketmq nacos scheduler-0 governance registry "$dsh_service" prometheus; do
      if grep -Fxq "$service" <<< "$services"; then
        pass "required service $service is present"
      else
        fail "required service $service is absent from rendered topology"
      fi
    done
    if [[ "$shape" == "cluster" ]]; then
      if grep -Fxq scheduler-1 <<< "$services"; then pass "cluster standby scheduler is present"; else fail "cluster topology lacks scheduler-1"; fi
    fi
  else
    fail "Compose topology does not render; inspect required variables and compose diagnostics"
  fi
fi

if (( failures > 0 )); then
  echo "preflight: $failures prerequisite(s) failed; no deployment was started." >&2
  exit 1
fi

echo "preflight: $shape prerequisites passed${strict:+ (strict)}"

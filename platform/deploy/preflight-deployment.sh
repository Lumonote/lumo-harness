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
  echo "  cluster defaults to compact bundles; set LUMO_CLUSTER_TOPOLOGY=full for per-process containers." >&2
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
shared_file="$script_dir/compose.shared.yml"
bundle_file="$script_dir/compose.control-plane.bundle.yml"
[[ -r "$shared_file" ]] && pass "shared components file $shared_file" || fail "missing shared components file $shared_file"
[[ -r "$bundle_file" ]] && pass "control-plane bundle file $bundle_file" || fail "missing control-plane bundle file $bundle_file"

compose=(docker compose -f "$shared_file" -f "$bundle_file" -f "$compose_file")
cluster_topology="full"
if [[ "$shape" == "cluster" ]]; then
  cluster_topology="${LUMO_CLUSTER_TOPOLOGY:-compact}"
  compact_file="$script_dir/compose.cluster.compact.yml"
  [[ -r "$compact_file" ]] && pass "cluster topology overlay $compact_file" || fail "missing topology file $compact_file"
  case "$cluster_topology" in
    compact) compose+=(-f "$compact_file" --profile cluster-compact) ;;
    full) compose+=(--profile cluster-full) ;;
    *) fail "LUMO_CLUSTER_TOPOLOGY must be compact or full" ;;
  esac
fi
if [[ -r "$env_file" ]]; then
  compose=(docker compose --env-file "$env_file" -f "$shared_file" -f "$bundle_file" -f "$compose_file")
  if [[ "$shape" == "cluster" ]]; then
    if [[ "$cluster_topology" == "compact" ]]; then
      compose+=(-f "$script_dir/compose.cluster.compact.yml" --profile cluster-compact)
    else
      compose+=(--profile cluster-full)
    fi
  fi
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
    # 期望值刻意**写死**，不从 compose 文件反推：这个检查比的是「部署者期望哪些服务」
    # 与「拓扑声明了哪些服务」，反推期望值会让检查恒真。任何一个默认服务从拓扑里消失
    # 都必须红。2026-09-15 之前这里只列了 10 个，connector-gateway / llm-gateway / flows
    # / projects / usage-ledger / collaborator / opa / vault / milvus / tei / etcd 缺席
    # 时静态检查照样通过。
    #
    # 刻意排除 `profiles: [provisioner]` 的 provisioner / artifact-runtime：默认
    # `config --services` 不渲染 profiled 服务，列进来会让每一次默认部署都误报。
    shared_services=(postgres redis minio rocketmq nacos prometheus api-bundle)
    # API bundle 中的十个逻辑 API 是一个物理 Compose 服务；这里验证运行容器拓扑，
    # 行为探针另会把 bundle 监听端口映射回 edge/terminal/session 等逻辑服务名。
    if [[ "$shape" == "standalone" ]]; then
      required_services=("${shared_services[@]}" dsh-node)
    else
      # 集群 API、Scheduler、Collaborator 共用 api-bundle；compact 再把每集群
      # 3 个 DSH 进程放进一个 bundle。逻辑服务由控制面 healthcheck 与行为探针覆盖。
      # etcd / milvus / opa / tei / tei-rerank / vault 只在 cluster 拓扑里，standalone 没有。
      if [[ "$cluster_topology" == "compact" ]]; then
        required_services=(
          postgres redis minio rocketmq nacos prometheus api-bundle
          etcd milvus opa tei tei-rerank vault
          dsh-web cluster-a-bundle cluster-b-bundle
        )
      else
        required_services=(
          postgres redis minio rocketmq nacos prometheus api-bundle
          etcd milvus opa tei tei-rerank vault
          scheduler-0 scheduler-1 scheduler-cluster-a scheduler-cluster-b
          collaborator-0 collaborator-1
          dsh-web cluster-a-dsh-0 cluster-a-dsh-1 cluster-b-dsh-0 cluster-b-dsh-1
        )
      fi
    fi
    missing_services=""
    for service in "${required_services[@]}"; do
      grep -Fxq "$service" <<< "$services" || missing_services="$missing_services $service"
    done
    if [[ -z "$missing_services" ]]; then
      if [[ "$shape" == "cluster" ]]; then
        pass "all ${#required_services[@]} required $shape/$cluster_topology services are present in the rendered topology"
      else
        pass "all ${#required_services[@]} required $shape services are present in the rendered topology"
      fi
    else
      fail "required $shape services are absent from the rendered topology:$missing_services"
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

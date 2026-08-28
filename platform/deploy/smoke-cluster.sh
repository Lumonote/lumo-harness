#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
env_file="${LUMO_ENV_FILE:-$script_dir/.env}"
timeout_seconds="${LUMO_SMOKE_TIMEOUT_SECONDS:-240}"

command -v docker >/dev/null 2>&1 || { echo "smoke: docker is required" >&2; exit 127; }
command -v curl >/dev/null 2>&1 || { echo "smoke: curl is required" >&2; exit 127; }

compose=(docker compose -f "$script_dir/compose.cluster.yml")
if [[ -f "$env_file" ]]; then
  compose=(docker compose --env-file "$env_file" -f "$script_dir/compose.cluster.yml")
fi

control_plane_token="${LUMO_CONTROL_PLANE_TOKEN:-}"
if [[ -z "$control_plane_token" && -r "$env_file" ]]; then
  control_plane_token="$(sed -n 's/^LUMO_CONTROL_PLANE_TOKEN=//p' "$env_file" | sed -n '1p')"
fi
if [[ -z "$control_plane_token" ]]; then
  echo "smoke: LUMO_CONTROL_PLANE_TOKEN is required in the environment or $env_file" >&2
  exit 64
fi

services="$("${compose[@]}" config --services)"
deadline=$((SECONDS + timeout_seconds))

dump_failure() {
  "${compose[@]}" ps -a >&2 || true
  "${compose[@]}" logs --tail=120 "$@" >&2 || true
}

while true; do
  pending=""
  failed=""
  while IFS= read -r service; do
    [[ -n "$service" ]] || continue
    container_id="$("${compose[@]}" ps -aq "$service" | sed -n '1p')"
    if [[ -z "$container_id" ]]; then
      pending="$pending $service"
      continue
    fi

    status="$(docker inspect --format '{{.State.Status}}' "$container_id")"
    exit_code="$(docker inspect --format '{{.State.ExitCode}}' "$container_id")"
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_id")"

    if [[ "$service" == "rocketmq-topic-init" ]]; then
      if [[ "$status" == "exited" && "$exit_code" == "0" ]]; then
        continue
      fi
      if [[ "$status" == "exited" || "$status" == "dead" ]]; then
        failed="$failed $service"
      else
        pending="$pending $service"
      fi
      continue
    fi

    if [[ "$status" == "exited" || "$status" == "dead" ]]; then
      failed="$failed $service"
    elif [[ "$status" != "running" || ( "$health" != "none" && "$health" != "healthy" ) ]]; then
      pending="$pending $service"
    fi
  done <<< "$services"

  if [[ -n "$failed" ]]; then
    echo "smoke: failed containers:$failed" >&2
    dump_failure $failed
    exit 1
  fi
  if [[ -z "$pending" ]]; then
    break
  fi
  if (( SECONDS >= deadline )); then
    echo "smoke: timed out waiting for:$pending" >&2
    dump_failure $pending
    exit 1
  fi
  echo "smoke: waiting for:$pending"
  sleep 3
done

wait_http() {
  local name="$1"
  local url="$2"
  local auth="${3:-no}"
  local attempt
  for attempt in $(seq 1 30); do
    if [[ "$auth" == "yes" ]]; then
      if curl --fail --silent --show-error --max-time 3 \
        -H "Authorization: Bearer $control_plane_token" "$url" >/dev/null; then
        echo "smoke: $name ok"
        return
      fi
    elif curl --fail --silent --show-error --max-time 3 "$url" >/dev/null; then
      echo "smoke: $name ok"
      return
    fi
    sleep 2
  done
  echo "smoke: $name failed: $url" >&2
  return 1
}

wait_http "scheduler-0 health" "http://127.0.0.1:18083/healthz"
wait_http "scheduler-1 health" "http://127.0.0.1:18093/healthz"
wait_http "scheduler leader" "http://127.0.0.1:18083/v1/leader" yes
wait_http "scheduler nodes" "http://127.0.0.1:18083/v1/nodes" yes
wait_http "collaborator health" "http://127.0.0.1:18081/healthz"
wait_http "connector gateway health" "http://127.0.0.1:18082/healthz"
wait_http "registry health" "http://127.0.0.1:18084/healthz"
wait_http "usage ledger health" "http://127.0.0.1:18085/healthz"
wait_http "projects health" "http://127.0.0.1:18086/healthz"
wait_http "flows health" "http://127.0.0.1:18087/healthz"
wait_http "LLM gateway health" "http://127.0.0.1:18088/healthz"
wait_http "governance health" "http://127.0.0.1:18089/healthz"
wait_http "DSH web" "http://127.0.0.1:${LUMO_CONSOLE_PORT:-4173}/"
wait_http "Prometheus ready" "http://127.0.0.1:${LUMO_PROMETHEUS_PORT:-9090}/-/ready"

echo "smoke: cluster acceptance passed"

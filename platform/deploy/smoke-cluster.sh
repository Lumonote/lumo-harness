#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
env_file="${LUMO_ENV_FILE:-$script_dir/.env}"
timeout_seconds="${LUMO_SMOKE_TIMEOUT_SECONDS:-240}"

command -v docker >/dev/null 2>&1 || { echo "smoke: docker is required" >&2; exit 127; }
command -v curl >/dev/null 2>&1 || { echo "smoke: curl is required" >&2; exit 127; }

# Fail before inspecting a partially started topology when the daemon, compose
# render, trust root, or mandatory control-plane credential is unavailable.
LUMO_ENV_FILE="$env_file" "$script_dir/preflight-deployment.sh" cluster

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
  # `--noproxy '*'` 的理由同 probe_once：这些都是 127.0.0.1 上的探测，走代理会把
  # 「服务不在」变成代理的 502，于是 wait_http 报出的失败与真实原因无关。
  for attempt in $(seq 1 30); do
    if [[ "$auth" == "yes" ]]; then
      if curl --noproxy '*' --fail --silent --show-error --max-time 3 \
        -H "Authorization: Bearer $control_plane_token" "$url" >/dev/null; then
        echo "smoke: $name ok"
        return
      fi
    elif curl --noproxy '*' --fail --silent --show-error --max-time 3 "$url" >/dev/null; then
      echo "smoke: $name ok"
      return
    fi
    sleep 2
  done
  echo "smoke: $name failed: $url" >&2
  return 1
}

# ---------------------------------------------------------------------------
# 控制面存活探针：**从拓扑派生**，不手写
# ---------------------------------------------------------------------------
#
# 这份名单此前是手写的 10 行，而拓扑里有 13 个控制面服务 —— `edge-gateway`（18080）、
# `terminal-gateway`（18091）、`session-control`（18092）三个服务没有任何存活探针。
# 后果不是「少查三条」：这三个容器里的任何一个启动即崩，本脚本照样打印
# 「cluster acceptance passed」——探针缺失与探针通过，在退出码上是同一件事。
# 这正是一条**部署级**探针本该抓住而没抓住的东西（C5 的 OPA 绑定地址缺陷就是同类：
# 服务进程在、配置错，静态门禁全绿，只有真集群探针能看见）。
#
# 现在探针集合由 `lib/probes.sh` 从 compose 文本算出：新增一个控制面服务会
# 自动多一条探针，**漏掉它反而会红**。`probe-coverage-verify.sh` 把这条派生与写死的
# 期望值对照，所以拓扑变了会强制一次显式的确认。
#
# 失败文案必须把「服务不在」与「服务在但答错」分开：两者的处置完全不同（前者去看
# 容器起没起来 / 端口发没发布，后者去看它自己的日志），而 `curl --fail` 把两者都归成
# 一个「失败」。`probe_once` / `wait_healthz` / `classify_probe` 都在 lib 里，`probes-cluster.sh`
# 用同一份——两份实现迟早会在「哪种失败算哪种」上分叉。
source "$script_dir/lib/probes.sh"

probe_targets="$(derive_probe_targets "$script_dir/compose.cluster.yml")"
probe_count=0
while IFS=$'\t' read -r probe_service probe_host probe_container; do
  [[ -n "$probe_service" ]] || continue
  if [[ -z "$probe_host" ]]; then
    echo "smoke: FAIL: ${probe_service}（容器端口 ${probe_container}）的宿主端口静态判定不了" \
      "—— 探针无法构造。写成不带默认值的变量时，请显式给它一个默认值或钉死端口。" >&2
    exit 1
  fi
  wait_healthz "$probe_service" "$probe_host"
  probe_count=$((probe_count + 1))
done <<< "$probe_targets"
if (( probe_count == 0 )); then
  echo "smoke: FAIL: 一条控制面探针都没构造出来（派生失效？）" >&2
  exit 1
fi
echo "smoke: 控制面存活探针 ${probe_count} 条（从拓扑派生）"

wait_http "scheduler leader" "http://127.0.0.1:18083/v1/leader" yes
wait_http "scheduler nodes" "http://127.0.0.1:18083/v1/nodes" yes
wait_http "DSH web" "http://127.0.0.1:${LUMO_CONSOLE_PORT:-4173}/"
wait_http "Prometheus ready" "http://127.0.0.1:${LUMO_PROMETHEUS_PORT:-9090}/-/ready"

echo "smoke: cluster acceptance passed"

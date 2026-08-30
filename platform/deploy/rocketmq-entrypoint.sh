#!/usr/bin/env bash
set -euo pipefail

store_dir="${ROCKETMQ_STORE_DIR:-/home/rocketmq/store}"
config_dir="$store_dir/config"
recovery_dir="$config_dir/recovery"
mode="${1:-prepare}"

is_complete_json_object() {
  local boundaries
  [[ -f "$1" ]] || return 1
  boundaries="$(awk '
    {
      gsub(/[[:space:]]/, "")
      if (length($0) > 0) {
        if (first == "") first = substr($0, 1, 1)
        last = substr($0, length($0), 1)
      }
    }
    END { printf "%s%s", first, last }
  ' "$1")"
  [[ "$boundaries" == "{}" ]]
}

quarantine() {
  local source="$1"
  local reason="$2"
  local timestamp destination
  timestamp="$(date -u '+%Y%m%dT%H%M%SZ')"
  mkdir -p "$recovery_dir"
  destination="$recovery_dir/$(basename "$source").$reason.$timestamp.$$"
  mv -- "$source" "$destination"
  echo "rocketmq-entrypoint: quarantined $source -> $destination" >&2
}

repair_metadata_file() {
  local source="$1"
  local backup="$source.bak"

  if [[ -f "$source" ]] && ! is_complete_json_object "$source"; then
    quarantine "$source" truncated-json
    if is_complete_json_object "$backup"; then
      cp -- "$backup" "$source"
      echo "rocketmq-entrypoint: restored $(basename "$source") from $backup" >&2
    fi
  fi

  if [[ -f "$backup" ]] && ! is_complete_json_object "$backup"; then
    quarantine "$backup" truncated-json
  fi
}

repair_metadata() {
  [[ -d "$config_dir" ]] || return 0
  local metadata_name
  for metadata_name in \
    topics.json \
    consumerOffset.json \
    subscriptionGroup.json \
    consumerFilter.json \
    consumerOrderInfo.json \
    delayOffset.json \
    timermetrics; do
    repair_metadata_file "$config_dir/$metadata_name"
  done
}

case "$mode" in
  repair)
    repair_metadata
    exit 0
    ;;
  prepare)
    if [[ "$(id -u)" -ne 0 ]]; then
      echo "rocketmq-entrypoint: prepare phase must run as root" >&2
      exit 77
    fi
    repair_metadata
    mkdir -p "$store_dir"
    chown -R rocketmq:rocketmq "$store_dir"
    exec su -m -s /bin/bash rocketmq -c 'exec bash /rocketmq-entrypoint.sh run'
    ;;
  run) ;;
  *)
    echo "rocketmq-entrypoint: unknown mode: $mode" >&2
    exit 64
    ;;
esac

export HOME=/home/rocketmq
export JAVA_HOME="${JAVA_HOME:-/opt/java/openjdk}"
export PATH="$JAVA_HOME/bin:$PATH"
export NAMESRV_ADDR="${NAMESRV_ADDR:-rocketmq-namesrv:9876}"
broker_config="${ROCKETMQ_BROKER_CONFIG:-/rocketmq-broker-dev.conf}"
broker_start_timeout="${ROCKETMQ_BROKER_START_TIMEOUT_SECONDS:-300}"
broker_pid=""
proxy_pid=""

if [[ ! "$broker_start_timeout" =~ ^[1-9][0-9]*$ ]]; then
  echo "rocketmq-entrypoint: ROCKETMQ_BROKER_START_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 64
fi

report_logs() {
  local log_file
  for log_file in \
    /home/rocketmq/logs/rocketmqlogs/broker.log \
    /home/rocketmq/logs/rocketmqlogs/proxy.log; do
    if [[ -f "$log_file" ]]; then
      echo "rocketmq-entrypoint: tail $log_file" >&2
      tail -n 120 "$log_file" >&2 || true
    fi
  done
}

cleanup() {
  [[ -z "$broker_pid" ]] || kill "$broker_pid" 2>/dev/null || true
  [[ -z "$proxy_pid" ]] || kill "$proxy_pid" 2>/dev/null || true
  [[ -z "$broker_pid" ]] || wait "$broker_pid" 2>/dev/null || true
  [[ -z "$proxy_pid" ]] || wait "$proxy_pid" 2>/dev/null || true
}

terminate() {
  exit 143
}

trap cleanup EXIT
trap terminate TERM INT

sh mqbroker -c "$broker_config" &
broker_pid=$!

broker_ready=false
broker_started_at=$SECONDS
while (( SECONDS - broker_started_at < broker_start_timeout )); do
  if ! kill -0 "$broker_pid" 2>/dev/null; then
    status=0
    wait "$broker_pid" || status=$?
    report_logs
    exit "$status"
  fi
  if bash -c 'exec 3<>/dev/tcp/127.0.0.1/10911' 2>/dev/null; then
    broker_ready=true
    break
  fi
  sleep 1
done
if [[ "$broker_ready" != true ]]; then
  echo "rocketmq-entrypoint: broker did not bind 10911 within ${broker_start_timeout} seconds" >&2
  report_logs
  exit 1
fi

sh mqproxy -n "$NAMESRV_ADDR" &
proxy_pid=$!

status=0
wait -n "$broker_pid" "$proxy_pid" || status=$?
if (( status == 0 )); then
  status=1
fi
report_logs
exit "$status"

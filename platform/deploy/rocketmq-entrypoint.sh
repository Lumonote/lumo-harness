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
topic_max_attempts="${ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS:-60}"
broker_pid=""
proxy_pid=""

# 计量闭集 topic。权威定义在 control-plane 的 cost-types manifest；这里必然是一份
# 副本——broker 容器不挂载 manifest，运行时读不到。改一边必须同步改另一边。
usage_topics=(
  usage-events-llm-tokens
  usage-events-connector-call
  usage-events-seam-query
  usage-events-job-compute
  usage-events-storage-bytes
  usage-events-inference-gpu
)

if [[ ! "$broker_start_timeout" =~ ^[1-9][0-9]*$ ]]; then
  echo "rocketmq-entrypoint: ROCKETMQ_BROKER_START_TIMEOUT_SECONDS must be a positive integer" >&2
  exit 64
fi

if [[ ! "$topic_max_attempts" =~ ^[1-9][0-9]*$ ]]; then
  echo "rocketmq-entrypoint: ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS must be a positive integer" >&2
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

# 「broker 已向 NameServer 注册」断言。healthcheck 只探端口（10911/8081），不覆盖注册
# 状态，也不验证 rocketmq-broker-dev.conf 的 brokerIP1 是否生效；这里付一次 mqadmin
# JVM 代价就够，不必让健康检查每 5s 重复付。
#
# 刻意不写 `mqadmin ... | grep -q`，而是先落变量再匹配。理由是 `set -o pipefail` 与
# `grep -q`（命中即退出）的组合：写入方若因 SIGPIPE 而死（退出码 141），管道整体变非 0，
# 「已注册」就被读成「没注册」。
#
# 2026-09-20 实测（本机，3MB 输出）：写入方是 `cat` 时管道写法 rc=141、落变量写法 rc=0；
# 写入方是 bash 内建 `echo` 时两者都 rc=0（bash 把 EPIPE 当写错误吞掉、继续跑完）。
# 也就是说这条管道的成败**取决于写入方**：内建命令不受影响，真实进程会死。`mqadmin` 不是
# 内建命令——仓库已记过它每次探针都 fork 一个 1g 堆的 JVM（见 compose.cluster.yml 的
# rocketmq-namesrv 注释），故取与写入方无关的那种写法。
# 注意分寸：`clusterList` 正常只有几行，管道缓冲能吞下时本来也不会触发，这里不做
# 「一定会炸」的断言——只是没有理由去赌它。
wait_for_broker_registration() {
  local attempt=1 cluster_list
  while :; do
    cluster_list="$(sh mqadmin clusterList -n "$NAMESRV_ADDR" 2>/dev/null || true)"
    if grep -q '127\.0\.0\.1:10911' <<<"$cluster_list"; then
      return 0
    fi
    if (( attempt >= topic_max_attempts )); then
      echo "rocketmq-entrypoint: broker never registered with NameServer after ${topic_max_attempts} attempts" >&2
      printf '%s\n' "$cluster_list" >&2
      return 1
    fi
    echo "rocketmq-entrypoint: waiting broker registration (${attempt}/${topic_max_attempts}) ..." >&2
    attempt=$((attempt + 1))
    sleep 3
  done
}

# 幂等建 topic。必须先于 mqproxy 启动：v5 producer 启动期的路由查询不等
# autoCreateTopicEnable（实测，设计说明 §8）。排在 proxy 之前，健康检查的 8081 探针就
# 顺带成了「topic 已就绪」的闸门——按 service_healthy 等 rocketmq 的消费方（usage-ledger）
# 不会再撞上「proxy 通了、topic 还没建完」的窗口。原独立 init 容器形态存在该窗口，见
# docs/implementation-status.md 2026-09-20。
create_usage_topics() {
  local topic attempt
  for topic in "${usage_topics[@]}"; do
    attempt=1
    while ! sh mqadmin updateTopic -b localhost:10911 -t "$topic" >/dev/null 2>&1; do
      if (( attempt >= topic_max_attempts )); then
        echo "rocketmq-entrypoint: broker did not accept topic ${topic} after ${topic_max_attempts} attempts" >&2
        sh mqadmin brokerStatus -b localhost:10911 >&2 || true
        return 1
      fi
      echo "rocketmq-entrypoint: waiting broker for ${topic} (${attempt}/${topic_max_attempts}) ..." >&2
      attempt=$((attempt + 1))
      sleep 3
    done
  done
  echo "rocketmq-entrypoint: usage-events topics ready" >&2
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

# 顺序即契约：注册断言 → 建 topic → 才启 proxy。8081 未监听 = 容器未 healthy =
# topic 未就绪，三者由同一条因果链绑定。
if ! wait_for_broker_registration; then
  report_logs
  exit 1
fi

if ! create_usage_topics; then
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

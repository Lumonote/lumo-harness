#!/usr/bin/env bash
# RocketMQ 入口脚本的 topic 预建契约：**topic 必须先于 proxy 存在**。
#
# ## 为什么需要它
#
# 2026-09-20 之前，计量闭集 topic 由一个独立的一次性容器 `rocketmq-topic-init` 预建：
# 它 `depends_on: rocketmq: service_healthy`，而 usage-ledger 又
# `depends_on: rocketmq-topic-init: service_completed_successfully`。那个形状有三个问题：
#
#   1. 多一个容器，且 topic 名单在 standalone / cluster 两份 compose 里各写一遍；
#   2. **一个真实的竞态窗口**：rocketmq 的 healthcheck 只探 10911+8081，而 proxy 在 broker
#      绑端口之后就起来了，于是「healthy」期间 topic 可能还没建完——任何没走 `depends_on`
#      的消费方（或单独 `docker compose up rocketmq`）都能钻进去；
#   3. v5 producer 启动期的路由查询**不等** `autoCreateTopicEnable`（实测，设计说明 §8），
#      所以钻进去的后果不是「慢一点」，是 producer 起不来。
#
# 合并进入口脚本后，「8081 在监听」蕴含「topic 已建完」——healthcheck 天然成了闸门。但这个
# 蕴含**只由顺序保证**，而顺序是后续改动里最容易被动掉的东西：把建 topic 挪到 `sh mqproxy`
# 之后，一切都照常工作，只是闸门没了、竞态窗口回来了。所以本文件钉的是顺序本身。
#
# ## 怎么钉
#
# 真起一套 broker 太重，所以用替身：把 `mqbroker` / `mqproxy` / `mqadmin` 换成沙箱脚本，
# 由一个共享事件文件记录**真实发生顺序**（`broker:start` / `topic:<名>` / `proxy:start`）。
# 入口脚本的 stdout 读不出顺序——它对 `mqadmin updateTopic` 的输出做了重定向——所以顺序只能
# 从副作用侧读，而那也正是它真实发生的位置。
#
# 断言的是「事件文件里 proxy 排在全部 topic 之后」，不是退出码：退出码 0 与「顺序对了」是
# 两件事（同 alerts-verify.sh / compose-ports-verify.sh 的理由）。并且有一条**反例**把顺序
# 反过来跑，证明这条断言不是恒真。
#
# topic 名单**从入口脚本里抽**，不在这里重抄一份：抄一份就等于又造了一个会漂移的来源，而
# 「名单少了一个」正是本门禁要抓的东西之一。
#
# 用法：platform/deploy/rocketmq-entrypoint-verify.sh
# 依赖：python3（起一个 10911 监听）、bash

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENTRY="$HERE/rocketmq-entrypoint.sh"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lumo-rmq-entrypoint.XXXXXX")"
LISTEN_PID=""
cleanup() {
  [[ -z "$LISTEN_PID" ]] || kill "$LISTEN_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

passed=0
failed=0
ok() { printf 'rocketmq-entrypoint-verify: OK: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'rocketmq-entrypoint-verify: FAIL: %s\n' "$1" >&2; failed=$((failed + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
  echo "rocketmq-entrypoint-verify: 缺少依赖 python3" >&2
  exit 1
fi
ok "command python3"

# --- 从入口脚本抽取 topic 名单（不重抄） ---------------------------------------
# 用 `while read` 而不是 `mapfile`：本机 `/usr/bin/env bash` 是 3.2，没有 mapfile，
# 而 CI 是 bash 5 —— 写 mapfile 会得到「CI 绿、本机炸」的分叉（同 shell-portability-check.py
# 记录的那类坑）。
if ! python3 - "$ENTRY" >"$WORK/topics.txt" <<'PY'
import re, sys
text = open(sys.argv[1], encoding="utf-8").read()
match = re.search(r"^usage_topics=\(\n(.*?)^\)$", text, re.M | re.S)
if not match:
    sys.exit(1)
for line in match.group(1).splitlines():
    name = line.strip()
    if name and not name.startswith("#"):
        print(name)
PY
then
  fail "无法从 $ENTRY 抽取 usage_topics（数组写法变了？门禁拒绝在名单为空时通过）"
fi
TOPICS=()
while IFS= read -r line; do
  [[ -n "$line" ]] && TOPICS+=("$line")
done <"$WORK/topics.txt"
if (( ${#TOPICS[@]} == 0 )); then
  fail "usage topic 名单为空 —— 抽取失效与「真的没有 topic」在退出码上一样，不许通过"
else
  ok "从入口脚本抽到 ${#TOPICS[@]} 个 usage topic"
fi

# --- 沙箱替身 ----------------------------------------------------------------
BIN="$WORK/bin"
mkdir -p "$BIN"

cat >"$BIN/mqbroker" <<'SH'
#!/bin/sh
echo "broker:start" >>"$FAKE_STATE/events.log"
exec sleep 300
SH

cat >"$BIN/mqproxy" <<'SH'
#!/bin/sh
echo "proxy:start" >>"$FAKE_STATE/events.log"
exec sleep 300
SH

# 输出一律被入口脚本重定向掉，所以顺序只能靠 events.log 这个副作用通道。
cat >"$BIN/mqadmin" <<'SH'
#!/bin/sh
cmd="${1:-}"
state="${FAKE_STATE:?FAKE_STATE must be set}"
case "$cmd" in
  clusterList)
    if [ "${FAKE_NEVER_REGISTER:-0}" = "1" ]; then
      echo "no broker registered yet"
      exit 0
    fi
    echo "127.0.0.1:10911"
    ;;
  updateTopic)
    printf 'argv:%s\n' "$*" >>"$state/events.log"
    topic=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -t) topic="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    if [ "${FAKE_UPDATE_FAIL:-0}" = "1" ]; then
      echo "updateTopic rejected" >&2
      exit 1
    fi
    echo "topic:$topic" >>"$state/events.log"
    ;;
  brokerStatus)
    echo "brokerStatus stub"
    ;;
  *)
    echo "fake mqadmin: unexpected subcommand: $cmd" >&2
    exit 2
    ;;
esac
SH
chmod +x "$BIN/mqbroker" "$BIN/mqproxy" "$BIN/mqadmin"

# 入口脚本用 `bash -c 'exec 3<>/dev/tcp/127.0.0.1/10911'` 判断 broker 是否就绪，
# 那是一次真实 TCP 连接，所以这里得有个真的监听方。
cat >"$WORK/listener.py" <<'PY'
import socket, sys, time
server = socket.socket()
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    server.bind(("127.0.0.1", 10911))
except OSError as exc:
    print(f"bind 10911 失败: {exc}", file=sys.stderr)
    sys.exit(1)
server.listen(64)
server.settimeout(1.0)
deadline = time.time() + 900
while time.time() < deadline:
    try:
        conn, _ = server.accept()
        conn.close()
    except socket.timeout:
        pass
PY
python3 "$WORK/listener.py" >"$WORK/listener.log" 2>&1 &
LISTEN_PID=$!
# disown：退出时由 cleanup 主动 kill，不希望 shell 再打一行 "Terminated: 15" 到
# stderr——那行噪音在 CI 日志里会被读成失败。
disown "$LISTEN_PID" 2>/dev/null || true
sleep 1
if kill -0 "$LISTEN_PID" 2>/dev/null; then
  ok "已在 127.0.0.1:10911 起监听（入口脚本的就绪探测需要真连接）"
else
  # 端口被占（例如真有 rocketmq 在跑）时探测照样会成功，测试仍然有效，只是要说出来。
  fail "无法在 127.0.0.1:10911 起监听：$(cat "$WORK/listener.log")"
fi

# run_entry <入口脚本> <状态目录> <最多等多少秒> [环境赋值...]
# 结果写在 <状态目录>/entry.rc 与 entry.out。
run_entry() {
  local entry="$1" state="$2" wait_seconds="$3"
  shift 3
  mkdir -p "$state"
  : >"$state/events.log"
  env FAKE_STATE="$state" PATH="$BIN:$PATH" "$@" \
    bash "$entry" run >"$state/entry.out" 2>&1 &
  local pid=$!
  local rc=0 deadline=$((SECONDS + wait_seconds)) exited=0
  while (( SECONDS < deadline )); do
    if ! kill -0 "$pid" 2>/dev/null; then
      exited=1
      break
    fi
    if grep -Fqx 'proxy:start' "$state/events.log" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done
  if (( exited == 1 )); then
    wait "$pid" 2>/dev/null || rc=$?
  else
    # 还活着 = 走到了 `wait -n`（broker/proxy 都在 sleep），这正是成功路径的形状。
    kill -TERM "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
    rc=143
  fi
  printf '%s\n' "$rc" >"$state/entry.rc"
}

# 读事件文件里某个模式的行号（用 awk 而不是 `grep|head`：管道里的 head 会提前退出，
# 在 pipefail 下给写入方发 SIGPIPE —— 本文件自己的注释里讲的那个坑，别在这里踩）
first_line_of() { awk -v pat="$1" '$0 == pat { print NR; exit }' "$2"; }
last_line_matching() { awk -v pat="$1" '$0 ~ pat { n = NR } END { print n + 0 }' "$2"; }

# --- 正向：顺序契约 ------------------------------------------------------------
HAPPY="$WORK/happy"
run_entry "$ENTRY" "$HAPPY" 30
events="$HAPPY/events.log"

missing=""
for topic in "${TOPICS[@]}"; do
  if ! grep -Fxq "topic:$topic" <<<"$(cat "$events")"; then
    missing="$missing $topic"
  fi
done
if [[ -z "$missing" ]]; then
  ok "建 topic：${#TOPICS[@]} 个 usage-events-* 全部创建"
else
  fail "建 topic：未创建$missing"
fi

proxy_line="$(first_line_of 'proxy:start' "$events")"
last_topic_line="$(last_line_matching '^topic:' "$events")"
if [[ -z "$proxy_line" ]]; then
  fail "顺序契约：proxy 从未启动（成功路径没走到 mqproxy？）"
elif (( last_topic_line == 0 )); then
  fail "顺序契约：一个 topic 都没建，顺序断言无从谈起"
elif (( last_topic_line < proxy_line )); then
  ok "顺序契约：全部 topic 建完（第 ${last_topic_line} 行）之后 proxy 才启动（第 ${proxy_line} 行）"
else
  fail "顺序契约：proxy 在第 ${proxy_line} 行先启动，topic 到第 ${last_topic_line} 行才建完 —— 闸门失效，竞态窗口回来了"
fi

# 同一容器内直连：建 topic 必须打 localhost:10911，而不是绕 NameServer。这条钉住
# 「broker 与 mqproxy 同容器共享 netns」这个前提，也钉住 brokerIP1=127.0.0.1 的用法。
if grep -Fq -- '-b localhost:10911' "$events"; then
  ok "建 topic 打的是 localhost:10911（同 netns 直连，不经 NameServer）"
else
  fail "建 topic 没有用 -b localhost:10911（改走 NameServer 了？）"
fi

# --- 反向 1：注册永远不出现 → 必须失败，且**不许**启动 proxy -------------------
NOREG="$WORK/noreg"
run_entry "$ENTRY" "$NOREG" 30 FAKE_NEVER_REGISTER=1 ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS=2
rc="$(cat "$NOREG/entry.rc")"
if [[ "$rc" == "0" ]]; then
  fail "注册断言：broker 从未注册，入口脚本却退 0"
else
  if grep -Fq 'never registered with NameServer' "$NOREG/entry.out"; then
    ok "注册断言：从未注册时失败，且报出的是预期的那一条"
  else
    fail "注册断言：失败了，但报的不是预期的那条"
    cat "$NOREG/entry.out" >&2
  fi
fi
if grep -Fqx 'proxy:start' "$NOREG/events.log" 2>/dev/null; then
  fail "注册断言：注册都没确认就把 proxy 起了（闸门失效）"
else
  ok "注册断言：失败路径上 proxy 没有启动"
fi

# --- 反向 2：topic 建不出来 → 必须失败，且**不许**启动 proxy -------------------
TOPICFAIL="$WORK/topicfail"
run_entry "$ENTRY" "$TOPICFAIL" 30 FAKE_UPDATE_FAIL=1 ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS=2
rc="$(cat "$TOPICFAIL/entry.rc")"
if [[ "$rc" == "0" ]]; then
  fail "建 topic 失败：broker 拒收 topic，入口脚本却退 0"
else
  if grep -Fq 'did not accept topic' "$TOPICFAIL/entry.out"; then
    ok "建 topic 失败：拒收时失败，且点名了是哪个 topic"
  else
    fail "建 topic 失败：失败了，但报的不是预期的那条"
    cat "$TOPICFAIL/entry.out" >&2
  fi
fi
if grep -Fqx 'proxy:start' "$TOPICFAIL/events.log" 2>/dev/null; then
  fail "建 topic 失败：topic 没建成就把 proxy 起了（闸门失效）"
else
  ok "建 topic 失败：失败路径上 proxy 没有启动"
fi

# --- 反向 3：重试次数真的受 ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS 约束 ---------------
# 只断言「失败了」是不够的：重试上界如果被写死成 60，一次失败要等 3 分钟，而用例只看到
# 「最终失败」。用 max_attempts=1 与 2 的**耗时差**把上界钉住（1 → 不 sleep；2 → 一次 3s）。
BOUND1="$WORK/bound1"
started=$SECONDS
run_entry "$ENTRY" "$BOUND1" 30 FAKE_UPDATE_FAIL=1 ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS=1
elapsed1=$((SECONDS - started))
if (( elapsed1 < 5 )); then
  ok "重试上界：max_attempts=1 时不重试（耗时 ${elapsed1}s）"
else
  fail "重试上界：max_attempts=1 却耗了 ${elapsed1}s（上界没被读到？）"
fi

BOUND2="$WORK/bound2"
started=$SECONDS
run_entry "$ENTRY" "$BOUND2" 30 FAKE_UPDATE_FAIL=1 ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS=2
elapsed2=$((SECONDS - started))
if (( elapsed2 >= 3 && elapsed2 < 20 )); then
  ok "重试上界：max_attempts=2 时恰好重试一次（耗时 ${elapsed2}s）"
else
  fail "重试上界：max_attempts=2 耗时 ${elapsed2}s，既不是「重试一次」也不在合理区间"
fi

# --- 反向 4：非法重试次数必须早退，不能当成默认值继续 --------------------------
BAD="$WORK/badattempts"
run_entry "$ENTRY" "$BAD" 20 ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS=abc
rc="$(cat "$BAD/entry.rc")"
if [[ "$rc" == "64" ]]; then
  if grep -Fq 'ROCKETMQ_TOPIC_INIT_MAX_ATTEMPTS must be a positive integer' "$BAD/entry.out"; then
    ok "非法重试次数：退出码 64 且点名了变量（不是静默回落成默认值）"
  else
    fail "非法重试次数：退 64 了，但没报出是哪个变量"
    cat "$BAD/entry.out" >&2
  fi
else
  fail "非法重试次数：退出码是 ${rc}，预期 64"
  cat "$BAD/entry.out" >&2
fi
if grep -Fqx 'broker:start' "$BAD/events.log" 2>/dev/null; then
  fail "非法重试次数：校验没拦住，broker 已经起来了"
else
  ok "非法重试次数：在启动 broker 之前就退出了"
fi

# --- 反例：把顺序倒过来跑，顺序断言必须失败 -----------------------------------
# 没有这一条，上面那条「顺序契约 OK」可能只是因为断言恒真。做法是把入口脚本里
# 「注册断言 + 建 topic」整段挪到 `sh mqproxy` 之后，别的逐字不动。
python3 - "$ENTRY" "$WORK/reversed.sh" <<'PY'
import re, sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
block = re.search(
    r"if ! wait_for_broker_registration; then\n"
    r"(?:.*?\n)*?"
    r"if ! create_usage_topics; then\n"
    r"(?:.*?\n)*?"
    r"fi\n",
    text,
)
if not block:
    print("无法定位「注册断言 + 建 topic」整段（写法变了？）", file=sys.stderr)
    sys.exit(1)
start, end = block.span()
proxy = "sh mqproxy -n \"$NAMESRV_ADDR\" &\nproxy_pid=$!\n"
at = text.find(proxy, end)
if at < 0:
    print("无法定位 mqproxy 启动块（写法变了？）", file=sys.stderr)
    sys.exit(1)
moved = text[:start] + text[end:at + len(proxy)] + "\n" + text[start:end] + text[at + len(proxy):]
open(dst, "w", encoding="utf-8").write(moved)
PY
REVERSED="$WORK/reversed"
run_entry "$WORK/reversed.sh" "$REVERSED" 30
rev_events="$REVERSED/events.log"
rev_proxy="$(first_line_of 'proxy:start' "$rev_events")"
rev_topic="$(last_line_matching '^topic:' "$rev_events")"
if [[ -z "$rev_proxy" ]]; then
  fail "反例：倒序版本里 proxy 没启动，反例无效"
elif (( rev_topic > 0 && rev_proxy < rev_topic )); then
  ok "反例：把建 topic 挪到 mqproxy 之后，顺序断言确实会失败（第 ${rev_proxy} 行 < 第 ${rev_topic} 行）"
else
  fail "反例：倒序版本仍被判为顺序正确（proxy 第 ${rev_proxy} 行，topic 第 ${rev_topic} 行）——顺序断言没有牙齿"
fi

printf 'rocketmq-entrypoint-verify: %d 项通过 / %d 项失败\n' "$passed" "$failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
echo "rocketmq-entrypoint-verify: all checks passed."

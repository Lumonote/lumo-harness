#!/usr/bin/env bash
# probes-cluster.sh 的门禁：用**假服务**把探针的每一条分类逐个钉住。
#
# ## 为什么这个门禁比探针本身更重要
#
# `probes-cluster.sh` 的全部价值在**分类**：它要说清「服务不在」与「服务在但答错」。
# 而这件事没有任何真集群能稳定地验——要造出「边缘网关回 502」「terminal 伪造空历史」
# 「路由表加载了但是空的」这几种现场，真集群上要么做不到、要么得先破坏它。
# 所以这里起 5 个假 HTTP 服务，逐个场景断言探针报出的是**预期的那一组词**，
# 而不是只看退出码：
#
#   退出码 1 可能来自任何一条判据。只断言「非零退出」等于给「判据被换成了另一条」
#   留后门（同 compose-ports-verify.sh / edge-cors-verify.sh 的理由）。
#   2026-09-16 写这个门禁时真抓到两条：`$?` 在 `if` 之后被重置（所有传输失败都报成
#   `transport:0`），以及 `metric_value` 只认带标签的序列行（无标签的 gauge 一律被判成
#   「没装配」）——两条都**只在假服务上才暴露得出来**，而两条都会让结论指向反方向。
#
# 覆盖：
#   依赖 1 条 + 正向 2 条（全绿 / 「已配事件源」的 400 也算通过）
#   + 反向 11 条（8 类行为错 + 2 条自身守卫 + 缺令牌）+ 派生对照 5 条
#
# 正向为什么要两条：**「正确」不止一种形状**。terminal-gateway 对普通 GET 的正确回答
# 取决于事件源配没配（未配 503+no_event_source / 已配在握手处 400，见 `server.go:106-127`），
# 而「已配事件源」正是 C4 清单上那条**排期中的**接线。只钉住 503 这一种，探针就会在
# 接线推进的那一刻对着一个正确的部署报红——那比不报还坏：下一个人会把探针改坏。
# 所以两个形状各有一条正向用例。
#
# 依赖：bash、curl、python3（只用标准库）。**不需要** docker / 集群 / docker 守护进程。
#
# 用法：platform/deploy/probes-cluster-verify.sh

set -euo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROBE="$HERE/probes-cluster.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/lumo-probes-verify.XXXXXX")"
# 端口基数可覆盖：本机若恰好占用了默认段，改这个变量即可，不必改脚本。
base="${LUMO_PROBES_VERIFY_PORT_BASE:-19700}"
edge_port=$((base + 80))
terminal_port=$((base + 91))
flows_port=$((base + 87))
scheduler_port=$((base + 83))
session_port=$((base + 92))

server_pid=""
stop_server() {
  if [[ -n "$server_pid" ]] && kill -0 "$server_pid" 2>/dev/null; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  server_pid=""
}
cleanup() { stop_server; rm -rf "$WORK"; }
trap cleanup EXIT

passed=0
failed=0
ok() { printf 'probes-cluster-verify: OK: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'probes-cluster-verify: FAIL: %s\n' "$1" >&2; failed=$((failed + 1)); }

for tool in curl python3; do
  command -v "$tool" >/dev/null 2>&1 || {
    echo "probes-cluster-verify: 缺少依赖 ${tool}" >&2
    exit 1
  }
done
ok "依赖 curl / python3"

# ---------------------------------------------------------------------------
# 假服务：5 个端口，行为由场景名决定
# ---------------------------------------------------------------------------
cat >"$WORK/scenario-server.py" <<'PY'
import json
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SCENARIO = sys.argv[1]
PORTS = {
    "edge": int(sys.argv[2]),
    "terminal": int(sys.argv[3]),
    "flows": int(sys.argv[4]),
    "scheduler": int(sys.argv[5]),
    "session": int(sys.argv[6]),
}


def send(handler, code, payload, ctype="application/json"):
    body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    handler.send_response(code)
    handler.send_header("Content-Type", ctype)
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def handler_for(service):
    class H(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.0"

        def log_message(self, *args):
            pass

        def do_GET(self):  # noqa: N802
            path = self.path
            if path == "/healthz":
                return send(self, 200, b"ok", "text/plain")
            if service == "edge":
                if path == "/v1/routes":
                    if SCENARIO == "routes-empty":
                        return send(self, 200, {"whitelist": [], "routes": []})
                    return send(self, 200, {
                        "whitelist": ["terminal-gateway:8090"],
                        "routes": [{"prefix": "/v1/terminals/", "upstream": "http://terminal-gateway:8090"},
                                   {"prefix": "/v1/flows", "upstream": "http://flows:8087"}]})
                if path.startswith("/v1/terminals/"):
                    if SCENARIO == "edge-404":
                        return send(self, 404, {"error": "not found"})
                    if SCENARIO == "edge-502":
                        return send(self, 502, {"error": "bad gateway"})
                    if SCENARIO == "edge-401":
                        return send(self, 401, {"error": "unauthorized"})
                    if SCENARIO == "terminal-fabricates":
                        return send(self, 200, {"session_ref": "x", "events": []})
                    if SCENARIO == "terminal-configured":
                        return send(self, 400, b"missing Sec-WebSocket-Key", "text/plain")
                    return send(self, 503, {"error": "no_event_source",
                                            "message": "终端网关未配置 session/event 历史源"})
                return send(self, 404, {"error": "not found"})
            if service == "terminal":
                if path.endswith("/presence"):
                    if SCENARIO == "presence-shape":
                        return send(self, 200, {"items": []})
                    return send(self, 200, {"session_ref": "x", "presence": []})
                return send(self, 503, {"error": "no_event_source"})
            if path == "/metrics":
                # 刻意两种序列形态各用一次：带标签（`name{...} 0`）与不带标签（`name 0`）。
                # 第一版 metric_value 只认前者，于是无标签的 gauge 一律被判成「没装配」。
                text = {
                    "flows": 'lumo_flow_lineage_projector_enabled{reason="nebula_not_configured"} 0',
                    "scheduler": 'lumo_scheduler_task_migrations_total{outcome="migrated"} 0\n'
                                 'lumo_scheduler_task_migrations_total{outcome="skipped"} 0',
                    "session": "lumo_session_control_forced_releases_total 0",
                }[service]
                if SCENARIO == "lineage-absent" and service == "flows":
                    text = "lumo_unrelated_metric 1"
                return send(self, 200, (text + "\n").encode(), "text/plain; version=0.0.4")
            return send(self, 404, {"error": "not found"})

    return H


servers = []
for name, port in PORTS.items():
    if SCENARIO == "edge-absent" and name == "edge":
        continue
    server = ThreadingHTTPServer(("127.0.0.1", port), handler_for(name))
    servers.append(server)
    threading.Thread(target=server.serve_forever, daemon=True).start()

print("ready", len(servers), flush=True)
threading.Event().wait()
PY

# ---------------------------------------------------------------------------
# 合成拓扑
# ---------------------------------------------------------------------------
write_topology() {
  local path="$1" terminal_name="${2:-terminal-gateway}"
  cat >"$path" <<YAML
services:
  edge-gateway:
    ports: ["${edge_port}:8080"]
  ${terminal_name}:
    ports: ["${terminal_port}:8090"]
  flows:
    ports: ["${flows_port}:8087"]
  scheduler-0:
    ports: ["${scheduler_port}:8083"]
  session-control:
    ports: ["${session_port}:8092"]
YAML
}
TOPOLOGY="$WORK/compose.probe.yml"
RENAMED="$WORK/compose.probe-renamed.yml"
write_topology "$TOPOLOGY"
write_topology "$RENAMED" "terminal-gateway-renamed"

# 一条控制面端口都没有的拓扑：派生必须**失败**，而不是返回空列表。
cat >"$WORK/compose.probe-notarget.yml" <<'YAML'
services:
  postgres:
    ports: ["15432:5432"]
  prometheus:
    ports: ["9090:9090"]
YAML

start_server() {
  local scenario="$1"
  stop_server
  : >"$WORK/server.log"
  python3 "$WORK/scenario-server.py" "$scenario" \
    "$edge_port" "$terminal_port" "$flows_port" "$scheduler_port" "$session_port" \
    >"$WORK/server.log" 2>&1 &
  server_pid=$!
  local attempt
  for attempt in $(seq 1 20); do
    if grep -q '^ready' "$WORK/server.log" 2>/dev/null; then
      return 0
    fi
    sleep 0.5
  done
  cat "$WORK/server.log" >&2
  fail "假服务（场景 ${scenario}）在 10s 内没起来"
  return 1
}

# run_probe <拓扑> [<额外 env 赋值>...] —— 输出到 $WORK/probe.out，退出码写进 $PROBE_RC
PROBE_RC=0
run_probe() {
  local topology="$1"
  shift
  set +e
  env LUMO_CONTROL_PLANE_TOKEN=verify-token LUMO_PROBE_TOPOLOGY="$topology" \
    LUMO_PROBE_METRIC_ATTEMPTS=2 LUMO_PROBE_TIMEOUT_SECONDS=2 "$@" \
    bash "$PROBE" >"$WORK/probe.out" 2>&1
  PROBE_RC=$?
  set -e
}

expect_pass() {
  local name="$1" want="$2" topology="$3"
  run_probe "$topology"
  if [[ "$PROBE_RC" -ne 0 ]]; then
    fail "${name}：本该通过，实际退出码 ${PROBE_RC}"
    sed 's/^/    /' "$WORK/probe.out" >&2
    return
  fi
  if ! grep -qF "$want" "$WORK/probe.out"; then
    fail "${name}：退出了 0，但输出里没有 ${want}"
    sed 's/^/    /' "$WORK/probe.out" >&2
    return
  fi
  ok "${name}"
}

expect_fail() {
  local name="$1" want="$2" topology="$3"
  run_probe "$topology"
  if [[ "$PROBE_RC" -eq 0 ]]; then
    fail "${name}：缺陷没有被抓住（探针放行了）"
    sed 's/^/    /' "$WORK/probe.out" >&2
    return
  fi
  if ! grep -qF "$want" "$WORK/probe.out"; then
    fail "${name}：红是红了，但报的不是预期的那一条（期望含 ${want}）"
    sed 's/^/    /' "$WORK/probe.out" >&2
    return
  fi
  ok "${name}（${want}）"
}

# ---------------------------------------------------------------------------
# 正向：全绿
# ---------------------------------------------------------------------------
if start_server good; then
  expect_pass "全绿：6 条探针全过" "6 项通过 / 0 项失败" "$TOPOLOGY"
fi

if start_server terminal-configured; then
  # 「正确」的第二种形状：事件源配好了的部署，普通 GET 在握手处被拒（400）。
  # 这一条防的是探针**在接线推进之后变成假警报**——期望值写成「必须 503」时，
  # 一个接线更完整的部署反而会红。
  run_probe "$TOPOLOGY"
  if [[ "$PROBE_RC" -ne 0 ]]; then
    fail "terminal 已配事件源（400）：本该通过，实际退出码 ${PROBE_RC}"
    sed 's/^/    /' "$WORK/probe.out" >&2
  elif grep -qF "已配事件源" "$WORK/probe.out"; then
    ok "terminal 已配事件源 → 400 也算通过（探针不把「接线更完整」报成故障）"
  else
    fail "terminal 已配事件源（400）：退出了 0，但输出里没有说明这是哪种形状"
    sed 's/^/    /' "$WORK/probe.out" >&2
  fi
fi

# ---------------------------------------------------------------------------
# 反向：每一类行为错各一条
# ---------------------------------------------------------------------------
if start_server edge-absent; then
  expect_fail "边缘网关没起来 → 服务不存在" "probe-edge-gateway-absent" "$TOPOLOGY"
fi

if start_server edge-401; then
  expect_fail "令牌两边不一致 → 401" "probe-gateway-token-mismatch" "$TOPOLOGY"
fi

if start_server edge-404; then
  expect_fail "路由表里没有这个前缀 → 404" "probe-edge-route-missing" "$TOPOLOGY"
fi

if start_server edge-502; then
  expect_fail "上游不可达 → 502" "probe-edge-upstream-unreachable" "$TOPOLOGY"
fi

if start_server terminal-fabricates; then
  # 最贵的一条：终端在未配事件源时返回成功，终端 UI 会把「没采集」读成「本来就没有」。
  expect_fail "终端伪造空历史 → 2xx" "probe-terminal-fabricates-history" "$TOPOLOGY"
fi

if start_server routes-empty; then
  # 网关启动时只拒绝「加载失败」与「校验失败」；空表是**合法输入**，于是每个请求 404
  # 而进程健康、日志干净。这一条同时钉住 pipefail 那个坑：修好之前它静默退出、不打印。
  expect_fail "路由表加载了但是空的" "probe-edge-route-table-empty" "$TOPOLOGY"
fi

if start_server presence-shape; then
  expect_fail "presence 面形状变了（没有 presence 键）" "probe-terminal-presence-shape" "$TOPOLOGY"
fi

if start_server lineage-absent; then
  # 「特性压根没装配」与「特性显式关掉（值 0）」是两件事，探针必须分得开。
  expect_fail "flows 里没有血缘投影器序列" "probe-feature-not-assembled" "$TOPOLOGY"
fi

# ---------------------------------------------------------------------------
# 反向：探针自身的两条守卫
# ---------------------------------------------------------------------------
if start_server good; then
  expect_fail "服务改名后探针目标解析不到（必须红，不能静默少跑一条）" \
    "probe-target-port-absent" "$RENAMED"
fi

run_probe "$WORK/compose.probe-notarget.yml"
if [[ "$PROBE_RC" -eq 0 ]]; then
  fail "拓扑里一个控制面端口都没有：派生本该失败，实际退出了 0"
else
  if grep -qF "probe-targets-not-derived" "$WORK/probe.out"; then
    ok "拓扑里没有控制面端口 → 派生失败（不是返回空列表）"
  else
    fail "派生失败的红没有说明原因（期望含 probe-targets-not-derived）"
    sed 's/^/    /' "$WORK/probe.out" >&2
  fi
fi

# 令牌缺失：与「服务不在」完全无关的一种前置条件，应该以固定的退出码挡住。
stop_server
set +e
env -u LUMO_CONTROL_PLANE_TOKEN LUMO_ENV_FILE="$WORK/absent.env" \
  LUMO_PROBE_TOPOLOGY="$TOPOLOGY" bash "$PROBE" >"$WORK/probe.out" 2>&1
PROBE_RC=$?
set -e
if [[ "$PROBE_RC" -eq 64 ]] && grep -qF "LUMO_CONTROL_PLANE_TOKEN" "$WORK/probe.out"; then
  ok "缺令牌 → 退出码 64 并说明缺什么"
else
  fail "缺令牌时的行为不对（退出码 ${PROBE_RC}，期望 64）"
  sed 's/^/    /' "$WORK/probe.out" >&2
fi

# ---------------------------------------------------------------------------
# 派生结果 vs **写死的期望值**
# ---------------------------------------------------------------------------
#
# 探针集合是派生的，所以「漏掉一个服务」这件事已经不可能发生。但派生会随拓扑变，
# 而拓扑的变化**必须被看见**：新增一个控制面服务、或把一个服务移出控制面端口段，
# 应当让某个人确认一次，而不是悄悄多/少一条探针。
#
# 期望值**写死、不从派生结果反推**（同 helm-verify.sh / preflight-deployment.sh 的规矩）：
# 反推会让检查恒真，而它唯一要防的就是「列表自己腐烂」。
#
# 反向用例同样是必需的：如果派生对端口段完全不敏感（例如正则失效、恒返回全部服务），
# 那么正向的两条照样绿。所以下面把 edge-gateway 的容器端口挪出控制面段，断言派生**跟着变**。
DERIVED=""
derive_of() {
  DERIVED="$(bash -c 'source "$1/lib/probes.sh"; derive_probe_targets "$2"' _ "$HERE" "$1")" || return 1
  return 0
}

expect_derivation() {
  local name="$1" file="$2" want="$3"
  if ! derive_of "$file"; then
    fail "${name}：派生失败"
    return
  fi
  if [[ "$DERIVED" == "$want" ]]; then
    ok "${name}"
  else
    fail "${name}：派生结果与写死的期望值不一致"
    printf '    期望（写死）:\n%s\n    实际（派生）:\n%s\n' "$want" "$DERIVED" >&2
  fi
}

expect_derivation_differs() {
  local name="$1" file="$2"
  if ! derive_of "$file"; then
    fail "${name}：派生失败（本该派生出一个不同的集合）"
    return
  fi
  if [[ "$DERIVED" == "$CLUSTER_PINNED" ]]; then
    fail "${name}：派生结果与改动前完全一样 —— 派生对容器端口段**不敏感**，等于没在看"
    return
  fi
  ok "${name}"
}

CLUSTER_PINNED="$(cat <<'PINNED'
collaborator-0	18081	8081
connector-gateway	18082	8082
edge-gateway	18080	8080
flows	18087	8087
governance	18089	8089
llm-gateway	18088	8088
projects	18086	8086
registry	18084	8084
scheduler-0	18083	8083
scheduler-1	18093	8083
scheduler-cluster-a	18094	8083
scheduler-cluster-b	18095	8083
session-control	18092	8092
terminal-gateway	18091	8090
usage-ledger	18085	8085
PINNED
)"
STANDALONE_PINNED="$(cat <<'PINNED'
collaborator	18081	8081
connector-gateway	18082	8082
edge-gateway	18080	8080
flows	18087	8087
governance	18089	8089
llm-gateway	18088	8088
projects	18086	8086
registry	18084	8084
scheduler-0	18083	8083
session-control	18092	8092
terminal-gateway	18091	8090
usage-ledger	18085	8085
PINNED
)"

expect_derivation "compose.cluster.yml 的探针目标 == 写死的 15 条" \
  "$HERE/compose.cluster.yml" "$CLUSTER_PINNED"
expect_derivation "compose.standalone.yml 的探针目标 == 写死的 12 条" \
  "$HERE/compose.standalone.yml" "$STANDALONE_PINNED"

# 反向 1：把 edge-gateway 的容器端口挪出控制面段（8080 → 9080）→ 派生必须跟着变。
sed 's/"18080:8080"/"18080:9080"/' "$HERE/compose.cluster.yml" >"$WORK/port-moved.yml"
if grep -q '"18080:9080"' "$WORK/port-moved.yml"; then
  expect_derivation_differs "容器端口挪出控制面段 → 派生跟着变（不是恒返回全部）" "$WORK/port-moved.yml"
else
  fail "反向用例：无法把 edge-gateway 的容器端口挪出控制面段（锚点失效？拓扑被改过？）"
fi

# 反向 2：新增一个控制面服务 → 派生必须**自动多一条**（这正是「派生」相对「手写名单」
# 的全部意义：漏掉它反而会红，而不是静默少查一个）。
#
# 容器端口必须落在控制面段（8091）——第一次写成 8111 时这条用例红了，而**派生是对的**：
# 8111 不在 8080-8099 里，被正确排除。用例写错与实现写错在输出上长得一样，这是本仓库
# 反复出现的一类误判，所以这条注释留在原地。
sed 's/^  usage-ledger:/  brand-new-service:\n    ports: ["18111:8091"]\n  usage-ledger:/' \
  "$HERE/compose.cluster.yml" >"$WORK/new-service.yml"
if grep -q '^  brand-new-service:' "$WORK/new-service.yml"; then
  if derive_of "$WORK/new-service.yml" && grep -qF "brand-new-service	18111	8091" <<<"$DERIVED"; then
    ok "新增一个控制面服务 → 派生自动多一条（无需改任何名单）"
  else
    fail "新增一个控制面服务后派生没有跟着多一条 —— 那它就不是派生了"
    printf '%s\n' "$DERIVED" | sed 's/^/    /' >&2
  fi
else
  fail "反向用例：无法插入新服务（锚点失效？）"
fi

# 反向 3：`ports:` 块改成解析不出来的写法（长语法）→ 宿主端口不可判定必须**报出来**，
# 不能静默跳过。跳过它，「无法判定」与「没问题」在输出上就一样了。
cat >"$WORK/long-syntax.yml" <<'YAML'
services:
  edge-gateway:
    ports:
      - target: 8080
        published: "18080"
YAML
if derive_of "$WORK/long-syntax.yml"; then
  if [[ "${DERIVED#*$'\t'}" == $'\t'* ]]; then
    ok "长语法端口项 → 宿主端口不可判定被报出（而非静默跳过）"
  else
    fail "长语法端口项被当成了可判定的：${DERIVED}"
  fi
else
  fail "长语法端口项：派生失败了，但应当报出「宿主端口不可判定」"
fi

printf 'probes-cluster-verify: %d 项通过 / %d 项失败\n' "$passed" "$failed"
if [[ "$failed" -gt 0 ]]; then
  exit 1
fi
echo "probes-cluster-verify: all checks passed."

#!/usr/bin/env bash
# 真集群**行为**探针：断言跑起来的那些进程在做它们该做的事。
#
# ## 与 smoke-cluster.sh 的分工
#
# `smoke-cluster.sh` 回答「服务在不在」（存活探针，`/healthz` 2xx）。本脚本回答
# 「在的那个服务是不是对的」。两者的失效模式完全不同：一个进程可以活着、健康检查
# 自认 ok，而它的**配置是错的**——路由表没加载、特性没装配、上游名字写错了。
# C5 的 OPA 绑定地址缺陷就是这一类的实证：服务全部健康，策略评估对兄弟容器一律
# 连不上，而当时没有任何一条探针会去看这件事。
#
# ## 覆盖的四个缺口
#
#   C3 edge-gateway     探针 1（端到端链）、探针 2（路由表只读面）
#   C4 terminal-gateway 探针 1（端到端链）、探针 3（presence 只读面）
#   C7 lineage          探针 4（投影器装配指标）
#   C1 任务漂移         探针 5（漂移累计指标）+ 目标端的活库用例（scheduler 集成套件）
#   C5 session-control  探针 6（控制面累积器装配指标）—— 顺带补上：它与 C3/C4 一样
#                       此前**一条探针都没有**（存活探针都没有，见 smoke-cluster.sh 的注释）
#
# ## 判据的两条纪律
#
#   ① **区分「服务不存在」与「服务在但行为错」**。前者处置是「去看容器起没起来 /
#      宿主端口发没发布」，后者是「去看它自己的日志」。把两者压成同一个「失败」，
#      等于把一条探针的诊断价值丢掉一半。所以每条探针都按 transport / 401 / 404 /
#      502 / 503 / 2xx 分别给文案。
#   ② **探针目标从拓扑派生**，不手写端口：`lib/probes.sh`。服务被改名或从拓扑里
#      删掉时，`probe-target-port-absent` 会让这条探针红，而不是静默少跑一条。
#
# 探针 1 刻意是**一条链**（客户端 → edge-gateway → terminal-gateway），因为它一次
# 同时证明四件事：边缘加载了路由表、反向代理真的转发、容器名解析得通、
# terminal-gateway 的行为是它该有的那一种（未配事件源=诚实 503 / 已配=握手处 400，
# 见该探针自己的注释：**「正确」不止一种形状**）。任何一环坏掉，文案会指出是哪一环。
#
# ## 一条自己踩过的坑（写在这里，因为下一个人会踩同一处）
#
# **`fail` 绝不能在命令替换里调用。** `$(host_of …)` 会开一个子 shell，子 shell 里
# `failed=$((failed+1))` 加的是**子 shell 的**变量，父 shell 里的计数不变——于是脚本
# 会「打印了 FAIL 却退出 0」。这是本仓库最忌讳的形态：失败被说出来、而退出码说成功，
# 任何只看退出码的调用方（CI、acceptance-cluster.sh）都会把它读成通过。
# 所以 `resolve_host` 只做解析、不报错，报错交给调用方在**当前 shell** 里做。
#
# 用法：
#   LUMO_ENV_FILE=platform/deploy/.env platform/deploy/probes-cluster.sh
#
# 依赖：bash、curl。不需要 python / docker / node。

set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
topology="${LUMO_PROBE_TOPOLOGY:-$script_dir/compose.cluster.yml}"
env_file="${LUMO_ENV_FILE:-$script_dir/.env}"
export LUMO_PROBE_TIMEOUT_SECONDS="${LUMO_PROBE_TIMEOUT_SECONDS:-3}"
# 指标序列是**后台周期发布**的（session-control 的 tick、flows 的启动期设置），
# 所以探测要给它一个窗口；给窗口不代表放宽判据：窗口走完仍缺席就是缺席。
metric_attempts="${LUMO_PROBE_METRIC_ATTEMPTS:-15}"

# shellcheck source=lib/probes.sh
source "$script_dir/lib/probes.sh"

command -v curl >/dev/null 2>&1 || {
  echo "probes: 需要命令 curl" >&2
  exit 1
}

# 控制面令牌：与 smoke-cluster.sh 同一条回退链（环境变量优先，再读 compose 的 env 文件）。
# 显式环境变量优先是 docker compose 的取值顺序，两处保持一致才不会出现
# 「smoke 过了、probes 过不了」这种由**取值顺序**造成的不一致。
control_plane_token="${LUMO_CONTROL_PLANE_TOKEN:-}"
if [[ -z "$control_plane_token" && -r "$env_file" ]]; then
  control_plane_token="$(sed -n 's/^LUMO_CONTROL_PLANE_TOKEN=//p' "$env_file" | sed -n '1p')"
fi
if [[ -z "$control_plane_token" ]]; then
  echo "probes: 需要 LUMO_CONTROL_PLANE_TOKEN（环境变量或 ${env_file}）" >&2
  exit 64
fi

targets="$(derive_probe_targets "$topology")"

passed=0
failed=0
pass() { printf 'probes: OK: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'probes: FAIL: %s\n' "$1" >&2; failed=$((failed + 1)); }

# resolve_host <service>：打印宿主端口；解析不到返回 1。
# **刻意不报错、不计数**——它总是在命令替换里被调用，而命令替换会开一个子 shell：
# 在子 shell 里 `failed=$((failed+1))` 加的是子 shell 的变量，父 shell 的计数不变，
# 于是脚本会「打印了 FAIL 却退出 0」。报错一律交给调用方在当前 shell 里做：
#
#   if ! host="$(resolve_host edge-gateway)"; then
#     fail "probe-target-port-absent: …"
#     return 0
#   fi
resolve_host() {
  local service="$1" host
  host="$(probe_target_port "$service" "$targets")" || return 1
  [[ -n "$host" ]] || return 1
  printf '%s' "$host"
}

# target_absent <service>：把「探针目标解析不到」记成一条失败。文案单独拎出来，
# 是为了四个调用点说的是同一件事、同一句话。
target_absent() {
  fail "probe-target-port-absent: ${1} 不在 ${topology} 派生出的探针目标里" \
    "（改名了？被删了？宿主端口写成动态变量了？）—— 这条探针无法构造，按失败处理"
}

transport_detail() {
  case "${1#transport:}" in
    7) printf '服务不存在：端口上没有监听（容器没起来，或宿主端口没发布）' ;;
    28) printf '连接超时：端口上有东西在听但不回应' ;;
    6) printf '主机名解析不了' ;;
    *) printf '连接失败（curl 退出码 %s）' "${1#transport:}" ;;
  esac
}

# ---------------------------------------------------------------------------
# 探针 1：端到端链 edge-gateway → terminal-gateway（C3 + C4）
# ---------------------------------------------------------------------------
#
# 这条链的每一环都有一个**只看静态配置看不出来**的失效形态：
#   * edge 没起来              → transport
#   * 令牌两边不一致           → 401
#   * 路由表加载了但为空       → 404
#   * 路由表里上游名字写错     → 502（DNS 解析不到兄弟容器）
#   * terminal 没起来          → 502（上游拒绝连接）
#   * terminal 在但伪造空历史  → 2xx（本探针要抓的最贵的一种：静默的错）
#
# **探的是普通 GET，所以「正确」不止一种形状。** 这一点值得写清楚，因为如实写死
# 一种会让这条探针在**接线推进的那一刻**变成假警报：`handleWS` 的判断顺序是
# 「先看事件源、再看握手」——事件源为 nil 时回 503（`server.go:106-113`），
# 事件源配好之后普通 GET 会在 `ws.ValidateUpgrade` 上被拒、回 **400**（`server.go:124-127`），
# 只有带 Upgrade 头的真握手才走 101。于是：
#
#   503 + no_event_source → 诚实：这个部署没配事件源，它没有假装自己配了
#   400                   → 常态：这个部署配了事件源，普通 GET 在握手处被正确拒绝
#   2xx                   → **伪造**：一个非 WS 请求拿到了成功响应（见下）
#
# 判据因此写成「上面两种形状都算通过」，而不是「必须是 503」。反过来说，这条探针
# 抓的仍然是 §8.2 禁止的那件事：终端把「我们没在采集」渲染成「这个会话本来就没有事件」。
# 2xx 是唯一能把这两件事混起来的形状，所以它单独被判失败。
probe_edge_to_terminal() {
  local edge result code body url
  if ! edge="$(resolve_host edge-gateway)"; then
    target_absent edge-gateway
    return 0
  fi
  url="http://127.0.0.1:${edge}/v1/terminals/lumo-probe-ref"

  result="$(probe_once_body "$url" -H "Authorization: Bearer $control_plane_token")" || true
  code="${result%%$'\t'*}"
  body="${result#*$'\t'}"

  case "$code" in
    transport:*)
      fail "probe-edge-gateway-absent: ${url} —— $(transport_detail "$code")" \
        "（南北向入口没起来，本探针无法继续）"
      return 0 ;;
    ok:401)
      fail "probe-gateway-token-mismatch: edge-gateway 回了 401 —— 控制面令牌与网关的不一致" \
        "（probes 用的是环境变量或 ${env_file} 里的 LUMO_CONTROL_PLANE_TOKEN）"
      return 0 ;;
    ok:404)
      fail "probe-edge-route-missing: edge-gateway 回了 404 —— 已加载的路由表里没有 /v1/terminals/" \
        "（表没加载 / 挂载目录为空 / 前缀被改过）。这与「服务在不在」无关，是配置问题"
      return 0 ;;
    ok:503)
      # 503 有两种含义，靠响应体区分：terminal 自己的诚实 503 带 no_event_source；
      # 而「edge 报上游不可达」也可能是 503。先认响应体的原义。
      if [[ "$body" == *no_event_source* ]]; then
        pass "探针 1：edge → terminal 全链路通，且 terminal 对「未配历史事件源」回了诚实的 503"
        return 0
      fi
      fail "probe-edge-unexpected: 整条链回了 503 但响应体不是 terminal 的诚实原因" \
        "（no_event_source）—— 可能是边缘到上游这段坏了。响应体: ${body:0:200}"
      return 0 ;;
    ok:400)
      # 配好事件源的部署在这里的正确形状：普通 GET 不是合法握手，被 ValidateUpgrade 拒。
      # 「事件源没配」应当是 503 而不是 400（两者都能到达这里，说明 Source 不为 nil）。
      pass "探针 1：edge → terminal 全链路通，terminal 已配事件源（普通 GET 在握手处被正确拒绝）"
      return 0 ;;
    ok:502|ok:504)
      fail "probe-edge-upstream-unreachable: edge-gateway 回了 ${code#ok:} —— 上游 terminal-gateway" \
        "不可达（容器名/端口写错？容器没起来？）响应体: ${body:0:200}"
      return 0 ;;
    ok:2*)
      fail "probe-terminal-fabricates-history: 整条链答了 ${code#ok:} —— terminal-gateway" \
        "在**未配置历史事件源**的部署里返回了成功。这正是 §8.2 禁止的「伪造空历史」：" \
        "终端会把「我们没在采集」读成「这个会话本来就没有事件」。响应体: ${body:0:200}"
      return 0 ;;
    *)
      fail "probe-edge-unexpected: 整条链答了 ${code#ok:}（既不是诚实的 503、也不是「已配事件源」的 400）" \
        "响应体: ${body:0:200}"
      return 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# 探针 2：edge-gateway 的路由表只读面（C3）
# ---------------------------------------------------------------------------
#
# `/v1/routes` 返回**进程内已加载并已编译**的那张表。它抓到的是「表加载了但是空的」
# 这一类静默失效：网关启动时只拒绝**加载失败**与**校验失败**，表为空是合法输入，
# 于是每个请求都 404，而进程健康、日志干净。
probe_edge_routes_face() {
  local edge result code body routes url
  if ! edge="$(resolve_host edge-gateway)"; then
    target_absent edge-gateway
    return 0
  fi
  url="http://127.0.0.1:${edge}/v1/routes"

  result="$(probe_once_body "$url" -H "Authorization: Bearer $control_plane_token")" || true
  code="${result%%$'\t'*}"
  body="${result#*$'\t'}"

  case "$code" in
    transport:*)
      fail "probe-edge-gateway-absent: ${url} —— $(transport_detail "$code")"
      return 0 ;;
    ok:401)
      fail "probe-gateway-token-mismatch: /v1/routes 回了 401 —— 控制面令牌与网关的不一致"
      return 0 ;;
    ok:200) ;;
    *)
      fail "probe-edge-routes-face: /v1/routes 答了 ${code#ok:}（期望 200）响应体: ${body:0:200}"
      return 0 ;;
  esac

  routes="$(string_count '"prefix"' "$body")"
  if [[ "${routes:-0}" -eq 0 ]]; then
    fail "probe-edge-route-table-empty: edge-gateway 回了 200，但已加载的路由表里**一条路由都没有**" \
      "—— 每个请求都会 404，而进程健康、日志干净。查挂载（$topology 里 /etc/lumo/edge-routes.json）"
    return 0
  fi
  pass "探针 2：edge-gateway 已加载并通过编译的路由 ${routes} 条"
}

# ---------------------------------------------------------------------------
# 探针 3：terminal-gateway 的 presence 只读面（C4）
# ---------------------------------------------------------------------------
#
# 与探针 1 的区别：探针 1 走的是**经边缘转发**的 WS 面，探针 3 直连只读面。
# 两条都留着是因为它们能失败的情形不同：探针 1 的 502 可能来自边缘的转发层，
# 而这里直连能立刻区分是「终端自己坏了」还是「边缘到终端这段坏了」。
probe_terminal_presence_face() {
  local terminal result code body url
  if ! terminal="$(resolve_host terminal-gateway)"; then
    target_absent terminal-gateway
    return 0
  fi
  url="http://127.0.0.1:${terminal}/v1/terminals/lumo-probe-ref/presence"

  result="$(probe_once_body "$url" -H "Authorization: Bearer $control_plane_token")" || true
  code="${result%%$'\t'*}"
  body="${result#*$'\t'}"

  case "$code" in
    transport:*)
      fail "probe-terminal-gateway-absent: ${url} —— $(transport_detail "$code")"
      return 0 ;;
    ok:401)
      fail "probe-gateway-token-mismatch: terminal-gateway 的 presence 面回了 401 —— 令牌不一致"
      return 0 ;;
    ok:404)
      fail "probe-terminal-presence-route: terminal-gateway 的 presence 面回了 404 ——" \
        "「/<session_ref>/presence」这条路由形状变了（handleTerminal 的后缀判定被改过？）"
      return 0 ;;
    ok:200)
      if [[ "$body" != *'"presence"'* ]]; then
        fail "probe-terminal-presence-shape: presence 面回了 200，但响应体里没有 \"presence\" 键" \
          "—— 形状变了，调用方（终端 UI）会静默拿到空列表。响应体: ${body:0:200}"
        return 0
      fi
      pass "探针 3：terminal-gateway 的 presence 只读面正常（返回体带 presence 字段）"
      return 0 ;;
    *)
      fail "probe-terminal-unexpected: presence 面答了 ${code#ok:} 响应体: ${body:0:200}"
      return 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# 探针 4 / 5 / 6：特性是否**装配进了这个部署的二进制**
# ---------------------------------------------------------------------------
#
# 这三条探针查的是一件静态配置查不到的事：**特性在部署里到底有没有被装配**。
# 它们的失效形态是「代码、指标、告警规则全都齐全，而部署里那个开关从头到尾没打开」——
# `cluster-registry-verify.sh` 正是为同一形态而建（那里的实例是一个从未在任何拓扑里
# 打开的开关）。所以这里查的不是「值为 1」，而是**这条序列在不在**：
# 序列在＝特性被装配了（哪怕值是 0，那也是「显式关掉」而不是「压根没有」）。
#
# 指标名是写死的字符串（值定义在代码里，见各自的文件:行 注释）。改名时本探针会红 ——
# 这是刻意的：它强迫改名的人来这里确认一次，而不是让探针跟着漂。
probe_metric_present() {
  local service="$1" metric="$2" where="$3" label="$4"
  local host result code body value attempt url
  if ! host="$(resolve_host "$service")"; then
    target_absent "$service"
    return 0
  fi
  url="http://127.0.0.1:${host}/metrics"

  for attempt in $(seq 1 "$metric_attempts"); do
    result="$(probe_once_body "$url")" || true
    code="${result%%$'\t'*}"
    body="${result#*$'\t'}"
    case "$code" in
      transport:*)
        fail "probe-service-absent: ${service} 的 /metrics 连不上 —— $(transport_detail "$code")"
        return 0 ;;
      ok:200) ;;
      *)
        fail "probe-metrics-face: ${service} 的 /metrics 答了 ${code#ok:}（期望 200）"
        return 0 ;;
    esac
    if value="$(metric_value "$metric" "$body")"; then
      pass "探针：${service} 导出了 ${metric}（当前值 ${value}）—— ${label}已装配"
      return 0
    fi
    sleep 2
  done

  fail "probe-feature-not-assembled: ${service} 在、/metrics 可读，但等了" \
    "$((metric_attempts * 2))s 仍**没有** ${metric} 这条序列 —— ${label}没被装配进这个部署" \
    "的二进制（${where}）。注意这与「值为 0」是两件事：0 是显式关掉，缺席是压根没有。"
  return 0
}

# ---------------------------------------------------------------------------
# 跑
# ---------------------------------------------------------------------------

echo "probes: 拓扑 ${topology}（派生 $(printf '%s\n' "$targets" | wc -l | tr -d ' ') 个控制面目标）"

probe_edge_to_terminal
probe_edge_routes_face
probe_terminal_presence_face
# C7：flows/cmd/flows/main.go:147,153 设置的 gauge —— 未配 LUMO_FLOW_NEBULA_URL 时值 0 且
# 带 reason 标签，配上时值 1 且无标签。探针只断言序列在，值照实报出来（0 是合法部署）。
probe_metric_present flows lumo_flow_lineage_projector_enabled \
  "flows/cmd/flows/main.go:147,153" "流程血缘投影器（C7）"
# C1：scheduler/internal/server/metrics.go:77 的 MetricTaskMigrations，由指标快照路径
# **无条件**发布（同文件 metrics.go:237），所以「装了但还没搬过家」（值 0）也看得出来。
probe_metric_present scheduler-0 lumo_scheduler_task_migrations_total \
  "scheduler/internal/server/metrics.go:77" "任务漂移循环（C1）"
# C5：session-control/internal/control/metrics.go:43 —— 三条无标签 gauge 由 PublishMetrics
# 无条件写入（cmd/session-control/main.go:193 的周期循环），所以序列缺席只可能是
# 「这一版没装配控制面累积器」。
probe_metric_present session-control lumo_session_control_forced_releases_total \
  "session-control/internal/control/metrics.go:43" "共享执行控制（C5）"

printf 'probes: %d 项通过 / %d 项失败\n' "$passed" "$failed"
if (( failed > 0 )); then
  exit 1
fi
echo "probes: 真集群行为探针全部通过。"

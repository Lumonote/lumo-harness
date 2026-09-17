#!/usr/bin/env bash
# 存活/行为探针的公共部分。两份东西：
#
#   ① 目标派生  derive_probe_targets / probe_target_port
#      —— 从 compose 拓扑算出「哪些服务该被探」与「它们的宿主端口是多少」。
#   ② HTTP 原语  probe_once / wait_healthz / classify_probe
#      —— 把一次探测的结果分成「服务不在」与「服务在但答错」，并给出各自的处置提示。
#
# 放在 lib 里而不是各脚本内联，是因为 `smoke-cluster.sh`（存活）与 `probes-cluster.sh`
# （行为）都要用，而两份实现迟早会在「哪种失败算哪种」上分叉——那是本仓库最贵的一类
# 缺陷：两份各自都对，只有交叉看才错。顺带它也让 CI 能对**派生**单独取证（不需要
# 集群、不需要 docker 守护进程）。
# ===========================================================================
# 一、目标派生
# ===========================================================================
#
# ## 为什么是派生，而不是一份手写名单
#
# 手写名单的腐烂方向恰好是它唯一要防的那个方向。2026-09-16 实测：`smoke-cluster.sh`
# 手写了 10 条 `wait_http`，而拓扑里有 13 个控制面服务 —— `edge-gateway`（18080）、
# `terminal-gateway`（18091）、`session-control`（18092）**三个服务没有任何存活探针**。
# 后果不是「少查三条」：这三个容器里的任何一个启动即崩，`smoke-cluster.sh` 照样打印
# 「cluster acceptance passed」。同一件事在 `preflight-deployment.sh` 也发生过一次
# （那里的注释自己记着「名单腐烂的方向恰是它唯一要防的方向」），说明靠人记住不管用。
#
# 所以这里换成派生：新增一个控制面服务会自动多一条探针，**漏掉它反而会红**。
#
# ## 约定（一条约定，不是一个可推导的事实）
#
# 判据是「容器端口落在 `[LUMO_CONTROL_PLANE_PORT_LO, LUMO_CONTROL_PLANE_PORT_HI]`」。
# 这条边界必须写死在这里，理由要讲清楚：拓扑只能告诉我们「端口是多少」，**不能**告诉
# 我们「哪些端口后面应该有一个 /healthz」。上界/下界是一条团队约定（控制面 HTTP 面用
# 8080-8099），把它伪装成从拓扑推出来会让下一个人以为它自动跟着拓扑走。
#
# ## 为什么不用 `docker compose config`
#
# 渲染结果确实更准（能看到 overlay 合并、变量插值后的真值），但它要求 docker 守护进程
# 可用 —— 而本函数同时被 CI 门禁调用，CI 里没有守护进程。所以这里解析的是**未渲染的
# 原始文本**，与 `compose-ports-check.py` 同一口径（那个门禁的存在理由之一正是「这件事
# 没有任何静态检查会拦住」）。代价是带 `:-默认值` 的宿主端口只能取默认值那一支：这与
# `compose-ports-check.py` 对「动态端口」的处理一致，且方向是安全的——取到默认值说明
# 有人显式写了默认，运行时若走另一支，探针会连不上并**报出**连不上。
#
# ## 用法
#
#   source "$repo_root/platform/deploy/lib/probes.sh"
#   derive_probe_targets compose.cluster.yml [compose.extra.yml ...]
#
# 输出每行 `<service>\t<host_port>\t<container_port>`；`host_port` 为空串表示该服务的
# 宿主端口静态判定不了 —— 调用方**必须**把它当成失败（`probe-targets-undecidable`），
# 而不是跳过：跳过它，「无法判定」与「没有问题」在输出上就长得一样了。
#
# 解析不出任何目标时**返回非零并打印原因**，不返回空列表：空列表会被调用方读成
# 「这个拓扑本来就没有控制面服务」，而门禁的全部价值就是发现漏看。
#
# 多文件表示**合并语义**（后者叠加在前者之上），同一 service+container 只保留一条。

# 控制面 HTTP 段的边界（见上：这是约定，不是推导出来的事实）。
LUMO_CONTROL_PLANE_PORT_LO="${LUMO_CONTROL_PLANE_PORT_LO:-8080}"
LUMO_CONTROL_PLANE_PORT_HI="${LUMO_CONTROL_PLANE_PORT_HI:-8099}"

# awk 程序用**引号 heredoc** 读进来，而不是写成单引号字符串。
# 理由是一个具体的坑：程序里需要匹配 `'`（YAML 允许单引号字符串），而单引号字符串
# 里写不出 `'`；退而用 `\047` 这个转义在 macOS awk 上能用，但在 mawk（Ubuntu 默认
# awk）上不可靠 —— 而本函数的两个调用点一个跑 macOS、一个跑 CI。
# 用 heredoc 就没有这层编码游戏。
#
# `IFS= read -r -d ''` 在读到 EOF 时必然返回非零，所以这里必须吞掉那个状态：
# 调用方普遍开着 `set -e`。
if ! IFS= read -r -d '' LUMO_PROBE_TARGETS_AWK <<'AWK'
function emit(svc, raw,   e, parts, n, last, cont, host, hp) {
  e = raw
  gsub(/["' \t]/, "", e)             # 去掉引号与空白
  sub(/\/[a-z]+$/, "", e)            # /tcp /udp
  if (e == "") return
  n = split(e, parts, ":")
  if (n < 2) return                  # `- 8090`：只写容器端口、不绑宿主，不产生探针面
  last = parts[n]
  if (last !~ /^[0-9]+$/) return     # 末段不是端口号（长语法 `target:` 等）→ 不猜
  cont = last + 0
  if (cont < LO || cont > HI) return
  host = ""
  hp = parts[n - 1]
  if (hp ~ /[0-9]+$/) {              # 含 `:-18080}` 这类默认值形态
    host = hp
    sub(/^.*[^0-9]/, "", host)
  }
  print svc "\t" host "\t" cont
}

BEGIN { svc = ""; inports = 0 }

# 服务键：缩进 2 的 `name:`（可带尾随注释）
/^  [a-z0-9][a-z0-9_-]*:[[:space:]]*(#.*)?$/ {
  svc = $0
  sub(/^  /, "", svc)
  sub(/:.*$/, "", svc)
  inports = 0
  next
}

# 顶层键：离开服务区
/^[A-Za-z]/ { svc = ""; inports = 0; next }

{
  if (svc == "") next

  # ports: 键。两种写法都要认：
  #   ports: ["18080:8080"]        （cluster 拓扑的写法）
  #   ports:\n  - "18080:8080"     （standalone 拓扑的写法）
  if ($0 ~ /^[[:space:]]+ports:/) {
    rest = $0
    sub(/^[[:space:]]*ports:[[:space:]]*/, "", rest)
    if (rest ~ /^\[/) {
      sub(/^\[/, "", rest)
      sub(/\][[:space:]]*$/, "", rest)
      n = split(rest, items, ",")
      for (i = 1; i <= n; i++) emit(svc, items[i])
      inports = 0
    } else {
      inports = 1
    }
    next
  }

  if (inports) {
    if ($0 ~ /^[[:space:]]+-[[:space:]]/) {
      rest = $0
      sub(/^[[:space:]]+-[[:space:]]*/, "", rest)
      emit(svc, rest)
      next
    }
    if ($0 ~ /^[[:space:]]*$/ || $0 ~ /^[[:space:]]*#/) next
    inports = 0
  }
}
AWK
then :; fi

# derive_probe_targets <compose 文件>...
#
# 成功时把目标打到 stdout（按 service+container 去重、按 service 排序）并返回 0；
# 一个目标都没派生出来时把原因打到 stderr 并返回 1。
derive_probe_targets() {
  if [[ $# -eq 0 ]]; then
    echo "probe-targets: 需要至少一个 compose 文件" >&2
    return 1
  fi

  local file raw
  raw=""
  for file in "$@"; do
    if [[ ! -r "$file" ]]; then
      echo "probe-targets: 读不到拓扑文件 $file" >&2
      return 1
    fi
    raw+="$(awk -v LO="$LUMO_CONTROL_PLANE_PORT_LO" -v HI="$LUMO_CONTROL_PLANE_PORT_HI" \
      "$LUMO_PROBE_TARGETS_AWK" "$file")"$'\n'
  done

  local derived
  derived="$(printf '%s' "$raw" | awk -F'\t' 'NF >= 3 && $1 != "" { seen[$1 "\t" $3] = $0 }
    END { for (k in seen) print seen[k] }' | LC_ALL=C sort)"

  if [[ -z "$derived" ]]; then
    echo "probe-targets: probe-targets-not-derived —— 在 $* 里一个控制面服务都没有派生出来" \
      "（判据是容器端口落在 ${LUMO_CONTROL_PLANE_PORT_LO}-${LUMO_CONTROL_PLANE_PORT_HI}）。" \
      "「解析器失效」与「拓扑本来就没有控制面服务」在退出码上必须分得开，所以这里直接失败。" >&2
    return 1
  fi

  printf '%s\n' "$derived"
}

# probe_target_port <service> <derive_probe_targets 的输出>
#
# 单独一条函数，是因为行为探针要按**服务名**找端口，而「按名字找不到」是一种必须
# 报出来的情况：服务被改名或从拓扑里删掉时，静默跳过就等于那条探针不再存在。
probe_target_port() {
  local service="$1" list="$2" svc host _
  while IFS=$'\t' read -r svc host _; do
    [[ "$svc" == "$service" ]] || continue
    printf '%s' "$host"
    return 0
  done <<< "$list"
  return 1
}

# ===========================================================================
# 二、HTTP 探针原语
# ===========================================================================
#
# 全部 HTTP 探测都必须带 `--noproxy '*'`，这不是可选项：探针打的是 127.0.0.1，而
# 只要环境里设了 `http_proxy`（2026-09-16 实测：开发机沙箱、不少公司网络都有），
# curl 会先把请求发给代理，代理连不上目标就回 **502**。于是探针把「服务不在」读成
# 「服务在但答错」，而真正的原因（端口上没人听）在输出里一个字都看不到——
# 一个**探测**环节引入的、把结论指向错误方向的噪声。
#
# 判据刻意不用 `curl --fail`：那会把「连不上」「超时」「HTTP 500」「HTTP 404」压成
# 同一个非零退出码，而它们的处置完全不同（前者去看容器起没起来/端口发没发布，
# 后者去看它自己的日志）。所以这里分开取 **curl 退出码** 与 **HTTP 状态码**。

# probe_once <url>
# 打印 `ok:<http 状态码>`（HTTP 层答上了，状态码是多少都不重要）或
# `transport:<curl 退出码>`（压根没答上：7=连不上、28=超时、6=解析不了主机名）。
# 返回 0 表示 HTTP 层答上了，1 表示传输层失败。
probe_once() {
  local url="$1" code rc=0
  # 退出码必须在 `if` **之前**取走：`if c; then …; fi` 在条件为假时整个 if 的退出码是 0，
  # 于是在 `fi` 之后 `$?` 已经不是 curl 的了（第一版就是这么写的，实测所有传输失败都
  # 报成 `transport:0`，看起来像「连上了」）。`|| rc=$?` 同时还让失败不触发 `set -e`。
  code="$(curl --noproxy '*' --silent --max-time "${LUMO_PROBE_TIMEOUT_SECONDS:-3}" \
    --output /dev/null --write-out '%{http_code}' "$url" 2>/dev/null)" || rc=$?
  if (( rc == 0 )); then
    printf 'ok:%s' "$code"
    return 0
  fi
  printf 'transport:%s' "$rc"
  return 1
}

# probe_once_body <url> [<curl 额外参数>...]
# 打印 `<probe_once 的结果>\t<响应体（单行）>`。响应体用于断言**内容**而不只是状态码
# （例如「503 且 reason 是 no_event_source」与「503 但原因不是它」是两件事）。
probe_once_body() {
  local url="$1"; shift
  local out rc=0
  out="$(curl --noproxy '*' --silent --max-time "${LUMO_PROBE_TIMEOUT_SECONDS:-3}" \
    --write-out $'\n%{http_code}' "$@" "$url" 2>/dev/null)" || rc=$?
  if (( rc != 0 )); then
    printf 'transport:%s\t' "$rc"
    return 1
  fi
  local code body
  code="${out##*$'\n'}"
  body="${out%$'\n'*}"
  printf 'ok:%s\t%s' "$code" "$(printf '%s' "$body" | tr -d '\n')"
  return 0
}

# classify_probe <probe_once 的输出>
# 把结果翻成两个机器可读的词 + 一句人话，供调用方决定处置。输出三行：
#   <ok|absent|wrong>   、<detail>、<hint>
# 分开的理由写在上面「判据刻意不用 --fail」那一段。
classify_probe() {
  local result="$1" code
  case "$result" in
    ok:2*)
      printf 'ok\nhttp %s\n服务在且自认健康\n' "${result#ok:}"
      return 0 ;;
    ok:*)
      code="${result#ok:}"
      printf 'wrong\nhttp %s\n服务**在**，但答错了状态码（进程活着却不认为自己健康，去看它自己的日志）\n' "$code"
      return 0 ;;
    transport:7)
      printf 'absent\ncurl exit 7\n服务不存在：端口上没有监听（容器没起来，或宿主端口没发布）\n'
      return 0 ;;
    transport:28)
      printf 'absent\ncurl exit 28\n连接超时：端口上有东西在听但不回应（进程卡死？）\n'
      return 0 ;;
    transport:6)
      printf 'absent\ncurl exit 6\n主机名解析不了（探针目标写错了？）\n'
      return 0 ;;
    transport:*)
      printf 'absent\ntransport %s\n连接失败（curl 退出码 %s）\n' "${result#transport:}" "${result#transport:}"
      return 0 ;;
  esac
  printf 'wrong\n无法分类\n探针输出不是预期的形态：%s\n' "$result"
  return 0
}

# wait_healthz <service> <host_port> [<尝试次数>]
# 轮询 `/healthz` 直到 2xx；超时后按 classify_probe 的结果打印**区分过**的失败文案。
wait_healthz() {
  local service="$1" host_port="$2" attempts="${3:-30}"
  local url="http://127.0.0.1:${host_port}/healthz"
  local attempt result
  for attempt in $(seq 1 "$attempts"); do
    result="$(probe_once "$url")" || true
    case "$result" in
      ok:2*) echo "smoke: ${service} /healthz ok"; return 0 ;;
    esac
    sleep 2
  done
  local kind detail hint
  {
    read -r kind
    read -r detail
    read -r hint
  } <<< "$(classify_probe "$result")"
  echo "smoke: FAIL: ${service} ${hint}（${detail}）: $url" >&2
  return 1
}

# ===========================================================================
# 三、正文解析原语（**刻意避开管道**）
# ===========================================================================
#
# ## 为什么不写 `count="$(… | grep -c …)"`
#
# 因为调用方普遍开着 `set -euo pipefail`，而 `grep` 在**零命中**时的退出码是 1 ——
# pipefail 让整条管道的退出码也变成 1，于是那个赋值语句返回 1，`set -e` 让脚本**当场
# 退出且什么都不打印**。实测（2026-09-16）：路由表为空的场景里，探针应当在退出前打印
# 那条「路由表是空的」FAIL 文案，实际却是静默退出 1 —— 探针把**最该被看见**的那种
# 缺陷（配置空了）报成了「没有任何解释的失败」。
#
# 所以正文解析一律走纯 bash 的字符串操作：没有子进程、没有退出码可被 pipefail 放大。

# string_count <子串> <正文>：返回出现次数。零次返回 0（不是失败）——「出现 0 次」是
# 一个**结论**，不是一个错误，[[]] 的语义在这里刚好。
string_count() {
  local needle="$1" haystack="$2" count=0
  while [[ "$haystack" == *"$needle"* ]]; do
    haystack="${haystack#*"$needle"}"
    count=$((count + 1))
  done
  printf '%s' "$count"
}

# metric_value <指标名> <Prometheus 文本>：取以该名字开头的第一条序列的值。
# 命中返回 0 并把值打到 stdout（可能是 0 / 1e+06 / -1 等）；没命中返回 1。
#
# 判据是「行首就是这个名字」而不是「正文里含这个子串」：`# HELP <名字> …` 这种注释行
# 也含这个名字，用子串判定会把「只有 HELP 没有样本」读成「指标在」——而那恰恰是
# 「注册了但从来没写过值」，与「装配好了」不是一回事。
#
# 序列行有两种形态，**必须都在**（第一版漏了第二种，于是无标签的 gauge 一律被判成
# 「没装配」——一个把结论指向反方向的假失败）：
#   `<name> 0`               无标签
#   `<name>{a="b"} 0`        带标签
# `#TYPE` / `#HELP` 行以 `#` 开头，天然不匹配。
metric_value() {
  local name="$1" text="$2" line
  while IFS= read -r line; do
    case "$line" in
      "$name"[[:space:]]*|"$name"{*)
        printf '%s' "${line##* }"
        return 0 ;;
    esac
  done <<< "$text"
  return 1
}



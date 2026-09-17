#!/usr/bin/env bash
# 入口网关 CORS 接线的静态门禁：**部署侧声明的名字必须是代码真正读的那个名字**，
# 并且同一个响应上只允许有一层 CORS。
#
# ## 为什么需要它
#
# edge-gateway 上有两层 CORS：`gate.CORS`（边缘自己的白名单，按**请求的 Origin** 裁决）
# 与 `observability.Middleware`（按**配置的来源**把 ACAO 写死）。两件事各自都对，
# 错法只出现在**跨文件对照**上，而且症状是「能用」：
#
#   2026-09-16 实测 compose.cluster.yml 与 compose.standalone.yml 给 edge-gateway 设的
#   正是 `LUMO_CORS_ORIGIN`（中间件读的那个），于是边缘白名单一直是空的、边缘层根本
#   没在管事——中间件那一层替它把 preflight 答了，curl 与手测全都正常。没有任何静态
#   检查能看出来，因为「配置看起来对」与「语义对」在文件里长得一样。
#
# 这与 cluster-registry-verify.sh 的「判定开着却没人自报」是同一种病（那一次也是
# 代码/测试/指标/告警全齐，只有可部署拓扑里少了一个变量），所以补的是门禁而不是文档。
#
# ## 判据从代码推导，不是写死的字符串
#
# 「部署里有没有 `LUMO_EDGE_CORS_ORIGINS`」是错的判据：代码改个旗标名，门禁会继续绿，
# 而部署侧那一行就成了废配置。所以检查器先读源码推导变量名（推导不出就报
# `cors-rule-not-derived`），下面第 8~10 条反例专门钉这件事：把代码侧改名之后，门禁
# 报出的必须是**新名字**，那才证明它不是在比对写死的字符串。
#
# ## 断言到具体文案，而不是退出码
#
# 退出码 1 可能来自任何一个检查，只断言「非零退出」等于给「检查被换成了另一个检查」
# 留后门（同 alerts-verify.sh / compose-ports-verify.sh 的理由）。下面每个缺陷用例都
# 断言检查器报出的是**预期的那一条**。
#
# ## 覆盖是遍历而不是点名
#
# 所有 `compose*.yml` 都过一遍：定义了受检网关的文件必须满足接线规则，没定义的必须
# 打印「未做网关检查」（沉默的通过与核对过的通过不是一回事）。按名字枚举文件会腐烂
# ——本仓库在 CI 的 DSN 注入上就吃过一次（按模块枚举，名单没跟着长）。
#
# 用法：platform/deploy/edge-cors-verify.sh
# 依赖：python3（只做文本替换与行扫描，不 import 任何第三方库）、helm

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/edge-cors-check.py"
CODE="$HERE/../control-plane"
CHART="$HERE/helm/lumo-platform"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lumo-edge-cors.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0
ok() { printf 'edge-cors-verify: OK: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'edge-cors-verify: FAIL: %s\n' "$1" >&2; failed=$((failed + 1)); }

for tool in python3 helm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "edge-cors-verify: 缺少依赖 ${tool}" >&2
    exit 1
  fi
done
ok "command python3 / helm"

# 代码根就是判据的来源。它不见了会让所有规则名推导失败——那种失败必须是一条明确的
# 「布局变了」，而不是 12 个看起来像拓扑缺陷的报错。
if [ ! -f "$CODE/observability/metrics.go" ]; then
  echo "edge-cors-verify: FAIL: 找不到 ${CODE}/observability/metrics.go（控制面布局变了？本门禁的判据由它推导）" >&2
  exit 1
fi
if ! compgen -G "$CODE/*/cmd/*/main.go" >/dev/null; then
  echo "edge-cors-verify: FAIL: 找不到任何 ${CODE}/*/cmd/*/main.go（布局变了？网关旗标要从这里推导）" >&2
  exit 1
fi
ok "代码根布局（observability/metrics.go 与 */cmd/*/main.go）"

cat >"$WORK/mutate.py" <<'PY'
import re
import sys

op, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4:]
text = open(src, encoding="utf-8").read()

if op == "sub":
    anchor, replacement = extra
    hits = text.count(anchor)
    if hits == 0:
        print(f"锚点未命中: {anchor!r}", file=sys.stderr)
        sys.exit(1)
    text = text.replace(anchor, replacement)
elif op == "drop":
    # 删掉一整段（含换行）。用于「把正确的覆盖整块删掉」这类缺陷：只删键名会留下悬空的
    # value 行，YAML 就废了，而废掉的 YAML 与「接线断了」不是一回事。
    anchor = extra[0]
    hits = text.count(anchor)
    if hits != 1:
        print(f"锚点命中 {hits} 处（期望 1）: {anchor!r}", file=sys.stderr)
        sys.exit(1)
    text = text.replace(anchor, "")
else:
    print(f"未知操作: {op}", file=sys.stderr)
    sys.exit(1)

open(dst, "w", encoding="utf-8").write(text)
PY

mutate() {
  local op="$1" src="$2" dst="$3"
  shift 3
  python3 "$WORK/mutate.py" "$op" "$src" "$dst" "$@" || true
}

# expect_pass <说明> <kind> <文件> [--require-gateways]
expect_pass() {
  local name="$1" kind="$2" file="$3"
  shift 3
  local out
  if ! out="$(python3 "$CHECK" --kind "$kind" --file "$file" "$@" 2>&1)"; then
    fail "${name}：本该通过，实际失败了"
    printf '%s\n' "$out" >&2
    return
  fi
  # 断言它真的解析到了内容并跑完了检查，而不是「什么都没看就退 0」——本仓库最容易退化的
  # 那种失效就是「没发现缺陷」与「没在找缺陷」在退出码上完全一样。
  if [[ "$out" != *"解析出"* ]]; then
    fail "${name}：退出码为 0，但没有报出任何解析结果"
    printf '%s\n' "$out" >&2
    return
  fi
  if [[ "$out" != *"通过（"* ]]; then
    fail "${name}：退出码为 0，但没有报出执行的检查项数"
    printf '%s\n' "$out" >&2
    return
  fi
  ok "$name"
}

# expect_pass_saying <说明> <kind> <文件> <必须出现的文案> [额外参数]
# 用于「允许为空」这类**正确但容易被读成没检查**的形态：光退 0 不够，必须把理由说出来。
expect_pass_saying() {
  local name="$1" kind="$2" file="$3" want="$4"
  shift 4
  local out
  if ! out="$(python3 "$CHECK" --kind "$kind" --file "$file" "$@" 2>&1)"; then
    fail "${name}：本该通过，实际失败了"
    printf '%s\n' "$out" >&2
    return
  fi
  if [[ "$out" != *"$want"* ]]; then
    fail "${name}：通过是通过了，但没有给出「${want}」这一条证据"
    printf '%s\n' "$out" >&2
    return
  fi
  ok "${name}（给出：${want}）"
}

# expect_fail <说明> <kind> <文件> <期望文案> [额外参数]
expect_fail() {
  local name="$1" kind="$2" file="$3" want="$4"
  shift 4
  local out
  if out="$(python3 "$CHECK" --kind "$kind" --file "$file" "$@" 2>&1)"; then
    fail "${name}：缺陷没有被抓住（门禁放行了）"
    return
  fi
  if [[ "$out" != *"$want"* ]]; then
    fail "${name}：报错了，但报的不是预期的那一条（期望含「${want}」）"
    printf '%s\n' "$out" >&2
    return
  fi
  ok "${name}（${want}）"
}

# ---------------------------------------------------------------------------
# 正向：真实的三个部署面都必须通过
# ---------------------------------------------------------------------------
CLUSTER="$HERE/compose.cluster.yml"
STANDALONE="$HERE/compose.standalone.yml"

expect_pass "compose.cluster.yml（边缘白名单接线 + 中间件那层没开）" compose "$CLUSTER" --require-gateways
expect_pass "compose.standalone.yml（同上）" compose "$STANDALONE" --require-gateways

if helm template lumo "$CHART" >"$WORK/helm-base.yaml" 2>"$WORK/helm-base.err" \
  && helm template lumo "$CHART" --set console.corsOrigin=https://console.example \
       >"$WORK/helm-cors.yaml" 2>"$WORK/helm-cors.err"; then
  ok "helm template 基础 profile 与「配了来源」的 profile 均可渲染"
  # 基础 profile 的白名单是**空串**：`console.corsOrigin` 默认为空，边缘层与中间件那层
  # 都不放行跨域，这是 fail-closed 默认而不是接线断了。所以这一条不能只断言退出码，
  # 必须断言它把理由说出来了（否则「通过」与「漏检」长得一样）。
  expect_pass_saying "Helm 基础 profile（未配来源 → 空白名单是 fail-closed 默认，不是缺陷）" \
    helm "$WORK/helm-base.yaml" "允许为空" --require-gateways
  expect_pass "Helm profile（配了 console.corsOrigin → 白名单必须非空）" helm "$WORK/helm-cors.yaml" --require-gateways
else
  fail "helm template 渲染失败"
  cat "$WORK/helm-base.err" "$WORK/helm-cors.err" >&2
fi

# ---------------------------------------------------------------------------
# 覆盖遍历：所有 compose*.yml 都要过一遍
# ---------------------------------------------------------------------------
# 受检网关的**服务名也从代码推**（含 `"cors-origins"` 旗标的那些 cmd 所属的服务目录）：
# 写死 `edge-gateway` 会在服务改名那天让遍历静默走进「本面不含网关」那一支。
CODE_REAL="$(cd "$CODE" && pwd)"
gateway_names="$(grep -l '"cors-origins"' "$CODE_REAL"/*/cmd/*/main.go 2>/dev/null \
  | sed -E "s#^${CODE_REAL}/([^/]+)/.*#\1#" | sort -u || true)"
if [ -z "$gateway_names" ]; then
  fail "从代码里推导不出任何自带 CORS 白名单的网关服务（旗标被删/改名？）"
  gateway_names="__none__"
else
  ok "代码侧推导出的网关服务：$(tr '\n' ' ' <<<"$gateway_names")"
fi

gateway_files=0
for f in "$HERE"/compose*.yml; do
  base="$(basename "$f")"
  defines_gateway=0
  while IFS= read -r gw; do
    [ -n "$gw" ] || continue
    if grep -qE "^  ${gw}:" "$f"; then
      defines_gateway=1
    fi
  done <<<"$gateway_names"
  if [ "$defines_gateway" -eq 1 ]; then
    gateway_files=$((gateway_files + 1))
    expect_pass "${base}（定义了入口网关 → 必须满足接线规则）" compose "$f" --require-gateways
  else
    # 没有网关的可选拓扑也必须走一遍并**说出来**它没做网关检查：沉默的通过与核对过的
    # 通过不是一回事（这一条同时把「本文件被本门禁覆盖了」记录下来）。
    expect_pass_saying "${base}（不含入口网关 → 必须说明未做网关检查）" \
      compose "$f" "未做网关检查"
  fi
done
if [ "$gateway_files" -lt 2 ]; then
  fail "compose 拓扑里只找到 ${gateway_files} 个定义了入口网关的文件（期望 ≥2）——遍历失效了？"
else
  ok "compose 拓扑遍历：${gateway_files} 个文件定义了入口网关，全部已核对"
fi

# ---------------------------------------------------------------------------
# 解析形态：env 写在**单行 flow mapping** 里的服务也必须读到
# ---------------------------------------------------------------------------
# 真实拓扑里就有这个形态（compose.cluster.yml 的 `vault: { image: ... }`），而它此前
# 会被整条漏掉——漏掉一个服务与那个服务没问题在退出码上完全一样。这里用两个合法 YAML
# 的小样本把这条路径钉住：能读到 env（正向），读不到就必须报缺（反向）。
cat >"$WORK/inline.yml" <<'YML'
services:
  edge-gateway: { image: lumo/edge-gateway:dev, environment: ["LUMO_EDGE_CORS_ORIGINS=${LUMO_CORS_ORIGIN:-http://127.0.0.1:4173}"] }
YML
expect_pass "flow mapping 形态的网关（env 写在行内也要读到）" compose "$WORK/inline.yml" --require-gateways

cat >"$WORK/inline-nocors.yml" <<'YML'
services:
  edge-gateway: { image: lumo/edge-gateway:dev, environment: ["LUMO_EDGE_ROUTES=/etc/lumo/edge-routes.json"] }
YML
expect_fail "flow mapping 形态但白名单缺失（不许因为读不到就跳过）" \
  compose "$WORK/inline-nocors.yml" "gateway-cors-missing" --require-gateways

# ---------------------------------------------------------------------------
# 反向：每个缺陷都必须被抓住，且报出预期的那一条
# ---------------------------------------------------------------------------

# 1. 这正是 2026-09-16 修掉的那个缺陷形态：白名单变量被换回中间件读的名字。
#    改完 compose 仍然是合法 YAML、网关仍然能起来、手测仍然正常——只有这条门禁会红。
mutate sub "$STANDALONE" "$WORK/r1-standalone.yml" \
  'LUMO_EDGE_CORS_ORIGINS: "${LUMO_CORS_ORIGIN:-http://127.0.0.1:4173}"' \
  'LUMO_CORS_ORIGIN: "${LUMO_CORS_ORIGIN:-http://127.0.0.1:4173}"'
if grep -q 'LUMO_CORS_ORIGIN: "${LUMO_CORS_ORIGIN' "$WORK/r1-standalone.yml"; then
  expect_fail "回归：白名单变量被换回中间件读的那个名字（边缘层静默失效）" \
    compose "$WORK/r1-standalone.yml" "dual-cors-source" --require-gateways
else
  fail "回归用例 1：锚点失效（拓扑被改过？）"
fi

# 2. 键还在、值被清空——「保留了那一行」会让人以为接线还活着。
mutate sub "$CLUSTER" "$WORK/r2-cluster.yml" \
  '"LUMO_EDGE_CORS_ORIGINS=${LUMO_CORS_ORIGIN:-http://127.0.0.1:4173}"' \
  '"LUMO_EDGE_CORS_ORIGINS="'
if grep -q '"LUMO_EDGE_CORS_ORIGINS="' "$WORK/r2-cluster.yml"; then
  expect_fail "白名单变量被清空（键还在，值没了）" \
    compose "$WORK/r2-cluster.yml" "gateway-cors-missing" --require-gateways
else
  fail "反例 2：锚点失效"
fi

# 3. 整个键被删掉（有人「顺手清理」掉了那行看起来多余的配置）。
#    判据必须带 `=`：这份文件里**注释**也提到过这个变量名，只 grep 名字的话这条用例
#    会在「变异生效」与「变异没生效」上都报错（实测踩过）。
mutate sub "$CLUSTER" "$WORK/r3-cluster.yml" \
  ', "LUMO_EDGE_CORS_ORIGINS=${LUMO_CORS_ORIGIN:-http://127.0.0.1:4173}"' ''
if ! grep -q 'LUMO_EDGE_CORS_ORIGINS=' "$WORK/r3-cluster.yml"; then
  expect_fail "白名单变量被整行删掉" \
    compose "$WORK/r3-cluster.yml" "gateway-cors-missing" --require-gateways
else
  fail "反例 3：锚点失效"
fi

# 4. 入口网关被改名/删掉：没有这条，一个「拓扑里根本没有网关」的仓库会全绿。
mutate sub "$STANDALONE" "$WORK/r4-standalone.yml" '  edge-gateway:' '  edge-gateway-moved:'
if grep -q '^  edge-gateway-moved:' "$WORK/r4-standalone.yml"; then
  expect_fail "入口网关被改名（本面里不再有受检网关）" \
    compose "$WORK/r4-standalone.yml" "required-service-absent" --require-gateways
else
  fail "反例 4：锚点失效"
fi

# 5. 入口网关被写进 `services:` 之外/被注掉——遍历必须以「拓扑里真的定义了网关」为准，
#    而不是以「文件里出现过这个词」为准。这里把服务键顶到 0 缩进（不再属于 services）。
mutate sub "$STANDALONE" "$WORK/r5-standalone.yml" '  edge-gateway:' 'edge-gateway:'
if grep -qE '^edge-gateway:' "$WORK/r5-standalone.yml"; then
  expect_fail "网关键被顶出 services 段（拓扑里不再有受检网关）" \
    compose "$WORK/r5-standalone.yml" "required-service-absent" --require-gateways
else
  fail "反例 5：锚点失效"
fi

# 6. Helm 面：容器把中间件那个变量设成了非空值 —— 两层 CORS 叠在同一个响应上。
if [ -f "$WORK/helm-cors.yaml" ]; then
  mutate sub "$WORK/helm-cors.yaml" "$WORK/r6-helm.yaml" \
    '            - name: LUMO_CORS_ORIGIN
              value: ""' \
    '            - name: LUMO_CORS_ORIGIN
              value: "https://console.example"'
  expect_fail "Helm：容器把中间件那层 CORS 又打开了（非空值）" \
    helm "$WORK/r6-helm.yaml" "dual-cors-source" --require-gateways

  # 7. Helm 面：正确的空值覆盖被整块删掉。envFrom 的注入会立刻生效，而单看容器
  #    （只看「容器里有没有非空」）是完全看不出来的——那条判据是这次的补丁之一。
  mutate drop "$WORK/helm-cors.yaml" "$WORK/r7-helm.yaml" \
    '            - name: LUMO_CORS_ORIGIN
              value: ""
'
  if ! grep -q 'name: LUMO_CORS_ORIGIN' "$WORK/r7-helm.yaml"; then
    expect_fail "Helm：空值覆盖被删掉（envFrom 的注入立刻生效）" \
      helm "$WORK/r7-helm.yaml" "dual-cors-source" --require-gateways
  else
    fail "反例 7：锚点失效"
  fi
else
  fail "反例 6/7：缺少 helm-cors.yaml（上一步渲染失败）"
fi

# 8. 模板副本：去掉 console.corsOrigin 回退。这一条是**渲染之后再判**的——只看模板
#    文本看不出「配了来源却渲染出空表」，只有渲染出来才看得见。
if command -v helm >/dev/null 2>&1; then
  cp -R "$CHART" "$WORK/chart-no-fallback"
  mutate sub "$WORK/chart-no-fallback/templates/deployment.yaml" \
    "$WORK/chart-no-fallback/templates/deployment.yaml.mutated" \
    '{{ default $.Values.console.corsOrigin (join "," $.Values.edgeGateway.corsOrigins) | quote }}' \
    '{{ join "," $.Values.edgeGateway.corsOrigins | quote }}'
  if [ -f "$WORK/chart-no-fallback/templates/deployment.yaml.mutated" ]; then
    mv "$WORK/chart-no-fallback/templates/deployment.yaml.mutated" \
      "$WORK/chart-no-fallback/templates/deployment.yaml"
    if helm template lumo "$WORK/chart-no-fallback" --set console.corsOrigin=https://console.example \
        >"$WORK/r8-helm.yaml" 2>"$WORK/r8-helm.err"; then
      expect_fail "Helm：模板丢了来源回退（配了来源却渲染出空白名单）" \
        helm "$WORK/r8-helm.yaml" "gateway-cors-missing" --require-gateways
    else
      fail "反例 8：模板副本渲染失败"
      cat "$WORK/r8-helm.err" >&2
    fi
  else
    fail "反例 8：锚点失效（deployment.yaml 的回退表达式被改过？）"
  fi
fi

# ---------------------------------------------------------------------------
# 反向（判据来自代码）：把代码侧的锚点改掉，门禁必须跟着变，而不是继续绿
# ---------------------------------------------------------------------------
mkdir -p "$WORK/code/edge-gateway/cmd/edge-gateway" "$WORK/code/observability"
cp "$CODE/edge-gateway/cmd/edge-gateway/main.go" "$WORK/code/edge-gateway/cmd/edge-gateway/main.go"
cp "$CODE/observability/metrics.go" "$WORK/code/observability/metrics.go"

# 9. 旗标被删掉：推导不出白名单变量名时必须**报错**，不能降级成「没有规则要查」。
mutate sub "$WORK/code/edge-gateway/cmd/edge-gateway/main.go" \
  "$WORK/code/main-no-flag.go" \
  'corsOrigins = flag.String("cors-origins", envOr("LUMO_EDGE_CORS_ORIGINS", ""), "允许的 CORS 来源（逗号分隔，* 通配）")' \
  'corsOrigins = flag.String("cors-allow", envOr("LUMO_EDGE_CORS_ORIGINS", ""), "允许的 CORS 来源（逗号分隔，* 通配）")'
if grep -q '"cors-allow"' "$WORK/code/main-no-flag.go"; then
  mv "$WORK/code/main-no-flag.go" "$WORK/code/edge-gateway/cmd/edge-gateway/main.go"
  expect_fail "代码侧旗标改名（推导不出白名单变量 → 不许静默放行）" \
    compose "$CLUSTER" "cors-rule-not-derived" --require-gateways --code-root "$WORK/code"
  # 复原，供下一条用
  cp "$CODE/edge-gateway/cmd/edge-gateway/main.go" "$WORK/code/edge-gateway/cmd/edge-gateway/main.go"
else
  fail "反例 9：锚点失效（cors-origins 旗标那行被改过？）"
fi

# 10. 白名单变量**改名**（旗标还在）：门禁报出的必须是新名字。报旧名字说明它在比对
#     写死的字符串，那这门禁在代码改名的当天就已经失效了。
mutate sub "$WORK/code/edge-gateway/cmd/edge-gateway/main.go" \
  "$WORK/code/edge-gateway/cmd/edge-gateway/main.go" \
  'envOr("LUMO_EDGE_CORS_ORIGINS", "")' 'envOr("LUMO_EDGE_CORS_ALLOW", "")'
expect_fail "代码侧白名单变量改名（门禁必须报出**新名字**，证明判据是推导来的）" \
  compose "$CLUSTER" "LUMO_EDGE_CORS_ALLOW" --require-gateways --code-root "$WORK/code"
cp "$CODE/edge-gateway/cmd/edge-gateway/main.go" "$WORK/code/edge-gateway/cmd/edge-gateway/main.go"

# 11. 中间件侧的锚点漂移（ACAO 头改名）：推导不出「中间件读哪个变量」时必须报错。
#     若不报错，规则 2 会退化成「找不到变量所以没人违规」——绿得毫无意义。
mutate sub "$WORK/code/observability/metrics.go" \
  "$WORK/code/metrics-no-ancor.go" 'Access-Control-Allow-Origin' 'X-Cors-Origin'
if grep -q 'X-Cors-Origin' "$WORK/code/metrics-no-ancor.go"; then
  mv "$WORK/code/metrics-no-ancor.go" "$WORK/code/observability/metrics.go"
  expect_fail "中间件侧 ACAO 锚点漂移（推导不出中间件变量 → 不许静默放行）" \
    compose "$CLUSTER" "cors-rule-not-derived" --require-gateways --code-root "$WORK/code"
else
  fail "反例 11：锚点失效"
fi

printf 'edge-cors-verify: %d 项通过 / %d 项失败\n' "$passed" "$failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
echo "edge-cors-verify: all checks passed."

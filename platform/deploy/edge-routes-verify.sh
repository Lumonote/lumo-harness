#!/usr/bin/env bash
# 边缘网关路由表的门禁：**被部署的那张表必须真的能被加载**，且缺陷表必须被拒绝。
#
# ## 为什么需要它
#
# `LUMO_EDGE_ROUTES` 指向的 JSON 是边缘网关的全部配置（缺口 C3 的实现）。它有三个特点
# 让「写完就没人看过」成为默认结局：
#
#   * 校验逻辑只在**服务启动时**跑，而 compose 里跑不起来才有人去看；
#   * `DisallowUnknownFields` 意味着多写一个字段就是启动失败——一份没人验过的表
#     大概率是坏的，而坏法是「服务起不来」而不是「服务行为不对」，最难联想的正是这个；
#   * 表里写的是**上游主机名**，拼错了在加载时会被白名单拦住，但白名单本身也可能被
#     照着错的名字改一遍——那样两边自洽、加载通过，直到运行期 502。
#
# 所以这里做两件事：正向证明被部署的那张表可用并**断言它覆盖了哪些前缀**（期望值写死，
# 不从表本身反推——反推等于拿被测对象给自己当期望值）；反向逐个注入缺陷，证明每种坏法
# 都会被抓住，且报出的是**预期的那一条**（只断言「非零退出」等于给「检查被换成另一个
# 检查」留后门，同 cluster-registry-verify.sh / alerts-verify.sh 的理由）。
#
# **被部署的表有两张，本脚本两张都验**（2026-09-16 补第二张）：
#
#   1. `edge-routes.dev.json` —— compose.cluster.yml 只读挂载给容器的那张；
#   2. `helm/lumo-platform/templates/edge-routes.yaml` 渲染出来的那张 —— Helm 拓扑的
#      全部路由配置。它在此前**没有任何门禁**：chart 侧唯一会看它的是 helm-verify.sh 的
#      结构断言（上游主机名与端口必须与同一次渲染出的 Service 一致），但那份断言不加载
#      这张表，而「加载」正是网关启动时唯一真正做的事。
#
#   只验第一张是有先例的错法：第一张表当初也被「只在服务启动时校验」保护着，而服务起不来
#   是最不像「配置写错」的症状。第二张表由模板生成、看起来更不容易错，于是更没人验——
#   而模板的错误恰恰是结构性的（少写一条路由、派生出一个不存在的上游名）。
#
# 用法：platform/deploy/edge-routes-verify.sh
# 依赖：go（跑 edge-gateway-check）、python3（只做 JSON 改写与提取，不 import 第三方库）、
#        helm（渲染第二张表；CI 的 production-gates 作业先装 helm 再装 go，见 ci.yml）

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROUTES="$HERE/edge-routes.dev.json"
CHART="$HERE/helm/lumo-platform"
GATEWAY_DIR="$HERE/../control-plane/edge-gateway"

# go 不在本机非登录 shell 的默认 PATH 上，缺了它会得到一片假失败。但**只在确实找不到时**
# 才补：CI 上的 go 是 setup-go 装的，无条件 prepend 一个写死的路径会把真正的 go 挤到后面，
# 于是本机绿、CI 红（或反过来），而那种分叉最难查。
if ! command -v go >/dev/null 2>&1 && [ -x /usr/local/bin/go ]; then
  export PATH="/usr/local/bin:$PATH"
fi

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lumo-edge-routes.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0
ok() { printf 'edge-routes-verify: OK: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'edge-routes-verify: FAIL: %s\n' "$1" >&2; failed=$((failed + 1)); }

for tool in go python3 helm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "edge-routes-verify: 缺少依赖 ${tool}（helm 是必需的：第二张被部署的表由 chart 渲染）" >&2
    exit 1
  fi
done
ok "command go / python3 / helm"

# 预编译自检入口一次：后面每个缺陷用例都要跑它，`go run` 每次都重新编译会很慢。
if ! ( cd "$GATEWAY_DIR" && go build -o "$WORK/edge-gateway-check" ./cmd/edge-gateway-check ) 2>"$WORK/build.err"; then
  fail "edge-gateway-check 构建失败"
  cat "$WORK/build.err" >&2
  printf 'edge-routes-verify: %d 项通过 / %d 项失败\n' "$passed" "$failed"
  exit 1
fi
ok "edge-gateway-check 构建"

# --- 第二张被部署的表：由 chart 渲染出来的那张 ---------------------------------
# 提取方式刻意简单：只取 `edge-routes.json: |` 之后缩进 4 空格的那段文本。用
# `helm template -s` 只渲染这一个模板，于是它是一份单文档的 ConfigMap，不需要
# 通用 YAML 解析（本脚本不 import 第三方库，也没有 yq）。
HELM_TABLE="$WORK/edge-routes.helm.json"
if helm template lumo "$CHART" -f "$CHART/values.cluster.yaml" -s templates/edge-routes.yaml \
  >"$WORK/edge-routes.helm.yaml" 2>"$WORK/helm.err"; then
  if python3 - "$WORK/edge-routes.helm.yaml" "$HELM_TABLE" <<'PY'
import json, sys

body, inside = [], False
for line in open(sys.argv[1], encoding="utf-8").read().split("\n"):
    if line.strip().startswith("edge-routes.json:"):
        inside = True
        continue
    if inside:
        if line.startswith("    "):
            body.append(line[4:])
        elif line.strip():
            break
if not inside:
    print("渲染结果里没有 edge-routes.json 键", file=sys.stderr)
    sys.exit(2)
text = "\n".join(body)
try:
    json.loads(text)
except Exception as err:
    print(f"渲染出的路由表不是合法 JSON: {err}", file=sys.stderr)
    sys.exit(3)
open(sys.argv[2], "w", encoding="utf-8").write(text)
PY
  then
    ok "chart 渲染出的路由表可提取（templates/edge-routes.yaml）"
  else
    fail "chart 渲染出的路由表无法提取"
  fi
else
  fail "helm template 渲染 templates/edge-routes.yaml 失败"
  cat "$WORK/helm.err" >&2
fi

cat >"$WORK/mutate.py" <<'PY'
import json, sys

src, dst, op = sys.argv[1:4]
table = json.load(open(src, encoding="utf-8"))

if op == "unknown_field":
    table["routes"][0]["bogus"] = 1
elif op == "duplicate_prefix":
    table["routes"].append(dict(table["routes"][0]))
elif op == "overlap_prefix":
    # /v1/pro 是 /v1/providers 与 /v1/projects 的前缀 → 匹配歧义
    table["routes"].append({"prefix": "/v1/pro", "upstream": "http://llm-gateway:8088"})
elif op == "upstream_not_whitelisted":
    table["routes"][0]["upstream"] = "http://evil.example:1234"
elif op == "canary_weight_zero":
    table["routes"][0]["canary"] = {"upstream": "http://llm-gateway:8088", "weight": 0}
elif op == "canary_weight_hundred":
    table["routes"][0]["canary"] = {"upstream": "http://llm-gateway:8088", "weight": 100}
elif op == "canary_upstream_not_whitelisted":
    table["routes"][0]["canary"] = {"upstream": "http://evil.example:1", "weight": 10}
elif op == "bad_prefix":
    table["routes"][0]["prefix"] = "v1/chat/"
elif op == "empty_routes":
    table["routes"] = []
else:
    print(f"未知的缺陷注入动作: {op}", file=sys.stderr)
    sys.exit(3)

json.dump(table, open(dst, "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY

# expect_ok <说明> <文件>
expect_ok() {
  local name="$1" file="$2" out
  if ! out="$("$WORK/edge-gateway-check" "$file" 2>&1)"; then
    fail "${name}：本该通过，实际失败了"
    printf '%s\n' "$out" >&2
    return
  fi
  # 计数守卫：退 0 但没有报出路由数 = 一个检查都没执行（自检入口被改坏/参数没传进去）。
  case "$out" in
    *'"routes"'*) ok "$name" ;;
    *) fail "${name}：退出码为 0，但没有报出任何路由摘要"; printf '%s\n' "$out" >&2 ;;
  esac
}

# expect_fail <说明> <文件> <期望文案>
expect_fail() {
  local name="$1" file="$2" want="$3" out
  if out="$("$WORK/edge-gateway-check" "$file" 2>&1)"; then
    fail "${name}：缺陷没有被抓住（门禁放行了）"
    return
  fi
  case "$out" in
    *"$want"*) ok "${name}（${want}）" ;;
    *)
      fail "${name}：报错了，但报的不是预期的那条"
      printf '%s\n' "$out" >&2
      ;;
  esac
}

# run_mutation <说明> <动作> <期望文案>
run_mutation() {
  # 分两句写：`local a="$1" b="$a"` 里的 `$a` 由 shell 在调用 local **之前**展开，
  # 那时局部变量还没建立，`set -u` 下会直接 "unbound variable" 把脚本打死。
  local name="$1" op="$2" want="$3"
  local mutated="$WORK/$op.json"
  if ! python3 "$WORK/mutate.py" "$ROUTES" "$mutated" "$op"; then
    fail "${name}：无法制造缺陷（注入动作失效？）"
    return
  fi
  expect_fail "$name" "$mutated" "$want"
}

# 覆盖面的期望值**写死**：要的是「有人想过应该代理哪些面」，而不是「表里有什么就算什么」。
# 少一条会报出来（比如有人以为路由改了其实没生效），多一条也会。两张表共用这一个期望值
# ——compose 与 Helm 描述的是同一个系统，若两张表分叉，那本身就是缺陷。
expected_prefixes='/v1/auth/ /v1/chat/ /v1/flows /v1/operators /v1/projects /v1/providers /v1/tasks/ /v1/terminals/'

# check_coverage <说明> <文件>：断言覆盖面与预期一致，且白名单无悬空条目。
# 白名单里每一条都必须真的被某条路由用到：白名单拼错了主机、或路由删了但白名单没删，
# 都会留下悬空条目，而悬空条目本身不影响加载、只影响「我改了白名单但没生效」的判断。
# （Helm 那张表的白名单是渲染时从路由派生的，所以这项对它恒成立——仍然断言，因为
# 「恒成立」一旦被谁改成手写清单就必须立刻报出来。）
# prefixes_of <文件>：把该表覆盖的前缀集合打印成一行（由自检入口的实际输出解析而来，
# 不是直接读 JSON——这样连「自检入口报的路由数与表里不一致」也会被发现）。
prefixes_of() {
  "$WORK/edge-gateway-check" "$1" | python3 -c '
import json, sys
t = json.load(sys.stdin)
print(" ".join(sorted(r["prefix"] for r in t["table"])))
'
}

check_coverage() {
  local label="$1" file="$2" actual dangling
  actual="$(prefixes_of "$file")"
  if [ "$actual" = "$expected_prefixes" ]; then
    ok "${label}：覆盖面与预期一致（8 条：${expected_prefixes}）"
  else
    fail "${label}：覆盖面与预期不一致
  期望: $expected_prefixes
  实际: $actual"
  fi

  dangling="$(python3 - "$file" <<'PY'
import json, sys
from urllib.parse import urlparse
t = json.load(open(sys.argv[1], encoding="utf-8"))
used = set()
for r in t["routes"]:
    used.add(urlparse(r["upstream"]).netloc)
    if r.get("canary"):
        used.add(urlparse(r["canary"]["upstream"]).netloc)
print(" ".join(sorted(h for h in t["whitelist"] if h not in used)))
PY
)"
  if [ -z "$dangling" ]; then
    ok "${label}：白名单无悬空条目（每条都被某条路由用到）"
  else
    fail "${label}：白名单存在悬空条目（改了白名单却没改路由，或反之）：$dangling"
  fi
}

# --- 正向：两张被部署的表都必须真的能被网关加载，且覆盖面一致 --------------------
expect_ok "edge-routes.dev.json 可加载 / 校验 / 编译" "$ROUTES"
check_coverage "edge-routes.dev.json" "$ROUTES"

if [ -s "$HELM_TABLE" ]; then
  expect_ok "chart 渲染的路由表可加载 / 校验 / 编译" "$HELM_TABLE"
  check_coverage "chart 渲染的路由表" "$HELM_TABLE"
else
  fail "chart 渲染的路由表为空，无法校验（提取步骤失败？）"
fi

# --- 反向：每种坏法都必须被抓住，且报出预期的那一条 -----------------------------
# 未知字段的文案来自标准库 encoding/json（`unknown field "bogus"`），不是我们自己写的
# 中文句子。断言实测文案而不是「看起来应该是什么」——这条一开始就是按想象写的，被门禁
# 自己抓了出来。
run_mutation "表里多写一个未知字段" unknown_field 'unknown field "bogus"' || true
run_mutation "两条路由前缀完全重复" duplicate_prefix "重复" || true
run_mutation "两条路由前缀重叠（/v1/pro 覆盖 /v1/providers）" overlap_prefix "前缀重叠" || true
run_mutation "上游主机不在白名单内" upstream_not_whitelisted "不在白名单内" || true
run_mutation "灰度权重为 0（是全量而非分流）" canary_weight_zero "weight 必须落在 (0,100)" || true
run_mutation "灰度权重为 100（是全覆盖而非分流）" canary_weight_hundred "weight 必须落在 (0,100)" || true
run_mutation "灰度上游不在白名单内" canary_upstream_not_whitelisted "canary: upstream 主机" || true
run_mutation "前缀没以 / 开头" bad_prefix "prefix 必须以 / 开头" || true
run_mutation "路由被删空（全站 404 与坏合并无法区分）" empty_routes "没有任何路由" || true

# --- 反向：第二张表（chart 渲染出来的那张）的两处专属断言 ----------------------
# 上面九个缺陷注入都跑在 dev 表上。下面两条针对渲染表**独有的**两处设计，否则「第二张表
# 也验了」这句话只覆盖了它的表层。
if [ -s "$HELM_TABLE" ]; then
  # ① 派生白名单仍然在加载期起作用。它的条目是模板从路由生成出来的，所以「上游不在
  #    白名单内」在**配置面**已经不可能出现（指向未部署的服务在渲染期就失败，见
  #    helm-verify.sh 的反例）。把缺陷注入到渲染产物里验的是另一件事：这张派生出来的
  #    白名单没有被「反正是自己生成的」顺手关掉。
  if python3 "$WORK/mutate.py" "$HELM_TABLE" "$WORK/helm-not-whitelisted.json" upstream_not_whitelisted; then
    expect_fail "Helm 表：上游主机不在派生白名单内" "$WORK/helm-not-whitelisted.json" "不在白名单内"
  else
    fail "Helm 表：无法制造缺陷（注入动作失效？）"
  fi

  # ② 覆盖面断言对渲染表也是活的：删掉一条路由后，它必须与写死的期望值不一致。
  #    少了这一条，上面那句「覆盖面与预期一致」可能是拿渲染结果自己当期望值。
  python3 - "$HELM_TABLE" "$WORK/helm-route-dropped.json" <<'PY'
import json, sys
t = json.load(open(sys.argv[1], encoding="utf-8"))
t["routes"] = [r for r in t["routes"] if r["prefix"] != "/v1/tasks/"]
json.dump(t, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, indent=2)
PY
  if [ "$(prefixes_of "$WORK/helm-route-dropped.json")" != "$expected_prefixes" ]; then
    ok "Helm 表：少一条路由会被覆盖面断言报出（期望值确实写死）"
  else
    fail "Helm 表：删掉 /v1/tasks/ 之后覆盖面断言仍然认为一致"
  fi
else
  fail "Helm 表：渲染产物为空，两条专属断言无法执行"
fi

printf 'edge-routes-verify: %d 项通过 / %d 项失败\n' "$passed" "$failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
echo "edge-routes-verify: all checks passed."

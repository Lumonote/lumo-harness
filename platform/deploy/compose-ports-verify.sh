#!/usr/bin/env bash
# compose 宿主端口冲突的静态门禁：**合并后的拓扑里，一个宿主端口只能有一个主张方**。
#
# ## 为什么需要它
#
# 冲突**不是** compose 配置错误：`docker compose config` 与 `up --dry-run` 都能过，失败发生在
# 容器真正启动的那一刻（`Bind for 0.0.0.0:18090 failed: port is already allocated`）。所以
# 没有任何静态检查会拦住它，只能靠人记住。
#
# 2026-09-16 踩到的形态值得记下来，因为它是本仓库的常客：`compose.cluster.yml` 给
# terminal-gateway 写了宿主 18090，而**可选** overlay `compose.cluster.devices.yml` 早已把
# 18090 给了 governance 容器里的设备网关（TLS passthrough）。两个文件各自都对，
# 只有 `-f compose.cluster.yml -f compose.cluster.devices.yml` 合并起来才是错的——
# 而「合并起来才是错的」这条路径恰恰是最常被跑的那条。
#
# ## 断言到具体文案，而不是退出码
#
# 退出码 1 可能来自任何一个检查，只断言「非零退出」等于给「检查被换成了另一个检查」留后门
# （同 alerts-verify.sh / cluster-registry-verify.sh 的理由）。下面每个缺陷用例都断言检查器
# 报出的是**预期的那一条**。
#
# ## 保守方向
#
# `port-collision` 的判据是「宿主端口号相同」，**不区分绑定地址**：`0.0.0.0:18090` 与
# `127.0.0.1:18090` 在实机上依然互斥，而「地址不同所以不冲突」是需要逐案论证的判断，
# 不该塞进门禁。宁可真报一次让人显式确认。
#
# 用法：platform/deploy/compose-ports-verify.sh
# 依赖：python3（只做文本替换与行扫描，不 import 任何第三方库）

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/compose-ports-check.py"
CLUSTER="$HERE/compose.cluster.yml"
DEVICES="$HERE/compose.cluster.devices.yml"
STANDALONE="$HERE/compose.standalone.yml"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lumo-compose-ports.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0
ok() { printf 'compose-ports-verify: OK: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'compose-ports-verify: FAIL: %s\n' "$1" >&2; failed=$((failed + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
  echo "compose-ports-verify: 缺少依赖 python3" >&2
  exit 1
fi
ok "command python3"

cat >"$WORK/mutate.py" <<'PY'
import re
import sys

op, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
extra = sys.argv[4:]
text = open(src, encoding="utf-8").read()

if op == "sub":
    anchor, replacement = extra
    if text.count(anchor) == 0:
        print(f"锚点未命中: {anchor!r}", file=sys.stderr)
        sys.exit(1)
    text = text.replace(anchor, replacement)
elif op == "sub-line":
    # **整行**匹配的替换。`sub` 用裸字符串替换，而服务名那类锚点在文件里到处都是子串
    # （`      postgres: { condition: service_healthy }` 就含 `  postgres:`，实测 17 处），
    # 于是 `sub` 会改出一堆不相干的行。服务名要按整行锚定。
    import re
    anchor, replacement = extra
    pattern = re.compile(r"^" + re.escape(anchor) + r"$", re.M)
    hits = len(pattern.findall(text))
    if hits != 1:
        print(f"整行锚点命中 {hits} 次（要求恰好 1 次）: {anchor!r}", file=sys.stderr)
        sys.exit(1)
    text = pattern.sub(lambda _: replacement, text, count=1)
elif op == "rename-ports-key":
    # 让解析器一个 `ports:` 键都看不到，验证「什么都没采集到」会失败而不是安静通过。
    text = text.replace("ports:", "portz:")
elif op == "insert-long-syntax":
    anchor = extra[0]
    long_form = ('    ports:\n'
                 '      - target: 9999\n'
                 '        published: "19999"')
    if text.count(anchor) == 0:
        print(f"锚点未命中: {anchor!r}", file=sys.stderr)
        sys.exit(1)
    text = text.replace(anchor, long_form)
else:
    print(f"未知操作: {op}", file=sys.stderr)
    sys.exit(1)

open(dst, "w", encoding="utf-8").write(text)
PY

# expect_pass <说明> <文件参数...>
expect_pass() {
  local name="$1"
  shift
  local out
  if ! out="$(python3 "$CHECK" "$@" 2>&1)"; then
    fail "${name}：本该通过，实际失败了"
    printf '%s\n' "$out" >&2
    return
  fi
  # 断言它真的解析到了端口条目，而不是「一个条目都没看到就退 0」——这正是本门禁最容易
  # 退化成的那种失效（「没发现冲突」与「没在找冲突」在退出码上完全一样）。
  case "$out" in
    *"通过（"*) ok "$name" ;;
    *) fail "${name}：退出码为 0，但没有报出任何解析结果"; printf '%s\n' "$out" >&2 ;;
  esac
}

# expect_fail <说明> <期望文案> <文件参数...>
expect_fail() {
  local name="$1" want="$2"
  shift 2
  local out
  if out="$(python3 "$CHECK" "$@" 2>&1)"; then
    fail "${name}：缺陷没有被抓住（门禁放行了）"
    return
  fi
  case "$out" in
    *"$want"*) ok "${name}（${want}）" ;;
    *)
      fail "${name}：报错了，但报的不是预期的那一条"
      printf '%s\n' "$out" >&2
      ;;
  esac
}

mutate() {
  local op="$1" src="$2" dst="$3"
  shift 3
  python3 "$WORK/mutate.py" "$op" "$src" "$dst" "$@" || true
}

# --- 正向：真实拓扑（含合并语义）都必须通过 --------------------------------------
expect_pass "compose.cluster.yml + compose.cluster.devices.yml（合并语义）" \
  --file "$CLUSTER" --file "$DEVICES"
expect_pass "compose.cluster.yml 单独" --file "$CLUSTER"
expect_pass "compose.standalone.yml 单独" --file "$STANDALONE"

# 反向 0：宿主端口写成不带默认值的变量时，它**不是**冲突（不能因为静态判不了就报错，
# 否则门禁会逼着人把动态端口写成硬编码）。这一条钉住这个边界。
mutate sub "$CLUSTER" "$WORK/dynamic.yml" '"18080:8080"' '"${LUMO_EDGE_PORT}:8080"'
if out="$(python3 "$CHECK" --file "$WORK/dynamic.yml" 2>&1)"; then
  case "$out" in
    *"不可静态判定"*) ok "动态宿主端口：提示而不报错（边界）" ;;
    *) fail "动态宿主端口：通过了但没有提示，等于静默忽略"; printf '%s\n' "$out" >&2 ;;
  esac
else
  fail "动态宿主端口被当成冲突了（门禁过紧）"
  printf '%s\n' "$out" >&2
fi

# --- 反向 1：本仓库真实踩过的那一次 —— 把 terminal-gateway 的端口还原成 18090 ----------
# 这是本门禁存在的唯一理由，必须有一个用例把它钉住，否则下次有人「顺手改回 18090」
# 只会得到一次容器起不来，而不是一条门禁失败。
mutate sub "$CLUSTER" "$WORK/regressed.yml" '"18091:8090"' '"18090:8090"'
if grep -q '"18090:8090"' "$WORK/regressed.yml"; then
  expect_fail "回归：terminal-gateway 与设备网关再次同时主张宿主 18090" \
    "port-collision: 宿主端口 18090" --file "$WORK/regressed.yml" --file "$DEVICES"
else
  fail "回归用例：无法把端口改回 18090（锚点失效？拓扑被改过？）"
fi

# --- 反向 2：单文件内两个服务主张同一个宿主端口 --------------------------------
mutate sub "$CLUSTER" "$WORK/dup-in-file.yml" '"18091:8090"' '"18089:8090"'
if grep -q '"18089:8090"' "$WORK/dup-in-file.yml"; then
  expect_fail "同一个文件里两个服务撞车（18089 = governance 的端口）" \
    "port-collision: 宿主端口 18089" --file "$WORK/dup-in-file.yml"
else
  fail "单文件撞车用例：锚点失效"
fi

# --- 反向 2b：服务名带**行内注释**时，它的 ports 不能被漏掉 ---------------------------
# 2026-09-20 修：首版的服务名正则要求行尾没有别的东西，于是 `  postgres:   # 注释` 不被
# 识别为服务，它的整段 `ports:` 被当成「不在服务区内」处理。**方向是 fail-open**：冲突的
# 另一方成了唯一主张者，于是**真冲突被放行**（实测过，退出码 0）。而本仓库
# `compose.standalone.yml` 里有 8 个带行内注释的服务名，cluster 一个都没有 ——
# 也就是说这个盲区在本机只对 standalone 生效，而 standalone 恰是最常起的那一个。
mutate sub-line "$CLUSTER" "$WORK/inline-a.yml" \
  '  postgres:' '  postgres:   # 行内注释
    ports: ["15432:5432"]'
mutate sub-line "$WORK/inline-a.yml" "$WORK/inline-comment.yml" \
  '  nacos:' '  nacos:
    ports: ["15432:8848"]'
if grep -q '"15432:8848"' "$WORK/inline-comment.yml"; then
  expect_fail "回归：服务名带行内注释时，真冲突仍必须被抓到（fail-open 盲区）" \
    "port-collision: 宿主端口 15432" --file "$WORK/inline-comment.yml"
else
  fail "行内注释用例：锚点失效（postgres / nacos 的服务名写法变了？）"
fi

# --- 反向 3：一个 ports 条目都解析不出来（解析器失效 / 拓扑被删空）------------------
mutate rename-ports-key "$CLUSTER" "$WORK/no-ports.yml"
expect_fail "拓扑里不再有任何 ports 键（解析失效的形态）" \
  "topology-not-parsed" --file "$WORK/no-ports.yml"

# --- 反向 4：解析不出来的端口写法必须报错，不能跳过 --------------------------------
# 长语法（`- target:` / `- published:`）落在这一支。跳过它的后果很具体：解析盲区与
# 「真的没有冲突」在输出上完全一样。
mutate insert-long-syntax "$CLUSTER" "$WORK/long-syntax.yml" '    ports: ["18080:8080"]'
expect_fail "长语法端口项（解析不了就必须喊，不能跳过）" \
  "port-entry-unparsed" --file "$WORK/long-syntax.yml"

printf 'compose-ports-verify: %d 项通过 / %d 项失败\n' "$passed" "$failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
echo "compose-ports-verify: all checks passed."

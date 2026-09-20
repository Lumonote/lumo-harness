#!/usr/bin/env bash
# 联邦注册表的静态门禁：**开了判定，就真的有上报方**。
#
# ## 为什么需要它
#
# `LUMO_CLUSTER_ENFORCE` 让调度器按自报判集群存活（可疑/下线的集群不再接受新放置，
# 见 architecture.md §7.4.1 与 docs/superpowers/specs/2026-09-15-multicluster-scheduling-design.md）。
# 这套机制在**任何单个文件里都是对的**，错法只出现在跨文件对照上：
#
#   * 判定开关写在 scheduler 服务上，上报方却必须写在 dsh-node 服务上；
#   * 一个调度实例只有一个 `LUMO_SCHEDULER_CLUSTER_ID`，所以它能替**一个**集群宣称
#     存活——一个服务多个集群的拓扑里，其余集群没有上报方；
#   * 而没有上报方的集群会停在 `unregistered`，而 `BlocksPlacement` 只拦 suspect/down
#     → 闸门恒放行。于是**判定看起来生效了，实际上一分钱的作用都没有**。
#
# 2026-09-16 发现的第一版就是这个形状：代码、测试、指标、告警都齐全，而
# `LUMO_SCHEDULER_CLUSTER_ID` / `LUMO_CLUSTER_ENFORCE` 在 compose 与 Helm 里**一个都
# 没有** —— 判定在整个可部署拓扑里是关的。这与本仓库在 CI 上踩过的「没人调用的门禁
# 与通过的门禁无法区分」是同一种病，所以补的是门禁而不是文档。
#
# ## 版本一致性前置（§7.4.1）是同一种病的第二个病例
#
# `LUMO_CLUSTER_VERSION_GATE` 开着时，闸门判定的**全部输入**是「有人声明版本」。而
# 声明方是承载节点的 `LUMO_CLUSTER_VERSION`，开关却在 scheduler 服务上——又是跨文件
# 对照才看得出来的形状。没人声明时 `VersionConsistency.Declared == 0`，判定为
# 「无信息一致」→ 恒放行：**开关是开的，作用为零**。所以这条门禁也管它，外加
# 「闸门开着而拓扑写死了两个版本」（闸门会整体拒绝全局放置，症状与「没有容量」同形）。
#
# ## 断言到具体文案，而不是退出码
#
# 退出码 1 可能来自任何一个检查，只断言「非零退出」等于给「检查被换成了另一个检查」
# 留后门（同 alerts-verify.sh 的理由）。下面每个缺陷用例都断言检查器报出的是**预期的
# 那一条**。
#
# 用法：platform/deploy/cluster-registry-verify.sh
# 依赖：python3（只做文本替换与行扫描，不 import 任何第三方库）、helm

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/cluster-registry-check.py"
CLUSTER_COMPOSE="$HERE/compose.cluster.yml"
STANDALONE_COMPOSE="$HERE/compose.standalone.yml"
CHART="$HERE/helm/lumo-platform"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lumo-cluster-registry.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0
ok() { printf 'cluster-registry-verify: OK: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'cluster-registry-verify: FAIL: %s\n' "$1" >&2; failed=$((failed + 1)); }

for tool in python3 helm; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "cluster-registry-verify: 缺少依赖 $tool" >&2
    exit 1
  fi
done
ok "command python3 / helm"

cat >"$WORK/mutate.py" <<'PY'
import sys

# 支持一次替换多组锚点：有些缺陷必须同时改两处才能造出来（例如「闸门打开」+「没人
# 声明版本」）。只支持一组时，那些用例就只能靠手写第二份拓扑，而手写的那份一旦与
# 真实拓扑漂移，用例就变成了在验证一个不存在的形状。
if len(sys.argv) < 5 or (len(sys.argv) - 3) % 2 != 0:
    print("用法: mutate.py <src> <dst> <anchor> <replacement> [<anchor> <replacement> ...]",
          file=sys.stderr)
    sys.exit(2)

src, dst = sys.argv[1], sys.argv[2]
pairs = list(zip(sys.argv[3::2], sys.argv[4::2]))
text = open(src, encoding="utf-8").read()
counts = []
for anchor, replacement in pairs:
    count = text.count(anchor)
    if count == 0:
        print(f"锚点未命中: {anchor!r}", file=sys.stderr)
        sys.exit(1)
    counts.append(count)
    text = text.replace(anchor, replacement)
open(dst, "w", encoding="utf-8").write(text)
print(" ".join(str(c) for c in counts))
PY

# expect_pass <说明> <kind> <文件> <期望形态>
expect_pass() {
  local name="$1" kind="$2" file="$3" mode="$4" out
  if ! out="$(python3 "$CHECK" --kind "$kind" --file "$file" --expect-mode "$mode" 2>&1)"; then
    fail "${name}：本该通过，实际失败了"
    printf '%s\n' "$out" >&2
    return
  fi
  # 断言它真的跑过检查，而不是「一个检查都没执行就退 0」——本仓库在 CI 上吃过
  # 「静默跳过而套件仍打印通过」的亏。
  case "$out" in
    *"通过（"*) ok "$name" ;;
    *) fail "${name}：退出码为 0，但没有报出任何执行过的检查"; printf '%s\n' "$out" >&2 ;;
  esac
}

# expect_fail <说明> <kind> <文件> <期望形态> <期望文案>
expect_fail() {
  local name="$1" kind="$2" file="$3" mode="$4" want="$5" out
  if out="$(python3 "$CHECK" --kind "$kind" --file "$file" --expect-mode "$mode" 2>&1)"; then
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

# run_mutation <说明> <锚点> <替换> <期望文案>
run_mutation() {
  local name="$1" anchor="$2" replacement="$3" want="$4" mutated="$WORK/$1.yml" hits
  if ! hits="$(python3 "$WORK/mutate.py" "$CLUSTER_COMPOSE" "$mutated" "$anchor" "$replacement")"; then
    fail "${name}：无法制造缺陷（锚点失效？拓扑被改过？）"
    return
  fi
  run_mutation_hits "$name" "$hits"
  expect_fail "$name" compose "$mutated" cluster "$want"
}

# run_mutation_many <说明> <锚点> <替换> [<锚点> <替换> ...] —— 需要同时改多处才能造出
# 的缺陷（例如「闸门打开」+「两个集群各声明一个版本」）。
run_mutation_many() {
  local name="$1" want="$2" mutated="$WORK/$1.yml" hits
  shift 2
  if ! hits="$(python3 "$WORK/mutate.py" "$CLUSTER_COMPOSE" "$mutated" "$@")"; then
    fail "${name}：无法制造缺陷（锚点失效？拓扑被改过？）"
    return
  fi
  run_mutation_hits "$name" "$hits"
  expect_fail "$name" compose "$mutated" cluster "$want"
}

run_mutation_hits() { printf 'cluster-registry-verify: ..: %s 命中 %s 处\n' "$1" "$2"; }

# 版本闸门开关在真实拓扑里的默认写法（几处用例共用，改了就一起改）。
GATE_OFF='LUMO_CLUSTER_VERSION_GATE=${LUMO_CLUSTER_VERSION_GATE:-false}'
DECLARE_A='LUMO_CLUSTER_VERSION=${LUMO_CLUSTER_A_VERSION:-dev}'
DECLARE_B='LUMO_CLUSTER_VERSION=${LUMO_CLUSTER_B_VERSION:-dev}'

# --- 正向：四个真实拓扑都必须通过 ---------------------------------------------
expect_pass "compose.cluster.yml（判定开 + 两个集群各有承载节点上报）" compose "$CLUSTER_COMPOSE" cluster
expect_pass "compose.standalone.yml（未开判定，无需上报方）" compose "$STANDALONE_COMPOSE" standalone

if helm template lumo "$CHART" >"$WORK/helm-base.yaml" 2>"$WORK/helm-base.err" \
  && helm template lumo "$CHART" -f "$CHART/values.cluster.yaml" >"$WORK/helm-cluster.yaml" 2>"$WORK/helm-cluster.err"; then
  ok "helm template 基础 profile 与 cluster profile 均可渲染"
  expect_pass "Helm 基础 profile（判定关闭）" helm "$WORK/helm-base.yaml" base
  expect_pass "Helm cluster profile（判定开 + dsh-node 上报）" helm "$WORK/helm-cluster.yaml" cluster
else
  fail "helm template 渲染失败"
  cat "$WORK/helm-base.err" "$WORK/helm-cluster.err" >&2
fi

# Helm 侧的版本闸门：**不靠文本变异，靠 --set 渲染两份真实清单**。变异只能证明
# 检查器读得懂一份被手改过的文件，而 --set 走的是 values → 模板 → 渲染的完整链路，
# 能顺带证明那三个键真的接在模板上（写错键名时 --set 会静默忽略，渲染出来仍是 false，
# 于是「闸门开着」这条用例会因为「闸门根本没开」而假绿——所以下面那条**通过**用例
# 不是装饰，它是「闸门真的打开了」的证据）。
if helm template lumo "$CHART" -f "$CHART/values.cluster.yaml" \
     --set services.scheduler.clusterVersionGate=true \
     >"$WORK/helm-gate-on.yaml" 2>"$WORK/helm-gate-on.err"; then
  expect_fail "Helm：闸门开但没人声明版本" helm "$WORK/helm-gate-on.yaml" cluster \
    "version-gate-without-declarer"
else
  fail "helm template --set clusterVersionGate 渲染失败"
  cat "$WORK/helm-gate-on.err" >&2
fi

if helm template lumo "$CHART" -f "$CHART/values.cluster.yaml" \
     --set services.scheduler.clusterVersionGate=true \
     --set dshNode.clusterVersion=0.1.0 \
     >"$WORK/helm-gate-declared.yaml" 2>"$WORK/helm-gate-declared.err"; then
  expect_pass "Helm：闸门开 + 节点池声明了版本（一致，放行）" helm "$WORK/helm-gate-declared.yaml" cluster
  # 同一份清单里必须真的出现 LUMO_CLUSTER_VERSION —— 上面那条 expect_pass 在
  # 「闸门没打开」时也会通过，所以这里再断言一次声明真的渲染出来了。
  if grep -q "name: LUMO_CLUSTER_VERSION$" "$WORK/helm-gate-declared.yaml"; then
    ok "Helm：dshNode.clusterVersion 真的渲染成了 LUMO_CLUSTER_VERSION"
  else
    fail "Helm：dshNode.clusterVersion 没有渲染出 LUMO_CLUSTER_VERSION（键名接错了？）"
  fi
else
  fail "helm template --set dshNode.clusterVersion 渲染失败"
  cat "$WORK/helm-gate-declared.err" >&2
fi

# --- 反向：每个缺陷都必须被抓住，且报出预期的那一条 -----------------------------
# 注：2026-09-17 加入每集群的本地调度实例之后，「谁是上报方」从一个来源变成了两个
# （承载节点 / 认领了集群身份的调度实例）。于是下面 1、2 两条**原本的单编辑反例不再是
# 缺陷**——移除承载节点的上报地址之后，该集群仍有它自己的调度实例在上报。反例要跟着
# 不变式一起长：现在必须把该集群的**全部**上报方都拿掉才构成缺陷。
#
# 第 4 条因此被删掉了：把每个节点的 LUMO_ROLE 改掉之后，拓扑里一个承载节点都不剩，
# 命中的是**计数守卫**（与本组第 6 条同一条），不再产生「某集群没有上报方」这条。
# 留一个与别条同义的反例会虚增覆盖数——那正是本仓库反复讲的「看起来在工作的门禁」。

# 1. 某个集群的承载节点报不了，且它没有本地调度实例顶上来（cluster-b 两个来源都断了）。
run_mutation_many "集群承载节点缺上报地址" "cluster-without-reporter: 集群 cluster-b" \
  $'      # 同上：cluster-b 的存活由它自己的承载节点自报，不能靠 scheduler 实例认领。\n      - LUMO_SCHEDULER_URL=http://scheduler-0:8083' \
  $'      # 同上：cluster-b 的存活由它自己的承载节点自报，不能靠 scheduler 实例认领。' \
  "LUMO_SCHEDULER_CLUSTER_ID=cluster-b" "LUMO_SCHEDULER_CLUSTER_ID="

# 2. 判定开着而整个拓扑没有上报方（承载节点的地址与两个本地实例的身份全部清空）。
run_mutation_many "判定开着却没有任何上报方" "enforce-without-reporter" \
  "LUMO_SCHEDULER_URL=http://scheduler-0:8083" "LUMO_SCHEDULER_URL=" \
  "LUMO_SCHEDULER_CLUSTER_ID=cluster-a" "LUMO_SCHEDULER_CLUSTER_ID=" \
  "LUMO_SCHEDULER_CLUSTER_ID=cluster-b" "LUMO_SCHEDULER_CLUSTER_ID="

# 2b. 降级路径不可达：只把两个本地调度实例的身份拿掉。承载节点的上报方仍然齐全，
#     所以「有没有上报方」这条**不该**响——响的必须是「降级走不到」这一条。
#     两者分开成用例，是因为它们的处置完全不同：前者去配上报方，后者去加调度实例。
run_mutation_many "集群里没有本地调度实例（降级走不到）" "degradation-unreachable" \
  "LUMO_SCHEDULER_CLUSTER_ID=cluster-a" "LUMO_SCHEDULER_CLUSTER_ID=" \
  "LUMO_SCHEDULER_CLUSTER_ID=cluster-b" "LUMO_SCHEDULER_CLUSTER_ID="

# 3. 判定开关打错字（会被当成 false 而悄悄关掉判定）。
run_mutation "判定开关打错字" \
  "LUMO_CLUSTER_ENFORCE=true" \
  "LUMO_CLUSTER_ENFORCE=Ture" \
  "invalid-enforce-value"

# 4. 部署形态写成非规范取值（dsh-node 的上报方是精确比较，会静默关闭）。
run_mutation "部署形态取值不规范" \
  "- LUMO_CLUSTER_ID=cluster-b" \
  $'      - LUMO_CLUSTER_ID=cluster-b\n      - LUMO_DEPLOYMENT_MODE=Cluster' \
  "deployment-mode-values"

# 5. 拓扑里一个承载节点都没有（计数守卫必须自己先炸，而不是「什么都没发现所以通过」）。
run_mutation "拓扑里删空了承载节点" \
  "- LUMO_ROLE=node" \
  "- LUMO_ROLE=" \
  "topology-not-parsed"

# 5b. 服务名后面带**行内注释**时，它的 environment 不能被漏掉 -------------------------
# 2026-09-20 修：`SERVICE_KEY_RE` 首版写成 `:\s*$`，于是 `  cluster-b-dsh-0:   # 承载节点`
# 不被认成服务键——而 `parse_compose` 的 `current` 游标会把它整段 environment **并进前一个
# 服务**，不是丢掉。方向是 fail-open，且后果正好落在本检查器存在的理由上：被污染的宿主
# 节点继承了 `LUMO_ROLE=node` 与**前一个服务的令牌**，于是替 cluster-b 假冒了一个上报方
# ——「判定看起来生效了，实际上一分钱的作用都没有」这个本文件开头写的形状，正好又出现
# 了一次。与 `compose-ports-check.py` / `compose-images-check.py` / `edge-cors-check.py`
# 是同一个盲区，本条是它在集群侧的最后一处。
#
# 用夹具而不是变异：真实 `compose.cluster.yml` 里 **0 处**行内注释（8 处全在
# standalone），所以这个形状在 cluster 拓扑上造不出来，只能手写。下面「无注释」那条是
# **对照**——它证明夹具本身的缺陷成立，否则「加注释仍报错」可能只是碰巧报了别的规则。
cat >"$WORK/inline-comment-base.yml" <<'YAML'
name: lumo-inline-comment-fixture
services:
  scheduler-0:
    environment:
      LUMO_DEPLOYMENT_MODE: cluster
      LUMO_CLUSTER_ENFORCE: "true"
      LUMO_CONTROL_PLANE_TOKEN: "${LUMO_CONTROL_PLANE_TOKEN:?must be set}"
      LUMO_SCHEDULER_CLUSTER_ID: cluster-a
  cluster-a-dsh-0:
    environment:
      LUMO_ROLE: node
      LUMO_CLUSTER_ID: cluster-a
      LUMO_DEPLOYMENT_MODE: cluster
      LUMO_SCHEDULER_URL: http://scheduler-0:8083
      LUMO_CONTROL_PLANE_TOKEN: "${LUMO_CONTROL_PLANE_TOKEN:?must be set}"
  cluster-b-dsh-0:
    environment:
      LUMO_ROLE: node
      LUMO_CLUSTER_ID: cluster-b
      LUMO_DEPLOYMENT_MODE: cluster
      LUMO_SCHEDULER_URL: http://scheduler-0:8083
YAML
# 只加一个行内注释，别的逐字不动。
python3 - "$WORK/inline-comment-base.yml" "$WORK/inline-comment.yml" <<'PY'
import sys
src, dst = sys.argv[1], sys.argv[2]
text = open(src, encoding="utf-8").read()
anchor = "  cluster-b-dsh-0:\n"
assert text.count(anchor) == 1, f"锚点命中 {text.count(anchor)} 次（要求 1 次）"
open(dst, "w", encoding="utf-8").write(text.replace(anchor, "  cluster-b-dsh-0:   # 承载节点\n"))
PY

expect_fail "行内注释对照：无注释时 cluster-b 缺上报方被抓到" compose \
  "$WORK/inline-comment-base.yml" cluster "cluster-without-reporter: 集群 cluster-b"

if out="$(python3 "$CHECK" --kind compose --file "$WORK/inline-comment.yml" --expect-mode cluster 2>&1)"; then
  fail "行内注释：同一个缺陷没被抓到（fail-open 盲区复现）"
  printf '%s\n' "$out" >&2
else
  case "$out" in
    *"cluster-without-reporter: 集群 cluster-b"*)
      # 再钉一次「这个服务真的被解析出来了」：修复前这一行是「解析出 2 个服务」。
      # 只断言文案会漏掉一种退化——报对了规则，但服务数仍然少一个。
      case "$out" in
        *"解析出 3 个服务"*) ok "行内注释：服务名带注释时该缺陷仍被抓到（fail-open 盲区）" ;;
        *) fail "行内注释：报对了文案，但服务数不对（仍有服务没被解析出来）"; printf '%s\n' "$out" >&2 ;;
      esac
      ;;
    *)
      fail "行内注释：报错了，但报的不是预期的那条"
      printf '%s\n' "$out" >&2
      ;;
  esac
fi

# 7. 版本闸门开着、两个集群都声明了同一个版本 —— 这是一份**合法**的派生拓扑，必须通过。
#    它同时给下面两条反向用例当对照：证明它们抓的不是「闸门开着」这件事本身。
if python3 "$WORK/mutate.py" "$CLUSTER_COMPOSE" "$WORK/gate-on.yml" "$GATE_OFF" "LUMO_CLUSTER_VERSION_GATE=true" >/dev/null; then
  expect_pass "版本闸门开 + 两集群同版本（一致，放行）" compose "$WORK/gate-on.yml" cluster
else
  fail "版本闸门开 + 两集群同版本：无法制造（锚点失效？）"
fi

# 8. 版本闸门开着，而整个拓扑没有任何服务声明版本。
#    这是版本闸门的静默失效：判定集合里一个声明都没有 → 视为「无信息一致」→ 恒放行。
run_mutation_many "版本闸门开着却无人声明版本" "version-gate-without-declarer" \
  "$GATE_OFF" "LUMO_CLUSTER_VERSION_GATE=true" \
  "$DECLARE_A" "LUMO_CLUSTER_A_VERSION_UNUSED=dev" \
  "$DECLARE_B" "LUMO_CLUSTER_B_VERSION_UNUSED=dev"

# 9. 版本闸门开着，而拓扑里写死了两个不同版本（滚动升级升到一半就提交）。
run_mutation_many "版本闸门开着而版本分叉" "version-gate-split-fleet" \
  "$GATE_OFF" "LUMO_CLUSTER_VERSION_GATE=true" \
  "$DECLARE_B" "LUMO_CLUSTER_VERSION=v2"

# 10. 版本闸门开关打错字（会被当成关闭，而「关着」与「版本本来就一致」长得一样）。
run_mutation "版本闸门开关打错字" \
  "$GATE_OFF" \
  "LUMO_CLUSTER_VERSION_GATE=Ture" \
  "invalid-version-gate-value"

printf 'cluster-registry-verify: %d 项通过 / %d 项失败\n' "$passed" "$failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
echo "cluster-registry-verify: all checks passed."

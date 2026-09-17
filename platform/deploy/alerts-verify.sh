#!/usr/bin/env bash
#
# 告警引用完整性门禁（§7.4.2 全局监控面）。
#
# 分两段跑：
#
#   ① 真实文件必须通过。
#   ② 在临时副本上制造一批**已知缺陷**，每一种都必须以**特定文案**失败。
#
# 为什么第二段不能省：只检查「好输入能过」的门禁，在它所保护的那个检查被删掉之后
# 仍然是绿的——它证明不了自己还在工作。历史上有两条告警规则就是这样烂了很久：
#
#   · LumoServiceDown          expr 是 lumo_service_up == 0，而 lumo_service_up 是
#                              /metrics 里写死的字面量 1，永远不可能为 0。
#   · lumo:http_error_ratio5m  选择器是 lumo_http_requests_total{status=~"5.."}，而
#                              那个计数器不带任何标签，永远选不到序列。
#
# 两条都「看起来对」、语法都合法、Prometheus 都接受，只是永远不会响。静态检查能
# 抓住的正是这一类，所以每一种失败模式都要在这里当场演示一次。
#
# 断言到**具体文案**而不是退出码：退出码 1 可能来自任何一个检查，只断言「非零退出」
# 等于给「检查被换成了另一个检查」留后门。
#
# 用法：platform/deploy/alerts-verify.sh
# 依赖：go、python3（只做文本替换，不 import 任何第三方库）

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
CHECK_DIR="$ROOT/platform/control-plane/observability"
ALERTS="$ROOT/platform/deploy/prometheus-alerts.yml"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ ! -f "$ALERTS" ]; then
  echo "找不到告警文件：$ALERTS" >&2
  exit 1
fi

echo "── ① 真实文件 ──────────────────────────────────────────────"
(cd "$CHECK_DIR" && go run ./cmd/alerts-verify -root "$ROOT")

# ── ② 反例自证 ────────────────────────────────────────────────────────────────
#
# mutate.py 负责制造缺陷。它内建一条硬约束：**替换必须命中且只命中一次**，
# 否则以非零退出。锚点漂移（比如某条规则的文案被改了）会让反例静默地变成
# 「什么都没改」，那样门禁会一路绿下去——这正是反例本身要防的那类问题。

cat > "$WORK/mutate.py" <<'PY'
import sys

CASES = {}


def case(name, expect):
    def deco(fn):
        CASES[name] = (expect, fn)
        return fn
    return deco


def sub(text, old, new):
    """替换，且必须恰好命中一次。命中 0 次或多次都视为锚点失效。"""
    n = text.count(old)
    if n != 1:
        raise SystemExit(
            "锚点在源文件里出现 %d 次（期望 1 次）：%r\n"
            "锚点漂移会让这个反例变成空转，请同步更新 alerts-verify.sh" % (n, old[:80])
        )
    return text.replace(old, new)


@case("unknown-metric", "引用了指标 lumo_scheduler_pending_tasks_typo")
def _(t):
    # 拼错的指标名。PromQL 不会报错，这条规则只是永远不产生序列。
    return sub(t, "expr: lumo_scheduler_pending_tasks > 100",
               "expr: lumo_scheduler_pending_tasks_typo > 100")


@case("unknown-label", '指标 up 没有标签 "status"')
def _(t):
    # 不存在的标签选择器——lumo_http_requests_total{status=~"5.."} 那条死规则的样子。
    return sub(t, 'up{job="lumo-control-plane"} == 0',
               'up{job="lumo-control-plane",status="500"} == 0')


@case("misplaced-grouping", '分组/匹配标签 "cluster_id"')
def _(t):
    # 真实回归：这条规则一度写成 max by (cluster_id) (lumo_scheduler_pending_tasks)，
    # 而那个 gauge 是无标签的全局契约。按不存在的标签分组不报错，它只会把维度全
    # 聚合掉、并在注解里打印空集群名。
    return sub(t, "expr: lumo_scheduler_pending_tasks > 100",
               "expr: max by (cluster_id) (lumo_scheduler_pending_tasks) > 100")


@case("missing-class", 'labels 里缺 "class"')
def _(t):
    return sub(t, "          class: task_lost\n", "")


@case("missing-severity", 'labels 里缺 "severity"')
def _(t):
    # severity: info 出现多次，所以锚点带上整段 labels 块保证唯一。
    return sub(t,
               "        labels:\n          class: latency\n          tier: P3\n          severity: info\n",
               "        labels:\n          class: latency\n          tier: P3\n")


@case("tier-severity-mismatch", "tier=P2 应对应 severity=warning")
def _(t):
    # 路由按 severity、排班按 tier；两者不一致时半夜被叫醒的人和处理级别对不上。
    return sub(t,
               "          class: queue_backlog\n          tier: P2\n          severity: warning\n",
               "          class: queue_backlog\n          tier: P2\n          severity: info\n")


@case("unknown-rule-key", '规则级键 "class" 不是 Prometheus 认识的键')
def _(t):
    # 把 class 写在规则级而不是 labels 里。YAML 解析成功，Prometheus 拒绝整个文件。
    return sub(t,
               '        expr: up{job="lumo-control-plane"} == 0\n        for: 2m\n',
               '        expr: up{job="lumo-control-plane"} == 0\n        class: instance_down\n        for: 2m\n')


@case("spec-class-missing", "§7.4.2 点名的告警类里缺少 budget_overrun")
def _(t):
    return sub(t, "class: budget_overrun\n", "class: budget_overrun_x\n")


@case("vacuous-parse", "没解析出任何规则")
def _(t):
    # 文件格式一变（比如列表项从 `- alert:` 换成别的形态），解析器会扫出零条规则，
    # 所有检查随之变成空转。自检必须把这一态报出来。
    return "groups:\n  - name: lumo-platform\n    interval: 30s\n    rules:\n"


@case("gateway-list-drift", "在 service=~ 侧没有同一张名单")
def _(t):
    # 新增一个网关时只改了负向名单（!=~）那张：正向那张还留着旧名单。后果是这个网关
    # 两条 5xx 规则都不覆盖——静默盲区。锚点带上指标名以保证唯一（同一个名单在
    # errors_total 与 requests_total 里各出现一次）。
    return sub(t,
               'rate(lumo_http_errors_total{service!~"connector-gateway|llm-gateway|edge-gateway|terminal-gateway"}[5m])',
               'rate(lumo_http_errors_total{service!~"connector-gateway|llm-gateway"}[5m])')


@case("service-not-scraped", "不在任何抓取配置里")
def _(t):
    # 正负两张名单**同时**加上一个没人抓取的服务：互斥性仍然成立，坏的是「它对不上
    # 任何抓取目标」——规则语法合法、Prometheus 接受，只是那条序列永远不存在。
    # 四处都要改，否则会先撞上互斥性那条检查，反例就测不到本意要测的东西。
    for op in ("=~", "!~"):
        for metric in ("lumo_http_errors_total", "lumo_http_requests_total"):
            old = f'rate({metric}{{service{op}"connector-gateway|llm-gateway|edge-gateway|terminal-gateway"}}[5m])'
            new = f'rate({metric}{{service{op}"connector-gateway|llm-gateway|edge-gateway|terminal-gateway|ghost-gateway"}}[5m])'
            t = sub(t, old, new)
    return t


def main():
    name, src, dst = sys.argv[1], sys.argv[2], sys.argv[3]
    if name not in CASES:
        raise SystemExit("未知反例: %s" % name)
    with open(src, encoding="utf-8") as fh:
        text = fh.read()
    expect, fn = CASES[name]
    mutated = fn(text)
    if mutated == text:
        raise SystemExit("反例 %s 没有改动任何内容——它是空转的" % name)
    with open(dst, "w", encoding="utf-8") as fh:
        fh.write(mutated)
    sys.stdout.write(expect)


main()
PY

# 反例清单：与 mutate.py 里的 @case 一一对应。
CASES="unknown-metric unknown-label misplaced-grouping missing-class missing-severity tier-severity-mismatch unknown-rule-key spec-class-missing vacuous-parse gateway-list-drift service-not-scraped"

echo
echo "── ② 反例自证（每种缺陷都必须被抓住）───────────────────────"

failed=0
count=0

for name in $CASES; do
  count=$((count + 1))
  mutated="$WORK/$name.yml"
  out="$WORK/$name.out"

  if ! expect="$(python3 "$WORK/mutate.py" "$name" "$ALERTS" "$mutated")"; then
    echo "  ✗ $name: 无法制造缺陷（锚点失效？）"
    failed=$((failed + 1))
    continue
  fi

  if (cd "$CHECK_DIR" && go run ./cmd/alerts-verify -root "$ROOT" -alerts "$mutated") > "$out" 2>&1; then
    echo "  ✗ $name: 缺陷没有被抓住（门禁放行了）"
    failed=$((failed + 1))
    continue
  fi

  if ! grep -qF -- "$expect" "$out"; then
    echo "  ✗ $name: 报错了，但报的不是预期的那条"
    echo "      期望包含：$expect"
    echo "      实际输出：$(tr '\n' ' ' < "$out" | cut -c1-400)"
    failed=$((failed + 1))
    continue
  fi

  echo "  ✓ $name: $expect"
done

echo
if [ "$failed" -ne 0 ]; then
  echo "❌ 有 $failed/$count 个反例没有被正确抓住——门禁本身可能已经失效" >&2
  exit 1
fi

echo "✅ 告警门禁通过：真实文件无问题，$count 个反例全部被抓住"

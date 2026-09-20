#!/usr/bin/env bash
# compose 镜像引用的静态门禁：**同名服务跨形态必须同源**，且**不得出现浮动 tag**。
#
# ## 为什么需要它
#
# 这不是 compose 的配置错误：`docker compose config` 与 `up --dry-run` 都能过，失败发生在
# 容器真正去拉镜像的那一刻（`pull access denied for minio/minio`）。所以没有任何静态检查会
# 拦住它，只能靠人记住 —— 而 2026-09-16 与 2026-09-20 连踩了**同一个位置两次**：
#
#   09-16 两处都写 `minio/minio:latest` 拉不到 → 改成钉具体版本 `RELEASE.2025-04-22T22-12-26Z`；
#   09-20 同一个版本号也不可拉了 —— 因为**整个 `minio/minio` 仓库从 Docker Hub 下线了**。
#
# 两次的根因是同一件事：**镜像引用有两个自由度（registry 与 tag），只钉其中一个等于没钉。**
# 第二类错法是两份 compose 各写各的版本（`redis:7` vs `redis:7-alpine`），两个文件各自都能
# 起来，**只有放在一起看才是错的** —— 这正是本仓库反复出现的形态（见 compose-ports-verify.sh）。
#
# ## 断言到具体文案，而不是退出码
#
# 退出码 1 可能来自任何一个检查，只断言「非零退出」等于给「检查被换成了另一个检查」留后门
# （同 compose-ports-verify.sh / alerts-verify.sh / cluster-registry-verify.sh 的理由）。
#
# ## 为什么有一条「flow 写法」的反例
#
# `compose.cluster.yml` 里 vault 是行内 flow 写法 `vault: { image: "...", ... }`。行级 grep
# 与「按缩进取 `image:`」的朴素解析**都看不见它** —— 2026-09-20 实测，正是这个盲区让
# `hashicorp/vault:latest` 在两次排查里都被漏掉。反例 4 专门钉住它。
#
# 用法：platform/deploy/compose-images-verify.sh
# 依赖：python3（只做文本替换与行扫描，不 import 任何第三方库）

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK="$HERE/compose-images-check.py"
STANDALONE="$HERE/compose.standalone.yml"
CLUSTER="$HERE/compose.cluster.yml"
LOCAL="$HERE/compose.local.yml"
ACCEPTANCE="$HERE/compose.cluster.acceptance.yml"
DEVICES="$HERE/compose.cluster.devices.yml"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/lumo-compose-images.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

passed=0
failed=0
ok() { printf 'compose-images-verify: OK: %s\n' "$1"; passed=$((passed + 1)); }
fail() { printf 'compose-images-verify: FAIL: %s\n' "$1" >&2; failed=$((failed + 1)); }

if ! command -v python3 >/dev/null 2>&1; then
  echo "compose-images-verify: 缺少依赖 python3" >&2
  exit 1
fi
ok "command python3"

cat >"$WORK/mutate.py" <<'PY'
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
elif op == "rename-image-key":
    # 让解析器一个 `image:` 键都看不到，验证「什么都没采集到」会失败而不是安静通过。
    text = text.replace("image:", "imag3:")
else:
    print(f"未知操作: {op}", file=sys.stderr)
    sys.exit(1)

open(dst, "w", encoding="utf-8").write(text)
PY

# expect_pass <说明> <参数...>
expect_pass() {
  local name="$1"
  shift
  local out
  if ! out="$(python3 "$CHECK" "$@" 2>&1)"; then
    fail "${name}：本该通过，实际失败了"
    printf '%s\n' "$out" >&2
    return
  fi
  # 断言它真的采集到了镜像引用，而不是「一个引用都没看到就退 0」——这正是本门禁最容易
  # 退化成的那种失效（「没有分歧」与「没在找分歧」在退出码上完全一样）。
  case "$out" in
    *"通过（"*) ok "$name" ;;
    *) fail "${name}：退出码为 0，但没有报出任何采集结果"; printf '%s\n' "$out" >&2 ;;
  esac
}

# expect_fail <说明> <期望文案> <参数...>
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

# --- 正向：真实拓扑（三形态 + 两个 overlay）必须通过 -------------------------------
expect_pass "compose.standalone / compose.cluster / compose.local + 两个 overlay" \
  --shape "$STANDALONE" --shape "$CLUSTER" --shape "$LOCAL" \
  --overlay "$ACCEPTANCE" --overlay "$DEVICES"

# --- 反向 1：本仓库真实踩过的那条 —— minio 回到 Docker Hub 上已下线的仓库 -------------
# 这是本门禁存在的第一个理由。注意它**不是**浮动 tag：版本号一模一样，坏的只是 registry，
# 所以只有「跨形态同源」这一半抓得住它 —— 反例 1 与反例 2 各守一半，缺一不可。
mutate sub "$STANDALONE" "$WORK/minio-hub.yml" \
  'image: quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z' \
  'image: minio/minio:RELEASE.2025-04-22T22-12-26Z'
if grep -q 'image: minio/minio:' "$WORK/minio-hub.yml"; then
  expect_fail "回归：standalone 的 minio 回到已下线的 Docker Hub 仓库" \
    "shape-divergence: 服务 minio" \
    --shape "$WORK/minio-hub.yml" --shape "$CLUSTER" --shape "$LOCAL" \
    --overlay "$ACCEPTANCE" --overlay "$DEVICES"
else
  fail "回归用例：无法把 minio 改回 Docker Hub（锚点失效？registry 又被改过？）"
fi

# --- 反向 2：把已钉死的版本改成 `latest` ---------------------------------------------
mutate sub "$CLUSTER" "$WORK/opa-latest.yml" \
  'image: openpolicyagent/opa:1.3.0' 'image: openpolicyagent/opa:latest'
expect_fail "回归：opa 被改回 latest" \
  "服务 opa 用了 latest 标签" \
  --shape "$STANDALONE" --shape "$WORK/opa-latest.yml" --shape "$LOCAL" \
  --overlay "$ACCEPTANCE" --overlay "$DEVICES"

# --- 反向 3：镜像**没有 tag**（比 `latest` 更隐蔽：连「浮动」都看不出来）---------------
mutate sub "$CLUSTER" "$WORK/nacos-notag.yml" \
  'image: nacos/nacos-server:v2.4.0' 'image: nacos/nacos-server'
expect_fail "回归：nacos 去掉 tag" \
  "没有 tag" \
  --shape "$STANDALONE" --shape "$WORK/nacos-notag.yml" --shape "$LOCAL" \
  --overlay "$ACCEPTANCE" --overlay "$DEVICES"

# --- 反向 4：**flow 写法**里的浮动 tag（行级 grep 看不见的那一类）---------------------
# 保持 `vault: { image: ..., ... }` 的单行 flow 形态不变，只换 tag —— 朴素的
# 「按缩进取 image:」解析在这里一个字符都取不到。
mutate sub "$CLUSTER" "$WORK/vault-flow-latest.yml" \
  'image: "hashicorp/vault:2.1.1"' 'image: "hashicorp/vault:latest"'
if grep -q 'vault: { image: "hashicorp/vault:latest"' "$WORK/vault-flow-latest.yml"; then
  expect_fail "回归：flow 写法里的 vault:latest 必须被抓到（解析盲区）" \
    "服务 vault 用了 latest 标签" \
    --shape "$STANDALONE" --shape "$WORK/vault-flow-latest.yml" --shape "$LOCAL" \
    --overlay "$ACCEPTANCE" --overlay "$DEVICES"
else
  fail "flow 用例：锚点失效（vault 不再是行内 flow 写法？）"
fi

# --- 反向 5：一个 image 引用都解析不出来（解析器失效 / 拓扑被删空）--------------------
# **三个形态都要改**：只改一个的话另两个仍有镜像，计数守卫不会被触发 —— 首版就是这么写的，
# 于是这条反例静默失效（而它守的恰恰是「门禁退化成永远通过」那一种失效）。
mutate rename-image-key "$STANDALONE" "$WORK/no-images-standalone.yml"
mutate rename-image-key "$CLUSTER" "$WORK/no-images-cluster.yml"
mutate rename-image-key "$LOCAL" "$WORK/no-images-local.yml"
expect_fail "拓扑里不再有任何 image 键（解析失效的形态）" \
  "topology-not-parsed" \
  --shape "$WORK/no-images-standalone.yml" --shape "$WORK/no-images-cluster.yml" \
  --shape "$WORK/no-images-local.yml" \
  --overlay "$ACCEPTANCE" --overlay "$DEVICES"

# --- 反向 6：解析不了的 image 值必须报错，不能跳过 -----------------------------------
# 跳过它的后果很具体：解析盲区与「真的同源」在输出上完全一样。
mutate sub "$STANDALONE" "$WORK/bad-value.yml" \
  'image: redis:7-alpine' 'image: [a, b]'
expect_fail "非标量的 image 值（解析不了就必须喊，不能跳过）" \
  "image-entry-unparsed" \
  --shape "$WORK/bad-value.yml" --shape "$CLUSTER" --shape "$LOCAL" \
  --overlay "$ACCEPTANCE" --overlay "$DEVICES"

# --- 反向 7：overlay 里定义了镜像 ----------------------------------------------------
# overlay 按约定只加 ports，本门禁**不合并** overlay。所以一旦 overlay 定义镜像，
# 「同名服务跨形态同源」的比对范围就少了一维，而这一点没有任何别的检查会说。
mutate sub "$ACCEPTANCE" "$WORK/overlay-image.yml" \
  '  minio:' '  minio:
    image: someone/minio:1.0'
if grep -q 'image: someone/minio:1.0' "$WORK/overlay-image.yml"; then
  expect_fail "overlay 里出现 image（本门禁不合并它，会成盲区）" \
    "overlay-defines-image" \
    --shape "$STANDALONE" --shape "$CLUSTER" --shape "$LOCAL" \
    --overlay "$WORK/overlay-image.yml" --overlay "$DEVICES"
else
  fail "overlay 用例：锚点失效（acceptance 里没有独立的 minio 服务？）"
fi

# --- 边界 1：注释掉的 image 不是引用 -------------------------------------------------
# `compose.standalone.yml` 里就留着一行注释掉的 `#   image: milvusdb/milvus:latest`。
# 把它当真会得到一个**永远修不掉**的假阳性，所以这条边界必须有守卫。
mutate sub "$STANDALONE" "$WORK/commented.yml" \
  '    image: quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z' \
  '    #   image: someone/repo:latest
    image: quay.io/minio/minio:RELEASE.2025-04-22T22-12-26Z'
if grep -q '#   image: someone/repo:latest' "$WORK/commented.yml"; then
  expect_pass "边界：注释掉的 image:latest 不算引用" \
    --shape "$WORK/commented.yml" --shape "$CLUSTER" --shape "$LOCAL" \
    --overlay "$ACCEPTANCE" --overlay "$DEVICES"
else
  fail "注释边界用例：锚点失效"
fi

# --- 边界 2：只在单个形态里存在的服务，改它不算「分歧」 -------------------------------
# 门禁只比**同名**服务：`dsh-node`（standalone）与 `dsh-web` / `cluster-a-dsh-0`（cluster）
# 是形态差异，不是分歧。少了这条边界，门禁会逼着人把形态差异也强行统一 —— 那比漏报更坏。
mutate sub "$STANDALONE" "$WORK/solo-service.yml" \
  'image: "${LUMO_DSH_IMAGE:-lumo/dsh-node:dev}"' 'image: other/dsh-node:9.9'
if grep -q 'image: other/dsh-node:9.9' "$WORK/solo-service.yml"; then
  expect_pass "边界：只在 standalone 存在的服务改版本不算分歧（过紧会逼人统一形态差异）" \
    --shape "$WORK/solo-service.yml" --shape "$CLUSTER" --shape "$LOCAL" \
    --overlay "$ACCEPTANCE" --overlay "$DEVICES"
else
  fail "单形态服务用例：锚点失效"
fi

# --- 边界 3：不带默认值的 ${VAR} 无法静态判定，提示而不报错 ---------------------------
# 不能因为静态判不了就报错，否则门禁会逼着人把动态镜像写成硬编码。
mutate sub "$STANDALONE" "$WORK/dynamic.yml" \
  'image: redis:7-alpine' 'image: "${LUMO_REDIS_IMAGE}"'
if out="$(python3 "$CHECK" --shape "$WORK/dynamic.yml" --shape "$CLUSTER" --shape "$LOCAL" \
    --overlay "$ACCEPTANCE" --overlay "$DEVICES" 2>&1)"; then
  case "$out" in
    *"不可静态判定"*) ok "动态镜像：提示而不报错（边界）" ;;
    *) fail "动态镜像：通过了但没有提示，等于静默忽略"; printf '%s\n' "$out" >&2 ;;
  esac
else
  fail "动态镜像被当成错误了（门禁过紧）"
  printf '%s\n' "$out" >&2
fi

printf 'compose-images-verify: %d 项通过 / %d 项失败\n' "$passed" "$failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
echo "compose-images-verify: all checks passed."

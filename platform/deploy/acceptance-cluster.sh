#!/usr/bin/env bash
# Run the real Cluster acceptance gate against operator-owned dependencies.
# This script deliberately refuses to use localhost/dev defaults: a green
# in-memory test is not evidence of multi-node resume or failover safety.
#
# 每一步都断言「真的执行了活体用例」。`it.skip` / `describe.skipIf` / `t.Skip` 会让
# 退出码保持 0，所以「脚本绿了」本身不足以证明这一步产生了证据：2026-09-15 实测
# `session-log/__tests__/pg-log.spec.ts` 在 DSN 名字对不上时 19 个用例全跳过、退出码 0。
# 计数为 0 即失败，并打出跳过数，让「部分覆盖」至少是可见的。
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
root_dir="$(cd -- "$script_dir/../.." && pwd)"
timeout_seconds="${LUMO_ACCEPTANCE_TIMEOUT_SECONDS:-5}"
report_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumo-acceptance.XXXXXX")"
trap 'rm -rf "$report_dir"' EXIT

fail() { echo "cluster-acceptance: FAIL: $*" >&2; exit 1; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "需要命令 $1"; }
require_value() { [[ -n "${!1:-}" ]] || fail "$1 必须指向目标环境，不接受空值或开发默认"; }

require_command curl
require_command go
require_command node
# vitest 优先用工作区自带的二进制——`pnpm exec vitest` 解析到的就是同一个文件，但这样
# 绕开了 pnpm 自身：`pnpm exec` 在 pnpm store 不可写等受限环境里会在启动 vitest 之前就
# 失败，而验收链不该因为包管理器跑不起来。
if [[ -x "$root_dir/platform/node_modules/.bin/vitest" ]]; then
  vitest_cmd=("$root_dir/platform/node_modules/.bin/vitest")
else
  require_command pnpm
  vitest_cmd=(pnpm exec vitest)
fi
require_value LUMO_TEST_PG_DSN
require_value LUMO_TEST_RMQ_ENDPOINT
require_value LUMO_TEST_NACOS_HEALTH_URL
require_value LUMO_TEST_MILVUS_HEALTH_URL
require_value LUMO_TEST_OPA_HEALTH_URL
require_value LUMO_TEST_VAULT_HEALTH_URL

# dsh-plugins 的活库 spec 读 `<SUBSYSTEM>_TEST_DSN`，而本脚本与全部 Go 侧只认
# `LUMO_TEST_PG_DSN`。两者的桥接在 platform/vitest.setup.ts（所以 `pnpm test` 直接跑
# 也不会踩同一个坑），这里不重复导出——重复的两套机制迟早会漂移。若那条桥接被删掉，
# 下面的活体用例计数守卫会立刻变红，而不是让这一步静默变成「零证据通过」。

check_http() {
  local name="$1" url="$2"
  curl --fail --silent --show-error --max-time "$timeout_seconds" "$url" >/dev/null \
    || fail "$name 健康检查失败: $url"
  echo "cluster-acceptance: $name healthy"
}

check_http "Nacos" "$LUMO_TEST_NACOS_HEALTH_URL"
check_http "Milvus" "$LUMO_TEST_MILVUS_HEALTH_URL"
check_http "OPA" "$LUMO_TEST_OPA_HEALTH_URL"
check_http "Vault" "$LUMO_TEST_VAULT_HEALTH_URL"

# Nebula 是**可选的外部**图适配器，不是本仓库部署的一部分：任何 compose/Helm 里都没有
# nebula 服务，`cluster-runtime.env` 与 Helm `values.yaml` 都把它默认为空，knowledge
# 插件在空值时回落到 PG 递归 CTE（dsh-plugins/knowledge/src/index.ts:69）。把它列为
# 必需会让整条验收链在没有外部 Nebula 的环境里永远跑不起来——脚本自己先说不可能通过，
# 后面的证据就没人看了。设了就探测，没设就跳过并说明。
if [[ -n "${LUMO_TEST_NEBULA_HEALTH_URL:-}" ]]; then
  check_http "Nebula adapter" "$LUMO_TEST_NEBULA_HEALTH_URL"
else
  echo "cluster-acceptance: INFO: 未设置 LUMO_TEST_NEBULA_HEALTH_URL，跳过可选图适配器探测（图侧回落 PG 递归 CTE）"
fi

# usage-ledger 的 RocketMQ e2e 在 TestMain 里用 `docker exec <broker> mqadmin` 清空重建
# 闭集 topic；测试自身的默认值是 standalone 的容器名，而这里是 **cluster** 验收。名字
# 对不上时重置会退化成一条警告，topic 历史随后跨运行单调累积，新消费组重放预算线性膨胀，
# 套件最终超时——失败形态与被测代码无关。所以按 cluster compose 反查真实容器名传下去。
if [[ -z "${LUMO_TEST_RMQ_CONTAINER:-}" ]] && command -v docker >/dev/null 2>&1; then
  env_file="${LUMO_ENV_FILE:-$script_dir/.env}"
  rmq_compose=(docker compose -f "$script_dir/compose.cluster.yml")
  if [[ -r "$env_file" ]]; then
    rmq_compose=(docker compose --env-file "$env_file" -f "$script_dir/compose.cluster.yml")
  fi
  rmq_container_id="$("${rmq_compose[@]}" ps -q rocketmq 2>/dev/null | sed -n '1p' || true)"
  if [[ -n "$rmq_container_id" ]]; then
    LUMO_TEST_RMQ_CONTAINER="$(docker inspect --format '{{.Name}}' "$rmq_container_id" | sed 's|^/||')"
    export LUMO_TEST_RMQ_CONTAINER
    echo "cluster-acceptance: RocketMQ topic 重置目标 $LUMO_TEST_RMQ_CONTAINER"
  else
    echo "cluster-acceptance: INFO: 未找到 cluster 的 rocketmq 容器；topic 重置将按测试自身规则降级" >&2
  fi
fi

if [[ "${LUMO_ACCEPTANCE_SKIP_SMOKE:-0}" != "1" ]]; then
  LUMO_ENV_FILE="${LUMO_ENV_FILE:-$root_dir/platform/deploy/.env}" \
    "$script_dir/smoke-cluster.sh"
fi

# 行为探针。与上面那步**分工不同**，而这个分工是刻意保留的：
# `smoke-cluster.sh` 答「进程活没活」（`/healthz` 2xx），本步答「活着的进程做的是不是它该做的事」。
# 一个部署可以前者全绿、后者全错——C5 的 OPA 绑定地址缺陷就是实证：服务全部健康，
# 策略评估对兄弟容器一律连不上，而当时没有任何一条探针会去看这件事。
#
# **这一步此前为什么不在链里**（2026-09-17 复核发现）：`probes-cluster.sh` 写好了、
# `probes-cluster-verify.sh` 的 19 项门禁也接了 CI，但本文件**通篇没有出现过 "probe"**
# （已用 `grep -n probe` 确认零命中）。于是这条链打印 `passed` 时，`edge-gateway` 与
# `terminal-gateway` 的行为一次都没被碰过——而 C1/C3/C4/C5/C7 的验收证据正写在那些探针里。
# 这与 D5 修掉的「验收脚本静默跳过而退出码为 0」同族：**证据存在，但不在被执行的那条路上。**
#
# **顺序在 smoke 之后**：先答「服务在不在」，再答「在的那个对不对」。反过来的话，
# 服务没起来时探针会刷一屏 `probe-service-absent`，把真正的第一因埋进噪声里。
#
# **开关刻意与 `SKIP_SMOKE` 分开**：两者的失效含义不同（跳过存活检查 vs 跳过行为断言）。
# 共用一个会让「我跳过了探针」看起来像「我跳过了存活检查」，而后者在读日志的人眼里是无害的。
# 探针自身失败时以非 0 退出，在 `set -e` 下终止本脚本——这正是它该有的效果。
if [[ "${LUMO_ACCEPTANCE_SKIP_PROBES:-0}" != "1" ]]; then
  LUMO_ENV_FILE="${LUMO_ENV_FILE:-$root_dir/platform/deploy/.env}" \
    "$script_dir/probes-cluster.sh"
fi

# 读 vitest 的 JSON 报告，输出「实际执行（非跳过）」的用例数。
count_executed_tests() {
  node -e '
    const fs = require("node:fs")
    const r = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    const skipped = (r.numPendingTests || 0) + (r.numTodoTests || 0)
    process.stdout.write(String((r.numTotalTests || 0) - skipped))
  ' "$1"
}

run_vitest() {
  local step="$1"; shift
  local report="$report_dir/vitest-$step.json"
  echo "cluster-acceptance: vitest $step"
  (cd "$root_dir/platform" && "${vitest_cmd[@]}" run "$@" \
    --reporter=default --reporter=json --outputFile.json="$report")
  local executed
  executed="$(count_executed_tests "$report")"
  if (( executed < 1 )); then
    fail "$step 执行了 0 个活体用例（全部跳过）——这一步没有产生证据，不能算通过"
  fi
  echo "cluster-acceptance: $step 执行 $executed 个活体用例"
}

run_go_integration() {
  local module="$1" package="$2"
  # 报告名带上包路径：同一个 module 可能被检查两个包（如 connector-gateway 的
  # server 与 audit），否则后一次会覆盖前一次的证据文件。
  local report="$report_dir/go-${module}${package//\//_}.txt"
  echo "cluster-acceptance: go test $module $package"
  if ! (cd "$root_dir/platform/control-plane/$module" && go test -v "$package" -count=1) \
    >"$report" 2>&1; then
    cat "$report" >&2
    fail "go test $module $package 失败"
  fi
  local passed skipped
  passed="$(grep -c '^--- PASS' "$report" || true)"
  skipped="$(grep -c '^--- SKIP' "$report" || true)"
  if (( passed < 1 )); then
    cat "$report" >&2
    fail "go test $module $package 执行了 0 个通过用例（全部 SKIP）——这一步没有产生证据"
  fi
  echo "cluster-acceptance: $module$package 通过 $passed 跳过 $skipped"
}

# Scheduler lease expiry is the real fencing/takeover check; the session-log
# suite exercises two writer identities against the same PG log for resume.
# collaborator 与 connector-gateway/internal/audit 是 2026-09-15 补入的：前者是控制面
# 服务但此前完全不在验收链里，后者是本轮新增的审计读取面（E7）。
run_go_integration scheduler ./internal/integration
run_go_integration governance ./internal/store
run_go_integration collaborator ./internal/integration
run_go_integration flows ./internal/integration
run_go_integration projects ./internal/integration
run_go_integration registry ./internal/integration
run_go_integration connector-gateway ./internal/server
run_go_integration connector-gateway ./internal/audit
run_go_integration llm-gateway ./internal/server
run_go_integration usage-ledger ./internal/integration

run_vitest session-log-resume dsh-plugins/session-log/__tests__/pg-log.spec.ts
run_vitest governed-dispatch-receipts \
  dsh-plugins/subagent-host/__tests__/governed-dispatch.pg.spec.ts \
  dsh-plugins/subagent-remote/__tests__/receipts.pg.spec.ts

echo "cluster-acceptance: passed (real dependencies and isolated PG schema)"

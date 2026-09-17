#!/usr/bin/env bash
# 本机活库套件：用 Docker 起本地依赖，把「因缺服务而整组跳过」的活体用例全部解封跑一遍。
#
# 与 acceptance-cluster.sh 的分工（两者互补，不要合并）：
#   - `acceptance-cluster.sh` 是**集群拓扑**验收，要求运算符自有的 Nacos / Milvus / OPA /
#     Vault / RocketMQ，回答的是「多节点恢复与故障转移安不安全」；
#   - 本脚本只要求**本机 Docker**，回答的是「此前被静默跳过的那批用例到底过不过」。
# 2026-09-15 的教训正是后者的价值：CI 给控制面无条件注入 DSN 后，那些**从未在真库上执行过**
# 的用例一次性暴露出 9 处真实缺陷（错误链被 `%s` 截断、PG 的 `ON CONFLICT` 也做 NOT NULL
# 校验使「省略即保持原值」从未生效、三实现判态对负 overdraft 分叉……）。所以这一步不是
# 「再跑一遍测试」，而是让已经写下的活体断言第一次真的执行。
#
# **退出码不是证据**：`it.skip` / `t.Skip` 让退出码保持 0。本脚本对每一步都断言
# 「至少执行了 1 个**非跳过**用例」，并把跳过数与跳过原因打出来。只有活体用例真的跑了，
# 「绿」才等于证据。
#
# 环境隔离靠**一模块一库**：所有 Go 模块与 TS 套件各自 DROP/CREATE 一个独立库 —— 上一个
# 模块留在库里的行会把下一个模块的断言弄红（2026-09-15 实测：调度器的 leader 租约是全局
# 单行，别的模块当过 leader 就让 `TestDDLIdempotent` 的「初始租约为空」失败）。
#
# 用法：
#   ./test-local-pg.sh                   # 起 postgres+redis，跑 PG/Redis 活库用例
#   ./test-local-pg.sh scheduler flows   # 只跑这些 Go 模块（TS 步骤照跑）
#   LUMO_LOCAL_SERVICES=postgres,redis,minio ./test-local-pg.sh
#                                        # 额外起 MinIO，解封对象存储/冷层用例（见下）
#   LUMO_LOCAL_MINIO_IMAGE=minio/minio:RELEASE.<其他版本> ./test-local-pg.sh
#                                        # 试别的 MinIO 版本时临时覆盖 image
#   LUMO_LOCAL_SERVICES=postgres ...     # 只起 PG：Redis 相关 spec 会被**排除并列出**
#   LUMO_LOCAL_KEEP_DB=1 ...             # 保留测试库与报告目录，便于事后查看
#   LUMO_LOCAL_DOWN=1 ...                # 跑完把 compose 服务停掉
#
# MinIO 的版本必须钉死，且两个 compose 文件里的版本要一致。原先两处都写
# `minio/minio:latest`，而 Docker Hub 已不为该仓库提供 `latest` 标签（实测
# 2026-09-16：`pull access denied for minio/minio`）—— compose 解析镜像名时不发探测
# 请求，所以这个错误只在 `up` 时才暴露，表现得像「对象存储起不来」而不是「镜像写错了」。
# 2026-09-16 起 compose 已钉 `RELEASE.2025-04-22T22-12-26Z`，因此
# `LUMO_LOCAL_SERVICES=…,minio` 直接可用；`LUMO_LOCAL_MINIO_IMAGE` 现在只用于**试别的
# 版本**，它用一个覆盖文件临时替换 image，不改 compose。
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
platform_dir="$(cd -- "$script_dir/.." && pwd)"
compose_file="$script_dir/compose.standalone.yml"
compose_project="lumo-platform-standalone"

services_csv="${LUMO_LOCAL_SERVICES:-postgres,redis}"
[[ -n "$services_csv" ]] || { echo "local-pg: FAIL: LUMO_LOCAL_SERVICES 不能为空" >&2; exit 1; }
IFS=',' read -r -a services <<<"$services_csv"

report_dir="$(mktemp -d "${TMPDIR:-/tmp}/lumo-local-pg.XXXXXX")"
created_databases=()
pg_container=""
pg_user="lumo"
compose_args=(-f "$compose_file")

# MinIO 镜像覆盖：只改 image，其余（command/ports/env/healthcheck）沿用 compose 定义。
if [[ -n "${LUMO_LOCAL_MINIO_IMAGE:-}" ]]; then
  minio_override="$report_dir/minio-override.yml"
  printf 'services:\n  minio:\n    image: %s\n' "$LUMO_LOCAL_MINIO_IMAGE" >"$minio_override"
  compose_args+=(-f "$minio_override")
  has_minio_requested=0
  for service in "${services[@]}"; do [[ "$service" == "minio" ]] && has_minio_requested=1; done
  (( has_minio_requested )) || services+=(minio)
  services_csv="${services[*]}"
fi

cleanup() {
  # 收尾失败不能覆盖脚本本身的退出码，且它在 `set -e` 下运行，所以逐条容错 + 末尾必 return 0。
  # 顺序有讲究：`compose down` 要用 `compose_args`，其中可能含**写在 $report_dir 里的**
  # MinIO 覆盖文件 —— 先删目录再 down，`-f` 会指向不存在的文件，down 静默不生效。
  if [[ "${LUMO_LOCAL_DOWN:-0}" == "1" ]]; then
    docker compose "${compose_args[@]}" down >/dev/null 2>&1 || true
  fi
  if [[ "${LUMO_LOCAL_KEEP_DB:-0}" != "1" ]]; then
    for db in "${created_databases[@]:-}"; do
      [[ -n "$db" ]] || continue
      docker exec "$pg_container" psql -U "$pg_user" -d postgres -qc "DROP DATABASE IF EXISTS \"$db\"" \
        >/dev/null 2>&1 || true
    done
    rm -rf "$report_dir"
  else
    echo "local-pg: 保留测试库与报告目录 $report_dir" >&2
  fi
  return 0
}
trap cleanup EXIT

fail() { echo "local-pg: FAIL: $*" >&2; exit 1; }
info() { echo "local-pg: $*"; }
warn() { echo "local-pg: WARN: $*" >&2; return 0; }
require_command() { command -v "$1" >/dev/null 2>&1 || fail "需要命令 $1"; }

require_command docker
require_command go
require_command node
# `command -v docker` 有命令 ≠ 守护进程可用 —— 装了 Docker Desktop 但没启动正是最常见的形态。
docker info >/dev/null 2>&1 || fail "Docker 守护进程不可用：请先启动 Docker Desktop（macOS 上 \`open -a Docker\`）"

# ---- 起依赖 ----
# 直接用 compose 而不是 up.sh：本脚本只要数据引擎，不需要触发 dsh 源树 bootstrap，也不需要
# preflight（那两步属于「起一套完整拓扑」，与本脚本的目标无关）。
info "启动依赖容器：$services_csv"
docker compose "${compose_args[@]}" up -d postgres >/dev/null \
  || fail "postgres 起不来（必需依赖）"

# 必需之外的都当**可选**：缺了不该让整轮跑不起来，但也绝不静默 —— 依赖它的 spec 会在
# 下面被显式排除并列出文件名，绝不让「没跑」看起来像「通过」。
started_services=(postgres)
for service in "${services[@]}"; do
  [[ "$service" == "postgres" ]] && continue
  if docker compose "${compose_args[@]}" up -d "$service" >/dev/null 2>&1; then
    started_services+=("$service")
  else
    warn "$service 无法启动（可选依赖），依赖它的活体用例将被排除"
  fi
done

has_started() {
  local needle="$1" service
  for service in "${started_services[@]}"; do [[ "$service" == "$needle" ]] && return 0; done
  return 1
}

# 容器名按 compose 项目名 + 服务名推导，但**不硬编码**：项目名可被 .env 覆盖，所以问 compose。
container_of() {
  local service="$1" id
  id="$(docker compose "${compose_args[@]}" -p "$compose_project" ps -q "$service" 2>/dev/null | sed -n '1p')"
  [[ -n "$id" ]] || return 1
  docker inspect --format '{{.Name}}' "$id" | sed 's|^/||'
}

pg_container="$(container_of postgres || true)"
[[ -n "$pg_container" ]] || fail "找不到 postgres 容器"

# 用户名从**容器实际环境**读，而不是拿 compose 默认值猜：`.env` 或 shell 里的
# `LUMO_POSTGRES_USER` 会改掉它，猜错的表现是「DSN 连不上」而不是「变量没设」，更费时间。
pg_user="$(docker exec "$pg_container" printenv POSTGRES_USER 2>/dev/null || true)"
pg_user="${pg_user:-lumo}"

# compose 已带 healthcheck，但 `up -d` 是异步的；自己等一次，免得后续失败形态变成
# 「连接被拒」而不是「服务还没起来」。
wait_ready() {
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    docker exec "$pg_container" pg_isready -U "$pg_user" -q 2>/dev/null && return 0
    sleep 1
  done
  return 1
}
wait_ready || fail "等待 PostgreSQL 就绪超时（容器 ${pg_container}）"

# 宿主端口同样问 compose：compose.standalone.yml 里是 `15432:5432`，但端口可被覆盖，
# 写死会让脚本在换过端口的环境上连到别的东西上去。
host_port() {
  local service="$1" container_port="$2" mapping
  mapping="$(docker compose "${compose_args[@]}" -p "$compose_project" port "$service" "$container_port" 2>/dev/null | sed -n '1p')"
  [[ -n "$mapping" ]] || return 1
  echo "${mapping##*:}"
}

pg_port="$(host_port postgres 5432 || true)"
[[ -n "$pg_port" ]] || fail "无法解析 postgres 宿主端口"
pg_version="$(docker exec "$pg_container" psql -U "$pg_user" -d postgres -tAc 'SHOW server_version' 2>/dev/null | tr -d '[:space:]')"
info "PostgreSQL $pg_version 就绪于 127.0.0.1:${pg_port}（容器 ${pg_container}）"

ts_env=()
go_env=()
if has_started redis; then
  redis_port="$(host_port redis 6379 || true)"
  if [[ -n "$redis_port" ]]; then
    # 地址**只解析一次**再分发给两侧：同一个端口算两遍迟早会漂移，而「两个名字指向不同的
    # Redis」在输出上完全看不出来（两侧都会绿，只是绿的覆盖面不是同一份数据）。
    redis_dsn="redis://127.0.0.1:$redis_port"
    # TS 侧沿用既有门控名（session-log 的活库 spec 读它，且自带同值缺省）。
    ts_env+=("SESSION_LOG_TEST_REDIS=$redis_dsn")
    # Go 侧用统一名，与 `LUMO_TEST_PG_DSN` 同一口径。在此之前 Go 模块**只拿到 PG 的 DSN**，
    # 于是共享限流库的 Lua 令牌桶——两个南北向网关的准入依据——从未在真 Redis 上跑过一次，
    # 而它的失败模式（超发）恰恰只在真库里才成立。
    go_env+=("LUMO_TEST_REDIS_DSN=$redis_dsn")
  else
    warn "redis 容器在跑但解析不到宿主端口（热层用例将被排除）"
  fi
fi
if has_started minio; then
  minio_port="$(host_port minio 9000 || true)"
  minio_container="$(container_of minio || true)"
  minio_user=""
  minio_password=""
  if [[ -n "$minio_container" ]]; then
    minio_user="$(docker exec "$minio_container" printenv MINIO_ROOT_USER 2>/dev/null || true)"
    minio_password="$(docker exec "$minio_container" printenv MINIO_ROOT_PASSWORD 2>/dev/null || true)"
  fi
  # 端点是端点、凭据是凭据：`OBJECT_STORE_TEST_ENDPOINT` 只是端点，凭据是**独立的门控变量**，
  # 只设端点不设凭据时 spec 仍然整组跳过。
  if [[ -n "$minio_port" && -n "$minio_user" && -n "$minio_password" ]]; then
    ts_env+=("OBJECT_STORE_TEST_ENDPOINT=127.0.0.1:$minio_port")
    ts_env+=("OBJECT_STORE_TEST_CREDS=$minio_user:$minio_password")
  else
    warn "minio 容器在跑但解析不到端口或凭据（对象存储用例将被排除）"
  fi
fi

create_database() {
  local db="$1"
  # `client_min_messages=warning` 压掉 `DROP DATABASE IF EXISTS` 的 `NOTICE: database … does
  # not exist, skipping` —— 它会把结果的表格切得看不出来。只降级 NOTICE，ERROR 仍然照报，
  # 所以不是「把错误吞掉」。
  local psql=(docker exec -e PGOPTIONS=-c\ client_min_messages=warning "$pg_container" psql -U "$pg_user" -d postgres -q)
  "${psql[@]}" -c "DROP DATABASE IF EXISTS \"$db\"" >/dev/null
  "${psql[@]}" -c "CREATE DATABASE \"$db\"" >/dev/null
  created_databases+=("$db")
}

dsn_for() { echo "postgres://$pg_user:$pg_user@127.0.0.1:$pg_port/$1?sslmode=disable"; }

overall_rc=0
printf '%-18s %6s %6s %6s %6s  %s\n' MODULE PASS FAIL SKIP EXIT NOTE

# ---- Go 控制面 ----
# 模块清单**遍历仓库树**而不是写死：新加一个控制面服务时，写死的清单会静默漏掉它，而
# 「漏掉」与「通过」在输出上无法区分。（同类教训见 ci.yml 里按模块枚举 DSN 的那段。）
selected_modules=()
if (( $# > 0 )); then
  selected_modules=("$@")
else
  for go_mod in "$platform_dir"/control-plane/*/go.mod; do
    [[ -f "$go_mod" ]] || continue
    selected_modules+=("$(basename "$(dirname "$go_mod")")")
  done
fi
(( ${#selected_modules[@]} > 0 )) || fail "没有可跑的模块"

for module in "${selected_modules[@]}"; do
  [[ -d "$platform_dir/control-plane/$module" ]] || fail "未知模块 $module"
  # 库名里连字符换成下划线：`connector-gateway` → `lumo_local_connector_gateway`。
  db="lumo_local_${module//-/_}"
  create_database "$db"
  log="$report_dir/go-$module.log"
  rc=0
  ( cd "$platform_dir/control-plane/$module" \
      && env LUMO_TEST_PG_DSN="$(dsn_for "$db")" ${go_env[@]+"${go_env[@]}"} \
           go test -count=1 -v -timeout=600s ./... ) >"$log" 2>&1 || rc=$?
  # `grep -c` 无匹配返回 1，在 `set -e` 下会杀掉脚本；统一 `|| true`。
  # `-v` 下子测试缩进 4 空格、顶层不缩进，所以两种前缀都要数。
  passed="$(grep -cE '^(--- PASS|    --- PASS)' "$log" || true)"
  failed="$(grep -cE '^(--- FAIL|    --- FAIL)' "$log" || true)"
  skipped="$(grep -cE '^(--- SKIP|    --- SKIP)' "$log" || true)"
  note=""
  if (( rc != 0 )); then
    note="$(grep -E '^(--- FAIL|# )' "$log" | head -2 | tr '\n' ' ')"
  fi
  # 计数守卫：0 个通过 = 这一步没有产生证据（全被 skip / 编译失败 / 包名写错）。
  if (( passed < 1 )); then
    overall_rc=1
    note="执行了 0 个通过用例——这一步没有产生证据${note:+；$note}"
  elif (( rc != 0 )); then
    overall_rc=1
  fi
  printf '%-18s %6s %6s %6s %6s  %s\n' "$module" "$passed" "$failed" "$skipped" "$rc" "$note"
done

# ---- TS 侧活库 spec ----
# 门控变量名是各 spec 自己选的（`SESSION_LOG_TEST_DSN` 等），统一的 `LUMO_TEST_PG_DSN` 由
# platform/vitest.setup.ts 兜底成这些别名 —— 所以这里只导出统一名，**不重复**导出各子系统名：
# 两套并存机制迟早漂移，而那条桥接被删时下面的计数守卫会立刻变红。
gate_tokens='LUMO_TEST_PG_DSN|SESSION_LOG_TEST_DSN|METERING_TEST_DSN|JOB_CONTROL_TEST_DSN|STORAGE_TEST_DSN|OBJECT_STORE_TEST_ENDPOINT|SESSION_LOG_TEST_REDIS|LUMO_TEST_REDIS_DSN'
ts_specs=()
excluded_specs=()
while IFS= read -r spec; do
  [[ -n "$spec" ]] || continue
  missing=""
  # 依赖哪些服务由 spec 自己的门控变量决定，**不是**由文件名猜。写成 `if` 而不是
  # `grep -q && ! has_started && missing=…`：后者在 `set -e` 下的豁免规则（AND 列表里
  # 只有最后一个命令的失败会触发退出）不直观，容易在后续编辑中变成「脚本莫名其妙就退出」。
  if grep -qE 'OBJECT_STORE_TEST_ENDPOINT' "$spec" 2>/dev/null && ! has_started minio; then
    missing="${missing}minio "
  fi
  # 统一名与子系统名都要认：只认后者的话，一个按统一名门控的新 spec 在 redis 没起时不会被
  # 排除，而是直接跑失败——「该跳过」与「真坏了」就被混成同一种红了。
  if grep -qE 'SESSION_LOG_TEST_REDIS|LUMO_TEST_REDIS_DSN' "$spec" 2>/dev/null && ! has_started redis; then
    missing="${missing}redis "
  fi
  if [[ -n "$missing" ]]; then
    excluded_specs+=("$(basename "$spec")（缺 ${missing% }）")
  else
    ts_specs+=("$spec")
  fi
done < <(
  cd "$platform_dir" \
    && grep -rlE "$gate_tokens" --include='*.spec.ts' --exclude-dir=node_modules dsh-plugins 2>/dev/null \
    | sed "s|^|$platform_dir/|" | sort
)
(( ${#ts_specs[@]} > 0 )) || fail "没有可跑的 TS 活库 spec —— 门控变量可能被改名了"

if (( ${#excluded_specs[@]} > 0 )); then
  # 排除要**说出来**：不打印的话，「本轮绿的覆盖面」会被误读成「全部活体用例都过」。
  info "排除 ${#excluded_specs[@]} 个 spec（未启动其所需服务）："
  for line in "${excluded_specs[@]}"; do echo "  - $line"; done
  if ! has_started minio; then
    info "  起 MinIO：LUMO_LOCAL_SERVICES=$services_csv,minio $0"
  fi
fi

run_ts() {
  ts_db="lumo_local_ts"
  create_database "$ts_db"
  ts_log="$report_dir/ts.log"
  ts_json="$report_dir/ts.json"
  ts_guard_log="$report_dir/ts-guard.log"
  ts_counts="$report_dir/ts-counts.txt"

  info "TS 活库 spec：${#ts_specs[@]} 个文件"
  ts_rc=0
  (
    cd "$platform_dir"
    # `${ts_env[@]+"${ts_env[@]}"}` 而不是 `"${ts_env[@]}"`：本机 bash 是 3.2，`set -u` 下
    # 空数组的 `[@]` 展开会报 unbound variable；这个写法在 3.2 与 4+ 上行为一致。
    env LUMO_TEST_PG_DSN="$(dsn_for "$ts_db")" ${ts_env[@]+"${ts_env[@]}"} \
      ./node_modules/.bin/vitest run "${ts_specs[@]}" \
        --reporter=default --reporter=json --outputFile.json="$ts_json"
  ) >"$ts_log" 2>&1 || ts_rc=$?

  # 逐文件断言「至少 1 个非跳过用例」。这是本脚本最强的一道守卫：**按文件**看，而不是只看
  # 整卷通过数 —— 一个文件整体跳过（DSN 名字对不上）时整卷仍是绿的，而那正是 2026-09-15
  # 那次「零证据通过」的形态；收集期失败的文件在报告里根本不出现，也计入违规。
  ts_guard_rc=0
  # 报告路径走环境变量而不是 argv：`node -e` 下 `process.argv[1]` 的位置随 Node 版本变过
  # （历史上会给出 `[eval]`），env 与版本无关。
  LUMO_EXPECTED_SPECS="$(printf '%s\n' "${ts_specs[@]}")" LUMO_TS_REPORT="$ts_json" \
    node -e '
      const fs = require("node:fs")
      const reportPath = process.env.LUMO_TS_REPORT
      const expected = (process.env.LUMO_EXPECTED_SPECS || "").split("\n").filter(Boolean)
      let report
      try {
        report = JSON.parse(fs.readFileSync(reportPath, "utf8"))
      } catch (error) {
        console.error(`无法读取 vitest JSON 报告 ${reportPath}: ${error.message}`)
        process.exit(1)
      }
      // 只认 passed/failed；pending/todo/skipped/disabled 都不算「执行过」。
      const executedByFile = new Map()
      for (const result of report.testResults || []) {
        const executed = (result.assertionResults || [])
          .filter(entry => entry.status === "passed" || entry.status === "failed").length
        executedByFile.set(result.name, executed)
      }
      const offenders = []
      for (const spec of expected) {
        const hit = [...executedByFile.entries()].find(([name]) => name === spec || name.endsWith(spec))
        const executed = hit ? hit[1] : 0
        if (executed < 1) offenders.push(`${spec} → ${executed} 个非跳过用例`)
      }
      process.stdout.write(`${report.numPassedTests || 0} ${report.numFailedTests || 0}\n`)
      if (offenders.length > 0) {
        console.error("这些 spec 文件没有执行任何非跳过用例（缺服务会整组跳过，收集期失败记 0）：")
        for (const line of offenders) console.error(`  - ${line}`)
        process.exit(1)
      }
    ' >"$ts_counts" 2>"$ts_guard_log" || ts_guard_rc=$?

  ts_passed="$(cut -d' ' -f1 "$ts_counts" 2>/dev/null || true)"
  ts_failed="$(cut -d' ' -f2 "$ts_counts" 2>/dev/null || true)"
  ts_note=""
  if (( ts_guard_rc != 0 )); then
    overall_rc=1
    ts_note="活体用例计数守卫失败"
    cat "$ts_guard_log" >&2
  fi
  if (( ts_rc != 0 )); then
    overall_rc=1
    ts_note="${ts_note:+${ts_note}；}vitest 退出码非 0"
  fi
  printf '%-18s %6s %6s %6s %6s  %s\n' "ts-live-db" "${ts_passed:-?}" "${ts_failed:-?}" "-" "$ts_rc" "$ts_note"
}

run_ts

echo
if (( overall_rc != 0 )); then
  echo "local-pg: FAILED" >&2
  exit 1
fi
echo "local-pg: passed（依赖：${services_csv}；测试库前缀 lumo_local_*，跑完已清理）"

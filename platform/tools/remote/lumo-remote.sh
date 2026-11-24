#!/bin/sh
# lumo 远端安装器（P1 SSH 一键接入）。由本机经 `ssh host sh -s -- <cmd> ...` 从 stdin 送达执行，
# 也可以手动 `sh lumo-remote.sh <cmd> ...` 运行。POSIX sh，不依赖 bash。
#
# 子命令：
#   probe                              输出 key=value：os/arch/kernel/dep.*/installed.*
#   status   --root R                  输出当前与上一个版本、服务状态
#   install  --root R --version V --dsh-sha S --dsh-tag T
#            [--bundle-url U]          U 可以是完整包地址，或发布目录（以 / 结尾或不以 .tar.gz/.tgz 结尾）
#            [--bundle-sha256 H]       包的 sha256；不给时取 incoming 旁的 .sha256，或下载同目录 SHA256SUMS
#            [--sig-pubkey F]          可选：远端 PEM 公钥，校验 SHA256SUMS.sig（openssl）
#            [--service auto|user|system|none]  守护方式，默认 auto（有 systemd --user 用 user，否则 nohup）
#            [--health-timeout N]      启动后健康检查等待秒数，默认 60；0 表示跳过
#   upgrade  （同 install；要求已安装）
#   rollback --root R [--service ...]  切回上一个版本并重启服务
#
# 服务端安装包（见 platform/tools/remote/README.md）：
#   lumo-server-<V>-<os>-<arch>.tar.gz，顶层目录 lumo-server-<V>-<os>-<arch>/，含
#   VERSION（key=value）、manifest.json、files.sha256、bin/lumo-node、app/{deepseek-harness,platform}
#   离线：本机先 scp 到 R/incoming/<包名>（可带 <包名>.sha256），install 不传 --bundle-url 即可。
#
# 目录布局（幂等、原子切换、可回滚）：
#   R/releases/<V>-<sha12>/   完整发布物 + .lumo-release（version / dsh_sha / dsh_tag）
#   R/current  -> releases/... 当前版本（ln -sfn + mv 原子替换）
#   R/previous -> releases/... 上一个版本（rollback 用）
#   R/lumo.env                 可选环境变量（systemd EnvironmentFile / nohup 启动时读取）
#   R/.lock                    mkdir 锁，防止并发安装
# 失败时：新版本目录被删除，current 不动；切换后自检或健康检查失败则自动切回 previous 并重启旧服务。
set -eu

die() { echo "error=$*" >&2; exit 1; }
cmd="${1:-}"; [ -n "$cmd" ] || die "missing command"; shift
ROOT="" VERSION="" DSH_SHA="" DSH_TAG="" BUNDLE_URL="" BUNDLE_SHA="" SIG_PUBKEY="" SERVICE="auto" HEALTH_TIMEOUT="60"
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || die "missing value for $1"
  case "$1" in
    --root) ROOT="$2"; shift 2 ;;
    --version) VERSION="$2"; shift 2 ;;
    --dsh-sha) DSH_SHA="$2"; shift 2 ;;
    --dsh-tag) DSH_TAG="$2"; shift 2 ;;
    --bundle-url) BUNDLE_URL="$2"; shift 2 ;;
    --bundle-sha256) BUNDLE_SHA="$2"; shift 2 ;;
    --sig-pubkey) SIG_PUBKEY="$2"; shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --health-timeout) HEALTH_TIMEOUT="$2"; shift 2 ;;
    *) die "unknown argument $1" ;;
  esac
done
case "$ROOT" in "~/"*) ROOT="$HOME/${ROOT#\~/}" ;; esac
case "$ROOT" in ""|/*) ;; *) ROOT="$HOME/$ROOT" ;; esac
case "$SERVICE" in auto|user|system|none) ;; *) die "invalid --service $SERVICE" ;; esac
echo "$HEALTH_TIMEOUT" | grep -Eq '^[0-9]{1,4}$' || die "invalid --health-timeout"

dep() { if command -v "$1" >/dev/null 2>&1; then v=$("$1" --version 2>/dev/null | head -n1 | tr -d '\r' || true); echo "dep.$1=${v:-present}"; else echo "dep.$1=missing"; fi; }

host_os() { uname -s | tr 'A-Z' 'a-z'; }
host_arch() { case "$(uname -m)" in x86_64|amd64) echo x64 ;; aarch64|arm64) echo arm64 ;; *) uname -m ;; esac; }

do_probe() {
  echo "os=$(host_os)"
  echo "arch=$(uname -m)"
  echo "kernel=$(uname -r)"
  for d in node tar curl sha256sum shasum systemctl openssl frpc; do dep "$d"; done
  r="${ROOT:-$HOME/.lumo-remote}"; case "$r" in "~/"*) r="$HOME/${r#\~/}" ;; esac
  if [ -L "$r/current" ] && [ -f "$r/current/.lumo-release" ]; then
    echo "installed.version=$(sed -n 's/^version=//p' "$r/current/.lumo-release")"
    echo "installed.dsh=$(sed -n 's/^dsh_sha=//p' "$r/current/.lumo-release")"
  fi
}

lock() {
  mkdir -p "$ROOT"
  if ! mkdir "$ROOT/.lock" 2>/dev/null; then die "another install is running (remove $ROOT/.lock if stale)"; fi
  trap 'rm -rf "$ROOT/.lock"' EXIT INT TERM
}

sha256() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
sha256_check() { # $1 dir, $2 list file（相对 $1）
  if command -v sha256sum >/dev/null 2>&1; then (cd "$1" && sha256sum -c "$2" >/dev/null 2>&1)
  else (cd "$1" && shasum -a 256 -c -s "$2" >/dev/null 2>&1); fi
}

swap_link() { # $1 name  $2 target(relative)
  ln -sfn "$2" "$ROOT/.$1.tmp" || return 1
  # GNU/BusyBox -T and BSD -h both replace the link, not a file inside it.
  case "$(host_os)" in darwin) mv -fh "$ROOT/.$1.tmp" "$ROOT/$1" ;; *) mv -fT "$ROOT/.$1.tmp" "$ROOT/$1" ;; esac
}

# ---- 守护：systemd（user/system）或 nohup 兜底 ----
svc_mode() {
  case "$SERVICE" in
    auto)
      if command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then echo user; else echo none; fi ;;
    *) echo "$SERVICE" ;;
  esac
}
svc_ctl() { if [ "$MODE" = user ]; then systemctl --user "$@"; else systemctl "$@"; fi; }
unit_path() { if [ "$MODE" = user ]; then echo "$HOME/.config/systemd/user/lumo-server.service"; else echo "/etc/systemd/system/lumo-server.service"; fi; }
write_unit() {
  u="$(unit_path)"; mkdir -p "$(dirname "$u")"
  want="default.target"; [ "$MODE" = system ] && want="multi-user.target"
  cat > "$u.tmp" <<EOF
# 由 lumo-remote.sh 生成；指向 current，升级/回滚只需 restart。
[Unit]
Description=Lumo server (remote node)
After=network-online.target

[Service]
Type=simple
WorkingDirectory=$ROOT/current
Environment=LUMO_REMOTE_ROOT=$ROOT
EnvironmentFile=-$ROOT/lumo.env
ExecStart=$ROOT/current/bin/lumo-node run
Restart=on-failure
RestartSec=5
TimeoutStopSec=20
NoNewPrivileges=yes

[Install]
WantedBy=$want
EOF
  mv -f "$u.tmp" "$u"
  svc_ctl daemon-reload
  svc_ctl enable lumo-server.service >/dev/null 2>&1 || true
}
svc_stop() {
  case "$MODE" in
    user|system) svc_ctl stop lumo-server.service >/dev/null 2>&1 || true ;;
    none)
      if [ -f "$ROOT/run/lumo.pid" ]; then
        pid="$(cat "$ROOT/run/lumo.pid")"
        kill "$pid" 2>/dev/null || true
        i=0; while [ $i -lt 20 ] && kill -0 "$pid" 2>/dev/null; do sleep 1; i=$((i + 1)); done
        kill -9 "$pid" 2>/dev/null || true
        rm -f "$ROOT/run/lumo.pid"
      fi ;;
  esac
}
svc_start() {
  case "$MODE" in
    user|system) write_unit; svc_ctl restart lumo-server.service ;;
    none)
      svc_stop
      mkdir -p "$ROOT/run" "$ROOT/logs"
      ( if [ -f "$ROOT/lumo.env" ]; then set -a; . "$ROOT/lumo.env"; set +a; fi
        LUMO_REMOTE_ROOT="$ROOT"; export LUMO_REMOTE_ROOT
        nohup "$ROOT/current/bin/lumo-node" run >>"$ROOT/logs/lumo-server.log" 2>&1 &
        echo $! > "$ROOT/run/lumo.pid" ) ;;
  esac
}
health() { # 健康检查：入口脚本 --healthcheck（本机 HTTP 探活），轮询到超时
  [ "$HEALTH_TIMEOUT" -eq 0 ] && return 0
  [ -x "$ROOT/current/bin/lumo-node" ] || return 0
  waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    if [ -f "$ROOT/lumo.env" ]; then (set -a; . "$ROOT/lumo.env"; set +a; "$ROOT/current/bin/lumo-node" --healthcheck) >/dev/null 2>&1 && return 0
    else "$ROOT/current/bin/lumo-node" --healthcheck >/dev/null 2>&1 && return 0; fi
    sleep 2; waited=$((waited + 2))
  done
  return 1
}

self_check() { # 新版本自检：发布物标记与目标一致，入口存在
  [ "$(sed -n 's/^version=//p' "$ROOT/current/.lumo-release")" = "$VERSION" ] || return 1
  [ "$(sed -n 's/^dsh_sha=//p' "$ROOT/current/.lumo-release")" = "$DSH_SHA" ] || return 1
  if [ -x "$ROOT/current/bin/lumo-node" ]; then "$ROOT/current/bin/lumo-node" --version >/dev/null 2>&1 || return 1; fi
  return 0
}

# ---- 取包 + 校验 ----
url_dir() { case "$1" in *.tar.gz|*.tgz) echo "${1%/*}" ;; *) echo "${1%/}" ;; esac; }
fetch() { curl -fsSL --proto '=https' --retry 3 -o "$2" "$1"; }

obtain_bundle() { # 输出：$tmp/bundle.tgz 与 BUNDLE_SHA（已确定）
  name="lumo-server-$VERSION-$(host_os)-$(host_arch).tar.gz"
  if [ -f "$ROOT/incoming/$name" ]; then
    # 本机通过 scp 预先推送的发布包（离线安装）
    cp "$ROOT/incoming/$name" "$tmp/bundle.tgz"
    if [ -z "$BUNDLE_SHA" ] && [ -f "$ROOT/incoming/$name.sha256" ]; then BUNDLE_SHA="$(cut -d' ' -f1 < "$ROOT/incoming/$name.sha256")"; fi
  elif [ -f "$ROOT/incoming/$rel.tgz" ]; then
    cp "$ROOT/incoming/$rel.tgz" "$tmp/bundle.tgz"   # 兼容早期 <rel>.tgz 命名
  elif [ -n "$BUNDLE_URL" ]; then
    case "$BUNDLE_URL" in https://*) ;; *) return 3 ;; esac
    base="$(url_dir "$BUNDLE_URL")"
    case "$BUNDLE_URL" in *.tar.gz|*.tgz) url="$BUNDLE_URL"; name="${BUNDLE_URL##*/}" ;; *) url="$base/$name" ;; esac
    fetch "$url" "$tmp/bundle.tgz" || return 4
    if [ -z "$BUNDLE_SHA" ] || [ -n "$SIG_PUBKEY" ]; then
      fetch "$base/SHA256SUMS" "$tmp/SHA256SUMS" || return 5
      if [ -n "$SIG_PUBKEY" ]; then
        command -v openssl >/dev/null 2>&1 || return 6
        fetch "$base/SHA256SUMS.sig" "$tmp/SHA256SUMS.sig" || return 6
        openssl dgst -sha256 -verify "$SIG_PUBKEY" -signature "$tmp/SHA256SUMS.sig" "$tmp/SHA256SUMS" >/dev/null 2>&1 || return 6
      fi
      listed="$(awk -v n="$name" '$2 == n || $2 == "*" n { print $1 }' "$tmp/SHA256SUMS" | head -n1)"
      [ -n "$listed" ] || return 5
      if [ -n "$BUNDLE_SHA" ] && [ "$BUNDLE_SHA" != "$listed" ]; then return 2; fi
      BUNDLE_SHA="$listed"
    fi
  else
    return 7
  fi
  # fail closed：没有可信 sha256 不安装
  [ -n "$BUNDLE_SHA" ] || return 5
  [ "$(sha256 "$tmp/bundle.tgz")" = "$BUNDLE_SHA" ] || return 2
  return 0
}

verify_tree() { # $1 解包后的发布物根
  # 新格式：VERSION + files.sha256 必须与目标一致且全部文件通过校验；旧格式（无 VERSION）只做标记比对
  [ -f "$1/VERSION" ] || return 0
  [ "$(sed -n 's/^version=//p' "$1/VERSION")" = "$VERSION" ] || return 1
  [ "$(sed -n 's/^dsh_sha=//p' "$1/VERSION")" = "$DSH_SHA" ] || return 1
  [ "$(sed -n 's/^os=//p' "$1/VERSION")" = "$(host_os)" ] || return 1
  [ "$(sed -n 's/^arch=//p' "$1/VERSION")" = "$(host_arch)" ] || return 1
  [ -f "$1/files.sha256" ] || return 1
  sha256_check "$1" files.sha256 || return 1
  return 0
}

do_install() {
  [ -n "$ROOT" ] && [ -n "$VERSION" ] && [ -n "$DSH_TAG" ] || die "install requires --root --version --dsh-tag --dsh-sha"
  echo "$DSH_SHA" | grep -Eq '^[0-9a-f]{40}$' || die "dsh sha must be 40 hex"
  echo "$VERSION" | grep -Eq '^[0-9A-Za-z.+-]{1,40}$' || die "invalid version"
  [ -z "$BUNDLE_SHA" ] || echo "$BUNDLE_SHA" | grep -Eq '^[0-9a-f]{64}$' || die "bundle sha256 must be 64 hex"
  lock
  MODE="$(svc_mode)"
  rel="$VERSION-$(echo "$DSH_SHA" | cut -c1-12)"
  dir="$ROOT/releases/$rel"
  if [ -L "$ROOT/current" ] && [ "$(readlink "$ROOT/current")" = "releases/$rel" ] && self_check && health; then
    echo "result=already-installed"; echo "release=$rel"; return 0
  fi
  if [ ! -f "$dir/.lumo-release" ]; then
    tmp="$ROOT/releases/.tmp-$rel-$$"
    rm -rf "$tmp"; mkdir -p "$tmp/tree"
    cleanup_tmp() { rm -rf "$tmp"; }
    rc=0; obtain_bundle || rc=$?
    case "$rc" in
      0) ;;
      2) cleanup_tmp; die "bundle checksum mismatch" ;;
      3) cleanup_tmp; die "bundle url must be https" ;;
      4) cleanup_tmp; die "download failed" ;;
      5) cleanup_tmp; die "no trusted sha256 for bundle (pass --bundle-sha256, ship <name>.sha256 or publish SHA256SUMS)" ;;
      6) cleanup_tmp; die "SHA256SUMS signature verification failed" ;;
      *) cleanup_tmp; die "no bundle: pass --bundle-url or scp lumo-server-$VERSION-$(host_os)-$(host_arch).tar.gz to $ROOT/incoming/" ;;
    esac
    # 拒绝绝对路径与 .. 成员，防止解包越界
    if tar -tzf "$tmp/bundle.tgz" | grep -Eq '^/|(^|/)\.\.(/|$)'; then cleanup_tmp; die "unsafe paths in bundle"; fi
    tar -xzf "$tmp/bundle.tgz" -C "$tmp/tree" || { cleanup_tmp; die "extract failed"; }
    rm -f "$tmp/bundle.tgz" "$tmp/SHA256SUMS" "$tmp/SHA256SUMS.sig"
    # 新格式包有唯一顶层目录 lumo-server-*/，提升一层
    top="$(ls -1 "$tmp/tree")"
    if [ "$(echo "$top" | wc -l | tr -d ' ')" = 1 ] && [ -d "$tmp/tree/$top" ] && [ -f "$tmp/tree/$top/VERSION" ]; then src="$tmp/tree/$top"; else src="$tmp/tree"; fi
    verify_tree "$src" || { cleanup_tmp; die "bundle manifest/file verification failed"; }
    printf 'version=%s\ndsh_sha=%s\ndsh_tag=%s\ninstalled_at=%s\n' "$VERSION" "$DSH_SHA" "$DSH_TAG" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$src/.lumo-release"
    mkdir -p "$ROOT/releases"; rm -rf "$dir"; mv "$src" "$dir"; rm -rf "$tmp"
  fi
  old=""; [ -L "$ROOT/current" ] && old="$(readlink "$ROOT/current")"
  swap_link current "releases/$rel"
  ok=1
  self_check || ok=0
  if [ "$ok" = 1 ]; then svc_start || ok=0; fi
  if [ "$ok" = 1 ]; then health || ok=0; fi
  if [ "$ok" = 0 ]; then
    if [ "$old" = "releases/$rel" ]; then
      die "self check failed (release $rel kept; see logs, or rollback)"
    elif [ -n "$old" ]; then
      swap_link current "$old"; svc_start >/dev/null 2>&1 || true; echo "result=rolled-back"
    else svc_stop; rm -f "$ROOT/current"; fi
    rm -rf "$dir"; die "self check failed"
  fi
  [ -n "$old" ] && [ "$old" != "releases/$rel" ] && swap_link previous "$old"
  rm -f "$ROOT/incoming/lumo-server-$VERSION-"*.tar.gz "$ROOT/incoming/lumo-server-$VERSION-"*.tar.gz.sha256 2>/dev/null || true
  # 只保留 current / previous 指向的版本 + 最新 3 个
  ls -1t "$ROOT/releases" 2>/dev/null | tail -n +4 | while read -r r; do
    [ "releases/$r" = "$(readlink "$ROOT/current" 2>/dev/null)" ] && continue
    [ "releases/$r" = "$(readlink "$ROOT/previous" 2>/dev/null)" ] && continue
    rm -rf "$ROOT/releases/$r"
  done
  echo "service=$MODE"
  echo "result=installed"; echo "release=$rel"
}

do_rollback() {
  [ -n "$ROOT" ] || die "rollback requires --root"
  lock
  MODE="$(svc_mode)"
  [ -L "$ROOT/previous" ] || die "no previous release"
  prev="$(readlink "$ROOT/previous")"; cur="$(readlink "$ROOT/current" 2>/dev/null || true)"
  [ -f "$ROOT/$prev/.lumo-release" ] || die "previous release missing"
  swap_link current "$prev"
  [ -n "$cur" ] && swap_link previous "$cur"
  svc_start || die "service restart failed after rollback"
  health || echo "warning=health check failed after rollback" >&2
  echo "result=rolled-back"; echo "release=${prev#releases/}"
}

do_status() {
  [ -n "$ROOT" ] || die "status requires --root"
  MODE="$(svc_mode)"
  [ -L "$ROOT/current" ] && echo "current=$(readlink "$ROOT/current")"
  [ -L "$ROOT/previous" ] && echo "previous=$(readlink "$ROOT/previous")"
  echo "service=$MODE"
  if [ "$MODE" != none ]; then echo "service.active=$(svc_ctl is-active lumo-server.service 2>/dev/null || true)"
  elif [ -f "$ROOT/run/lumo.pid" ] && kill -0 "$(cat "$ROOT/run/lumo.pid")" 2>/dev/null; then echo "service.active=active"
  else echo "service.active=inactive"; fi
  return 0
}

case "$cmd" in
  probe) do_probe ;;
  status) do_status ;;
  install) do_install ;;
  upgrade) [ -L "${ROOT:-/nonexistent}/current" ] || die "not installed; use install"; do_install ;;
  rollback) do_rollback ;;
  *) die "unknown command $cmd" ;;
esac

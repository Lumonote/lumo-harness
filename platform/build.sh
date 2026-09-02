#!/usr/bin/env bash
# 一键构建入口：12 个 Docker 镜像 + macOS 桌面包（darwin-arm64 / darwin-x64）。
#
# 本地与 CI（.github/workflows/release.yml）共用这一份脚本，避免「本地能跑、CI 产出
# 不一样」的双份维护。设计见 docs/superpowers/specs/2026-09-02-one-click-build-design.md。
#
#   ./platform/build.sh                        # 默认 = --targets images
#   ./platform/build.sh --targets darwin-arm64
#   ./platform/build.sh --targets all          # 镜像 + 本机架构桌面包
#   ./platform/build.sh --targets images --push --registry ghcr.io/lumo-harness \
#                       --platform linux/amd64,linux/arm64
#   ./platform/build.sh --dry-run --targets all
#
# 兼容 macOS 自带的 bash 3.2：不用关联数组、mapfile、wait -n。
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd -- "$script_dir/.." && pwd)"
platform_root="$script_dir"
dsh_root="$repo_root/deepseek-harness"
# shellcheck source=deploy/lib/dsh-source.sh
source "$platform_root/deploy/lib/dsh-source.sh"

# 子进程入口（xargs -P 并行构建单个镜像）：`$0 __build-image <spec>`，上下文经
# LUMO_BUILD_* 环境变量恢复。真正的分发在文件末尾，函数定义完之后。
subprocess_spec=""
if [[ "${1:-}" == "__build-image" ]]; then
  subprocess_spec="${2:?__build-image 需要镜像 spec}"
  set -- --targets images
fi

# ---- 镜像清单（§3）----
# 形如 name|context(相对仓库根)|dockerfile(相对 context)。observability 是共享库、
# Dockerfile.resume 是 dev-loop 变体、artifact-runtime 复用 provisioner 镜像，均不在此。
go_images=(
  "collaborator|platform/control-plane|collaborator/Dockerfile"
  "connector-gateway|platform/control-plane|connector-gateway/Dockerfile"
  "flows|platform/control-plane|flows/Dockerfile"
  "governance|platform/control-plane|governance/Dockerfile"
  "llm-gateway|platform/control-plane|llm-gateway/Dockerfile"
  "projects|platform/control-plane|projects/Dockerfile"
  "registry|platform/control-plane|registry/Dockerfile"
  "scheduler|platform/control-plane|scheduler/Dockerfile"
  "usage-ledger|platform/control-plane|usage-ledger/Dockerfile"
  "provisioner|platform/control-plane|registry/Dockerfile.provisioner"
)
# 仓库根为 context 的两个镜像；dsh-node 最重且 pnpm store 有写竞争，串行。
root_images=(
  "console|.|platform/console/Dockerfile"
  "dsh-node|.|platform/data-plane/dsh-node/Dockerfile"
)

usage() {
  cat >&2 <<EOF
usage: $0 [--targets <list>] [--registry <prefix>] [--version <v>] [--push]
          [--platform <p1,p2>] [--jobs <n>] [--dry-run]

  --targets   逗号分隔：images | darwin-arm64 | darwin-x64 | all | win-x64（报错）
              默认 images。all = 镜像 + 宿主架构桌面包（非 macOS 上仅镜像）。
  --registry  设置后镜像 tag 为 <registry>/<name>:<version>；否则 lumo/<name>:dev
  --version   默认读 platform/package.json
  --push      推送镜像，需配合 --registry；推送前校验三处版本一致
  --platform  docker 平台；多平台仅在 --push 时可用（buildx 无法 --load 多平台产物）
  --jobs      Go 镜像并行度，默认 CPU 数
  --dry-run   只打印将执行的命令
EOF
  exit 64
}

die() { echo "build.sh: $*" >&2; exit 1; }

# ---- 参数 ----
targets_arg="images"
registry=""
version=""
push=0
platform_arg=""
jobs=""
dry_run=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --targets) [[ $# -ge 2 ]] || usage; targets_arg="$2"; shift 2 ;;
    --targets=*) targets_arg="${1#*=}"; shift ;;
    --registry) [[ $# -ge 2 ]] || usage; registry="${2%/}"; shift 2 ;;
    --registry=*) registry="${1#*=}"; registry="${registry%/}"; shift ;;
    --version) [[ $# -ge 2 ]] || usage; version="$2"; shift 2 ;;
    --version=*) version="${1#*=}"; shift ;;
    --push) push=1; shift ;;
    --platform) [[ $# -ge 2 ]] || usage; platform_arg="$2"; shift 2 ;;
    --platform=*) platform_arg="${1#*=}"; shift ;;
    --jobs) [[ $# -ge 2 ]] || usage; jobs="$2"; shift 2 ;;
    --jobs=*) jobs="${1#*=}"; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

# ---- 宿主 ----
# LUMO_BUILD_HOST_OS / LUMO_BUILD_HOST_ARCH 仅供 --dry-run 测试模拟另一台构建机。
host_os="${LUMO_BUILD_HOST_OS:-$(uname -s)}"
host_arch="${LUMO_BUILD_HOST_ARCH:-$(uname -m)}"
case "$host_arch" in
  arm64|aarch64) host_arch="arm64" ;;
  x86_64|amd64) host_arch="x64" ;;
esac
host_desktop_target=""
[[ "$host_os" == "Darwin" ]] && host_desktop_target="darwin-$host_arch"

if [[ -z "$jobs" ]]; then
  jobs="$(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null || echo 4)"
fi
[[ "$jobs" =~ ^[1-9][0-9]*$ ]] || die "--jobs 必须是正整数：$jobs"

# ---- 版本 ----
read_package_version() {
  sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$platform_root/package.json" | head -1
}
[[ -n "$version" ]] || version="$(read_package_version)"
[[ -n "$version" ]] || die "无法从 platform/package.json 读取版本"

# ---- target 解析 ----
want_images=0
desktop_targets=""
add_desktop_target() {
  case " $desktop_targets " in
    *" $1 "*) ;;
    *) desktop_targets="${desktop_targets:+$desktop_targets }$1" ;;
  esac
}

print_windows_gap() {
  cat >&2 <<'EOF'
build.sh: --targets win-x64 尚不支持。桌面打包链从头到尾假设「macOS + 构建机架构」，
Windows 是一次独立的移植工作（设计 §1），不是给脚本加一个 flag：

  位置                                  硬编码                                    后果
  desktop/build-runtime.mjs keepOnly    只保留 darwin 原生二进制                   非 darwin 的 onnxruntime/node-pty/ripgrep 被删
  desktop/build-runtime.mjs otool/lipo  Mach-O 专用可移植性与架构闸门              Node 与 Python 的唯一闸门
  upstream/install-components.sh        宿主 python3 -m venv → bin/python          Windows venv 是 Scripts/python.exe
  desktop/lumo-runtime.sh               #!/bin/sh、~/Library/Application Support   Windows 无 POSIX shell，路径不成立
  desktop/src/main.rs                   候选路径全是 lumo-runtime.sh + Contents/   启动器只认 macOS .app 布局
  desktop/make-dmg.sh                   hdiutil                                   macOS 专用
EOF
  exit 2
}

IFS=',' read -r -a requested <<<"$targets_arg"
for target in "${requested[@]}"; do
  target="$(echo "$target" | tr -d '[:space:]')"
  [[ -n "$target" ]] || continue
  case "$target" in
    images) want_images=1 ;;
    darwin-arm64|darwin-x64)
      # 具名 target 是「必须产出」：宿主非 macOS 直接硬失败。
      [[ "$host_os" == "Darwin" ]] || die "$target 只能在 macOS 上构建（当前宿主：${host_os}）"
      add_desktop_target "$target"
      ;;
    all)
      # all 是「尽力而为」：非 macOS 上只出镜像并说明。
      want_images=1
      if [[ -n "$host_desktop_target" ]]; then
        add_desktop_target "$host_desktop_target"
      else
        echo "build.sh: 宿主 $host_os 不是 macOS，--targets all 仅构建镜像，跳过桌面包"
      fi
      ;;
    win-x64) print_windows_gap ;;
    *) die "未知 target：${target}（可用：images, darwin-arm64, darwin-x64, all）" ;;
  esac
done
[[ $want_images -eq 1 || -n "$desktop_targets" ]] || die "没有可构建的 target：$targets_arg"

# ---- 参数约束 ----
if [[ $push -eq 1 && -z "$registry" ]]; then
  die "--push 需要配合 --registry"
fi
if [[ "$platform_arg" == *,* && $push -eq 0 ]]; then
  die "多平台（${platform_arg}）只能配合 --push：buildx 无法把多平台产物 --load 进本地 daemon"
fi

# ---- 执行辅助 ----
run() {
  if [[ $dry_run -eq 1 ]]; then
    printf '+'
    printf ' %q' "$@"
    printf '\n'
  else
    echo "+ $*" >&2
    "$@"
  fi
}

image_tag() {
  if [[ -n "$registry" ]]; then
    echo "$registry/$1:$version"
  else
    echo "lumo/$1:dev"
  fi
}

# ---- 版本一致性（§3.1）：推送前硬失败 ----
check_version_consistency() {
  local chart="$platform_root/deploy/helm/lumo-platform/Chart.yaml"
  local tauri="$platform_root/desktop/tauri.conf.json"
  local pkg_v chart_v chart_app_v tauri_v mismatch=0
  pkg_v="$(read_package_version)"
  chart_v="$(sed -n 's/^version: *\(.*\)$/\1/p' "$chart" | tr -d '"' | head -1)"
  chart_app_v="$(sed -n 's/^appVersion: *\(.*\)$/\1/p' "$chart" | tr -d '"' | head -1)"
  tauri_v="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "$tauri" | head -1)"
  for pair in "platform/package.json=$pkg_v" \
              "deploy/helm/lumo-platform/Chart.yaml version=$chart_v" \
              "deploy/helm/lumo-platform/Chart.yaml appVersion=$chart_app_v" \
              "desktop/tauri.conf.json=$tauri_v"; do
    if [[ "${pair#*=}" != "$version" ]]; then
      echo "  ${pair%%=*}: ${pair#*=}  (期望 $version)" >&2
      mismatch=1
    fi
  done
  if [[ $mismatch -eq 1 ]]; then
    die "--push 拒绝：三处版本不一致。推上去的 tag 会与 Helm 引用静默错开，请先对齐再推送。"
  fi
  echo "版本一致：${version}（package.json / Chart.yaml / tauri.conf.json）"
}

# ---- 单镜像构建 ----
# 通过 `$0 __build-image <spec>` 复用，便于 xargs -P 并行；参数经环境变量传递。
docker_build_one() {
  local spec="$1"
  local name="${spec%%|*}" rest="${spec#*|}"
  local context="${rest%%|*}" dockerfile="${rest#*|}"
  local tag; tag="$(image_tag "$name")"
  local cmd=()
  if [[ $push -eq 1 ]]; then
    cmd=(docker buildx build --push)
  else
    cmd=(docker build)
  fi
  [[ -n "$platform_arg" ]] && cmd+=(--platform "$platform_arg")
  local context_dir="$repo_root"
  [[ "$context" == "." ]] || context_dir="$repo_root/$context"
  cmd+=(-f "$context_dir/$dockerfile" -t "$tag" "$context_dir")
  run "${cmd[@]}"
}

build_image_entry() {
  # 子进程入口：从环境变量恢复上下文。
  push="${LUMO_BUILD_PUSH:-0}" platform_arg="${LUMO_BUILD_PLATFORM:-}"
  registry="${LUMO_BUILD_REGISTRY:-}" version="${LUMO_BUILD_VERSION:-}" dry_run="${LUMO_BUILD_DRY_RUN:-0}"
  docker_build_one "$1"
}

ensure_dsh_source_unless_dry() {
  if [[ $dry_run -eq 1 ]]; then
    echo "+ ensure_dsh_source $dsh_root  # 缺失时浅克隆，已存在则原样使用"
  else
    ensure_dsh_source "$dsh_root"
  fi
}

build_images() {
  echo "== 镜像（${#go_images[@]} 个 Go + ${#root_images[@]} 个仓库根 context，并行度 ${jobs}）=="
  [[ $push -eq 1 ]] && check_version_consistency
  ensure_dsh_source_unless_dry

  if [[ $dry_run -eq 1 || $jobs -eq 1 ]]; then
    for spec in "${go_images[@]}"; do docker_build_one "$spec"; done
  else
    export LUMO_BUILD_PUSH="$push" LUMO_BUILD_PLATFORM="$platform_arg" \
      LUMO_BUILD_REGISTRY="$registry" LUMO_BUILD_VERSION="$version" LUMO_BUILD_DRY_RUN="$dry_run"
    printf '%s\n' "${go_images[@]}" | xargs -P "$jobs" -I{} bash "$0" __build-image {}
  fi
  for spec in "${root_images[@]}"; do docker_build_one "$spec"; done
  echo "== 镜像完成：$(for s in "${go_images[@]}" "${root_images[@]}"; do image_tag "${s%%|*}"; done | tr '\n' ' ')"
}

# ---- 桌面包（§4）----
build_desktop() {
  local target="$1" arch="${1#darwin-}"
  local lipo_arch="x86_64"
  [[ "$arch" == "arm64" ]] && lipo_arch="arm64"
  echo "== 桌面包 $target =="
  if [[ "$target" != "$host_desktop_target" ]]; then
    # x64 venv 必须在 x64 环境里建（native wheel），Rust 壳同理；跨架构走 CI。
    die "$target 不能在 $host_desktop_target 宿主上构建：PPT venv 与 Rust 壳都要求宿主架构一致。请走 CI（release.yml 的 macos-13 = x64 / macos-14 = arm64）。"
  fi
  ensure_dsh_source_unless_dry
  run bash "$platform_root/upstream/install-components.sh" --target "$target"
  # tauri 的 beforeBuildCommand 调 build-runtime.mjs；target 经环境变量传入
  # （与 package.json 的 desktop:dmg 一样在 desktop/ 目录下执行）。
  run env "LUMO_DESKTOP_TARGET=$target" cargo tauri build --bundles app
  run bash "$platform_root/desktop/make-dmg.sh"
  # 唯一能证明「x64 包真是 x64 包」的检查（§6）。
  local node_bin="$platform_root/desktop/target/release/bundle/macos/Lumo.app/Contents/Resources/runtime/node"
  if [[ $dry_run -eq 1 ]]; then
    printf '+ lipo -archs %q  # 断言 == %s\n' "$node_bin" "$lipo_arch"
  else
    local archs; archs="$(lipo -archs "$node_bin")"
    [[ "$archs" == "$lipo_arch" ]] || die "打包 Node 架构为 [$archs]，期望 ${lipo_arch}：$node_bin"
    echo "桌面包 Node 架构校验通过：$archs"
    ls "$platform_root"/desktop/target/release/bundle/dmg/Lumo_*_*.dmg
  fi
}

# ---- 第一铁律收尾（§6）----
assert_dsh_pristine() {
  [[ $dry_run -eq 0 && -d "$dsh_root/.git" ]] || return 0
  local porcelain describe
  porcelain="$(git -C "$dsh_root" status --porcelain -uno)"
  describe="$(git -C "$dsh_root" describe --tags --dirty 2>/dev/null || echo unknown)"
  if [[ -n "$porcelain" || "$describe" == *-dirty ]]; then
    echo "$porcelain" >&2
    die "第一铁律违规：构建把改动写回了 deepseek-harness（${describe}）。请用 git -C deepseek-harness checkout -- <path> 还原。"
  fi
  echo "deepseek-harness 洁净：$describe"
}

# ---- 主流程 ----
if [[ -n "$subprocess_spec" ]]; then
  build_image_entry "$subprocess_spec"
  exit
fi
if [[ $push -eq 1 && $dry_run -eq 0 ]] && ! docker buildx version >/dev/null 2>&1; then
  die "--push 需要 docker buildx"
fi
[[ $want_images -eq 1 ]] && build_images
for target in $desktop_targets; do
  cargo_dir="$platform_root/desktop"
  (cd "$cargo_dir" && build_desktop "$target")
done
assert_dsh_pristine
echo "build.sh 完成：targets=$targets_arg version=$version${registry:+ registry=$registry}${push:+ push=$push}"

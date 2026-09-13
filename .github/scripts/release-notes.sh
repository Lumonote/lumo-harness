#!/usr/bin/env bash
#
# 从 CHANGELOG.md 里取出指定版本的小节，输出到 stdout，作为 GitHub Release 正文。
#
# 用法：release-notes.sh <version> [changelog-path]
#   <version>         不带 v 前缀，例如 1.0.0
#   [changelog-path]  默认 CHANGELOG.md（相对当前工作目录）
#
# 取不到小节时回退为「自上一个 tag 起的提交列表」（需要完整历史与 tag，即
# actions/checkout 的 fetch-depth: 0），并且**仍然返回 0**——发布不应因为
# CHANGELOG 还没写就整个失败。
#
# 由 .github/workflows/changelog-release.yml 与 release.yml 共用，
# 保证两条路径产出的正文完全一致。

set -euo pipefail

version="${1:?用法: release-notes.sh <version> [changelog-path]}"
changelog="${2:-CHANGELOG.md}"

notes=''
if [ -f "$changelog" ]; then
  # 取 "## [<version>]" 这一行之后、下一个 "## [" 或链接定义行之前的内容。
  # 用 index(...) == 1 而不是正则，避免版本号里的点被当成通配符（1.0.0 会匹配到 1x0y0）。
  # 末尾的 "[1.0.0]: https://..." 是 Keep a Changelog 的链接定义，不属于正文。
  notes="$(
    awk -v ver="$version" '
      index($0, "## [" ver "]") == 1 { found = 1; next }
      found && (index($0, "## [") == 1 || $0 ~ /^\[[^]]+\]:/) { exit }
      found { print }
    ' "$changelog" | awk 'NF { keep = 1 } keep'
  )"
fi

if [ -n "${notes//[[:space:]]/}" ]; then
  printf '%s\n' "$notes"
  exit 0
fi

echo "release-notes: ${changelog} 中没有 v${version} 小节，回退为提交列表" >&2

fallback=''
if prev="$(git describe --tags --abbrev=0 "v${version}^" 2>/dev/null)"; then
  fallback="$(git log --no-merges --pretty='- %s (%h)' "${prev}..v${version}" 2>/dev/null || true)"
else
  # 首个 tag：没有可比较的上一个 tag，列出该 tag 可达的全部提交。
  fallback="$(git log --no-merges --pretty='- %s (%h)' "v${version}" 2>/dev/null || true)"
fi

# 连提交列表都拿不到（tag 不存在、或历史被浅克隆）时给一行占位：
# 保证 --notes-file 永不为空，发布本身不因此失败。
printf '%s\n' "${fallback:-（本次发布未提供更新说明，详见 CHANGELOG.md）}"

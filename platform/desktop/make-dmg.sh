#!/usr/bin/env bash
# 把 release DeepSeek Harness.app 打成压缩 dmg。
# tauri 的 dmg bundler（create-dmg）会用 AppleScript 让 Finder 摆图标，没有 GUI
# 自动化权限的环境（CI / 代理沙箱）必挂在 -10004「发生权限违例」。本脚本只做内容：
# DeepSeek Harness.app + /Applications 拖放链接，UDZO 压缩，全程不碰 Finder。
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
app="${script_dir}/target/release/bundle/macos/DeepSeek Harness.app"
version="$(sed -n 's/^  "version": "\([^"]*\)".*/\1/p' "${script_dir}/tauri.conf.json" | head -1)"
arch="$(uname -m)"
[ "${arch}" = "arm64" ] && arch="aarch64" || arch="x64"
dmg_dir="${script_dir}/target/release/bundle/dmg"
dmg="${dmg_dir}/DeepSeek-Harness_${version}_${arch}.dmg"

if [[ ! -d "${app}" ]]; then
  echo "DeepSeek Harness.app 不存在，请先在 platform/desktop 执行：cargo tauri build --bundles app" >&2
  exit 1
fi

staging="$(mktemp -d)"
trap 'rm -rf "${staging}" 2>/dev/null || true' EXIT
# APFS clonefile 秒级完成且不占额外空间；非 APFS 回退 ditto。
cp -Rc "${app}" "${staging}/DeepSeek Harness.app" 2>/dev/null || ditto "${app}" "${staging}/DeepSeek Harness.app"
ln -s /Applications "${staging}/Applications"

mkdir -p "${dmg_dir}"
rm -f "${dmg}"
hdiutil create -srcfolder "${staging}" -volname "DeepSeek Harness" -fs HFS+ -format UDZO -ov "${dmg}"
echo "dmg 完成：${dmg}（$(du -h "${dmg}" | cut -f1)）"

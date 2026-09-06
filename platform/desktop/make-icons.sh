#!/bin/sh
# 从 icons/deepseek-logo.svg（品牌源，DeepSeek 鱼形）生成 macOS 风格的圆角应用图标（icon.png + Lumo.icns）、
# 菜单栏模板图标（tray.png，同源剪影）与启动页圆形徽章（../desktop-assets/lumo-logo.png，boot.html + /branding/logo.png 共用）。
# 只依赖宿主 macOS 自带的 swiftc / iconutil，不引入 npm 依赖。构建入口见 tauri.conf.json 的 beforeBuildCommand。
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
icons="$here/icons"
build="$here/target/icons"
assets="$here/../desktop-assets"
mkdir -p "$build" "$assets"

generator="$build/make-icons"
if [ ! -x "$generator" ] || [ "$here/make-icons.swift" -nt "$generator" ]; then
  swiftc -O -o "$generator" "$here/make-icons.swift"
fi
"$generator" "$icons/deepseek-logo.svg" "$icons/icon.png" "$icons/tray.png" "$assets/lumo-logo.png"

# iconutil 需要一套固定命名的 iconset；每个尺寸从 1024 主图缩放，圆角与边距随之等比缩放。
iconset="$build/Lumo.iconset"
rm -rf "$iconset"; mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$icons/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$icons/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
if ! iconutil -c icns "$iconset" -o "$icons/Lumo.icns"; then
  # macOS 15's iconutil can reject CoreGraphics-generated PNG metadata even
  # when the iconset has the documented names and pixel dimensions. Keep the
  # checked-in ICNS only when it is valid and still contains this exact 1024px
  # source image; otherwise do not silently ship a stale or missing icon.
  existing="$build/Lumo-existing.iconset"
  rm -rf "$existing"
  if ! iconutil -c iconset "$icons/Lumo.icns" -o "$existing" >/dev/null 2>&1 \
    || ! cmp -s "$icons/icon.png" "$existing/icon_512x512@2x.png"; then
    echo "无法生成 $icons/Lumo.icns，且现有 ICNS 无效或与 icon.png 不匹配" >&2
    exit 1
  fi
  echo "警告：iconutil 拒绝当前 iconset，保留已验证的 $icons/Lumo.icns" >&2
fi
echo "已生成 $icons/Lumo.icns"

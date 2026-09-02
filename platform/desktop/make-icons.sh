#!/bin/sh
# 从 icons/logo.png 生成 macOS 风格的圆角应用图标（icon.png + Lumo.icns）与菜单栏模板图标（tray.png）。
# 只依赖宿主 macOS 自带的 swiftc / iconutil，不引入 npm 依赖。构建入口见 tauri.conf.json 的 beforeBuildCommand。
set -eu
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
icons="$here/icons"
build="$here/target/icons"
mkdir -p "$build"

generator="$build/make-icons"
if [ ! -x "$generator" ] || [ "$here/make-icons.swift" -nt "$generator" ]; then
  swiftc -O -o "$generator" "$here/make-icons.swift"
fi
"$generator" "$icons/logo.png" "$icons/icon.png" "$icons/tray.png"

# iconutil 需要一套固定命名的 iconset；每个尺寸从 1024 主图缩放，圆角与边距随之等比缩放。
iconset="$build/Lumo.iconset"
rm -rf "$iconset"; mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  double=$((size * 2))
  sips -z "$size" "$size" "$icons/icon.png" --out "$iconset/icon_${size}x${size}.png" >/dev/null
  sips -z "$double" "$double" "$icons/icon.png" --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$icons/Lumo.icns"
echo "已生成 $icons/Lumo.icns"

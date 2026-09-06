import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktopRoot = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(desktopRoot, '..', '..')

function run(command, args) {
  const result = spawnSync(command, args, { cwd: repoRoot, stdio: 'inherit' })
  if (result.error !== undefined) throw result.error
  if (result.status !== 0) throw new Error(`${command} 执行失败：${String(result.status ?? result.signal)}`)
}

function ensureWindowsIcon() {
  const iconPath = resolve(desktopRoot, 'icons', 'icon.ico')
  const png = readFileSync(resolve(desktopRoot, 'icons', 'icon.png'))
  // An ICO may contain PNG-compressed image data. Keeping the source PNG as
  // the payload avoids requiring ImageMagick or a Windows-only icon tool.
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  const entry = Buffer.alloc(16)
  entry.writeUInt8(0, 0) // 0 means 256px or larger
  entry.writeUInt8(0, 1)
  entry.writeUInt8(0, 2)
  entry.writeUInt8(0, 3)
  entry.writeUInt16LE(1, 4)
  entry.writeUInt16LE(32, 6)
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(header.length + entry.length, 12)
  writeFileSync(iconPath, Buffer.concat([header, entry, png]))
}

// macOS 需要由 CoreGraphics 生成 icns；Windows 直接复用已提交的 PNG 图标，
// 不让 Tauri 的 beforeBuildCommand 依赖 bash、swiftc 或 iconutil。
if (process.platform === 'darwin') run('sh', [resolve(desktopRoot, 'make-icons.sh')])
ensureWindowsIcon()
run(process.execPath, [resolve(desktopRoot, 'build-runtime.mjs')])

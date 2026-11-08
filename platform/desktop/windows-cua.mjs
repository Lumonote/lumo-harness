import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { resolveInstalledPackage } from './runtime-dependencies.mjs'

function peArchitecture(path) {
  const data = readFileSync(path)
  if (data.length < 64 || data.readUInt16LE(0) !== 0x5a4d) throw Error(`无效 Windows PE 文件：${path}`)
  const offset = data.readUInt32LE(0x3c)
  if (offset > data.length - 6 || data.readUInt32LE(offset) !== 0x00004550) throw Error(`无效 Windows PE header：${path}`)
  return data.readUInt16LE(offset + 4)
}
export function verifyWindowsCua({ packageRoot, targetArch, modulesRoot }) {
  const expected = { x64: 0x8664, arm64: 0xaa64 }[targetArch]
  if (!expected) throw Error(`不支持的 Windows CUA 架构：${targetArch}`)
  const executable = join(packageRoot, 'native', 'bin', `win32-${targetArch}`, 'lumo-cua-supervisor.exe')
  const receipt = JSON.parse(readFileSync(join(packageRoot, 'native', 'bin', `win32-${targetArch}`, 'receipt.json'), 'utf8'))
  const digest = createHash('sha256').update(readFileSync(executable)).digest('hex')
  if (receipt.version !== 1 || receipt.architecture !== targetArch || receipt.sha256 !== digest || peArchitecture(executable) !== expected) throw Error('Windows CUA supervisor 内容、架构与 receipt 不一致')
  const sdkRoot = resolveInstalledPackage('@trycua/cua-driver', packageRoot)
  const nativeRoot = (sdkRoot && resolveInstalledPackage(`@trycua/cua-driver-win32-${targetArch}-msvc`, sdkRoot))
    ?? (modulesRoot && join(modulesRoot, '@trycua', `cua-driver-win32-${targetArch}-msvc`))
  if (!nativeRoot) throw Error('Windows CUA 缺少目标 SDK native package，请保留 pnpm 可选依赖')
  const manifest = JSON.parse(readFileSync(join(nativeRoot, 'package.json'), 'utf8'))
  if (manifest.name !== `@trycua/cua-driver-win32-${targetArch}-msvc` || manifest.version !== '0.28.0') throw Error('Windows CUA native SDK 版本不匹配')
  for (const name of ['cua_driver_sdk.dll', 'cua_driver_node_runtime.node']) {
    if (peArchitecture(join(nativeRoot, name)) !== expected) throw Error(`Windows CUA ${name} 架构不匹配`)
  }
  return { available: true, provider: '@lumo/computer-use/windows', target: `win32-${targetArch}`, variant: 'release', digest, executable: relative(packageRoot, executable).split(sep).join('/') }
}
/** Build with host Windows rustc; the SDK is never imported while packaging. */
export function stageWindowsCua({ packageRoot, targetArch, modulesRoot, hostPlatform = process.platform, run = spawnSync }) {
  if (hostPlatform !== 'win32') throw Error('Windows CUA supervisor 必须在 Windows 构建机上编译')
  const target = { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' }[targetArch]
  if (!target || !existsSync(join(packageRoot, 'native', 'windows-supervisor.rs'))) throw Error('Windows CUA supervisor 源码或目标架构无效')
  const directory = join(packageRoot, 'native', 'bin', `win32-${targetArch}`)
  mkdirSync(directory, { recursive: true })
  const executable = join(directory, 'lumo-cua-supervisor.exe')
  const result = run('rustc', ['--edition=2021', '--target', target, '-C', 'opt-level=2', '-C', 'target-feature=+crt-static', join(packageRoot, 'native', 'windows-supervisor.rs'), '-o', executable], { encoding: 'utf8', windowsHide: true })
  if (result.error || result.status !== 0) throw Error(`Windows CUA supervisor 编译失败：${result.stderr || result.error?.message || result.status}`)
  writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify({ version: 1, architecture: targetArch, sha256: createHash('sha256').update(readFileSync(executable)).digest('hex') })}\n`)
  return verifyWindowsCua({ packageRoot, targetArch, modulesRoot })
}

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

export const cuaProviderPackage = '@deepseek-ai/dsh-experimental-cua-macos'
const applicationName = 'DSH Computer Use.app'
const digestPattern = /^[a-f0-9]{64}$/u
const requiredFiles = [
  'Contents/MacOS/dsh-cua-native',
  'Contents/Info.plist',
  'Contents/Resources/DSHComputerUse.icns',
  'Contents/Resources/LICENSE.computer-use-icon',
  'Contents/Resources/LICENSE.cua-driver',
]

function fail(message, cause) {
  return new Error(`无法打包 Computer Use helper：${message}`, cause === undefined ? undefined : { cause })
}

function regularFile(path) {
  let stat
  try { stat = lstatSync(path) } catch (error) { throw fail(`缺少文件 ${path}`, error) }
  if (!stat.isFile()) throw fail(`不是普通文件 ${path}`)
  return stat
}

function checkArchitecture(targetArch) {
  if (targetArch !== 'arm64' && targetArch !== 'x64') throw fail(`不支持的 macOS 架构 ${targetArch}`)
  return targetArch === 'x64' ? 'x86_64' : 'arm64'
}

function runChecked(run, command, args, label, options = {}) {
  const result = run(command, args, { encoding: 'utf8', ...options })
  if (result.error !== undefined || result.status !== 0) {
    const diagnostic = result.stderr?.toString().trim() || result.error?.message || String(result.status ?? result.signal)
    throw fail(`${label}失败：${diagnostic}`, result.error)
  }
  return result
}

/** Same bundle membership, bytes and executable-bit digest as upstream native/build_app.py. */
export function cuaBundleDigest(application) {
  if (!lstatSync(application).isDirectory()) throw fail(`应用不是普通目录 ${application}`)
  const files = []
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) files.push(path)
      else throw fail(`应用包含符号链接或特殊文件 ${path}`)
    }
  }
  visit(application)
  const portable = (path) => relative(application, path).split(sep).join('/')
  // UTF-8 lexical order agrees with Python's Unicode code point ordering.
  files.sort((left, right) => Buffer.compare(Buffer.from(portable(left)), Buffer.from(portable(right))))
  const digest = createHash('sha256')
  for (const path of files) {
    digest.update(`${portable(path)}\0`)
    digest.update(createHash('sha256').update(readFileSync(path)).digest())
    digest.update(Buffer.from([Number((lstatSync(path).mode & 0o111) !== 0)]))
  }
  return digest.digest('hex')
}

/** Verify a relocated, installed provider without starting the helper or requesting OS permissions. */
export function verifyCuaHelper({ packageRoot, targetArch, run = spawnSync }) {
  const expectedArchitecture = checkArchitecture(targetArch)
  const directory = join(packageRoot, 'native', 'bin', `darwin-${targetArch}`)
  const receiptPath = join(directory, 'current.json')
  regularFile(receiptPath)
  let receipt
  try { receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) } catch (error) { throw fail(`无效的 helper receipt ${receiptPath}`, error) }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)
    || Object.keys(receipt).length !== 1 || typeof receipt.bundle !== 'string' || !digestPattern.test(receipt.bundle)) {
    throw fail(`无效的 helper receipt ${receiptPath}`)
  }
  const application = join(directory, receipt.bundle, applicationName)
  for (const path of requiredFiles) regularFile(join(application, path))
  const executable = join(application, requiredFiles[0])
  if ((lstatSync(executable).mode & 0o111) === 0) throw fail(`helper 没有可执行权限 ${executable}`)
  if (cuaBundleDigest(application) !== receipt.bundle) throw fail(`helper 内容与 receipt 摘要不一致 ${application}`)
  const architectures = runChecked(run, '/usr/bin/lipo', ['-archs', executable], '架构验证').stdout.trim().split(/\s+/u)
  if (architectures.length !== 1 || architectures[0] !== expectedArchitecture) {
    throw fail(`helper 架构为 ${architectures.join(', ')}，需要 ${expectedArchitecture}`)
  }
  runChecked(run, '/usr/bin/codesign', ['--verify', '--strict', application], '签名验证')
  return { application, executable, digest: receipt.bundle }
}

/** Build the official release helper into the copied runtime package, never the upstream checkout. */
export function stageCuaHelper({
  packageRoot,
  targetPlatform,
  targetArch,
  scratchPath,
  hostPlatform = process.platform,
  signingIdentity = process.env.LUMO_CUA_SIGNING_IDENTITY ?? '-',
  signingKeychain = process.env.LUMO_CUA_SIGNING_KEYCHAIN,
  run = spawnSync,
}) {
  if (targetPlatform !== 'darwin') return { available: false, reason: 'macOS-only' }
  const architecture = checkArchitecture(targetArch)
  if (hostPlatform !== 'darwin') throw fail('macOS helper 必须在 macOS 构建机上编译')
  if (typeof packageRoot !== 'string') throw fail(`runtime 缺少 ${cuaProviderPackage}`)
  regularFile(join(packageRoot, 'package.json'))
  if (JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).name !== cuaProviderPackage) {
    throw fail(`不是 ${cuaProviderPackage} 包：${packageRoot}`)
  }
  const nativeRoot = join(packageRoot, 'native')
  const builder = join(nativeRoot, 'build_app.py')
  regularFile(builder)
  if (typeof scratchPath !== 'string' || !isAbsolute(scratchPath)) throw fail('scratchPath 必须为独立的绝对路径')
  const scratchRelative = relative(resolve(packageRoot), resolve(scratchPath))
  if (scratchRelative === '' || (!scratchRelative.startsWith(`..${sep}`) && scratchRelative !== '..' && !isAbsolute(scratchRelative))) {
    throw fail('Swift scratchPath 不能位于 runtime 包内')
  }
  if (typeof signingIdentity !== 'string' || signingIdentity.trim() !== signingIdentity || signingIdentity.length === 0
    || (signingIdentity.startsWith('-') && signingIdentity !== '-')) throw fail('无效的签名 identity')
  if (signingKeychain !== undefined && (typeof signingKeychain !== 'string' || !isAbsolute(signingKeychain) || signingIdentity === '-')) {
    throw fail('签名 keychain 必须为绝对路径，且需要非 ad-hoc identity')
  }
  // Source packages can contain ignored development builds from another host.
  // Only this target's freshly signed, complete release bundle may enter the app.
  rmSync(join(nativeRoot, '.build'), { recursive: true, force: true })
  rmSync(join(nativeRoot, 'bin'), { recursive: true, force: true })
  mkdirSync(scratchPath, { recursive: true })
  const directory = join(nativeRoot, 'bin', `darwin-${targetArch}`)
  const args = ['python3', builder, '--scratch-path', scratchPath, '--output-directory', directory,
    '--arch', architecture, '--variant', 'release', '--identity', signingIdentity]
  if (signingKeychain !== undefined) args.push('--keychain', signingKeychain)
  runChecked(run, '/usr/bin/xcrun', args, '官方 helper 编译', { cwd: packageRoot, stdio: 'inherit' })
  const verified = verifyCuaHelper({ packageRoot, targetArch, run })
  // Receipts and manifest paths remain valid when the enclosing .app moves.
  return {
    available: true,
    provider: cuaProviderPackage,
    target: `darwin-${targetArch}`,
    variant: 'release',
    signing: signingIdentity === '-' ? 'ad-hoc' : 'certificate',
    digest: verified.digest,
    executable: relative(packageRoot, verified.executable).split(sep).join('/'),
  }
}

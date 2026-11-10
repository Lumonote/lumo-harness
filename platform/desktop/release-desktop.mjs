import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { verifyCuaHelper, cuaProviderPackage } from './cua-helper.mjs'
import { measureRuntime, enforceRuntimeBudget } from './runtime-size.mjs'

const desktop = dirname(fileURLToPath(import.meta.url))
const identityName = /^Developer ID Application: .+ \(([A-Z0-9]{10})\)$/u
const safe = (value, name) => { if (typeof value !== 'string' || !value.trim() || value.trim() !== value || /[\r\n\0]/u.test(value)) throw Error(`缺少或无效的 ${name}`); return value }
function checked(run, command, args, { secret = false, ...options } = {}) {
  const result = run(command, args, { encoding: 'utf8', ...options })
  if (result.error || result.status !== 0) throw Error(`${command} 执行失败${secret ? '（请检查签名/公证凭据与服务回执）' : `：${result.stderr || result.error?.message || result.status}`}`)
  return result
}

/** Credentials stay in the existing unlocked Keychain; never accept passwords on argv. */
export function releaseConfiguration(env = process.env, platform = process.platform) {
  if (platform === 'darwin') {
    const identity = safe(env.LUMO_MACOS_SIGNING_IDENTITY, 'LUMO_MACOS_SIGNING_IDENTITY')
    const match = identity.match(identityName)
    if (!match) throw Error('正式 Mac 发布必须使用 Developer ID Application identity（包含 Team ID）')
    const profile = safe(env.LUMO_MACOS_NOTARY_PROFILE, 'LUMO_MACOS_NOTARY_PROFILE')
    if (env.LUMO_CUA_SIGNING_IDENTITY !== identity) throw Error('LUMO_CUA_SIGNING_IDENTITY 必须与正式发布 identity 相同；请在构建 runtime 前设置')
    const keychain = env.LUMO_MACOS_SIGNING_KEYCHAIN
    if (keychain !== undefined && (!isAbsolute(keychain) || !existsSync(keychain))) throw Error('LUMO_MACOS_SIGNING_KEYCHAIN 必须指向已有 keychain 的绝对路径')
    return { platform, identity, team: match[1], profile, keychain }
  }
  if (platform === 'win32') {
    const thumbprint = safe(env.LUMO_WINDOWS_CERT_THUMBPRINT, 'LUMO_WINDOWS_CERT_THUMBPRINT')
    if (!/^[a-f0-9]{40}$/iu.test(thumbprint)) throw Error('Windows 签名证书 thumbprint 必须为 40 位十六进制')
    const timestamp = safe(env.LUMO_WINDOWS_TIMESTAMP_URL, 'LUMO_WINDOWS_TIMESTAMP_URL')
    const parsed = new URL(timestamp)
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw Error('Windows timestamp 必须是无凭据的 HTTP(S) URL')
    const tool = env.LUMO_WINDOWS_SIGNTOOL ?? 'signtool.exe'
    return { platform, thumbprint, timestamp, tool }
  }
  throw Error('正式桌面发布仅支持 macOS 或 Windows 构建机')
}

export function preflightRelease({ env = process.env, platform = process.platform, run = spawnSync } = {}) {
  const config = releaseConfiguration(env, platform)
  if (platform === 'darwin') {
    const args = ['find-identity', '-v', '-p', 'codesigning', ...(config.keychain ? [config.keychain] : [])]
    const identities = checked(run, '/usr/bin/security', args, { secret: true }).stdout ?? ''
    if (!identities.includes(`"${config.identity}"`)) throw Error('Developer ID 签名 identity 不在当前可用 keychain 中')
    checked(run, '/usr/bin/xcrun', ['notarytool', 'history', '--keychain-profile', config.profile, ...(config.keychain ? ['--keychain', config.keychain] : []), '--output-format', 'json'], { secret: true })
  } else {
    checked(run, config.tool, ['verify', '/?'])
    checked(run, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', [
      "$ErrorActionPreference='Stop'",
      "$certificate=Get-Item ('Cert:\\CurrentUser\\My\\'+$env:LUMO_RELEASE_CERT_CHECK)",
      "if(-not $certificate.HasPrivateKey -or $certificate.NotAfter -le (Get-Date) -or $certificate.NotBefore -gt (Get-Date)){throw 'Signing certificate is expired or has no private key'}",
      "if(-not ($certificate.EnhancedKeyUsageList.ObjectId -contains '1.3.6.1.5.5.7.3.3')){throw 'Certificate is not enabled for code signing'}",
    ].join('; ')], { secret: true, env: { ...process.env, LUMO_RELEASE_CERT_CHECK: config.thumbprint } })
  }
  return config
}

function macho(path) {
  const fd = openSync(path, 'r'); const header = Buffer.alloc(32)
  try { readSync(fd, header, 0, 32, 0) } finally { closeSync(fd) }
  const magic = header.subarray(0, 4).toString('hex')
  // cafebabe also identifies Java class files. Fat Mach-O starts with a small
  // architecture count, while Java stores minor/major version in these bytes.
  if (['cafebabe', 'cafebabf'].includes(magic)) return header.readUInt32BE(4) > 0 && header.readUInt32BE(4) < 32
  if (['bebafeca', 'bfbafeca'].includes(magic)) return header.readUInt32LE(4) > 0 && header.readUInt32LE(4) < 32
  return ['cefaedfe', 'cffaedfe', 'feedface', 'feedfacf'].includes(magic)
}
function hash(path) { return createHash('sha256').update(readFileSync(path)).digest('hex') }

/** Select build output policy without changing the strict signed-only API below. */
export function installerSigningMode(env = process.env) {
  const required = env.LUMO_RELEASE_SIGNING_REQUIRED, mode = env.LUMO_RELEASE_SIGNING_MODE
  if (required !== undefined && !['0', '1'].includes(required)) throw Error('LUMO_RELEASE_SIGNING_REQUIRED 必须为 0 或 1')
  if (mode !== undefined && !['signed', 'unsigned'].includes(mode)) throw Error('LUMO_RELEASE_SIGNING_MODE 必须为 signed 或 unsigned')
  const selected = required === undefined ? mode ?? 'unsigned' : required === '1' ? 'signed' : 'unsigned'
  if (mode !== undefined && mode !== selected) throw Error('发行签名模式与 LUMO_RELEASE_SIGNING_REQUIRED 冲突')
  return selected
}

export function loadInstallerRuntimeReport({ root = desktop, platform = process.platform, mode = installerSigningMode() } = {}) {
  const manifest = JSON.parse(readFileSync(join(root, 'lumo-runtime/runtime-manifest.json'), 'utf8'))
  const report = platform === 'darwin' && mode === 'signed'
    ? JSON.parse(readFileSync(join(root, 'target/release/release-evidence', `${manifest.target}.json`), 'utf8')).runtimeSize
    : JSON.parse(readFileSync(join(root, 'target/runtime-size', `${manifest.target}.json`), 'utf8'))
  const targets = platform === 'darwin' ? ['darwin-arm64', 'darwin-x64'] : platform === 'win32' ? ['win-x64'] : []
  if (!report || !targets.includes(manifest.target) || report.target !== manifest.target || report.version !== manifest.version) throw Error('安装包与 runtime 尺寸证据版本或目标不一致')
  return report
}

function writeInstallerEvidence(artifact, { receipt, runtimeReport, signing, notarization }) {
  const result = { schemaVersion: 1, artifact: artifact.split(/[\\/]/u).at(-1), bytes: lstatSync(artifact).size, sha256: hash(artifact), receipt, signing,
    ...(notarization ? { notarization } : {}),
    ...(runtimeReport ? { target: runtimeReport.target, version: runtimeReport.version, runtime: runtimeReport.total, sourceRevision: runtimeReport.sourceRevision, upstreamRevision: runtimeReport.upstreamRevision } : {}) }
  writeFileSync(`${artifact}.release.json`, `${JSON.stringify(result, null, 2)}\n`)
  return result
}

/** No distribution certificate is claimed; macOS application ad-hoc signatures remain intact. */
export function recordUnsignedInstaller(artifact, { platform = process.platform, runtimeReport } = {}) {
  const extension = platform === 'darwin' ? '.dmg' : platform === 'win32' ? '.exe' : null
  if (!extension || extname(artifact) !== extension || !lstatSync(artifact).isFile()) throw Error('需要当前平台的现有安装包文件')
  const targets = platform === 'darwin' ? ['darwin-arm64', 'darwin-x64'] : ['win-x64']
  if (!runtimeReport || !targets.includes(runtimeReport.target) || typeof runtimeReport.version !== 'string' || !runtimeReport.version.trim()
    || !Number.isSafeInteger(runtimeReport.total?.contentBytes) || runtimeReport.total.contentBytes < 0
    || !Number.isSafeInteger(runtimeReport.total?.fileCount) || runtimeReport.total.fileCount < 0
    || ![runtimeReport.sourceRevision, runtimeReport.upstreamRevision].every(value => typeof value === 'string' && /^[a-f0-9]{40}$/u.test(value))) throw Error('无证书安装包必须保留有效的 runtime 与源码身份报告')
  const destination = artifact.endsWith(`-unsigned${extension}`) ? artifact : `${artifact.slice(0, -extension.length)}-unsigned${extension}`
  if (destination !== artifact) {
    if (existsSync(destination) || existsSync(`${artifact}.release.json`)) throw Error('无证书安装包目标或旧发行证据已存在；请清理旧构建产物')
    renameSync(artifact, destination)
  }
  return writeInstallerEvidence(destination, { receipt: { status: 'unsigned' }, signing: { status: 'unsigned', certificate: false },
    ...(platform === 'darwin' ? { notarization: { status: 'not-performed' } } : {}), runtimeReport })
}

export function finalizeBuiltInstaller(artifact, { env = process.env, ...options } = {}) {
  return installerSigningMode(env) === 'signed'
    ? finalizeInstaller(artifact, { ...options, env })
    : recordUnsignedInstaller(artifact, options)
}

/** Sign nested code explicitly, preserving the official content-addressed helper.
 * The helper is signed by its own builder before its receipt is frozen. Re-signing
 * or stapling that nested bundle here would invalidate that immutable receipt.
 */
export function signMacApplication(application, config, { run = spawnSync } = {}) {
  const app = realpathSync(resolve(application))
  if (!lstatSync(app).isDirectory() || !app.endsWith('.app')) throw Error('需要现有的 .app 安装目录')
  const runtime = join(app, 'Contents/Resources/runtime')
  const manifestPath = join(runtime, 'runtime-manifest.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (!['darwin-arm64', 'darwin-x64'].includes(manifest.target) || manifest.computerUse?.signing !== 'certificate') throw Error('正式包必须包含由证书签名的目标 CUA helper')
  const helperRoot = join(runtime, 'node_modules', cuaProviderPackage)
  const helper = verifyCuaHelper({ packageRoot: helperRoot, targetArch: manifest.target.slice(7), run })
  const signature = checked(run, '/usr/bin/codesign', ['-d', '--verbose=4', helper.application])
  const signatureText = signature.stderr ?? ''
  if (!signatureText.split(/\r?\n/u).includes(`TeamIdentifier=${config.team}`)
    || !signatureText.split(/\r?\n/u).includes(`Authority=${config.identity}`)
    || !/flags=.*\bruntime\b/u.test(signatureText) || !/^Timestamp=(?!none\s*$)\S.+$/mu.test(signatureText)) throw Error('CUA helper 缺少匹配的 Developer ID、hardened runtime 或可信时间戳')
  const files = []; const bundles = []
  const visit = path => {
    if (path === helper.application) return
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      const rel = relative(app, realpathSync(path))
      if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw Error(`正式应用的符号链接逃出包体：${path}`)
      return
    }
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry))
      if (path !== app && /\.(app|framework|xpc|bundle)$/u.test(path)) bundles.push(path)
    } else if (stat.isFile() && macho(path)) files.push(path)
  }
  visit(app)
  const sign = (path, node = false) => checked(run, '/usr/bin/codesign', ['--force', '--sign', config.identity, '--options', 'runtime', '--timestamp',
    ...(config.keychain ? ['--keychain', config.keychain] : []), ...(node ? ['--entitlements', join(desktop, 'node-entitlements.plist')] : []), path], { secret: true })
  for (const path of files) sign(path, ['node', 'nodejs'].includes(path.split('/').at(-1)))
  for (const path of bundles) sign(path)
  sign(app)
  checked(run, '/usr/bin/codesign', ['--verify', '--deep', '--strict', app])
  const stillValid = verifyCuaHelper({ packageRoot: helperRoot, targetArch: manifest.target.slice(7), run })
  if (stillValid.digest !== helper.digest) throw Error('正式签名改变了 CUA helper 的不可变内容')
  return { runtime, manifest, helperDigest: helper.digest, signedMachOCount: files.length }
}

export function notarizeArtifact(artifact, config, { run = spawnSync, stapleTarget = artifact } = {}) {
  const submitted = checked(run, '/usr/bin/xcrun', ['notarytool', 'submit', artifact, '--wait', '--keychain-profile', config.profile,
    ...(config.keychain ? ['--keychain', config.keychain] : []), '--output-format', 'json'], { secret: true })
  let receipt
  try { receipt = JSON.parse(submitted.stdout) } catch { throw Error('公证回执不是有效 JSON') }
  if (receipt.status !== 'Accepted' || typeof receipt.id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(receipt.id)) throw Error('Apple 公证未明确 Accepted；禁止发布该安装包')
  checked(run, '/usr/bin/xcrun', ['stapler', 'staple', stapleTarget])
  checked(run, '/usr/bin/xcrun', ['stapler', 'validate', stapleTarget])
  return { id: receipt.id, status: receipt.status }
}

export function finalizeMacRelease(application, { env = process.env, run = spawnSync, outputDirectory = join(desktop, 'target/release/release-evidence') } = {}) {
  const config = preflightRelease({ env, platform: 'darwin', run })
  const signed = signMacApplication(application, config, { run })
  mkdirSync(outputDirectory, { recursive: true })
  const zip = join(outputDirectory, 'notarization-upload.zip')
  try {
    checked(run, '/usr/bin/ditto', ['-c', '-k', '--keepParent', application, zip])
    // ZIPs cannot be stapled: notarize the archive, staple its original .app.
    const appReceipt = notarizeArtifact(zip, config, { run, stapleTarget: application })
    checked(run, '/usr/bin/codesign', ['--verify', '--deep', '--strict', application])
    checked(run, '/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose=2', application])
    const original = JSON.parse(readFileSync(join(desktop, 'target/runtime-size', `${signed.manifest.target}.json`), 'utf8'))
    if (original.target !== signed.manifest.target || original.version !== signed.manifest.version) throw Error('已签名应用与构建尺寸报告版本不一致')
    const report = measureRuntime(signed.runtime, { target: signed.manifest.target, version: signed.manifest.version, sourceRevision: original.sourceRevision, upstreamRevision: original.upstreamRevision })
    enforceRuntimeBudget(report, JSON.parse(readFileSync(env.LUMO_RUNTIME_SIZE_BUDGET ?? join(desktop, 'runtime-size-budgets.json'), 'utf8')),
      env.LUMO_RUNTIME_SIZE_BASELINE ? JSON.parse(readFileSync(env.LUMO_RUNTIME_SIZE_BASELINE, 'utf8')) : undefined)
    const evidence = { schemaVersion: 1, target: report.target, version: report.version, team: config.team, helperDigest: signed.helperDigest,
      signedMachOCount: signed.signedMachOCount, notarization: appReceipt, runtimeSize: report, generatedAt: new Date().toISOString() }
    writeFileSync(join(outputDirectory, `${report.target}.json`), `${JSON.stringify(evidence, null, 2)}\n`)
    return evidence
  } finally { rmSync(zip, { force: true }) }
}

export function finalizeInstaller(artifact, { env = process.env, platform = process.platform, run = spawnSync, runtimeReport } = {}) {
  const config = preflightRelease({ env, platform, run })
  if (!lstatSync(artifact).isFile()) throw Error('需要现有的安装包文件')
  let receipt
  if (platform === 'darwin') {
    if (!artifact.endsWith('.dmg')) throw Error('Mac 安装包必须为 .dmg')
    checked(run, '/usr/bin/codesign', ['--force', '--sign', config.identity, '--timestamp', ...(config.keychain ? ['--keychain', config.keychain] : []), artifact], { secret: true })
    receipt = notarizeArtifact(artifact, config, { run })
    checked(run, '/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', artifact])
  } else {
    if (!artifact.endsWith('.exe')) throw Error('Windows 安装包必须为 .exe')
    checked(run, config.tool, ['sign', '/sha1', config.thumbprint, '/fd', 'SHA256', '/tr', config.timestamp, '/td', 'SHA256', artifact], { secret: true })
    checked(run, config.tool, ['verify', '/pa', '/all', '/v', artifact])
    receipt = { status: 'signed', thumbprint: config.thumbprint }
  }
  return writeInstallerEvidence(artifact, { receipt, runtimeReport, signing: { status: 'signed', certificate: true },
    ...(platform === 'darwin' ? { notarization: receipt } : {}) })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [action, artifact] = process.argv.slice(2)
    if (action === 'mode') console.log(installerSigningMode())
    else if (action === 'preflight') preflightRelease()
    else if (action === 'app' && artifact && process.platform === 'darwin') finalizeMacRelease(resolve(artifact))
    else if (action === 'installer' && artifact) {
      const mode = installerSigningMode()
      const report = loadInstallerRuntimeReport({ mode })
      finalizeBuiltInstaller(resolve(artifact), { runtimeReport: report })
    }
    else throw Error('用法：node release-desktop.mjs mode | preflight | app APPLICATION.app | installer INSTALLER.dmg/exe')
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}

import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { finalizeBuiltInstaller, finalizeInstaller, installerSigningMode, loadInstallerRuntimeReport, notarizeArtifact, preflightRelease, recordUnsignedInstaller, releaseConfiguration, signMacApplication } from '../release-desktop.mjs'
import { cuaBundleDigest, cuaProviderPackage } from '../cua-helper.mjs'
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const identity = 'Developer ID Application: Lumo (&) (ABCDE12345)'
const env = { LUMO_MACOS_SIGNING_IDENTITY: identity, LUMO_CUA_SIGNING_IDENTITY: identity, LUMO_MACOS_NOTARY_PROFILE: 'release (&) profile' }
const unsignedReport = (target = 'darwin-arm64') => ({ target, version: '1.2.1', total: { contentBytes: 123, fileCount: 4 }, sourceRevision: 'a'.repeat(40), upstreamRevision: 'b'.repeat(40) })
describe('formal desktop release boundary', () => {
  it.skipIf(process.platform === 'win32')('signs native payloads from inside out without mutating the content-addressed helper or Java resources', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo signed app ')); roots.push(root)
    const application = join(realpathSync(root), 'Lumo.app'), runtime = join(application, 'Contents/Resources/runtime')
    const helperBase = join(runtime, 'node_modules', cuaProviderPackage, 'native/bin/darwin-arm64')
    const staged = join(helperBase, 'staged/DSH Computer Use.app')
    const write = (path: string, body: string | Buffer) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, body) }
    write(join(staged, 'Contents/Info.plist'), '<plist/>')
    for (const name of ['DSHComputerUse.icns', 'LICENSE.computer-use-icon', 'LICENSE.cua-driver']) write(join(staged, 'Contents/Resources', name), name)
    write(join(staged, 'Contents/MacOS/dsh-cua-native'), '#!/bin/sh\n'); chmodSync(join(staged, 'Contents/MacOS/dsh-cua-native'), 0o755)
    const digest = cuaBundleDigest(staged), helper = join(helperBase, digest, 'DSH Computer Use.app')
    mkdirSync(join(helper, '..'), { recursive: true }); renameSync(staged, helper)
    writeFileSync(join(helperBase, 'current.json'), JSON.stringify({ bundle: digest }))
    write(join(runtime, 'runtime-manifest.json'), JSON.stringify({ target: 'darwin-arm64', version: '1', computerUse: { signing: 'certificate' } }))
    write(join(runtime, 'node'), Buffer.from('cffaedfe00000000000000000000000000000000000000000000000000000000', 'hex'))
    write(join(runtime, 'java.class'), Buffer.from('cafebabe00000037000100000000000000000000000000000000000000000000', 'hex'))
    const validSignature = `Authority=${identity}\nTeamIdentifier=ABCDE12345\nflags=0x10000(runtime)\nTimestamp=Nov 9, 2026\n`
    let helperSignature = validSignature
    const run = vi.fn((command: string, args: string[]) => ({ status: 0, stdout: command.endsWith('lipo') ? 'arm64\n' : '',
      stderr: args[0] === '-d' ? helperSignature : '' }))
    const result = signMacApplication(application, releaseConfiguration(env, 'darwin'), { run })
    expect(result.helperDigest).toBe(digest)
    const signed = run.mock.calls.filter(([, args]) => args.includes('--sign')).map(([, args]) => args.at(-1))
    expect(signed).toEqual([join(runtime, 'node'), application])
    expect(run.mock.calls.find(([, args]) => args.at(-1) === join(runtime, 'node'))?.[1]).toContain('--entitlements')
    expect(cuaBundleDigest(helper)).toBe(digest)
    // An intact receipt and successful codesign verification alone cannot make
    // an ad-hoc, differently owned or non-notarizable helper a formal release.
    for (const invalidSignature of [
      validSignature.replace(identity, 'Developer ID Application: Other (ABCDE12345)'),
      validSignature.replace('TeamIdentifier=ABCDE12345', 'TeamIdentifier=OTHER12345'),
      validSignature.replace('flags=0x10000(runtime)', 'flags=0x0(none)'),
      validSignature.replace('Timestamp=Nov 9, 2026\n', ''),
      validSignature.replace('Timestamp=Nov 9, 2026', 'Timestamp=none'),
    ]) {
      helperSignature = invalidSignature; run.mockClear()
      expect(() => signMacApplication(application, releaseConfiguration(env, 'darwin'), { run })).toThrow(/CUA helper/)
      expect(run.mock.calls.filter(([, args]) => args.includes('--sign'))).toHaveLength(0)
    }
  })
  it('fails before invoking tools for missing credentials or an ad-hoc/mismatched helper identity', () => {
    const run = vi.fn()
    expect(() => preflightRelease({ env: {}, platform: 'darwin', run })).toThrow(/LUMO_MACOS_SIGNING_IDENTITY/)
    expect(() => preflightRelease({ env: { ...env, LUMO_MACOS_SIGNING_IDENTITY: '-' }, platform: 'darwin', run })).toThrow(/Developer ID/)
    expect(() => preflightRelease({ env: { ...env, LUMO_CUA_SIGNING_IDENTITY: '-' }, platform: 'darwin', run })).toThrow(/必须与/)
    expect(run).not.toHaveBeenCalled()
  })
  it('checks existing keychain identities and validates notary credentials without exposing secrets or shell expansion', () => {
    const run = vi.fn().mockReturnValueOnce({ status: 0, stdout: `1) HASH "${identity}"\n` }).mockReturnValueOnce({ status: 0, stdout: '{}' })
    const config = preflightRelease({ env, platform: 'darwin', run })
    expect(config.team).toBe('ABCDE12345')
    expect(run.mock.calls[1][1]).toContain('release (&) profile')
    expect(run.mock.calls[1][2]).not.toHaveProperty('shell')
    expect(() => preflightRelease({ env, platform: 'darwin', run: () => ({ status: 1, stderr: 'PRIVATE CREDENTIAL' }) })).toThrow(/检查签名/)
    try { preflightRelease({ env, platform: 'darwin', run: () => ({ status: 1, stderr: 'PRIVATE CREDENTIAL' }) }) } catch (error) { expect(String(error)).not.toContain('PRIVATE CREDENTIAL') }
  })
  it.each(['Invalid', 'In Progress', undefined])('rejects a successful CLI exit without Accepted notarization: %s', status => {
    const run = vi.fn(() => ({ status: 0, stdout: JSON.stringify({ id: '12345678-1234-1234-1234-123456789abc', status }) }))
    expect(() => notarizeArtifact('/tmp/App (&).dmg', releaseConfiguration(env, 'darwin'), { run })).toThrow(/未明确 Accepted/)
    expect(run).toHaveBeenCalledTimes(1)
  })
  it('staples and validates only an explicitly accepted artifact, retaining its final hash and size', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo release ')); roots.push(root); const artifact = join(root, 'App (&).dmg'); writeFileSync(artifact, 'installer')
    const run = vi.fn((command: string, args: string[]) => ({ status: 0, stdout: command.endsWith('security') ? `"${identity}"` : args[0] === 'notarytool' && args[1] === 'submit' ? JSON.stringify({ id: '12345678-1234-1234-1234-123456789abc', status: 'Accepted' }) : '{}' }))
    const result = finalizeInstaller(artifact, { env, platform: 'darwin', run })
    expect(result.bytes).toBe(9); expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.parse(readFileSync(`${artifact}.release.json`, 'utf8')).receipt.status).toBe('Accepted')
    expect(result.signing).toEqual({ status: 'signed', certificate: true })
    expect(run.mock.calls.some(([, args]) => args.join(' ') === `stapler validate ${artifact}`)).toBe(true)
  })
  it('requires an existing-store Windows certificate and validates the signed installer', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo win release ')); roots.push(root); const artifact = join(root, 'App.exe'); writeFileSync(artifact, 'installer')
    const run = vi.fn(() => ({ status: 0, stdout: '' }))
    const win = { LUMO_WINDOWS_CERT_THUMBPRINT: 'a'.repeat(40), LUMO_WINDOWS_TIMESTAMP_URL: 'https://timestamp.example.test' }
    expect(finalizeInstaller(artifact, { env: win, platform: 'win32', run }).receipt.status).toBe('signed')
    expect(run.mock.calls.map(([, args]) => args[0])).toEqual(['verify', '-NoProfile', 'sign', 'verify'])
    expect(() => releaseConfiguration({ ...win, LUMO_WINDOWS_TIMESTAMP_URL: 'https://user:secret@timestamp.example.test' }, 'win32')).toThrow(/无凭据/)
  })
})

describe('desktop installers without distribution certificates', () => {
  it.each([
    ['darwin', '.dmg', 'darwin-arm64'], ['win32', '.exe', 'win-x64'],
  ])('records the actual %s installer and source identity without invoking signing tools', (platform, extension, target) => {
    const root = mkdtempSync(join(tmpdir(), 'lumo unsigned ')); roots.push(root)
    const artifact = join(root, `App (&)${extension}`), body = Buffer.from('actual installer bytes')
    writeFileSync(artifact, body)
    const run = vi.fn(() => { throw Error('A signing tool must not run') })
    const report = unsignedReport(target)
    const result = finalizeBuiltInstaller(artifact, { env: { LUMO_RELEASE_SIGNING_MODE: 'unsigned', LUMO_RELEASE_SIGNING_REQUIRED: '0' }, platform, run, runtimeReport: report })
    const output = join(root, `App (&)-unsigned${extension}`)
    expect(existsSync(artifact)).toBe(false)
    expect(readFileSync(output)).toEqual(body)
    expect(result).toMatchObject({ artifact: `App (&)-unsigned${extension}`, bytes: body.length,
      sha256: createHash('sha256').update(body).digest('hex'), receipt: { status: 'unsigned' }, signing: { status: 'unsigned', certificate: false },
      target, version: report.version, runtime: report.total, sourceRevision: report.sourceRevision, upstreamRevision: report.upstreamRevision })
    expect(JSON.parse(readFileSync(`${output}.release.json`, 'utf8'))).toEqual(result)
    if (platform === 'darwin') expect(result.notarization).toEqual({ status: 'not-performed' })
    expect(JSON.stringify(result)).not.toContain('Accepted')
    expect(run).not.toHaveBeenCalled()
  })

  it('requires runtime measurements and source identities before renaming an unsigned artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo unsigned invalid ')); roots.push(root)
    const artifact = join(root, 'App.dmg'); writeFileSync(artifact, 'installer')
    for (const runtimeReport of [undefined, { ...unsignedReport(), target: 'win-x64' }, { ...unsignedReport(), sourceRevision: null },
      { ...unsignedReport(), total: { contentBytes: -1, fileCount: 4 } }]) {
      expect(() => recordUnsignedInstaller(artifact, { platform: 'darwin', runtimeReport })).toThrow(/runtime/)
      expect(existsSync(artifact)).toBe(true)
    }
    writeFileSync(join(root, 'App-unsigned.dmg'), 'previous build')
    expect(() => recordUnsignedInstaller(artifact, { platform: 'darwin', runtimeReport: unsignedReport() })).toThrow(/旧构建/)
    expect(readFileSync(join(root, 'App-unsigned.dmg'), 'utf8')).toBe('previous build')
  })

  it('retains the strict signed API and rejects conflicting mode selections', () => {
    const run = vi.fn()
    expect(() => finalizeInstaller('/tmp/no-installer.dmg', { env: {}, platform: 'darwin', run })).toThrow(/LUMO_MACOS_SIGNING_IDENTITY/)
    expect(() => finalizeBuiltInstaller('/tmp/no-installer.dmg', { env: { LUMO_RELEASE_SIGNING_REQUIRED: '1' }, platform: 'darwin', run })).toThrow(/LUMO_MACOS_SIGNING_IDENTITY/)
    expect(installerSigningMode({})).toBe('unsigned')
    expect(installerSigningMode({ LUMO_RELEASE_SIGNING_REQUIRED: '1' })).toBe('signed')
    for (const selection of [
      { LUMO_RELEASE_SIGNING_REQUIRED: '1', LUMO_RELEASE_SIGNING_MODE: 'unsigned' },
      { LUMO_RELEASE_SIGNING_REQUIRED: '0', LUMO_RELEASE_SIGNING_MODE: 'signed' },
      { LUMO_RELEASE_SIGNING_REQUIRED: 'maybe' }, { LUMO_RELEASE_SIGNING_MODE: 'auto' },
    ]) expect(() => installerSigningMode(selection)).toThrow()
    expect(run).not.toHaveBeenCalled()
  })

  it('loads unsigned measurements directly and signed Mac measurements from the post-signing evidence', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo installer report ')); roots.push(root)
    mkdirSync(join(root, 'lumo-runtime'), { recursive: true }); mkdirSync(join(root, 'target/runtime-size'), { recursive: true })
    mkdirSync(join(root, 'target/release/release-evidence'), { recursive: true })
    writeFileSync(join(root, 'lumo-runtime/runtime-manifest.json'), JSON.stringify({ target: 'darwin-arm64', version: '1.2.1' }))
    const unsigned = unsignedReport(), signed = { ...unsigned, total: { contentBytes: 140, fileCount: 4 } }
    writeFileSync(join(root, 'target/runtime-size/darwin-arm64.json'), JSON.stringify(unsigned))
    writeFileSync(join(root, 'target/release/release-evidence/darwin-arm64.json'), JSON.stringify({ runtimeSize: signed }))
    expect(loadInstallerRuntimeReport({ root, platform: 'darwin', mode: 'unsigned' })).toEqual(unsigned)
    expect(loadInstallerRuntimeReport({ root, platform: 'darwin', mode: 'signed' })).toEqual(signed)
    writeFileSync(join(root, 'target/runtime-size/darwin-arm64.json'), JSON.stringify({ ...unsigned, version: 'old' }))
    expect(() => loadInstallerRuntimeReport({ root, platform: 'darwin', mode: 'unsigned' })).toThrow(/版本或目标/)
  })

  it.skipIf(process.platform === 'win32')('builds an unsigned DMG through the real script from another working directory and writes matching evidence', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo dmg (&) '))); roots.push(root)
    const bin = join(root, 'tools'), app = join(root, 'target/release/bundle/macos/DeepSeek Harness.app')
    mkdirSync(bin); mkdirSync(app, { recursive: true }); writeFileSync(join(app, 'payload.txt'), 'app')
    for (const name of ['make-dmg.sh', 'release-desktop.mjs', 'cua-helper.mjs', 'runtime-size.mjs']) copyFileSync(fileURLToPath(new URL(`../${name}`, import.meta.url)), join(root, name))
    writeFileSync(join(root, 'tauri.conf.json'), '{\n  "version": "1.2.1"\n}\n')
    mkdirSync(join(root, 'lumo-runtime'), { recursive: true }); mkdirSync(join(root, 'target/runtime-size'), { recursive: true })
    writeFileSync(join(root, 'lumo-runtime/runtime-manifest.json'), JSON.stringify({ target: 'darwin-arm64', version: '1.2.1' }))
    writeFileSync(join(root, 'target/runtime-size/darwin-arm64.json'), JSON.stringify(unsignedReport()))
    writeFileSync(join(root, 'darwin-fixture.mjs'), "Object.defineProperty(process, 'platform', { value: 'darwin' })\n")
    writeFileSync(join(bin, 'node'), `#!${process.execPath}\nconst { spawnSync } = require('node:child_process');\nconst result = spawnSync(process.execPath, ['--import', ${JSON.stringify(join(root, 'darwin-fixture.mjs'))}, ...process.argv.slice(2)], { stdio: 'inherit' });\nprocess.exit(result.status ?? 1);\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'cp'), `#!${process.execPath}\nrequire('node:fs').cpSync(process.argv.at(-2), process.argv.at(-1), { recursive: true });\n`, { mode: 0o755 })
    writeFileSync(join(bin, 'uname'), '#!/bin/sh\nprintf "arm64\\n"\n', { mode: 0o755 })
    writeFileSync(join(bin, 'hdiutil'), '#!/bin/sh\nfor artifact do :; done\nprintf "disk image fixture" > "$artifact"\n', { mode: 0o755 })
    const result = spawnSync('bash', [join(root, 'make-dmg.sh')], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      LUMO_RELEASE_SIGNING_REQUIRED: '0', LUMO_RELEASE_SIGNING_MODE: 'unsigned' } })
    expect(result.status, result.stderr).toBe(0)
    const artifact = join(root, 'target/release/bundle/dmg/DeepSeek-Harness_1.2.1_aarch64-unsigned.dmg')
    const evidence = JSON.parse(readFileSync(`${artifact}.release.json`, 'utf8'))
    expect(evidence.artifact).toBe('DeepSeek-Harness_1.2.1_aarch64-unsigned.dmg')
    expect(evidence.bytes).toBe(readFileSync(artifact).length)
    expect(evidence.notarization.status).toBe('not-performed')
  })
})

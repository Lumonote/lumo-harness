import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cuaBundleDigest, cuaProviderPackage, stageCuaHelper, verifyCuaHelper } from '../cua-helper.mjs'
import { copyRuntimePackage } from '../runtime-dependencies.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function write(root: string, path: string, value: string) {
  const target = join(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, value)
}
function publish(packageRoot: string, arch: string) {
  const directory = join(packageRoot, 'native/bin', `darwin-${arch}`)
  const temporary = join(directory, 'preparing', 'DSH Computer Use.app')
  write(temporary, 'Contents/MacOS/dsh-cua-native', '#!/bin/sh\nexit 0\n')
  chmodSync(join(temporary, 'Contents/MacOS/dsh-cua-native'), 0o755)
  write(temporary, 'Contents/Info.plist', '<plist>release</plist>')
  for (const file of ['DSHComputerUse.icns', 'LICENSE.computer-use-icon', 'LICENSE.cua-driver']) {
    write(temporary, `Contents/Resources/${file}`, file)
  }
  const digest = cuaBundleDigest(temporary)
  const application = join(directory, digest, 'DSH Computer Use.app')
  mkdirSync(dirname(application), { recursive: true })
  renameSync(temporary, application)
  rmSync(join(directory, 'preparing'), { recursive: true })
  writeFileSync(join(directory, 'current.json'), JSON.stringify({ bundle: digest }))
  return { application, directory, digest }
}

function fixture(arch = 'arm64') {
  const root = mkdtempSync(join(tmpdir(), 'lumo CUA (&) '))
  roots.push(root)
  const packageRoot = join(root, 'runtime/node_modules', cuaProviderPackage)
  const scratchPath = join(root, 'Swift 缓存')
  write(packageRoot, 'package.json', JSON.stringify({ name: cuaProviderPackage, type: 'module' }))
  write(packageRoot, 'native/build_app.py', '# official builder fixture\n')
  const run = vi.fn((command: string, args: string[], _options: unknown) => {
    if (command === '/usr/bin/xcrun') publish(packageRoot, arch)
    return { status: 0, stdout: command === '/usr/bin/lipo' ? `${arch === 'x64' ? 'x86_64' : arch}\n` : '', stderr: '' }
  })
  const spec = {
    packageRoot, scratchPath, targetPlatform: 'darwin', targetArch: arch, hostPlatform: 'darwin',
    signingIdentity: '-', signingKeychain: undefined, run,
  }
  return { root, packageRoot, run, spec, stage: () => stageCuaHelper(spec) }
}

describe('desktop Computer Use helper', () => {
  it('leaves unsupported hosts without a fake native capability or any build command', () => {
    const run = vi.fn()
    expect(stageCuaHelper({ targetPlatform: 'win32', hostPlatform: 'win32', targetArch: 'x64', run }))
      .toEqual({ available: false, reason: 'macOS-only' })
    expect(run).not.toHaveBeenCalled()
  })
})

// Windows cannot represent macOS executable bits or validate a signed .app.
describe.skipIf(process.platform === 'win32')('macOS Computer Use helper payload', () => {
  it.each(['arm64', 'x64'])('stages an official %s release helper with structured arguments', (arch) => {
    const f = fixture(arch)
    write(f.packageRoot, 'native/.build/old-cache', 'old')
    write(f.packageRoot, 'native/bin/wrong-architecture/stale', 'old')
    const staged = f.stage()
    expect(staged).toMatchObject({ available: true, variant: 'release', signing: 'ad-hoc', target: `darwin-${arch}` })
    expect(staged.digest).toMatch(/^[a-f0-9]{64}$/u)
    expect(staged.executable).toBe(`native/bin/darwin-${arch}/${staged.digest}/DSH Computer Use.app/Contents/MacOS/dsh-cua-native`)
    expect(f.run).toHaveBeenNthCalledWith(1, '/usr/bin/xcrun', [
      'python3', join(f.packageRoot, 'native/build_app.py'), '--scratch-path', f.spec.scratchPath,
      '--output-directory', join(f.packageRoot, 'native/bin', `darwin-${arch}`),
      '--arch', arch === 'x64' ? 'x86_64' : 'arm64', '--variant', 'release', '--identity', '-',
    ], { cwd: f.packageRoot, encoding: 'utf8', stdio: 'inherit' })
    expect(f.run).toHaveBeenLastCalledWith('/usr/bin/codesign', [
      '--verify', '--strict', join(f.packageRoot, 'native/bin', `darwin-${arch}`, staged.digest, 'DSH Computer Use.app'),
    ], { encoding: 'utf8' })
    expect(existsSync(join(f.packageRoot, 'native/.build'))).toBe(false)
    expect(existsSync(join(f.packageRoot, 'native/bin/wrong-architecture'))).toBe(false)
    expect(f.run.mock.calls.map(([command]) => command)).toEqual(['/usr/bin/xcrun', '/usr/bin/lipo', '/usr/bin/codesign'])
  })

  it('passes explicit existing signing credentials without shell expansion', () => {
    const f = fixture()
    const identity = 'Developer ID Application: Team (&)'
    const keychain = join(f.root, '私有 keychain (&).keychain-db')
    expect(stageCuaHelper({ ...f.spec, signingIdentity: identity, signingKeychain: keychain }).signing).toBe('certificate')
    expect(f.run.mock.calls[0][1].slice(-4)).toEqual(['--identity', identity, '--keychain', keychain])
  })

  it('resolves the receipt after relocating the entire runtime package', () => {
    const f = fixture()
    const staged = f.stage()
    const moved = join(f.root, '安装应用 (&)', 'DSH.app', 'runtime', cuaProviderPackage)
    mkdirSync(dirname(moved), { recursive: true })
    renameSync(f.packageRoot, moved)
    const checked = verifyCuaHelper({ packageRoot: moved, targetArch: 'arm64', run: f.run })
    expect(checked.executable).toBe(join(moved, staged.executable))
    expect(checked.digest).toBe(staged.digest)
    expect(readFileSync(checked.executable, 'utf8')).toContain('exit 0')
  })

  it('rejects wrong host, architecture, missing provider or compiler source before invoking a tool', () => {
    const f = fixture()
    expect(() => stageCuaHelper({ ...f.spec, hostPlatform: 'linux' })).toThrow(/macOS 构建机/u)
    expect(() => stageCuaHelper({ ...f.spec, targetArch: 'ia32' })).toThrow(/不支持/u)
    expect(() => stageCuaHelper({ ...f.spec, packageRoot: undefined })).toThrow(/runtime 缺少/u)
    rmSync(join(f.packageRoot, 'native/build_app.py'))
    expect(f.stage).toThrow(/build_app.py/u)
    expect(f.run).not.toHaveBeenCalled()
  })

  it('rejects unsafe signing and compiler-cache configuration before deleting existing output', () => {
    const f = fixture()
    write(f.packageRoot, 'native/bin/keep', 'untouched')
    for (const signingIdentity of ['', ' leading whitespace', '--options']) {
      expect(() => stageCuaHelper({ ...f.spec, signingIdentity })).toThrow(/identity/u)
    }
    expect(() => stageCuaHelper({ ...f.spec, signingKeychain: join(f.root, 'keychain') })).toThrow(/keychain/u)
    expect(() => stageCuaHelper({ ...f.spec, signingIdentity: 'certificate', signingKeychain: 'relative' })).toThrow(/keychain/u)
    expect(() => stageCuaHelper({ ...f.spec, scratchPath: join(f.packageRoot, 'native/cache') })).toThrow(/runtime 包内/u)
    expect(existsSync(join(f.packageRoot, 'native/bin/keep'))).toBe(true)
    expect(f.run).not.toHaveBeenCalled()
  })

  it('fails the build on a compiler failure rather than publishing stale output', () => {
    const f = fixture()
    f.run.mockReturnValueOnce({ status: 1, stdout: '', stderr: 'Swift compile failed' })
    expect(f.stage).toThrow(/Swift compile failed/u)
    expect(f.run).toHaveBeenCalledTimes(1)
  })

  it('fails on a missing receipt or missing resources even when the compiler reports success', () => {
    const f = fixture()
    f.run.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' })
    expect(f.stage).toThrow(/current.json/u)
    const built = publish(f.packageRoot, 'arm64')
    rmSync(join(built.application, 'Contents/Resources/DSHComputerUse.icns'))
    expect(() => verifyCuaHelper({ packageRoot: f.packageRoot, targetArch: 'arm64', run: f.run })).toThrow(/DSHComputerUse.icns/u)
  })

  it.each([null, { bundle: '../escape' }, { bundle: 'a'.repeat(64), extra: true }, { bundle: ['a'.repeat(64)] }])
    ('rejects malformed receipts: %j', (receipt) => {
      const f = fixture()
      write(f.packageRoot, 'native/bin/darwin-arm64/current.json', JSON.stringify(receipt))
      expect(() => verifyCuaHelper({ packageRoot: f.packageRoot, targetArch: 'arm64', run: f.run })).toThrow(/receipt/u)
      expect(f.run).not.toHaveBeenCalled()
    })

  it('detects post-build mutation before checking the architecture or signature', () => {
    const f = fixture()
    const staged = f.stage()
    f.run.mockClear()
    writeFileSync(join(f.packageRoot, staged.executable), 'altered payload')
    expect(() => verifyCuaHelper({ packageRoot: f.packageRoot, targetArch: 'arm64', run: f.run })).toThrow(/摘要不一致/u)
    expect(f.run).not.toHaveBeenCalled()
  })

  it.skipIf(process.platform === 'win32')('rejects links inside an immutable application', () => {
    const f = fixture()
    const staged = f.stage()
    const contents = dirname(dirname(join(f.packageRoot, staged.executable)))
    symlinkSync('/tmp', join(contents, 'linked-resource'))
    expect(() => verifyCuaHelper({ packageRoot: f.packageRoot, targetArch: 'arm64', run: f.run })).toThrow(/符号链接/u)
  })

  it('rejects an executable for the wrong architecture', () => {
    const f = fixture()
    f.run.mockImplementationOnce(() => {
      publish(f.packageRoot, 'arm64')
      return { status: 0, stdout: '', stderr: '' }
    }).mockReturnValueOnce({ status: 0, stdout: 'x86_64\n', stderr: '' })
    expect(f.stage).toThrow(/架构为 x86_64，需要 arm64/u)
    expect(f.run).toHaveBeenCalledTimes(2)
  })

  it('fails on a broken code signature', () => {
    const f = fixture()
    f.run.mockImplementationOnce(() => {
      publish(f.packageRoot, 'arm64')
      return { status: 0, stdout: '', stderr: '' }
    }).mockReturnValueOnce({ status: 0, stdout: 'arm64\n', stderr: '' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'invalid signature' })
    expect(f.stage).toThrow(/invalid signature/u)
  })

  it('omits copied development and foreign helper builds while retaining official compiler inputs', () => {
    const f = fixture()
    write(f.packageRoot, 'native/.build/huge-cache', 'debug')
    write(f.packageRoot, 'native/bin/darwin-x64/old-helper', 'stale')
    write(f.packageRoot, 'native/Sources/CuaNative/main.swift', '// native input')
    const destination = join(f.root, 'copied')
    copyRuntimePackage(f.packageRoot, destination, { exclude: [join('native', '.build'), join('native', 'bin')] })
    expect(existsSync(join(destination, 'native/.build'))).toBe(false)
    expect(existsSync(join(destination, 'native/bin'))).toBe(false)
    expect(readFileSync(join(destination, 'native/Sources/CuaNative/main.swift'), 'utf8')).toContain('native input')
  })
})

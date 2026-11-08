/** Packaging fixtures, never native driver or desktop access. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { stageWindowsCua, verifyWindowsCua } from '../windows-cua.mjs'
const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))
function pe(arch = 'x64') { const data = Buffer.alloc(512); data.writeUInt16LE(0x5a4d); data.writeUInt32LE(128, 0x3c); data.writeUInt32LE(0x00004550, 128); data.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 132); return data }
function fixture(arch = 'x64') {
  const root = mkdtempSync(join(tmpdir(), 'windows cua (&) ')); roots.push(root)
  const modulesRoot = join(root, 'node_modules'); const packageRoot = join(modulesRoot, '@lumo/computer-use')
  const write = (path: string, value: string | Buffer) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value) }
  write(join(packageRoot, 'native/windows-supervisor.rs'), '// compile fixture')
  const native = join(modulesRoot, `@trycua/cua-driver-win32-${arch}-msvc`)
  write(join(native, 'package.json'), JSON.stringify({ name: `@trycua/cua-driver-win32-${arch}-msvc`, version: '0.28.0' }))
  for (const name of ['cua_driver_sdk.dll', 'cua_driver_node_runtime.node']) write(join(native, name), pe(arch))
  const run = vi.fn((_command: string, args: string[]) => { writeFileSync(args.at(-1)!, pe(arch)); return { status: 0, stderr: '' } })
  const options = { packageRoot, modulesRoot, targetArch: arch, hostPlatform: 'win32', run }
  return { packageRoot, native, options, run }
}
describe('Windows Computer Use packaging', () => {
  it.each(['x64', 'arm64'])('compiles %s job supervisor with exact arguments and validates target DLLs', arch => {
    const f = fixture(arch); const result = stageWindowsCua(f.options)
    expect(result).toMatchObject({ available: true, provider: '@lumo/computer-use/windows', target: `win32-${arch}` })
    expect(result.executable).toBe(`native/bin/win32-${arch}/lumo-cua-supervisor.exe`)
    expect(f.run).toHaveBeenCalledWith('rustc', expect.arrayContaining(['--target', arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc', '-C', 'target-feature=+crt-static']), { encoding: 'utf8', windowsHide: true })
    expect(result.digest).toBe(createHash('sha256').update(pe(arch)).digest('hex'))
  })
  it('fails closed for wrong architecture, missing SDK binary or compiler failure', () => {
    const f = fixture(); stageWindowsCua(f.options)
    writeFileSync(join(f.native, 'cua_driver_sdk.dll'), pe('arm64'))
    expect(() => verifyWindowsCua(f.options)).toThrow('架构不匹配')
    rmSync(join(f.native, 'cua_driver_sdk.dll')); expect(() => verifyWindowsCua(f.options)).toThrow()
    expect(() => stageWindowsCua({ ...f.options, run: () => ({ status: 1, stderr: 'compiler failed' }) })).toThrow('compiler failed')
    expect(() => stageWindowsCua({ ...f.options, hostPlatform: 'darwin' })).toThrow('Windows 构建机')
  })
  it('detects an executable replaced after receipt creation', () => {
    const f = fixture(); stageWindowsCua(f.options)
    const binary = join(f.packageRoot, 'native/bin/win32-x64/lumo-cua-supervisor.exe')
    const data = readFileSync(binary); data[500] = 42; writeFileSync(binary, data)
    expect(() => verifyWindowsCua(f.options)).toThrow('receipt 不一致')
  })
})

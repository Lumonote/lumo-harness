import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertPortablePythonLinks, copyPortablePythonTree } from '../portable-python.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo python (&) '))); roots.push(root)
  const source = join(root, 'source'); mkdirSync(join(source, 'bin'), { recursive: true })
  const write = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
  write(join(source, 'bin/python3.13'), '#!/bin/sh\nprintf PYTHON_RELOCATED\n'); chmodSync(join(source, 'bin/python3.13'), 0o755)
  return { root, source, output: join(root, 'output'), write }
}
describe.skipIf(process.platform === 'win32')('portable Python copy', () => {
  it('keeps internal relative executable aliases and runs them after moving without its source', () => {
    const f = fixture(); symlinkSync('python3.13', join(f.source, 'bin/python3')); symlinkSync('python3', join(f.source, 'bin/python'))
    expect(copyPortablePythonTree(f.source, f.output)).toMatchObject({ preservedLinks: 2, materializedLinks: 0 })
    expect(lstatSync(join(f.output, 'bin/python')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(f.output, 'bin/python'))).toBe('python3.13')
    const relocated = join(f.root, 'Installed App (&)/runtime/python'); mkdirSync(dirname(relocated), { recursive: true }); renameSync(f.output, relocated); rmSync(f.source, { recursive: true })
    expect(() => assertPortablePythonLinks(relocated)).not.toThrow()
    const result = spawnSync(join(relocated, 'bin/python'), [], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0); expect(result.stdout).toBe('PYTHON_RELOCATED')
  })
  it('materializes explicitly allowed external links and internal absolute aliases without machine paths', () => {
    const f = fixture(); f.write(join(f.root, 'external/lib.txt'), 'library')
    symlinkSync('../external', join(f.source, 'external')); symlinkSync(join(f.source, 'bin/python3.13'), join(f.source, 'bin/python'))
    expect(() => copyPortablePythonTree(f.source, f.output)).toThrow(/未授权的包外/)
    rmSync(f.output, { recursive: true, force: true })
    copyPortablePythonTree(f.source, f.output, { externalRoots: [join(f.root, 'external')] })
    expect(lstatSync(join(f.output, 'bin/python')).isFile()).toBe(true)
    expect(readFileSync(join(f.output, 'external/lib.txt'), 'utf8')).toBe('library')
    rmSync(f.source, { recursive: true }); rmSync(join(f.root, 'external'), { recursive: true })
    expect(() => assertPortablePythonLinks(f.output)).not.toThrow()
  })
  it('rejects a nested link escaping an explicitly allowed external root', () => {
    const f = fixture(); f.write(join(f.root, 'external/lib.txt'), 'library'); f.write(join(f.root, 'host-secret'), 'not part of distribution')
    symlinkSync('../host-secret', join(f.root, 'external/escape'))
    symlinkSync('../external', join(f.source, 'external'))
    expect(() => copyPortablePythonTree(f.source, f.output, { externalRoots: [join(f.root, 'external')] })).toThrow(/未授权的包外/)
  })
  it('does not create aliases for excluded site-packages, skips dangling links and rejects directory cycles', () => {
    const f = fixture(); f.write(join(f.source, 'site-packages/pkg/a.py'), 'a')
    symlinkSync('site-packages/pkg/a.py', join(f.source, 'alias')); symlinkSync('missing', join(f.source, 'dangling'))
    copyPortablePythonTree(f.source, f.output, { filter: (path: string) => !path.includes('site-packages') })
    expect(existsSync(join(f.output, 'alias'))).toBe(false); expect(lstatSync(f.output).isDirectory()).toBe(true)
    symlinkSync('..', join(f.source, 'bin/loop'))
    expect(() => copyPortablePythonTree(f.source, join(f.root, 'cycle'))).toThrow(/循环/)
  })
  it('supports materialization for Windows packagers without requiring symlink privilege', () => {
    const f = fixture(); symlinkSync('python3.13', join(f.source, 'bin/python'))
    expect(copyPortablePythonTree(f.source, f.output, { preserveLinks: false }).materializedLinks).toBe(1)
    expect(lstatSync(join(f.output, 'bin/python')).isFile()).toBe(true)
  })
})

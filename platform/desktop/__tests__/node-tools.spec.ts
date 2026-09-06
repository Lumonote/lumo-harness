import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveWorkspaceNodeTool } from '../node-tools.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function tool(root: string, label: string) {
  const directory = join(root, 'node_modules', 'typescript')
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'typescript', bin: { tsc: 'compiler.cjs' } }))
  writeFileSync(join(directory, 'compiler.cjs'), `console.log(JSON.stringify({label:${JSON.stringify(label)},args:process.argv.slice(2)}))`)
}

describe('desktop Node tools', () => {
  it('runs the package entry without interpreting spaces or shell metacharacters', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo build (&) '))
    roots.push(root)
    tool(root, 'root')
    const entry = resolveWorkspaceNodeTool(join(root, 'apps', 'web'), root, 'tsc')
    const args = ['a file.json', '%PATH%', 'a&b', '(value)']
    expect(JSON.parse(execFileSync(process.execPath, [entry, ...args], { encoding: 'utf8' })))
      .toEqual({ label: 'root', args })
  })

  it('prefers a package-local compiler and rejects a missing tool', () => {
    const root = mkdtempSync(join(tmpdir(), 'lumo-tools-'))
    roots.push(root)
    const local = join(root, 'app')
    tool(root, 'root')
    tool(local, 'local')
    expect(resolveWorkspaceNodeTool(local, root, 'tsc')).toBe(realpathSync(join(local, 'node_modules', 'typescript', 'compiler.cjs')))
    expect(() => resolveWorkspaceNodeTool(local, root, 'missing-tool')).toThrow('Cannot find missing-tool')
  })
})

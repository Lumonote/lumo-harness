import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import typescript from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { stageDshNode } from '../stage-dsh-node.mjs'

const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function write(root: string, path: string, value: string) {
  const target = resolve(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, value)
}
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo-stage-node-')))
  roots.push(root)
  const dependencyRoot = join(root, 'source', 'platform')
  const packageRoot = join(dependencyRoot, 'data-plane', 'dsh-node')
  const destination = join(root, 'runtime', 'dsh-node')
  write(packageRoot, 'package.json', JSON.stringify({ name: '@lumo/dsh-node', type: 'module' }))
  const stage = () => stageDshNode({ typescript, packageRoot, destination, dependencyRoot })
  const run = (env: NodeJS.ProcessEnv = {}) => spawnSync(process.execPath, ['--experimental-strip-types', join(destination, 'src/index.ts')], {
    cwd: dirname(destination), encoding: 'utf8', timeout: 15_000,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, SYSTEMROOT: process.env.SYSTEMROOT, NODE_OPTIONS: '', NODE_PATH: '', ...env },
  })
  return { root, dependencyRoot, packageRoot, destination, stage, run }
}

describe('desktop dsh-node staging', () => {
  it('keeps src/index.ts while compiling a cross-root class and preserving import.meta location', () => {
    const f = fixture()
    write(f.packageRoot, 'src/index.ts', `import { Owner } from '../../../shared/owner.ts'; import { dirname } from 'node:path'; import { fileURLToPath } from 'node:url'; console.log(JSON.stringify({ value: new Owner('ready').value, here: dirname(fileURLToPath(import.meta.url)) }))`)
    write(f.dependencyRoot, 'shared/owner.ts', 'export class Owner { constructor(readonly value: string) {} }')
    f.stage()
    rmSync(join(f.root, 'source'), { recursive: true, force: true })
    expect(existsSync(join(f.destination, 'src/index.ts'))).toBe(true)
    expect(existsSync(join(f.destination, 'src/index.js'))).toBe(true)
    const result = f.run()
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ value: 'ready', here: join(f.destination, 'src') })
  })

  it('loads the actual launcher static graph to its own role validation in an isolated runtime', () => {
    const f = fixture()
    stageDshNode({ typescript, packageRoot: join(platformRoot, 'data-plane/dsh-node'), destination: f.destination, dependencyRoot: platformRoot })
    const modules = join(f.root, 'runtime/node_modules/@lumo/web-fetch-fakeip')
    write(modules, 'package.json', JSON.stringify({ name: '@lumo/web-fetch-fakeip', type: 'module', exports: './index.js' }))
    write(modules, 'index.js', 'export const FAKE_IP_PROVIDER_ID = "fixture-fake-ip"')
    const result = f.run({ LUMO_ROLE: 'invalid', LUMO_RUNTIME_ROOT: join(f.root, 'runtime'), LUMO_SQLITE_PATH: join(f.root, 'state/lumo.sqlite') })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('LUMO_ROLE 只能是 node|agent')
    expect(result.stderr).not.toMatch(/ERR_MODULE_NOT_FOUND|ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX/)
    expect(existsSync(join(f.destination, 'src/__lumo_runtime__/shared/nacos-registration.js'))).toBe(true)
    expect(existsSync(join(f.destination, 'src/__lumo_runtime__/dsh-plugins/user-auth/src/session-attachments.js'))).toBe(true)
  })

  it('refuses a missing cross-root runtime dependency before handing off to the launcher', () => {
    const f = fixture()
    write(f.packageRoot, 'src/index.ts', `import { missing } from '../../../shared/missing.ts'; console.log(missing)`)
    expect(f.stage).toThrow(/missing/)
  })
})

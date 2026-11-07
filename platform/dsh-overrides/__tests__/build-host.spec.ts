import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

// Exercise the real build-host executable, including its pristine-source gate,
// native bootstrap, Typert -> tsc -> synthesized entry, and PTC worker build.
// Only the external compilers are fixture executables. No production helper is
// mocked, and no file in the actual upstream checkout is written.
const entry = resolve(dirname(fileURLToPath(import.meta.url)), '../build-host.mjs')
const temporary: string[] = []
afterEach(() => { for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true }) })

function write(root: string, relative: string, content: string): void {
  const path = resolve(root, relative)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function git(root: string, ...args: string[]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr || `fixture git failed: ${args.join(' ')}`)
  return result.stdout
}

function fixture(): { root: string; env: NodeJS.ProcessEnv; binding: string; phases(): string[] } {
  const root = mkdtempSync(resolve(tmpdir(), 'lumo-build-host-native-'))
  temporary.push(root)
  write(root, '.gitignore', 'node_modules/\n**/lib/\nnative/system/packages/*/bin/\nphases\n')
  write(root, 'package.json', '{"name":"fixture-dsh","type":"module"}\n')
  write(root, 'tsconfig.host.json', '{"files":[]}\n')
  for (const path of ['util/brand', 'llm/llm', 'core/agent', 'util/native-command', 'skill/skill', 'typert/protocol', 'ptc-runtime/ptc-runtime-node']) {
    write(root, `packages/${path}/package.json`, JSON.stringify({ name: `@fixture/${path.replace('/', '-')}`, type: 'module' }))
  }
  write(root, 'packages/api/workspace-files/package.json', JSON.stringify({ name: '@fixture/workspace-files', type: 'module', exports: {
    './remote': { types: './lib/typert.remote-client.d.ts', default: './lib/typert.remote-client.js' },
    './typert': { types: './lib/typert.host.d.ts', default: './lib/typert.host.js' },
  } }))
  // The actual upstream Linux package manifest has nested libc-specific paths;
  // the unrelated Landlock executable or the other libc does not satisfy flock.
  write(root, 'native/system/packages/linux-x64/prebuilds.json', JSON.stringify({ platform: 'linux-x64', binaries: [
    { tool: 'landlock-run', kind: 'static-musl', path: 'bin/landlock-run' },
    { tool: 'flock', kind: 'node-api', napi: 8, libc: 'glibc', path: 'bin/glibc/system.node' },
    { tool: 'flock', kind: 'node-api', napi: 8, libc: 'musl', path: 'bin/musl/system.node' },
  ] }))
  write(root, 'native/system/scripts/build.ts', '// External compiler entry represented by the fixture tsx executable.\n')
  // Host selection is confined to this child's Node processes, so a macOS
  // developer runs the same Linux glibc path that failed on the CI runner.
  write(root, 'fixture-host.mjs', `
Object.defineProperty(process, 'platform', { value: 'linux' })
Object.defineProperty(process, 'arch', { value: 'x64' })
process.report.getReport = () => ({ header: { glibcVersionRuntime: '2.36' } })
`)
  write(root, 'node_modules/.bin/tsx', `#!${process.execPath}
const fs = process.getBuiltinModule('node:fs')
const path = process.getBuiltinModule('node:path')
const assert = process.getBuiltinModule('node:assert/strict')
assert.deepEqual(process.argv.slice(2), ['native/system/scripts/build.ts', '--host-addon-only'])
const root = process.cwd()
fs.appendFileSync(path.join(root, 'phases'), 'native\\n')
if (process.env.LUMO_FIXTURE_NATIVE_MODE === 'fail') process.exit(23)
const relative = process.env.LUMO_FIXTURE_NATIVE_MODE === 'missing' ? 'bin/musl/system.node' : 'bin/glibc/system.node'
const output = path.join(root, 'native/system/packages/linux-x64', relative)
fs.mkdirSync(path.dirname(output), { recursive: true })
fs.writeFileSync(output, 'fixture-native-output')
`)
  chmodSync(resolve(root, 'node_modules/.bin/tsx'), 0o755)
  write(root, 'node_modules/tsx/package.json', '{"name":"tsx","type":"module","exports":{"./esm":"./esm.mjs"}}\n')
  write(root, 'node_modules/tsx/esm.mjs', '// Fixture generator is plain JavaScript in a .ts entry.\n')
  write(root, 'scripts/generate-typert.ts', `
import fs from 'node:fs'
import path from 'node:path'
const root = process.cwd()
for (const [file, content] of [
  ['typert.remote-client.d.ts', 'interface TypertRemoteNamespaceMap {}\\n'],
  ['typert.host.d.ts', 'export declare const TYPERT: unknown\\n'],
]) {
  const output = path.join(root, 'packages/api/workspace-files/lib', file)
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, content)
}
fs.appendFileSync(path.join(root, 'phases'), 'typert\\n')
`)
  write(root, 'node_modules/typescript/bin/tsc', `
const fs = require('node:fs')
const path = require('node:path')
const assert = require('node:assert/strict')
const root = process.cwd()
assert.ok(fs.existsSync(path.join(root, 'packages/api/workspace-files/lib/typert.remote-client.d.ts')), 'Typert must precede host tsc')
assert.ok(process.execArgv.includes('--max-old-space-size=8192'), 'host heap budget must reach the child process')
assert.deepEqual(process.argv.slice(2), ['-b', 'tsconfig.host.json'])
for (const [relative, content] of [
  ['packages/util/brand/lib/types/index.js', 'export const brandString = "runtime"\\n'],
  ['packages/llm/llm/lib/types/assistant-stream.d.ts', 'export declare function assistantStreamChunks(): void\\n'],
  ['packages/core/agent/lib/types/types.d.ts', 'export declare const InboxState: unknown\\n'],
  ['packages/core/agent/lib/types/index.d.ts', '(agentCtx: Context, agent: Agent)\\n'],
  ['packages/util/native-command/lib/types/index.d.ts', 'export { nativeFileManager, revealNativePath }\\n'],
  ['packages/skill/skill/lib/types/index.d.ts', '/** Absolute instruction file path when supplied by the provider */\\n'],
  ['packages/typert/protocol/lib/types/types.d.ts', 'create: () => TypertSchema\\n'],
]) {
  const output = path.join(root, relative)
  fs.mkdirSync(path.dirname(output), { recursive: true }); fs.writeFileSync(output, content)
}
fs.appendFileSync(path.join(root, 'phases'), 'tsc\\n')
`)
  write(root, 'node_modules/tsdown/package.json', '{"name":"tsdown","type":"module","exports":{"./run":"./run.mjs"}}\n')
  write(root, 'node_modules/tsdown/run.mjs', `
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
const root = path.resolve(process.cwd(), '../../..')
assert.equal(path.relative(root, process.cwd()), 'packages/ptc-runtime/ptc-runtime-node')
assert.ok(fs.statSync(path.join(root, 'native/system/packages/linux-x64/bin/glibc/system.node')).isFile(), 'PTC prerequisites must include the loader-selected native addon')
assert.match(fs.readFileSync(path.join(root, 'packages/util/brand/lib/index.js'), 'utf8'), /export \\* from '\\.\\/types\\/index\\.js'/)
fs.appendFileSync(path.join(root, 'phases'), 'ptc\\n')
fs.mkdirSync('lib', { recursive: true }); fs.writeFileSync('lib/process.js', '// fixture executable worker bundle\\n')
`)
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid.test', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'Pristine fixture source')
  return {
    root,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(resolve(root, 'fixture-host.mjs')).href}` },
    binding: resolve(root, 'native/system/packages/linux-x64/bin/glibc/system.node'),
    phases: () => existsSync(resolve(root, 'phases')) ? readFileSync(resolve(root, 'phases'), 'utf8').trim().split('\n') : [],
  }
}

function run(f: ReturnType<typeof fixture>) {
  return spawnSync(process.execPath, [entry, f.root], { encoding: 'utf8', env: f.env, timeout: 20_000 })
}

const posix = it.skipIf(process.platform === 'win32')
describe('build-host native prerequisites through its real executable entry', () => {
  posix('bootstraps a pristine fresh Linux glibc checkout before the PTC worker build', () => {
    const f = fixture()
    const result = run(f)
    expect(result.status, result.stderr).toBe(0)
    expect(f.phases()).toEqual(['typert', 'tsc', 'native', 'ptc'])
    expect(readFileSync(f.binding, 'utf8')).toBe('fixture-native-output')
    expect(existsSync(resolve(f.root, 'packages/ptc-runtime/ptc-runtime-node/lib/process.js'))).toBe(true)
    expect(git(f.root, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(git(f.root, 'ls-files', '--others', '--exclude-standard')).toBe('')
  })

  posix('an existing bin directory containing Landlock and musl still builds the missing glibc addon', () => {
    const f = fixture()
    write(f.root, 'native/system/packages/linux-x64/bin/landlock-run', 'not-the-flock-binding')
    write(f.root, 'native/system/packages/linux-x64/bin/musl/system.node', 'wrong-libc-binding')
    const result = run(f)
    expect(result.status, result.stderr).toBe(0)
    expect(f.phases()).toEqual(['typert', 'tsc', 'native', 'ptc'])
    expect(existsSync(f.binding)).toBe(true)
  })

  posix('reuses an existing nonempty loader-selected binding without another native build', () => {
    const f = fixture()
    write(f.root, 'native/system/packages/linux-x64/bin/glibc/system.node', 'existing-native-output')
    const first = run(f)
    expect(first.status, first.stderr).toBe(0)
    expect(f.phases()).toEqual(['typert', 'tsc', 'ptc'])
    const second = run(f)
    expect(second.status, second.stderr).toBe(0)
    expect(f.phases()).toEqual(['typert', 'tsc', 'ptc', 'ptc'])
    expect(readFileSync(f.binding, 'utf8')).toBe('existing-native-output')
  })

  posix('a successful compiler exit without the selected addon fails before the PTC worker build', () => {
    const f = fixture()
    f.env.LUMO_FIXTURE_NATIVE_MODE = 'missing'
    const result = run(f)
    expect(result.status).not.toBe(0)
    expect(f.phases()).toEqual(['typert', 'tsc', 'native'])
    expect(result.stderr).toContain('glibc/system.node')
    expect(existsSync(resolve(f.root, 'packages/ptc-runtime/ptc-runtime-node/lib/process.js'))).toBe(false)
  })

  posix('native compiler failure stops the pipeline and retains a pristine source tree', () => {
    const f = fixture()
    f.env.LUMO_FIXTURE_NATIVE_MODE = 'fail'
    const result = run(f)
    expect(result.status).not.toBe(0)
    expect(f.phases()).toEqual(['typert', 'tsc', 'native'])
    expect(result.stderr).toContain('23')
    expect(git(f.root, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  posix('refuses dirty tracked sources before running any external compiler', () => {
    const f = fixture()
    write(f.root, 'tsconfig.host.json', '{"files":[],"changed":true}\n')
    const result = run(f)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('tracked modifications')
    expect(f.phases()).toEqual([])
  })
})

import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { buildDshClientArtifacts, projectDshClientDeclarations } from '../build-client.mjs'

const require = createRequire(import.meta.url)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function write(root: string, path: string, source: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), source)
}

function git(root: string, ...args: string[]) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
  return result.stdout
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lumo-client-types-'))
  roots.push(root)
  write(root, 'package.json', '{"private":true,"type":"module"}')
  write(root, '.gitignore', 'node_modules/\nlib/\n')
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(dirname(require.resolve('typescript/package.json')), join(root, 'node_modules/typescript'), process.platform === 'win32' ? 'junction' : 'dir')
  write(root, 'tsconfig.base.json', JSON.stringify({ compilerOptions: {
    composite: true, declaration: true, target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
  } }))
  const packageConfig = (references: Array<{ path: string }> = [], include = ['src']) => JSON.stringify({
    extends: '../../../tsconfig.base.json', compilerOptions: { rootDir: 'src', outDir: 'lib/types', tsBuildInfoFile: 'lib/tsconfig.client.tsbuildinfo' }, include, references,
  })
  write(root, 'packages/util/shared/tsconfig.json', packageConfig())
  write(root, 'packages/util/shared/package.json', '{"name":"@fixture/shared","type":"module","exports":{".":{"types":"./lib/types/index.d.ts","default":"./lib/types/index.js"}}}')
  write(root, 'packages/util/shared/src/index.ts', 'export interface Shared { value: string }\n')
  write(root, 'packages/client/sidebar/package.json', '{"name":"@fixture/sidebar","type":"module","exports":{"./client":{"types":"./lib/types/client/index.d.ts","default":"./lib/types/client/index.js"}}}')
  write(root, 'packages/client/sidebar/tsconfig.json', '{"files":[],"references":[{"path":"./tsconfig.client.json"}]}')
  write(root, 'packages/client/sidebar/tsconfig.client.json', packageConfig([{ path: '../../util/shared' }]))
  write(root, 'packages/client/sidebar/tsdown.config.ts', 'export default {}\n')
  write(root, 'packages/client/sidebar/src/client/index.ts', 'import type { Shared } from "@fixture/shared"; export interface Sidebar extends Shared { selected: boolean }\n')
  write(root, 'packages/client/sidebar/src/index.ts', 'export type { Sidebar } from "./client/index.js"\n')
  write(root, 'packages/experimental/preview/tsconfig.client.json', packageConfig([{ path: '../../client/sidebar/tsconfig.client.json' }]))
  write(root, 'packages/experimental/preview/tsdown.config.ts', 'export default {}\n')
  write(root, 'packages/experimental/preview/src/client/index.ts', 'import type { Sidebar } from "@fixture/sidebar/client"; export interface Preview { sidebar: Sidebar }\n')
  write(root, 'packages/experimental/preview/src/index.ts', 'export type { Preview } from "./client/index.js"\n')
  // This referenced pure library deliberately has no tsdown config. Building
  // only desktop bundle candidates would leave this direct root uncompiled.
  write(root, 'packages/test-support/pure/tsconfig.json', packageConfig())
  write(root, 'packages/test-support/pure/src/index.ts', 'export interface Pure { active: boolean }\n')
  mkdirSync(join(root, 'node_modules/@fixture'))
  for (const [name, directory] of [['shared', 'packages/util/shared'], ['sidebar', 'packages/client/sidebar']]) {
    symlinkSync(resolve(root, directory), join(root, 'node_modules/@fixture', name), process.platform === 'win32' ? 'junction' : 'dir')
  }
  write(root, 'aggregate-only.ts', 'const aggregateOnlyError: string = 7\n')
  write(root, 'tsconfig.client.json', `{
    // The noEmit test/script aggregate must not itself be compiled.
    "compilerOptions": { "noEmit": true }, "files": ["aggregate-only.ts"],
    "references": [{"path":"./packages/client/sidebar"}, {"path":"./packages/experimental/preview/tsconfig.client.json"}, {"path":"./packages/test-support/pure"}],
  }`)
  git(root, 'init', '-q')
  git(root, 'add', '.')
  git(root, '-c', 'user.name=Lumo test', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'clean source fixture')
  return root
}

describe('fresh-checkout Client type prerequisite', () => {
  it('emits the complete referenced graph and browser halves using the real compiler, preserving tracked source', () => {
    const root = fixture()
    expect(existsSync(join(root, 'packages/client/sidebar/lib'))).toBe(false)
    const configs = buildDshClientArtifacts(root)
    expect(configs).toContain('packages/test-support/pure')
    for (const declaration of ['packages/util/shared/lib/types/index.d.ts', 'packages/client/sidebar/lib/types/client/index.d.ts', 'packages/experimental/preview/lib/types/client/index.d.ts', 'packages/test-support/pure/lib/types/index.d.ts']) {
      expect(readFileSync(join(root, declaration), 'utf8')).toMatch(/interface /u)
    }
    expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(git(root, 'ls-files', '--others', '--exclude-standard')).toBe('')
    // A consumer with project-reference redirection disabled must read emitted
    // declarations, just as platform's /client imports do on a new CI runner.
    write(root, 'consumer.ts', 'import type { Preview } from "./packages/experimental/preview/lib/types/client/index.js"; const preview: Preview = {sidebar: {value: "ready", selected: true}}; void preview\n')
    const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '--strict', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', 'consumer.ts'], { cwd: root, encoding: 'utf8' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it('fails on actual Client type errors and refuses tracked edits before emitting', () => {
    const root = fixture()
    write(root, 'packages/test-support/pure/src/index.ts', 'export const invalid: string = 7\n')
    expect(() => buildDshClientArtifacts(root)).toThrow('tracked modifications')
    expect(existsSync(join(root, 'packages/client/sidebar/lib'))).toBe(false)
    git(root, 'add', '.')
    git(root, '-c', 'user.name=Lumo test', '-c', 'user.email=ci@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'upstream compiler diagnostic fixture')
    expect(() => buildDshClientArtifacts(root)).toThrow('client build failed')
    expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('')
  })

  it('projects overlay declarations while retaining Host bundles and pristine source, refusing paths outside the workspace', () => {
    const root = fixture()
    const stage = mkdtempSync(join(tmpdir(), 'lumo-client-overlay-'))
    roots.push(stage)
    buildDshClientArtifacts(root)
    write(root, 'packages/client/sidebar/lib/index.js', 'export const hostBundle = true\n')
    write(root, 'packages/client/sidebar/lib/types/deleted.d.ts', 'export interface Obsolete {}\n')
    write(stage, 'packages/client/sidebar/lib/types/client/index.d.ts', 'export interface Sidebar { overlaySeat: string }\n')
    projectDshClientDeclarations(root, stage, ['packages/client/sidebar/tsconfig.json'])
    expect(readFileSync(join(root, 'packages/client/sidebar/lib/types/client/index.d.ts'), 'utf8')).toContain('overlaySeat')
    expect(readFileSync(join(root, 'packages/client/sidebar/lib/index.js'), 'utf8')).toContain('hostBundle')
    expect(readFileSync(join(root, 'packages/client/sidebar/src/client/index.ts'), 'utf8')).not.toContain('overlaySeat')
    expect(existsSync(join(root, 'packages/client/sidebar/lib/types/deleted.d.ts'))).toBe(false)
    expect(git(root, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    expect(() => projectDshClientDeclarations(root, join(root, 'stage'), [])).toThrow('outside the upstream checkout')
    expect(() => projectDshClientDeclarations(root, stage, ['../outside/tsconfig.json'])).toThrow('inside the workspace')
  })

  it('requires the CI Client build after Host preparation and before browser typechecks', () => {
    const workflow = readFileSync(fileURLToPath(new URL('../../../.github/workflows/ci.yml', import.meta.url)), 'utf8')
    const host = workflow.indexOf('node dsh-overrides/build-host.mjs ../deepseek-harness')
    const client = workflow.indexOf('node dsh-overrides/build-client.mjs ../deepseek-harness')
    const checks = workflow.indexOf('pnpm run typecheck:client')
    expect(client).toBeGreaterThan(host)
    expect(checks).toBeGreaterThan(client)
  })
})

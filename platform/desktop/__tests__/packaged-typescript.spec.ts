import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import typescript from 'typescript'
import { compilePackagedTypeScriptPlugin } from '../packaged-typescript.mjs'

const temporary: string[] = []
const platformRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }) })

function write(root: string, path: string, value: string) {
  const target = resolve(root, path)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, value)
}

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo-packaged-ts-')))
  temporary.push(root)
  const dependencyRoot = join(root, 'sources', 'platform')
  const packageRoot = join(dependencyRoot, 'dsh-plugins', 'fixture')
  const runtimeRoot = join(root, 'runtime')
  const destination = join(runtimeRoot, 'node_modules', '@lumo', 'fixture')
  const manifest = JSON.stringify({ name: '@lumo/fixture', type: 'module', exports: { '.': { import: './src/index.ts', default: './src/index.ts' } } })
  write(packageRoot, 'package.json', manifest)
  write(destination, 'package.json', manifest)
  const compile = () => compilePackagedTypeScriptPlugin({ typescript, packageName: '@lumo/fixture', packageRoot, destination, dependencyRoot })
  const run = (expression: string) => {
    // The child has neither workspace sources nor tsx hooks to mask a missing
    // emitted dependency or a shared module outside its ESM package scope.
    rmSync(join(root, 'sources'), { recursive: true, force: true })
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `const plugin = await import('@lumo/fixture'); console.log(JSON.stringify(${expression}))`], {
      cwd: runtimeRoot, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' },
    })
    expect(result.status, result.stderr).toBe(0)
    return JSON.parse(result.stdout)
  }
  return { root, dependencyRoot, packageRoot, destination, compile, run }
}

describe('packaged TypeScript plugin runtime closure', () => {
  it('retains sibling modules and their normal lib layout', () => {
    const f = fixture()
    write(f.packageRoot, 'src/index.ts', 'export { greeting } from "./nested/resolver.ts"\n')
    write(f.packageRoot, 'src/nested/resolver.ts', 'export const greeting: string = "hello"\n')
    f.compile()
    expect(existsSync(join(f.destination, 'lib/nested/resolver.js'))).toBe(true)
    expect(f.run('plugin.greeting')).toBe('hello')
  })

  it('ships transitive shared value exports and literal dynamic imports inside the plugin', () => {
    const f = fixture()
    write(f.packageRoot, 'src/index.ts', `
import type { Invisible } from '../../../shared/type-only.ts'
export {
  owner,
} from '../../../shared/owner.ts'
export async function lazy(): Promise<string> {
  return (await import('../../../shared/nested/lazy.ts')).value
}
`)
    write(f.dependencyRoot, 'shared/owner.ts', `import { suffix } from './nested/suffix.ts'; export const owner: string = 'owner:' + suffix`)
    write(f.dependencyRoot, 'shared/nested/suffix.ts', `export const suffix: string = 'ready'`)
    write(f.dependencyRoot, 'shared/nested/lazy.ts', `import { suffix } from './suffix.ts'; export const value: string = 'lazy:' + suffix`)
    write(f.dependencyRoot, 'shared/type-only.ts', `import './not-a-runtime-dependency.ts'; export interface Invisible { value: string }`)
    const emitted = f.compile()
    expect(emitted.size).toBe(4)
    expect([...emitted].every(path => path.startsWith(f.destination + sep))).toBe(true)
    expect(f.run('[plugin.owner, await plugin.lazy()]')).toEqual(['owner:ready', 'lazy:ready'])
  })

  it('follows JavaScript specifiers to their TypeScript sources and terminates import cycles', () => {
    const f = fixture()
    write(f.packageRoot, 'src/index.ts', `export { answer } from '../../../shared/a.js'`)
    write(f.dependencyRoot, 'shared/a.ts', `import { add } from './b.js'; export const answer: number = add(40)`)
    write(f.dependencyRoot, 'shared/b.ts', `import type { Missing } from './types.ts'; export { answer } from './a.js'; export const add = (value: number): number => value + 2`)
    const emitted = f.compile()
    expect(emitted.size).toBe(3)
    expect(f.run('plugin.answer')).toBe(42)
  })

  it('preserves bare imports in the packaged plugin dependency context', () => {
    const f = fixture()
    write(f.packageRoot, 'src/index.ts', `export { value } from '../../../shared/consumer.ts'`)
    write(f.dependencyRoot, 'shared/consumer.ts', `import { value } from 'fixture-dependency'; export { value }`)
    write(f.destination, 'node_modules/fixture-dependency/package.json', JSON.stringify({ name: 'fixture-dependency', type: 'module', exports: './index.js' }))
    write(f.destination, 'node_modules/fixture-dependency/index.js', 'export const value = "plugin-local"')
    f.compile()
    expect(f.run('plugin.value')).toBe('plugin-local')
  })

  it('fails at build time for a missing transitive shared value dependency', () => {
    const f = fixture()
    write(f.packageRoot, 'src/index.ts', `export { owner } from '../../../shared/owner.ts'`)
    write(f.dependencyRoot, 'shared/owner.ts', `export { owner } from './missing.ts'`)
    expect(f.compile).toThrow(/missing/)
  })

  it('loads and calls the actual session owner contract after removing the source fixture', () => {
    const f = fixture()
    write(f.packageRoot, 'src/index.ts', `export { SessionOwnerClient } from '../../../shared/session-owners.ts'`)
    for (const name of ['session-owners', 'session-execution']) {
      write(f.dependencyRoot, `shared/${name}.ts`, readFileSync(join(platformRoot, 'shared', `${name}.ts`), 'utf8'))
    }
    f.compile()
    const owner = { session_ref: 's1', realm: 'r1', owner_user_id: 'u1', project_id: 'p1', node_id: 'n1', parent_session_ref: '', state: 'active', created_at: '2026-11-07' }
    expect(f.run(`await new plugin.SessionOwnerClient('https://authority.test', 'fixture-token', async () => new Response(JSON.stringify({ owner: ${JSON.stringify(owner)} }))).get('r1', 's1')`)).toEqual(owner)
  })

  it.each(['agent-teams', 'open-design', 'archify', 'creative-skills', 'ruflo-orchestration', 'web-fetch-fakeip'])(
    'emits the current %s plugin and its complete relative runtime graph', (name) => {
      const f = fixture()
      const packageRoot = join(platformRoot, 'dsh-plugins', name)
      write(f.destination, 'package.json', readFileSync(join(packageRoot, 'package.json'), 'utf8'))
      const emitted = compilePackagedTypeScriptPlugin({ typescript, packageName: `@lumo/${name}`, packageRoot, destination: f.destination, dependencyRoot: platformRoot })
      expect(existsSync(join(f.destination, 'lib/index.js'))).toBe(true)
      expect([...emitted].every(path => path.startsWith(f.destination + sep))).toBe(true)
      if (name === 'agent-teams') {
        expect(emitted.has(join(f.destination, 'lib/__lumo_runtime__/shared/session-owners.js'))).toBe(true)
        expect(emitted.has(join(f.destination, 'lib/__lumo_runtime__/shared/session-execution.js'))).toBe(true)
      }
    },
  )
})

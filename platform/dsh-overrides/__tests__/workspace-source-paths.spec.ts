import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isolateWorkspaceSourcePaths } from '../workspace-source-paths.mjs'

const require = createRequire(import.meta.url)
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lumo-source-paths-'))
  roots.push(root)
  const source = join(root, 'source'), stage = join(root, 'stage')
  write(source, 'package.json', '{"name":"fixture","type":"module","private":true}')
  write(source, 'tsconfig.base.json', `{
    // Match the upstream JSONC source facade and its source-level canonical entry.
    "compilerOptions": {
      "target":"ES2022", "module":"ESNext", "moduleResolution":"Bundler",
      "strict":true, "noEmit":true, "skipLibCheck":true, "types":[], "allowImportingTsExtensions":true,
      "paths": {
        "@fixture/context": ["./packages/context/src/index.ts"],
        "@fixture/controller/client": ["./packages/controller/src/index.ts"],
      },
    },
  }`)
  write(source, 'tsconfig.json', '{"extends":"./tsconfig.base.json","files":["consumer.ts"]}')
  write(source, 'packages/context/package.json', '{"name":"@fixture/context","type":"module"}')
  write(source, 'packages/context/src/index.ts', 'export interface Context {}\n')
  write(source, 'packages/controller/package.json', JSON.stringify({
    name: '@fixture/controller', type: 'module', exports: { './client': './src/index.ts', './src/*': './src/*' },
  }))
  write(source, 'packages/controller/src/index.ts', `import type {} from '@fixture/context'
export interface SessionRetainFacetMap {}
export type SessionRetainFacet = keyof SessionRetainFacetMap
export interface ISessions { retain(facets: readonly SessionRetainFacet[]): void }
declare module '@fixture/context' { interface Context { sessions: ISessions } }
`)
  write(source, 'packages/controller/src/facets.ts', `import type { SessionRetainFacet } from './index'
export interface RetainedUse { facets: readonly SessionRetainFacet[] }
export function shiftRetention(_use: RetainedUse): void {}
`)
  write(source, 'consumer.ts', `import type { SessionRetainFacet } from '@fixture/controller/client'
import { shiftRetention } from '@fixture/controller/src/facets.ts'
declare module '@fixture/controller/client' { interface SessionRetainFacetMap { conversation: unknown } }
const facets: readonly SessionRetainFacet[] = ['conversation']
shiftRetention({ facets })
`)
  cpSync(source, stage, { recursive: true })
  mkdirSync(join(source, 'node_modules/@fixture'), { recursive: true })
  symlinkSync(join(source, 'packages/controller'), join(source, 'node_modules/@fixture/controller'), 'junction')
  symlinkSync(dirname(require.resolve('typescript/package.json')), join(source, 'node_modules/typescript'), 'junction')
  symlinkSync(join(source, 'node_modules'), join(stage, 'node_modules'), 'junction')
  expect(spawnSync('git', ['init', '--quiet'], { cwd: source }).status).toBe(0)
  expect(spawnSync('git', ['add', 'package.json', 'packages'], { cwd: source }).status).toBe(0)
  return { source, stage }
}

function compile(root: string) {
  return spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.json', '--pretty', 'false'], { cwd: root, encoding: 'utf8' })
}

describe('isolated workspace source exports', () => {
  it('repairs duplicate declarations and split augmentation using the real TypeScript compiler', () => {
    const { source, stage } = fixture()
    const originalConfig = readFileSync(join(source, 'tsconfig.base.json'), 'utf8')
    const original = compile(source)
    expect(original.status, original.stdout + original.stderr).toBe(0)
    const broken = compile(stage)
    expect(broken.status).not.toBe(0)
    expect(broken.stdout).toContain('TS2717')
    expect(broken.stdout).toContain('TS2322')
    expect(broken.stdout).toContain('readonly never[]')
    expect(isolateWorkspaceSourcePaths(source, stage)).toBe(1)
    const fixed = compile(stage)
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0)
    expect(readFileSync(join(source, 'tsconfig.base.json'), 'utf8')).toBe(originalConfig)
    const preparedConfig = readFileSync(join(stage, 'tsconfig.base.json'), 'utf8')
    expect(isolateWorkspaceSourcePaths(source, stage)).toBe(0)
    expect(readFileSync(join(stage, 'tsconfig.base.json'), 'utf8')).toBe(preparedConfig)
  })

  it('preserves explicit paths and maps only source exports, including equivalent conditions', () => {
    const { source, stage } = fixture()
    const config = { compilerOptions: { baseUrl: './packages', paths: {
      '@fixture/controller/src/*': ['./custom/*'], '@fixture/other': ['./other.ts'],
    } } }
    write(stage, 'tsconfig.base.json', JSON.stringify(config))
    for (const [name, exports] of [
      ['conditional', { './src/*': { types: './src/*', default: './src/*' } }],
      ['private', { '.': './src/index.ts' }],
      ['compiled', { './src/*': './lib/*' }],
      ['mixed', { './src/*': { types: './src/*', default: './lib/*' } }],
    ]) {
      const path = `packages/${name}/package.json`
      const manifest = JSON.stringify({ name: `@fixture/${name}`, exports })
      write(source, path, manifest)
      write(stage, path, manifest)
    }
    expect(spawnSync('git', ['add', 'packages'], { cwd: source }).status).toBe(0)
    expect(isolateWorkspaceSourcePaths(source, stage)).toBe(1)
    expect(JSON.parse(readFileSync(join(stage, 'tsconfig.base.json'), 'utf8')).compilerOptions.paths).toEqual({
      ...config.compilerOptions.paths, '@fixture/conditional/src/*': ['./conditional/src/*'],
    })
  })

  it('refuses to rewrite the original checkout or a snapshot inside it', () => {
    const { source } = fixture()
    expect(() => isolateWorkspaceSourcePaths(source, source)).toThrow('outside the upstream checkout')
    expect(() => isolateWorkspaceSourcePaths(source, join(source, 'stage'))).toThrow('outside the upstream checkout')
  })
})

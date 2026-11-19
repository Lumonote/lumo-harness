import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { dshClientBundleArgs } from '../dsh-client-bundle.mjs'
import { resolveWorkspaceNodeTool } from '../node-tools.mjs'

const upstreamRoot = fileURLToPath(new URL('../../../deepseek-harness/', import.meta.url))
const tsdown = resolveWorkspaceNodeTool(upstreamRoot, upstreamRoot, 'tsdown')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function write(root: string, path: string, content: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), content)
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'lumo-client-bundle-'))
  roots.push(root)
  const source = join(root, 'source'), stage = join(root, 'stage')
  write(source, 'package.json', '{"name":"fixture","private":true,"type":"module"}')
  write(source, 'tsconfig.base.client.json', JSON.stringify({ compilerOptions: {
    target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', paths: {
      '@fixture/controller/client/directories': ['./packages/controller/src/client/directories.ts'],
    },
  } }))
  write(source, 'tsconfig.json', '{"extends":"./tsconfig.base.client.json","files":[]}')
  write(source, 'tsdown.config.mjs', 'export default {workspace:["packages/consumer"],entry:""}\n')
  write(source, 'packages/controller/package.json', JSON.stringify({
    name: '@fixture/controller', type: 'module', exports: { './client/directories': {
      types: './lib/types/client/directories.d.ts', default: './lib/types/client/directories.js',
    } },
  }))
  // A clean upstream checkout has no emitted Client dependency. The snapshot
  // owns its source and output, but shares the upstream node_modules links.
  write(source, 'packages/controller/src/client/directories.ts', 'export const selectSessionDirectory = () => "original"\n')
  write(source, 'packages/consumer/package.json', JSON.stringify({
    name: '@fixture/consumer', type: 'module', dependencies: { '@fixture/controller': 'workspace:*' },
  }))
  write(source, 'packages/consumer/tsconfig.json', '{"files":[],"references":[{"path":"./tsconfig.client.json"}]}')
  write(source, 'packages/consumer/tsconfig.client.json', '{"extends":"../../tsconfig.base.client.json","include":["src"]}')
  write(source, 'packages/consumer/tsdown.config.mjs', `export default {
    entry:'lib/types/client/index.js',format:'esm',outDir:'lib',fixedExtension:false,
    dts:false,clean:false,deps:{alwaysBundle:()=>true},
  }\n`)
  write(source, 'packages/consumer/lib/types/client/index.js', `import {selectSessionDirectory} from '@fixture/controller/client/directories'
export const value = selectSessionDirectory()\n`)
  cpSync(source, stage, { recursive: true })
  write(stage, 'packages/controller/src/client/directories.ts', 'export const selectSessionDirectory = () => "isolated"\n')
  mkdirSync(join(source, 'packages/consumer/node_modules/@fixture'), { recursive: true })
  symlinkSync(join(source, 'packages/controller'), join(source, 'packages/consumer/node_modules/@fixture/controller'), 'junction')
  symlinkSync(join(source, 'packages/consumer/node_modules'), join(stage, 'packages/consumer/node_modules'), 'junction')
  return { source, stage }
}

describe('isolated Client bundling', () => {
  it.each(['package', 'workspace'])('resolves inline dependencies from the snapshot in a %s build', (scope) => {
    const { source, stage } = fixture()
    const cwd = scope === 'package' ? join(stage, 'packages/consumer') : stage
    const output = join(stage, 'packages/consumer/lib/index.js')
    const original = readFileSync(join(source, 'packages/controller/src/client/directories.ts'), 'utf8')
    const broken = spawnSync(process.execPath, [tsdown, '--env.DSH_BUILD_FACE', 'client'], { cwd, encoding: 'utf8' })
    // POSIX can warn and silently leave a runtime require; Windows reports the
    // missing export target as fatal. Either outcome is a broken bundle.
    expect(broken.stdout + broken.stderr).toMatch(/UNRESOLVED_IMPORT|UNLOADABLE_DEPENDENCY/)

    const fixed = spawnSync(process.execPath, [tsdown, ...dshClientBundleArgs(stage)], { cwd, encoding: 'utf8' })
    expect(fixed.status, fixed.stdout + fixed.stderr).toBe(0)
    expect(fixed.stdout + fixed.stderr).not.toMatch(/UNRESOLVED_IMPORT|UNLOADABLE_DEPENDENCY/)
    expect(readFileSync(output, 'utf8')).not.toContain('@fixture/controller/client/directories')
    const executed = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {value} from ${JSON.stringify(pathToFileURL(output).href)}; console.log(value)`,
    ], { encoding: 'utf8' })
    expect(executed.status, executed.stderr).toBe(0)
    expect(executed.stdout.trim()).toBe('isolated')
    expect(readFileSync(join(source, 'packages/controller/src/client/directories.ts'), 'utf8')).toBe(original)
  })
})

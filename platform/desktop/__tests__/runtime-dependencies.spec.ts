import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertWindowsRuntimePaths, copyRuntimePackage, planRuntimePackages, resolveInstalledPackage } from '../runtime-dependencies.mjs'

type Package = {
  root: string
  manifest: { name: string; version: string }
  dependencies: Map<string, Package>
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lumo-runtime-deps-')))
  roots.push(root)
  const modulesRoot = join(root, 'runtime', 'node_modules')
  const packages = new Map<string, Package>()
  const add = (name: string, version: string, source: string): Package => {
    const path = join(root, 'sources', `${name.replaceAll('/', '-')}-${version}`)
    mkdirSync(path, { recursive: true })
    const info = { root: path, manifest: { name, version }, dependencies: new Map<string, Package>() }
    writeFileSync(join(path, 'package.json'), JSON.stringify({ ...info.manifest, main: 'index.js' }))
    writeFileSync(join(path, 'index.js'), source)
    if (!packages.has(name)) packages.set(name, info)
    return info
  }
  const run = (source: string) => {
    const layout = planRuntimePackages(modulesRoot, packages)
    for (const entry of layout) copyRuntimePackage(entry.root, entry.destination)
    // A separate Node process has no source-tree module cache or workspace links.
    const result = spawnSync(process.execPath, ['-e', source], { cwd: dirname(modulesRoot), encoding: 'utf8', env: { ...process.env, NODE_PATH: '' } })
    expect(result.status, result.stderr).toBe(0)
    return { value: JSON.parse(result.stdout), layout }
  }
  return { root, modulesRoot, packages, add, run }
}

describe('desktop runtime dependency layout', () => {
  it('keeps the callable signal-exit 3 API for proper-lockfile alongside the signal-exit 4 API', () => {
    const { add, run } = fixture()
    const modern = add('signal-exit', '4.1.0', 'exports.onExit = () => "modern"')
    const legacy = add('signal-exit', '3.0.7', 'module.exports = () => "legacy"')
    const lockfile = add('proper-lockfile', '4.1.2', 'module.exports = require("signal-exit")()')
    lockfile.dependencies.set('signal-exit', legacy)
    const consumer = add('modern-consumer', '1.0.0', 'module.exports = require("signal-exit").onExit()')
    consumer.dependencies.set('signal-exit', modern)

    const { value, layout } = run('console.log(JSON.stringify([require("proper-lockfile"), require("modern-consumer")]))')
    expect(value).toEqual(['legacy', 'modern'])
    expect(layout).toHaveLength(4)
  })

  it('preserves transitive dependencies when an ancestor shadows the top-level version', () => {
    const { add, run } = fixture()
    const shared = add('shared', '1.0.0', 'module.exports = "shared-1"')
    const other = add('shared', '2.0.0', 'module.exports = "shared-2"')
    add('parent', '1.0.0', 'module.exports = "unused"')
    const parent = add('parent', '2.0.0', 'module.exports = [require("shared"), require("child")]')
    add('child', '1.0.0', 'module.exports = "unused"')
    const child = add('child', '2.0.0', 'module.exports = require("shared")')
    const app = add('app', '1.0.0', 'module.exports = require("parent")')
    app.dependencies.set('parent', parent)
    parent.dependencies.set('shared', other)
    parent.dependencies.set('child', child)
    child.dependencies.set('shared', shared)

    expect(run('console.log(JSON.stringify(require("app")))').value).toEqual(['shared-2', 'shared-1'])
  })

  it('handles cyclic dependencies, aliases, and scoped packages without recursive copying', () => {
    const { add, run, modulesRoot } = fixture()
    add('@scope/a', '1.0.0', 'exports.name = "a1"')
    const a = add('@scope/a', '2.0.0', 'exports.name = "a2"; exports.b = require("b").name')
    add('b', '1.0.0', 'exports.name = "b1"')
    const b = add('b', '2.0.0', 'exports.name = "b2"; exports.a = require("@scope/a").name')
    const app = add('app', '1.0.0', 'module.exports = require("legacy-a")')
    app.dependencies.set('legacy-a', a)
    a.dependencies.set('b', b)
    b.dependencies.set('@scope/a', a)

    const { value, layout } = run('console.log(JSON.stringify(require("app")))')
    expect(value).toEqual({ name: 'a2', b: 'b2' })
    expect(layout.length).toBeLessThan(10)
    const resolved = resolveInstalledPackage('legacy-a', join(modulesRoot, 'app'))
    expect(resolved).toBeDefined()
    expect(JSON.parse(readFileSync(join(resolved!, 'package.json'), 'utf8'))).toMatchObject({ name: '@scope/a', version: '2.0.0' })
  })

  it('hoists a conflicting dependency chain within the Windows installer path budget', () => {
    const { add, run, modulesRoot } = fixture()
    const names = ['express', 'qs', 'side-channel', 'side-channel-map', 'call-bound', 'call-bind-apply-helpers']
    // Every name already has another top-level version. Nesting each conflict
    // directly under its importer recreates the real NSIS MAX_PATH failure,
    // including executable JavaScript rather than only optional dotfiles.
    for (const name of names) add(name, '1.0.0', 'module.exports = ["top-level-1"]')
    const chain = names.map((name, index) => add(name, '2.0.0', index === names.length - 1
      ? `module.exports = [${JSON.stringify(name + '@2')}]`
      : `module.exports = [${JSON.stringify(name + '@2')}, ...require(${JSON.stringify(names[index + 1])})]`))
    for (let index = 0; index < chain.length - 1; index++) chain[index]!.dependencies.set(names[index + 1]!, chain[index + 1]!)
    const sdk = add('@modelcontextprotocol/sdk', '1.0.0', 'module.exports = require("express")')
    sdk.dependencies.set('express', chain[0]!)

    const { value, layout } = run('console.log(JSON.stringify(require("@modelcontextprotocol/sdk")))')
    expect(value).toEqual(names.map(name => name + '@2'))
    const windowsModules = 'D:\\a\\lumo-harness\\lumo-harness\\platform\\desktop\\lumo-runtime\\node_modules\\'
    const executablePaths = layout.map(entry => windowsModules + relative(modulesRoot, join(entry.destination, 'index.js')).replaceAll('\\', '/').replaceAll('/', '\\'))
    expect(Math.max(...executablePaths.map(path => path.length)), 'NSIS must open every JavaScript payload below Windows MAX_PATH').toBeLessThan(260)
  })

  it('does not let a hoisted sibling replace an already-correct ancestor dependency', () => {
    const { add, run } = fixture()
    const original = add('shared-value', '1.0.0', 'module.exports = "shared-1"')
    const replacement = add('shared-value', '2.0.0', 'module.exports = "shared-2"')
    add('consumer-a', '1.0.0', 'module.exports = "unused-a"')
    add('consumer-b', '1.0.0', 'module.exports = "unused-b"')
    const first = add('consumer-a', '2.0.0', 'module.exports = require("shared-value")')
    const second = add('consumer-b', '2.0.0', 'module.exports = require("shared-value")')
    const app = add('sibling-parent', '1.0.0', 'module.exports = [require("consumer-a"), require("consumer-b")]')
    first.dependencies.set('shared-value', original)
    second.dependencies.set('shared-value', replacement)
    app.dependencies.set('consumer-a', first)
    app.dependencies.set('consumer-b', second)

    expect(run('console.log(JSON.stringify(require("sibling-parent")))').value).toEqual(['shared-1', 'shared-2'])
  })

  it('resolves each importer through its own pnpm links instead of reusing a previously seen name', () => {
    const { root, add } = fixture()
    const modern = add('signal-exit', '4.1.0', '')
    const legacy = add('signal-exit', '3.0.7', '')
    const lockfile = add('proper-lockfile', '4.1.2', '')
    mkdirSync(join(root, 'node_modules'), { recursive: true })
    mkdirSync(join(lockfile.root, 'node_modules'), { recursive: true })
    symlinkSync(modern.root, join(root, 'node_modules', 'signal-exit'), 'junction')
    symlinkSync(legacy.root, join(lockfile.root, 'node_modules', 'signal-exit'), 'junction')

    expect(resolveInstalledPackage('signal-exit', root)).toBe(modern.root)
    expect(resolveInstalledPackage('signal-exit', lockfile.root)).toBe(legacy.root)
    expect(resolveInstalledPackage('missing-package', lockfile.root)).toBeUndefined()
  })

  it('accepts a real runtime tree whose installer resource paths stay below MAX_PATH', () => {
    const { root, add, run } = fixture()
    add('short-package', '1.0.0', 'module.exports = "ready"')
    expect(run('console.log(JSON.stringify(require("short-package")))').value).toBe('ready')
    expect(() => assertWindowsRuntimePaths(join(root, 'runtime'))).not.toThrow()
  })

  it('rejects an existing oversized executable payload before NSIS starts', () => {
    const { root } = fixture()
    const runtime = join(root, 'runtime')
    let directory = runtime
    while (join(directory, 'index.js').length < 260) directory = join(directory, 'nested-dependency')
    mkdirSync(directory, { recursive: true })
    const file = join(directory, 'index.js')
    writeFileSync(file, 'module.exports = "real executable payload"')
    expect(() => assertWindowsRuntimePaths(runtime)).toThrow(/NSIS.*MAX_PATH/)
    // The diagnostic names the actual overlong directory or file and its size.
    expect(() => assertWindowsRuntimePaths(runtime)).toThrow(/>= 260/)
  })
})

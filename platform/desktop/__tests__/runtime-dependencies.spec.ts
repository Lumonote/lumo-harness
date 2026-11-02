import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { copyRuntimePackage, planRuntimePackages, resolveInstalledPackage } from '../runtime-dependencies.mjs'

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
    expect(resolveInstalledPackage('legacy-a', join(modulesRoot, 'app'))).toBe(join(modulesRoot, 'app', 'node_modules', 'legacy-a'))
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
})

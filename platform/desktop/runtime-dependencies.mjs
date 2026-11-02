import { cpSync, existsSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'

// Resolve from the importer before considering any shared fallback. A package
// name alone is not an identity: pnpm can install several incompatible versions.
export function resolveInstalledPackage(name, fromRoot) {
  for (let cursor = fromRoot; ; cursor = dirname(cursor)) {
    const candidate = resolve(cursor, 'node_modules', ...name.split('/'))
    if (existsSync(resolve(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(cursor) === cursor) return undefined
  }
}

// Keep the shared top-level packages, placing conflicting versions beneath
// their importers. Breadth-first placement ensures an ancestor's dependencies
// are settled before deciding what its children can resolve through that ancestor.
export function planRuntimePackages(modulesRoot, packageSources) {
  const placements = new Map()
  const queue = []
  const place = (info, destination) => {
    const entry = { ...info, destination }
    placements.set(destination, entry)
    queue.push(entry)
  }
  for (const [name, info] of packageSources) {
    place(info, resolve(modulesRoot, ...name.split('/')))
  }

  const findDependency = (destination, name) => {
    for (let cursor = destination; ; cursor = dirname(cursor)) {
      const found = placements.get(resolve(cursor, 'node_modules', ...name.split('/')))
      if (found !== undefined) return found
      if (cursor === dirname(modulesRoot)) return undefined
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    for (const [name, dependency] of current.dependencies) {
      if (findDependency(current.destination, name)?.root === dependency.root) continue
      place(dependency, resolve(current.destination, 'node_modules', ...name.split('/')))
    }
  }

  for (const current of queue) {
    for (const [name, dependency] of current.dependencies) {
      if (findDependency(current.destination, name)?.root !== dependency.root) {
        throw new Error(`桌面 runtime 依赖布局错误：${current.manifest.name} → ${name}`)
      }
    }
  }
  return queue
}

export function copyRuntimePackage(packageRoot, destination) {
  cpSync(packageRoot, destination, {
    recursive: true,
    dereference: true,
    filter(source) {
      const rel = relative(packageRoot, source)
      if (rel === '') return true
      return !['node_modules', 'tests', '__tests__', '.git'].includes(rel.split(sep)[0])
    },
  })
}

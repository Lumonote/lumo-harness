import { cpSync, existsSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, relative, resolve, sep } from 'node:path'

// npm's os/cpu/libc fields are package eligibility constraints, not a list of
// files that can be removed after copying. Keep the check here so the build
// can reject a required dependency before its transitive closure is staged.
function constraintValues(values) {
  if (typeof values === 'string') return [values]
  return Array.isArray(values) ? values.filter((value) => typeof value === 'string') : []
}

function matchesConstraint(values, target) {
  const constraints = constraintValues(values)
  if (constraints.length === 0) return true
  if (constraints.length === 1 && constraints[0] === 'any') return true
  if (constraints.some((value) => value === `!${target}`)) return false
  const positive = constraints.filter((value) => !value.startsWith('!'))
  // A target omitted from a negative-only constraint is allowed. For a
  // positive constraint, an unknown target is conservatively incompatible.
  return positive.length === 0 || (target !== undefined && positive.includes(target))
}

/**
 * Return whether an npm package manifest is eligible for a desktop target.
 * Like npm, libc constraints only apply on Linux. A Linux package with a
 * positive libc constraint cannot be treated as portable if that target libc
 * is unknown. This function only classifies metadata and never inspects files.
 */
export function isPackageTargetCompatible(manifest, { platform, arch, libc } = {}) {
  return matchesConstraint(manifest?.os, platform)
    && matchesConstraint(manifest?.cpu, arch)
    && (platform !== 'linux' || matchesConstraint(manifest?.libc, libc))
}

export function isOptionalRuntimeDependency(manifest, name) {
  // optionalDependencies override dependencies; optional peer metadata does
  // not override a separately declared required dependency of the same name.
  return Object.hasOwn(manifest.optionalDependencies ?? {}, name)
    || (!Object.hasOwn(manifest.dependencies ?? {}, name)
      && manifest.peerDependenciesMeta?.[name]?.optional === true)
}

// An explicit optional dependency may be absent on this platform. A required
// one must fail the build instead of producing a smaller but broken runtime.
export function shouldStageRuntimeDependency(manifest, target, { optional = false, importer = '?' } = {}) {
  if (isPackageTargetCompatible(manifest, target)) return true
  if (optional) return false
  throw new Error(`无法构建桌面 runtime：${importer} 的必需依赖 ${manifest.name}@${manifest.version ?? '?'} 不兼容目标 ${target.platform}-${target.arch}`)
}

/**
 * Validate every package placement after dependency planning. A package that
 * declares an incompatible target must have been filtered before planning;
 * throwing here prevents an accidental cross-platform native payload from
 * silently entering a release.
 */
export function assertRuntimePackageTargets(entries, target) {
  const incompatible = entries.filter(({ manifest }) => !isPackageTargetCompatible(manifest, target))
  if (incompatible.length === 0) return
  const details = incompatible.map(({ manifest, destination }) => `${manifest.name}@${manifest.version ?? '?'} (${destination})`)
  throw new Error(`桌面 runtime 包含目标平台不兼容依赖：${details.join(', ')}`)
}

// Resolve from the importer before considering any shared fallback. A package
// name alone is not an identity: pnpm can install several incompatible versions.
export function resolveInstalledPackage(name, fromRoot) {
  for (let cursor = fromRoot; ; cursor = dirname(cursor)) {
    const candidate = resolve(cursor, 'node_modules', ...name.split('/'))
    if (existsSync(resolve(candidate, 'package.json'))) return realpathSync(candidate)
    if (dirname(cursor) === cursor) return undefined
  }
}

// Keep top-level entry packages, and hoist conflicting versions to the highest
// safe ancestor. Putting every conflict directly under its importer repeats
// whole dependency chains and exceeds NSIS/Windows MAX_PATH during packaging.
// Every placement must preserve already-resolved dependency identities.
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

  const dependencyLocations = (destination, name) => {
    const locations = []
    for (let cursor = destination; ; cursor = dirname(cursor)) {
      // Node skips node_modules/node_modules in its ancestor search paths.
      if (basename(cursor) !== 'node_modules') locations.push(resolve(cursor, 'node_modules', ...name.split('/')))
      if (cursor === dirname(modulesRoot)) return locations
    }
  }
  const findDependency = (destination, name) => {
    for (const location of dependencyLocations(destination, name)) {
      const found = placements.get(location)
      if (found !== undefined) return found
    }
  }

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index]
    for (const [name, dependency] of current.dependencies) {
      if (findDependency(current.destination, name)?.root === dependency.root) continue
      const satisfied = queue.filter((entry) => {
        const expected = entry.dependencies.get(name)
        return expected !== undefined && findDependency(entry.destination, name)?.root === expected.root
      })
      let destination
      for (const candidate of dependencyLocations(current.destination, name).reverse()) {
        if (placements.has(candidate)) continue
        placements.set(candidate, { ...dependency, destination: candidate })
        const preservesResolution = satisfied.every((entry) =>
          findDependency(entry.destination, name)?.root === entry.dependencies.get(name).root)
        const resolvesCurrent = findDependency(current.destination, name)?.root === dependency.root
        placements.delete(candidate)
        if (preservesResolution && resolvesCurrent) {
          destination = candidate
          break
        }
      }
      if (destination === undefined) {
        throw new Error(`桌面 runtime 依赖无法安全放置：${current.manifest.name} → ${name}`)
      }
      place(dependency, destination)
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

export function copyRuntimePackage(packageRoot, destination, { exclude = [] } = {}) {
  cpSync(packageRoot, destination, {
    recursive: true,
    dereference: true,
    filter(source) {
      const rel = relative(packageRoot, source)
      if (rel === '') return true
      return !['node_modules', 'tests', '__tests__', '.git'].includes(rel.split(sep)[0])
        && !exclude.some((path) => rel === path || rel.startsWith(`${path}${sep}`))
    },
  })
}

// NSIS opens resource files using Windows paths even after Rust has finished.
// Detect oversized resource paths before paying for that compilation step.
export function assertWindowsRuntimePaths(runtimeRoot) {
  const pending = [resolve(runtimeRoot)]
  for (let index = 0; index < pending.length; index += 1) {
    const directory = pending[index]
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name)
      if (path.length >= 260) {
        throw new Error(`无法构建 Windows runtime：NSIS 资源路径超过 MAX_PATH（${path.length} >= 260）：${path}；请缩短依赖布局或构建目录`)
      }
      if (entry.isDirectory()) pending.push(path)
    }
  }
}

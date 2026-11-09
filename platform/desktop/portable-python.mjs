import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, symlinkSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

const inside = (root, path) => { const rel = relative(root, path); return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)) }

/** Copy a Python distribution without turning relocatable aliases into full binaries.
 * Only links whose final target is copied within this tree remain links. Windows
 * deliberately materialises them: NSIS resource handling does not preserve links.
 */
export function copyPortablePythonTree(source, destination, { preserveLinks = process.platform !== 'win32', filter = () => true, externalRoots = [] } = {}) {
  const root = realpathSync(source)
  const allowedExternalRoots = externalRoots.map(path => realpathSync(path))
  const output = resolve(destination)
  if (inside(root, output) || inside(output, root)) throw Error('Python 源目录与目标目录不能互相包含')
  if (existsSync(output)) throw Error(`Python 复制目标必须为空且不存在：${output}`)
  const summary = { preservedLinks: 0, materializedLinks: 0, skippedLinks: 0 }
  const included = path => {
    if (!inside(root, path)) return true
    for (let cursor = path; ; cursor = dirname(cursor)) {
      if (!filter(cursor)) return false
      if (cursor === root) return true
    }
  }
  const copy = (from, to, ancestors) => {
    if (!filter(from)) return
    const stat = lstatSync(from)
    if (stat.isSymbolicLink()) {
      let target
      try { target = realpathSync(from) } catch (error) {
        if (error.code === 'ENOENT') { summary.skippedLinks++; return }
        throw Error(`Python 符号链接不可解析：${from}`, { cause: error })
      }
      if (!inside(root, target) && !allowedExternalRoots.some(allowed => inside(allowed, target))) throw Error(`Python 符号链接指向未授权的包外目录：${from}`)
      if (!included(target)) { summary.skippedLinks++; return }
      if (preserveLinks && lstatSync(target).isFile() && !isAbsolute(readlinkSync(from)) && inside(root, target)) {
        // Canonical relative targets cannot retain an absolute build-machine prefix.
        mkdirSync(dirname(to), { recursive: true })
        symlinkSync(relative(dirname(to), resolve(output, relative(root, target))), to)
        summary.preservedLinks++
        return
      }
      summary.materializedLinks++
      copy(target, to, ancestors)
      return
    }
    if (stat.isDirectory()) {
      const canonical = realpathSync(from)
      if (ancestors.has(canonical)) throw Error(`Python 目录链接形成循环：${from}`)
      const next = new Set(ancestors).add(canonical)
      mkdirSync(to, { recursive: true, mode: stat.mode })
      for (const entry of readdirSync(from)) copy(resolve(from, entry), resolve(to, entry), next)
      chmodSync(to, stat.mode & 0o777)
    } else if (stat.isFile()) {
      mkdirSync(dirname(to), { recursive: true })
      copyFileSync(from, to)
      chmodSync(to, stat.mode & 0o777)
    } else throw Error(`Python runtime 包含特殊文件：${from}`)
  }
  copy(root, output, new Set())
  assertPortablePythonLinks(output)
  return summary
}

/** Works after moving the copied tree; never follows directory links recursively. */
export function assertPortablePythonLinks(directory) {
  const root = realpathSync(directory)
  const visit = path => {
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) {
      if (isAbsolute(readlinkSync(path)) || !inside(root, realpathSync(path))) throw Error(`Python runtime 链接逃出安装目录：${path}`)
    } else if (stat.isDirectory()) for (const entry of readdirSync(path)) visit(resolve(path, entry))
  }
  visit(root)
}

import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { git } from './assert-pristine.mjs'

function exportsSourcePattern(value) {
  if (typeof value === 'string') return value === './src/*'
  // Equivalent conditional exports are safe to map without changing which
  // source a browser, Node or the type checker would otherwise select.
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length > 0 && Object.values(value).every(exportsSourcePattern)
}

/** Keep exported workspace source subpaths inside the isolated compiler graph.
 * Canonical entries already use upstream's paths, while node_modules links
 * resolve back to the original checkout. Mixing the two splits declaration
 * merging into separate module identities (for example SessionRetainFacetMap).
 */
export function isolateWorkspaceSourcePaths(sourceRoot, targetRoot) {
  sourceRoot = resolve(sourceRoot)
  targetRoot = resolve(targetRoot)
  const location = relative(sourceRoot, targetRoot)
  if (location === '' || (!isAbsolute(location) && location !== '..' && !location.startsWith(`..${sep}`))) {
    throw new Error('Lumo source path isolation requires a snapshot outside the upstream checkout')
  }
  const configPath = resolve(targetRoot, 'tsconfig.base.json')
  const requireFromSource = createRequire(resolve(sourceRoot, 'package.json'))
  const ts = requireFromSource('typescript')
  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile)
  if (error) throw new Error(`Lumo source path isolation: ${ts.flattenDiagnosticMessageText(error.messageText, '\n')}`)
  const options = config.compilerOptions ??= {}
  const paths = options.paths ??= {}
  const base = resolve(targetRoot, options.baseUrl ?? '.')
  const manifests = git(sourceRoot, ['ls-files', '-z', '**/package.json', 'package.json'], null)
    .toString().split('\0').filter(Boolean)
  let added = 0
  for (const manifestPath of manifests) {
    const manifest = JSON.parse(readFileSync(resolve(targetRoot, manifestPath), 'utf8'))
    if (typeof manifest.name !== 'string' || !exportsSourcePattern(manifest.exports?.['./src/*'])) continue
    const specifier = `${manifest.name}/src/*`
    if (Object.hasOwn(paths, specifier)) continue
    paths[specifier] = [`./${relative(base, resolve(targetRoot, dirname(manifestPath), 'src', '*')).split(sep).join('/')}`]
    added++
  }
  if (added > 0) writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return added
}

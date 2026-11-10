import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshClientTypeConfigs } from '../desktop/dsh-client-types.mjs'
import { assertPristineProductSource } from './assert-pristine.mjs'
import { generateTypertArtifacts, hasTypertRemoteProjection, prepareRuntime } from './prepare-runtime.mjs'

function compileClientDeclarations(sourceRoot) {
  const requireFromSource = createRequire(resolve(sourceRoot, 'package.json'))
  const ts = requireFromSource('typescript')
  const aggregate = resolve(sourceRoot, 'tsconfig.client.json')
  const config = ts.getParsedCommandLineOfConfigFile(aggregate, {}, {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic(diagnostic) {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
    },
  })
  if (!config || config.errors.length > 0) {
    throw new Error(`Lumo DSH client build: invalid aggregate ${aggregate}\n${(config?.errors ?? []).map(error => ts.flattenDiagnosticMessageText(error.messageText, '\n')).join('\n')}`)
  }
  if (config.options.noEmit !== true || !config.projectReferences?.length) {
    throw new Error('Lumo DSH client build: tsconfig.client.json must be a noEmit aggregate with project references')
  }
  // The aggregate includes shared leaves and packages outside packages/client.
  // Keep desktop discovery too: it covers browser halves whose package root is
  // a Host/Client solution, without hardcoding the three missing UI packages.
  const configs = [...new Set([
    ...config.projectReferences.map(reference => relative(sourceRoot, reference.path)),
    ...dshClientTypeConfigs(sourceRoot),
  ])]
  console.log(`Building DSH Client declarations (${configs.length} project roots)...`)
  const result = spawnSync(process.execPath, [
    '--max-old-space-size=8192', requireFromSource.resolve('typescript/bin/tsc'),
    '-b', ...configs, '--force', '--pretty', 'false',
  ], { cwd: sourceRoot, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Lumo DSH client build failed (${String(result.status ?? result.signal)})`)
  return configs
}

/** Build package declarations without including the aggregate's tests/scripts. */
export function buildDshClientArtifacts(sourceRoot) {
  sourceRoot = resolve(sourceRoot)
  assertPristineProductSource(sourceRoot)
  try { return compileClientDeclarations(sourceRoot) }
  finally { assertPristineProductSource(sourceRoot) }
}

function contains(root, target) {
  const path = relative(root, target)
  return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
}

export function projectDshClientDeclarations(sourceRoot, targetRoot, configs) {
  sourceRoot = resolve(sourceRoot)
  targetRoot = resolve(targetRoot)
  if (contains(sourceRoot, targetRoot)) throw new Error('Lumo Client staging must be outside the upstream checkout')
  const directories = [...new Set(configs.map(config => dirname(config.endsWith('.json') ? config : `${config}/tsconfig.json`)))]
  for (const directory of directories) {
    if (!contains(sourceRoot, resolve(sourceRoot, directory)) || !contains(targetRoot, resolve(targetRoot, directory))) {
      throw new Error('Lumo Client declaration project must stay inside the workspace')
    }
  }
  for (const directory of directories) {
    const types = resolve(targetRoot, directory, 'lib/types')
    if (!existsSync(types)) continue
    const destination = resolve(sourceRoot, directory, 'lib/types')
    rmSync(destination, { recursive: true, force: true })
    cpSync(types, destination, { recursive: true, dereference: true })
  }
}

/** Compile the existing platform overlay in its isolated tree, then project
 * generated types for package exports consumed by platform's typechecks.
 * Source files/configuration/lockfiles are never copied back to upstream.
 */
export function buildLumoClientArtifacts(sourceRoot, targetRoot) {
  sourceRoot = resolve(sourceRoot)
  targetRoot = resolve(targetRoot)
  if (contains(sourceRoot, targetRoot)) {
    throw new Error('Lumo Client staging must be outside the upstream checkout')
  }
  assertPristineProductSource(sourceRoot)
  try {
    prepareRuntime(sourceRoot, targetRoot)
    if (!hasTypertRemoteProjection(targetRoot)) generateTypertArtifacts(targetRoot)
    const configs = compileClientDeclarations(targetRoot)
    // Match desktop's generated-lib projection, limited to types so CI keeps
    // the Host executable bundles prepared by build-host.mjs.
    projectDshClientDeclarations(sourceRoot, targetRoot, configs)
    return configs
  } finally { assertPristineProductSource(sourceRoot) }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('usage: node platform/dsh-overrides/build-client.mjs <source-dsh-root>')
  buildLumoClientArtifacts(process.argv[2], resolve(dirname(fileURLToPath(import.meta.url)), '../.build/ci-client-types'))
}

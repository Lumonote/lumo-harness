import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { assertPristineProductSource } from '../dsh-overrides/assert-pristine.mjs'
import { buildLumoClientArtifacts } from '../dsh-overrides/build-client.mjs'
import { fingerprint, prepareRuntime } from '../dsh-overrides/prepare-runtime.mjs'
import { overriddenPackageDirectories } from '../dsh-overrides/apply.mjs'
import { brandWebBuild } from '../dsh-overrides/brand-web.mjs'
import { acquireBuildLock } from './build-lock.mjs'
import { dshClientBundleArgs } from './dsh-client-bundle.mjs'
import { resolveWorkspaceNodeTool } from './node-tools.mjs'

const script = fileURLToPath(import.meta.url)

function run(cwd, root, binary, args, heap = false) {
  const result = spawnSync(process.execPath, [
    ...(heap ? ['--max-old-space-size=8192'] : []),
    resolveWorkspaceNodeTool(cwd, root, binary), ...args,
  ], { cwd, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`Preview ${binary} failed in ${cwd}: ${result.status ?? result.signal}`)
}

function assertSeparateStage(source, stage) {
  const nested = (parent, child) => {
    const path = relative(realpathSync(parent), realpathSync(child))
    return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`)
  }
  if (nested(source, stage) || nested(stage, source)) {
    throw new Error('Preview stage must be outside the upstream checkout')
  }
  assertPristineProductSource(source)
}

/** Dependencies resolve to the checkout. Project generated outputs only. */
export function projectPreviewLibraries(source, stage) {
  assertSeparateStage(source, stage)
  const manifests = execFileSync('git', ['-C', source, 'ls-files', '-z', '**/package.json', 'package.json'], { encoding: 'utf8' })
  for (const manifest of manifests.split('\0').filter(Boolean)) {
    const lib = resolve(stage, dirname(manifest), 'lib')
    if (!existsSync(lib)) continue
    const destination = resolve(source, dirname(manifest), 'lib')
    // A future package must not turn an artifact copy into a tracked source edit.
    const tracked = execFileSync('git', ['-C', source, 'ls-files', '--', `${dirname(manifest)}/lib`], { encoding: 'utf8' })
    if (tracked.trim()) throw new Error(`Preview cannot replace tracked library: ${destination}`)
    rmSync(destination, { recursive: true, force: true })
    cpSync(lib, destination, { recursive: true, dereference: true })
  }
  assertPristineProductSource(source)
}

/** The native Web runtime resolves its frontend package through workspace links. */
export function projectPreviewFrontend(source, stage) {
  assertSeparateStage(source, stage)
  const directory = 'apps/web/dist'
  if (!existsSync(resolve(stage, directory, 'index.html'))) throw new Error('Preview frontend index is missing')
  const tracked = execFileSync('git', ['-C', source, 'ls-files', '--', directory], { encoding: 'utf8' })
  if (tracked.trim()) throw new Error('Preview cannot replace a tracked frontend dist')
  rmSync(resolve(source, directory), { recursive: true, force: true })
  cpSync(resolve(stage, directory), resolve(source, directory), { recursive: true, dereference: true })
  assertPristineProductSource(source)
}

/** The repository preview needs the same full Host/Client graph as a release. */
export function buildPreview(platformRoot) {
  const source = resolve(platformRoot, '../deepseek-harness')
  const stage = resolve(platformRoot, '.build/deepseek-harness')
  const release = acquireBuildLock(resolve(platformRoot, '.build/desktop-runtime.lock'))
  try {
    prepareRuntime(source, stage)
    const marker = resolve(stage, '.lumo-preview-built')
    const recipe = createHash('sha256').update(readFileSync(script)).digest('hex')
    const stageKey = () => `${readFileSync(resolve(stage, '.lumo-stage'), 'utf8').trim()}:${recipe}`
    const index = resolve(stage, 'apps/web/dist/index.html')
    if (!existsSync(index) || !existsSync(marker) || readFileSync(marker, 'utf8').trim() !== stageKey()) {
      rmSync(marker, { force: true })
      console.log('Lumo: building the complete native preview...')
      buildLumoClientArtifacts(source, stage)
      run(stage, stage, 'tsc', ['-b', 'apps/cli/tsconfig.json', 'apps/desktop-host/tsconfig.json', '--force', '--pretty', 'false'], true)
      for (const directory of overriddenPackageDirectories) {
        const cwd = resolve(stage, directory)
        const config = existsSync(resolve(cwd, 'tsconfig.host.json')) ? 'tsconfig.host.json'
          : directory.startsWith('packages/client/') ? undefined : 'tsconfig.json'
        if (config) run(cwd, stage, 'tsc', ['-p', config, '--pretty', 'false'])
      }
      run(stage, stage, 'tsdown', ['--env.DSH_BUILD_FACE', 'host'])
      run(stage, stage, 'tsdown', dshClientBundleArgs(stage))
      projectPreviewLibraries(source, stage)
      // apps/web owns Vite 6; the root's Vitest dependency can use a newer Vite.
      run(resolve(stage, 'apps/web'), stage, 'vite', ['build'])
      if (!existsSync(index)) throw new Error(`Preview did not produce ${index}`)
      brandWebBuild(stage)
      projectPreviewFrontend(source, stage)
      // Projecting ignored artifacts changes the source fingerprint. Keep the
      // next launch from discarding the very outputs this successful build made.
      writeFileSync(resolve(stage, '.lumo-stage'), `${fingerprint(source)}\n`)
      writeFileSync(marker, `${stageKey()}\n`)
    }
    // A developer can remove the ignored source dist while keeping the stage.
    if (!existsSync(resolve(source, 'apps/web/dist/index.html'))) projectPreviewFrontend(source, stage)
    // Platform edits do not change the upstream stage key. Always refresh these
    // small bundles so a valid native shell cannot silently host stale UI code.
    for (const name of ['knowledge-vault', 'lumo-ui']) {
      const cwd = resolve(platformRoot, 'dsh-plugins', name)
      run(cwd, source, 'tsdown', ['--config', 'tsdown.config.ts'])
    }
    assertPristineProductSource(source)
    return stage
  } finally { release() }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  buildPreview(resolve(dirname(script), '..'))
}
